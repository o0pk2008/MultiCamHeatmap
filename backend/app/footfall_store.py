import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.exc import OperationalError

from .db import SessionLocal
from . import models

_db_write_lock = threading.Lock()
_recent_event_lock = threading.Lock()
_recent_event_keys: Dict[Tuple[int, int, str, int, int], float] = {}


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


def _tz_from_offset_minutes(tz_offset_minutes: Optional[int]) -> timezone:
    # JS Date.getTimezoneOffset(): local = UTC - offset_minutes
    # e.g. Asia/Shanghai => -480 => timezone(+08:00)
    if tz_offset_minutes is None:
        # 默认使用容器本地时区（docker TZ）
        local_dt = datetime.now().astimezone()
        tzinfo = local_dt.tzinfo
        if isinstance(tzinfo, timezone):
            return tzinfo
        offset = local_dt.utcoffset() or timedelta(0)
        return timezone(offset)
    return timezone(-timedelta(minutes=int(tz_offset_minutes)))


def _normalize_stats_mode_range(
    mode: str,
    date_key: Optional[str],
    tz_offset_minutes: Optional[int] = None,
) -> Tuple[float, float]:
    tz = _tz_from_offset_minutes(tz_offset_minutes)
    if mode not in ("realtime", "date"):
        raise ValueError("invalid mode")
    if mode == "realtime":
        now = datetime.now(tz)
        start = datetime(now.year, now.month, now.day, tzinfo=tz)
        end = start + timedelta(days=1)
        return float(start.timestamp()), float(end.timestamp())
    if not date_key:
        raise ValueError("date_key required for date mode")
    try:
        y, m, d = [int(x) for x in str(date_key).split("-", 2)]
        start = datetime(y, m, d, tzinfo=tz)
    except Exception as e:  # pragma: no cover
        raise ValueError("invalid date_key") from e
    end = start + timedelta(days=1)
    return float(start.timestamp()), float(end.timestamp())


def get_footfall_stats_sync(
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",
    date_key: Optional[str] = None,
    tz_offset_minutes: Optional[int] = None,
) -> Dict[str, Any]:
    tz = _tz_from_offset_minutes(tz_offset_minutes)
    start_ts, end_ts = _normalize_stats_mode_range(
        mode=mode,
        date_key=date_key,
        tz_offset_minutes=tz_offset_minutes,
    )

    age_buckets = ["0-12", "18-25", "26-35", "36-45", "46-55", "55+"]
    age_bucket_counts: Dict[str, int] = {k: 0 for k in age_buckets}
    trend_in = [{"hour": h, "value": 0} for h in range(24)]
    trend_out = [{"hour": h, "value": 0} for h in range(24)]

    in_count = 0
    out_count = 0
    gender_male = 0
    gender_female = 0

    with SessionLocal() as db:
        cfg = (
            db.query(models.FootfallLineConfig)
            .filter(
                models.FootfallLineConfig.floor_plan_id == int(floor_plan_id),
                models.FootfallLineConfig.virtual_view_id == int(virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            return {
                "inCount": 0,
                "outCount": 0,
                "genderMale": 0,
                "genderFemale": 0,
                "ageBuckets": [{"label": k, "value": 0} for k in age_buckets],
                "trendIn": trend_in,
                "trendOut": trend_out,
            }

        events = (
            db.query(models.FootfallCrossEvent)
            .filter(
                models.FootfallCrossEvent.line_config_id == int(cfg.id),
                models.FootfallCrossEvent.ts >= float(start_ts),
                models.FootfallCrossEvent.ts < float(end_ts),
            )
            .order_by(models.FootfallCrossEvent.ts.asc())
            .all()
        )

        for e in events:
            try:
                h = datetime.fromtimestamp(float(e.ts), tz=tz).hour
            except Exception:
                continue

            if e.direction == "in":
                in_count += 1
                trend_in[h]["value"] += 1
                if e.gender == "male":
                    gender_male += 1
                elif e.gender == "female":
                    gender_female += 1
                if e.age_bucket in age_bucket_counts:
                    age_bucket_counts[str(e.age_bucket)] += 1
            else:
                out_count += 1
                trend_out[h]["value"] += 1

    return {
        "inCount": in_count,
        "outCount": out_count,
        "genderMale": gender_male,
        "genderFemale": gender_female,
        "ageBuckets": [{"label": k, "value": int(age_bucket_counts[k])} for k in age_buckets],
        "trendIn": trend_in,
        "trendOut": trend_out,
    }


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

    # 时间窗幂等去重，避免同一事件因重连/重复广播被重复写库
    # key: (line_config_id, stable_id_or_track_id, direction, ts_ms_bucket, pos_mm_bucket)
    sid_or_tid = stable_id if stable_id is not None else (track_id if track_id is not None else -1)
    ts_bucket = int(round(float(ts) * 1000.0))
    pos_bucket = int(round((float(foot_u or 0.0) * 1000.0))) * 2048 + int(round((float(foot_v or 0.0) * 1000.0)))
    dedup_key = (int(line_config_id), int(sid_or_tid), str(direction), ts_bucket, int(pos_bucket))
    now_ts = time.time()
    dedup_ttl_sec = 2.0
    with _recent_event_lock:
        cutoff = float(now_ts) - float(dedup_ttl_sec)
        for k, seen_ts in list(_recent_event_keys.items()):
            if float(seen_ts) < cutoff:
                _recent_event_keys.pop(k, None)
        if dedup_key in _recent_event_keys:
            return
        _recent_event_keys[dedup_key] = float(now_ts)

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

