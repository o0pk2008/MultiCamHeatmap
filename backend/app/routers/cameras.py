from typing import List

import json
import time

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db, SessionLocal
from ..panorama import equirect_to_perspective
from ..virtual_view_inference import manager

# 摄像头基础管理路由：
# - 负责维护摄像头的元信息（名称 / RTSP URL / 启用状态）。
# - 不直接关心平面图映射，映射由 mappings 路由负责。

router = APIRouter(prefix="/api/cameras", tags=["cameras"])

# 避免浏览器在 SPA 内切换 MJPEG URL 时复用空白/陈旧缓存，导致 analyzed 长时间黑屏
_MJPEG_NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}


def _apply_native_crop(frame, crop_x1=None, crop_y1=None, crop_x2=None, crop_y2=None) -> any:
    try:
        h, w = frame.shape[:2]
    except Exception:
        return frame
    x1 = int(crop_x1 or 0)
    y1 = int(crop_y1 or 0)
    x2_raw = crop_x2
    y2_raw = crop_y2
    x2 = int(x2_raw) if x2_raw is not None else w
    y2 = int(y2_raw) if y2_raw is not None else h
    x1 = max(0, min(x1, w - 1))
    y1 = max(0, min(y1, h - 1))
    x2 = max(x1 + 1, min(x2, w))
    y2 = max(y1 + 1, min(y2, h))
    try:
        crop = frame[y1:y2, x1:x2]
        if crop is None or getattr(crop, "size", 0) == 0:
            return frame
        return crop
    except Exception:
        return frame


