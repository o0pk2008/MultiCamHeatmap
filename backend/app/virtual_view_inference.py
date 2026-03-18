import time
import threading
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, Any

import cv2

from .db import SessionLocal
from . import models
from .panorama import equirect_to_perspective

try:
    from ultralytics import YOLO  # type: ignore
except Exception:  # pragma: no cover
    YOLO = None  # type: ignore

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore


@dataclass
class VirtualViewFrame:
    jpeg: bytes
    ts: float


@dataclass
class VirtualViewDetections:
    """
    最近一次推理的检测框（xyxy + cls），以及对应图像尺寸与时间戳。
    """
    xyxy: Any  # numpy array
    cls: Any   # numpy array
    w: int
    h: int
    ts: float


class VirtualViewInferenceManager:
    """
    目标：
    - 每个 virtual_view_id 只拉一次 RTSP，只推理一次 YOLO
    - 多个 analyzed.mjpeg 客户端共享同一份“最新已分析帧”
    """

    def __init__(self) -> None:
        self._threads: Dict[int, threading.Thread] = {}
        self._stops: Dict[int, threading.Event] = {}
        self._latest: Dict[int, VirtualViewFrame] = {}
        self._detections: Dict[int, VirtualViewDetections] = {}
        self._subscribers: Dict[int, int] = {}
        self._lock = threading.Lock()
        self._model = None

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        if YOLO is None:
            return
        # 默认 COCO 轻量模型（自动下载一次）
        self._model = YOLO("yolov8n.pt")
        # 显式切到 GPU（在部分环境中 ultralytics 默认不会自动选择 cuda）
        try:
            if torch is not None and torch.cuda.is_available():
                self._model.to("cuda:0")
        except Exception:
            pass

    def ensure_running(self, virtual_view_id: int) -> None:
        with self._lock:
            existing = self._threads.get(virtual_view_id)
            if existing is not None and existing.is_alive():
                return
            # 如果线程已存在但已退出，先清理再重启
            if existing is not None and not existing.is_alive():
                self._threads.pop(virtual_view_id, None)
                ev = self._stops.pop(virtual_view_id, None)
                if ev is not None:
                    try:
                        ev.set()
                    except Exception:
                        pass
            ev = threading.Event()
            t = threading.Thread(
                target=self._run_view_loop,
                args=(virtual_view_id, ev),
                name=f"vv-infer-{virtual_view_id}",
                daemon=True,
            )
            self._stops[virtual_view_id] = ev
            self._threads[virtual_view_id] = t
            t.start()

    def stop(self, virtual_view_id: int) -> None:
        with self._lock:
            ev = self._stops.pop(virtual_view_id, None)
            if ev is not None:
                ev.set()
            self._threads.pop(virtual_view_id, None)
            self._latest.pop(virtual_view_id, None)
            self._subscribers.pop(virtual_view_id, None)

    def add_subscriber(self, virtual_view_id: int) -> None:
        with self._lock:
            self._subscribers[virtual_view_id] = self._subscribers.get(virtual_view_id, 0) + 1

    def remove_subscriber(self, virtual_view_id: int) -> None:
        with self._lock:
            cur = self._subscribers.get(virtual_view_id, 0)
            cur = cur - 1
            if cur <= 0:
                self._subscribers.pop(virtual_view_id, None)
            else:
                self._subscribers[virtual_view_id] = cur

    def subscriber_count(self, virtual_view_id: int) -> int:
        with self._lock:
            return int(self._subscribers.get(virtual_view_id, 0))

    def get_latest(self, virtual_view_id: int) -> Optional[VirtualViewFrame]:
        return self._latest.get(virtual_view_id)

    def get_latest_detections(self, virtual_view_id: int) -> Optional[VirtualViewDetections]:
        return self._detections.get(virtual_view_id)

    def _load_view(self, virtual_view_id: int) -> Optional[Tuple[str, models.CameraVirtualView]]:
        with SessionLocal() as db:
            view = (
                db.query(models.CameraVirtualView)
                .filter(models.CameraVirtualView.id == virtual_view_id)
                .first()
            )
            if not view:
                return None
            cam = db.query(models.Camera).filter(models.Camera.id == view.camera_id).first()
            if not cam:
                return None
            return cam.rtsp_url, view

    def _reload_view_params(self, virtual_view_id: int) -> Optional[Tuple[str, dict]]:
        """
        热加载 view 参数：用于不中断流的情况下应用最新 yaw/pitch/fov/out_w/out_h/enabled。
        返回 (rtsp_url, params_dict)。
        """
        with SessionLocal() as db:
            view = (
                db.query(models.CameraVirtualView)
                .filter(models.CameraVirtualView.id == virtual_view_id)
                .first()
            )
            if not view:
                return None
            cam = db.query(models.Camera).filter(models.Camera.id == view.camera_id).first()
            if not cam:
                return None
            return cam.rtsp_url, {
                "enabled": bool(view.enabled),
                "yaw_deg": float(view.yaw_deg),
                "pitch_deg": float(view.pitch_deg),
                "fov_deg": float(view.fov_deg),
                "out_w": int(view.out_w),
                "out_h": int(view.out_h),
            }

    def _run_view_loop(self, virtual_view_id: int, stop_event: threading.Event) -> None:
        """
        后台常驻：拉流 -> 透视 -> YOLO(限帧) -> 叠框 -> JPEG(限帧) -> 写入最新帧
        """
        analyze_fps = 6.0    # 推理频率（一直运行，便于历史统计）
        stream_fps = 10.0   # 有人观看时输出 MJPEG 刷新频率
        idle_stream_fps = 1.0  # 无人观看时仍保留低频编码，避免最新帧长期不更新

        last_infer_ts = 0.0
        last_emit_ts = 0.0
        last_boxes = None  # (xyxy, cls)

        self._ensure_model()

        loaded = self._load_view(virtual_view_id)
        if not loaded:
            return
        rtsp_url, view = loaded
        enabled = bool(view.enabled)
        yaw_deg = float(view.yaw_deg)
        pitch_deg = float(view.pitch_deg)
        fov_deg = float(view.fov_deg)
        out_w = int(view.out_w)
        out_h = int(view.out_h)
        last_reload = 0.0

        cap = None
        last_ok_ts = time.time()
        try:
            while not stop_event.is_set():
                now = time.time()
                # 每 1 秒热加载一次参数；若 RTSP 地址变化则重连
                if now - last_reload >= 1.0:
                    last_reload = now
                    try:
                        reloaded = self._reload_view_params(virtual_view_id)
                        if reloaded is not None:
                            new_rtsp, p = reloaded
                            enabled = bool(p["enabled"])
                            yaw_deg = float(p["yaw_deg"])
                            pitch_deg = float(p["pitch_deg"])
                            fov_deg = float(p["fov_deg"])
                            out_w = int(p["out_w"])
                            out_h = int(p["out_h"])
                            if new_rtsp and new_rtsp != rtsp_url:
                                rtsp_url = new_rtsp
                                try:
                                    if cap is not None:
                                        cap.release()
                                except Exception:
                                    pass
                                cap = None
                    except Exception:
                        pass

                if cap is None or not cap.isOpened():
                    if cap is not None:
                        try:
                            cap.release()
                        except Exception:
                            pass
                    cap = cv2.VideoCapture(rtsp_url)
                    try:
                        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    except Exception:
                        pass
                    time.sleep(0.05)

                ok, frame = cap.read() if cap is not None else (False, None)
                if not ok or frame is None:
                    # 如果长时间读不到帧，重连
                    if time.time() - last_ok_ts > 5:
                        try:
                            if cap is not None:
                                cap.release()
                        except Exception:
                            pass
                        cap = None
                        last_ok_ts = time.time()
                        time.sleep(0.2)
                    else:
                        time.sleep(0.02)
                    continue
                last_ok_ts = time.time()

                # 只对 virtual PTZ 透视图做处理
                if not enabled:
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

                now = time.time()

                # 1) YOLO 推理（限帧）
                if self._model is not None and (now - last_infer_ts) >= (1.0 / analyze_fps):
                    last_infer_ts = now
                    try:
                        results = self._model(persp, verbose=False)
                        if results and len(results) > 0:
                            res = results[0]
                            boxes = res.boxes
                            if boxes is not None:
                                cls_ids = boxes.cls.cpu().numpy() if hasattr(boxes, "cls") else None
                                xyxy = boxes.xyxy.cpu().numpy() if hasattr(boxes, "xyxy") else None
                                if cls_ids is not None and xyxy is not None:
                                    last_boxes = (xyxy, cls_ids)
                                    try:
                                        h_img, w_img = persp.shape[:2]
                                        self._detections[virtual_view_id] = VirtualViewDetections(
                                            xyxy=xyxy,
                                            cls=cls_ids,
                                            w=int(w_img),
                                            h=int(h_img),
                                            ts=float(now),
                                        )
                                    except Exception:
                                        pass
                    except Exception:
                        # 推理失败就沿用上一帧的 boxes 或不画
                        pass

                # 2) 叠加检测框（使用 last_boxes，避免每帧都必须推理）
                if last_boxes is not None:
                    xyxy, cls_ids = last_boxes
                    for (x1, y1, x2, y2), cid in zip(xyxy, cls_ids):
                        if int(cid) != 0:  # person
                            continue
                        x1_i, y1_i, x2_i, y2_i = map(int, [x1, y1, x2, y2])
                        cv2.rectangle(persp, (x1_i, y1_i), (x2_i, y2_i), (0, 255, 0), 2)
                        cv2.putText(
                            persp,
                            "person",
                            (x1_i, max(y1_i - 5, 0)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.5,
                            (0, 255, 0),
                            1,
                            cv2.LINE_AA,
                        )

                # 3) 编码/发布（限帧）
                subs = self.subscriber_count(virtual_view_id)
                target_fps = stream_fps if subs > 0 else idle_stream_fps
                if (now - last_emit_ts) >= (1.0 / max(0.1, target_fps)):
                    last_emit_ts = now
                    ok2, jpg = cv2.imencode(".jpg", persp, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                    if ok2:
                        self._latest[virtual_view_id] = VirtualViewFrame(jpeg=jpg.tobytes(), ts=now)

                # 线程里稍微 sleep，避免 CPU 空转
                time.sleep(0.001)
        except Exception:
            # 线程异常退出时，避免整个服务崩溃
            return
        finally:
            try:
                if cap is not None:
                    cap.release()
            except Exception:
                pass


manager = VirtualViewInferenceManager()

