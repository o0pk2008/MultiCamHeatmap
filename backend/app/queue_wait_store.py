import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .db import SessionLocal
from . import models

_db_write_lock = threading.Lock()

# 与 routers/admin.py 中 AppSetting.key 一致（避免 queue_wait_store → admin 循环依赖）
_QW_KEY_DIRECT_SVC_MIN = "queue_wait_direct_service_complete_min_sec"
_QW_KEY_ABANDON_MIN_Q = "queue_wait_abandon_min_queue_sec"


def _queue_wait_stat_thresholds_sync() -> Tuple[float, float]:
    """统计口径：直进服务区计完成的最短服务秒数、计弃单的最短排队秒数（与当前数据库设置一致）。"""
    direct = float(os.environ.get("QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_SEC", "3"))
    abandon_m = float(os.environ.get("QUEUE_WAIT_ABANDON_MIN_QUEUE_SEC", "2"))
    try:
        with SessionLocal() as db:
            r_d = (
                db.query(models.AppSetting)
                .filter(models.AppSetting.key == _QW_KEY_DIRECT_SVC_MIN)
                .first()
            )
            if r_d is not None:
                direct = max(0.0, float(str(r_d.value)))
            r_a = (
                db.query(models.AppSetting)
                .filter(models.AppSetting.key == _QW_KEY_ABANDON_MIN_Q)
                .first()
            )
            if r_a is not None:
                abandon_m = max(0.0, float(str(r_a.value)))
    except Exception:
        pass
    return float(direct), float(abandon_m)


def _tz_from_offset_minutes(tz_offset_minutes: Optional[int]) -> timezone:
    if tz_offset_minutes is None:
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


def record_queue_visit_sync(
    *,
    roi_config_id: int,
    floor_plan_id: int,
    virtual_view_id: int,
    track_id: Optional[int],
    queue_seconds: float,
    service_seconds: Optional[float],
    end_ts: float,
) -> None:
    with _db_write_lock:
        with SessionLocal() as db:
            row = models.QueueWaitVisit(
                roi_config_id=int(roi_config_id),
                floor_plan_id=int(floor_plan_id),
                virtual_view_id=int(virtual_view_id),
                track_id=(int(track_id) if track_id is not None else None),
                queue_seconds=float(max(0.0, queue_seconds)),
                service_seconds=(float(service_seconds) if service_seconds is not None else None),
                end_ts=float(end_ts),
            )
            db.add(row)
            db.commit()


def _normalize_trend_bucket(raw: Optional[str]) -> str:
    k = str(raw or "1h").strip().lower()
    if k in ("1h", "hour", "60m", "60"):
        return "1h"
    if k in ("30m", "half", "1800"):
        return "30m"
    if k in ("1m", "min", "minute", "60s"):
        return "1m"
    raise ValueError("trend_bucket must be 1h, 30m or 1m")


def _trend_bucket_layout(bucket: str) -> Tuple[int, float]:
    if bucket == "1h":
        return 24, 3600.0
    if bucket == "30m":
        return 48, 1800.0
    if bucket == "1m":
        return 1440, 60.0
    raise ValueError("invalid bucket")


def _empty_trend_points(num_buckets: int) -> List[Dict[str, Any]]:
    return [{"bucket": i, "value": 0.0} for i in range(num_buckets)]


def _empty_trend_points_int(num_buckets: int) -> List[Dict[str, Any]]:
    return [{"bucket": i, "value": 0} for i in range(num_buckets)]


