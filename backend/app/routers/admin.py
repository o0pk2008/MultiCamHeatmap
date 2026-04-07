import os
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import models
from ..db import DB_URL, SessionLocal
from ..virtual_view_inference import manager

router = APIRouter(prefix="/api/admin", tags=["admin"])


class PurgeByFloorPlanRequest(BaseModel):
    floor_plan_id: int
    confirm_text: str
    purge_mode: str = "all"  # all | range
    start_date: Optional[str] = None  # YYYY-MM-DD (local date with tz_offset_minutes)
    end_date: Optional[str] = None    # YYYY-MM-DD
    tz_offset_minutes: Optional[int] = None


class FootfallOverlayConfigRequest(BaseModel):
    draw_footfall_line_overlay: bool
    yolo_box_style: Optional[str] = None  # rect | corners_rounded
    yolo_box_color: Optional[str] = None  # green | blue | white
    yolo_foot_point_enabled: Optional[bool] = None
    yolo_foot_point_style: Optional[str] = None  # circle | square
    yolo_foot_point_color: Optional[str] = None  # green | blue | white
    mapped_cam_grid_color: Optional[str] = None  # white | green | blue


class FaceCaptureRetentionRequest(BaseModel):
    retention_days: int


class QueueWaitAnalysisConfigRequest(BaseModel):
    """排队时长分析运行参数（与 queue_wait_analysis 状态机一致）。"""

    post_service_queue_ignore_sec: float
    direct_service_complete_min_sec: float
    abandon_min_queue_sec: float


class LowLatencyConfigRequest(BaseModel):
    stream_fps: float
    analyzed_stream_fps: float
    idle_stream_fps: float
    plain_jpeg_quality: int
    analyzed_jpeg_quality: int
    low_latency_minimal_overlay: bool


class YoloTrackingRuntimeConfigRequest(BaseModel):
    detection_conf_threshold: float
    track_min_consecutive_frames: int


FACE_CAPTURE_RETENTION_KEY = "face_capture_retention_days"
QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY = "queue_wait_post_service_queue_ignore_sec"
QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_KEY = "queue_wait_direct_service_complete_min_sec"
QUEUE_WAIT_ABANDON_MIN_QUEUE_KEY = "queue_wait_abandon_min_queue_sec"
VV_STREAM_FPS_KEY = "vv_stream_fps"
VV_ANALYZED_STREAM_FPS_KEY = "vv_analyzed_stream_fps"
VV_IDLE_STREAM_FPS_KEY = "vv_idle_stream_fps"
VV_PLAIN_JPEG_QUALITY_KEY = "vv_plain_jpeg_quality"
VV_ANALYZED_JPEG_QUALITY_KEY = "vv_analyzed_jpeg_quality"
VV_LOW_LATENCY_MINIMAL_OVERLAY_KEY = "vv_low_latency_minimal_overlay"
YOLO_DETECTION_CONF_THRESHOLD_KEY = "yolo_detection_conf_threshold"
YOLO_TRACK_MIN_CONSECUTIVE_FRAMES_KEY = "yolo_track_min_consecutive_frames"


def _resolve_sqlite_db_path() -> Path:
    if not str(DB_URL).startswith("sqlite:///"):
        raise HTTPException(status_code=400, detail="db backup only supports sqlite")
    path_part = str(DB_URL).replace("sqlite:///", "", 1)
    if os.name == "nt" and path_part.startswith("/"):
        path_part = path_part[1:]
    db_path = Path(path_part)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="database file not found")
    return db_path


