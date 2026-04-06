from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text, UniqueConstraint
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
    virtual_views = relationship(
        "CameraVirtualView", back_populates="camera", cascade="all, delete-orphan"
    )


class CameraVirtualView(Base):
    """
    360 全景相机的虚拟 PTZ 透视视窗配置。
    """

    __tablename__ = "camera_virtual_views"

    id = Column(Integer, primary_key=True, index=True)
    camera_id = Column(Integer, ForeignKey("cameras.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False, default="View")
    enabled = Column(Boolean, nullable=False, default=True)

    # 视角参数（单位：度）
    yaw_deg = Column(Float, nullable=False, default=0.0)
    pitch_deg = Column(Float, nullable=False, default=0.0)
    fov_deg = Column(Float, nullable=False, default=90.0)

    # 输出分辨率
    out_w = Column(Integer, nullable=False, default=640)
    out_h = Column(Integer, nullable=False, default=640)
    # 视窗模式：
    # - panorama_perspective: 全景透视（yaw/pitch/fov 生效）
    # - native_resize: 直接使用原始画面，仅按 out_w/out_h 缩放
    view_mode = Column(String(32), nullable=False, default="panorama_perspective")
    # native_resize 下可选裁剪区域（像素坐标，基于原始输入帧）
    crop_x1 = Column(Integer, nullable=True)
    crop_y1 = Column(Integer, nullable=True)
    crop_x2 = Column(Integer, nullable=True)
    crop_y2 = Column(Integer, nullable=True)

    camera = relationship("Camera", back_populates="virtual_views")
    grid_config = relationship(
        "CameraVirtualViewGridConfig",
        back_populates="virtual_view",
        uselist=False,
        cascade="all, delete-orphan",
    )


class CameraVirtualViewGridConfig(Base):
    """
    virtual PTZ 视窗中的“地面四边形区域”与网格划分配置（用于后续映射绑定）。
    polygon_json: [{"x":..,"y":..}, ...] 4 points in image pixel coords (out_w/out_h space)
    """

    __tablename__ = "camera_virtual_view_grid_configs"

    id = Column(Integer, primary_key=True, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, unique=True, index=True
    )
    polygon_json = Column(Text, nullable=False, default="[]")
    grid_rows = Column(Integer, nullable=False, default=10)
    grid_cols = Column(Integer, nullable=False, default=10)

    virtual_view = relationship("CameraVirtualView", back_populates="grid_config")


class VirtualViewCellMapping(Base):
    """
    virtual PTZ 网格 cell -> 平面图网格 cell 的绑定关系。
    以 (virtual_view_id, camera_row, camera_col) 唯一，便于替换。
    """

    __tablename__ = "virtual_view_cell_mappings"
    __table_args__ = (
        UniqueConstraint("virtual_view_id", "camera_row", "camera_col", name="uq_vv_cam_cell"),
        UniqueConstraint(
            "virtual_view_id",
            "floor_plan_id",
            "floor_row",
            "floor_col",
            name="uq_vv_floor_cell",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    virtual_view_id = Column(Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True)
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)

    camera_row = Column(Integer, nullable=False)
    camera_col = Column(Integer, nullable=False)
    floor_row = Column(Integer, nullable=False)
    floor_col = Column(Integer, nullable=False)

    virtual_view = relationship("CameraVirtualView")
    floor_plan = relationship("FloorPlan")


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


class HeatmapEvent(Base):
    """
    热力事件落库（用于历史回放/按时间段统计）。
    事件粒度：一次“落脚点”命中某个 floor cell。
    """

    __tablename__ = "heatmap_events"

    id = Column(Integer, primary_key=True, index=True)
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    floor_row = Column(Integer, nullable=False, index=True)
    floor_col = Column(Integer, nullable=False, index=True)

    camera_id = Column(Integer, ForeignKey("cameras.id"), nullable=True, index=True)
    virtual_view_id = Column(Integer, ForeignKey("camera_virtual_views.id"), nullable=True, index=True)

    # Unix timestamp（秒，浮点）
    ts = Column(Float, nullable=False, index=True)

    floor_plan = relationship("FloorPlan")
    camera = relationship("Camera")
    virtual_view = relationship("CameraVirtualView")


class FootfallLineConfig(Base):
    """
    进入/离开判定线配置（用于跨电脑共享）。

    目前前端一次只允许对某个 virtual_view_id 配置一条线，因此用 (floor_plan_id, virtual_view_id)
    做唯一约束进行 upsert。
    """

    __tablename__ = "footfall_line_configs"
    __table_args__ = (
        UniqueConstraint("floor_plan_id", "virtual_view_id", name="uq_footfall_line_cfg_fp_vv"),
    )

    id = Column(Integer, primary_key=True, index=True)

    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True
    )

    # 判定线使用虚拟视窗 UV 空间归一化坐标（0..1）
    p1_u = Column(Float, nullable=False)
    p1_v = Column(Float, nullable=False)
    p2_u = Column(Float, nullable=False)
    p2_v = Column(Float, nullable=False)

    # 同一条线在平面图 UV 空间（0..1）的位置，用于绘制/校准（可选）
    floor_p1_x = Column(Float, nullable=True)
    floor_p1_y = Column(Float, nullable=True)
    floor_p2_x = Column(Float, nullable=True)
    floor_p2_y = Column(Float, nullable=True)

    in_label = Column(String(32), nullable=False, default="进入")
    out_label = Column(String(32), nullable=False, default="离开")
    enabled = Column(Boolean, nullable=False, default=True)


class FootfallCrossEvent(Base):
    """
    进入/离开计数触发事件（用于跨电脑累计统计）。
    """

    __tablename__ = "footfall_cross_events"

    id = Column(Integer, primary_key=True, index=True)

    line_config_id = Column(
        Integer, ForeignKey("footfall_line_configs.id"), nullable=False, index=True
    )
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True
    )

    direction = Column(String(8), nullable=False, index=True)  # "in" | "out"
    ts = Column(Float, nullable=False, index=True)

    track_id = Column(Integer, nullable=True, index=True)
    stable_id = Column(Integer, nullable=True, index=True)

    # foot origin point in UV space (optional)
    foot_u = Column(Float, nullable=True)
    foot_v = Column(Float, nullable=True)

    # only meaningful when direction == "in"
    gender = Column(String(16), nullable=True)
    age_bucket = Column(String(16), nullable=True)


class FootfallFaceCapture(Base):
    """
    人脸抓拍落库（仅进入方向）。
    用于按日期查询并在前端展示抓拍图 + 性别/年龄。
    """

    __tablename__ = "footfall_face_captures"

    id = Column(Integer, primary_key=True, index=True)

    line_config_id = Column(
        Integer, ForeignKey("footfall_line_configs.id"), nullable=False, index=True
    )
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True
    )

    ts = Column(Float, nullable=False, index=True)
    track_id = Column(Integer, nullable=True, index=True)
    stable_id = Column(Integer, nullable=True, index=True)
    gender = Column(String(16), nullable=True)
    age_bucket = Column(String(16), nullable=True)
    image_path = Column(Text, nullable=True)
    image_base64 = Column(Text, nullable=False)