def _visit_bucket_index(end_ts: float, start_ts: float, bucket_seconds: float, num_buckets: int) -> Optional[int]:
    try:
        idx = int((float(end_ts) - float(start_ts)) // float(bucket_seconds))
    except Exception:
        return None
    if idx < 0 or idx >= int(num_buckets):
        return None
    return idx


def _samples_inside_bucket(bucket_seconds: float) -> int:
    """桶内排队长度采样次数：1 小时 60 次（每分钟），30 分钟 30 次，1 分钟 1 次。"""
    if bucket_seconds >= 3600:
        return 60
    if bucket_seconds >= 60:
        return max(1, int(bucket_seconds // 60))
    return 1


def _build_trend_series_for_bucket(
    *,
    visits: List[models.QueueWaitVisit],
    queue_intervals: List[Tuple[float, float]],
    start_ts: float,
    end_ts: float,
    bucket: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    num_buckets, bucket_seconds = _trend_bucket_layout(bucket)
    trend_queue: Dict[int, Dict[str, Any]] = {i: {"value": 0.0, "count": 0} for i in range(num_buckets)}
    trend_service: Dict[int, Dict[str, Any]] = {i: {"value": 0.0, "count": 0} for i in range(num_buckets)}

    for v in visits:
        try:
            idx = _visit_bucket_index(float(v.end_ts), start_ts, bucket_seconds, num_buckets)
        except Exception:
            idx = None
        if idx is None:
            continue
        q = float(v.queue_seconds or 0.0)
        trend_queue[idx]["value"] += q
        trend_queue[idx]["count"] += 1
        if v.service_seconds is not None:
            sv = float(v.service_seconds)
            trend_service[idx]["value"] += sv
            trend_service[idx]["count"] += 1

    out_tq: List[Dict[str, Any]] = []
    for i in range(num_buckets):
        c = int(trend_queue[i]["count"])
        avg = (float(trend_queue[i]["value"]) / c) if c > 0 else 0.0
        out_tq.append({"bucket": i, "value": round(avg, 2)})

    out_ts: List[Dict[str, Any]] = []
    for i in range(num_buckets):
        c = int(trend_service[i]["count"])
        avg = (float(trend_service[i]["value"]) / c) if c > 0 else 0.0
        out_ts.append({"bucket": i, "value": round(avg, 2)})

    trend_svc_count: List[Dict[str, Any]] = []
    trend_qlen: List[Dict[str, Any]] = []
    samples_per_bucket = _samples_inside_bucket(bucket_seconds)

    for i in range(num_buckets):
        hour_start = float(start_ts) + i * bucket_seconds
        hour_end = hour_start + bucket_seconds
        if hour_start >= float(end_ts) or hour_end <= float(start_ts):
            trend_svc_count.append({"bucket": i, "value": 0})
            trend_qlen.append({"bucket": i, "value": 0.0})
            continue
        hs = max(hour_start, float(start_ts))
        he = min(hour_end, float(end_ts))
        he = max(he, hs + 1e-6)

        direct_min, _abandon_m = _queue_wait_stat_thresholds_sync()
        svc_n = 0
        for v in visits:
            if not _visit_queued_then_served(v, direct_min):
                continue
            try:
                et = float(v.end_ts)
            except Exception:
                continue
            if hs <= et < he:
                svc_n += 1

        step = (he - hs) / float(samples_per_bucket)
        acc = 0.0
        used = 0
        for j in range(samples_per_bucket):
            t = hs + (j + 0.5) * step
            if t < float(start_ts) or t >= float(end_ts):
                continue
            cnt = 0
            for q0, q1 in queue_intervals:
                if q0 <= t < q1:
                    cnt += 1
            acc += float(cnt)
            used += 1
        avg_len = (acc / used) if used > 0 else 0.0
        trend_svc_count.append({"bucket": i, "value": int(svc_n)})
        trend_qlen.append({"bucket": i, "value": round(avg_len, 2)})

    return out_tq, out_ts, trend_svc_count, trend_qlen


def _visit_is_queue_abandon(v: models.QueueWaitVisit, abandon_min_queue_sec: float) -> bool:
    """曾产生排队时长，但未记录服务时长；排队停留需达到阈值才计弃单（低于阈值视为路过）。"""
    try:
        if v.service_seconds is not None:
            return False
        q = float(v.queue_seconds or 0.0)
        if q <= 1e-6:
            return False
        return q >= float(abandon_min_queue_sec) - 1e-9
    except Exception:
        return False


def _visit_queued_then_served(v: models.QueueWaitVisit, direct_service_min_sec: float) -> bool:
    """完成服务笔数：曾排队后成交，或直进服务区且服务停留达到阈值。"""
    try:
        if v.service_seconds is None:
            return False
        q = float(v.queue_seconds or 0.0)
        sv = float(v.service_seconds)
        if q > 1e-6:
            return True
        return sv >= float(direct_service_min_sec) - 1e-9
    except Exception:
        return False


def _trend_abandon_counts_for_bucket(
    visits: List[models.QueueWaitVisit],
    start_ts: float,
    end_ts: float,
    bucket: str,
    abandon_min_queue_sec: float,
) -> List[Dict[str, Any]]:
    num_buckets, bucket_seconds = _trend_bucket_layout(bucket)
    out: List[Dict[str, Any]] = []
    for i in range(num_buckets):
        hs = float(start_ts) + i * bucket_seconds
        he = hs + bucket_seconds
        n = 0
        for v in visits:
            if not _visit_is_queue_abandon(v, abandon_min_queue_sec):
                continue
            try:
                et = float(v.end_ts)
            except Exception:
                continue
            if hs <= et < he:
                n += 1
        out.append({"bucket": i, "value": int(n)})
    return out


def _trend_queued_then_served_counts_for_bucket(
    visits: List[models.QueueWaitVisit],
    start_ts: float,
    end_ts: float,
    bucket: str,
    direct_service_min_sec: float,
) -> List[Dict[str, Any]]:
    num_buckets, bucket_seconds = _trend_bucket_layout(bucket)
    out: List[Dict[str, Any]] = []
    for i in range(num_buckets):
        hs = float(start_ts) + i * bucket_seconds
        he = hs + bucket_seconds
        n = 0
        for v in visits:
            if not _visit_queued_then_served(v, direct_service_min_sec):
                continue
            try:
                et = float(v.end_ts)
            except Exception:
                continue
            if hs <= et < he:
                n += 1
        out.append({"bucket": i, "value": int(n)})
    return out


def _trend_abandon_rate_for_bucket(
    abandon_counts: List[Dict[str, Any]],
    served_counts: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i in range(len(abandon_counts)):
        a = int(abandon_counts[i].get("value") or 0)
        s = int(served_counts[i].get("value") or 0) if i < len(served_counts) else 0
        denom = a + s
        pct = round(100.0 * float(a) / float(denom), 2) if denom > 0 else 0.0
        out.append({"bucket": i, "value": float(pct)})
    return out


def _visit_queue_interval(v: models.QueueWaitVisit) -> Optional[Tuple[float, float]]:
    """排队停留区间 [start, end)（秒时间戳）。无排队时长则忽略。"""
    try:
        end = float(v.end_ts)
        q = max(0.0, float(v.queue_seconds or 0.0))
        if q <= 1e-6:
            return None
        if v.service_seconds is None:
            return (end - q, end)
        sv = max(0.0, float(v.service_seconds))
        return (end - sv - q, end - sv)
    except Exception:
        return None


def get_queue_wait_stats_sync(
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",
    date_key: Optional[str] = None,
    tz_offset_minutes: Optional[int] = None,
    trend_bucket_queue: Optional[str] = None,
    trend_bucket_service: Optional[str] = None,
    trend_bucket_footfall: Optional[str] = None,
    trend_bucket_abandon: Optional[str] = None,
) -> Dict[str, Any]:
    _ = _tz_from_offset_minutes(tz_offset_minutes)
    start_ts, end_ts = _normalize_stats_mode_range(
        mode=mode,
        date_key=date_key,
        tz_offset_minutes=tz_offset_minutes,
    )
    bq = _normalize_trend_bucket(trend_bucket_queue)
    bs = _normalize_trend_bucket(trend_bucket_service)
    bf = _normalize_trend_bucket(trend_bucket_footfall)
    ba = _normalize_trend_bucket(trend_bucket_abandon)
    n_q, _ = _trend_bucket_layout(bq)
    n_s, _ = _trend_bucket_layout(bs)
    n_f, _ = _trend_bucket_layout(bf)
    n_a, _ = _trend_bucket_layout(ba)
    direct_min_s, abandon_min_q = _queue_wait_stat_thresholds_sync()

    def _empty_payload() -> Dict[str, Any]:
        return {
            "visitCount": 0,
            "avgQueueSeconds": 0.0,
            "avgServiceSeconds": 0.0,
            "serviceSampleCount": 0,
            "abandonCount": 0,
            "queuedThenServedCount": 0,
            "abandonRatePercent": 0.0,
            "trendQueueAvg": _empty_trend_points(n_q),
            "trendServiceAvg": _empty_trend_points(n_s),
            "trendServiceCount": _empty_trend_points_int(n_f),
            "trendAvgQueueLength": _empty_trend_points(n_f),
            "trendAbandonCount": _empty_trend_points_int(n_a),
            "trendQueuedThenServedByBucket": _empty_trend_points_int(n_a),
            "trendAbandonRate": _empty_trend_points(n_a),
            "trendBucketQueue": bq,
            "trendBucketService": bs,
            "trendBucketFootfall": bf,
            "trendBucketAbandon": ba,
        }

    with SessionLocal() as db:
        cfg = (
            db.query(models.QueueWaitRoiConfig)
            .filter(
                models.QueueWaitRoiConfig.floor_plan_id == int(floor_plan_id),
                models.QueueWaitRoiConfig.virtual_view_id == int(virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            return _empty_payload()

        visits = (
            db.query(models.QueueWaitVisit)
            .filter(
                models.QueueWaitVisit.roi_config_id == int(cfg.id),
                models.QueueWaitVisit.end_ts >= float(start_ts),
                models.QueueWaitVisit.end_ts < float(end_ts),
            )
            .all()
        )

        queue_intervals: List[Tuple[float, float]] = []
        for v in visits:
            it = _visit_queue_interval(v)
            if it is None:
                continue
            qs, qe = it
            qs = max(qs, float(start_ts))
            qe = min(qe, float(end_ts))
            if qe > qs:
                queue_intervals.append((qs, qe))

        total_q = 0.0
        total_s = 0.0
        n_s = 0
        for v in visits:
            q = float(v.queue_seconds or 0.0)
            total_q += q
            if v.service_seconds is not None:
                total_s += float(v.service_seconds)
                n_s += 1

        n = len(visits)
        cache4: Dict[str, Tuple[Any, Any, Any, Any]] = {}

        def _series_for(b: str):
            if b not in cache4:
                cache4[b] = _build_trend_series_for_bucket(
                    visits=visits,
                    queue_intervals=queue_intervals,
                    start_ts=float(start_ts),
                    end_ts=float(end_ts),
                    bucket=b,
                )
            return cache4[b]

        tq_a, t_svc_pts, t_sc_f, t_ql_f = _series_for(bq)[0], _series_for(bs)[1], _series_for(bf)[2], _series_for(bf)[3]
        abandon_n = sum(1 for v in visits if _visit_is_queue_abandon(v, abandon_min_q))
        served_after_q_n = sum(1 for v in visits if _visit_queued_then_served(v, direct_min_s))
        denom = int(abandon_n) + int(served_after_q_n)
        abandon_rate_pct = (
            round(100.0 * float(abandon_n) / float(denom), 2) if denom > 0 else 0.0
        )
        t_abandon_cnt = _trend_abandon_counts_for_bucket(
            visits, float(start_ts), float(end_ts), ba, abandon_min_q
        )
        t_served_bucket = _trend_queued_then_served_counts_for_bucket(
            visits, float(start_ts), float(end_ts), ba, direct_min_s
        )
        t_abandon_rate = _trend_abandon_rate_for_bucket(t_abandon_cnt, t_served_bucket)

        return {
            "visitCount": int(n),
            "avgQueueSeconds": round(float(total_q / n), 2) if n > 0 else 0.0,
            "avgServiceSeconds": round(float(total_s / n_s), 2) if n_s > 0 else 0.0,
            "serviceSampleCount": int(n_s),
            "abandonCount": int(abandon_n),
            "queuedThenServedCount": int(served_after_q_n),
            "abandonRatePercent": float(abandon_rate_pct),
            "trendQueueAvg": tq_a,
            "trendServiceAvg": t_svc_pts,
            "trendServiceCount": t_sc_f,
            "trendAvgQueueLength": t_ql_f,
            "trendAbandonCount": t_abandon_cnt,
            "trendQueuedThenServedByBucket": t_served_bucket,
            "trendAbandonRate": t_abandon_rate,
            "trendBucketQueue": bq,
            "trendBucketService": bs,
            "trendBucketFootfall": bf,
            "trendBucketAbandon": ba,
        }
