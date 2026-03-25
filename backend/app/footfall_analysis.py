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


class FootfallAnalyzer:
    """
    在后端基于 YOLO 检测 + track(stable_id) 实时判断进入/离开。

    关键点：
    - 过线判定使用同一坐标系：foot_u/foot_v（bbox 底部中心->UV）
    - 进入/离开由线两侧符号变化 + 近线带 hysteresis 决定
    - 输出仅“翻边计数事件”，前端不再做过线状态机，从而避免丢帧漏检
    """

    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._stops: Dict[str, asyncio.Event] = {}

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
            # already running; ignore repeated start
            return
        stop_event = asyncio.Event()
        self._stops[key] = stop_event
        loop = asyncio.get_running_loop()
        self._tasks[key] = loop.create_task(
            self._run_session(key, floor_plan_id, virtual_view_id, line, emit_interval_sec, stop_event),
        )

        # 让 YOLO inference 保持运行（即使没有 analyzed.mjpeg 订阅者）
        try:
            manager.acquire_inference(int(virtual_view_id))
        except Exception:
            pass

    def is_running(self, floor_plan_id: int, virtual_view_id: int) -> bool:
        key = self._session_key(floor_plan_id, virtual_view_id)
        return key in self._tasks

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

    async def _run_session(
        self,
        session_key: str,
        floor_plan_id: int,
        virtual_view_id: int,
        line: FootfallLine,
        emit_interval_sec: float,
        stop_event: asyncio.Event,
    ) -> None:
        line_config_id = int(line.line_config_id)
        stable_next_id = 1

        # stable_id state: stable_id -> {last_sd, armed, cooldown_until_ts, last_ts}
        state_by_sid: Dict[int, Dict[str, Any]] = {}

        # stable association: track_id -> stable_id
        det_track_to_sid: Dict[int, int] = {}
        # stable memory for uv matching: sid -> (u, v, ts)
        stable_by_uv: Dict[int, Tuple[float, float, float]] = {}

        stable_ttl_sec = float(os.environ.get("HEATMAP_STABLE_ID_TTL_SEC", "2.5"))
        stable_match_dt_sec = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DT_SEC", "1.2"))
        stable_match_dist = float(os.environ.get("HEATMAP_STABLE_ID_MATCH_DIST", "0.18"))

        # 过线事件冷却：同一个对象穿越后需要冷却，并且离开近线带后才能重新计数
        cooldown_sec = float(os.environ.get("HEATMAP_FOOTFALL_COOLDOWN_SEC", "0.8"))

        rearm_sd_mult = float(os.environ.get("HEATMAP_FOOTFALL_REARM_SD_MULT", "1.4"))

        # 全局最近穿越去重：解决 stable_id/track_id 抖动导致的同一次经过重复计数
        cross_pos_dist = float(os.environ.get("HEATMAP_CROSS_POS_DIST", "0.03"))  # UV distance
        cross_dedup_dt = float(os.environ.get("HEATMAP_CROSS_DEDUP_DT_SEC", "1.0"))
        recent_crosses: list[Tuple[float, float, float, str]] = []  # (u,v,ts,dir)

        last_emit_ts_by_vv = 0.0

        try:
            while not stop_event.is_set():
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

                # pruning stable memories
                now_ts = det_ts
                for sid, (_u, _v, sts) in list(stable_by_uv.items()):
                    if now_ts - float(sts) > stable_ttl_sec:
                        stable_by_uv.pop(int(sid), None)
                        state_by_sid.pop(int(sid), None)

                # iterate detections
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
                    # sd 符号表示点位于判定线两侧；用于穿越方向判定

                    # stable id association
                    sid = det_track_to_sid.get(tid)
                    if sid is None:
                        # match by uv in recent memory
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

                    # update stable uv memory
                    stable_by_uv[int(sid)] = (float(foot_u), float(foot_v), float(now_ts))

                    prev = state_by_sid.get(int(sid))
                    if prev is None:
                        init_sign = 1 if sd > 0 else -1 if sd < 0 else 0
                        state_by_sid[int(sid)] = {
                            "last_sd": float(sd),
                            "last_foot_u": float(foot_u),
                            "last_foot_v": float(foot_v),
                            "last_nonzero_sign": init_sign,
                            "last_ts": det_ts,
                            "armed": True,
                            "cooldown_until_ts": 0.0,
                        }
                        continue

                    prev_sd = float(prev.get("last_sd") or 0.0)
                    curr_nonzero_sign = 1 if sd > 0 else -1 if sd < 0 else 0

                    armed = bool(prev.get("armed", True))
                    cooldown_until_ts = float(prev.get("cooldown_until_ts") or 0.0)
                    rearm_sd_thr = float(rearm_sd_mult) * float(line.zone_w)

                    # 冷却/未解锁状态：不计数；离开近线带后重新 armed
                    if (not armed) or (det_ts < cooldown_until_ts):
                        if abs(sd) > rearm_sd_thr:
                            prev["armed"] = True
                            prev["cooldown_until_ts"] = 0.0
                        prev["last_sd"] = float(sd)
                        prev["last_foot_u"] = float(foot_u)
                        prev["last_foot_v"] = float(foot_v)
                        prev["last_ts"] = float(det_ts)
                        state_by_sid[int(sid)] = prev
                        continue

                    counted_dir: Optional[str] = None

                    prev_foot_u = float(prev.get("last_foot_u") or foot_u)
                    prev_foot_v = float(prev.get("last_foot_v") or foot_v)

                    # 线段相交判定（更鲁棒，适配丢帧）
                    intersects = self._segments_intersect(
                        prev_foot_u,
                        prev_foot_v,
                        float(foot_u),
                        float(foot_v),
                        float(line.p1[0]),
                        float(line.p1[1]),
                        float(line.p2[0]),
                        float(line.p2[1]),
                    )

                    if intersects:
                        # 方向优先使用 signed-dist 符号翻转（保持与之前方向一致）
                        if prev_sd < 0 and sd > 0:
                            counted_dir = "in"
                        elif prev_sd > 0 and sd < 0:
                            counted_dir = "out"
                        else:
                            # 兜底：用 cross(LineVec, MoveVec) 决定方向
                            line_vec_x = float(line.p2[0] - line.p1[0])
                            line_vec_y = float(line.p2[1] - line.p1[1])
                            move_vec_x = float(foot_u - prev_foot_u)
                            move_vec_y = float(foot_v - prev_foot_v)
                            cross2 = line_vec_x * move_vec_y - line_vec_y * move_vec_x
                            counted_dir = "in" if cross2 > 0 else "out"

                    if counted_dir is not None:
                        # 全局最近穿越去重：同方向、同位置、同时间窗内的重复触发抑制
                        if recent_crosses:
                            cutoff_ts = det_ts - cross_dedup_dt
                            recent_crosses = [c for c in recent_crosses if float(c[2]) >= cutoff_ts]

                        suppressed = False
                        if recent_crosses:
                            du = float(foot_u)
                            dv = float(foot_v)
                            r2 = float(cross_pos_dist) * float(cross_pos_dist)
                            for (ru, rv, rts, rdir) in recent_crosses:
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

                        recent_crosses.append((float(foot_u), float(foot_v), float(det_ts), counted_dir))

                        # 穿越一次后先关掉：离开近线带后再允许下一次计数
                        prev["armed"] = False
                        prev["cooldown_until_ts"] = float(det_ts) + float(cooldown_sec)

                    # always update state
                    prev["last_sd"] = float(sd)
                    prev["last_foot_u"] = float(foot_u)
                    prev["last_foot_v"] = float(foot_v)
                    prev["last_ts"] = float(det_ts)
                    state_by_sid[int(sid)] = prev

                await asyncio.sleep(emit_interval_sec)
        except asyncio.CancelledError:
            return
        finally:
            # no-op; stable cleanup is handled by ttl
            pass


# global instance
analyzer = FootfallAnalyzer()