#
# NOTE
# - equirect->perspective 逻辑已提取到 app/panorama.py，便于复用到后台推理任务中。
#


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
                "view_mode": str(getattr(view, "view_mode", "panorama_perspective") or "panorama_perspective"),
                "yaw_deg": view.yaw_deg,
                "pitch_deg": view.pitch_deg,
                "fov_deg": view.fov_deg,
                "out_w": view.out_w,
                "out_h": view.out_h,
                "crop_x1": view.crop_x1,
                "crop_y1": view.crop_y1,
                "crop_x2": view.crop_x2,
                "crop_y2": view.crop_y2,
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
    old_out_w = int(getattr(view, "out_w", 0) or 0)
    old_out_h = int(getattr(view, "out_h", 0) or 0)
    for k, v in data.items():
        setattr(view, k, v)

    # 兼容性修复：当输出分辨率变化时，按比例缩放已保存的 virtual grid 四边形，
    # 避免“绑定映射”里网格区域在画面中错位。
    new_out_w = int(getattr(view, "out_w", 0) or 0)
    new_out_h = int(getattr(view, "out_h", 0) or 0)
    if (
        old_out_w > 0
        and old_out_h > 0
        and new_out_w > 0
        and new_out_h > 0
        and (new_out_w != old_out_w or new_out_h != old_out_h)
    ):
        cfg = (
            db.query(models.CameraVirtualViewGridConfig)
            .filter(models.CameraVirtualViewGridConfig.virtual_view_id == view_id)
            .first()
        )
        if cfg and cfg.polygon_json:
            try:
                raw = json.loads(cfg.polygon_json or "[]")
                if isinstance(raw, list) and len(raw) == 4:
                    max_x = 0.0
                    max_y = 0.0
                    for p in raw:
                        x = float(p.get("x"))
                        y = float(p.get("y"))
                        max_x = max(max_x, x)
                        max_y = max(max_y, y)
                    # 仅对“像素坐标”做缩放；若是 0..1 归一化数据则跳过
                    if max_x > 1.5 or max_y > 1.5:
                        sx = float(new_out_w) / float(old_out_w)
                        sy = float(new_out_h) / float(old_out_h)
                        scaled = []
                        for p in raw:
                            x = float(p.get("x"))
                            y = float(p.get("y"))
                            scaled.append({"x": x * sx, "y": y * sy})
                        cfg.polygon_json = json.dumps(scaled, ensure_ascii=False)
            except Exception:
                pass

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
        """
        注意：此 endpoint 是“每请求一条 RTSP + MJPEG”。
        为降低“客户端慢导致读帧/编码被拖慢 -> 延迟累积”的风险，这里使用：
        - 读帧线程：持续读 RTSP，并覆盖写入一个有界(=1)的“最新帧”缓存（满时丢旧）
        - 输出线程：按目标 FPS 从缓存取最新帧编码并 yield
        """
        import threading
        import queue

        cap = cv2.VideoCapture(cam.rtsp_url)
        # 尝试降低缓冲延迟（不同 backend 支持程度不同）
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        latest_q: "queue.Queue[any]" = queue.Queue(maxsize=1)
        stop = threading.Event()
        last_ok = time.time()

        boundary = b"--frame"
        last_jpeg_ts = 0.0
        # 预览输出限帧：避免前端/网络压力导致延迟与资源消耗放大
        try:
            target_fps = float(os.environ.get("VV_PREVIEW_FPS", "10.0"))
        except Exception:
            target_fps = 10.0
        target_fps = max(0.2, min(30.0, float(target_fps)))
        last_emit_ts = 0.0
        # 定期热加载最新参数（避免前端必须强制重连才能看到保存后的画面）
        last_reload = 0.0
        enabled = view.enabled
        view_mode = str(getattr(view, "view_mode", "panorama_perspective") or "panorama_perspective")
        yaw_deg = view.yaw_deg
        pitch_deg = view.pitch_deg
        fov_deg = view.fov_deg
        out_w = view.out_w
        out_h = view.out_h
        crop_x1 = getattr(view, "crop_x1", None)
        crop_y1 = getattr(view, "crop_y1", None)
        crop_x2 = getattr(view, "crop_x2", None)
        crop_y2 = getattr(view, "crop_y2", None)

        def reader_loop():
            nonlocal last_ok
            try:
                while not stop.is_set():
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        # RTSP 抖动时短暂等待重试；超过 5s 认为断流
                        if time.time() - last_ok > 5:
                            break
                        time.sleep(0.02)
                        continue
                    last_ok = time.time()
                    # 覆盖写入“最新帧”（满了丢旧）
                    try:
                        latest_q.put_nowait(frame)
                    except queue.Full:
                        try:
                            _ = latest_q.get_nowait()
                        except Exception:
                            pass
                        try:
                            latest_q.put_nowait(frame)
                        except Exception:
                            pass
                    time.sleep(0.001)
            except Exception:
                return

        t = threading.Thread(target=reader_loop, name=f"vv-preview-reader-{camera_id}-{view_id}", daemon=True)
        t.start()
        try:
            while True:
                now = time.time()
                if now - last_reload >= 1.0:
                    last_reload = now
                    try:
                        with SessionLocal() as db2:
                            v2 = (
                                db2.query(models.CameraVirtualView)
                                .filter(
                                    models.CameraVirtualView.id == view_id,
                                    models.CameraVirtualView.camera_id == camera_id,
                                )
                                .first()
                            )
                            if v2 is not None:
                                enabled = bool(v2.enabled)
                                view_mode = str(getattr(v2, "view_mode", "panorama_perspective") or "panorama_perspective")
                                yaw_deg = float(v2.yaw_deg)
                                pitch_deg = float(v2.pitch_deg)
                                fov_deg = float(v2.fov_deg)
                                out_w = int(v2.out_w)
                                out_h = int(v2.out_h)
                                crop_x1 = getattr(v2, "crop_x1", None)
                                crop_y1 = getattr(v2, "crop_y1", None)
                                crop_x2 = getattr(v2, "crop_x2", None)
                                crop_y2 = getattr(v2, "crop_y2", None)
                    except Exception:
                        pass
                # 限帧：输出线程不需要每次循环都编码
                if (now - last_emit_ts) < (1.0 / max(0.1, target_fps)):
                    time.sleep(0.005)
                    continue

                try:
                    frame = latest_q.get(timeout=0.5)
                except Exception:
                    # reader 可能断流/卡住，给出超时退出条件
                    if time.time() - last_ok > 5:
                        break
                    continue
                last_emit_ts = time.time()

                if not enabled:
                    persp = frame
                else:
                    if view_mode == "native_resize":
                        try:
                            src = _apply_native_crop(frame, crop_x1, crop_y1, crop_x2, crop_y2)
                            persp = cv2.resize(src, (int(max(1, out_w)), int(max(1, out_h))))
                        except Exception:
                            persp = frame
                    else:
                        persp = equirect_to_perspective(
                            frame,
                            yaw_deg=yaw_deg,
                            pitch_deg=pitch_deg,
                            fov_deg=fov_deg,
                            out_w=out_w,
                            out_h=out_h,
                        )

                # 同一帧避免重复编码（极端情况下队列里重复值/时间相同）
                if last_jpeg_ts == last_emit_ts:
                    time.sleep(0.005)
                    continue
                last_jpeg_ts = last_emit_ts

                ok2, jpg = cv2.imencode(".jpg", persp, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok2:
                    continue
                data = jpg.tobytes()
                yield boundary + b"\r\n"
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(data)}\r\n\r\n".encode("utf-8")
                yield data + b"\r\n"
        finally:
            try:
                stop.set()
            except Exception:
                pass
            cap.release()

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers=_MJPEG_NO_CACHE_HEADERS,
    )


