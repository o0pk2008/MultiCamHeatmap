import React, { useCallback, useEffect, useRef, useState } from "react";

type TabKey = "realtime" | "heatmap" | "mapping";

// 后端 API 基础地址：优先使用环境变量，未配置时退回到当前主机的 18080 端口
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  window.location.protocol + "//" + window.location.hostname + ":18080";

// mediamtx 转发服务地址（按你的规则生成 CameraXX）
// 从 Vite 环境变量中读取，便于通过 .env 配置：
// VITE_MEDIA_HOST=192.168.2.94
// VITE_MEDIA_RTSP_PORT=8554
// VITE_MEDIA_WEBRTC_PORT=8889
const MEDIA_HOST =
  import.meta.env.VITE_MEDIA_HOST || window.location.hostname;
const MEDIA_RTSP_PORT = Number(import.meta.env.VITE_MEDIA_RTSP_PORT || "8554");
const MEDIA_WEBRTC_PORT = Number(
  import.meta.env.VITE_MEDIA_WEBRTC_PORT || "8889",
);

interface Camera {
  id: number;
  name: string;
  rtsp_url: string;
  enabled: boolean;
  description?: string | null;
  webrtc_url?: string | null;
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("realtime");

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-4 font-sans text-slate-900">
      {/* 顶部标题栏 */}
      <header className="mb-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-sm">
        <div className="flex items-center gap-3">
          {/* 简单热力图风格 Icon */}
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 via-yellow-300 to-red-500 shadow-inner">
            <div className="h-5 w-5 rounded-full bg-white/70 mix-blend-screen" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-snug text-slate-900 md:text-xl">
              MultiCam Heatmap
            </h1>
            <p className="text-xs text-slate-500 md:text-[13px]">
              多路摄像头 · 实时热力图 · 映射管理
            </p>
          </div>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        <TabButton label="实时画面" tab="realtime" activeTab={activeTab} onChange={setActiveTab} />
        <TabButton label="热力图" tab="heatmap" activeTab={activeTab} onChange={setActiveTab} />
        <TabButton label="映射管理" tab="mapping" activeTab={activeTab} onChange={setActiveTab} />
      </div>
      {activeTab === "realtime" && <RealtimeView />}
      {activeTab === "heatmap" && <HeatmapView />}
      {activeTab === "mapping" && <MappingView />}
    </div>
  );
};