@router.get("/db-stats")
async def admin_db_stats(floor_plan_id: Optional[int] = None):
    with SessionLocal() as db:
        heatmap_q = db.query(models.HeatmapEvent)
        footfall_q = db.query(models.FootfallCrossEvent)
        queue_wait_q = db.query(models.QueueWaitVisit)
        if floor_plan_id is not None:
            fp_id = int(floor_plan_id)
            heatmap_q = heatmap_q.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            footfall_q = footfall_q.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
            queue_wait_q = queue_wait_q.filter(models.QueueWaitVisit.floor_plan_id == fp_id)

        heatmap_count = int(heatmap_q.count())
        footfall_count = int(footfall_q.count())
        queue_wait_count = int(queue_wait_q.count())

        heatmap_min = db.query(models.HeatmapEvent.ts)
        heatmap_max = db.query(models.HeatmapEvent.ts)
        footfall_min = db.query(models.FootfallCrossEvent.ts)
        footfall_max = db.query(models.FootfallCrossEvent.ts)
        queue_wait_min = db.query(models.QueueWaitVisit.end_ts)
        queue_wait_max = db.query(models.QueueWaitVisit.end_ts)
        if floor_plan_id is not None:
            fp_id = int(floor_plan_id)
            heatmap_min = heatmap_min.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            heatmap_max = heatmap_max.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            footfall_min = footfall_min.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
            footfall_max = footfall_max.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
            queue_wait_min = queue_wait_min.filter(models.QueueWaitVisit.floor_plan_id == fp_id)
            queue_wait_max = queue_wait_max.filter(models.QueueWaitVisit.floor_plan_id == fp_id)

        heatmap_min_ts = heatmap_min.order_by(models.HeatmapEvent.ts.asc()).first()
        heatmap_max_ts = heatmap_max.order_by(models.HeatmapEvent.ts.desc()).first()
        footfall_min_ts = footfall_min.order_by(models.FootfallCrossEvent.ts.asc()).first()
        footfall_max_ts = footfall_max.order_by(models.FootfallCrossEvent.ts.desc()).first()
        queue_wait_min_ts = queue_wait_min.order_by(models.QueueWaitVisit.end_ts.asc()).first()
        queue_wait_max_ts = queue_wait_max.order_by(models.QueueWaitVisit.end_ts.desc()).first()

    db_file_size = None
    try:
        db_path = _resolve_sqlite_db_path()
        db_file_size = int(db_path.stat().st_size)
    except Exception:
        db_file_size = None

    return {
        "floor_plan_id": int(floor_plan_id) if floor_plan_id is not None else None,
        "db_url": str(DB_URL),
        "db_file_size_bytes": db_file_size,
        "heatmap_events_count": heatmap_count,
        "footfall_cross_events_count": footfall_count,
        "queue_wait_visits_count": queue_wait_count,
        "heatmap_min_ts": float(heatmap_min_ts[0]) if heatmap_min_ts and heatmap_min_ts[0] is not None else None,
        "heatmap_max_ts": float(heatmap_max_ts[0]) if heatmap_max_ts and heatmap_max_ts[0] is not None else None,
        "footfall_min_ts": float(footfall_min_ts[0]) if footfall_min_ts and footfall_min_ts[0] is not None else None,
        "footfall_max_ts": float(footfall_max_ts[0]) if footfall_max_ts and footfall_max_ts[0] is not None else None,
        "queue_wait_min_ts": float(queue_wait_min_ts[0]) if queue_wait_min_ts and queue_wait_min_ts[0] is not None else None,
        "queue_wait_max_ts": float(queue_wait_max_ts[0]) if queue_wait_max_ts and queue_wait_max_ts[0] is not None else None,
    }


