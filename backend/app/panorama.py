from typing import Dict, Tuple

import math

import cv2
import numpy as np

_remap_cache: Dict[Tuple[int, int, float, float, float, int, int], Tuple[np.ndarray, np.ndarray]] = {}


def build_equirect_to_perspective_map(
    in_w: int,
    in_h: int,
    yaw_deg: float,
    pitch_deg: float,
    fov_deg: float,
    out_w: int,
    out_h: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    构造等距柱状投影（equirectangular）到透视平面的 remap。
    约定：输入横轴为 yaw（-pi..pi），纵轴为 pitch/纬度（-pi/2..pi/2）。

    视场角说明：
    - 当前函数的 `fov_deg` 视为「水平视场角」(horizontal FOV)。
    - 垂直视场角会根据输出宽高比自动换算，避免非正方形输出时产生几何拉伸/扭曲。
    """
    key = (in_w, in_h, float(yaw_deg), float(pitch_deg), float(fov_deg), out_w, out_h)
    cached = _remap_cache.get(key)
    if cached is not None:
        return cached

    # Treat fov_deg as horizontal FOV, derive vertical FOV from aspect ratio.
    # Relationship: tan(fov_y/2) = (h/w) * tan(fov_x/2)
    fov_x = math.radians(fov_deg)
    aspect_ratio = out_w / max(1, out_h)
    # out_h/out_w is the inverse of aspect_ratio; use direct form for clarity.
    fov_y = 2.0 * math.atan((out_h / max(1, out_w)) * math.tan(fov_x / 2.0))
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)

    x = (np.linspace(0, out_w - 1, out_w) - (out_w - 1) / 2.0) / ((out_w - 1) / 2.0)
    y = (np.linspace(0, out_h - 1, out_h) - (out_h - 1) / 2.0) / ((out_h - 1) / 2.0)
    xx, yy = np.meshgrid(x, y)

    zz = np.ones_like(xx)
    xx = xx * math.tan(fov_x / 2.0)
    yy = -yy * math.tan(fov_y / 2.0)

    norm = np.sqrt(xx * xx + yy * yy + zz * zz)
    vx = xx / norm
    vy = yy / norm
    vz = zz / norm

    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)

    # pitch around x
    vy2 = vy * cp - vz * sp
    vz2 = vy * sp + vz * cp
    vx2 = vx

    # yaw around y
    vx3 = vx2 * cy + vz2 * sy
    vz3 = -vx2 * sy + vz2 * cy
    vy3 = vy2

    lon = np.arctan2(vx3, vz3)
    lat = np.arcsin(np.clip(vy3, -1.0, 1.0))

    map_x = (lon / (2 * math.pi) + 0.5) * (in_w - 1)
    map_y = (0.5 - lat / math.pi) * (in_h - 1)

    map_x = map_x.astype(np.float32)
    map_y = map_y.astype(np.float32)
    _remap_cache[key] = (map_x, map_y)
    return map_x, map_y


def equirect_to_perspective(
    frame_bgr: np.ndarray,
    yaw_deg: float,
    pitch_deg: float,
    fov_deg: float,
    out_w: int,
    out_h: int,
) -> np.ndarray:
    in_h, in_w = frame_bgr.shape[:2]
    map_x, map_y = build_equirect_to_perspective_map(
        in_w, in_h, yaw_deg, pitch_deg, fov_deg, out_w, out_h
    )
    return cv2.remap(
        frame_bgr,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_WRAP,
    )

