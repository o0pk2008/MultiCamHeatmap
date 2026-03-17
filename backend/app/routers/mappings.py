from typing import List
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db

# 映射相关路由：
# - 平面图及其网格（FloorPlan / FloorCell）
# - 摄像头与平面图的整体映射（CameraMapping）
# - 摄像机画面中的地面格子（CameraGroundCell）
# 这些接口构成“多摄像头 → 一张平面图”的静态配置基础。

router = APIRouter(prefix="/api", tags=["mappings"])


@router.get("/floor-plans", response_model=List[schemas.FloorPlanOut])
def list_floor_plans(db: Session = Depends(get_db)) -> List[models.FloorPlan]:
    return db.query(models.FloorPlan).order_by(models.FloorPlan.id).all()


@router.post("/floor-plans", response_model=schemas.FloorPlanOut)
def create_floor_plan(
    payload: schemas.FloorPlanCreate, db: Session = Depends(get_db)
) -> models.FloorPlan:
    fp = models.FloorPlan(**payload.dict())
    db.add(fp)
    db.commit()
    db.refresh(fp)
    return fp


@router.put("/floor-plans/{floor_plan_id}", response_model=schemas.FloorPlanOut)
def update_floor_plan(
    floor_plan_id: int,
    payload: schemas.FloorPlanUpdate,
    db: Session = Depends(get_db),
) -> models.FloorPlan:
    fp = db.query(models.FloorPlan).filter(models.FloorPlan.id == floor_plan_id).first()
    if not fp:
        raise HTTPException(status_code=404, detail="Floor plan not found")
    data = payload.dict(exclude_unset=True)
    for k, v in data.items():
        setattr(fp, k, v)
    db.commit()
    db.refresh(fp)
    return fp


@router.get("/floor-plans/{floor_plan_id}/cells", response_model=List[schemas.FloorCellOut])
def list_floor_cells(
    floor_plan_id: int, db: Session = Depends(get_db)
) -> List[models.FloorCell]:
    return (
        db.query(models.FloorCell)
        .filter(models.FloorCell.floor_plan_id == floor_plan_id)
        .order_by(models.FloorCell.row_index, models.FloorCell.col_index)
        .all()
    )


@router.post(
    "/floor-plans/{floor_plan_id}/cells/bulk",
    response_model=List[schemas.FloorCellOut],
)
def bulk_create_floor_cells(
    floor_plan_id: int, payload: List[schemas.FloorCellCreate], db: Session = Depends(get_db)
) -> List[models.FloorCell]:
    # 假设前端已经算好 polygon，并保证 floor_plan_id 一致
    cells: List[models.FloorCell] = []
    for item in payload:
        if item.floor_plan_id != floor_plan_id:
            raise HTTPException(status_code=400, detail="floor_plan_id mismatch in payload")
        cell = models.FloorCell(
            floor_plan_id=item.floor_plan_id,
            row_index=item.row_index,
            col_index=item.col_index,
            polygon=item.polygon,
        )
        db.add(cell)
        cells.append(cell)
    db.commit()
    for c in cells:
        db.refresh(c)
    return cells


@router.get("/camera-mappings", response_model=List[schemas.CameraMappingOut])
def list_camera_mappings(db: Session = Depends(get_db)) -> List[models.CameraMapping]:
    return db.query(models.CameraMapping).order_by(models.CameraMapping.id).all()


@router.get("/floor-plans/{floor_plan_id}/mapped-camera-ids", response_model=List[int])
def list_mapped_camera_ids(floor_plan_id: int, db: Session = Depends(get_db)) -> List[int]:
    """
    返回与该平面图存在“映射关系”的 camera_id 列表。
    映射关系来源包含：
    - camera_mappings（传统 camera->floor_plan 映射）
    - virtual PTZ 的 cell-mappings（virtual_view_cell_mappings，通过 virtual_view -> camera 关联）
    """
    if not db.query(models.FloorPlan).filter(models.FloorPlan.id == floor_plan_id).first():
        raise HTTPException(status_code=404, detail="Floor plan not found")

    cam_ids = set(
        r[0]
        for r in db.query(models.CameraMapping.camera_id)
        .filter(models.CameraMapping.floor_plan_id == floor_plan_id)
        .all()
    )

    vv_cam_ids = (
        db.query(models.CameraVirtualView.camera_id)
        .join(
            models.VirtualViewCellMapping,
            models.VirtualViewCellMapping.virtual_view_id == models.CameraVirtualView.id,
        )
        .filter(models.VirtualViewCellMapping.floor_plan_id == floor_plan_id)
        .distinct()
        .all()
    )
    for (cid,) in vv_cam_ids:
        cam_ids.add(cid)

    return sorted(list(cam_ids))


