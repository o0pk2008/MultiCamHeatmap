import asyncio
import math
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, Any

import os

from .virtual_view_inference import manager


@dataclass
class FootfallLine:
    # UV space line endpoints (0..1) in the virtual view original out_w/out_h coordinate
    p1: Tuple[float, float]  # (u, v)
    p2: Tuple[float, float]  # (u, v)
    zone_w: float  # near-line band half width in UV signed distance units
    line_config_id: int
    # False：保留几何与推理会话，但不产生过线事件 / 抓拍（与 DB footfall_line_configs.enabled 一致）
    enabled: bool = True


class FootfallAnalyzer:
    """
    在后端基于 YOLO 检测 + 追踪 ID 实时判断进入/离开。

    与 Ultralytics ObjectCounter（线段区域）一致的核心原则：
    - 仅用「上一帧落脚点 → 当前帧落脚点」线段与计数线段求交判断是否过线；
    - 几何状态按 track_id 保存（与推理里用 bbox 中心做关联的 track 一致；落脚点统一为脚底，
      避免 stable_id 合并把不同人的轨迹拼成一段导致错判）；
    - stable_id 仅用于上报与统计，不参与距离与过线计算。

    方向语义（与原有前端一致）：signed_dist 从负半平面到正半平面记为 in，反之为 out。
    """

    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._stops: Dict[str, asyncio.Event] = {}
        # 运行中会随 POST /footfall/start 更新，使多终端调整线或刷新后几何立即生效
        self._session_line: Dict[str, FootfallLine] = {}

    def _session_key(self, floor_plan_id: int, virtual_view_id: int) -> str:
        return f"fp{int(floor_plan_id)}-vv{int(virtual_view_id)}"

    def start(
        self,
        floor_plan_id: int,
        virtual_view_id: int,
        line: FootfallLine,
        emit_interval_sec: float = 0.03,
    ) -> None:
        key = self._session_key(floor_plan_id, virtual_view_id)
        self._session_line[key] = line
        # 无论是否已在运行，都更新可视化线（便于 YOLO 对齐验证）
        try:
            manager.set_footfall_line_uv(
                int(virtual_view_id),
                p1_uv=(float(line.p1[0]), float(line.p1[1])),
                p2_uv=(float(line.p2[0]), float(line.p2[1])),
            )
        except Exception:
            pass

        if key in self._tasks:
            # 已在运行：只更新上面的几何与可视化，不重复创建任务
            return

        stop_event = asyncio.Event()
        self._stops[key] = stop_event
        loop = asyncio.get_running_loop()
        self._tasks[key] = loop.create_task(
            self._run_session(key, floor_plan_id, virtual_view_id, emit_interval_sec, stop_event),
        )

        # 让 YOLO inference 保持运行（即使没有 analyzed.mjpeg 订阅者）
        try:
            manager.acquire_inference(int(virtual_view_id))
        except Exception:
            pass

    def merge_line_state(
        self,
        floor_plan_id: int,
        virtual_view_id: int,
        *,
        p1: Tuple[float, float],
        p2: Tuple[float, float],
        line_config_id: int,
        enabled: bool,
    ) -> None:
        """在会话已存在时应用 DB / upsert 的最新几何与启用状态（不创建或销毁任务）。"""
        key = self._session_key(floor_plan_id, virtual_view_id)
        if key not in self._tasks:
            return
        prev = self._session_line.get(key)
        zone_w = float(prev.zone_w) if prev is not None else 0.05
        line = FootfallLine(
            p1=(float(p1[0]), float(p1[1])),
            p2=(float(p2[0]), float(p2[1])),
            zone_w=zone_w,
            line_config_id=int(line_config_id),
            enabled=bool(enabled),
        )
        self._session_line[key] = line
        try:
            manager.set_footfall_line_uv(
                int(virtual_view_id),
                p1_uv=(float(p1[0]), float(p1[1])),
                p2_uv=(float(p2[0]), float(p2[1])),
            )
        except Exception:
            pass

    def is_running(self, floor_plan_id: int, virtual_view_id: int) -> bool:
        key = self._session_key(floor_plan_id, virtual_view_id)
        return key in self._tasks

    def running_session_count(self) -> int:
        return len(self._tasks)

    def stop(self, floor_plan_id: int, virtual_view_id: int) -> None:
        key = self._session_key(floor_plan_id, virtual_view_id)
        task = self._tasks.pop(key, None)
        stop_event = self._stops.pop(key, None)
        if stop_event is not None:
            try:
                stop_event.set()
            except Exception:
                pass
        if task is not None:
            try:
                task.cancel()
            except Exception:
                pass
        try:
            manager.release_inference(int(virtual_view_id))
        except Exception:
            pass

        try:
            self._session_line.pop(key, None)
        except Exception:
            pass

        try:
            manager.clear_footfall_line_uv(int(virtual_view_id))
        except Exception:
            pass

    async def _broadcast(self, event: dict) -> None:
        # 延迟导入，避免循环依赖
        from .main import footfall_broadcast

        await footfall_broadcast(event)

    def _signed_dist(self, u: float, v: float, line: FootfallLine) -> Optional[float]:
        dx = line.p2[0] - line.p1[0]
        dy = line.p2[1] - line.p1[1]
        ln = math.hypot(dx, dy)
        if ln <= 1e-12:
            return None
        # cross / |dir|，符号表示左右侧
        cross = dx * (v - line.p1[1]) - dy * (u - line.p1[0])
        return cross / ln

    def _orient(self, ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
        # 2D orientation (cross product of AB x AC)
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

    def _segments_intersect(
        self,
        ax: float,
        ay: float,
        bx: float,
        by: float,
        cx: float,
        cy: float,
        dx: float,
        dy: float,
        eps: float = 1e-9,
    ) -> bool:
        """
        判断线段 AB 与线段 CD 是否相交（包含端点/共线重叠）。
        坐标单位：UV 空间归一化坐标。
        """

        def sgn(x: float) -> int:
            if x > eps:
                return 1
            if x < -eps:
                return -1
            return 0

        o1 = self._orient(ax, ay, bx, by, cx, cy)
        o2 = self._orient(ax, ay, bx, by, dx, dy)
        o3 = self._orient(cx, cy, dx, dy, ax, ay)
        o4 = self._orient(cx, cy, dx, dy, bx, by)

        s1 = sgn(o1)
        s2 = sgn(o2)
        s3 = sgn(o3)
        s4 = sgn(o4)

        # 一般情况
        if s1 * s2 <= 0 and s3 * s4 <= 0:
            # 进一步用包围盒过滤（处理共线/端点）
            if (
                max(min(ax, bx), min(cx, dx)) - eps <= min(max(ax, bx), max(cx, dx)) + eps
                and max(min(ay, by), min(cy, dy)) - eps <= min(max(ay, by), max(cy, dy)) + eps
            ):
                return True
        return False

    @staticmethod
    def _motion_cross_line(line: FootfallLine, prev_u: float, prev_v: float, u: float, v: float) -> float:
        dx = float(line.p2[0] - line.p1[0])
        dy = float(line.p2[1] - line.p1[1])
        return dx * (v - prev_v) - dy * (u - prev_u)

    async def _run_session(
        self,
        session_key: str,
        floor_plan_id: int,
        virtual_view_id: int,
        emit_interval_sec: float,
        stop_event: asyncio.Event,
    ) -> None:
        stable_next_id = 1

        # 过线几何与防抖：仅按 track_id（与推理线程分配的 ID 一致）
        geom_by_tid: Dict[int, Dict[str, Any]] = {}

        # stable_id 仅作事件属性：track_id -> stable_id；近邻匹配用
        det_track_to_sid: Dict[int, int] = {}
        stable_by_uv: Dict[int, Tuple[float, float, float]] = {}

        stable_ttl_sec = float(os.environ.get("HEATMAP_STABLE_ID_TTL_SEC", "2.5"))
        stable_match_dt_sec = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DT_SEC", "1.2"))
        stable_match_dist = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DIST", "0.18"))

        cooldown_sec = float(os.environ.get("HEATMAP_FOOTFALL_COOLDOWN_SEC", "0.8"))
        rearm_sd_mult = float(os.environ.get("HEATMAP_FOOTFALL_REARM_SD_MULT", "1.4"))

        cross_pos_dist = float(os.environ.get("HEATMAP_CROSS_POS_DIST", "0.03"))
        cross_dedup_dt = float(os.environ.get("HEATMAP_CROSS_DEDUP_DT_SEC", "1.0"))
        # (track_id, foot_u, foot_v, ts, direction)：去重仅针对同一 track，避免并排多人互相抑制
        recent_crosses: list[Tuple[int, float, float, float, str]] = []

        # 半平面容差：与 zone_w 成比例，避免在在线附近抖动反复判穿越
        sd_tol_base = float(os.environ.get("HEATMAP_FOOTFALL_SD_TOL_MULT", "0.25"))

        last_emit_ts_by_vv = 0.0

        try:
            while not stop_event.is_set():
                line = self._session_line.get(session_key)
                if line is None:
                    await asyncio.sleep(emit_interval_sec)
                    continue
                if not line.enabled:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                line_config_id = int(line.line_config_id)
                p1u = float(line.p1[0])
                p1v = float(line.p1[1])
                p2u = float(line.p2[0])
                p2v = float(line.p2[1])
                line_dx = p2u - p1u
                line_dy = p2v - p1v
                line_len = math.hypot(line_dx, line_dy)

                det = manager.get_latest_detections(int(virtual_view_id))
                if det is None:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                det_ts = float(getattr(det, "ts", 0.0) or 0.0)
                if det_ts <= 0:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                # 降低事件重复发送：同一个 det_ts 不重复
                if det_ts <= last_emit_ts_by_vv:
                    await asyncio.sleep(emit_interval_sec)
                    continue
                last_emit_ts_by_vv = det_ts

                xyxy = getattr(det, "xyxy", None)
                cls_ids = getattr(det, "cls", None)
                if xyxy is None or cls_ids is None:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                track_ids = getattr(det, "track_ids", None)
                if track_ids is None:
                    track_ids = getattr(det, "ids", None)

                genders = getattr(det, "gender", None)
                age_buckets = getattr(det, "age_bucket", None)

                w = int(getattr(det, "w", 0) or 0)
                h = int(getattr(det, "h", 0) or 0)
                if w <= 1 or h <= 1:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                now_ts = det_ts
                for sid, (_u, _v, sts) in list(stable_by_uv.items()):
                    if now_ts - float(sts) > stable_ttl_sec:
                        stable_by_uv.pop(int(sid), None)
                for tid_k, gst in list(geom_by_tid.items()):
                    if now_ts - float(gst.get("last_ts", 0.0)) > stable_ttl_sec:
                        geom_by_tid.pop(int(tid_k), None)

                sd_tol = max(1e-5, float(sd_tol_base) * float(line.zone_w))
                cross_z_min = max(1e-8, 1e-6 * max(line_len, 1e-9))

                try:
                    n_det = min(len(xyxy), len(cls_ids), len(track_ids))  # type: ignore[arg-type]
                except Exception:
                    n_det = 0

                for idx in range(n_det):
                    try:
                        tid = int(track_ids[idx])
                    except Exception:
                        continue
                    if tid < 0:
                        continue

                    try:
                        cid_int = int(cls_ids[idx])
                    except Exception:
                        continue
                    try:
                        if not manager.is_person_detection_class(cid_int):
                            continue
                    except Exception:
                        pass

                    x1, y1, x2, y2 = xyxy[idx]
                    foot_x = float(x1 + x2) * 0.5
                    foot_y = float(y2) - 0.01 * float(y2 - y1)
                    foot_u = foot_x / float(w)
                    foot_v = foot_y / float(h)
                    if not (0.0 <= foot_u <= 1.0 and 0.0 <= foot_v <= 1.0):
                        continue

                    sd = self._signed_dist(float(foot_u), float(foot_v), line)
                    if sd is None:
                        continue

                    sid = det_track_to_sid.get(tid)
                    if sid is None:
                        best_sid = None
                        best_d2 = None
                        for cand_sid, (su, sv, sts) in stable_by_uv.items():
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
                                best_sid = int(cand_sid)
                        if best_sid is not None:
                            sid = best_sid
                        else:
                            sid = int(stable_next_id)
                            stable_next_id += 1
                        det_track_to_sid[int(tid)] = int(sid)

                    stable_by_uv[int(sid)] = (float(foot_u), float(foot_v), float(now_ts))

                    prev = geom_by_tid.get(int(tid))
                    if prev is None:
                        geom_by_tid[int(tid)] = {
                            "last_sd": float(sd),
                            "last_foot_u": float(foot_u),
                            "last_foot_v": float(foot_v),
                            "last_ts": float(det_ts),
                            "armed": True,
                            "cooldown_until_ts": 0.0,
                        }
                        continue

                    prev_sd = float(prev.get("last_sd") or 0.0)
                    armed = bool(prev.get("armed", True))
                    cooldown_until_ts = float(prev.get("cooldown_until_ts") or 0.0)
                    rearm_sd_thr = float(rearm_sd_mult) * float(line.zone_w)

                    if (not armed) or (det_ts < cooldown_until_ts):
                        if abs(float(sd)) > rearm_sd_thr:
                            prev["armed"] = True
                            prev["cooldown_until_ts"] = 0.0
                        prev["last_sd"] = float(sd)
                        prev["last_foot_u"] = float(foot_u)
                        prev["last_foot_v"] = float(foot_v)
                        prev["last_ts"] = float(det_ts)
                        geom_by_tid[int(tid)] = prev
                        continue

                    counted_dir: Optional[str] = None

                    prev_foot_u = float(prev.get("last_foot_u"))
                    prev_foot_v = float(prev.get("last_foot_v"))

                    intersects = self._segments_intersect(
                        prev_foot_u,
                        prev_foot_v,
                        float(foot_u),
                        float(foot_v),
                        p1u,
                        p1v,
                        p2u,
                        p2v,
                    )

                    if intersects:
                        cross_z = self._motion_cross_line(
                            line, prev_foot_u, prev_foot_v, float(foot_u), float(foot_v)
                        )
                        strong = (prev_sd > sd_tol and sd < -sd_tol) or (prev_sd < -sd_tol and sd > sd_tol)
                        if strong:
                            counted_dir = "in" if float(sd) > 0 else "out"
                        elif abs(prev_sd) <= sd_tol or abs(float(sd)) <= sd_tol:
                            if abs(cross_z) >= cross_z_min:
                                counted_dir = "in" if cross_z > 0 else "out"
                        elif prev_sd * float(sd) < 0:
                            counted_dir = "in" if float(sd) > 0 else "out"
                        elif abs(cross_z) >= cross_z_min:
                            counted_dir = "in" if cross_z > 0 else "out"

                    if counted_dir is not None:
                        # 同一 track 的近时、近落脚点、同方向重复触发抑制（抖动/ID 未变时的双计）
                        if recent_crosses:
                            cutoff_ts = det_ts - cross_dedup_dt
                            recent_crosses = [c for c in recent_crosses if float(c[3]) >= cutoff_ts]

                        suppressed = False
                        if recent_crosses:
                            du = float(foot_u)
                            dv = float(foot_v)
                            r2 = float(cross_pos_dist) * float(cross_pos_dist)
                            for (rtid, ru, rv, rts, rdir) in recent_crosses:
                                if int(rtid) != int(tid):
                                    continue
                                if rdir != counted_dir:
                                    continue
                                if abs(det_ts - float(rts)) > cross_dedup_dt:
                                    continue
                                dx = du - float(ru)
                                dy = dv - float(rv)
                                if dx * dx + dy * dy <= r2:
                                    suppressed = True
                                    break
                        if suppressed:
                            counted_dir = None

                    if counted_dir is not None:
                        gender = None
                        age_bucket = None
                        # 性别/年龄只在“进入(in)”时返回，用于统计；“离开(out)”不做性别/年龄统计
                        if counted_dir == "in":
                            try:
                                if genders is not None and idx < len(genders):
                                    gender = genders[idx]
                            except Exception:
                                gender = None
                            try:
                                if age_buckets is not None and idx < len(age_buckets):
                                    age_bucket = age_buckets[idx]
                            except Exception:
                                age_bucket = None
                        event = {
                            "type": "footfall_cross",
                            "floor_plan_id": int(floor_plan_id),
                            "virtual_view_id": int(virtual_view_id),
                            "line_config_id": line_config_id,
                            "track_id": int(tid),
                            "stable_id": int(sid),
                            "direction": counted_dir,
                            "gender": gender,
                            "age_bucket": age_bucket,
                            "ts": float(det_ts),
                            "foot_u": float(foot_u),
                            "foot_v": float(foot_v),
                        }
                        try:
                            await self._broadcast(event)
                        except Exception:
                            pass
                        # 仅对进入方向抓拍，并且每个稳定ID每次进入只抓拍一次
                        if counted_dir == "in":
                            try:
                                manager.capture_enter_face_once(
                                    floor_plan_id=int(floor_plan_id),
                                    line_config_id=int(line_config_id),
                                    virtual_view_id=int(virtual_view_id),
                                    track_id=int(tid),
                                    stable_id=int(sid),
                                    ts=float(det_ts),
                                )
                            except Exception:
                                pass

                        recent_crosses.append((int(tid), float(foot_u), float(foot_v), float(det_ts), counted_dir))

                        # 穿越一次后先关掉：离开近线带后再允许下一次计数
                        prev["armed"] = False
                        prev["cooldown_until_ts"] = float(det_ts) + float(cooldown_sec)

                    prev["last_sd"] = float(sd)
                    prev["last_foot_u"] = float(foot_u)
                    prev["last_foot_v"] = float(foot_v)
                    prev["last_ts"] = float(det_ts)
                    geom_by_tid[int(tid)] = prev

                await asyncio.sleep(emit_interval_sec)
        except asyncio.CancelledError:
            return
        finally:
            # no-op; stable cleanup is handled by ttl
            pass


# global instance
analyzer = FootfallAnalyzer()