class QueueWaitRoiConfig(Base):
    """
    排队 / 服务区 ROI（虚拟视窗 UV 归一化四边形，JSON 存 4 个顶点）。
    与人流量判定线类似，按 (floor_plan_id, virtual_view_id) 唯一。
    """

    __tablename__ = "queue_wait_roi_configs"
    __table_args__ = (
        UniqueConstraint("floor_plan_id", "virtual_view_id", name="uq_queue_wait_roi_fp_vv"),
    )

    id = Column(Integer, primary_key=True, index=True)
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True
    )
    queue_quad_json = Column(Text, nullable=False, default="[]")
    service_quad_json = Column(Text, nullable=False, default="[]")


class QueueWaitVisit(Base):
    """
    单次排队/服务停留闭环记录（结束时刻落库）。
    queue_seconds：在排队 ROI 内累计时长；service_seconds：在服务区 ROI 内时长（未进入则为空）。
    弃单：曾排队（queue_seconds>0）且未产生服务时长（service_seconds 为空）的闭环，表示离开排队区而未进入服务区。
    """

    __tablename__ = "queue_wait_visits"

    id = Column(Integer, primary_key=True, index=True)
    roi_config_id = Column(
        Integer, ForeignKey("queue_wait_roi_configs.id"), nullable=False, index=True
    )
    floor_plan_id = Column(Integer, ForeignKey("floor_plans.id"), nullable=False, index=True)
    virtual_view_id = Column(
        Integer, ForeignKey("camera_virtual_views.id"), nullable=False, index=True
    )
    track_id = Column(Integer, nullable=True, index=True)
    queue_seconds = Column(Float, nullable=False)
    service_seconds = Column(Float, nullable=True)
    end_ts = Column(Float, nullable=False, index=True)


class AppSetting(Base):
    """
    通用系统设置（key/value），用于持久化系统配置项。
    """

    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(128), nullable=False, unique=True, index=True)
    value = Column(Text, nullable=False, default="")

