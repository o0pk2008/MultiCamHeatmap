from typing import List, Optional

from pydantic import BaseModel


# Pydantic 模型用于描述 API 输入/输出。
# 其中 polygon / homography 字段统一用字符串承载 JSON/矩阵数据，
# 以保证与 SQLite / PostgreSQL 等多种后端的兼容性。


class CameraBase(BaseModel):
    name: str
    rtsp_url: str
    enabled: bool = True
    description: Optional[str] = None
    webrtc_url: Optional[str] = None


class CameraCreate(CameraBase):
    pass


class CameraUpdate(CameraBase):
    pass


class CameraOut(CameraBase):
    id: int

    class Config:
        orm_mode = True


class CameraVirtualViewBase(BaseModel):
    name: str = "View"
    enabled: bool = True
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    fov_deg: float = 90.0
    out_w: int = 960
    out_h: int = 540


class CameraVirtualViewCreate(CameraVirtualViewBase):
    camera_id: int


class CameraVirtualViewUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    yaw_deg: Optional[float] = None
    pitch_deg: Optional[float] = None
    fov_deg: Optional[float] = None
    out_w: Optional[int] = None
    out_h: Optional[int] = None


class CameraVirtualViewOut(CameraVirtualViewBase):
    id: int
    camera_id: int

    class Config:
        orm_mode = True


class CameraVirtualViewWithCameraOut(CameraVirtualViewOut):
    camera_name: str


class CameraVirtualViewGridConfigBase(BaseModel):
    polygon_json: str  # JSON: [{"x":..,"y":..}, ...] 4 points
    grid_rows: int
    grid_cols: int


class CameraVirtualViewGridConfigUpsert(CameraVirtualViewGridConfigBase):
    pass


class CameraVirtualViewGridConfigOut(CameraVirtualViewGridConfigBase):
    virtual_view_id: int

    class Config:
        orm_mode = True


class VirtualViewCellMappingBase(BaseModel):
    virtual_view_id: int
    floor_plan_id: int
    camera_row: int
    camera_col: int
    floor_row: int
    floor_col: int


class VirtualViewCellMappingUpsert(BaseModel):
    floor_plan_id: int
    camera_row: int
    camera_col: int
    floor_row: int
    floor_col: int


class VirtualViewCellMappingOut(VirtualViewCellMappingBase):
    id: int

    class Config:
        orm_mode = True


class FloorPlanBase(BaseModel):
    name: str
    image_path: str
    width_px: int
    height_px: int
    grid_rows: int
    grid_cols: int


class FloorPlanCreate(FloorPlanBase):
    pass


class FloorPlanUpdate(BaseModel):
    name: Optional[str] = None
    image_path: Optional[str] = None
    width_px: Optional[int] = None
    height_px: Optional[int] = None
    grid_rows: Optional[int] = None
    grid_cols: Optional[int] = None


class FloorPlanOut(FloorPlanBase):
    id: int

    class Config:
        orm_mode = True


class FloorCellBase(BaseModel):
    floor_plan_id: int
    row_index: int
    col_index: int
    polygon: str  # JSON 字符串，由前端计算好传入


class FloorCellCreate(FloorCellBase):
    pass


class FloorCellOut(FloorCellBase):
    id: int

    class Config:
        orm_mode = True


class CameraMappingBase(BaseModel):
    camera_id: int
    floor_plan_id: int
    method: str = "grid"
    homography: Optional[str] = None  # 逗号分隔的 9 个 float 或 JSON 字符串
    notes: Optional[str] = None


class CameraMappingCreate(CameraMappingBase):
    pass


class CameraMappingOut(CameraMappingBase):
    id: int

    class Config:
        orm_mode = True


class CameraGroundCellBase(BaseModel):
    camera_mapping_id: int
    floor_cell_id: int
    polygon: str  # JSON 字符串


class CameraGroundCellCreate(CameraGroundCellBase):
    pass


class CameraGroundCellOut(CameraGroundCellBase):
    id: int

    class Config:
        orm_mode = True


class HeatmapSourceOut(BaseModel):
    kind: str  # "camera" | "virtual"
    camera_id: int
    camera_name: str
    webrtc_url: Optional[str] = None
    virtual_view_id: Optional[int] = None
    virtual_view_name: Optional[str] = None


class HeatmapHistoryCellOut(BaseModel):
    floor_row: int
    floor_col: int
    count: int