@router.get("/{camera_id}/virtual-views/{view_id}/preview_shared.mjpeg")
def preview_shared_virtual_view_mjpeg(camera_id: int, view_id: int, db: Session = Depends(get_db)):
    """
    plain preview：复用 VirtualViewInferenceManager 的“最新帧缓存”，不做 YOLO inference。
    用于避免 virtual PTZ 配置/热力图预览切换时触发 RTSP 冷启动。
    """
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

    try:
        manager.ensure_running_plain(view_id)
    except Exception:
        pass

    def gen():
        boundary = b"--frame"
        manager.add_plain_subscriber(view_id)
        last_ts = 0.0
        try:
            while True:
                frame = manager.get_latest_plain(view_id)
                if frame is None:
                    time.sleep(0.05)
                    continue
                if frame.ts <= last_ts:
                    time.sleep(0.02)
                    continue
                last_ts = frame.ts
                data = frame.jpeg
                yield boundary + b"\r\n"
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(data)}\r\n\r\n".encode("utf-8")
                yield data + b"\r\n"
                time.sleep(0.01)
        finally:
            manager.remove_plain_subscriber(view_id)

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers=_MJPEG_NO_CACHE_HEADERS,
    )


@router.get("/{camera_id}/virtual-views/{view_id}/snapshot.jpg")
def snapshot_virtual_view(camera_id: int, view_id: int, db: Session = Depends(get_db)):
    """
    返回单张 JPEG 快照（短连接），用于卡片缩略图轮询刷新。
    复用 VirtualViewInferenceManager 的最新缓存帧（plain 模式，不做 YOLO）。
    """
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

    try:
        manager.ensure_running_plain(view_id)
    except Exception:
        pass

    # 尝试短暂等待首帧，避免刚创建时拿不到缓存导致缩略图空白
    jpg = None
    for _ in range(20):  # up to ~1s
        fr = manager.get_latest_plain(view_id)
        if fr is not None and fr.jpeg:
            jpg = fr.jpeg
            break
        time.sleep(0.05)

    if not jpg:
        return Response(status_code=204)
    return Response(content=jpg, media_type="image/jpeg")


@router.get("/{camera_id}/virtual-views/{view_id}/source-size")
def get_virtual_view_source_size(camera_id: int, view_id: int, db: Session = Depends(get_db)):
    """
    返回原始 RTSP 输入帧尺寸（未做 virtual PTZ 处理）。
    用于前端把点选坐标回投到原始画面坐标系。
    """
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

    cap = cv2.VideoCapture(cam.rtsp_url)
    try:
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        ok, frame = cap.read()
        if ok and frame is not None:
            h, w = frame.shape[:2]
            return {"width": int(w), "height": int(h)}

        # 读帧失败时，尝试从 CAP_PROP 取尺寸
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if w > 0 and h > 0:
            return {"width": w, "height": h}
        raise HTTPException(status_code=502, detail="Failed to read source frame size")
    finally:
        try:
            cap.release()
        except Exception:
            pass


@router.get("/{camera_id}/virtual-views/{view_id}/analyzed.mjpeg")
def analyzed_virtual_view_mjpeg(camera_id: int, view_id: int, db: Session = Depends(get_db)):
    """
    预留给“带检测框”的 virtual PTZ 视图。
    当前版本先复用 preview.mjpeg 的逻辑，后续会在这里叠加 YOLO 检测框。
    """
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

    # 先确保后台任务已启动（线程常驻，不会阻塞当前请求）
    try:
        manager.ensure_running(view_id)
    except Exception:
        pass

    def gen():
        boundary = b"--frame"
        manager.add_subscriber(view_id)
        last_ts = 0.0
        try:
            while True:
                ann = manager.get_latest_annotated(view_id)
                plain = manager.get_latest_plain(view_id)
                if ann is None:
                    frame = plain
                elif plain is None:
                    frame = ann
                else:
                    # 取较新的一层，避免 annotated 短暂落后时画面卡住
                    frame = ann if ann.ts >= plain.ts else plain
                if frame is None:
                    time.sleep(0.05)
                    continue
                # 如果没有新帧就短睡，避免重复发送造成高延迟感
                if frame.ts <= last_ts:
                    time.sleep(0.02)
                    continue
                last_ts = frame.ts
                data = frame.jpeg
                yield boundary + b"\r\n"
                yield b"Content-Type: image/jpeg\r\n"
                yield f"Content-Length: {len(data)}\r\n\r\n".encode("utf-8")
                yield data + b"\r\n"
                time.sleep(0.01)
        finally:
            manager.remove_subscriber(view_id)

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers=_MJPEG_NO_CACHE_HEADERS,
    )


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


