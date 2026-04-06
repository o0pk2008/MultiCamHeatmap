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


FACE_CAPTURE_RETENTION_KEY = "face_capture_retention_days"
QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY = "queue_wait_post_service_queue_ignore_sec"


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


@router.get("/queue-wait-analysis-config")
async def admin_get_queue_wait_analysis_config():
    from ..queue_wait_analysis import analyzer as qw_analyzer

    sec = float(qw_analyzer.get_post_service_queue_ignore_sec())
    with SessionLocal() as db:
        row = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY)
            .first()
        )
        if row is not None:
            try:
                sec = max(0.0, float(str(row.value)))
            except Exception:
                pass
    qw_analyzer.set_post_service_queue_ignore_sec(sec)
    return {"post_service_queue_ignore_sec": float(sec)}


@router.post("/queue-wait-analysis-config")
async def admin_set_queue_wait_analysis_config(req: QueueWaitAnalysisConfigRequest):
    from ..queue_wait_analysis import analyzer as qw_analyzer

    sec = max(0.0, min(float(req.post_service_queue_ignore_sec), 3600.0))
    qw_analyzer.set_post_service_queue_ignore_sec(sec)
    with SessionLocal() as db:
        row = (
            db.query(models.AppSetting)
            .filter(models.AppSetting.key == QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY)
            .first()
        )
        if row is None:
            row = models.AppSetting(key=QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY, value=str(sec))
            db.add(row)
        else:
            row.value = str(sec)
        db.commit()
    return {"status": "ok", "post_service_queue_ignore_sec": float(sec)}