const TabButton: React.FC<{
  label: string;
  tab: TabKey;
  activeTab: TabKey;
  onChange: (t: TabKey) => void;
}> = ({ label, tab, activeTab, onChange }) => (
  <button
    onClick={() => onChange(tab)}
    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
      activeTab === tab
        ? "bg-emerald-500 text-white shadow-sm"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
    }`}
  >
    {label}
  </button>
);

const RealtimeView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`${API_BASE}/api/cameras/`);
      const data: Camera[] = await res.json();
      setCameras(data);
    };
    load();
  }, []);

  const enabled = cameras.filter((c) => c.enabled && c.webrtc_url);
  const display = enabled.slice(0, 9);

  if (display.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        暂无可用的摄像头画面，请先在“摄像头管理”中添加并启用摄像头，并配置 WebRTC 播放地址。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold text-slate-800">实时画面（最多 9 路）</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {display.map((cam) => (
          <div
            key={cam.id}
            className="overflow-hidden rounded-lg border border-slate-200 bg-black shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
              <span className="font-semibold">{cam.name}</span>
              <span className="text-slate-400">ID: {cam.id}</span>
            </div>
            <div className="aspect-video w-full bg-black">
              {cam.webrtc_url ? (
                <iframe
                  src={cam.webrtc_url}
                  className="h-full w-full border-none"
                  allow="autoplay; fullscreen"
                  title={`camera-${cam.id}`}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">
                  未配置 WebRTC 地址
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const HeatmapView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      const [camRes, fpRes] = await Promise.all([
        fetch(`${API_BASE}/api/cameras/`),
        fetch(`${API_BASE}/api/floor-plans`),
      ]);
      const camData: Camera[] = await camRes.json();
      const fpData: FloorPlan[] = await fpRes.json();
      setCameras(camData);
      setFloorPlans(fpData);
      if (fpData.length > 0 && selectedFloorPlanId === null) {
        setSelectedFloorPlanId(fpData[0].id);
      }
    };
    load();
  }, [selectedFloorPlanId]);

  const mappedCameras = cameras.filter((c) => c.enabled && c.webrtc_url);

  const selectedFloorPlan = floorPlans.find((fp) => fp.id === selectedFloorPlanId) || null;
  const floorPlanImageUrl =
    selectedFloorPlan && selectedFloorPlan.image_path.startsWith("/data/maps/")
      ? `${API_BASE}/maps/${selectedFloorPlan.image_path.split("/").pop()}`
      : null;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">热力图与映射摄像头</h2>
      <p className="text-xs text-slate-500">
        左侧显示当前选择的平面图热力图，右侧以宫格形式展示参与该热力图的摄像头画面。
        映射关系和底图上传将在“映射管理”模块中配置。
      </p>

      <div className="grid gap-4 md:grid-cols-[2fr,3fr]">
        {/* 左侧：热力图区域 */}
        <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">热力图预览</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">选择平面图：</span>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={selectedFloorPlanId ?? ""}
                onChange={(e) =>
                  setSelectedFloorPlanId(
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              >
                {floorPlans.length === 0 && <option value="">无平面图</option>}
                {floorPlans.map((fp) => (
                  <option key={fp.id} value={fp.id}>
                    {fp.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {floorPlanImageUrl ? (
              <img
                src={floorPlanImageUrl}
                alt={selectedFloorPlan?.name}
                className="h-full w-full object-contain"
              />
            ) : (
              <span className="text-xs text-slate-400">
                当前无平面图配置，请在“映射管理”中上传或选择平面图。
              </span>
            )}
          </div>
        </div>

        {/* 右侧：摄像头宫格 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">映射摄像头画面</span>
            <span className="text-[11px] text-slate-400">
              后续将按映射配置筛选参与当前热力图的摄像头
            </span>
          </div>
          {mappedCameras.length === 0 ? (
            <p className="text-xs text-slate-500">
              暂无可用摄像头，请先在“摄像头管理”中添加并启用，后续在“映射管理”中关联到平面图。
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {mappedCameras.slice(0, 6).map((cam) => (
                <div
                  key={cam.id}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-black"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                    <span className="truncate">{cam.name}</span>
                    <span className="text-slate-400">ID: {cam.id}</span>
                  </div>
                  <div className="aspect-video w-full bg-black">
                    {cam.webrtc_url ? (
                      <iframe
                        src={cam.webrtc_url}
                        className="h-full w-full border-none"
                        allow="autoplay; fullscreen"
                        title={`heatmap-camera-${cam.id}`}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">
                        未配置 WebRTC 地址
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface FloorPlan {
  id: number;
  name: string;
  image_path: string;
  width_px: number;
  height_px: number;
  grid_rows: number;
  grid_cols: number;
}

function floorPlanImageUrl(fp: FloorPlan): string {
  return fp.image_path.startsWith("/data/maps/")
    ? `${API_BASE}/maps/${fp.image_path.split("/").pop()}`
    : fp.image_path;
}

/** 平面图 Canvas：支持拖拽、缩放、网格叠加与 hover 显示网格编号 */
const FloorPlanCanvas: React.FC<{
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  className?: string;
}> = ({ imageUrl, gridRows, gridCols, className = "" }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 600, h: 400 });

  // 加载图片并记录尺寸
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    return () => {
      img.src = "";
      imageRef.current = null;
    };
  }, [imageUrl]);

  // 监听容器尺寸
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 600, height: 400 };
      setCanvasSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imgSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = canvasSize.w;
    const ch = canvasSize.h;
    const iw = imgSize.w;
    const ih = imgSize.h;
    const fitScale = Math.min(cw / iw, ch / ih);
    const offsetX = cw / 2 - (iw * fitScale) / 2;
    const offsetY = ch / 2 - (ih * fitScale) / 2;

    // 先清空画布，避免拖拽/缩放时出现“残影”
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.translate(offsetX, offsetY);
    ctx.scale(fitScale, fitScale);
    ctx.drawImage(img, 0, 0);
    // 网格线
    const rows = Math.max(1, gridRows);
    const cols = Math.max(1, gridCols);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1 / fitScale;
    for (let r = 0; r <= rows; r++) {
      const y = (ih * r) / rows;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(iw, y);
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      const x = (iw * c) / cols;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ih);
      ctx.stroke();
    }
    // hover 高亮与编号
    if (hoverCell != null && hoverCell.row >= 0 && hoverCell.row < rows && hoverCell.col >= 0 && hoverCell.col < cols) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      const x = hoverCell.col * cellW;
      const y = hoverCell.row * cellH;
      ctx.fillStyle = "rgba(59, 130, 246, 0.35)";
      ctx.fillRect(x, y, cellW, cellH);
      ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
      ctx.lineWidth = 2 / fitScale;
      ctx.strokeRect(x, y, cellW, cellH);
      ctx.restore();
      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(offsetX, offsetY);
      ctx.scale(fitScale, fitScale);
      ctx.font = `bold ${Math.max(12, Math.min(24, cellW * 0.3))}px sans-serif`;
      ctx.fillStyle = "#1e3a8a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `行${hoverCell.row} 列${hoverCell.col}`,
        x + cellW / 2,
        y + cellH / 2
      );
      ctx.restore();
      return;
    }
    ctx.restore();
  }, [pan, zoom, hoverCell, gridRows, gridCols, imgSize, canvasSize]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 画布坐标 -> 图像坐标
  const canvasToImage = useCallback(
    (cx: number, cy: number) => {
      if (!imgSize) return { x: 0, y: 0 };
      const cw = canvasSize.w;
      const ch = canvasSize.h;
      const iw = imgSize.w;
      const ih = imgSize.h;
      const fitScale = Math.min(cw / iw, ch / ih);
      const offsetX = cw / 2 - (iw * fitScale) / 2;
      const offsetY = ch / 2 - (ih * fitScale) / 2;
      const lx = (cx - pan.x) / zoom - offsetX;
      const ly = (cy - pan.y) / zoom - offsetY;
      return {
        x: lx / fitScale,
        y: ly / fitScale,
      };
    },
    [pan, zoom, canvasSize, imgSize]
  );

  const getCellAt = useCallback(
    (cx: number, cy: number): { row: number; col: number } | null => {
      if (!imgSize) return null;
      const { x, y } = canvasToImage(cx, cy);
      const iw = imgSize.w;
      const ih = imgSize.h;
      const rows = Math.max(1, gridRows);
      const cols = Math.max(1, gridCols);
      if (x < 0 || x >= iw || y < 0 || y >= ih) return null;
      const col = Math.floor((x / iw) * cols);
      const row = Math.floor((y / ih) * rows);
      if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
      return { row, col };
    },
    [canvasToImage, gridRows, gridCols, imgSize]
  );

  const onWheel = (e: React.WheelEvent) => {
    if (!imgSize || !canvasRef.current) return;

    // wheel 事件的坐标是 CSS 像素；需要换算到 canvas 实际像素坐标（width/height）
    const rect = canvasRef.current.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const cx = (cssX * canvasSize.w) / Math.max(1, rect.width);
    const cy = (cssY * canvasSize.h) / Math.max(1, rect.height);

    // 鼠标所在位置对应的图片坐标
    const { x: imgX, y: imgY } = canvasToImage(cx, cy);
    const cw = canvasSize.w;
    const ch = canvasSize.h;
    const iw = imgSize.w;
    const ih = imgSize.h;
    const fitScale = Math.min(cw / iw, ch / ih);
    const offsetX = cw / 2 - (iw * fitScale) / 2;
    const offsetY = ch / 2 - (ih * fitScale) / 2;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

    setZoom((oldZoom) => {
      const newZoom = Math.min(5, Math.max(0.3, oldZoom * zoomFactor));

      // 保证鼠标下的图片点在缩放前后保持在同一画布坐标 (cx, cy)
      const baseX = offsetX + fitScale * imgX;
      const baseY = offsetY + fitScale * imgY;
      const newPan = {
        x: cx - newZoom * baseX,
        y: cy - newZoom * baseY,
      };
      setPan(newPan);

      return newZoom;
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    setDragging(true);
    setHoverCell(null);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (dragging) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    } else {
      const cell = getCellAt(cx, cy);
      setHoverCell(cell);
    }
  };
  const onMouseUp = () => setDragging(false);
  const onMouseLeave = () => setHoverCell(null);

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${className}`}
      style={{ minHeight: 320, userSelect: "none" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize.w}
        height={canvasSize.h}
        className="block cursor-grab active:cursor-grabbing"
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
};

