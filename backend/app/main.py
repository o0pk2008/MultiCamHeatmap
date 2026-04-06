import os
import asyncio
import json
from sqlalchemy import inspect, text

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

from .db import Base, engine, SessionLocal
from . import models
from .routers.cameras import router as cameras_router
from .routers.mappings import router as mappings_router
from .routers.discovery import router as discovery_router

from typing import List

from .heatmap_store import record_heatmap_event, is_recording, update_current_dwell

heatmap_clients: List[WebSocket] = []
heatmap_lock = asyncio.Lock()

footfall_clients: List[WebSocket] = []
footfall_lock = asyncio.Lock()

app = FastAPI(title="MultiCam Heatmap Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 创建数据库表
Base.metadata.create_all(bind=engine)


def _ensure_schema_columns() -> None:
    """轻量兼容迁移：为旧库补充新增列。"""
    try:
        insp = inspect(engine)
        cols = {c.get("name") for c in insp.get_columns("camera_virtual_views")}
        if "view_mode" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE camera_virtual_views "
                        "ADD COLUMN view_mode VARCHAR(32) NOT NULL DEFAULT 'panorama_perspective'"
                    )
                )
        with engine.begin() as conn:
            if "crop_x1" not in cols:
                conn.execute(text("ALTER TABLE camera_virtual_views ADD COLUMN crop_x1 INTEGER"))
            if "crop_y1" not in cols:
                conn.execute(text("ALTER TABLE camera_virtual_views ADD COLUMN crop_y1 INTEGER"))
            if "crop_x2" not in cols:
                conn.execute(text("ALTER TABLE camera_virtual_views ADD COLUMN crop_x2 INTEGER"))
            if "crop_y2" not in cols:
                conn.execute(text("ALTER TABLE camera_virtual_views ADD COLUMN crop_y2 INTEGER"))
        face_cols = {c.get("name") for c in insp.get_columns("footfall_face_captures")}
        with engine.begin() as conn:
            if "image_path" not in face_cols:
                conn.execute(text("ALTER TABLE footfall_face_captures ADD COLUMN image_path TEXT"))
    except Exception:
        # 避免迁移失败阻断服务启动
        pass


_ensure_schema_columns()

# 静态目录挂载：用于访问上传的平面图图片（/maps/xxx.png）
# 设置较长缓存时间，避免切换页面时反复请求导致排队/等待（尤其在同时存在 MJPEG 长连接时）。
maps_dir = "/data/maps"
os.makedirs(maps_dir, exist_ok=True)
app.mount("/maps", StaticFiles(directory=maps_dir, html=False), name="maps")

face_captures_dir = "/data/face-captures"
os.makedirs(face_captures_dir, exist_ok=True)
app.mount("/face-captures", StaticFiles(directory=face_captures_dir, html=False), name="face-captures")

repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
icons_dir = "/data/icon" if os.path.isdir("/data/icon") else os.path.join(repo_root, "data", "icon")
if os.path.isdir(icons_dir):
    app.mount("/icons", StaticFiles(directory=icons_dir, html=False), name="icons")


