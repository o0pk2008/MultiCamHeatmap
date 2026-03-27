import os
import time
import threading
import re
import base64
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, Any

import cv2
import numpy as np

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

try:
    from uniface.detection import RetinaFace  # type: ignore
    from uniface.attribute.age_gender import AgeGender  # type: ignore
except Exception:  # pragma: no cover
    RetinaFace = None  # type: ignore
    AgeGender = None  # type: ignore


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
    # 与 xyxy/cls 对齐：用于业务侧统计（性别/年龄分桶）
    gender: Any  # list[str | None]
    age_bucket: Any  # list[str | None]


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
        # 来自 ultralytics 模型的 class_id -> class_name 映射（用于性别/年龄解析）
        self._cls_names: Dict[int, str] = {}
        # 前端目前使用的年龄分桶标签（用于匹配模型类别名）
        self._age_bucket_labels: Tuple[str, ...] = ("0-12", "18-25", "26-35", "36-45", "46-55", "55+")
        # 二阶段模型：基于每个 person 框做人脸->年龄/性别识别
        # - 性别模型：yolov8n-gender-classification.pt（可由 YOLO_GENDER_MODEL_PATH 覆盖）
        # - 年龄模型：yolo11n-face-age.pt（通常基于 face 进行年龄估计；这里直接对 person crop 推理，期望模型内部完成 face 提取/回归）
        self._gender_model = None
        self._age_parse_debug_once = False
        self._age_model_status_debug_once = False
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        default_gender_model_path = os.path.join(base_dir, "yolov8n-gender-classification.pt")
        gender_model_path = os.environ.get("YOLO_GENDER_MODEL_PATH") or default_gender_model_path
        if not os.path.isabs(gender_model_path) and not os.path.exists(gender_model_path):
            gender_model_path = os.path.join(base_dir, gender_model_path)
        self._gender_model_path = gender_model_path

        self._face_age_model = None
        default_face_age_model_path = os.path.join(base_dir, "yolo11n-face-age.pt")
        face_age_model_path = os.environ.get("YOLO_FACE_AGE_MODEL_PATH") or default_face_age_model_path
        if not os.path.isabs(face_age_model_path) and not os.path.exists(face_age_model_path):
            face_age_model_path = os.path.join(base_dir, face_age_model_path)
        self._face_age_model_path = face_age_model_path

        # face detector: 用于把 person crop -> face crop，再喂给 age model
        self._face_model = None
        default_face_model_path = os.path.join(base_dir, "yolov8n-face.pt")
        face_model_path = os.environ.get("YOLO_FACE_MODEL_PATH") or default_face_model_path
        if not os.path.isabs(face_model_path) and not os.path.exists(face_model_path):
            face_model_path = os.path.join(base_dir, face_model_path)
        self._face_model_path = face_model_path

        # track_id -> (gender, age_bucket, ts)
        self._ag_cache: Dict[int, Tuple[Optional[str], Optional[str], float]] = {}
        self._ag_cache_ttl_sec: float = float(os.environ.get("YOLO_AGE_GENDER_CACHE_TTL_SEC", "3.0"))
        # 年龄/性别算法提供者：uniface | yolo（默认使用 uniface）
        self._ag_provider: str = str(os.environ.get("AG_PROVIDER", "uniface")).strip().lower()
        self._ag_uniface_fallback_to_yolo: bool = str(
            os.environ.get("AG_UNIFACE_FALLBACK_TO_YOLO", "0")
        ).strip().lower() in ("1", "true", "yes", "on")
        # UniFace 相关模型
        self._uniface_detector = None
        self._uniface_age_gender = None
        self._uniface_infer_lock = threading.Lock()
        self._uniface_init_warned = False
        providers_raw = str(os.environ.get("UNIFACE_PROVIDERS", "CPUExecutionProvider")).strip()
        self._uniface_providers = [p.strip() for p in providers_raw.split(",") if p.strip()]
        if not self._uniface_providers:
            self._uniface_providers = ["CPUExecutionProvider"]
        self._uniface_face_min_conf: float = float(os.environ.get("UNIFACE_FACE_MIN_CONF", "0.2"))
        # 最近人脸抓拍（供前端可视化）
        self._face_captures_by_vv: Dict[int, list[Dict[str, Any]]] = {}
        self._face_capture_seq: int = 0
        self._face_capture_max: int = int(os.environ.get("YOLO_FACE_CAPTURE_MAX", "18"))
        self._face_capture_min_interval_sec: float = float(os.environ.get("YOLO_FACE_CAPTURE_MIN_INTERVAL_SEC", "1.2"))
        self._face_capture_last_ts: Dict[Tuple[int, int], float] = {}
        # (virtual_view_id, track_id) -> latest person crop + attrs
        self._track_attr_latest: Dict[Tuple[int, int], Dict[str, Any]] = {}
        # 去重：每次进入只抓拍一次（按稳定ID）
        self._enter_capture_seen: Dict[Tuple[int, int], float] = {}

        # 当前在后端用于 footfall 判定的直线（用于在 YOLO 画面里可视化对齐）
        # vv_id -> ((p1_u,p1_v),(p2_u,p2_v))
        self._footfall_line_uv_by_vv: Dict[int, Tuple[Tuple[float, float], Tuple[float, float]]] = {}
        # 是否在 analyzed 画面里绘制 footfall 判定线（系统设置开关）
        self._draw_footfall_line_overlay: bool = False
        # YOLO 框样式与颜色（系统设置）
        self._yolo_box_style: str = "corners_rounded"  # rect | corners_rounded
        self._yolo_box_color: str = "white"  # green | blue | white
        # YOLO 脚部点开关/样式/颜色（系统设置）
        self._yolo_foot_point_enabled: bool = False
        self._yolo_foot_point_style: str = "circle"  # circle | square
        self._yolo_foot_point_color: str = "green"  # green | blue | white

    def set_footfall_line_uv(
        self, virtual_view_id: int, p1_uv: Tuple[float, float], p2_uv: Tuple[float, float]
    ) -> None:
        with self._lock:
            self._footfall_line_uv_by_vv[int(virtual_view_id)] = (p1_uv, p2_uv)

    def clear_footfall_line_uv(self, virtual_view_id: int) -> None:
        with self._lock:
            self._footfall_line_uv_by_vv.pop(int(virtual_view_id), None)

    def set_draw_footfall_line_overlay(self, enabled: bool) -> None:
        with self._lock:
            self._draw_footfall_line_overlay = bool(enabled)

    def get_draw_footfall_line_overlay(self) -> bool:
        with self._lock:
            return bool(self._draw_footfall_line_overlay)

    def set_yolo_draw_config(
        self,
        box_style: Optional[str] = None,
        box_color: Optional[str] = None,
        foot_point_enabled: Optional[bool] = None,
        foot_point_style: Optional[str] = None,
        foot_point_color: Optional[str] = None,
    ) -> None:
        with self._lock:
            if box_style is not None:
                s = str(box_style).strip().lower()
                if s in ("rect", "corners_rounded"):
                    self._yolo_box_style = s
            if box_color is not None:
                c = str(box_color).strip().lower()
                if c in ("green", "blue", "white"):
                    self._yolo_box_color = c
            if foot_point_enabled is not None:
                self._yolo_foot_point_enabled = bool(foot_point_enabled)
            if foot_point_style is not None:
                s = str(foot_point_style).strip().lower()
                if s in ("circle", "square"):
                    self._yolo_foot_point_style = s
            if foot_point_color is not None:
                c = str(foot_point_color).strip().lower()
                if c in ("green", "blue", "white"):
                    self._yolo_foot_point_color = c

    def get_yolo_draw_config(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "box_style": str(self._yolo_box_style),
                "box_color": str(self._yolo_box_color),
                "foot_point_enabled": bool(self._yolo_foot_point_enabled),
                "foot_point_style": str(self._yolo_foot_point_style),
                "foot_point_color": str(self._yolo_foot_point_color),
            }

    @staticmethod
    def _named_bgr(color_name: str) -> Tuple[int, int, int]:
        c = str(color_name or "").strip().lower()
        if c == "blue":
            return (255, 0, 0)
        if c == "white":
            return (255, 255, 255)
        return (0, 255, 0)

    @staticmethod
    def _draw_corners_rounded_box(
        img,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        color: Tuple[int, int, int],
        thickness: int = 2,
    ) -> None:
        w = max(1, x2 - x1)
        h = max(1, y2 - y1)
        corner = max(6, int(min(w, h) * 0.18))
        corner = min(corner, max(6, int(min(w, h) * 0.45)))
        r = max(2, int(corner * 0.35))
        # top-left
        cv2.line(img, (x1 + r, y1), (x1 + corner, y1), color, thickness)
        cv2.line(img, (x1, y1 + r), (x1, y1 + corner), color, thickness)
        cv2.ellipse(img, (x1 + r, y1 + r), (r, r), 0, 180, 270, color, thickness)
        # top-right
        cv2.line(img, (x2 - corner, y1), (x2 - r, y1), color, thickness)
        cv2.line(img, (x2, y1 + r), (x2, y1 + corner), color, thickness)
        cv2.ellipse(img, (x2 - r, y1 + r), (r, r), 0, 270, 360, color, thickness)
        # bottom-left
        cv2.line(img, (x1 + r, y2), (x1 + corner, y2), color, thickness)
        cv2.line(img, (x1, y2 - corner), (x1, y2 - r), color, thickness)
        cv2.ellipse(img, (x1 + r, y2 - r), (r, r), 0, 90, 180, color, thickness)
        # bottom-right
        cv2.line(img, (x2 - corner, y2), (x2 - r, y2), color, thickness)
        cv2.line(img, (x2, y2 - corner), (x2, y2 - r), color, thickness)
        cv2.ellipse(img, (x2 - r, y2 - r), (r, r), 0, 0, 90, color, thickness)

    def _ensure_age_gender_model(self) -> None:
        """
        加载二阶段性别/年龄识别模型（分开两套权重）。
        """
        if YOLO is None:
            return
        # gender model
        try:
            if self._gender_model is None and self._gender_model_path and os.path.exists(self._gender_model_path):
                self._gender_model = YOLO(self._gender_model_path)
                try:
                    if torch is not None and torch.cuda.is_available():
                        self._gender_model.to("cuda:0")
                except Exception:
                    pass
        except Exception:
            self._gender_model = None

        # face-age model
        try:
            if self._face_age_model is None and self._face_age_model_path and os.path.exists(self._face_age_model_path):
                self._face_age_model = YOLO(self._face_age_model_path)
                try:
                    if torch is not None and torch.cuda.is_available():
                        self._face_age_model.to("cuda:0")
                except Exception:
                    pass
        except Exception:
            self._face_age_model = None

        # face detector model
        try:
            if self._face_model is None and self._face_model_path and os.path.exists(self._face_model_path):
                self._face_model = YOLO(self._face_model_path)
                try:
                    if torch is not None and torch.cuda.is_available():
                        self._face_model.to("cuda:0")
                except Exception:
                    pass
        except Exception:
            self._face_model = None

        if os.environ.get("YOLO_FACE_AGE_DEBUG", "0") == "1" and not self._age_model_status_debug_once:
            self._age_model_status_debug_once = True
            try:
                print(
                    "[YOLO_FACE_AGE_DEBUG][model_status]",
                    {
                        "gender_model_path": self._gender_model_path,
                        "gender_model_exists": bool(self._gender_model_path and os.path.exists(self._gender_model_path)),
                        "gender_model_loaded": self._gender_model is not None,
                        "face_age_model_path": self._face_age_model_path,
                        "face_age_model_exists": bool(self._face_age_model_path and os.path.exists(self._face_age_model_path)),
                        "face_age_model_loaded": self._face_age_model is not None,
                        "face_model_path": self._face_model_path,
                        "face_model_exists": bool(self._face_model_path and os.path.exists(self._face_model_path)),
                        "face_model_loaded": self._face_model is not None,
                    },
                )
            except Exception:
                pass

    def _age_to_bucket(self, age: float) -> Optional[str]:
        try:
            a = float(age)
        except Exception:
            return None
        if not a or a < 0:
            return None
        if a < 13:
            return "0-12"
        if a < 26:
            return "18-25"
        if a < 36:
            return "26-35"
        if a < 46:
            return "36-45"
        if a < 56:
            return "46-55"
        return "55+"

    def _extract_first_float(self, v: Any) -> Optional[float]:
        """
        尝试从任意输出结构中提取第一个标量 float：
        - torch.Tensor / numpy 标量：支持 `.item()`
        - list/tuple/np.ndarray：取第一个元素
        """
        if v is None:
            return None
        try:
            if hasattr(v, "item"):
                # torch/numpy scalar
                return float(v.item())
        except Exception:
            pass
        try:
            if isinstance(v, (list, tuple)):
                if len(v) > 0:
                    return self._extract_first_float(v[0])
                return None
        except Exception:
            pass
        try:
            # np.ndarray / tensor 也可能走这里
            if hasattr(v, "__len__"):
                if len(v) > 0:
                    return self._extract_first_float(v[0])
                return None
        except Exception:
            pass
        try:
            return float(v)
        except Exception:
            return None

    def _extract_age_value(self, r0: Any) -> Optional[float]:
        """
        兼容不同 age 模型输出：
        - 回归：可能叫 ages/age/pred_age/age_pred 等
        - 分类：如果是 logits/probs 不太可能直接转成 float，会在外层用 class name 解析
        """
        for attr in ("ages", "age", "age_val", "age_pred", "pred_age", "pred"):
            try:
                v = getattr(r0, attr, None)
                fv = self._extract_first_float(v)
                if fv is not None:
                    return fv
            except Exception:
                continue
        return None

    def _label_by_index(self, names_attr: Any, idx: Any) -> Optional[str]:
        """从 names(dict/list) 里按 index 取类别名。"""
        if names_attr is None or idx is None:
            return None
        try:
            i = int(idx)
        except Exception:
            return None
        try:
            if isinstance(names_attr, dict):
                if i in names_attr:
                    return str(names_attr[i])
                # 某些导出权重 keys 可能是 str
                si = str(i)
                if si in names_attr:
                    return str(names_attr[si])
            elif isinstance(names_attr, (list, tuple)):
                if 0 <= i < len(names_attr):
                    return str(names_attr[i])
        except Exception:
            return None
        return None

    def _normalize_gender(self, gender_str: Optional[str]) -> Optional[str]:
        if not gender_str:
            return None
        s = str(gender_str).strip().lower()
        if "female" in s or "woman" in s or s in ("f", "女"):
            return "female"
        if "male" in s or "man" in s or s in ("m", "男"):
            return "male"
        if s in ("男",):
            return "male"
        if s in ("女",):
            return "female"
        return None

    def _extract_face_crop_for_capture(self, person_crop):
        """
        抓拍用人脸裁剪：
        1) 优先用 face 模型检测人脸
        2) 无 face 模型时，用 person crop 上半区域作为兜底
        """
        if person_crop is None or getattr(person_crop, "size", 0) == 0:
            return None
        try:
            h, w = person_crop.shape[:2]
            if h <= 2 or w <= 2:
                return None
        except Exception:
            return None

        # 优先 face detector
        if self._face_model is not None:
            try:
                fr = self._face_model(person_crop, verbose=False)
                if fr:
                    r0 = fr[0]
                    boxes = getattr(r0, "boxes", None)
                    if boxes is not None:
                        xyxy = getattr(boxes, "xyxy", None)
                        conf = getattr(boxes, "conf", None)
                        if xyxy is not None:
                            try:
                                xyxy_np = xyxy.cpu().numpy()
                            except Exception:
                                xyxy_np = xyxy
                            try:
                                conf_np = conf.cpu().numpy().reshape(-1) if conf is not None else None
                            except Exception:
                                conf_np = None
                            n = len(xyxy_np) if hasattr(xyxy_np, "__len__") else 0
                            if n > 0:
                                best_i = 0
                                if conf_np is not None and len(conf_np) == n:
                                    best_i = int(max(range(n), key=lambda i: float(conf_np[i])))
                                x1, y1, x2, y2 = [float(v) for v in xyxy_np[best_i]]
                                ih, iw = person_crop.shape[:2]
                                xi1 = int(max(0, min(iw - 1, x1)))
                                yi1 = int(max(0, min(ih - 1, y1)))
                                xi2 = int(max(0, min(iw, x2)))
                                yi2 = int(max(0, min(ih, y2)))
                                if xi2 > xi1 and yi2 > yi1:
                                    return person_crop[yi1:yi2, xi1:xi2]
            except Exception:
                pass

        # 兜底：上半区域
        try:
            ih, iw = person_crop.shape[:2]
            x_pad = int(0.15 * iw)
            y2 = int(0.58 * ih)
            xi1 = max(0, x_pad)
            xi2 = max(xi1 + 1, iw - x_pad)
            yi1 = 0
            yi2 = max(yi1 + 1, min(ih, y2))
            return person_crop[yi1:yi2, xi1:xi2]
        except Exception:
            return None

    def _push_face_capture(
        self,
        virtual_view_id: int,
        track_id: int,
        ts: float,
        gender: Optional[str],
        age_bucket: Optional[str],
        person_crop,
    ) -> Optional[Dict[str, Any]]:
        # 抓拍以“过线事件”为准：即使属性暂未识别，也应保留抓拍记录（前端显示未知）
        key = (int(virtual_view_id), int(track_id))
        last_ts = self._face_capture_last_ts.get(key)
        if last_ts is not None and (float(ts) - float(last_ts)) < self._face_capture_min_interval_sec:
            return None
        face_crop = self._extract_face_crop_for_capture(person_crop)
        if face_crop is None or getattr(face_crop, "size", 0) == 0:
            return None
        # 对最终抓拍的人脸图再做一次属性识别（与离线 demo 输入口径一致）
        try:
            if str(self._ag_provider).lower() == "uniface":
                g2, a2 = self._infer_gender_age_from_crop_uniface(face_crop)
                if g2 is not None:
                    gender = g2
                if a2 is not None:
                    age_bucket = a2
        except Exception:
            pass
        try:
            ok, jpg = cv2.imencode(".jpg", face_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            if not ok:
                return
            b64 = base64.b64encode(jpg.tobytes()).decode("ascii")
        except Exception:
            return None
        self._face_capture_last_ts[key] = float(ts)
        with self._lock:
            self._face_capture_seq += 1
            row = {
                "id": int(self._face_capture_seq),
                "track_id": int(track_id),
                "ts": float(ts),
                "gender": gender,
                "age_bucket": age_bucket,
                "image_base64": b64,
            }
            arr = self._face_captures_by_vv.setdefault(int(virtual_view_id), [])
            arr.insert(0, row)
            if len(arr) > self._face_capture_max:
                del arr[self._face_capture_max :]
            return dict(row)

    def get_face_captures(self, virtual_view_id: int, limit: int = 12) -> list[Dict[str, Any]]:
        lim = max(1, min(int(limit), 36))
        with self._lock:
            arr = self._face_captures_by_vv.get(int(virtual_view_id), [])
            return [dict(x) for x in arr[:lim]]

    def note_track_attr(
        self,
        virtual_view_id: int,
        track_id: int,
        ts: float,
        gender: Optional[str],
        age_bucket: Optional[str],
        person_crop,
    ) -> None:
        if track_id is None or int(track_id) < 0:
            return
        if person_crop is None or getattr(person_crop, "size", 0) == 0:
            return
        key = (int(virtual_view_id), int(track_id))
        with self._lock:
            self._track_attr_latest[key] = {
                "ts": float(ts),
                "gender": gender,
                "age_bucket": age_bucket,
                "crop": person_crop.copy(),
            }
            # 清理过旧缓存，避免长期增长
            cutoff = float(ts) - 6.0
            old_keys = [k for k, v in self._track_attr_latest.items() if float(v.get("ts", 0.0)) < cutoff]
            for k in old_keys:
                self._track_attr_latest.pop(k, None)

    def capture_enter_face_once(
        self,
        floor_plan_id: int,
        line_config_id: int,
        virtual_view_id: int,
        track_id: int,
        stable_id: int,
        ts: float,
    ) -> None:
        vv = int(virtual_view_id)
        sid = int(stable_id)
        tid = int(track_id)
        if sid < 0 or tid < 0:
            return
        seen_key = (vv, sid)
        with self._lock:
            last_seen = self._enter_capture_seen.get(seen_key)
            if last_seen is not None and (float(ts) - float(last_seen)) < 1.5:
                return
            sample = self._track_attr_latest.get((vv, tid))
        if not sample:
            return
        # 仅在抓拍时做属性最终判定（优先 UniFace），避免画框阶段的临时属性干扰落库结果
        final_gender = sample.get("gender")
        final_age_bucket = sample.get("age_bucket")
        try:
            crop = sample.get("crop")
            if crop is not None and getattr(crop, "size", 0) != 0:
                g2, a2 = self._infer_gender_age_from_crop(crop, float(ts))
                if g2 is not None:
                    final_gender = g2
                if a2 is not None:
                    final_age_bucket = a2
        except Exception:
            pass
        row = self._push_face_capture(
            virtual_view_id=vv,
            track_id=tid,
            ts=float(ts),
            gender=final_gender,
            age_bucket=final_age_bucket,
            person_crop=sample.get("crop"),
        )
        if row is None:
            return
        # 持久化到数据库：支持按日期加载抓拍记录
        try:
            self._persist_face_capture(
                floor_plan_id=int(floor_plan_id),
                line_config_id=int(line_config_id),
                virtual_view_id=vv,
                track_id=tid,
                stable_id=sid,
                ts=float(ts),
                gender=final_gender,
                age_bucket=final_age_bucket,
                image_base64=str(row.get("image_base64", "")),
            )
        except Exception:
            pass
        with self._lock:
            self._enter_capture_seen[seen_key] = float(ts)

    def _persist_face_capture(
        self,
        floor_plan_id: int,
        line_config_id: int,
        virtual_view_id: int,
        track_id: int,
        stable_id: int,
        ts: float,
        gender: Optional[str],
        age_bucket: Optional[str],
        image_base64: str,
    ) -> None:
        if not image_base64:
            return
        try:
            with SessionLocal() as db:
                row = models.FootfallFaceCapture(
                    line_config_id=int(line_config_id),
                    floor_plan_id=int(floor_plan_id),
                    virtual_view_id=int(virtual_view_id),
                    ts=float(ts),
                    track_id=int(track_id),
                    stable_id=int(stable_id),
                gender=(str(gender) if gender is not None else None),
                age_bucket=(str(age_bucket) if age_bucket is not None else None),
                    image_base64=str(image_base64),
                )
                db.add(row)
                db.commit()
        except Exception:
            return

    def reanalyze_face_capture_attributes(self, image_base64: str) -> Tuple[Optional[str], Optional[str]]:
        """
        对已落库的人脸抓拍图（base64）重新执行年龄/性别识别。
        返回 (gender, age_bucket)。
        """
        if not image_base64:
            return None, None
        try:
            raw = base64.b64decode(str(image_base64))
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None or getattr(img, "size", 0) == 0:
                return None, None
            return self._infer_gender_age_from_crop(img, time.time())
        except Exception:
            return None, None

    def _infer_gender_age_from_crop(self, crop, now: float) -> Tuple[Optional[str], Optional[str]]:
        """
        运行二阶段性别/年龄模型（如果已配置），并返回 (gender, age_bucket)。
        - gender 来自 `yolov8n-gender-classification.pt`
        - age 来自 `yolo11n-face-age.pt`
        """
        if str(self._ag_provider).lower() == "uniface":
            g, a = self._infer_gender_age_from_crop_uniface(crop)
            # 默认严格使用 UniFace，避免与旧 YOLO 结果混用导致口径不一致。
            # 如需兜底回退，可设置 AG_UNIFACE_FALLBACK_TO_YOLO=1。
            if (g is not None or a is not None) or (not self._ag_uniface_fallback_to_yolo):
                return g, a
        if self._gender_model is None and self._face_age_model is None:
            return None, None

        gender: Optional[str] = None
        age_bucket: Optional[str] = None
        gender_input = crop

        try:
            # 1) age + 人脸框（优先）
            if self._face_age_model is not None:
                try:
                    age_input = crop
                    # face detector 作为兜底：当 age 模型不出 boxes/ages 时，仍可先裁脸
                    if self._face_model is not None:
                        try:
                            f_results = self._face_model(crop, verbose=False)
                            if f_results:
                                fr0 = f_results[0]
                                boxes = getattr(fr0, "boxes", None)
                                if boxes is not None:
                                    xyxy = getattr(boxes, "xyxy", None)
                                    conf = getattr(boxes, "conf", None)
                                    if xyxy is not None:
                                        try:
                                            xyxy_np = xyxy.cpu().numpy()
                                        except Exception:
                                            xyxy_np = xyxy
                                        try:
                                            conf_np = conf.cpu().numpy().reshape(-1) if conf is not None else None
                                        except Exception:
                                            conf_np = None
                                        n_face = len(xyxy_np) if hasattr(xyxy_np, "__len__") else 0
                                        if n_face > 0:
                                            best_i = 0
                                            if conf_np is not None and len(conf_np) == n_face:
                                                best_i = int(max(range(n_face), key=lambda i: float(conf_np[i])))
                                            try:
                                                x1, y1, x2, y2 = [float(v) for v in xyxy_np[best_i]]
                                                ih, iw = crop.shape[:2]
                                                xi1 = int(max(0, min(iw - 1, x1)))
                                                yi1 = int(max(0, min(ih - 1, y1)))
                                                xi2 = int(max(0, min(iw, x2)))
                                                yi2 = int(max(0, min(ih, y2)))
                                                if xi2 > xi1 and yi2 > yi1:
                                                    age_input = crop[yi1:yi2, xi1:xi2]
                                            except Exception:
                                                pass
                        except Exception:
                            pass

                    a_results = self._face_age_model(age_input, verbose=False)
                    if a_results:
                        r0 = a_results[0]
                        age_val: Optional[float] = self._extract_age_value(r0)
                        if age_val is not None:
                            age_bucket = self._age_to_bucket(age_val)

                        # 尝试用 age 模型输出的人脸框作为 gender 输入
                        try:
                            boxes = getattr(r0, "boxes", None)
                            if boxes is not None:
                                xyxy = getattr(boxes, "xyxy", None)
                                conf = getattr(boxes, "conf", None)
                                if xyxy is not None:
                                    try:
                                        xyxy_np = xyxy.cpu().numpy()
                                    except Exception:
                                        xyxy_np = xyxy
                                    try:
                                        conf_np = conf.cpu().numpy().reshape(-1) if conf is not None else None
                                    except Exception:
                                        conf_np = None
                                    n_face = len(xyxy_np) if hasattr(xyxy_np, "__len__") else 0
                                    if n_face > 0:
                                        best_i = 0
                                        if conf_np is not None and len(conf_np) == n_face:
                                            best_i = int(max(range(n_face), key=lambda i: float(conf_np[i])))
                                        x1, y1, x2, y2 = [float(v) for v in xyxy_np[best_i]]
                                        ih, iw = age_input.shape[:2]
                                        xi1 = int(max(0, min(iw - 1, x1)))
                                        yi1 = int(max(0, min(ih - 1, y1)))
                                        xi2 = int(max(0, min(iw, x2)))
                                        yi2 = int(max(0, min(ih, y2)))
                                        if xi2 > xi1 and yi2 > yi1:
                                            gender_input = age_input[yi1:yi2, xi1:xi2]
                        except Exception:
                            pass

                        if age_bucket is None:
                            # 如果模型输出的是 age 类别（例如 18-25），尝试用 class name 解析
                            label: Optional[str] = None
                            names_attr = getattr(r0, "names", None)
                            probs_attr = getattr(r0, "probs", None)
                            top1 = getattr(probs_attr, "top1", None) if probs_attr is not None else None
                            if top1 is not None and names_attr is not None:
                                label = self._label_by_index(names_attr, top1)
                            # yolo11n-face-age 常见输出路径：boxes.cls + names
                            if label is None:
                                try:
                                    boxes = getattr(r0, "boxes", None)
                                    cls_attr = getattr(boxes, "cls", None) if boxes is not None else None
                                    cls_i = self._extract_first_float(cls_attr)
                                    label = self._label_by_index(names_attr, cls_i)
                                except Exception:
                                    label = None
                            if label is not None:
                                _g, ab, _person_like = self._infer_gender_age_from_class_name(label)
                                age_bucket = ab

                        # optional debug: help figure out model output shape
                        if (
                            age_bucket is None
                            and not self._age_parse_debug_once
                            and os.environ.get("YOLO_FACE_AGE_DEBUG", "0") == "1"
                        ):
                            self._age_parse_debug_once = True
                            try:
                                attrs = {
                                    "has_ages": hasattr(r0, "ages"),
                                    "has_age": hasattr(r0, "age"),
                                    "has_probs": hasattr(r0, "probs"),
                                    "has_boxes": hasattr(r0, "boxes"),
                                    "has_pred": hasattr(r0, "pred"),
                                    "names_type": type(getattr(r0, "names", None)).__name__,
                                    "names": getattr(r0, "names", None),
                                    "top1": getattr(getattr(r0, "probs", None), "top1", None),
                                }
                                try:
                                    boxes = getattr(r0, "boxes", None)
                                    cls_attr = getattr(boxes, "cls", None) if boxes is not None else None
                                    attrs["first_box_cls"] = self._extract_first_float(cls_attr)
                                except Exception:
                                    attrs["first_box_cls"] = None
                                print("[YOLO_FACE_AGE_DEBUG]", attrs)
                            except Exception:
                                pass
                except Exception:
                    age_bucket = None

            # 2) gender（优先使用 face crop）
            if self._gender_model is not None:
                try:
                    g_results = self._gender_model(gender_input, verbose=False)
                    if g_results:
                        r0 = g_results[0]
                        gender_str: Optional[str] = None
                        names_attr = getattr(r0, "names", None)
                        probs_attr = getattr(r0, "probs", None)
                        top1 = getattr(probs_attr, "top1", None) if probs_attr is not None else None
                        if top1 is not None and names_attr is not None:
                            gender_str = self._label_by_index(names_attr, top1)
                        if gender_str is None:
                            try:
                                boxes = getattr(r0, "boxes", None)
                                cls_attr = getattr(boxes, "cls", None) if boxes is not None else None
                                cls_i = self._extract_first_float(cls_attr)
                                gender_str = self._label_by_index(names_attr, cls_i)
                            except Exception:
                                gender_str = None
                        if gender_str is None and isinstance(names_attr, dict):
                            try:
                                gender_str = str(next(iter(names_attr.values())))
                            except Exception:
                                gender_str = None
                        gender = self._normalize_gender(gender_str)
                except Exception:
                    gender = None

            return gender, age_bucket
        except Exception:
            return None, None

    def _ensure_uniface_models(self) -> None:
        if self._uniface_detector is not None and self._uniface_age_gender is not None:
            return
        if RetinaFace is None or AgeGender is None:
            if not self._uniface_init_warned:
                self._uniface_init_warned = True
                print("[UNIFACE] package not available, fallback to YOLO age/gender")
            return
        try:
            self._uniface_detector = RetinaFace(providers=self._uniface_providers)
            self._uniface_age_gender = AgeGender(providers=self._uniface_providers)
            print(f"[UNIFACE] initialized with providers={self._uniface_providers}")
        except Exception as e:
            if not self._uniface_init_warned:
                self._uniface_init_warned = True
                print(f"[UNIFACE] init failed, fallback to YOLO: {e}")
            self._uniface_detector = None
            self._uniface_age_gender = None

    def _infer_gender_age_from_crop_uniface(self, crop) -> Tuple[Optional[str], Optional[str]]:
        if crop is None or getattr(crop, "size", 0) == 0:
            return None, None
        self._ensure_uniface_models()
        if self._uniface_detector is None or self._uniface_age_gender is None:
            return None, None
        try:
            img = crop
            if not isinstance(img, np.ndarray):
                return None, None
            with self._uniface_infer_lock:
                faces = self._uniface_detector.detect(img) or []
            # 实时场景 person crop 中人脸偏小：先原图检测，失败后再做放大重试
            if not faces:
                try:
                    h0, w0 = img.shape[:2]
                    scale = 2.0 if min(h0, w0) < 220 else 1.5
                    up = cv2.resize(img, (max(2, int(w0 * scale)), max(2, int(h0 * scale))), interpolation=cv2.INTER_CUBIC)
                    with self._uniface_infer_lock:
                        faces = self._uniface_detector.detect(up) or []
                    img = up
                except Exception:
                    faces = []
            if not faces:
                return None, None
            valid_faces = []
            for f in faces:
                try:
                    conf = float(getattr(f, "confidence", 0.0) or 0.0)
                except Exception:
                    conf = 0.0
                if conf >= float(self._uniface_face_min_conf):
                    valid_faces.append(f)
            # 严格阈值下可能一个都不过；兜底取最高分人脸，避免长期全“未知”
            if not valid_faces:
                valid_faces = list(faces)

            def _score(face) -> float:
                try:
                    x1, y1, x2, y2 = [float(v) for v in getattr(face, "bbox", [0, 0, 0, 0])]
                    area = max(1.0, (x2 - x1) * (y2 - y1))
                except Exception:
                    area = 1.0
                try:
                    conf = float(getattr(face, "confidence", 0.0) or 0.0)
                except Exception:
                    conf = 0.0
                return conf * area

            best_face = max(valid_faces, key=_score)
            with self._uniface_infer_lock:
                # 兼容不同 uniface 版本：
                # - 新版可能支持传 face 对象
                # - 部分版本仅支持 bbox（np.ndarray/list[4]）
                try:
                    res = self._uniface_age_gender.predict(img, best_face)
                except Exception:
                    bbox = getattr(best_face, "bbox", None)
                    if bbox is None:
                        raise
                    res = self._uniface_age_gender.predict(img, bbox)

            gender: Optional[str] = None
            age_bucket: Optional[str] = None

            gender_raw = getattr(res, "gender", None)
            try:
                gv = int(gender_raw)
                if gv == 1:
                    gender = "male"
                elif gv == 0:
                    gender = "female"
            except Exception:
                s = str(gender_raw or "").strip().lower()
                if "female" in s:
                    gender = "female"
                elif "male" in s:
                    gender = "male"

            age_raw = getattr(res, "age", None)
            try:
                age_v = float(age_raw)
                if np.isfinite(age_v):
                    age_bucket = self._age_to_bucket(age_v)
            except Exception:
                age_bucket = None

            return gender, age_bucket
        except Exception:
            return None, None

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        if YOLO is None:
            return
        # 默认 COCO/人属性模型（自动下载一次）
        # 如果你的权重包含 gender/age 类别名，可通过环境变量切换为正确的权重。
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        default_model_path = os.path.join(base_dir, "yolov8m.pt")
        model_path = os.environ.get("YOLO_MODEL_PATH")
        if not model_path:
            model_path = default_model_path
        elif not os.path.isabs(model_path) and not os.path.exists(model_path):
            model_path = os.path.join(base_dir, model_path)
        self._model = YOLO(model_path)
        # 显式切到 GPU（在部分环境中 ultralytics 默认不会自动选择 cuda）
        try:
            if torch is not None and torch.cuda.is_available():
                self._model.to("cuda:0")
        except Exception:
            pass

        # 缓存 class names（用于性别/年龄解析）
        try:
            names = getattr(self._model, "names", None)
            # ultralytics 通常：dict[int, str] 或 list[str]
            if isinstance(names, dict):
                self._cls_names = {int(k): str(v) for k, v in names.items() if v is not None}
            elif isinstance(names, list):
                self._cls_names = {int(i): str(n) for i, n in enumerate(names) if n is not None}
        except Exception:
            self._cls_names = {}

    def _normalize_cls_name(self, s: str) -> str:
        # 统一成便于匹配的字符串
        return (
            s.lower()
            .replace(" ", "")
            .replace("_", "-")
            .replace("–", "-")
            .replace("—", "-")
            .replace("--", "-")
        )

    def _cls_name_of(self, cid: int) -> Optional[str]:
        return self._cls_names.get(int(cid))

    def _infer_gender_age_from_class_name(
        self, cls_name: Optional[str]
    ) -> Tuple[Optional[str], Optional[str], bool]:
        """
        从模型类别名解析 gender/age_bucket，并判断该类别是否“像人”（用于 footfall 事件的跟踪）。
        """
        if not cls_name:
            return None, None, False
        norm = self._normalize_cls_name(cls_name)

        gender: Optional[str] = None
        # 英文/中文兜底（如果你的模型命名不同，可以再扩展）
        if "male" in norm or "man" in norm or "男" in cls_name:
            gender = "male"
        if "female" in norm or "woman" in norm or "女" in cls_name:
            gender = "female" if gender is None else gender

        age_bucket: Optional[str] = None
        # 1) 先尝试命中项目原生分桶标签
        for label in self._age_bucket_labels:
            if label.endswith("+"):
                base = label[:-1]  # e.g. "55"
                if f"{base}+" in norm or f"{base}plus" in norm:
                    age_bucket = label
                    break
            elif label in norm:
                age_bucket = label
                break

        # 2) 通用年龄区间标签，如 20-29 / 20~29 / 20_29
        if age_bucket is None:
            try:
                m = re.search(r"(\d{1,3})\s*[-~_]\s*(\d{1,3})", norm)
                if m:
                    a = float(m.group(1))
                    b = float(m.group(2))
                    if b < a:
                        a, b = b, a
                    age_bucket = self._age_to_bucket((a + b) * 0.5)
            except Exception:
                pass

        # 3) 处理 60+ 这类标签
        if age_bucket is None:
            try:
                m = re.search(r"(\d{1,3})\s*\+", norm)
                if m:
                    age_bucket = self._age_to_bucket(float(m.group(1)) + 1.0)
            except Exception:
                pass

        # 4) 处理单值年龄，如 age25 / 25y
        if age_bucket is None:
            try:
                m = re.search(r"(\d{1,3})", norm)
                if m:
                    age_bucket = self._age_to_bucket(float(m.group(1)))
            except Exception:
                pass

        # 是否像人：命中 gender/age，或明确包含 person 关键词
        person_like = "person" in norm or gender is not None or age_bucket is not None or "people" in norm
        return gender, age_bucket, person_like

    def _infer_gender_age_from_cls_id(self, cid: int) -> Tuple[Optional[str], Optional[str], bool]:
        """
        返回 (gender, age_bucket, person_like)。
        """
        cid_int = int(cid)
        # COCO person 默认 id=0
        if cid_int == 0:
            return None, None, True
        name = self._cls_name_of(cid_int)
        return self._infer_gender_age_from_class_name(name)

    def is_person_detection_class(self, cid: int) -> bool:
        """与 YOLO 推理线程中 footfall person 过滤一致，供 footfall 等模块复用。"""
        _g, _a, person_like = self._infer_gender_age_from_cls_id(int(cid))
        return bool(person_like)

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
        热加载 view 参数：用于不中断流的情况下应用最新 view_mode/yaw/pitch/fov/out_w/out_h/enabled。
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
                "view_mode": str(getattr(view, "view_mode", "panorama_perspective") or "panorama_perspective"),
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
        analyze_fps = float(os.environ.get("VV_ANALYZE_FPS", "6.0"))  # 推理频率（一直运行，便于历史统计）
        stream_fps = 10.0   # 有人观看时输出 MJPEG 刷新频率
        idle_stream_fps = 1.0  # 无人观看时仍保留低频编码，避免最新帧长期不更新

        last_infer_ts = 0.0
        last_emit_ts = 0.0
        last_boxes = None  # (xyxy, cls)
        last_ids = None    # list[int]
        last_genders = None  # list[Optional[str]]
        last_age_buckets = None  # list[Optional[str]]
        tracks: Dict[int, Tuple[float, float, float, float, float, int]] = {}
        next_track_id = 1

        loaded = self._load_view(virtual_view_id)
        if not loaded:
            return
        rtsp_url, view = loaded
        enabled = bool(view.enabled)
        view_mode = str(getattr(view, "view_mode", "panorama_perspective") or "panorama_perspective")
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
                            view_mode = str(p.get("view_mode", "panorama_perspective"))
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
                        last_genders = None
                        last_age_buckets = None
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
                    if view_mode == "native_resize":
                        try:
                            persp = cv2.resize(frame, (int(max(1, out_w)), int(max(1, out_h))))
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

                now = time.time()
                # plain 版本（不带框）
                plain_img = persp

                # 1) YOLO 推理（限帧）
                if inference_enabled:
                    # 只有在 analyzed 需要时才懒加载 YOLO
                    self._ensure_model()
                    self._ensure_age_gender_model()
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
                                        n_det = int(len(cls_ids))
                                        ids = [-1 for _ in range(n_det)]
                                        genders: list[Optional[str]] = [None for _ in range(n_det)]
                                        age_buckets: list[Optional[str]] = [None for _ in range(n_det)]
                                        try:
                                            max_dist = max(25.0, 0.08 * float(max(w_img, h_img)))
                                            base_gate = max(25.0, 0.06 * float(max(w_img, h_img)))
                                            max_speed = 0.35 * float(max(w_img, h_img))
                                            used_tracks = set()
                                            used_dets = set()
                                            person_idxs: list[int] = []
                                            for i, cid in enumerate(cls_ids):
                                                try:
                                                    cid_int = int(cid)
                                                except Exception:
                                                    continue
                                                gender, age_bucket, person_like = self._infer_gender_age_from_cls_id(cid_int)
                                                genders[i] = gender
                                                age_buckets[i] = age_bucket
                                                if person_like:
                                                    person_idxs.append(int(i))
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
                                                for tid, (tx, ty, vx, vy, ts0, _miss) in tracks.items():
                                                    if tid in used_tracks:
                                                        continue
                                                    dtp = float(now) - float(ts0)
                                                    if dtp < 0.0:
                                                        dtp = 0.0
                                                    px = float(tx) + float(vx) * float(dtp)
                                                    py = float(ty) + float(vy) * float(dtp)
                                                    dx = float(px) - cx
                                                    dy = float(py) - cy
                                                    d2 = dx * dx + dy * dy
                                                    if best_d2 is None or d2 < best_d2:
                                                        best_d2 = d2
                                                        best_tid = int(tid)
                                                if best_tid is not None and best_d2 is not None:
                                                    try:
                                                        tx0, ty0, vx0, vy0, ts0, _m0 = tracks[int(best_tid)]
                                                        dtp = float(now) - float(ts0)
                                                        if dtp < 0.0:
                                                            dtp = 0.0
                                                        gate = float(base_gate) + float(max_dist) + float(max_speed) * float(dtp)
                                                        gate2 = float(gate) * float(gate)
                                                    except Exception:
                                                        gate2 = float(max_dist) * float(max_dist)
                                                    ok_match = float(best_d2) <= float(gate2)
                                                else:
                                                    ok_match = False

                                                if ok_match:
                                                    ids[i] = int(best_tid)
                                                    used_tracks.add(int(best_tid))
                                                    used_dets.add(int(i))
                                                    try:
                                                        tx0, ty0, vx0, vy0, ts0, _m0 = tracks[int(best_tid)]
                                                        dt0 = float(now) - float(ts0)
                                                        if dt0 <= 1e-3:
                                                            dt0 = 1e-3
                                                        ovx = (cx - float(tx0)) / float(dt0)
                                                        ovy = (cy - float(ty0)) / float(dt0)
                                                        nvx = 0.7 * float(vx0) + 0.3 * float(ovx)
                                                        nvy = 0.7 * float(vy0) + 0.3 * float(ovy)
                                                        tracks[int(best_tid)] = (cx, cy, float(nvx), float(nvy), float(now), 0)
                                                    except Exception:
                                                        tracks[int(best_tid)] = (cx, cy, 0.0, 0.0, float(now), 0)
                                                else:
                                                    tid = int(next_track_id)
                                                    next_track_id += 1
                                                    ids[i] = tid
                                                    used_tracks.add(tid)
                                                    used_dets.add(int(i))
                                                    tracks[tid] = (cx, cy, 0.0, 0.0, float(now), 0)

                                            next_tracks: Dict[int, Tuple[float, float, float, float, float, int]] = {}
                                            for tid, (tx, ty, vx, vy, ts0, miss) in tracks.items():
                                                if int(tid) in used_tracks:
                                                    next_tracks[int(tid)] = (float(tx), float(ty), float(vx), float(vy), float(ts0), 0)
                                                    continue
                                                miss2 = int(miss) + 1
                                                if miss2 > 8:
                                                    continue
                                                if float(now) - float(ts0) > 2.5:
                                                    continue
                                                next_tracks[int(tid)] = (float(tx), float(ty), float(vx), float(vy), float(ts0), miss2)
                                            tracks = next_tracks
                                        except Exception:
                                            pass
                                        # 2.5) 二阶段性别/年龄识别（按 track_id 缓存限频）
                                        # 在这里覆盖 genders/age_buckets，让后续事件携带真实属性。
                                        try:
                                            if self._gender_model is not None or self._face_age_model is not None:
                                                processed_tids: set[int] = set()
                                                frame_crop_w = w_img if 'w_img' in locals() else 0
                                                frame_crop_h = h_img if 'h_img' in locals() else 0
                                                for i in person_idxs:
                                                    tid = ids[i]
                                                    if tid is None or tid < 0:
                                                        continue
                                                    tid = int(tid)
                                                    if tid in processed_tids:
                                                        cached = self._ag_cache.get(tid)
                                                        if cached is not None and (now - cached[2]) <= self._ag_cache_ttl_sec:
                                                            gender_cached, age_cached, _ts = cached
                                                            genders[i] = gender_cached
                                                            age_buckets[i] = age_cached
                                                        continue
                                                    processed_tids.add(tid)

                                                    cached = self._ag_cache.get(tid)
                                                    if cached is not None and (now - cached[2]) <= self._ag_cache_ttl_sec:
                                                        gender_cached, age_cached, _ts = cached
                                                        genders[i] = gender_cached
                                                        age_buckets[i] = age_cached
                                                        continue

                                                    x1, y1, x2, y2 = xyxy[i]
                                                    xi1 = int(max(0, min(frame_crop_w - 1, float(x1))))
                                                    yi1 = int(max(0, min(frame_crop_h - 1, float(y1))))
                                                    xi2 = int(max(0, min(frame_crop_w, float(x2))))
                                                    yi2 = int(max(0, min(frame_crop_h, float(y2))))
                                                    if xi2 <= xi1 or yi2 <= yi1:
                                                        continue
                                                    crop = persp[yi1:yi2, xi1:xi2]
                                                    if crop is None or crop.size == 0:
                                                        continue

                                                    gender_pred, age_bucket_pred = self._infer_gender_age_from_crop(crop, now)
                                                    genders[i] = gender_pred
                                                    age_buckets[i] = age_bucket_pred
                                                    self._ag_cache[tid] = (gender_pred, age_bucket_pred, now)
                                                    self.note_track_attr(
                                                        virtual_view_id=int(virtual_view_id),
                                                        track_id=int(tid),
                                                        ts=float(now),
                                                        gender=gender_pred,
                                                        age_bucket=age_bucket_pred,
                                                        person_crop=crop,
                                                    )
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
                                                gender=genders,
                                                age_bucket=age_buckets,
                                            )
                                            last_genders = genders
                                            last_age_buckets = age_buckets
                                        except Exception:
                                            pass
                        except Exception:
                            # 推理失败就沿用上一轮的 boxes 或不画
                            pass

                # 2) 叠加检测框（使用 last_boxes，避免每帧都必须推理）
                annotated_img = plain_img
                h_img, w_img = 0, 0
                try:
                    h_img, w_img = persp.shape[:2]
                except Exception:
                    h_img, w_img = (0, 0)

                # 如果当前 vv 有前端配置的判定线，则画到 YOLO 画面上便于对齐验证
                foot_line_uv = None
                draw_footfall_line = True
                yolo_draw_cfg = {}
                try:
                    with self._lock:
                        foot_line_uv = self._footfall_line_uv_by_vv.get(int(virtual_view_id))
                        draw_footfall_line = bool(self._draw_footfall_line_overlay)
                        yolo_draw_cfg = {
                            "box_style": self._yolo_box_style,
                            "box_color": self._yolo_box_color,
                            "foot_point_enabled": self._yolo_foot_point_enabled,
                            "foot_point_style": self._yolo_foot_point_style,
                            "foot_point_color": self._yolo_foot_point_color,
                        }
                except Exception:
                    foot_line_uv = None
                    draw_footfall_line = True
                    yolo_draw_cfg = {
                        "box_style": "rect",
                        "box_color": "green",
                        "foot_point_enabled": True,
                        "foot_point_style": "circle",
                        "foot_point_color": "green",
                    }

                if inference_enabled and draw_footfall_line and foot_line_uv is not None:
                    try:
                        annotated_img = plain_img.copy()
                    except Exception:
                        annotated_img = plain_img

                    try:
                        (p1_u, p1_v), (p2_u, p2_v) = foot_line_uv
                        x1 = int(round(float(p1_u) * float(w_img)))
                        y1 = int(round(float(p1_v) * float(h_img)))
                        x2 = int(round(float(p2_u) * float(w_img)))
                        y2 = int(round(float(p2_v) * float(h_img)))
                        # Clamp
                        x1 = max(0, min(x1, max(0, w_img - 1)))
                        x2 = max(0, min(x2, max(0, w_img - 1)))
                        y1 = max(0, min(y1, max(0, h_img - 1)))
                        y2 = max(0, min(y2, max(0, h_img - 1)))

                        cv2.line(annotated_img, (x1, y1), (x2, y2), (255, 0, 255), 2)
                        cv2.circle(annotated_img, (x1, y1), 4, (255, 0, 255), -1)
                        cv2.circle(annotated_img, (x2, y2), 4, (255, 0, 255), -1)
                    except Exception:
                        pass
                if inference_enabled and last_boxes is not None:
                    # 在副本上画框，避免污染 plain 预览
                    try:
                        if annotated_img is plain_img:
                            annotated_img = plain_img.copy()
                    except Exception:
                        annotated_img = plain_img
                    xyxy, cls_ids = last_boxes
                    box_color_bgr = self._named_bgr(str(yolo_draw_cfg.get("box_color", "green")))
                    foot_color_bgr = self._named_bgr(str(yolo_draw_cfg.get("foot_point_color", "green")))
                    box_style = str(yolo_draw_cfg.get("box_style", "rect"))
                    foot_enabled = bool(yolo_draw_cfg.get("foot_point_enabled", True))
                    foot_style = str(yolo_draw_cfg.get("foot_point_style", "circle"))
                    for i, ((x1, y1, x2, y2), cid) in enumerate(zip(xyxy, cls_ids)):
                        try:
                            cid_int = int(cid)
                        except Exception:
                            continue
                        _, _, person_like = self._infer_gender_age_from_cls_id(cid_int)
                        if not person_like:
                            continue
                        x1_i, y1_i, x2_i, y2_i = map(int, [x1, y1, x2, y2])
                        if box_style == "corners_rounded":
                            self._draw_corners_rounded_box(annotated_img, x1_i, y1_i, x2_i, y2_i, box_color_bgr, 2)
                        else:
                            cv2.rectangle(annotated_img, (x1_i, y1_i), (x2_i, y2_i), box_color_bgr, 2)

                        # 脚步原点：bbox 底部中心向上 1%
                        try:
                            h_box = float(y2_i - y1_i)
                            foot_x = int(round((x1_i + x2_i) * 0.5))
                            foot_y = int(round(float(y2_i) - 0.01 * h_box))
                            if foot_enabled and 0 <= foot_x < int(w_img) and 0 <= foot_y < int(h_img):
                                if foot_style == "square":
                                    s = 4
                                    cv2.rectangle(
                                        annotated_img,
                                        (foot_x - s, foot_y - s),
                                        (foot_x + s, foot_y + s),
                                        foot_color_bgr,
                                        -1,
                                    )
                                else:
                                    cv2.circle(annotated_img, (foot_x, foot_y), 4, foot_color_bgr, -1)
                        except Exception:
                            pass
                        gender = None
                        age_bucket = None
                        if last_genders is not None and i < len(last_genders):
                            gender = last_genders[i]
                        if last_age_buckets is not None and i < len(last_age_buckets):
                            age_bucket = last_age_buckets[i]
                        # 注意：cv2.putText 默认字体不支持中文，"男/女" 会显示成 "???"
                        # 这里使用 ASCII 文本，避免出现乱码占位符。
                        gender_cn = None
                        if gender == "male":
                            gender_cn = "M"
                        elif gender == "female":
                            gender_cn = "F"

                        label = "person"
                        try:
                            if last_ids is not None and i < len(last_ids) and int(last_ids[i]) >= 0:
                                label = f"person#{int(last_ids[i])}"
                        except Exception:
                            label = "person"

                        # 按产品要求：YOLO 框顶只显示 person/id，不在这里显示性别和年龄
                        cv2.putText(
                            annotated_img,
                            label,
                            (x1_i, max(y1_i - 5, 0)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.5,
                            box_color_bgr,
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
                    elif ok_p:
                        # annotated 编码失败时仍发布 plain JPEG，避免 analyzed.mjpeg 长时间无首包导致浏览器黑屏
                        self._latest_annotated[virtual_view_id] = VirtualViewFrame(jpeg=jpg_p.tobytes(), ts=now)

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
