from typing import Optional, List, Dict, Any

from fastapi import APIRouter
from fastapi import HTTPException
from pydantic import BaseModel

from ..db import SessionLocal
from .. import models
from ..footfall_analysis import analyzer, FootfallLine
from ..footfall_store import get_footfall_stats_sync

router = APIRouter(prefix="/api/footfall", tags=["footfall"])


class Vec2In(BaseModel):
    x: float
    y: float


class Vec2Out(BaseModel):
    x: float
    y: float


class FootfallLineConfigOut(BaseModel):
    id: int
    floor_plan_id: int
    virtual_view_id: int
    p1: Vec2Out
    p2: Vec2Out
    floor_p1: Optional[Vec2Out] = None
    floor_p2: Optional[Vec2Out] = None
    in_label: str = "进入"
    out_label: str = "离开"
    enabled: bool = True


class FootfallLineUpsertRequest(BaseModel):
    floor_plan_id: int
    virtual_view_id: int
    p1: Vec2In
    p2: Vec2In
    floor_p1: Optional[Vec2In] = None
    floor_p2: Optional[Vec2In] = None
    in_label: Optional[str] = "进入"
    out_label: Optional[str] = "离开"
    enabled: Optional[bool] = True


class FootfallStartRequest(BaseModel):
    floor_plan_id: int
    virtual_view_id: int
    p1: Vec2In  # (u, v) in virtual view UV space
    p2: Vec2In  # (u, v) in virtual view UV space
    floor_p1: Optional[Vec2In] = None  # (x, y) in floor image UV space (0..1)
    floor_p2: Optional[Vec2In] = None
    in_label: Optional[str] = "进入"
    out_label: Optional[str] = "离开"
    enabled: Optional[bool] = True
    zone_w: float = 0.05
    emit_interval_sec: float = 0.03


