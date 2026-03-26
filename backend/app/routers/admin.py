import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import models
from ..db import DB_URL, SessionLocal

router = APIRouter(prefix="/api/admin", tags=["admin"])


class PurgeByFloorPlanRequest(BaseModel):
    floor_plan_id: int
    confirm_text: str


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
        if floor_plan_id is not None:
            fp_id = int(floor_plan_id)
            heatmap_q = heatmap_q.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            footfall_q = footfall_q.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)

        heatmap_count = int(heatmap_q.count())
        footfall_count = int(footfall_q.count())

        heatmap_min = db.query(models.HeatmapEvent.ts)
        heatmap_max = db.query(models.HeatmapEvent.ts)
        footfall_min = db.query(models.FootfallCrossEvent.ts)
        footfall_max = db.query(models.FootfallCrossEvent.ts)
        if floor_plan_id is not None:
            fp_id = int(floor_plan_id)
            heatmap_min = heatmap_min.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            heatmap_max = heatmap_max.filter(models.HeatmapEvent.floor_plan_id == fp_id)
            footfall_min = footfall_min.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
            footfall_max = footfall_max.filter(models.FootfallCrossEvent.floor_plan_id == fp_id)

        heatmap_min_ts = heatmap_min.order_by(models.HeatmapEvent.ts.asc()).first()
        heatmap_max_ts = heatmap_max.order_by(models.HeatmapEvent.ts.desc()).first()
        footfall_min_ts = footfall_min.order_by(models.FootfallCrossEvent.ts.asc()).first()
        footfall_max_ts = footfall_max.order_by(models.FootfallCrossEvent.ts.desc()).first()

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
        "heatmap_min_ts": float(heatmap_min_ts[0]) if heatmap_min_ts and heatmap_min_ts[0] is not None else None,
        "heatmap_max_ts": float(heatmap_max_ts[0]) if heatmap_max_ts and heatmap_max_ts[0] is not None else None,
        "footfall_min_ts": float(footfall_min_ts[0]) if footfall_min_ts and footfall_min_ts[0] is not None else None,
        "footfall_max_ts": float(footfall_max_ts[0]) if footfall_max_ts and footfall_max_ts[0] is not None else None,
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


@router.post("/purge-heatmap-events")
async def admin_purge_heatmap_events(req: PurgeByFloorPlanRequest):
    _validate_confirm_text(req.confirm_text)
    fp_id = int(req.floor_plan_id)
    with SessionLocal() as db:
        if not db.query(models.FloorPlan).filter(models.FloorPlan.id == fp_id).first():
            raise HTTPException(status_code=404, detail="floor plan not found")
        deleted_count = (
            db.query(models.HeatmapEvent)
            .filter(models.HeatmapEvent.floor_plan_id == fp_id)
            .delete(synchronize_session=False)
        )
        db.commit()
    return {"status": "ok", "deleted_count": int(deleted_count or 0), "floor_plan_id": fp_id}


@router.post("/purge-footfall-events")
async def admin_purge_footfall_events(req: PurgeByFloorPlanRequest):
    _validate_confirm_text(req.confirm_text)
    fp_id = int(req.floor_plan_id)
    with SessionLocal() as db:
        if not db.query(models.FloorPlan).filter(models.FloorPlan.id == fp_id).first():
            raise HTTPException(status_code=404, detail="floor plan not found")
        deleted_count = (
            db.query(models.FootfallCrossEvent)
            .filter(models.FootfallCrossEvent.floor_plan_id == fp_id)
            .delete(synchronize_session=False)
        )
        db.commit()
    return {"status": "ok", "deleted_count": int(deleted_count or 0), "floor_plan_id": fp_id}
