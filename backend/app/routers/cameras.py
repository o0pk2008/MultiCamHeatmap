from typing import Dict, List, Tuple

import math
import time

import cv2
import numpy as np

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

# 摄像头基础管理路由：
# - 负责维护摄像头的元信息（名称 / RTSP URL / 启用状态）。
# - 不直接关心平面图映射，映射由 mappings 路由负责。

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


_remap_cache: Dict[Tuple[int, int, float, float, float, int, int], Tuple[np.ndarray, np.ndarray]] = {}


def _build_equirect_to_perspective_map(
    in_w: int,
    in_h: int,
    yaw_deg: float,
    pitch_deg: float,
    fov_deg: float,
    out_w: int,
    out_h: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    基于等距柱状投影（equirectangular，经度x纬度）构造到透视平面的 remap。
    约定：输入图像横轴为 yaw（-pi..pi），纵轴为 pitch/纬度（-pi/2..pi/2）。
    """
    key = (in_w, in_h, float(yaw_deg), float(pitch_deg), float(fov_deg), out_w, out_h)
    cached = _remap_cache.get(key)
    if cached is not None:
        return cached

    fov = math.radians(fov_deg)
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)

    # 透视相机在归一化平面上的坐标
    x = (np.linspace(0, out_w - 1, out_w) - (out_w - 1) / 2.0) / ((out_w - 1) / 2.0)
    y = (np.linspace(0, out_h - 1, out_h) - (out_h - 1) / 2.0) / ((out_h - 1) / 2.0)
    xx, yy = np.meshgrid(x, y)

    # 按 fov 将归一化平面映射到视锥
    # 注意：这里用 tan(fov/2) 控制视场
    zz = np.ones_like(xx)
    xx = xx * math.tan(fov / 2.0)
    yy = -yy * math.tan(fov / 2.0)  # y 轴向下为正，反转为右手系

    # 归一化方向向量
    norm = np.sqrt(xx * xx + yy * yy + zz * zz)
    vx = xx / norm
    vy = yy / norm
    vz = zz / norm

    # 先绕 x 轴 pitch，再绕 y 轴 yaw（可按需要调整约定）
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)

    # pitch: rotate around x
    vy2 = vy * cp - vz * sp
    vz2 = vy * sp + vz * cp
    vx2 = vx

    # yaw: rotate around y
    vx3 = vx2 * cy + vz2 * sy
    vz3 = -vx2 * sy + vz2 * cy
    vy3 = vy2

    # 转为经纬度
    lon = np.arctan2(vx3, vz3)  # [-pi, pi]
    lat = np.arcsin(np.clip(vy3, -1.0, 1.0))  # [-pi/2, pi/2]

    # 映射到像素坐标
    map_x = (lon / (2 * math.pi) + 0.5) * (in_w - 1)
    map_y = (0.5 - lat / math.pi) * (in_h - 1)

    map_x = map_x.astype(np.float32)
    map_y = map_y.astype(np.float32)
    _remap_cache[key] = (map_x, map_y)
    return map_x, map_y


def _equirect_to_perspective(
    frame_bgr: np.ndarray,
    yaw_deg: float,
    pitch_deg: float,
    fov_deg: float,
    out_w: int,
    out_h: int,
) -> np.ndarray:
    in_h, in_w = frame_bgr.shape[:2]
    map_x, map_y = _build_equirect_to_perspective_map(
        in_w, in_h, yaw_deg, pitch_deg, fov_deg, out_w, out_h
    )
    return cv2.remap(frame_bgr, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


@router.get("/", response_model=List[schemas.CameraOut])
def list_cameras(db: Session = Depends(get_db)) -> List[models.Camera]:
    return db.query(models.Camera).order_by(models.Camera.id).all()


@router.post("/", response_model=schemas.CameraOut)
def create_camera(payload: schemas.CameraCreate, db: Session = Depends(get_db)) -> models.Camera:
    # 如果未显式提供 webrtc_url，可以在这里根据环境变量或约定自动生成。
    # 例如 WEBRTC_BASE_URL + 摄像头名称/ID（当前仅预留扩展点，默认直接使用 payload 中的值）。
    cam = models.Camera(
        name=payload.name,
        rtsp_url=payload.rtsp_url,
        webrtc_url=payload.webrtc_url,
        enabled=payload.enabled,
        description=payload.description,
    )
    db.add(cam)
    db.commit()
    db.refresh(cam)
    return cam


@router.get("/virtual-views/all", response_model=List[schemas.CameraVirtualViewWithCameraOut])
def list_all_virtual_views(db: Session = Depends(get_db)) -> List[dict]:
    rows = (
        db.query(models.CameraVirtualView, models.Camera.name)
        .join(models.Camera, models.Camera.id == models.CameraVirtualView.camera_id)
        .order_by(models.CameraVirtualView.id)
        .all()
    )
    # 返回 view 字段 + camera_name
    out: List[dict] = []
    for view, camera_name in rows:
        out.append(
            {
                "id": view.id,
                "camera_id": view.camera_id,
                "camera_name": camera_name,
                "name": view.name,
                "enabled": view.enabled,
                "yaw_deg": view.yaw_deg,
                "pitch_deg": view.pitch_deg,
                "fov_deg": view.fov_deg,
                "out_w": view.out_w,
                "out_h": view.out_h,
            }
        )
    return out


@router.put("/{camera_id}", response_model=schemas.CameraOut)
def update_camera(
    camera_id: int, payload: schemas.CameraUpdate, db: Session = Depends(get_db)
) -> models.Camera:
    cam = db.query(models.Camera).filter(models.Camera.id == camera_id).first()
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found")

    cam.name = payload.name
    cam.rtsp_url = payload.rtsp_url
    cam.webrtc_url = payload.webrtc_url
    cam.enabled = payload.enabled
    cam.description = payload.description

    db.commit()
    db.refresh(cam)
    return cam


@router.delete("/{camera_id}")
def delete_camera(camera_id: int, db: Session = Depends(get_db)) -> None:
    cam = db.query(models.Camera).filter(models.Camera.id == camera_id).first()
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found")
    db.delete(cam)
    db.commit()


@router.get("/{camera_id}/virtual-views", response_model=List[schemas.CameraVirtualViewOut])
def list_virtual_views(camera_id: int, db: Session = Depends(get_db)) -> List[models.CameraVirtualView]:
    if not db.query(models.Camera).filter(models.Camera.id == camera_id).first():
        raise HTTPException(status_code=404, detail="Camera not found")
    return (
        db.query(models.CameraVirtualView)
        .filter(models.CameraVirtualView.camera_id == camera_id)
        .order_by(models.CameraVirtualView.id)
        .all()
    )


@router.post("/{camera_id}/virtual-views", response_model=schemas.CameraVirtualViewOut)
def create_virtual_view(
    camera_id: int, payload: schemas.CameraVirtualViewCreate, db: Session = Depends(get_db)
) -> models.CameraVirtualView:
    if payload.camera_id != camera_id:
        raise HTTPException(status_code=400, detail="camera_id mismatch in payload")
    if not db.query(models.Camera).filter(models.Camera.id == camera_id).first():
        raise HTTPException(status_code=404, detail="Camera not found")
    view = models.CameraVirtualView(**payload.dict())
    db.add(view)
    db.commit()
    db.refresh(view)
    return view


@router.put("/{camera_id}/virtual-views/{view_id}", response_model=schemas.CameraVirtualViewOut)
def update_virtual_view(
    camera_id: int,
    view_id: int,
    payload: schemas.CameraVirtualViewUpdate,
    db: Session = Depends(get_db),
) -> models.CameraVirtualView:
    view = (
        db.query(models.CameraVirtualView)
        .filter(models.CameraVirtualView.id == view_id, models.CameraVirtualView.camera_id == camera_id)
        .first()
    )
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    data = payload.dict(exclude_unset=True)
    for k, v in data.items():
        setattr(view, k, v)
    db.commit()
    db.refresh(view)
    return view


@router.delete("/{camera_id}/virtual-views/{view_id}")
def delete_virtual_view(camera_id: int, view_id: int, db: Session = Depends(get_db)) -> None:
    view = (
        db.query(models.CameraVirtualView)
        .filter(models.CameraVirtualView.id == view_id, models.CameraVirtualView.camera_id == camera_id)
        .first()
    )
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    db.delete(view)
    db.commit()


@router.get("/{camera_id}/virtual-views/{view_id}/preview.mjpeg")
def preview_virtual_view_mjpeg(camera_id: int, view_id: int, db: Session = Depends(get_db)):
    cam = db.query(models.Camera).filter(models.Camera.id == camera_id).first()
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found")
    view = (
        db.query(models.CameraVirtualView)
        .filter(models.CameraVirtualView.id == view_id, models.CameraVirtualView.camera_id == camera_id)
        .first()
    )
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")

    def gen():
        cap = cv2.VideoCapture(cam.rtsp_url)
        # 尝试降低缓冲延迟
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        boundary = b"--frame"
        last_ok = time.time()
        try:
            while True:
                ok, frame = cap.read()
                if not ok or frame is None:
                    # RTSP 抖动时短暂等待重试
                    if time.time() - last_ok > 5:
                        break
                    time.sleep(0.05)
                    continue
                last_ok = time.time()

                if not view.enabled:
                    persp = frame
                else:
                    persp = _equirect_to_perspective(
                        frame,
                        yaw_deg=view.yaw_deg,
                        pitch_deg=view.pitch_deg,
                        fov_deg=view.fov_deg,
                        out_w=view.out_w,
                        out_h=view.out_h,
                    )

                ok2, jpg = cv2.imencode(".jpg", persp, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok2:
                    continue
                data = jpg.tobytes()
                yield boundary + b"\r\n"
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(data)}\r\n\r\n".encode("utf-8")
                yield data + b"\r\n"
        finally:
            cap.release()

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@router.get("/virtual-views/{view_id}/grid-config", response_model=schemas.CameraVirtualViewGridConfigOut)
def get_virtual_view_grid_config(view_id: int, db: Session = Depends(get_db)):
    view = db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    cfg = (
        db.query(models.CameraVirtualViewGridConfig)
        .filter(models.CameraVirtualViewGridConfig.virtual_view_id == view_id)
        .first()
    )
    if not cfg:
        # 返回默认配置（但不落库），前端可在保存时 upsert
        return {
            "virtual_view_id": view_id,
            "polygon_json": "[]",
            "grid_rows": 10,
            "grid_cols": 10,
        }
    return cfg


@router.put("/virtual-views/{view_id}/grid-config", response_model=schemas.CameraVirtualViewGridConfigOut)
def upsert_virtual_view_grid_config(
    view_id: int, payload: schemas.CameraVirtualViewGridConfigUpsert, db: Session = Depends(get_db)
):
    view = db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    cfg = (
        db.query(models.CameraVirtualViewGridConfig)
        .filter(models.CameraVirtualViewGridConfig.virtual_view_id == view_id)
        .first()
    )
    if not cfg:
        cfg = models.CameraVirtualViewGridConfig(virtual_view_id=view_id)
        db.add(cfg)
    cfg.polygon_json = payload.polygon_json
    cfg.grid_rows = payload.grid_rows
    cfg.grid_cols = payload.grid_cols
    db.commit()
    db.refresh(cfg)
    return cfg


@router.delete("/virtual-views/{view_id}/grid-config")
def delete_virtual_view_grid_config(view_id: int, db: Session = Depends(get_db)) -> None:
    view = db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    cfg = (
        db.query(models.CameraVirtualViewGridConfig)
        .filter(models.CameraVirtualViewGridConfig.virtual_view_id == view_id)
        .first()
    )
    if cfg:
        db.delete(cfg)
        db.commit()


@router.get(
    "/virtual-views/{view_id}/cell-mappings",
    response_model=List[schemas.VirtualViewCellMappingOut],
)
def list_virtual_view_cell_mappings(
    view_id: int,
    floor_plan_id: int,
    db: Session = Depends(get_db),
) -> List[models.VirtualViewCellMapping]:
    if not db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first():
        raise HTTPException(status_code=404, detail="Virtual view not found")
    return (
        db.query(models.VirtualViewCellMapping)
        .filter(
            models.VirtualViewCellMapping.virtual_view_id == view_id,
            models.VirtualViewCellMapping.floor_plan_id == floor_plan_id,
        )
        .order_by(models.VirtualViewCellMapping.camera_row, models.VirtualViewCellMapping.camera_col)
        .all()
    )


@router.put(
    "/virtual-views/{view_id}/cell-mappings",
    response_model=schemas.VirtualViewCellMappingOut,
)
def upsert_virtual_view_cell_mapping(
    view_id: int,
    payload: schemas.VirtualViewCellMappingUpsert,
    db: Session = Depends(get_db),
):
    if not db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first():
        raise HTTPException(status_code=404, detail="Virtual view not found")
    if not db.query(models.FloorPlan).filter(models.FloorPlan.id == payload.floor_plan_id).first():
        raise HTTPException(status_code=404, detail="Floor plan not found")

    existing = (
        db.query(models.VirtualViewCellMapping)
        .filter(
            models.VirtualViewCellMapping.virtual_view_id == view_id,
            models.VirtualViewCellMapping.camera_row == payload.camera_row,
            models.VirtualViewCellMapping.camera_col == payload.camera_col,
        )
        .first()
    )
    if not existing:
        existing = models.VirtualViewCellMapping(
            virtual_view_id=view_id,
            floor_plan_id=payload.floor_plan_id,
            camera_row=payload.camera_row,
            camera_col=payload.camera_col,
            floor_row=payload.floor_row,
            floor_col=payload.floor_col,
        )
        db.add(existing)
    else:
        existing.floor_plan_id = payload.floor_plan_id
        existing.floor_row = payload.floor_row
        existing.floor_col = payload.floor_col

    db.commit()
    db.refresh(existing)
    return existing


@router.delete("/virtual-views/{view_id}/cell-mappings/{mapping_id}")
def delete_virtual_view_cell_mapping(view_id: int, mapping_id: int, db: Session = Depends(get_db)) -> None:
    m = (
        db.query(models.VirtualViewCellMapping)
        .filter(
            models.VirtualViewCellMapping.id == mapping_id,
            models.VirtualViewCellMapping.virtual_view_id == view_id,
        )
        .first()
    )
    if not m:
        raise HTTPException(status_code=404, detail="Mapping not found")
    db.delete(m)
    db.commit()


@router.delete("/virtual-views/{view_id}/cell-mappings")
def delete_all_virtual_view_cell_mappings(
    view_id: int,
    floor_plan_id: int,
    db: Session = Depends(get_db),
) -> None:
    if not db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first():
        raise HTTPException(status_code=404, detail="Virtual view not found")
    (
        db.query(models.VirtualViewCellMapping)
        .filter(
            models.VirtualViewCellMapping.virtual_view_id == view_id,
            models.VirtualViewCellMapping.floor_plan_id == floor_plan_id,
        )
        .delete(synchronize_session=False)
    )
    db.commit()

