from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from .db import Base


# === 核心业务模型 ===
# 这些 ORM 模型描述了：
# - 多路摄像头（Camera）
# - 一张或多张平面图（FloorPlan）
# - 平面图上的网格格子（FloorCell）
# - 摄像机画面中的地面格子（CameraGroundCell）
# - 以及二者之间的映射关系（CameraMapping）


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    rtsp_url = Column(Text, nullable=False)
    # 对应的 WebRTC 播放地址（由 mediamtx 等服务提供），可选
    webrtc_url = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    description = Column(Text, nullable=True)

    # 一个摄像头可以映射到多张平面图（不同楼层 / 不同配置版本）
    mappings = relationship("CameraMapping", back_populates="camera")


class FloorPlan(Base):
    __tablename__ = "floor_plans"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    image_path = Column(Text, nullable=False)
    width_px = Column(Integer, nullable=False)
    height_px = Column(Integer, nullable=False)
    grid_rows = Column(Integer, nullable=False, default=0)
    grid_cols = Column(Integer, nullable=False, default=0)

    # 平面图被划分成规则网格后，对应的格子记录。
    cells = relationship("FloorCell", back_populates="floor_plan")
    # 与哪些摄像头存在映射关系（多摄像头 → 一张平面图）
    mappings = relationship("CameraMapping", back_populates="floor_plan")


class FloorCell(Base):
    __tablename__ = "floor_cells"

    id = Column(Integer, primary_key=True, index=True)
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    row_index = Column(Integer, nullable=False)
    col_index = Column(Integer, nullable=False)
    # 存平面图上的多边形顶点，JSON 字符串，例如 [{"x":0,"y":0}, ...]。
    # 设计为 JSON 字符串是为了兼容 SQLite / PostgreSQL，且便于一次性写入/读取。
    polygon = Column(Text, nullable=False)

    floor_plan = relationship("FloorPlan", back_populates="cells")
    # 所有关联到该平面格子的摄像机地面格子（多摄像头可共享同一 FloorCell）。
    ground_cells = relationship("CameraGroundCell", back_populates="floor_cell")


class CameraMapping(Base):
    __tablename__ = "camera_mappings"

    id = Column(Integer, primary_key=True, index=True)
    camera_id = Column(Integer, ForeignKey("cameras.id"), nullable=False, index=True)
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    # 映射方式：homography / grid / hybrid
    method = Column(String(32), nullable=False, default="grid")
    # 整体单应矩阵 H 的 9 个浮点数，逗号分隔存为字符串（或存 JSON 字符串）。
    # 这样既能快速反序列化为矩阵，又不会限制底层数据库类型。
    homography = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)

    camera = relationship("Camera", back_populates="mappings")
    floor_plan = relationship("FloorPlan", back_populates="mappings")
    # 当前摄像头视角中的所有地面格子，多边形与 FloorCell 一一对应。
    ground_cells = relationship("CameraGroundCell", back_populates="camera_mapping")


class CameraGroundCell(Base):
    __tablename__ = "camera_ground_cells"

    id = Column(Integer, primary_key=True, index=True)
    camera_mapping_id = Column(Integer, ForeignKey("camera_mappings.id"), nullable=False, index=True)
    floor_cell_id = Column(Integer, ForeignKey("floor_cells.id"), nullable=False, index=True)
    # 摄像机画面中的多边形（地面上的一个格子），JSON 字符串。
    # 多摄像头可以通过不同的 CameraGroundCell 指向同一个 FloorCell，
    # 从而实现“多摄像头地面区域 → 一张平面图网格”的统一统计。
    polygon = Column(Text, nullable=False)

    camera_mapping = relationship("CameraMapping", back_populates="ground_cells")
    floor_cell = relationship("FloorCell", back_populates="ground_cells")