@router.get("/db-backup")
async def admin_db_backup():
    db_path = _resolve_sqlite_db_path()
    backup_dir = db_path.parent / "backup"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_name = f"app_backup_{ts}.db"
    backup_path = backup_dir / backup_name
    try:
        shutil.copy2(str(db_path), str(backup_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"backup failed: {e}")
    return FileResponse(
        path=str(backup_path),
        media_type="application/octet-stream",
        filename=backup_name,
    )


def _validate_confirm_text(v: str) -> None:
    if str(v).strip().upper() != "DELETE":
        raise HTTPException(status_code=400, detail="confirm_text must be DELETE")


def _range_from_req(req: PurgeByFloorPlanRequest) -> tuple[Optional[float], Optional[float]]:
    mode = str(req.purge_mode or "all").strip().lower()
    if mode == "all":
        return None, None
    if mode != "range":
        raise HTTPException(status_code=400, detail="purge_mode must be all or range")
    if not req.start_date or not req.end_date:
        raise HTTPException(status_code=400, detail="start_date and end_date are required when purge_mode=range")
    try:
        y1, m1, d1 = [int(x) for x in str(req.start_date).split("-", 2)]
        y2, m2, d2 = [int(x) for x in str(req.end_date).split("-", 2)]
    except Exception:
        raise HTTPException(status_code=400, detail="invalid date format, expected YYYY-MM-DD")
    tz = timezone(-timedelta(minutes=int(req.tz_offset_minutes or 0)))
    start_dt = datetime(y1, m1, d1, tzinfo=tz)
    end_dt = datetime(y2, m2, d2, tzinfo=tz) + timedelta(days=1)
    if end_dt <= start_dt:
        raise HTTPException(status_code=400, detail="end_date must be on/after start_date")
    return float(start_dt.timestamp()), float(end_dt.timestamp())


@router.post("/purge-heatmap-events")
async def admin_purge_heatmap_events(req: PurgeByFloorPlanRequest):
    _validate_confirm_text(req.confirm_text)
    fp_id = int(req.floor_plan_id)
    start_ts, end_ts = _range_from_req(req)
    with SessionLocal() as db:
        if not db.query(models.FloorPlan).filter(models.FloorPlan.id == fp_id).first():
            raise HTTPException(status_code=404, detail="floor plan not found")
        q = db.query(models.HeatmapEvent).filter(models.HeatmapEvent.floor_plan_id == fp_id)
        if start_ts is not None and end_ts is not None:
            q = q.filter(models.HeatmapEvent.ts >= float(start_ts), models.HeatmapEvent.ts < float(end_ts))
        deleted_count = q.delete(synchronize_session=False)
        db.commit()
    return {
        "status": "ok",
        "deleted_count": int(deleted_count or 0),
        "floor_plan_id": fp_id,
        "purge_mode": req.purge_mode,
        "start_ts": start_ts,
        "end_ts": end_ts,
    }


@router.post("/purge-queue-wait-visits")
async def admin_purge_queue_wait_visits(req: PurgeByFloorPlanRequest):
    """
    按平面图删除排队时长分析落地记录（queue_wait_visits）。不删除 ROI 配置（queue_wait_roi_configs）。
    日期范围按记录的 end_ts 与热力/人流量清理一致（本地日切到 UTC 时间戳）。
    """
    _validate_confirm_text(req.confirm_text)
    fp_id = int(req.floor_plan_id)
    start_ts, end_ts = _range_from_req(req)
    with SessionLocal() as db:
        if not db.query(models.FloorPlan).filter(models.FloorPlan.id == fp_id).first():
            raise HTTPException(status_code=404, detail="floor plan not found")
        q = db.query(models.QueueWaitVisit).filter(models.QueueWaitVisit.floor_plan_id == fp_id)
        if start_ts is not None and end_ts is not None:
            q = q.filter(models.QueueWaitVisit.end_ts >= float(start_ts), models.QueueWaitVisit.end_ts < float(end_ts))
        deleted_count = q.delete(synchronize_session=False)
        db.commit()
    return {
        "status": "ok",
        "deleted_count": int(deleted_count or 0),
        "floor_plan_id": fp_id,
        "purge_mode": req.purge_mode,
        "start_ts": start_ts,
        "end_ts": end_ts,
    }


@router.post("/purge-footfall-events")
async def admin_purge_footfall_events(req: PurgeByFloorPlanRequest):
    _validate_confirm_text(req.confirm_text)
    fp_id = int(req.floor_plan_id)
    start_ts, end_ts = _range_from_req(req)
    with SessionLocal() as db:
        if not db.query(models.FloorPlan).filter(models.FloorPlan.id == fp_id).first():
            raise HTTPException(status_code=404, detail="floor plan not found")
        q_cross = db.query(models.FootfallCrossEvent).filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
        q_face = db.query(models.FootfallFaceCapture).filter(models.FootfallFaceCapture.floor_plan_id == fp_id)
        if start_ts is not None and end_ts is not None:
            q_cross = q_cross.filter(models.FootfallCrossEvent.ts >= float(start_ts), models.FootfallCrossEvent.ts < float(end_ts))
            q_face = q_face.filter(models.FootfallFaceCapture.ts >= float(start_ts), models.FootfallFaceCapture.ts < float(end_ts))
        deleted_cross = q_cross.delete(synchronize_session=False)
        deleted_faces = q_face.delete(synchronize_session=False)
        db.commit()
    return {
        "status": "ok",
        "deleted_count": int((deleted_cross or 0) + (deleted_faces or 0)),
        "deleted_cross_events": int(deleted_cross or 0),
        "deleted_face_captures": int(deleted_faces or 0),
        "floor_plan_id": fp_id,
        "purge_mode": req.purge_mode,
        "start_ts": start_ts,
        "end_ts": end_ts,
    }


@router.get("/footfall-overlay-config")
async def admin_get_footfall_overlay_config():
    cfg = manager.get_yolo_draw_config()
    return {
        "draw_footfall_line_overlay": bool(manager.get_draw_footfall_line_overlay()),
        "yolo_box_style": str(cfg.get("box_style", "corners_rounded")),
        "yolo_box_color": str(cfg.get("box_color", "white")),
        "yolo_foot_point_enabled": bool(cfg.get("foot_point_enabled", False)),
        "yolo_foot_point_style": str(cfg.get("foot_point_style", "circle")),
        "yolo_foot_point_color": str(cfg.get("foot_point_color", "green")),
        "mapped_cam_grid_color": str(cfg.get("mapped_cam_grid_color", "white")),
    }


@router.post("/footfall-overlay-config")
async def admin_set_footfall_overlay_config(req: FootfallOverlayConfigRequest):
    manager.set_draw_footfall_line_overlay(bool(req.draw_footfall_line_overlay))
    manager.set_yolo_draw_config(
        box_style=req.yolo_box_style,
        box_color=req.yolo_box_color,
        foot_point_enabled=req.yolo_foot_point_enabled,
        foot_point_style=req.yolo_foot_point_style,
        foot_point_color=req.yolo_foot_point_color,
        mapped_cam_grid_color=req.mapped_cam_grid_color,
    )
    cfg = manager.get_yolo_draw_config()
    return {
        "status": "ok",
        "draw_footfall_line_overlay": bool(manager.get_draw_footfall_line_overlay()),
        "yolo_box_style": str(cfg.get("box_style", "corners_rounded")),
        "yolo_box_color": str(cfg.get("box_color", "white")),
        "yolo_foot_point_enabled": bool(cfg.get("foot_point_enabled", False)),
        "yolo_foot_point_style": str(cfg.get("foot_point_style", "circle")),
        "yolo_foot_point_color": str(cfg.get("foot_point_color", "green")),
        "mapped_cam_grid_color": str(cfg.get("mapped_cam_grid_color", "white")),
    }


@router.get("/face-capture-retention")
async def admin_get_face_capture_retention():
    days = manager.get_face_capture_retention_days()
    with SessionLocal() as db:
        row = db.query(models.AppSetting).filter(models.AppSetting.key == FACE_CAPTURE_RETENTION_KEY).first()
        if row is not None:
            try:
                days = max(0, int(str(row.value)))
            except Exception:
                pass
    manager.set_face_capture_retention_days(int(days))
    return {"retention_days": int(days)}


@router.post("/face-capture-retention")
async def admin_set_face_capture_retention(req: FaceCaptureRetentionRequest):
    days = max(0, min(int(req.retention_days), 3650))
    manager.set_face_capture_retention_days(days)
    with SessionLocal() as db:
        row = db.query(models.AppSetting).filter(models.AppSetting.key == FACE_CAPTURE_RETENTION_KEY).first()
        if row is None:
            row = models.AppSetting(key=FACE_CAPTURE_RETENTION_KEY, value=str(days))
            db.add(row)
        else:
            row.value = str(days)
        db.commit()
    return {"status": "ok", "retention_days": int(days)}


def _clamp_queue_wait_runtime_secs(v: float, lo: float = 0.0, hi: float = 3600.0) -> float:
    try:
        return max(lo, min(float(v), hi))
    except Exception:
        return lo


def _clamp_float(v: float, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(float(v), hi))
    except Exception:
        return float(default)


def _clamp_int(v: int, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(int(v), hi))
    except Exception:
        return int(default)


@router.get("/queue-wait-analysis-config")
async def admin_get_queue_wait_analysis_config():
    from ..queue_wait_analysis import analyzer as qw_analyzer

    post_ign = float(qw_analyzer.get_post_service_queue_ignore_sec())
    direct_min = float(qw_analyzer.get_direct_service_complete_min_sec())
    abandon_q = float(qw_analyzer.get_abandon_min_queue_sec())
    with SessionLocal() as db:
        row = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY)
            .first()
        )
        if row is not None:
            try:
                post_ign = max(0.0, float(str(row.value)))
            except Exception:
                pass
        row_d = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_KEY)
            .first()
        )
        if row_d is not None:
            try:
                direct_min = max(0.0, float(str(row_d.value)))
            except Exception:
                pass
        row_a = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == QUEUE_WAIT_ABANDON_MIN_QUEUE_KEY)
            .first()
        )
        if row_a is not None:
            try:
                abandon_q = max(0.0, float(str(row_a.value)))
            except Exception:
                pass
    qw_analyzer.set_post_service_queue_ignore_sec(post_ign)
    qw_analyzer.set_direct_service_complete_min_sec(direct_min)
    qw_analyzer.set_abandon_min_queue_sec(abandon_q)
    return {
        "post_service_queue_ignore_sec": float(post_ign),
        "direct_service_complete_min_sec": float(direct_min),
        "abandon_min_queue_sec": float(abandon_q),
    }


