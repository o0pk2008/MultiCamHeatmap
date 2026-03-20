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
    ids: Any   # list[int] aligned with xyxy/cls; -1 means unknown (legacy)
    track_ids: Any  # list[int] aligned with xyxy/cls; -1 means unknown
    w: int
    h: int
    ts: float


class VirtualViewInferenceManager:
    """
    目标：
    - 每个 virtual_view_id 只拉一次 RTSP，只做透视重投影
    - plain preview / analyzed preview 共享同一份“最新帧缓存”
    - analyzed 模式才会加载 YOLO 并产出 detections（plain 模式不做 YOLO）
    """

    def __init__(self) -> None:
        self._threads: Dict[int, threading.Thread] = {}
        self._stops: Dict[int, threading.Event] = {}
        # plain: 不带检测框（用于 preview_shared / snapshot）
        self._latest_plain: Dict[int, VirtualViewFrame] = {}
        # annotated: 带检测框（用于 analyzed）
        self._latest_annotated: Dict[int, VirtualViewFrame] = {}
        self._detections: Dict[int, VirtualViewDetections] = {}
        self._plain_subscribers: Dict[int, int] = {}
        self._analyzed_subscribers: Dict[int, int] = {}
        # 是否需要在该 virtual_view_id 上进行 YOLO 推理
        self._inference_enabled: Dict[int, bool] = {}
        # 推理引用计数（例如 heatmap analyzer 运行时需要推理，即使没有 analyzed 订阅者）
        self._inference_refs: Dict[int, int] = {}
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
        """
        analyzed 模式：确保后台推理线程在跑，并允许 YOLO inference。
        """
        with self._lock:
            # 一旦进入 analyzed，推理就开启（不自动关闭，避免来回切换导致频繁加载/抖动）
            self._inference_enabled[virtual_view_id] = True

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

    def ensure_running_plain(self, virtual_view_id: int) -> None:
        """
        plain preview 模式：确保后台线程在跑，但不做 YOLO inference（除非之后被 analyzed 打开）。
        """
        with self._lock:
            # 不要覆盖 analyzed 已开启的推理状态
            cur = bool(self._inference_enabled.get(virtual_view_id, False))
            self._inference_enabled[virtual_view_id] = cur

            existing = self._threads.get(virtual_view_id)
            if existing is not None and existing.is_alive():
                return

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
                name=f"vv-plain-{virtual_view_id}",
                daemon=True,
            )
            self._stops[virtual_view_id] = ev
            self._threads[virtual_view_id] = t
            t.start()

    def acquire_inference(self, virtual_view_id: int) -> None:
        """增加推理引用：用于热力分析等后台逻辑。"""
        with self._lock:
            self._inference_refs[virtual_view_id] = self._inference_refs.get(virtual_view_id, 0) + 1
            self._inference_enabled[virtual_view_id] = True
        # 确保线程在跑
        self.ensure_running(virtual_view_id)

    def release_inference(self, virtual_view_id: int) -> None:
        """释放推理引用：当没有引用且没有 analyzed 订阅者时，关闭推理（plain 预览仍可继续）。"""
        with self._lock:
            cur = int(self._inference_refs.get(virtual_view_id, 0)) - 1
            if cur <= 0:
                self._inference_refs.pop(virtual_view_id, None)
            else:
                self._inference_refs[virtual_view_id] = cur
            refs = int(self._inference_refs.get(virtual_view_id, 0))
            analyzed_subs = int(self._analyzed_subscribers.get(virtual_view_id, 0))
            if refs <= 0 and analyzed_subs <= 0:
                self._inference_enabled[virtual_view_id] = False

    def stop(self, virtual_view_id: int) -> None:
        with self._lock:
            ev = self._stops.pop(virtual_view_id, None)
            if ev is not None:
                ev.set()
            self._threads.pop(virtual_view_id, None)
            self._latest_plain.pop(virtual_view_id, None)
            self._latest_annotated.pop(virtual_view_id, None)
            self._plain_subscribers.pop(virtual_view_id, None)
            self._analyzed_subscribers.pop(virtual_view_id, None)
            self._inference_enabled.pop(virtual_view_id, None)
            self._inference_refs.pop(virtual_view_id, None)

    def add_subscriber(self, virtual_view_id: int) -> None:
        # analyzed client 订阅计数（历史方法名保持不变）
        with self._lock:
            self._analyzed_subscribers[virtual_view_id] = self._analyzed_subscribers.get(virtual_view_id, 0) + 1

    def remove_subscriber(self, virtual_view_id: int) -> None:
        with self._lock:
            cur = self._analyzed_subscribers.get(virtual_view_id, 0)
            cur = cur - 1
            if cur <= 0:
                self._analyzed_subscribers.pop(virtual_view_id, None)
            else:
                self._analyzed_subscribers[virtual_view_id] = cur
            # 若没有 analyzed 订阅且没有后台引用，则关闭推理（避免停止分析后仍持续画框/推理）
            refs = int(self._inference_refs.get(virtual_view_id, 0))
            if int(self._analyzed_subscribers.get(virtual_view_id, 0)) <= 0 and refs <= 0:
                self._inference_enabled[virtual_view_id] = False

    def subscriber_count(self, virtual_view_id: int) -> int:
        # analyzed 订阅数（历史方法名保持不变）
        with self._lock:
            return int(self._analyzed_subscribers.get(virtual_view_id, 0))

    def add_plain_subscriber(self, virtual_view_id: int) -> None:
        with self._lock:
            self._plain_subscribers[virtual_view_id] = self._plain_subscribers.get(virtual_view_id, 0) + 1

    def remove_plain_subscriber(self, virtual_view_id: int) -> None:
        with self._lock:
            cur = self._plain_subscribers.get(virtual_view_id, 0) - 1
            if cur <= 0:
                self._plain_subscribers.pop(virtual_view_id, None)
            else:
                self._plain_subscribers[virtual_view_id] = cur

    def plain_subscriber_count(self, virtual_view_id: int) -> int:
        with self._lock:
            return int(self._plain_subscribers.get(virtual_view_id, 0))

    def subscriber_total_count(self, virtual_view_id: int) -> int:
        with self._lock:
            return int(self._plain_subscribers.get(virtual_view_id, 0) + self._analyzed_subscribers.get(virtual_view_id, 0))

    def get_latest_plain(self, virtual_view_id: int) -> Optional[VirtualViewFrame]:
        return self._latest_plain.get(virtual_view_id)

    def get_latest_annotated(self, virtual_view_id: int) -> Optional[VirtualViewFrame]:
        return self._latest_annotated.get(virtual_view_id)

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
        last_ids = None    # list[int]
        tracks: Dict[int, Tuple[float, float, float, int]] = {}
        next_track_id = 1

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
        last_infer_enabled_check = 0.0
        with self._lock:
            inference_enabled = bool(self._inference_enabled.get(virtual_view_id, False))

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

                if now - last_infer_enabled_check >= 0.2:
                    last_infer_enabled_check = now
                    with self._lock:
                        inference_enabled = bool(self._inference_enabled.get(virtual_view_id, False))
                    if not inference_enabled:
                        # plain 模式下不保留旧框，避免之后切换 analyzed 前“残留画框”
                        last_boxes = None
                        last_ids = None
                        tracks = {}
                        next_track_id = 1

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
                # plain 版本（不带框）
                plain_img = persp

                # 1) YOLO 推理（限帧）
                if inference_enabled:
                    # 只有在 analyzed 需要时才懒加载 YOLO
                    self._ensure_model()
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
                                        except Exception:
                                            h_img, w_img = (0, 0)
                                        ids = [-1 for _ in range(int(len(cls_ids)))]
                                        try:
                                            max_dist = max(25.0, 0.08 * float(max(w_img, h_img)))
                                            used_tracks = set()
                                            used_dets = set()
                                            person_idxs = []
                                            for i, cid in enumerate(cls_ids):
                                                try:
                                                    if int(cid) == 0:
                                                        person_idxs.append(int(i))
                                                except Exception:
                                                    continue
                                            person_idxs.sort(
                                                key=lambda i: float((xyxy[i][2] - xyxy[i][0]) * (xyxy[i][3] - xyxy[i][1])),
                                                reverse=True,
                                            )

                                            for i in person_idxs:
                                                if i in used_dets:
                                                    continue
                                                x1, y1, x2, y2 = xyxy[i]
                                                cx = float(x1 + x2) * 0.5
                                                cy = float(y1 + y2) * 0.5
                                                best_tid = None
                                                best_d2 = None
                                                for tid, (tx, ty, _ts, _miss) in tracks.items():
                                                    if tid in used_tracks:
                                                        continue
                                                    dx = float(tx) - cx
                                                    dy = float(ty) - cy
                                                    d2 = dx * dx + dy * dy
                                                    if best_d2 is None or d2 < best_d2:
                                                        best_d2 = d2
                                                        best_tid = int(tid)
                                                if best_tid is not None and best_d2 is not None and best_d2 <= (max_dist * max_dist):
                                                    ids[i] = int(best_tid)
                                                    used_tracks.add(int(best_tid))
                                                    used_dets.add(int(i))
                                                    tracks[int(best_tid)] = (cx, cy, float(now), 0)
                                                else:
                                                    tid = int(next_track_id)
                                                    next_track_id += 1
                                                    ids[i] = tid
                                                    used_tracks.add(tid)
                                                    used_dets.add(int(i))
                                                    tracks[tid] = (cx, cy, float(now), 0)

                                            next_tracks: Dict[int, Tuple[float, float, float, int]] = {}
                                            for tid, (tx, ty, ts0, miss) in tracks.items():
                                                if int(tid) in used_tracks:
                                                    next_tracks[int(tid)] = (float(tx), float(ty), float(ts0), 0)
                                                    continue
                                                miss2 = int(miss) + 1
                                                if miss2 > 3:
                                                    continue
                                                if float(now) - float(ts0) > 1.5:
                                                    continue
                                                next_tracks[int(tid)] = (float(tx), float(ty), float(ts0), miss2)
                                            tracks = next_tracks
                                        except Exception:
                                            pass
                                        last_ids = ids
                                        try:
                                            self._detections[virtual_view_id] = VirtualViewDetections(
                                                xyxy=xyxy,
                                                cls=cls_ids,
                                                ids=ids,
                                                track_ids=ids,
                                                w=int(w_img),
                                                h=int(h_img),
                                                ts=float(now),
                                            )
                                        except Exception:
                                            pass
                        except Exception:
                            # 推理失败就沿用上一轮的 boxes 或不画
                            pass

                # 2) 叠加检测框（使用 last_boxes，避免每帧都必须推理）
                annotated_img = plain_img
                if inference_enabled and last_boxes is not None:
                    # 在副本上画框，避免污染 plain 预览
                    try:
                        annotated_img = plain_img.copy()
                    except Exception:
                        annotated_img = plain_img
                    xyxy, cls_ids = last_boxes
                    for i, ((x1, y1, x2, y2), cid) in enumerate(zip(xyxy, cls_ids)):
                        if int(cid) != 0:  # person
                            continue
                        x1_i, y1_i, x2_i, y2_i = map(int, [x1, y1, x2, y2])
                        cv2.rectangle(annotated_img, (x1_i, y1_i), (x2_i, y2_i), (0, 255, 0), 2)
                        label = "person"
                        try:
                            if last_ids is not None and i < len(last_ids) and int(last_ids[i]) >= 0:
                                label = f"person#{int(last_ids[i])}"
                        except Exception:
                            label = "person"
                        cv2.putText(
                            annotated_img,
                            label,
                            (x1_i, max(y1_i - 5, 0)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.5,
                            (0, 255, 0),
                            1,
                            cv2.LINE_AA,
                        )

                # 3) 编码/发布（限帧）
                subs = self.subscriber_total_count(virtual_view_id)
                target_fps = stream_fps if subs > 0 else idle_stream_fps
                if (now - last_emit_ts) >= (1.0 / max(0.1, target_fps)):
                    last_emit_ts = now
                    ok_p, jpg_p = cv2.imencode(".jpg", plain_img, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                    if ok_p:
                        self._latest_plain[virtual_view_id] = VirtualViewFrame(jpeg=jpg_p.tobytes(), ts=now)
                    ok_a, jpg_a = cv2.imencode(".jpg", annotated_img, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                    if ok_a:
                        self._latest_annotated[virtual_view_id] = VirtualViewFrame(jpeg=jpg_a.tobytes(), ts=now)

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