@router.post("/start")
async def footfall_start(req: FootfallStartRequest):
    # upsert line config so other computers can load it from DB
    with SessionLocal() as db:
        cfg = (
            db.query(models.FootfallLineConfig)
            .filter(
                models.FootfallLineConfig.floor_plan_id == int(req.floor_plan_id),
                models.FootfallLineConfig.virtual_view_id == int(req.virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            cfg = models.FootfallLineConfig(
                floor_plan_id=int(req.floor_plan_id),
                virtual_view_id=int(req.virtual_view_id),
                p1_u=float(req.p1.x),
                p1_v=float(req.p1.y),
                p2_u=float(req.p2.x),
                p2_v=float(req.p2.y),
                floor_p1_x=float(req.floor_p1.x) if req.floor_p1 else None,
                floor_p1_y=float(req.floor_p1.y) if req.floor_p1 else None,
                floor_p2_x=float(req.floor_p2.x) if req.floor_p2 else None,
                floor_p2_y=float(req.floor_p2.y) if req.floor_p2 else None,
                in_label=str(req.in_label) if req.in_label is not None else "进入",
                out_label=str(req.out_label) if req.out_label is not None else "离开",
                enabled=bool(req.enabled) if req.enabled is not None else True,
            )
            db.add(cfg)
        else:
            cfg.p1_u = float(req.p1.x)
            cfg.p1_v = float(req.p1.y)
            cfg.p2_u = float(req.p2.x)
            cfg.p2_v = float(req.p2.y)
            cfg.floor_p1_x = float(req.floor_p1.x) if req.floor_p1 else None
            cfg.floor_p1_y = float(req.floor_p1.y) if req.floor_p1 else None
            cfg.floor_p2_x = float(req.floor_p2.x) if req.floor_p2 else None
            cfg.floor_p2_y = float(req.floor_p2.y) if req.floor_p2 else None
            cfg.in_label = str(req.in_label) if req.in_label is not None else cfg.in_label
            cfg.out_label = str(req.out_label) if req.out_label is not None else cfg.out_label
            cfg.enabled = bool(req.enabled) if req.enabled is not None else cfg.enabled
        db.commit()
        db.refresh(cfg)

    line = FootfallLine(
        p1=(float(req.p1.x), float(req.p1.y)),
        p2=(float(req.p2.x), float(req.p2.y)),
        zone_w=float(req.zone_w),
        line_config_id=int(cfg.id),
    )
    analyzer.start(
        floor_plan_id=int(req.floor_plan_id),
        virtual_view_id=int(req.virtual_view_id),
        line=line,
        emit_interval_sec=float(req.emit_interval_sec),
    )
    return {"status": "started", "floor_plan_id": req.floor_plan_id, "virtual_view_id": req.virtual_view_id}


@router.post("/lines/upsert", response_model=FootfallLineConfigOut)
async def footfall_lines_upsert(req: FootfallLineUpsertRequest):
    with SessionLocal() as db:
        cfg = (
            db.query(models.FootfallLineConfig)
            .filter(
                models.FootfallLineConfig.floor_plan_id == int(req.floor_plan_id),
                models.FootfallLineConfig.virtual_view_id == int(req.virtual_view_id),
            )
            .first()
        )
        if cfg is None:
            cfg = models.FootfallLineConfig(
                floor_plan_id=int(req.floor_plan_id),
                virtual_view_id=int(req.virtual_view_id),
                p1_u=float(req.p1.x),
                p1_v=float(req.p1.y),
                p2_u=float(req.p2.x),
                p2_v=float(req.p2.y),
                floor_p1_x=float(req.floor_p1.x) if req.floor_p1 else None,
                floor_p1_y=float(req.floor_p1.y) if req.floor_p1 else None,
                floor_p2_x=float(req.floor_p2.x) if req.floor_p2 else None,
                floor_p2_y=float(req.floor_p2.y) if req.floor_p2 else None,
                in_label=str(req.in_label) if req.in_label is not None else "进入",
                out_label=str(req.out_label) if req.out_label is not None else "离开",
                enabled=bool(req.enabled) if req.enabled is not None else True,
            )
            db.add(cfg)
        else:
            cfg.p1_u = float(req.p1.x)
            cfg.p1_v = float(req.p1.y)
            cfg.p2_u = float(req.p2.x)
            cfg.p2_v = float(req.p2.y)
            cfg.floor_p1_x = float(req.floor_p1.x) if req.floor_p1 else None
            cfg.floor_p1_y = float(req.floor_p1.y) if req.floor_p1 else None
            cfg.floor_p2_x = float(req.floor_p2.x) if req.floor_p2 else None
            cfg.floor_p2_y = float(req.floor_p2.y) if req.floor_p2 else None
            cfg.in_label = str(req.in_label) if req.in_label is not None else cfg.in_label
            cfg.out_label = str(req.out_label) if req.out_label is not None else cfg.out_label
            cfg.enabled = bool(req.enabled) if req.enabled is not None else cfg.enabled
        db.commit()
        db.refresh(cfg)

        return FootfallLineConfigOut(
            id=int(cfg.id),
            floor_plan_id=int(cfg.floor_plan_id),
            virtual_view_id=int(cfg.virtual_view_id),
            p1=Vec2Out(x=float(cfg.p1_u), y=float(cfg.p1_v)),
            p2=Vec2Out(x=float(cfg.p2_u), y=float(cfg.p2_v)),
            floor_p1=(
                Vec2Out(x=float(cfg.floor_p1_x), y=float(cfg.floor_p1_y))
                if cfg.floor_p1_x is not None and cfg.floor_p1_y is not None
                else None
            ),
            floor_p2=(
                Vec2Out(x=float(cfg.floor_p2_x), y=float(cfg.floor_p2_y))
                if cfg.floor_p2_x is not None and cfg.floor_p2_y is not None
                else None
            ),
            in_label=str(cfg.in_label),
            out_label=str(cfg.out_label),
            enabled=bool(cfg.enabled),
        )


@router.delete("/lines")
async def footfall_lines_delete(floor_plan_id: int, virtual_view_id: int):
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
            return {"status": "not_found"}
        db.delete(cfg)
        db.commit()
    return {"status": "deleted"}


@router.get("/lines", response_model=List[FootfallLineConfigOut])
async def footfall_lines_list(floor_plan_id: int):
    with SessionLocal() as db:
        rows = (
            db.query(models.FootfallLineConfig)
            .filter(models.FootfallLineConfig.floor_plan_id == int(floor_plan_id))
            .order_by(models.FootfallLineConfig.id.asc())
            .all()
        )
        out: List[FootfallLineConfigOut] = []
        for cfg in rows:
            out.append(
                FootfallLineConfigOut(
                    id=int(cfg.id),
                    floor_plan_id=int(cfg.floor_plan_id),
                    virtual_view_id=int(cfg.virtual_view_id),
                    p1=Vec2Out(x=float(cfg.p1_u), y=float(cfg.p1_v)),
                    p2=Vec2Out(x=float(cfg.p2_u), y=float(cfg.p2_v)),
                    floor_p1=(
                        Vec2Out(x=float(cfg.floor_p1_x), y=float(cfg.floor_p1_y))
                        if cfg.floor_p1_x is not None and cfg.floor_p1_y is not None
                        else None
                    ),
                    floor_p2=(
                        Vec2Out(x=float(cfg.floor_p2_x), y=float(cfg.floor_p2_y))
                        if cfg.floor_p2_x is not None and cfg.floor_p2_y is not None
                        else None
                    ),
                    in_label=str(cfg.in_label),
                    out_label=str(cfg.out_label),
                    enabled=bool(cfg.enabled),
                )
            )
        return out


@router.get("/stats")
async def footfall_stats(
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",  # realtime | date
    date_key: Optional[str] = None,  # YYYY-MM-DD in UTC
    tz_offset_minutes: Optional[int] = None,  # JS Date.getTimezoneOffset()
):
    try:
        return get_footfall_stats_sync(
            floor_plan_id=int(floor_plan_id),
            virtual_view_id=int(virtual_view_id),
            mode=str(mode),
            date_key=date_key,
            tz_offset_minutes=(int(tz_offset_minutes) if tz_offset_minutes is not None else None),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/status")
async def footfall_status(
    floor_plan_id: int,
    virtual_view_id: int,
):
    return {
        "floor_plan_id": int(floor_plan_id),
        "virtual_view_id": int(virtual_view_id),
        "running": analyzer.is_running(int(floor_plan_id), int(virtual_view_id)),
    }


@router.post("/stop")
async def footfall_stop(floor_plan_id: int, virtual_view_id: int):
    analyzer.stop(floor_plan_id=int(floor_plan_id), virtual_view_id=int(virtual_view_id))
    return {"status": "stopped", "floor_plan_id": floor_plan_id, "virtual_view_id": virtual_view_id}

