import asyncio
import time
from typing import Any, Dict, Optional, Tuple

import threading

from sqlalchemy.exc import OperationalError

from .db import SessionLocal
from . import models

_recording_floor_plans = set()  # floor_plan_id
_recording_lock = threading.Lock()
_db_write_lock = threading.Lock()
_current_lock = threading.Lock()
_current_dwell_sec: Dict[int, Dict[str, float]] = {}
_current_last_by_source: Dict[int, Dict[str, Tuple[float, str]]] = {}


def set_recording(floor_plan_id: int, enabled: bool) -> None:
    with _recording_lock:
        if enabled:
            _recording_floor_plans.add(int(floor_plan_id))
        else:
            _recording_floor_plans.discard(int(floor_plan_id))


def is_recording(floor_plan_id: Optional[int]) -> bool:
    if floor_plan_id is None:
        return False
    with _recording_lock:
        return int(floor_plan_id) in _recording_floor_plans


def _to_int_or_none(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _to_float_or_none(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def record_heatmap_event_sync(event: Dict[str, Any]) -> None:
    """
    同步写库（用于后台线程或 executor）。
    event 预期字段：
      floor_plan_id, floor_row, floor_col, camera_id?, virtual_view_id?, ts?
    """
    floor_plan_id = _to_int_or_none(event.get("floor_plan_id"))
    floor_row = _to_int_or_none(event.get("floor_row"))
    floor_col = _to_int_or_none(event.get("floor_col"))
    if floor_plan_id is None or floor_row is None or floor_col is None:
        return

    ts = _to_float_or_none(event.get("ts"))
    if ts is None:
        ts = time.time()

    camera_id = _to_int_or_none(event.get("camera_id"))
    virtual_view_id = _to_int_or_none(event.get("virtual_view_id"))

    # SQLite 并发写会锁表：这里用单写者锁串行化，再加重试
    payload = models.HeatmapEvent(
        floor_plan_id=floor_plan_id,
        floor_row=floor_row,
        floor_col=floor_col,
        camera_id=camera_id,
        virtual_view_id=virtual_view_id,
        ts=float(ts),
    )
    retries = 8
    backoff = 0.03
    for i in range(retries):
        try:
            with _db_write_lock:
                with SessionLocal() as db:
                    db.add(payload)
                    db.commit()
            return
        except OperationalError as e:
            msg = str(e).lower()
            if "database is locked" in msg or "database locked" in msg:
                # 轻量退避，给写锁释放机会
                try:
                    import time
                    time.sleep(backoff * (1.6 ** i))
                except Exception:
                    pass
                continue
            return
        except Exception:
            return


async def record_heatmap_event(event: Dict[str, Any]) -> None:
    """异步写库：丢到线程池，避免阻塞主事件循环。"""
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, record_heatmap_event_sync, event)
    except Exception:
        # 避免 "Task exception was never retrieved"
        return


def reset_current_dwell(floor_plan_id: int) -> None:
    with _current_lock:
        _current_dwell_sec.pop(int(floor_plan_id), None)
        _current_last_by_source.pop(int(floor_plan_id), None)


def update_current_dwell(event: Dict[str, Any], max_dt_sec: float = 2.0) -> None:
    floor_plan_id = _to_int_or_none(event.get("floor_plan_id"))
    floor_row = _to_int_or_none(event.get("floor_row"))
    floor_col = _to_int_or_none(event.get("floor_col"))
    if floor_plan_id is None or floor_row is None or floor_col is None:
        return

    ts = _to_float_or_none(event.get("ts"))
    if ts is None:
        ts = time.time()

    vv_id = _to_int_or_none(event.get("virtual_view_id"))
    cam_id = _to_int_or_none(event.get("camera_id"))
    if vv_id is not None:
        source_key = f"virtual:{vv_id}"
    elif cam_id is not None:
        source_key = f"camera:{cam_id}"
    else:
        source_key = "unknown"

    cell_key = f"{floor_row},{floor_col}"

    with _current_lock:
        last_map = _current_last_by_source.setdefault(int(floor_plan_id), {})
        dwell_map = _current_dwell_sec.setdefault(int(floor_plan_id), {})
        prev = last_map.get(source_key)
        if prev is not None:
            prev_ts, prev_cell = prev
            dt = ts - prev_ts
            if dt > 0:
                dt = min(float(dt), float(max_dt_sec))
                dwell_map[prev_cell] = float(dwell_map.get(prev_cell, 0.0) + dt)
        last_map[source_key] = (float(ts), cell_key)


def get_current_dwell(floor_plan_id: int) -> Dict[str, float]:
    with _current_lock:
        m = _current_dwell_sec.get(int(floor_plan_id), {})
        return dict(m)
