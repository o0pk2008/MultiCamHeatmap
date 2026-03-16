from typing import List

from fastapi import APIRouter, Depends, HTTPException
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

