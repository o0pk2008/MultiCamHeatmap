import asyncio
import threading
import time
from typing import Any, Dict, Optional

from sqlalchemy.exc import OperationalError

from .db import SessionLocal
from . import models

_db_write_lock = threading.Lock()


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


async def record_footfall_event(event: Dict[str, Any]) -> None:
    """
    异步写入 footfall_cross_events。
    event 预期包含：
      line_config_id, floor_plan_id, virtual_view_id, direction, ts
      可选：track_id, stable_id, foot_u, foot_v, gender, age_bucket
    """

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, record_footfall_event_sync, event)
    except Exception:
        return


def record_footfall_event_sync(event: Dict[str, Any]) -> None:
    line_config_id = _to_int_or_none(event.get("line_config_id"))
    floor_plan_id = _to_int_or_none(event.get("floor_plan_id"))
    virtual_view_id = _to_int_or_none(event.get("virtual_view_id"))
    direction = event.get("direction")

    if line_config_id is None or floor_plan_id is None or virtual_view_id is None:
        return
    if direction not in ("in", "out"):
        return

    ts = _to_float_or_none(event.get("ts"))
    if ts is None:
        ts = time.time()

    track_id = _to_int_or_none(event.get("track_id"))
    stable_id = _to_int_or_none(event.get("stable_id"))
    foot_u = _to_float_or_none(event.get("foot_u"))
    foot_v = _to_float_or_none(event.get("foot_v"))

    gender = event.get("gender")
    age_bucket = event.get("age_bucket")

    payload = models.FootfallCrossEvent(
        line_config_id=line_config_id,
        floor_plan_id=floor_plan_id,
        virtual_view_id=virtual_view_id,
        direction=str(direction),
        ts=float(ts),
        track_id=track_id,
        stable_id=stable_id,
        foot_u=foot_u,
        foot_v=foot_v,
        gender=gender if gender is not None else None,
        age_bucket=age_bucket if age_bucket is not None else None,
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
                try:
                    time.sleep(backoff * (1.6**i))
                except Exception:
                    pass
                continue
            return
        except Exception:
            return

