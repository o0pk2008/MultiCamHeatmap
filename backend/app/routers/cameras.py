from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

# 摄像头基础管理路由：
# - 负责维护摄像头的元信息（名称 / RTSP URL / 启用状态）。
# - 不直接关心平面图映射，映射由 mappings 路由负责。

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


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

