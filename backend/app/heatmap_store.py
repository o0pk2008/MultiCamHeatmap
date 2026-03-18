import asyncio
from typing import Any, Dict, Optional

import threading

from .db import SessionLocal
from . import models

_recording_floor_plans = set()  # floor_plan_id
_recording_lock = threading.Lock()


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
        # 缺失 ts 时用当前事件循环时间（近似）
        ts = asyncio.get_event_loop().time() if asyncio.get_event_loop().is_running() else 0.0

    camera_id = _to_int_or_none(event.get("camera_id"))
    virtual_view_id = _to_int_or_none(event.get("virtual_view_id"))

    with SessionLocal() as db:
        db.add(
            models.HeatmapEvent(
                floor_plan_id=floor_plan_id,
                floor_row=floor_row,
                floor_col=floor_col,
                camera_id=camera_id,
                virtual_view_id=virtual_view_id,
                ts=float(ts),
            )
        )
        db.commit()


async def record_heatmap_event(event: Dict[str, Any]) -> None:
    """异步写库：丢到线程池，避免阻塞主事件循环。"""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, record_heatmap_event_sync, event)

