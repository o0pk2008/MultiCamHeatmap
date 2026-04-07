from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Response
from pydantic import BaseModel

from ..db import SessionLocal
from .. import models
from ..footfall_analysis import analyzer, FootfallLine
from ..footfall_store import get_footfall_stats_sync
from ..virtual_view_inference import manager

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


class FaceCaptureOut(BaseModel):
    id: int
    track_id: int
    ts: float
    gender: Optional[str] = None
    age_bucket: Optional[str] = None
    image_url: Optional[str] = None
    image_base64: Optional[str] = None


class FaceReanalyzeRequest(BaseModel):
    floor_plan_id: int
    mode: str = "all"  # all | range
    start_date: Optional[str] = None  # YYYY-MM-DD
    end_date: Optional[str] = None  # YYYY-MM-DD
    tz_offset_minutes: Optional[int] = None


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
        enabled=bool(cfg.enabled),
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

        if analyzer.is_running(int(cfg.floor_plan_id), int(cfg.virtual_view_id)):
            analyzer.merge_line_state(
                floor_plan_id=int(cfg.floor_plan_id),
                virtual_view_id=int(cfg.virtual_view_id),
                p1=(float(cfg.p1_u), float(cfg.p1_v)),
                p2=(float(cfg.p2_u), float(cfg.p2_v)),
                line_config_id=int(cfg.id),
                enabled=bool(cfg.enabled),
            )

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
    response: Response,
    floor_plan_id: int,
    virtual_view_id: int,
    mode: str = "realtime",  # realtime | date
    date_key: Optional[str] = None,  # YYYY-MM-DD in UTC
    tz_offset_minutes: Optional[int] = None,  # JS Date.getTimezoneOffset()
):
    try:
        payload = get_footfall_stats_sync(
            floor_plan_id=int(floor_plan_id),
            virtual_view_id=int(virtual_view_id),
            mode=str(mode),
            date_key=date_key,
            tz_offset_minutes=(int(tz_offset_minutes) if tz_offset_minutes is not None else None),
        )
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return payload
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


@router.get("/face-captures", response_model=List[FaceCaptureOut])
async def footfall_face_captures(
    response: Response,
    virtual_view_id: int,
    floor_plan_id: Optional[int] = None,
    mode: str = "realtime",  # realtime | date
    date_key: Optional[str] = None,  # YYYY-MM-DD
    tz_offset_minutes: Optional[int] = None,
    limit: int = 12,
    offset: int = 0,
):
    lim = max(1, min(int(limit), 200))
    off = max(0, int(offset))

    def _tz_from_offset_minutes(tz_min: Optional[int]) -> timezone:
        if tz_min is None:
            local_dt = datetime.now().astimezone()
            tzinfo = local_dt.tzinfo
            if isinstance(tzinfo, timezone):
                return tzinfo
            offset = local_dt.utcoffset() or timedelta(0)
            return timezone(offset)
        return timezone(-timedelta(minutes=int(tz_min)))

    def _range_ts(_mode: str, _date_key: Optional[str], _tz_min: Optional[int]) -> tuple[float, float]:
        tz = _tz_from_offset_minutes(_tz_min)
        if _mode == "realtime":
            now = datetime.now(tz)
            start = datetime(now.year, now.month, now.day, tzinfo=tz)
            end = start + timedelta(days=1)
            return float(start.timestamp()), float(end.timestamp())
        if _mode != "date":
            raise HTTPException(status_code=400, detail="invalid mode")
        if not _date_key:
            raise HTTPException(status_code=400, detail="date_key required for date mode")
        try:
            y, m, d = [int(x) for x in str(_date_key).split("-", 2)]
            start = datetime(y, m, d, tzinfo=tz)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid date_key")
        end = start + timedelta(days=1)
        return float(start.timestamp()), float(end.timestamp())

    start_ts, end_ts = _range_ts(str(mode), date_key, tz_offset_minutes)

    with SessionLocal() as db:
        q = db.query(models.FootfallFaceCapture).filter(
            models.FootfallFaceCapture.virtual_view_id == int(virtual_view_id),
            models.FootfallFaceCapture.ts >= float(start_ts),
            models.FootfallFaceCapture.ts < float(end_ts),
        )
        if floor_plan_id is not None:
            q = q.filter(models.FootfallFaceCapture.floor_plan_id == int(floor_plan_id))
        rows = q.order_by(models.FootfallFaceCapture.ts.desc()).offset(off).limit(lim).all()

    out: List[FaceCaptureOut] = []
    for r in rows:
        try:
            out.append(
                FaceCaptureOut(
                    id=int(r.id),
                    track_id=int(r.track_id if r.track_id is not None else -1),
                    ts=float(r.ts),
                    gender=(str(r.gender) if r.gender is not None else None),
                    age_bucket=(str(r.age_bucket) if r.age_bucket is not None else None),
                    image_url=(
                        f"/face-captures/{str(r.image_path).lstrip('/')}"
                        if getattr(r, "image_path", None)
                        else None
                    ),
                    image_base64=(str(r.image_base64) if getattr(r, "image_base64", None) else None),
                )
            )
        except Exception:
            continue
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return out


