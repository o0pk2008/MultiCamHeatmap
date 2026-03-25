import asyncio
import random
from typing import Dict, Tuple, List
import json
import time
import os

from . import models
from .db import SessionLocal
import numpy as np
import cv2

try:
    from ultralytics import YOLO  # type: ignore
except Exception:  # pragma: no cover - 在未安装 ultralytics 时忽略
    YOLO = None  # type: ignore

from .virtual_view_inference import manager


class HeatmapAnalyzer:
    """
    负责：
    - 为每个 floor_plan_id 启动 / 管理一个后台分析任务
    - 从 RTSP 拉流，对 virtual PTZ 透视视图区域跑 YOLO
    - 将“脚底点”映射到 virtual PTZ 网格 cell，再通过 VirtualViewCellMapping 映射到 FloorPlan cell

    当前版本：仍然使用“随机 cell”作为事件，但结构已经按照真实流程设计，
    方便后续在 TODO 位置替换为真实 YOLO 分析与坐标映射。
    """

    def __init__(self) -> None:
        self._tasks: Dict[int, asyncio.Task] = {}
        # floor_plan_id -> 已 acquire 的 vv_id 集合（用于 stop 时释放推理引用）
        self._vv_refs: Dict[int, set] = {}

    def start_for_floor_plan(self, floor_plan_id: int) -> None:
        # 已有任务则忽略
        if floor_plan_id in self._tasks:
            return
        loop = asyncio.get_event_loop()
        task = loop.create_task(self._run_loop(floor_plan_id))
        self._tasks[floor_plan_id] = task
        self._vv_refs.setdefault(int(floor_plan_id), set())

    def stop_for_floor_plan(self, floor_plan_id: int) -> None:
        task = self._tasks.pop(floor_plan_id, None)
        if task is not None:
            task.cancel()
        # 主循环会在 finally 释放；这里额外兜底一次
        vv_ids = self._vv_refs.pop(int(floor_plan_id), set())
        for vv_id in list(vv_ids):
            try:
                manager.release_inference(int(vv_id))
            except Exception:
                pass

    async def _run_loop(self, floor_plan_id: int) -> None:
        """主循环：对与该平面图存在映射关系的 virtual PTZ 视窗做分析。

        当前策略（优化版）：
        - 不在此处重复拉流/重复 YOLO。
        - 复用 VirtualViewInferenceManager（analyzed.mjpeg 使用的后台推理线程）的检测结果。
        - 仅做：检测框 -> 脚底点 -> camera grid -> floor grid -> 事件推送。
        """
        acquired: set = self._vv_refs.setdefault(int(floor_plan_id), set())
        # 用 det.ts 去重：避免同一帧重复触发事件
        last_det_ts_by_vv: Dict[int, float] = {}
        interval_sec = float(os.environ.get("HEATMAP_ANALYZER_INTERVAL_SEC", "0.07"))
        # stable_id：用于缓解 track_id 丢失/跳变导致的漏检（在 uv 空间做轻量关联）
        stable_next_id = 1
        stable_by_vv: Dict[int, Dict[int, Tuple[float, float, float]]] = {}  # vv_id -> stable_id -> (u,v,ts)
        det_to_stable: Dict[int, Dict[int, int]] = {}  # vv_id -> det_track_id -> stable_id
        stable_ttl_sec = float(os.environ.get("HEATMAP_STABLE_ID_TTL_SEC", "2.5"))
        stable_match_dt_sec = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DT_SEC", "1.2"))
        stable_match_dist = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DIST", "0.18"))
        try:
            while True:
                # 每一轮查询一次当前 floor_plan 的网格和 virtual PTZ 映射关系
                with SessionLocal() as db:
                    fp = (
                        db.query(models.FloorPlan)
                        .filter(models.FloorPlan.id == floor_plan_id)
                        .first()
                    )
                    if not fp:
                        return
                    rows = max(1, fp.grid_rows or 1)
                    cols = max(1, fp.grid_cols or 1)

                    # 找到所有与该 floor_plan 存在映射关系的 virtual PTZ cell
                    vv_rows: List[
                        Tuple[
                            models.VirtualViewCellMapping,
                            models.CameraVirtualView,
                            models.Camera,
                        ]
                    ] = (
                        db.query(
                            models.VirtualViewCellMapping,
                            models.CameraVirtualView,
                            models.Camera,
                        )
                        .join(
                            models.CameraVirtualView,
                            models.CameraVirtualView.id
                            == models.VirtualViewCellMapping.virtual_view_id,
                        )
                        .join(
                            models.Camera,
                            models.Camera.id == models.CameraVirtualView.camera_id,
                        )
                        .filter(
                            models.VirtualViewCellMapping.floor_plan_id == floor_plan_id
                        )
                        .all()
                    )
                    # 预先将 (virtual_view_id, camera_row, camera_col) 映射到 floor cell 信息
                    cell_map: Dict[
                        Tuple[int, int, int],
                        Tuple[int, int, int, int],
                    ] = {}
                    for m, vv, cam in vv_rows:
                        key = (vv.id, m.camera_row, m.camera_col)
                        cell_map[key] = (m.floor_row, m.floor_col, cam.id, vv.id)

                    # 收集与该 floor_plan 相关的 virtual view 配置（RTSP、grid 配置等）
                    vv_ids = {vv.id for _, vv, _ in vv_rows}
                    vv_cfg: Dict[
                        int,
                        Tuple[str, int, int, int, int, List[Tuple[float, float]]],
                    ] = {}
                    if vv_ids:
                        cfg_rows = (
                            db.query(
                                models.CameraVirtualView,
                                models.Camera,
                                models.CameraVirtualViewGridConfig,
                            )
                            .join(
                                models.Camera,
                                models.Camera.id == models.CameraVirtualView.camera_id,
                            )
                            .outerjoin(
                                models.CameraVirtualViewGridConfig,
                                models.CameraVirtualViewGridConfig.virtual_view_id
                                == models.CameraVirtualView.id,
                            )
                            .filter(models.CameraVirtualView.id.in_(vv_ids))
                            .all()
                        )
                        for vv, cam, cfg in cfg_rows:
                            if cfg is None:
                                continue
                            quad: List[Tuple[float, float]] = []
                            try:
                                raw = json.loads(cfg.polygon_json or "[]")
                                if isinstance(raw, list) and len(raw) == 4:
                                    quad = [
                                        (float(raw[0]["x"]), float(raw[0]["y"])),
                                        (float(raw[1]["x"]), float(raw[1]["y"])),
                                        (float(raw[2]["x"]), float(raw[2]["y"])),
                                        (float(raw[3]["x"]), float(raw[3]["y"])),
                                    ]
                            except Exception:
                                quad = []
                            vv_cfg[vv.id] = (
                                cam.rtsp_url,
                                vv.out_w,
                                vv.out_h,
                                cfg.grid_rows,
                                cfg.grid_cols,
                                quad,
                            )

                # 如果没有任何 virtual PTZ 映射，则退化为整张平面图上的随机格子
                if not vv_rows or not vv_cfg:
                    r = random.randint(0, rows - 1)
                    c = random.randint(0, cols - 1)
                    event = {
                        "floor_plan_id": floor_plan_id,
                        "floor_row": r,
                        "floor_col": c,
                        "camera_id": None,
                        "virtual_view_id": None,
                        "ts": time.time(),
                    }
                    try:
                        await heatmap_broadcast(event)
                    except Exception:
                        pass
                    await asyncio.sleep(0.5)
                    continue

                # 依次读取每个 virtual PTZ 的“最近一次检测结果”，映射并发送事件
                # 让 analyzer 对当前关联的 vv_ids 持有推理引用（保证检测结果持续更新）
                cur_vv_ids = set(vv_cfg.keys())
                # acquire 新增的
                for vv_id in cur_vv_ids - set(acquired):
                    try:
                        manager.acquire_inference(int(vv_id))
                        acquired.add(int(vv_id))
                    except Exception:
                        pass
                # release 不再需要的
                for vv_id in set(acquired) - set(cur_vv_ids):
                    try:
                        manager.release_inference(int(vv_id))
                    except Exception:
                        pass
                    try:
                        acquired.discard(int(vv_id))
                    except Exception:
                        pass

                for vv_id, (_rtsp_url, out_w, out_h, g_rows, g_cols, quad) in vv_cfg.items():

                    det = manager.get_latest_detections(vv_id)
                    if det is None:
                        continue
                    try:
                        det_ts = float(getattr(det, "ts", 0.0) or 0.0)
                    except Exception:
                        det_ts = 0.0
                    if det_ts > 0:
                        prev_ts = float(last_det_ts_by_vv.get(int(vv_id), 0.0))
                        if det_ts <= prev_ts:
                            continue
                        last_det_ts_by_vv[int(vv_id)] = det_ts

                    xyxy = det.xyxy
                    cls_ids = det.cls
                    if xyxy is None or cls_ids is None:
                        continue
                    track_ids = getattr(det, "track_ids", None)
                    if track_ids is None:
                        track_ids = getattr(det, "ids", None)

                    genders = getattr(det, "gender", None)
                    age_buckets = getattr(det, "age_bucket", None)

                    # 将脚底点映射到“透视网格”的 cell：
                    # 先用 quad 的 homography 把像素坐标反变换到 unit square (u,v)，再算 row/col。
                    if len(quad) != 4:
                        continue
                    try:
                        src = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
                        dst = np.array(
                            [
                                [quad[0][0], quad[0][1]],
                                [quad[1][0], quad[1][1]],
                                [quad[2][0], quad[2][1]],
                                [quad[3][0], quad[3][1]],
                            ],
                            dtype=np.float32,
                        )
                        Hm = cv2.getPerspectiveTransform(src, dst)
                        Hinv = np.linalg.inv(Hm)
                    except Exception:
                        continue

                    for idx, ((x1, y1, x2, y2), cid) in enumerate(zip(xyxy, cls_ids)):
                        h = y2 - y1
                        foot_x = (x1 + x2) * 0.5
                        # 脚步点：bbox 底部中心向上 1%
                        foot_y = y2 - 0.01 * h
                        # 同时给前端返回“虚拟视窗原图归一化坐标”，用于精确过线判定（避免 floor 网格映射误差）
                        try:
                            fw = float(getattr(det, "w", 0) or 0)
                            fh = float(getattr(det, "h", 0) or 0)
                        except Exception:
                            fw, fh = (0.0, 0.0)
                        foot_u = float(foot_x) / fw if fw > 1 else None
                        foot_v = float(foot_y) / fh if fh > 1 else None
                        # 逆变换到 unit square
                        try:
                            p = np.array([foot_x, foot_y, 1.0], dtype=np.float32)
                            uvw = Hinv @ p
                            w = float(uvw[2]) if abs(float(uvw[2])) > 1e-6 else 1e-6
                            u = float(uvw[0]) / w
                            v = float(uvw[1]) / w
                        except Exception:
                            continue
                        if u < 0.0 or u > 1.0 or v < 0.0 or v > 1.0:
                            continue
                        cam_col = int(u * g_cols)
                        cam_row = int(v * g_rows)
                        if cam_row == g_rows:
                            cam_row = g_rows - 1
                        if cam_col == g_cols:
                            cam_col = g_cols - 1
                        if cam_row < 0 or cam_row >= g_rows or cam_col < 0 or cam_col >= g_cols:
                            continue

                        key = (vv_id, cam_row, cam_col)
                        if key not in cell_map:
                            continue
                        floor_row, floor_col, cam_id, vv_real_id = cell_map[key]

                        track_id = None
                        try:
                            if track_ids is not None and idx < len(track_ids):
                                tid = int(track_ids[idx])
                                if tid >= 0:
                                    track_id = tid
                        except Exception:
                            track_id = None

                        # 只有可跟踪的人才产出事件（避免非人类目标干扰）
                        if track_id is None:
                            continue

                        # === stable_id 关联（缓解 track_id 丢失/跳变）===
                        vv_int = int(vv_id)
                        now_ts = float(det_ts) if det_ts > 0 else time.time()
                        st_map = stable_by_vv.setdefault(vv_int, {})
                        dt_map = det_to_stable.setdefault(vv_int, {})
                        # prune
                        try:
                            for sid, (_su, _sv, _sts) in list(st_map.items()):
                                if now_ts - float(_sts) > stable_ttl_sec:
                                    st_map.pop(int(sid), None)
                        except Exception:
                            pass
                        try:
                            for tid, sid in list(dt_map.items()):
                                if int(sid) not in st_map:
                                    dt_map.pop(int(tid), None)
                        except Exception:
                            pass

                        stable_id = None
                        try:
                            stable_id = int(dt_map.get(int(track_id))) if int(track_id) in dt_map else None
                        except Exception:
                            stable_id = None

                        if stable_id is None and foot_u is not None and foot_v is not None:
                            # 在 uv 空间找最近且“最近出现”的 stable
                            best_sid = None
                            best_d2 = None
                            for sid, (su, sv, sts) in st_map.items():
                                dtp = now_ts - float(sts)
                                if dtp < 0:
                                    dtp = 0
                                if dtp > stable_match_dt_sec:
                                    continue
                                dx = float(su) - float(foot_u)
                                dy = float(sv) - float(foot_v)
                                d2 = dx * dx + dy * dy
                                if d2 <= stable_match_dist * stable_match_dist and (best_d2 is None or d2 < best_d2):
                                    best_d2 = d2
                                    best_sid = int(sid)
                            if best_sid is not None:
                                stable_id = int(best_sid)

                        if stable_id is None:
                            stable_id = int(stable_next_id)
                            stable_next_id += 1
                        dt_map[int(track_id)] = int(stable_id)
                        if foot_u is not None and foot_v is not None:
                            st_map[int(stable_id)] = (float(foot_u), float(foot_v), float(now_ts))

                        gender = None
                        try:
                            if genders is not None and idx < len(genders):
                                gender = genders[idx]
                        except Exception:
                            gender = None

                        age_bucket = None
                        try:
                            if age_buckets is not None and idx < len(age_buckets):
                                age_bucket = age_buckets[idx]
                        except Exception:
                            age_bucket = None

                        event = {
                            "floor_plan_id": floor_plan_id,
                            "floor_row": floor_row,
                            "floor_col": floor_col,
                            "camera_id": cam_id,
                            "virtual_view_id": vv_real_id,
                            "camera_row": cam_row,
                            "camera_col": cam_col,
                            "track_id": track_id,
                            "stable_id": stable_id,
                            "gender": gender,
                            "age_bucket": age_bucket,
                            "foot_u": foot_u,
                            "foot_v": foot_v,
                            # 优先使用 det.ts（更贴近实际采样时刻）
                            "ts": float(det_ts) if det_ts > 0 else time.time(),
                        }
                        try:
                            from .main import heatmap_broadcast
                            await heatmap_broadcast(event)
                        except Exception:
                            pass

                await asyncio.sleep(max(0.03, interval_sec))
        except asyncio.CancelledError:
            # 正常停止
            return
        finally:
            # 释放本 floor_plan 持有的推理引用
            for vv_id in list(acquired):
                try:
                    manager.release_inference(int(vv_id))
                except Exception:
                    pass
            try:
                acquired.clear()
            except Exception:
                pass


analyzer = HeatmapAnalyzer()