@router.post("/queue-wait-analysis-config")
async def admin_set_queue_wait_analysis_config(req: QueueWaitAnalysisConfigRequest):
    from ..queue_wait_analysis import analyzer as qw_analyzer

    post_ign = _clamp_queue_wait_runtime_secs(float(req.post_service_queue_ignore_sec))
    direct_min = _clamp_queue_wait_runtime_secs(float(req.direct_service_complete_min_sec))
    abandon_q = _clamp_queue_wait_runtime_secs(float(req.abandon_min_queue_sec))
    qw_analyzer.set_post_service_queue_ignore_sec(post_ign)
    qw_analyzer.set_direct_service_complete_min_sec(direct_min)
    qw_analyzer.set_abandon_min_queue_sec(abandon_q)
    with SessionLocal() as db:
        def upsert(key: str, val: float) -> None:
            row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
            if row is None:
                db.add(models.AppSetting(key=key, value=str(val)))
            else:
                row.value = str(val)

        upsert(QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY, post_ign)
        upsert(QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_KEY, direct_min)
        upsert(QUEUE_WAIT_ABANDON_MIN_QUEUE_KEY, abandon_q)
        db.commit()
    return {
        "status": "ok",
        "post_service_queue_ignore_sec": float(post_ign),
        "direct_service_complete_min_sec": float(direct_min),
        "abandon_min_queue_sec": float(abandon_q),
    }