@router.post("/reanalyze-face-captures")
async def footfall_reanalyze_face_captures(req: FaceReanalyzeRequest):
    fp_id = int(req.floor_plan_id)
    mode = str(req.mode or "all").strip().lower()
    start_ts: Optional[float] = None
    end_ts: Optional[float] = None

    def _tz_from_offset_minutes(tz_min: Optional[int]) -> timezone:
        if tz_min is None:
            local_dt = datetime.now().astimezone()
            tzinfo = local_dt.tzinfo
            if isinstance(tzinfo, timezone):
                return tzinfo
            offset = local_dt.utcoffset() or timedelta(0)
            return timezone(offset)
        return timezone(-timedelta(minutes=int(tz_min)))

    if mode not in ("all", "range"):
        raise HTTPException(status_code=400, detail="invalid mode")
    if mode == "range":
        if not req.start_date or not req.end_date:
            raise HTTPException(status_code=400, detail="start_date and end_date required in range mode")
        tz = _tz_from_offset_minutes(req.tz_offset_minutes)
        try:
            sy, sm, sd = [int(x) for x in str(req.start_date).split("-", 2)]
            ey, em, ed = [int(x) for x in str(req.end_date).split("-", 2)]
            start_dt = datetime(sy, sm, sd, tzinfo=tz)
            end_dt = datetime(ey, em, ed, tzinfo=tz) + timedelta(days=1)
            start_ts = float(start_dt.timestamp())
            end_ts = float(end_dt.timestamp())
        except Exception:
            raise HTTPException(status_code=400, detail="invalid start_date/end_date")

    scanned = 0
    updated_captures = 0
    updated_events = 0

    with SessionLocal() as db:
        q = db.query(models.FootfallFaceCapture).filter(models.FootfallFaceCapture.floor_plan_id == fp_id)
        if start_ts is not None and end_ts is not None:
            q = q.filter(models.FootfallFaceCapture.ts >= float(start_ts), models.FootfallFaceCapture.ts < float(end_ts))
        rows = q.order_by(models.FootfallFaceCapture.id.asc()).all()

        for r in rows:
            scanned += 1
            gender, age_bucket = manager.reanalyze_face_capture_attributes(
                image_base64=str(r.image_base64 or ""),
                image_path=(str(r.image_path) if getattr(r, "image_path", None) else None),
            )
            gender_next = str(gender) if gender is not None else None
            age_next = str(age_bucket) if age_bucket is not None else None
            changed = (r.gender != gender_next) or (r.age_bucket != age_next)
            if not changed:
                continue
            r.gender = gender_next
            r.age_bucket = age_next
            updated_captures += 1

            # 同步修正统计事件（只影响 in 方向）
            ev_q = db.query(models.FootfallCrossEvent).filter(
                models.FootfallCrossEvent.floor_plan_id == int(r.floor_plan_id),
                models.FootfallCrossEvent.virtual_view_id == int(r.virtual_view_id),
                models.FootfallCrossEvent.line_config_id == int(r.line_config_id),
                models.FootfallCrossEvent.direction == "in",
                models.FootfallCrossEvent.ts >= float(r.ts) - 3.0,
                models.FootfallCrossEvent.ts <= float(r.ts) + 3.0,
            )
            sid = int(r.stable_id) if r.stable_id is not None else None
            tid = int(r.track_id) if r.track_id is not None else None
            if sid is not None:
                ev_q = ev_q.filter(models.FootfallCrossEvent.stable_id == sid)
            elif tid is not None:
                ev_q = ev_q.filter(models.FootfallCrossEvent.track_id == tid)
            ev = ev_q.order_by(models.FootfallCrossEvent.ts.desc()).first()
            if ev is not None:
                ev.gender = gender_next
                ev.age_bucket = age_next
                updated_events += 1

        db.commit()

    return {
        "status": "ok",
        "scanned": int(scanned),
        "updated_captures": int(updated_captures),
        "updated_events": int(updated_events),
    }


@router.post("/stop")
async def footfall_stop(floor_plan_id: int, virtual_view_id: int):
    analyzer.stop(floor_plan_id=int(floor_plan_id), virtual_view_id=int(virtual_view_id))
    return {"status": "stopped", "floor_plan_id": floor_plan_id, "virtual_view_id": virtual_view_id}

