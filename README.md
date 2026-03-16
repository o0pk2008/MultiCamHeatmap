## MultiCamHeatmap

多路摄像头行人检测 + 平面图热力图 可视化系统。

### 功能概览

- **YOLO 行人检测**：从多路 RTSP 实时拉流，检测人物脚部位置。
- **平面图映射**：将各摄像机地面区域映射到同一张 CAD 平面图上。
- **热力图分析**：在平面图上实时叠加多摄像头的人员分布热力图。
- **Web 可视化**：前后端分离（React + FastAPI），支持：
  - 摄像头实时画面 + YOLO 检测结果
  - 平面图热力图展示
  - 摄像头管理（增删改）
  - 映射管理（平面图网格、摄像机地面格子、一对一对应关系）

### 技术栈

- **后端**：Python, FastAPI, SQLAlchemy, SQLite（可切换 PostgreSQL）
- **前端**：React + Vite
- **容器化**：Docker, docker-compose

### 开发环境启动

在项目根目录：

```bash
docker compose build
docker compose up
```

- 后端 API & 文档：`http://localhost:18080` / `http://localhost:18080/docs`
- 前端 Web：`http://localhost:13000`

### 数据库与映射设计（简要）

- 使用环境变量 `DB_URL` 控制数据库类型：
  - 默认：`sqlite:////data/app.db`
  - 将来可切换为 PostgreSQL：`postgresql+psycopg2://user:pass@host:5432/dbname`
- 关键表：
  - `cameras`：摄像头信息（名称、RTSP URL、启用状态等）。
  - `floor_plans`：平面图（名称、图像路径、像素尺寸、网格行列数）。
  - `floor_cells`：平面图网格中的单个格子，多边形以 JSON 文本存储。
  - `camera_mappings`：摄像头 ↔ 平面图 的总体映射（支持 grid / homography / hybrid）。
  - `camera_ground_cells`：摄像机画面中的地面格子，多边形以 JSON 文本存储，并与 `floor_cells` 一一对应。

通过上述设计，可以让 **任意多个摄像头** 的地面区域统一映射到 **同一张平面图的网格上**，从而对人流进行统一热力图分析。