@router.get("/low-latency-config")
async def admin_get_low_latency_config():
    cfg = manager.get_low_latency_config()
    stream_fps = float(cfg.get("stream_fps", 10.0))
    analyzed_stream_fps = float(cfg.get("analyzed_stream_fps", stream_fps))
    idle_stream_fps = float(cfg.get("idle_stream_fps", 1.0))
    plain_jpeg_quality = int(cfg.get("plain_jpeg_quality", 75))
    analyzed_jpeg_quality = int(cfg.get("analyzed_jpeg_quality", 70))
    low_latency_minimal_overlay = bool(cfg.get("low_latency_minimal_overlay", False))
    with SessionLocal() as db:
        def read_setting(key: str):
            return db.query(models.AppSetting).filter(models.AppSetting.key == key).first()

        r = read_setting(VV_STREAM_FPS_KEY)
        if r is not None:
            stream_fps = _clamp_float(float(r.value), 0.1, 60.0, stream_fps)
        r = read_setting(VV_ANALYZED_STREAM_FPS_KEY)
        if r is not None:
            analyzed_stream_fps = _clamp_float(float(r.value), 0.1, 60.0, analyzed_stream_fps)
        r = read_setting(VV_IDLE_STREAM_FPS_KEY)
        if r is not None:
            idle_stream_fps = _clamp_float(float(r.value), 0.1, 10.0, idle_stream_fps)
        r = read_setting(VV_PLAIN_JPEG_QUALITY_KEY)
        if r is not None:
            plain_jpeg_quality = _clamp_int(int(float(r.value)), 30, 95, plain_jpeg_quality)
        r = read_setting(VV_ANALYZED_JPEG_QUALITY_KEY)
        if r is not None:
            analyzed_jpeg_quality = _clamp_int(int(float(r.value)), 30, 95, analyzed_jpeg_quality)
        r = read_setting(VV_LOW_LATENCY_MINIMAL_OVERLAY_KEY)
        if r is not None:
            low_latency_minimal_overlay = str(r.value).strip().lower() in (
                "1",
                "true",
                "yes",
                "on",
            )

    manager.set_low_latency_config(
        stream_fps=stream_fps,
        analyzed_stream_fps=analyzed_stream_fps,
        idle_stream_fps=idle_stream_fps,
        plain_jpeg_quality=plain_jpeg_quality,
        analyzed_jpeg_quality=analyzed_jpeg_quality,
        low_latency_minimal_overlay=low_latency_minimal_overlay,
    )
    return {
        "stream_fps": float(stream_fps),
        "analyzed_stream_fps": float(analyzed_stream_fps),
        "idle_stream_fps": float(idle_stream_fps),
        "plain_jpeg_quality": int(plain_jpeg_quality),
        "analyzed_jpeg_quality": int(analyzed_jpeg_quality),
        "low_latency_minimal_overlay": bool(low_latency_minimal_overlay),
    }


