import os
import asyncio
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .db import Base, engine
from .routers.cameras import router as cameras_router
from .routers.mappings import router as mappings_router
from .routers.discovery import router as discovery_router

from typing import List

from .heatmap_store import record_heatmap_event, is_recording

heatmap_clients: List[WebSocket] = []
heatmap_lock = asyncio.Lock()

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
maps_dir = "/data/maps"
os.makedirs(maps_dir, exist_ok=True)
app.mount("/maps", StaticFiles(directory=maps_dir), name="maps")

app.include_router(cameras_router)
app.include_router(mappings_router)
app.include_router(discovery_router)


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
      asyncio.create_task(record_heatmap_event(event))
  except Exception:
    pass