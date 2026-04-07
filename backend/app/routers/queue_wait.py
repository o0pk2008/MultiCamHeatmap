import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..db import SessionLocal
from .. import models
from ..queue_wait_analysis import analyzer, _parse_quad_json
from ..queue_wait_store import _normalize_stats_mode_range, get_queue_wait_stats_sync
from ..virtual_view_inference import manager as vv_manager

router = APIRouter(prefix="/api/queue-wait", tags=["queue-wait"])


class Vec2In(BaseModel):
    x: float
    y: float


class Vec2Out(BaseModel):
    x: float
    y: float


class QueueRoiUpsertRequest(BaseModel):
    floor_plan_id: int
    virtual_view_id: int
    queue_quad: List[Vec2In]
    service_quad: List[Vec2In]


class QueueRoiConfigOut(BaseModel):
    id: int
    floor_plan_id: int
    virtual_view_id: int
    queue_quad: List[Vec2Out]
    service_quad: List[Vec2Out]


class QueueWaitStartRequest(BaseModel):
    floor_plan_id: int
    virtual_view_id: int
    emit_interval_sec: float = 0.05


class QueueVisitOut(BaseModel):
    id: int
    track_id: int
    queue_seconds: float
    service_seconds: Optional[float] = None
    end_ts: float


def _quad_to_json(pts: List[Vec2In]) -> str:
    return json.dumps([{"x": float(p.x), "y": float(p.y)} for p in pts], ensure_ascii=False)


def _json_to_out(raw: str) -> List[Vec2Out]:
    poly = _parse_quad_json(raw)
    if poly is None:
        return []
    return [Vec2Out(x=float(a), y=float(b)) for a, b in poly]