@router.post("/low-latency-config")
async def admin_set_low_latency_config(req: LowLatencyConfigRequest):
    stream_fps = _clamp_float(float(req.stream_fps), 0.1, 60.0, 10.0)
    analyzed_stream_fps = _clamp_float(float(req.analyzed_stream_fps), 0.1, 60.0, stream_fps)
    idle_stream_fps = _clamp_float(float(req.idle_stream_fps), 0.1, 10.0, 1.0)
    plain_jpeg_quality = _clamp_int(int(req.plain_jpeg_quality), 30, 95, 75)
    analyzed_jpeg_quality = _clamp_int(int(req.analyzed_jpeg_quality), 30, 95, 70)
    low_latency_minimal_overlay = bool(req.low_latency_minimal_overlay)

    manager.set_low_latency_config(
        stream_fps=stream_fps,
        analyzed_stream_fps=analyzed_stream_fps,
        idle_stream_fps=idle_stream_fps,
        plain_jpeg_quality=plain_jpeg_quality,
        analyzed_jpeg_quality=analyzed_jpeg_quality,
        low_latency_minimal_overlay=low_latency_minimal_overlay,
    )
    with SessionLocal() as db:
        def upsert(key: str, val: str) -> None:
            row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
            if row is None:
                db.add(models.AppSetting(key=key, value=val))
            else:
                row.value = val

        upsert(VV_STREAM_FPS_KEY, str(stream_fps))
        upsert(VV_ANALYZED_STREAM_FPS_KEY, str(analyzed_stream_fps))
        upsert(VV_IDLE_STREAM_FPS_KEY, str(idle_stream_fps))
        upsert(VV_PLAIN_JPEG_QUALITY_KEY, str(plain_jpeg_quality))
        upsert(VV_ANALYZED_JPEG_QUALITY_KEY, str(analyzed_jpeg_quality))
        upsert(
            VV_LOW_LATENCY_MINIMAL_OVERLAY_KEY,
            "1" if low_latency_minimal_overlay else "0",
        )
        db.commit()
    return {
        "status": "ok",
        "stream_fps": float(stream_fps),
        "analyzed_stream_fps": float(analyzed_stream_fps),
        "idle_stream_fps": float(idle_stream_fps),
        "plain_jpeg_quality": int(plain_jpeg_quality),
        "analyzed_jpeg_quality": int(analyzed_jpeg_quality),
        "low_latency_minimal_overlay": bool(low_latency_minimal_overlay),
    }


