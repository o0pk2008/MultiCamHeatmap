import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from .virtual_view_inference import manager
from .queue_wait_store import record_queue_visit_sync


def _foot_norm_uv_from_xyxy(
    x1: float, y1: float, x2: float, y2: float, w: int, h: int
) -> Optional[Tuple[float, float]]:
    """
    与热力图网格判定、人流量过线、本文件 virtual_view_inference 画脚步点一致：
    取 bbox 底边中心，并沿 bbox 高度向上 1% 作为“站立/接地点”，再除以帧宽高得到与 ROI 四边形一致的归一化图像坐标。
    """
    if w <= 1 or h <= 1:
        return None
    foot_x = float(x1 + x2) * 0.5
    foot_y = float(y2) - 0.01 * float(y2 - y1)
    foot_u = foot_x / float(w)
    foot_v = foot_y / float(h)
    if not (0.0 <= foot_u <= 1.0 and 0.0 <= foot_v <= 1.0):
        return None
    return (foot_u, foot_v)


def _point_in_poly(u: float, v: float, poly: List[Tuple[float, float]]) -> bool:
    if len(poly) < 3:
        return False
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = float(poly[i][0]), float(poly[i][1])
        xj, yj = float(poly[j][0]), float(poly[j][1])
        if ((yi > v) != (yj > v)) and (
            u < (xj - xi) * (v - yi) / (yj - yi + 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _parse_quad_json(raw: str) -> Optional[List[Tuple[float, float]]]:
    try:
        data = json.loads(raw or "[]")
        if not isinstance(data, list) or len(data) != 4:
            return None
        out: List[Tuple[float, float]] = []
        for it in data:
            if not isinstance(it, dict):
                return None
            out.append((float(it["x"]), float(it["y"])))
        return out
    except Exception:
        return None


class QueueWaitAnalyzer:
    """排队 ROI + 服务区 ROI：按 track_id 状态机累计时长；是否在区内以对齐热力图/过线的脚底归一化点做 point-in-polygon，并在画面叠加每人的 Q/S 秒数。"""

    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._stops: Dict[str, asyncio.Event] = {}
        self._session_ctx: Dict[str, Dict[str, Any]] = {}
        # 按会话缓存最近一帧几何意义下 ROI 内人数；供前端监控边框「进入」高亮轮询。
        self._live_occupancy: Dict[str, Dict[str, Any]] = {}
        # 可由系统设置或环境变量初始化；运行中后台可改写。
        self._post_service_queue_ignore_sec: float = float(
            os.environ.get("QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_SEC", "30")
        )
        # 脚底直进服务区、未经过排队：仅当服务停留 ≥ 该秒数并离开后落库并计入「完成笔数」。
        self._direct_service_complete_min_sec: float = float(
            os.environ.get("QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_SEC", "3")
        )
        # 曾进排队区但未进服务区就离开：排队停留 < 该秒数则不落库，不计弃单（视作路过）。
        self._abandon_min_queue_sec: float = float(
            os.environ.get("QUEUE_WAIT_ABANDON_MIN_QUEUE_SEC", "2")
        )

    def get_post_service_queue_ignore_sec(self) -> float:
        return float(self._post_service_queue_ignore_sec)

    def set_post_service_queue_ignore_sec(self, sec: float) -> None:
        self._post_service_queue_ignore_sec = max(0.0, float(sec))

    def get_direct_service_complete_min_sec(self) -> float:
        return float(self._direct_service_complete_min_sec)

    def set_direct_service_complete_min_sec(self, sec: float) -> None:
        self._direct_service_complete_min_sec = max(0.0, float(sec))

    def get_abandon_min_queue_sec(self) -> float:
        return float(self._abandon_min_queue_sec)

    def set_abandon_min_queue_sec(self, sec: float) -> None:
        self._abandon_min_queue_sec = max(0.0, float(sec))

    @staticmethod
    def _session_key(floor_plan_id: int, virtual_view_id: int) -> str:
        return f"qfp{int(floor_plan_id)}-qvv{int(virtual_view_id)}"

    def is_running(self, floor_plan_id: int, virtual_view_id: int) -> bool:
        return self._session_key(floor_plan_id, virtual_view_id) in self._tasks

    def start(
        self,
        *,
        floor_plan_id: int,
        virtual_view_id: int,
        roi_config_id: int,
        queue_poly: List[Tuple[float, float]],
        service_poly: List[Tuple[float, float]],
        emit_interval_sec: float = 0.05,
    ) -> None:
        key = self._session_key(floor_plan_id, virtual_view_id)
        self._session_ctx[key] = {
            "floor_plan_id": int(floor_plan_id),
            "virtual_view_id": int(virtual_view_id),
            "roi_config_id": int(roi_config_id),
            "queue_poly": list(queue_poly),
            "service_poly": list(service_poly),
        }
        try:
            manager.set_queue_wait_overlay(
                int(virtual_view_id),
                queue_pts=list(queue_poly),
                service_pts=list(service_poly),
            )
        except Exception:
            pass

        if key in self._tasks:
            return

        stop_event = asyncio.Event()
        self._stops[key] = stop_event
        loop = asyncio.get_running_loop()
        self._tasks[key] = loop.create_task(
            self._run_session(key, emit_interval_sec, stop_event),
        )
        try:
            manager.acquire_inference(int(virtual_view_id))
        except Exception:
            pass

    def patch_running_rois(
        self,
        floor_plan_id: int,
        virtual_view_id: int,
        queue_poly: List[Tuple[float, float]],
        service_poly: List[Tuple[float, float]],
    ) -> None:
        """分析进行中用户「保存 ROI」时同步内存中的多边形与视频叠加，下一轮检测即用新区域。"""
        key = self._session_key(floor_plan_id, virtual_view_id)
        if key not in self._tasks:
            return
        ctx = self._session_ctx.get(key)
        if ctx is None:
            return
        ctx["queue_poly"] = list(queue_poly)
        ctx["service_poly"] = list(service_poly)
        try:
            manager.set_queue_wait_overlay(
                int(virtual_view_id),
                queue_pts=list(queue_poly),
                service_pts=list(service_poly),
            )
        except Exception:
            pass

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
        self._session_ctx.pop(key, None)
        self._live_occupancy.pop(key, None)
        try:
            manager.clear_queue_wait_overlay(int(virtual_view_id))
            manager.clear_queue_wait_labels(int(virtual_view_id))
        except Exception:
            pass

    def get_live_occupancy(self, floor_plan_id: int, virtual_view_id: int) -> Dict[str, Any]:
        key = self._session_key(floor_plan_id, virtual_view_id)
        running = key in self._tasks
        snap = self._live_occupancy.get(key)
        if snap:
            return {
                "running": running,
                "in_queue": int(snap.get("in_queue") or 0),
                "in_service": int(snap.get("in_service") or 0),
                "ts": float(snap.get("ts") or 0.0),
                "queue_pulse_ts": float(snap.get("queue_pulse_ts") or 0.0),
                "service_pulse_ts": float(snap.get("service_pulse_ts") or 0.0),
            }
        return {
            "running": running,
            "in_queue": 0,
            "in_service": 0,
            "ts": 0.0,
            "queue_pulse_ts": 0.0,
            "service_pulse_ts": 0.0,
        }

    def _flush_tid(
        self,
        *,
        tid: int,
        st: Dict[str, Any],
        now_ts: float,
        roi_config_id: int,
        floor_plan_id: int,
        virtual_view_id: int,
    ) -> None:
        phase = str(st.get("phase") or "idle")
        if phase == "idle":
            return
        try:
            if phase == "queue":
                q0 = float(st.get("queue_t0") or now_ts)
                qsec = max(0.0, float(now_ts) - q0)
                if qsec < float(self._abandon_min_queue_sec):
                    return
                record_queue_visit_sync(
                    roi_config_id=roi_config_id,floor_plan_id=floor_plan_id,virtual_view_id=virtual_view_id,track_id=int(tid),
                    queue_seconds=qsec,service_seconds=None,end_ts=float(now_ts),
                )
            elif phase == "service":
                q_at = float(st.get("queue_sec_fixed") or 0.0)
                s0 = float(st.get("service_t0") or now_ts)
                ssec = max(0.0, float(now_ts) - s0)
                if q_at <= 1e-6 and ssec < float(self._direct_service_complete_min_sec):
                    return
                record_queue_visit_sync(
                    roi_config_id=roi_config_id,floor_plan_id=floor_plan_id,virtual_view_id=virtual_view_id,track_id=int(tid),
                    queue_seconds=q_at,service_seconds=ssec,end_ts=float(now_ts),
                )
        except Exception:
            pass

    async def _run_session(
        self,
        session_key: str,
        emit_interval_sec: float,
        stop_event: asyncio.Event,
    ) -> None:
        ctx = self._session_ctx.get(session_key) or {}
        roi_config_id = int(ctx.get("roi_config_id") or 0)
        floor_plan_id = int(ctx.get("floor_plan_id") or 0)
        virtual_view_id = int(ctx.get("virtual_view_id") or 0)

        ttl = float(os.environ.get("QUEUE_WAIT_TRACK_TTL_SEC", "2.5"))
        # 排队中脚步短暂落在「排队区、服务区之外」（两 ROI 间隙、贴边 bbox 抖动）时，不立刻判弃单；持续超过该秒数才落库弃单。
        queue_neither_grace = float(os.environ.get("QUEUE_WAIT_QUEUE_NEITHER_GRACE_SEC", "1.2"))
        # 脚步短暂跑出服务区多边形（遮挡/抖动）时，不立刻结束服务；持续超过该秒数才闭环为一次成交。
        service_out_grace = float(os.environ.get("QUEUE_WAIT_SERVICE_OUT_GRACE_SEC", "0.45"))
        # 脚底点平滑：EMA 系数（越大越跟随当前帧，越小越平滑）。
        foot_smooth_alpha = float(os.environ.get("QUEUE_WAIT_FOOT_SMOOTH_ALPHA", "0.65"))
        foot_smooth_alpha = min(1.0, max(0.0, foot_smooth_alpha))
        # track 若长时间未出现，清理其平滑状态，避免后续复用 track_id 时继承旧位置。
        foot_smooth_ttl = float(os.environ.get("QUEUE_WAIT_FOOT_SMOOTH_TTL_SEC", "3.0"))
        states: Dict[int, Dict[str, Any]] = {}
        foot_smooth: Dict[int, Tuple[float, float, float]] = {}
        last_emit_det_ts = 0.0

        try:
            while not stop_event.is_set():
                post_service_queue_ignore_sec = float(self._post_service_queue_ignore_sec)
                abandon_min_q = float(self._abandon_min_queue_sec)
                direct_svc_min = float(self._direct_service_complete_min_sec)
                live = self._session_ctx.get(session_key)
                if not live:
                    break
                queue_poly = list(live.get("queue_poly") or [])
                service_poly = list(live.get("service_poly") or [])

                det = manager.get_latest_detections(int(virtual_view_id))
                if det is None:
                    await asyncio.sleep(emit_interval_sec)
                    continue
                det_ts = float(getattr(det, "ts", 0.0) or 0.0)
                if det_ts <= 0:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                xyxy = getattr(det, "xyxy", None)
                cls_ids = getattr(det, "cls", None)
                if xyxy is None or cls_ids is None:
                    await asyncio.sleep(emit_interval_sec)
                    continue
                track_ids = getattr(det, "track_ids", None)
                if track_ids is None:
                    track_ids = getattr(det, "ids", None)
                w = int(getattr(det, "w", 0) or 0)
                h = int(getattr(det, "h", 0) or 0)
                if w <= 1 or h <= 1:
                    await asyncio.sleep(emit_interval_sec)
                    continue

                if det_ts <= last_emit_det_ts:
                    await asyncio.sleep(emit_interval_sec)
                    continue
                last_emit_det_ts = det_ts

                active: Dict[int, Tuple[float, float, int]] = {}
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
                    foot_uv = _foot_norm_uv_from_xyxy(
                        float(x1), float(y1), float(x2), float(y2), w, h
                    )
                    if foot_uv is None:
                        continue
                    foot_u, foot_v = foot_uv
                    prev_s = foot_smooth.get(int(tid))
                    if prev_s is not None:
                        prev_u, prev_v, prev_ts = prev_s
                        if float(det_ts) - float(prev_ts) <= foot_smooth_ttl:
                            foot_u = (foot_smooth_alpha * float(foot_u)) + (
                                (1.0 - foot_smooth_alpha) * float(prev_u)
                            )
                            foot_v = (foot_smooth_alpha * float(foot_v)) + (
                                (1.0 - foot_smooth_alpha) * float(prev_v)
                            )
                    foot_smooth[int(tid)] = (float(foot_u), float(foot_v), float(det_ts))
                    active[int(tid)] = (float(foot_u), float(foot_v), int(idx))

                cnt_queue_geom = 0
                cnt_service_geom = 0
                for _tid_g, (fu_g, fv_g, _ix_g) in active.items():
                    in_q_raw = _point_in_poly(fu_g, fv_g, queue_poly)
                    in_s_g = _point_in_poly(fu_g, fv_g, service_poly)
                    in_queue_effective_g = bool(in_q_raw) and not bool(in_s_g)
                    if in_s_g:
                        cnt_service_geom += 1
                    elif in_queue_effective_g:
                        cnt_queue_geom += 1

                prev_pair = live.get("_occ_prev_counts")
                pq = int(prev_pair[0]) if isinstance(prev_pair, (list, tuple)) and len(prev_pair) == 2 else -1
                ps = int(prev_pair[1]) if isinstance(prev_pair, (list, tuple)) and len(prev_pair) == 2 else -1
                occ_prev = self._live_occupancy.get(session_key) or {}
                queue_pulse_ts = float(occ_prev.get("queue_pulse_ts") or 0.0)
                service_pulse_ts = float(occ_prev.get("service_pulse_ts") or 0.0)
                ts_wall = float(time.time())
                if pq >= 0:
                    if cnt_queue_geom > pq:
                        queue_pulse_ts = ts_wall
                    if cnt_service_geom > ps:
                        service_pulse_ts = ts_wall
                live["_occ_prev_counts"] = (cnt_queue_geom, cnt_service_geom)
                self._live_occupancy[session_key] = {
                    "floor_plan_id": floor_plan_id,
                    "virtual_view_id": virtual_view_id,
                    "in_queue": int(cnt_queue_geom),
                    "in_service": int(cnt_service_geom),
                    "ts": float(det_ts),
                    "queue_pulse_ts": queue_pulse_ts,
                    "service_pulse_ts": service_pulse_ts,
                }

                labels: Dict[int, str] = {}

                for tid, (fu, fv, _idx) in active.items():
                    in_q_raw = _point_in_poly(fu, fv, queue_poly)
                    in_s = _point_in_poly(fu, fv, service_poly)
                    # 服务区与排队区重叠时，服务区优先：身处重叠区视为「在服务」，不计入排队区
                    in_queue_effective = bool(in_q_raw) and not bool(in_s)

                    st = states.get(int(tid))
                    if st is None:
                        st = {"phase": "idle", "last_ts": float(det_ts)}
                        states[int(tid)] = st
                    st["last_ts"] = float(det_ts)

                    phase = str(st.get("phase") or "idle")

                    if phase == "idle":
                        ign_until = st.get("post_service_ignore_until")
                        if in_s:
                            st["phase"] = "service"
                            st["queue_sec_fixed"] = 0.0
                            st["service_t0"] = float(det_ts)
                            st.pop("post_service_ignore_until", None)
                        elif in_queue_effective:
                            if ign_until is None or float(det_ts) >= float(ign_until):
                                st["phase"] = "queue"
                                st["queue_t0"] = float(det_ts)
                                st.pop("queue_neither_since", None)
                                st.pop("post_service_ignore_until", None)
                        else:
                            if ign_until is not None and float(det_ts) >= float(ign_until):
                                st.pop("post_service_ignore_until", None)
                    elif phase == "queue":
                        if in_s:
                            q0 = float(st.get("queue_t0") or det_ts)
                            st["queue_sec_fixed"] = max(0.0, float(det_ts) - q0)
                            st["phase"] = "service"
                            st["service_t0"] = float(det_ts)
                            st.pop("queue_neither_since", None)
                            st.pop("post_service_ignore_until", None)
                        elif in_queue_effective:
                            st.pop("queue_neither_since", None)
                        elif not in_queue_effective and not in_s:
                            qn0 = st.get("queue_neither_since")
                            if qn0 is None:
                                st["queue_neither_since"] = float(det_ts)
                            elif float(det_ts) - float(qn0) >= queue_neither_grace:
                                q0 = float(st.get("queue_t0") or det_ts)
                                qsec = max(0.0, float(det_ts) - q0)
                                try:
                                    # 弃单闭环：离开排队有效区且长时间未进入服务区；极短停留视为路过不落库
                                    if qsec >= abandon_min_q:
                                        record_queue_visit_sync(
                                            roi_config_id=roi_config_id,
                                            floor_plan_id=floor_plan_id,
                                            virtual_view_id=virtual_view_id,
                                            track_id=int(tid),
                                            queue_seconds=qsec,
                                            service_seconds=None,
                                            end_ts=float(det_ts),
                                        )
                                except Exception:
                                    pass
                                st["phase"] = "idle"
                                st.pop("queue_t0", None)
                                st.pop("queue_neither_since", None)
                    elif phase == "service":
                        if not in_s:
                            so0 = st.get("service_out_since")
                            if so0 is None:
                                st["service_out_since"] = float(det_ts)
                            elif float(det_ts) - float(so0) >= service_out_grace:
                                q_at = float(st.get("queue_sec_fixed") or 0.0)
                                s0 = float(st.get("service_t0") or det_ts)
                                ssec = max(0.0, float(det_ts) - s0)
                                try:
                                    if q_at > 1e-6 or ssec >= direct_svc_min:
                                        record_queue_visit_sync(
                                            roi_config_id=roi_config_id,
                                            floor_plan_id=floor_plan_id,
                                            virtual_view_id=virtual_view_id,
                                            track_id=int(tid),
                                            queue_seconds=q_at,
                                            service_seconds=ssec,
                                            end_ts=float(det_ts),
                                        )
                                except Exception:
                                    pass
                                st["phase"] = "idle"
                                for k in (
                                    "queue_sec_fixed",
                                    "service_t0",
                                    "queue_t0",
                                    "service_out_since",
                                    "queue_neither_since",
                                ):
                                    st.pop(k, None)
                                if post_service_queue_ignore_sec > 0:
                                    st["post_service_ignore_until"] = float(det_ts) + float(
                                        post_service_queue_ignore_sec
                                    )
                        else:
                            st.pop("service_out_since", None)

                    phase = str(st.get("phase") or "idle")
                    if phase == "queue":
                        q0 = float(st.get("queue_t0") or det_ts)
                        qsec = int(max(0.0, float(det_ts) - q0))
                        labels[int(tid)] = f"Queue wait: {qsec}s"
                    elif phase == "service":
                        s0 = float(st.get("service_t0") or det_ts)
                        ssec = int(max(0.0, float(det_ts) - s0))
                        # 在服务区内只显示服务时长（重叠区已按服务区优先，不再展示排队倒计时）
                        labels[int(tid)] = f"Service time: {ssec}s"

                for tid in list(states.keys()):
                    if int(tid) in active:
                        continue
                    st = states[int(tid)]
                    ls = float(st.get("last_ts") or 0.0)
                    if float(det_ts) - ls > ttl:
                        self._flush_tid(
                            tid=int(tid),st=st,now_ts=float(det_ts),roi_config_id=roi_config_id,floor_plan_id=floor_plan_id,virtual_view_id=virtual_view_id,
                        )
                        states.pop(int(tid), None)
                    ps = foot_smooth.get(int(tid))
                    if ps is not None and float(det_ts) - float(ps[2]) > foot_smooth_ttl:
                        foot_smooth.pop(int(tid), None)

                try:
                    manager.set_queue_wait_labels(int(virtual_view_id), labels)
                except Exception:
                    pass

                await asyncio.sleep(emit_interval_sec)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            self._live_occupancy.pop(session_key, None)
            for tid, st in list(states.items()):
                try:
                    self._flush_tid(
                        tid=int(tid),
                        st=st,
                        now_ts=float(time.time()),
                        roi_config_id=roi_config_id,
                        floor_plan_id=floor_plan_id,
                        virtual_view_id=virtual_view_id,
                    )
                except Exception:
                    pass
            try:
                manager.clear_queue_wait_labels(int(virtual_view_id))
            except Exception:
                pass


analyzer = QueueWaitAnalyzer()