@router.post(
    "/virtual-views/{view_id}/cell-mappings/auto-anchors",
    response_model=schemas.AutoAnchorResponse,
)
def auto_map_by_anchors(
    view_id: int,
    payload: schemas.AutoAnchorRequest,
    db: Session = Depends(get_db),
) -> schemas.AutoAnchorResponse:
    """
    基于 4 对锚点（camera_grid <-> floor_grid）计算单应，并批量生成相机格到平面格的映射。
    - 仅处理当前 virtual_view_id 与指定 floor_plan_id
    - 冲突策略：默认跳过；可选择覆盖（删除冲突项后写入）
    """
    view = db.query(models.CameraVirtualView).filter(models.CameraVirtualView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Virtual view not found")
    fp = db.query(models.FloorPlan).filter(models.FloorPlan.id == payload.floor_plan_id).first()
    if not fp:
        raise HTTPException(status_code=404, detail="Floor plan not found")
    cfg = (
        db.query(models.CameraVirtualViewGridConfig)
        .filter(models.CameraVirtualViewGridConfig.virtual_view_id == view_id)
        .first()
    )
    if not cfg:
        raise HTTPException(status_code=400, detail="Grid config not found for this virtual view")
    if not payload.anchors or len(payload.anchors) < 4:
        raise HTTPException(status_code=400, detail="At least 4 anchor pairs are required")

    # 取前 4 对锚点，使用格子中心点坐标拟合单应（列为 x，行为 y）
    src = []
    dst = []
    for a in payload.anchors[:4]:
        src.append([float(a.camera_col) + 0.5, float(a.camera_row) + 0.5])
        dst.append([float(a.floor_col) + 0.5, float(a.floor_row) + 0.5])
    src_m = np.array(src, dtype=np.float32)
    dst_m = np.array(dst, dtype=np.float32)
    try:
        H = cv2.getPerspectiveTransform(src_m, dst_m)
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to compute homography with provided anchors")

    rows_cam = int(max(1, cfg.grid_rows or 1))
    cols_cam = int(max(1, cfg.grid_cols or 1))
    rows_fp = int(max(1, fp.grid_rows or 1))
    cols_fp = int(max(1, fp.grid_cols or 1))

    # 预读现有映射，便于 O(1) 检查
    existing_rows = (
        db.query(models.VirtualViewCellMapping)
        .filter(
            models.VirtualViewCellMapping.virtual_view_id == view_id,
            models.VirtualViewCellMapping.floor_plan_id == payload.floor_plan_id,
        )
        .all()
    )
    by_cam = {(m.camera_row, m.camera_col): m for m in existing_rows}
    by_floor = {(m.floor_row, m.floor_col): m for m in existing_rows}

    applied = 0
    skipped = 0
    conflicts = 0

    def map_point(col: float, row: float) -> (int, int):
        p = np.array([col, row, 1.0], dtype=np.float32)
        uvw = H @ p
        w = float(uvw[2]) if abs(float(uvw[2])) > 1e-6 else 1e-6
        x = float(uvw[0]) / w
        y = float(uvw[1]) / w
        fc = int(round(x - 0.5))
        fr = int(round(y - 0.5))
        return fr, fc

    for r in range(rows_cam):
        for c in range(cols_cam):
            fr, fc = map_point(float(c) + 0.5, float(r) + 0.5)
            if fr < 0 or fr >= rows_fp or fc < 0 or fc >= cols_fp:
                skipped += 1
                continue
            cam_key = (r, c)
            floor_key = (fr, fc)

            conflict_m = by_floor.get(floor_key)
            if conflict_m and (conflict_m.camera_row, conflict_m.camera_col) != cam_key:
                # 冲突：该平面格已被别的相机格占用
                if payload.overwrite_conflict:
                    # 删除冲突映射
                    db.delete(conflict_m)
                    db.flush()
                    by_cam.pop((conflict_m.camera_row, conflict_m.camera_col), None)
                    by_floor.pop(floor_key, None)
                else:
                    conflicts += 1
                    skipped += 1
                    continue

            m = by_cam.get(cam_key)
            if not m:
                m = models.VirtualViewCellMapping(
                    virtual_view_id=view_id,
                    floor_plan_id=payload.floor_plan_id,
                    camera_row=r,
                    camera_col=c,
                    floor_row=fr,
                    floor_col=fc,
                )
                db.add(m)
                by_cam[cam_key] = m
                by_floor[floor_key] = m
                applied += 1
            else:
                # 如果目标未变则跳过
                if m.floor_row == fr and m.floor_col == fc:
                    skipped += 1
                else:
                    # 更新为新目标
                    # 先清理旧的 floor_key 占用
                    old_key = (m.floor_row, m.floor_col)
                    if old_key in by_floor:
                        by_floor.pop(old_key, None)
                    m.floor_row = fr
                    m.floor_col = fc
                    by_floor[floor_key] = m
                    applied += 1

    db.commit()
    return schemas.AutoAnchorResponse(applied=applied, skipped=skipped, conflicts=conflicts)