@router.get("/yolo-tracking-runtime-config")
async def admin_get_yolo_tracking_runtime_config():
    cfg = manager.get_yolo_tracking_runtime_config()
    detection_conf_threshold = float(cfg.get("detection_conf_threshold", 0.25))
    track_min_consecutive_frames = int(cfg.get("track_min_consecutive_frames", 1))
    with SessionLocal() as db:
        row = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == YOLO_DETECTION_CONF_THRESHOLD_KEY)
            .first()
        )
        if row is not None:
            detection_conf_threshold = _clamp_float(float(row.value), 0.01, 0.99, detection_conf_threshold)
        row2 = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == YOLO_TRACK_MIN_CONSECUTIVE_FRAMES_KEY)
            .first()
        )
        if row2 is not None:
            track_min_consecutive_frames = _clamp_int(
                int(float(row2.value)), 1, 20, track_min_consecutive_frames
            )
    manager.set_yolo_tracking_runtime_config(
        detection_conf_threshold=detection_conf_threshold,
        track_min_consecutive_frames=track_min_consecutive_frames,
    )
    return {
        "detection_conf_threshold": float(detection_conf_threshold),
        "track_min_consecutive_frames": int(track_min_consecutive_frames),
    }


@router.post("/yolo-tracking-runtime-config")
async def admin_set_yolo_tracking_runtime_config(req: YoloTrackingRuntimeConfigRequest):
    detection_conf_threshold = _clamp_float(float(req.detection_conf_threshold), 0.01, 0.99, 0.25)
    track_min_consecutive_frames = _clamp_int(
        int(req.track_min_consecutive_frames), 1, 20, 1
    )
    manager.set_yolo_tracking_runtime_config(
        detection_conf_threshold=detection_conf_threshold,
        track_min_consecutive_frames=track_min_consecutive_frames,
    )
    with SessionLocal() as db:
        def upsert(key: str, val: str) -> None:
            row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
            if row is None:
                db.add(models.AppSetting(key=key, value=val))
            else:
                row.value = val

        upsert(YOLO_DETECTION_CONF_THRESHOLD_KEY, str(detection_conf_threshold))
        upsert(
            YOLO_TRACK_MIN_CONSECUTIVE_FRAMES_KEY,
            str(int(track_min_consecutive_frames)),
        )
        db.commit()
    return {
        "status": "ok",
        "detection_conf_threshold": float(detection_conf_threshold),
        "track_min_consecutive_frames": int(track_min_consecutive_frames),
    }