const MappingView: React.FC = () => {
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [name, setName] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [rows, setRows] = useState("20");
  const [cols, setCols] = useState("30");
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // 已配置平面图：编辑某一条时的表单状态
  const [editingFloorPlanId, setEditingFloorPlanId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editImagePath, setEditImagePath] = useState("");
  const [editRows, setEditRows] = useState("");
  const [editCols, setEditCols] = useState("");
  const [editUploading, setEditUploading] = useState(false);
  const [editPreviewUrl, setEditPreviewUrl] = useState<string | null>(null);

  type MappingTabKey = "bind" | "cameras" | "floorPlans";
  const [mappingTab, setMappingTab] = useState<MappingTabKey>("bind");

  // 映射绑定子页使用的摄像头和平面图选择状态
  const [bindCameras, setBindCameras] = useState<Camera[]>([]);
  const [bindFloorPlanId, setBindFloorPlanId] = useState<number | "">("");
  const [bindCameraId, setBindCameraId] = useState<number | "">("");
  // 左侧平面图网格设置（可本地修改，保存时写回平面图）
  const [bindGridRows, setBindGridRows] = useState("");
  const [bindGridCols, setBindGridCols] = useState("");
  const [savingGrid, setSavingGrid] = useState(false);

  const loadFloorPlans = async () => {
    const res = await fetch(`${API_BASE}/api/floor-plans`);
    const data: FloorPlan[] = await res.json();
    setFloorPlans(data);
    if (data.length > 0 && bindFloorPlanId === "") {
      setBindFloorPlanId(data[0].id);
    }
  };

  const loadBindCameras = async () => {
    const res = await fetch(`${API_BASE}/api/cameras/`);
    const data: Camera[] = await res.json();
    setBindCameras(data);
    if (data.length > 0 && bindCameraId === "") {
      setBindCameraId(data[0].id);
    }
  };

  useEffect(() => {
    loadFloorPlans();
    loadBindCameras();
  }, []);

  // 切换平面图时同步网格数为该平面图的配置
  useEffect(() => {
    if (bindFloorPlanId === "") return;
    const fp = floorPlans.find((f) => f.id === bindFloorPlanId);
    if (fp) {
      setBindGridRows(String(fp.grid_rows));
      setBindGridCols(String(fp.grid_cols));
    }
  }, [bindFloorPlanId, floorPlans]);

  const handleCreate = async () => {
    if (!name || !imagePath) {
      alert("请先填写名称，并通过上传或手动输入方式设置图片路径。");
      return;
    }

    const payload = {
      name,
      image_path: imagePath,
      width_px: 0, // 后续可在后端根据图片实际尺寸更新
      height_px: 0,
      grid_rows: Number(rows || "0"),
      grid_cols: Number(cols || "0"),
    };

    try {
      const res = await fetch(`${API_BASE}/api/floor-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("保存平面图失败:", text);
        alert("保存平面图失败，请查看控制台日志。");
        return;
      }
      setName("");
      setImagePath("");
      await loadFloorPlans();
    } catch (e) {
      console.error(e);
      alert("保存平面图时发生网络错误，请稍后重试。");
    }
  };

  const startEditFloorPlan = (fp: FloorPlan) => {
    setEditingFloorPlanId(fp.id);
    setEditName(fp.name);
    setEditImagePath(fp.image_path);
    setEditRows(String(fp.grid_rows));
    setEditCols(String(fp.grid_cols));
    setEditPreviewUrl(null);
  };

  const cancelEditFloorPlan = () => {
    setEditingFloorPlanId(null);
  };

  const saveBindGrid = async () => {
    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") return;
    const fp = floorPlans.find((f) => f.id === bindFloorPlanId);
    if (!fp) return;
    setSavingGrid(true);
    try {
      const res = await fetch(`${API_BASE}/api/floor-plans/${bindFloorPlanId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grid_rows: Number(bindGridRows || "0") || 1,
          grid_cols: Number(bindGridCols || "0") || 1,
        }),
      });
      if (!res.ok) throw new Error("保存失败");
      await loadFloorPlans();
    } catch (e) {
      console.error(e);
      alert("保存网格设置失败，请稍后重试。");
    } finally {
      setSavingGrid(false);
    }
  };

  const saveEditFloorPlan = async () => {
    if (editingFloorPlanId == null) return;
    const payload: Record<string, unknown> = {
      name: editName,
      image_path: editImagePath,
      grid_rows: Number(editRows || "0"),
      grid_cols: Number(editCols || "0"),
    };
    try {
      const res = await fetch(`${API_BASE}/api/floor-plans/${editingFloorPlanId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("更新平面图失败:", text);
        alert("更新平面图失败，请查看控制台。");
        return;
      }
      setEditingFloorPlanId(null);
      await loadFloorPlans();
    } catch (e) {
      console.error(e);
      alert("更新平面图时发生网络错误，请稍后重试。");
    }
  };

  const subTabClass = (key: MappingTabKey) =>
    "rounded-full px-3 py-1 text-xs font-medium transition " +
    (mappingTab === key
      ? "bg-slate-900 text-white"
      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">映射管理</h2>
      <p className="text-xs text-slate-500">
        管理热力图底图（平面图）、摄像头以及它们之间的映射绑定关系。
      </p>

      {/* 子标签页切换 */}
      <div className="mb-3 flex flex-wrap gap-2">
        <button
          className={subTabClass("bind")}
          onClick={() => setMappingTab("bind")}
        >
          映射绑定
        </button>
        <button
          className={subTabClass("cameras")}
          onClick={() => setMappingTab("cameras")}
        >
          摄像头管理
        </button>
        <button
          className={subTabClass("floorPlans")}
          onClick={() => setMappingTab("floorPlans")}
        >
          平面图管理
        </button>
      </div>

      {/* 1. 映射绑定：左侧平面图，右侧单路摄像头预览 */}
      {mappingTab === "bind" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr,3fr]">
          {/* 左侧：选择平面图、网格设置、Canvas 预览（拖拽/缩放/网格/hover） */}
          <div className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800">平面图选择</span>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={bindFloorPlanId ?? ""}
                onChange={(e) =>
                  setBindFloorPlanId(
                    e.target.value ? Number(e.target.value) : "",
                  )
                }
              >
                {floorPlans.length === 0 && <option value="">无平面图</option>}
                {floorPlans.map((fp) => (
                  <option key={fp.id} value={fp.id}>
                    {fp.name}
                  </option>
                ))}
              </select>
            </div>
            {bindFloorPlanId !== "" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label className="text-xs text-slate-600">
                  网格行数
                  <input
                    type="number"
                    min={1}
                    className="ml-1 w-14 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    value={bindGridRows}
                    onChange={(e) => setBindGridRows(e.target.value)}
                  />
                </label>
                <label className="text-xs text-slate-600">
                  网格列数
                  <input
                    type="number"
                    min={1}
                    className="ml-1 w-14 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    value={bindGridCols}
                    onChange={(e) => setBindGridCols(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={saveBindGrid}
                  disabled={savingGrid}
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {savingGrid ? "保存中…" : "保存网格设置"}
                </button>
              </div>
            )}
            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              {bindFloorPlanId !== "" ? (
                (() => {
                  const fp = floorPlans.find((f) => f.id === bindFloorPlanId) || null;
                  if (!fp) {
                    return (
                      <span className="text-xs text-slate-400">
                        未找到对应平面图，请检查配置。
                      </span>
                    );
                  }
                  const url = floorPlanImageUrl(fp);
                  const rows = Math.max(1, Number(bindGridRows) || fp.grid_rows);
                  const cols = Math.max(1, Number(bindGridCols) || fp.grid_cols);
                  return (
                    <FloorPlanCanvas
                      imageUrl={url}
                      gridRows={rows}
                      gridCols={cols}
                      className="w-full"
                    />
                  );
                })()
              ) : (
                <span className="text-xs text-slate-400">
                  当前无平面图配置，请在“平面图管理”子页中添加。
                </span>
              )}
            </div>
          </div>

          {/* 右侧：选择摄像头并预览 */}
          <div className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800">摄像头选择</span>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={bindCameraId ?? ""}
                onChange={(e) =>
                  setBindCameraId(
                    e.target.value ? Number(e.target.value) : "",
                  )
                }
              >
                {bindCameras.length === 0 && <option value="">无摄像头</option>}
                {bindCameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>
                    {cam.name || cam.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              {bindCameraId !== "" ? (
                (() => {
                  const cam =
                    bindCameras.find((c) => c.id === bindCameraId) || null;
                  if (!cam) {
                    return (
                      <span className="text-xs text-slate-400">
                        未找到对应摄像头，请检查配置。
                      </span>
                    );
                  }
                  if (!cam.webrtc_url) {
                    return (
                      <span className="text-xs text-slate-400">
                        该摄像头未配置 WebRTC 播放地址，请在“摄像头管理”中补充。
                      </span>
                    );
                  }
                  return (
                    <iframe
                      src={cam.webrtc_url}
                      className="h-full w-full border-none"
                      allow="autoplay; fullscreen"
                      title={`mapping-bind-camera-${cam.id}`}
                    />
                  );
                })()
              ) : (
                <span className="text-xs text-slate-400">
                  当前无摄像头配置，请在“摄像头管理”子页中添加。
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. 摄像头管理：复用现有 CameraManageView */}
      {mappingTab === "cameras" && <CameraManageView />}

      {/* 3. 平面图管理：使用你原来的平面图表单 + 列表 */}
      {mappingTab === "floorPlans" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 左侧：新增平面图 */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-base font-semibold text-slate-800">
              新增平面图（底图）
            </h3>
            <div className="space-y-2 text-sm">
              <div>
                <label className="block text-slate-700">
                  名称
                  <input
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </div>
              <div>
                <label className="block text-slate-700">
                  图片路径（后端可访问的路径）
                  <input
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    placeholder="/data/maps/hall_1f.png"
                    value={imagePath}
                    onChange={(e) => setImagePath(e.target.value)}
                  />
                </label>
              </div>
              <div>
                <label className="block text-slate-700">
                  上传图片（JPG / PNG）
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-emerald-700"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      try {
                        const form = new FormData();
                        form.append("file", file);
                        const res = await fetch(
                          `${API_BASE}/api/floor-plans/upload-image`,
                          {
                            method: "POST",
                            body: form,
                          },
                        );
                        if (!res.ok) {
                          alert("上传失败，请检查文件格式（仅支持 JPG / PNG）");
                          return;
                        }
                        const data = await res.json();
                        setImagePath(data.image_path || "");
                        setPreviewUrl(`${API_BASE}${data.url}`);
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
                {uploading && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    上传中，请稍候...
                  </p>
                )}
                {previewUrl && (
                  <div className="mt-2">
                    <span className="text-[11px] text-slate-500">预览：</span>
                    <div className="mt-1 h-32 w-full overflow-hidden rounded border border-slate-200 bg-slate-100">
                      <img
                        src={previewUrl}
                        alt="floor-plan-preview"
                        className="h-full w-full object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <label className="block text-slate-700">
                  网格行数
                  <input
                    className="mt-1 w-24 rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    value={rows}
                    onChange={(e) => setRows(e.target.value)}
                  />
                </label>
                <label className="block text-slate-700">
                  网格列数
                  <input
                    className="mt-1 w-24 rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    value={cols}
                    onChange={(e) => setCols(e.target.value)}
                  />
                </label>
              </div>
              <button
                onClick={handleCreate}
                className="mt-1 inline-flex items-center rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                保存平面图
              </button>
            </div>
          </div>

          {/* 右侧：平面图列表 */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-base font-semibold text-slate-800">
              已配置平面图
            </h3>
            {floorPlans.length === 0 ? (
              <p className="text-xs text-slate-500">
                暂未配置任何平面图，请先在左侧添加。
              </p>
            ) : (
              <div className="max-h-[28rem] space-y-2 overflow-y-auto">
                {floorPlans.map((fp) => (
                  <div
                    key={fp.id}
                    className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                  >
                    {editingFloorPlanId === fp.id ? (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-slate-700">名称</label>
                          <input
                            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-slate-700">图片路径</label>
                          <input
                            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm font-mono"
                            value={editImagePath}
                            onChange={(e) => setEditImagePath(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-slate-700">更换图片（可选）</label>
                          <input
                            type="file"
                            accept="image/png,image/jpeg"
                            className="mt-0.5 block w-full text-xs file:rounded file:border-0 file:bg-emerald-600 file:px-2 file:py-0.5 file:text-white"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setEditUploading(true);
                              try {
                                const form = new FormData();
                                form.append("file", file);
                                const res = await fetch(
                                  `${API_BASE}/api/floor-plans/upload-image`,
                                  { method: "POST", body: form }
                                );
                                if (!res.ok) return;
                                const data = await res.json();
                                setEditImagePath(data.image_path || "");
                                setEditPreviewUrl(`${API_BASE}${data.url}`);
                              } finally {
                                setEditUploading(false);
                              }
                            }}
                          />
                          {editUploading && (
                            <span className="text-[11px] text-slate-500">上传中...</span>
                          )}
                          {editPreviewUrl && (
                            <div className="mt-1 h-20 w-full overflow-hidden rounded border">
                              <img src={editPreviewUrl} alt="预览" className="h-full w-full object-contain" />
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <label className="block text-slate-700">
                            网格行数
                            <input
                              className="ml-1 w-14 rounded border border-slate-300 px-1 py-0.5 text-sm"
                              value={editRows}
                              onChange={(e) => setEditRows(e.target.value)}
                            />
                          </label>
                          <label className="block text-slate-700">
                            网格列数
                            <input
                              className="ml-1 w-14 rounded border border-slate-300 px-1 py-0.5 text-sm"
                              value={editCols}
                              onChange={(e) => setEditCols(e.target.value)}
                            />
                          </label>
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={saveEditFloorPlan}
                            className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-700"
                          >
                            保存
                          </button>
                          <button
                            onClick={cancelEditFloorPlan}
                            className="rounded border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-100"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="h-16 w-24 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100">
                          <img
                            src={floorPlanImageUrl(fp)}
                            alt={fp.name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-slate-800">
                            {fp.name}{" "}
                            <span className="ml-1 text-[11px] text-slate-400">#{fp.id}</span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            {fp.image_path}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            网格：{fp.grid_rows} × {fp.grid_cols}
                          </div>
                          <button
                            onClick={() => startEditFloorPlan(fp)}
                            className="mt-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                          >
                            编辑
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const CameraManageView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [webrtcUrl, setWebrtcUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [description, setDescription] = useState("");
  const [ipRange, setIpRange] = useState("192.168.4.1-192.168.4.255");
  const [scanPort, setScanPort] = useState("554");
  const [discovered, setDiscovered] = useState<{ ip: string; port: number }[]>([]);
  const [scanning, setScanning] = useState(false);

  const loadCameras = async () => {
    const res = await fetch(`${API_BASE}/api/cameras/`);
    const data: Camera[] = await res.json();
    setCameras(data);
  };

  useEffect(() => {
    loadCameras();
  }, []);

  const handleAdd = async () => {
    if (!name || !rtspUrl) return;
    await fetch(`${API_BASE}/api/cameras/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        rtsp_url: rtspUrl,
        enabled,
        webrtc_url: webrtcUrl || null,
        description: description || null,
      }),
    });
    setName("");
    setRtspUrl("");
    setWebrtcUrl("");
    setDescription("");
    setEnabled(true);
    await loadCameras();
  };

  const handleScan = async () => {
    if (!ipRange) return;

    // 解析类似 "192.168.4.1-192.168.4.255" 的格式
    const parts = ipRange.split("-");
    if (parts.length !== 2) {
      alert("网络地址格式不正确，请使用例如：192.168.4.1-192.168.4.255");
      return;
    }

    const start = parts[0].trim();
    const end = parts[1].trim();
    const startSegs = start.split(".").map((s) => Number(s));
    const endSegs = end.split(".").map((s) => Number(s));

    if (
      startSegs.length !== 4 ||
      endSegs.length !== 4 ||
      startSegs[0] !== endSegs[0] ||
      startSegs[1] !== endSegs[1] ||
      startSegs[2] !== endSegs[2]
    ) {
      alert("目前仅支持同一网段的范围，例如：192.168.4.1-192.168.4.255");
      return;
    }

    const basePrefix = `${startSegs[0]}.${startSegs[1]}.${startSegs[2]}.`;
    const startHost = startSegs[3];
    const endHost = endSegs[3];
    if (endHost < startHost) {
      alert("IP 范围结束地址应大于开始地址");
      return;
    }

    setScanning(true);
    setDiscovered([]);
    try {
      const port = scanPort ? Number(scanPort) : 554;
      const found: { ip: string; port: number }[] = [];

      for (let host = startHost; host <= endHost; host++) {
        const ip = `${basePrefix}${host}`;
        const res = await fetch(`${API_BASE}/api/discovery/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ip_range: `${ip}-${ip}`,
            port,
            timeout_ms: 300,
          }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.devices && data.devices.length > 0) {
          const dev = data.devices[0];
          found.push(dev);
          // 逐个更新 UI
          setDiscovered((prev) => [...prev, dev]);
        }
      }
    } finally {
      setScanning(false);
    }
  };

  const handleQuickFill = (ip: string, port: number) => {
    // 规则：
    // 原始 IP：192.168.4.3  -> 后缀 "43"
    // 原始 IP：192.168.4.29 -> 后缀 "429"
    const segs = ip.split(".");
    const suffix = segs.slice(2).join(""); // "4.3" 或 "4.29" -> "43"/"429"

    setName(ip);
    // mediamtx 转发 RTSP
    setRtspUrl(`rtsp://${MEDIA_HOST}:${MEDIA_RTSP_PORT}/Camera${suffix}`);
    // WebRTC 播放地址
    setWebrtcUrl(`http://${MEDIA_HOST}:${MEDIA_WEBRTC_PORT}/Camera${suffix}`);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">摄像头管理</h2>

      {/* 上方：左右两栏 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* 左：网段扫描 */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-base font-semibold text-slate-800">扫描并添加摄像头</h3>
          <p className="mb-3 text-xs text-slate-500">
            网络地址和端口均为可选。
            支持 IP 段格式，例如：192.168.4.1-192.168.4.255。系统会在此范围内扫描开放 RTSP
            端口的设备，方便快速填入表单。
          </p>
          <div className="mb-3 flex items-center gap-2">
            <div className="flex flex-col gap-1 text-sm text-slate-700">
              <span>网络地址（可选）</span>
              <input
                className="w-64 rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="例如：192.168.4.1-192.168.4.255"
                value={ipRange}
                onChange={(e) => setIpRange(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1 text-sm text-slate-700">
              <span>端口（可选）</span>
              <input
                className="w-20 rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="554"
                value={scanPort}
                onChange={(e) => setScanPort(e.target.value)}
              />
            </div>
            <button
              onClick={handleScan}
              disabled={scanning}
              className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {scanning ? "扫描中..." : "开始扫描"}
            </button>
          </div>

          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded border border-slate-100 bg-slate-50 p-2 text-xs">
            {discovered.length === 0 && (
              <div className="text-slate-400">尚未发现设备，尝试调整网段后重新扫描。</div>
            )}
            {discovered.map((d) => {
              // 通过名称是否等于原始 IP 判断是否已添加（我们在快速填充时用 IP 作为名称）
              const exists = cameras.some((c) => c.name === d.ip);
              return (
                <div
                  key={`${d.ip}:${d.port}`}
                  className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1"
                >
                  <div>
                    <div className="font-mono text-xs text-slate-800">
                      {d.ip}:{d.port}
                    </div>
                    {exists && <div className="text-[11px] text-emerald-600">已接入</div>}
                  </div>
                  {!exists && (
                    <button
                      className="rounded border border-blue-500 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50"
                      onClick={() => handleQuickFill(d.ip, d.port)}
                    >
                      填入表单
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 右：新增摄像头表单 */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-base font-semibold text-slate-800">新增摄像头</h3>
          <div className="space-y-2 text-sm">
            <div>
              <label className="block text-slate-700">
                名称
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
            <div>
              <label className="block text-slate-700">
                RTSP URL
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="例如 rtsp://user:pass@ip:554/streaming"
                  value={rtspUrl}
                  onChange={(e) => setRtspUrl(e.target.value)}
                />
              </label>
            </div>
            <div>
              <label className="block text-slate-700">
                WebRTC 播放地址
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="例如 https://mediamtx-host/play/camera1"
                  value={webrtcUrl}
                  onChange={(e) => setWebrtcUrl(e.target.value)}
                />
              </label>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center text-slate-700">
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                启用
              </label>
            </div>
            <div>
              <label className="block text-slate-700">
                备注
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>
            <button
              onClick={handleAdd}
              className="mt-1 inline-flex items-center rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              保存
            </button>
          </div>
        </div>
      </div>

      {/* 下方：已接入摄像头列表 */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-base font-semibold text-slate-800">已接入摄像头列表</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                <th className="border border-slate-200 px-2 py-1">ID</th>
                <th className="border border-slate-200 px-2 py-1">名称</th>
                <th className="border border-slate-200 px-2 py-1">RTSP URL</th>
                <th className="border border-slate-200 px-2 py-1">WebRTC</th>
                <th className="border border-slate-200 px-2 py-1">启用</th>
                <th className="border border-slate-200 px-2 py-1">备注</th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="border border-slate-200 px-2 py-1">{c.id}</td>
                  <td className="border border-slate-200 px-2 py-1">{c.name}</td>
                  <td className="border border-slate-200 px-2 py-1 font-mono text-[11px]">
                    {c.rtsp_url}
                  </td>
                  <td className="border border-slate-200 px-2 py-1 font-mono text-[11px]">
                    {c.webrtc_url || "-"}
                  </td>
                  <td className="border border-slate-200 px-2 py-1">
                    {c.enabled ? (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                        启用
                      </span>
                    ) : (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        禁用
                      </span>
                    )}
                  </td>
                  <td className="border border-slate-200 px-2 py-1">
                    {c.description || <span className="text-slate-400">-</span>}
                  </td>
                </tr>
              ))}
              {cameras.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="border border-slate-200 px-2 py-4 text-center text-sm text-slate-400"
                  >
                    暂无摄像头，请先添加。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default App;