@router.get("/floor-plans/{floor_plan_id}/heatmap-sources", response_model=List[schemas.HeatmapSourceOut])
def list_heatmap_sources(floor_plan_id: int, db: Session = Depends(get_db)) -> List[dict]:
    """
    热力图页右侧要展示的“参与映射的画面源”列表。
    - kind=camera: 来自 camera_mappings
    - kind=virtual: 来自 virtual_view_cell_mappings（展示 virtual PTZ 的画面）
    """
    if not db.query(models.FloorPlan).filter(models.FloorPlan.id == floor_plan_id).first():
        raise HTTPException(status_code=404, detail="Floor plan not found")

    out: List[dict] = []

    # camera_mappings -> camera
    cams = (
        db.query(models.Camera)
        .join(models.CameraMapping, models.CameraMapping.camera_id == models.Camera.id)
        .filter(models.CameraMapping.floor_plan_id == floor_plan_id)
        .distinct()
        .all()
    )
    for c in cams:
        out.append(
            {
                "kind": "camera",
                "camera_id": c.id,
                "camera_name": c.name,
                "webrtc_url": c.webrtc_url,
                "virtual_view_id": None,
                "virtual_view_name": None,
            }
        )

    # virtual_view_cell_mappings -> virtual_view -> camera
    vvs = (
        db.query(models.CameraVirtualView, models.Camera)
        .join(models.Camera, models.Camera.id == models.CameraVirtualView.camera_id)
        .join(
            models.VirtualViewCellMapping,
            models.VirtualViewCellMapping.virtual_view_id == models.CameraVirtualView.id,
        )
        .filter(models.VirtualViewCellMapping.floor_plan_id == floor_plan_id)
        .distinct()
        .all()
    )
    for vv, cam in vvs:
        out.append(
            {
                "kind": "virtual",
                "camera_id": cam.id,
                "camera_name": cam.name,
                "webrtc_url": None,
                "virtual_view_id": vv.id,
                "virtual_view_name": vv.name,
            }
        )

    return out


@router.post("/camera-mappings", response_model=schemas.CameraMappingOut)
def create_camera_mapping(
    payload: schemas.CameraMappingCreate, db: Session = Depends(get_db)
) -> models.CameraMapping:
    # 确认 camera 和 floor_plan 存在
    if not db.query(models.Camera).filter(models.Camera.id == payload.camera_id).first():
        raise HTTPException(status_code=400, detail="Camera not found")
    if not db.query(models.FloorPlan).filter(models.FloorPlan.id == payload.floor_plan_id).first():
        raise HTTPException(status_code=400, detail="Floor plan not found")

    mapping = models.CameraMapping(**payload.dict())
    db.add(mapping)
    db.commit()
    db.refresh(mapping)
    return mapping


@router.post("/floor-plans/upload-image")
async def upload_floor_plan_image(file: UploadFile = File(...)) -> dict:
    """
    上传平面图底图图片（JPG/PNG），保存到 /data/maps 目录。
    返回后端可访问的 image_path 以及通过 /maps 前缀访问的 url。
    """
    if file.content_type not in ("image/png", "image/jpeg"):
        raise HTTPException(status_code=400, detail="Only PNG and JPG images are supported")

    ext = ".png" if file.content_type == "image/png" else ".jpg"
    maps_dir = "/data/maps"
    os.makedirs(maps_dir, exist_ok=True)

    filename = f"{uuid.uuid4().hex}{ext}"
    full_path = os.path.join(maps_dir, filename)

    content = await file.read()
    with open(full_path, "wb") as f:
        f.write(content)

    image_path = f"/data/maps/{filename}"
    url = f"/maps/{filename}"
    return {"image_path": image_path, "url": url}


@router.get(
    "/camera-mappings/{mapping_id}/ground-cells",
    response_model=List[schemas.CameraGroundCellOut],
)
def list_camera_ground_cells(
    mapping_id: int, db: Session = Depends(get_db)
) -> List[models.CameraGroundCell]:
    return (
        db.query(models.CameraGroundCell)
        .filter(models.CameraGroundCell.camera_mapping_id == mapping_id)
        .order_by(models.CameraGroundCell.id)
        .all()
    )


@router.post(
    "/camera-mappings/{mapping_id}/ground-cells",
    response_model=schemas.CameraGroundCellOut,
)
def create_camera_ground_cell(
    mapping_id: int, payload: schemas.CameraGroundCellCreate, db: Session = Depends(get_db)
) -> models.CameraGroundCell:
    if payload.camera_mapping_id != mapping_id:
        raise HTTPException(status_code=400, detail="camera_mapping_id mismatch in payload")

    # 可选：检查 floor_cell 是否存在
    if not db.query(models.FloorCell).filter(models.FloorCell.id == payload.floor_cell_id).first():
        raise HTTPException(status_code=400, detail="Floor cell not found")

    cell = models.CameraGroundCell(
        camera_mapping_id=payload.camera_mapping_id,
        floor_cell_id=payload.floor_cell_id,
        polygon=payload.polygon,
    )
    db.add(cell)
    db.commit()
    db.refresh(cell)
    return cell