# 为 /maps 图片设置长缓存（避免切换页面时反复下载/解码导致排队）
@app.middleware("http")
async def add_maps_cache_control(request: Request, call_next):
    response = await call_next(request)
    try:
        if request.url.path.startswith("/maps/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    except Exception:
        pass
    return response

app.include_router(cameras_router)
app.include_router(mappings_router)
app.include_router(discovery_router)
from .routers.footfall import router as footfall_router
from .routers.queue_wait import router as queue_wait_router
from .routers.admin import QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY, router as admin_router

app.include_router(footfall_router)
app.include_router(queue_wait_router)
app.include_router(admin_router)


@app.on_event("startup")
async def _load_persisted_runtime_settings() -> None:
    try:
        from .virtual_view_inference import manager as vv_manager
        from .queue_wait_analysis import analyzer as qw_analyzer

        with SessionLocal() as db:
            row = db.query(models.AppSetting).filter(models.AppSetting.key == "face_capture_retention_days").first()
            if row is not None:
                try:
                    vv_manager.set_face_capture_retention_days(int(str(row.value)))
                except Exception:
                    pass
            row_qw = (
                db.query(models.AppSetting)
                .filter(models.AppSetting.key == QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_KEY)
                .first()
            )
            if row_qw is not None:
                try:
                    qw_analyzer.set_post_service_queue_ignore_sec(float(str(row_qw.value)))
                except Exception:
                    pass
    except Exception:
        pass


@app.get("/", response_class=HTMLResponse)
async def root():
    return "<h1>MultiCam Heatmap Backend</h1><p>FastAPI is running.</p>"


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.get("/api/system/status")
async def system_status(response: Response):
    """首页仪表盘：后台分析 / 推理任务数量（不含重复语义上的「总和」，分项展示）。"""
    from .footfall_analysis import analyzer as footfall_analyzer
    from .routers import mappings as mappings_mod
    from .virtual_view_inference import manager as vv_manager

    response.headers["Cache-Control"] = "no-store, max-age=0"
    footfall_sessions = int(footfall_analyzer.running_session_count())
    heatmap_floor_plans = len(mappings_mod.heatmap_running_floor_plans)
    inference_views = int(vv_manager.count_inference_enabled_virtual_views())
    decode_streams = int(vv_manager.active_virtual_view_stream_count())
    face_capture_queue_size = int(vv_manager.face_capture_queue_size())
    return {
        "footfall_sessions": footfall_sessions,
        "heatmap_floor_plans": heatmap_floor_plans,
        "inference_virtual_views": inference_views,
        "virtual_view_decode_streams": decode_streams,
        "face_capture_queue_size": face_capture_queue_size,
    }


@app.websocket("/ws/heatmap")
async def websocket_heatmap(ws: WebSocket):
    await ws.accept()
    try:
        # TODO: 后续替换为真实的热力图数据推送
        while True:
            # 简单心跳，避免前端连接报错
            await ws.send_json({"type": "heartbeat"})
            await ws.receive_text()
    except WebSocketDisconnect:
        pass

@app.websocket("/ws/heatmap-events")
async def websocket_heatmap_events(ws: WebSocket):
  await ws.accept()
  async with heatmap_lock:
    heatmap_clients.append(ws)
  try:
    while True:
      # 这里只是保持连接；实际数据由其他协程通过 heatmap_broadcast 发送
      await asyncio.sleep(10)
  except WebSocketDisconnect:
    pass
  finally:
    async with heatmap_lock:
      if ws in heatmap_clients:
        heatmap_clients.remove(ws)

async def heatmap_broadcast(event: dict):
  try:
    update_current_dwell(event)
  except Exception:
    pass

  data = json.dumps(event)
  async with heatmap_lock:
    for ws in list(heatmap_clients):
      try:
        await ws.send_text(data)
      except Exception:
        # 出错时移除该客户端
        try:
          heatmap_clients.remove(ws)
        except ValueError:
          pass

  # 落库（用于历史回放），由开关控制，异步执行避免阻塞推送
  try:
    floor_plan_id = event.get("floor_plan_id")
    if is_recording(int(floor_plan_id) if floor_plan_id is not None else None):
      t = asyncio.create_task(record_heatmap_event(event))
      # 避免未被 await 的 task 抛异常刷屏
      t.add_done_callback(lambda fut: fut.exception() if fut.cancelled() else fut.exception())
  except Exception:
    pass


@app.websocket("/ws/footfall-events")
async def websocket_footfall_events(ws: WebSocket):
  await ws.accept()
  async with footfall_lock:
    footfall_clients.append(ws)
  try:
    while True:
      await asyncio.sleep(10)
  except WebSocketDisconnect:
    pass
  finally:
    async with footfall_lock:
      if ws in footfall_clients:
        footfall_clients.remove(ws)


async def footfall_broadcast(event: dict):
  data = json.dumps(event)
  async with footfall_lock:
    for ws in list(footfall_clients):
      try:
        await ws.send_text(data)
      except Exception:
        try:
          footfall_clients.remove(ws)
        except ValueError:
          pass

  # 落库：用于跨电脑持久化（统计/回放）
  try:
    from .footfall_store import record_footfall_event

    t = asyncio.create_task(record_footfall_event(event))
    t.add_done_callback(lambda fut: fut.exception() if fut.cancelled() else fut.exception())
  except Exception:
    pass
