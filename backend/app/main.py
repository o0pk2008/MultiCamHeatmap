import os
import asyncio
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

from .db import Base, engine
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

# 静态目录挂载：用于访问上传的平面图图片（/maps/xxx.png）
# 设置较长缓存时间，避免切换页面时反复请求导致排队/等待（尤其在同时存在 MJPEG 长连接时）。
maps_dir = "/data/maps"
os.makedirs(maps_dir, exist_ok=True)
app.mount("/maps", StaticFiles(directory=maps_dir, html=False), name="maps")

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
from .routers.admin import router as admin_router

app.include_router(footfall_router)
app.include_router(admin_router)


@app.get("/", response_class=HTMLResponse)
async def root():
    return "<h1>MultiCam Heatmap Backend</h1><p>FastAPI is running.</p>"


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


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