@router.post("/rois/upsert", response_model=QueueRoiConfigOut)
async def queue_wait_rois_upsert(req: QueueRoiUpsertRequest):
    if len(req.queue_quad) != 4 or len(req.service_quad) != 4:
        raise HTTPException(status_code=400, detail="queue_quad and service_quad must have 4 points each")

    qj = _quad_to_json(req.queue_quad)
    sj = _quad_to_json(req.service_quad)
    if _parse_quad_json(qj) is None or _parse_quad_json(sj) is None:
        raise HTTPException(status_code=400, detail="invalid quad coordinates")

    with SessionLocal() as db:
        cfg = (
            db.query(models.QueueWaitRoiConfig)
            .filter(
                models.QueueWaitRoiConfig.floor_plan_id == int(req.floor_plan_id),
                models.QueueWaitRoiConfig.virtual_view_id == int(req.virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            cfg = models.QueueWaitRoiConfig(
                floor_plan_id=int(req.floor_plan_id),
                virtual_view_id=int(req.virtual_view_id),
                queue_quad_json=qj,
                service_quad_json=sj,
            )
            db.add(cfg)
        else:
            cfg.queue_quad_json = qj
            cfg.service_quad_json = sj
        db.commit()
        db.refresh(cfg)

        qp_live = [(float(p.x), float(p.y)) for p in req.queue_quad]
        sp_live = [(float(p.x), float(p.y)) for p in req.service_quad]
        analyzer.patch_running_rois(int(req.floor_plan_id), int(req.virtual_view_id), qp_live, sp_live)

        return QueueRoiConfigOut(
            id=int(cfg.id),
            floor_plan_id=int(cfg.floor_plan_id),
            virtual_view_id=int(cfg.virtual_view_id),
            queue_quad=_json_to_out(str(cfg.queue_quad_json or "[]")),
            service_quad=_json_to_out(str(cfg.service_quad_json or "[]")),
        )


@router.get("/rois", response_model=Optional[QueueRoiConfigOut])
async def queue_wait_rois_get(floor_plan_id: int, virtual_view_id: int):
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
            return None
        return QueueRoiConfigOut(
            id=int(cfg.id),
            floor_plan_id=int(cfg.floor_plan_id),
            virtual_view_id=int(cfg.virtual_view_id),
            queue_quad=_json_to_out(str(cfg.queue_quad_json or "[]")),
            service_quad=_json_to_out(str(cfg.service_quad_json or "[]")),
        )


@router.delete("/rois")
async def queue_wait_rois_delete(floor_plan_id: int, virtual_view_id: int):
    """
    删除已保存的排队/服务 ROI 配置；若正在分析则先停止。
    同时删除绑定到该配置的 queue_wait_visits（避免外键孤立）。
    """
    fp = int(floor_plan_id)
    vv = int(virtual_view_id)
    if analyzer.is_running(fp, vv):
        analyzer.stop(fp, vv)
    else:
        try:
            vv_manager.clear_queue_wait_overlay(vv)
            vv_manager.clear_queue_wait_labels(vv)
        except Exception:
            pass

    deleted_cfg = False
    deleted_visits = 0
    with SessionLocal() as db:
        cfg = (
            db.query(models.QueueWaitRoiConfig)
            .filter(
                models.QueueWaitRoiConfig.floor_plan_id == fp,
                models.QueueWaitRoiConfig.virtual_view_id == vv,
            )
            .first()
        )
        if cfg is None:
            return {
                "status": "ok",
                "deleted_config": False,
                "deleted_visits": 0,
            }
        cfg_id = int(cfg.id)
        deleted_visits = int(
            db.query(models.QueueWaitVisit)
            .filter(models.QueueWaitVisit.roi_config_id == cfg_id)
            .delete(synchronize_session=False)
        )
        db.delete(cfg)
        db.commit()
        deleted_cfg = True

    return {
        "status": "ok",
        "deleted_config": deleted_cfg,
        "deleted_visits": deleted_visits,
    }


@router.post("/start")
async def queue_wait_start(req: QueueWaitStartRequest):
    with SessionLocal() as db:
        cfg = (
            db.query(models.QueueWaitRoiConfig)
            .filter(
                models.QueueWaitRoiConfig.floor_plan_id == int(req.floor_plan_id),
                models.QueueWaitRoiConfig.virtual_view_id == int(req.virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            raise HTTPException(status_code=400, detail="请先保存排队区与服务区 ROI")
        qp = _parse_quad_json(str(cfg.queue_quad_json or "[]"))
        sp = _parse_quad_json(str(cfg.service_quad_json or "[]"))
        if qp is None or sp is None:
            raise HTTPException(status_code=400, detail="ROI 数据无效，请重新保存")
        roi_config_id = int(cfg.id)

    analyzer.start(
        floor_plan_id=int(req.floor_plan_id),
        virtual_view_id=int(req.virtual_view_id),
        roi_config_id=roi_config_id,
        queue_poly=qp,
        service_poly=sp,
        emit_interval_sec=float(req.emit_interval_sec),
    )
    return {"status": "started", "floor_plan_id": req.floor_plan_id, "virtual_view_id": req.virtual_view_id}


@router.post("/stop")
async def queue_wait_stop(floor_plan_id: int, virtual_view_id: int):
    analyzer.stop(int(floor_plan_id), int(virtual_view_id))
    return {"status": "stopped", "floor_plan_id": floor_plan_id, "virtual_view_id": virtual_view_id}


@router.get("/status")
async def queue_wait_status(floor_plan_id: int, virtual_view_id: int):
    return {
        "floor_plan_id": int(floor_plan_id),
        "virtual_view_id": int(virtual_view_id),
        "running": analyzer.is_running(int(floor_plan_id), int(virtual_view_id)),
    }


@router.get("/live-occupancy")
async def queue_wait_live_occupancy(
    response: Response,
    floor_plan_id: int,
    virtual_view_id: int,
):
    """分析进行中时返回几何意义的排队区/服务区人数及「人数增加」时刻，供前端画 ROI 边框脉冲。"""
    payload = analyzer.get_live_occupancy(int(floor_plan_id), int(virtual_view_id))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return payload


@router.get("/stats")
async def queue_wait_stats(
    response: Response,
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",
    date_key: Optional[str] = None,
    tz_offset_minutes: Optional[int] = None,
    trend_bucket_queue: Optional[str] = None,
    trend_bucket_service: Optional[str] = None,
    trend_bucket_footfall: Optional[str] = None,
    trend_bucket_abandon: Optional[str] = None,
):
    try:
        payload = get_queue_wait_stats_sync(
            floor_plan_id=int(floor_plan_id),
            virtual_view_id=int(virtual_view_id),
            mode=str(mode),
            date_key=date_key,
            tz_offset_minutes=(int(tz_offset_minutes) if tz_offset_minutes is not None else None),
            trend_bucket_queue=trend_bucket_queue,
            trend_bucket_service=trend_bucket_service,
            trend_bucket_footfall=trend_bucket_footfall,
            trend_bucket_abandon=trend_bucket_abandon,
        )
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return payload
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/dashboard")
async def queue_wait_dashboard(
    response: Response,
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",
    date_key: Optional[str] = None,
    tz_offset_minutes: Optional[int] = None,
    trend_bucket_queue: Optional[str] = None,
    trend_bucket_service: Optional[str] = None,
    trend_bucket_footfall: Optional[str] = None,
    trend_bucket_abandon: Optional[str] = None,
):
    """
    面向外部接入的聚合看板接口：
    - meta: 请求上下文和口径
    - kpi: 统计标签区数据
    - charts: 4 张图表数据
    """
    try:
        payload = get_queue_wait_stats_sync(
            floor_plan_id=int(floor_plan_id),
            virtual_view_id=int(virtual_view_id),
            mode=str(mode),
            date_key=date_key,
            tz_offset_minutes=(int(tz_offset_minutes) if tz_offset_minutes is not None else None),
            trend_bucket_queue=trend_bucket_queue,
            trend_bucket_service=trend_bucket_service,
            trend_bucket_footfall=trend_bucket_footfall,
            trend_bucket_abandon=trend_bucket_abandon,
        )
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return {
            "schema_version": "1.0",
            "meta": {
                "floor_plan_id": int(floor_plan_id),
                "virtual_view_id": int(virtual_view_id),
                "mode": str(mode),
                "date_key": date_key,
                "tz_offset_minutes": (int(tz_offset_minutes) if tz_offset_minutes is not None else None),
                "trend_bucket_queue": str(payload.get("trendBucketQueue") or "1h"),
                "trend_bucket_service": str(payload.get("trendBucketService") or "1h"),
                "trend_bucket_footfall": str(payload.get("trendBucketFootfall") or "1h"),
                "trend_bucket_abandon": str(payload.get("trendBucketAbandon") or "1h"),
            },
            "kpi": {
                "visit_count": int(payload.get("visitCount") or 0),
                "avg_queue_seconds": float(payload.get("avgQueueSeconds") or 0.0),
                "avg_service_seconds": float(payload.get("avgServiceSeconds") or 0.0),
                "service_sample_count": int(payload.get("serviceSampleCount") or 0),
                "abandon_count": int(payload.get("abandonCount") or 0),
                "queued_then_served_count": int(payload.get("queuedThenServedCount") or 0),
                "abandon_rate_percent": float(payload.get("abandonRatePercent") or 0.0),
            },
            "charts": {
                "queue_avg": {
                    "bucket": str(payload.get("trendBucketQueue") or "1h"),
                    "points": list(payload.get("trendQueueAvg") or []),
                },
                "service_avg": {
                    "bucket": str(payload.get("trendBucketService") or "1h"),
                    "points": list(payload.get("trendServiceAvg") or []),
                },
                "footfall": {
                    "bucket": str(payload.get("trendBucketFootfall") or "1h"),
                    "service_count_points": list(payload.get("trendServiceCount") or []),
                    "avg_queue_length_points": list(payload.get("trendAvgQueueLength") or []),
                },
                "abandon": {
                    "bucket": str(payload.get("trendBucketAbandon") or "1h"),
                    "rate_points": list(payload.get("trendAbandonRate") or []),
                    "abandon_count_points": list(payload.get("trendAbandonCount") or []),
                    "queued_then_served_points": list(payload.get("trendQueuedThenServedByBucket") or []),
                },
            },
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/visits", response_model=List[QueueVisitOut])
async def queue_wait_visits(
    response: Response,
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",
    date_key: Optional[str] = None,
    tz_offset_minutes: Optional[int] = None,
    limit: int = 40,
):
    lim = max(1, min(int(limit), 200))
    try:
        start_ts, end_ts = _normalize_stats_mode_range(
            mode=str(mode),
            date_key=date_key,
            tz_offset_minutes=(int(tz_offset_minutes) if tz_offset_minutes is not None else None),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

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
            return []
        rows = (
            db.query(models.QueueWaitVisit)
            .filter(
                models.QueueWaitVisit.roi_config_id == int(cfg.id),
                models.QueueWaitVisit.end_ts >= float(start_ts),
                models.QueueWaitVisit.end_ts < float(end_ts),
            )
            .order_by(models.QueueWaitVisit.end_ts.desc())
            .limit(lim)
            .all()
        )

    out: List[QueueVisitOut] = []
    for r in rows:
        try:
            out.append(
                QueueVisitOut(
                    id=int(r.id),
                    track_id=int(r.track_id if r.track_id is not None else -1),
                    queue_seconds=float(r.queue_seconds),
                    service_seconds=(float(r.service_seconds) if r.service_seconds is not None else None),
                    end_ts=float(r.end_ts),
                )
            )
        except Exception:
            continue
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return out
