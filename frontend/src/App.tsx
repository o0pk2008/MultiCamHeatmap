import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TabKey = "realtime" | "heatmap" | "people" | "mapping";

// 后端 API 基础地址：优先使用环境变量，未配置时退回到当前主机的 18080 端口
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  window.location.protocol + "//" + window.location.hostname + ":18080";

const POI_ICON_URL = `${API_BASE}/icons/poi.png`;

type ShareKind = "heatmap" | "people";
type ShareRoute =
  | {
      kind: ShareKind;
      params: URLSearchParams;
    }
  | null;

function parseShareRoute(hash: string): ShareRoute {
  const h = String(hash || "");
  if (!h.startsWith("#/share/")) return null;
  const rest = h.slice("#/share/".length);
  const [pathPart, queryPart] = rest.split("?", 2);
  const kind = pathPart === "heatmap" || pathPart === "people" ? (pathPart as ShareKind) : null;
  if (!kind) return null;
  return { kind, params: new URLSearchParams(queryPart || "") };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.left = "-9999px";
      el.style.top = "-9999px";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

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

type HeatmapSource = {
  kind: "camera" | "virtual";
  camera_id: number;
  camera_name: string;
  webrtc_url?: string | null;
  virtual_view_id?: number | null;
  virtual_view_name?: string | null;
};

type Footfall = { row: number; col: number; ts: number };

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("realtime");
  const [shareRoute, setShareRoute] = useState<ShareRoute>(() => parseShareRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setShareRoute(parseShareRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  if (shareRoute) {
    if (shareRoute.kind === "heatmap") return <ShareHeatmapPage params={shareRoute.params} />;
    return <SharePeoplePage params={shareRoute.params} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="flex min-h-screen">
        {/* 左侧侧边栏 */}
        <aside className="w-60 shrink-0 border-r border-slate-200 bg-white px-3 py-4 shadow-sm">
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900/5 shadow-inner">
              <svg
                viewBox="0 0 1024 1024"
                xmlns="http://www.w3.org/2000/svg"
                className="h-8 w-8"
                aria-hidden="true"
              >
                <path d="M34.816 148.48h240.128v240.64H34.816z" fill="#694FF9"></path>
                <path d="M274.432 148.48h240.128v240.64H274.432z" fill="#8A75FA"></path>
                <path d="M514.56 148.48h240.128v240.64h-240.128z" fill="#694FF9"></path>
                <path d="M34.816 389.12h240.128v240.64H34.816z" fill="#8A75FA"></path>
                <path d="M274.432 389.12h240.128v240.64H274.432z" fill="#A08FFB"></path>
                <path d="M514.56 389.12h240.128v240.64h-240.128z" fill="#D6CFFE"></path>
                <path d="M754.688 148.48h240.128v240.64h-240.128z" fill="#AA9CFC"></path>
                <path d="M754.688 389.12h240.128v240.64h-240.128z" fill="#8A75FA"></path>
                <path d="M34.816 629.76h240.128v240.64H34.816z" fill="#D6CFFE"></path>
                <path d="M274.432 629.76h240.128v240.64H274.432z" fill="#8A75FA"></path>
                <path d="M514.56 629.76h240.128v240.64h-240.128z" fill="#AA9CFC"></path>
                <path d="M754.688 629.76h240.128v240.64h-240.128z" fill="#A08FFB"></path>
              </svg>
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">
                MultiCam Heatmap
              </div>
              <div className="text-[11px] text-slate-500">
                多路摄像头热力图解决方案
              </div>
            </div>
          </div>

          <nav className="space-y-2">
            <SidebarTabButton
              label="实时画面"
              tab="realtime"
              activeTab={activeTab}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="热力图"
              tab="heatmap"
              activeTab={activeTab}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="人员位置"
              tab="people"
              activeTab={activeTab}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="映射管理"
              tab="mapping"
              activeTab={activeTab}
              onChange={setActiveTab}
            />
          </nav>
        </aside>

        {/* 右侧内容区 */}
        <main className="flex-1 px-4 py-4">
          {activeTab === "realtime" && <RealtimeView />}
          {activeTab === "heatmap" && <HeatmapView />}
          {activeTab === "people" && <PeoplePositionView />}
          {activeTab === "mapping" && <MappingView />}
        </main>
      </div>
    </div>
  );
};

const ShareHeatmapPage: React.FC<{ params: URLSearchParams }> = ({ params }) => {
  const floorPlanId = Number(params.get("floor_plan_id") || "");
  const embed = params.get("embed") === "1" || params.get("embed") === "true";
  const showGrid = params.get("grid") === "1" || params.get("grid") === "true";
  const mode = (params.get("mode") || "current") as "current" | "history";
  const showPeople = params.get("people") === "1" || params.get("people") === "true";
  const refreshMsRaw = Number(params.get("refresh_ms") || "1000");
  const refreshMs = Math.min(60_000, Math.max(200, Number.isFinite(refreshMsRaw) ? refreshMsRaw : 1000));
  const scale = (params.get("scale") || "log") as "log" | "linear";
  const alphaMode = (params.get("alpha") || "byValue") as "byValue" | "fixed";
  const clip = (params.get("clip") || "p95") as "p95" | "p99" | "max";

  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [heatmapCells, setHeatmapCells] = useState<Map<string, number>>(new Map());
  const [poiCells, setPoiCells] = useState<Map<string, number>>(new Map());
  const [statusText, setStatusText] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeenByEntityRef = useRef<Map<string, { tsMs: number; cellKey: string }>>(new Map());
  const sourceStaleMs = 900;

  useEffect(() => {
    fetch(`${API_BASE}/api/floor-plans`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((fps: FloorPlan[]) => setFloorPlans(Array.isArray(fps) ? fps : []))
      .catch(() => setFloorPlans([]));
  }, []);

  const selectedFloorPlan = useMemo(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return null;
    return floorPlans.find((fp) => fp.id === floorPlanId) || null;
  }, [floorPlans, floorPlanId]);

  const imageUrl = useMemo(() => {
    if (!selectedFloorPlan) return "";
    return floorPlanImageUrl(selectedFloorPlan);
  }, [selectedFloorPlan]);

  const computeMax = useCallback(
    (m: Map<string, number>) => {
      const vals: number[] = [];
      m.forEach((v) => {
        if (Number.isFinite(v) && v > 0) vals.push(v);
      });
      if (vals.length === 0) return 1;
      vals.sort((a, b) => a - b);
      const pick = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * p)))];
      if (clip === "max") return vals[vals.length - 1];
      if (clip === "p99") return pick(0.99);
      return pick(0.95);
    },
    [clip],
  );

  const loadCurrent = useCallback(async () => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    try {
      const res = await fetch(`${API_BASE}/api/heatmap/current-dwell?floor_plan_id=${floorPlanId}`);
      const items: { floor_row: number; floor_col: number; dwell_sec: number }[] = res.ok ? await res.json() : [];
      const m = new Map<string, number>();
      items.forEach((it) => {
        const r = Number(it.floor_row);
        const c = Number(it.floor_col);
        const v = Number(it.dwell_sec);
        if (!Number.isFinite(r) || !Number.isFinite(c) || !Number.isFinite(v) || v <= 0) return;
        m.set(`${r},${c}`, v);
      });
      setHeatmapCells(m);
      setStatusText("");
    } catch {
      setStatusText("加载热力图数据失败");
    }
  }, [floorPlanId]);

  const loadHistory = useCallback(async () => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    const startTs = Number(params.get("start_ts") || "");
    const endTs = Number(params.get("end_ts") || "");
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs >= endTs) {
      setStatusText("历史参数缺失：start_ts / end_ts");
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/api/heatmap/history-dwell?floor_plan_id=${floorPlanId}&start_ts=${encodeURIComponent(
          String(startTs),
        )}&end_ts=${encodeURIComponent(String(endTs))}`,
      );
      const items: { floor_row: number; floor_col: number; dwell_sec: number }[] = res.ok ? await res.json() : [];
      const m = new Map<string, number>();
      items.forEach((it) => {
        const r = Number(it.floor_row);
        const c = Number(it.floor_col);
        const v = Number(it.dwell_sec);
        if (!Number.isFinite(r) || !Number.isFinite(c) || !Number.isFinite(v) || v <= 0) return;
        m.set(`${r},${c}`, v);
      });
      setHeatmapCells(m);
      setStatusText("");
    } catch {
      setStatusText("加载历史热力图失败");
    }
  }, [floorPlanId, params]);

  useEffect(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    if (mode === "history") {
      void loadHistory();
      return;
    }
    void loadCurrent();
    const t = window.setInterval(() => void loadCurrent(), refreshMs);
    return () => window.clearInterval(t);
  }, [floorPlanId, mode, loadCurrent, loadHistory, refreshMs]);

  const recomputePeople = useCallback(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    const nextByEntity = new Map<string, { tsMs: number; cellKey: string }>();
    lastSeenByEntityRef.current.forEach((v, k) => {
      if (now - v.tsMs > sourceStaleMs) return;
      nextByEntity.set(k, v);
      counts.set(v.cellKey, (counts.get(v.cellKey) || 0) + 1);
    });
    lastSeenByEntityRef.current = nextByEntity;
    setPoiCells(counts);
  }, [sourceStaleMs]);

  useEffect(() => {
    if (!showPeople || mode !== "current" || !Number.isFinite(floorPlanId) || floorPlanId <= 0) {
      wsRef.current?.close();
      wsRef.current = null;
      lastSeenByEntityRef.current = new Map();
      setPoiCells(new Map());
      return;
    }
    lastSeenByEntityRef.current = new Map();
    setPoiCells(new Map());
    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(/:\d+$/, ":18080")}/ws/heatmap-events`,
    );
    ws.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.floor_plan_id !== floorPlanId) return;
        const r = Number(evt.floor_row);
        const c = Number(evt.floor_col);
        if (!Number.isFinite(r) || !Number.isFinite(c)) return;
        const sourceKey =
          evt.virtual_view_id != null && Number.isFinite(Number(evt.virtual_view_id))
            ? `virtual:${Number(evt.virtual_view_id)}`
            : evt.camera_id != null && Number.isFinite(Number(evt.camera_id))
              ? `camera:${Number(evt.camera_id)}`
              : "unknown";
        const trackId = evt.track_id != null ? Number(evt.track_id) : NaN;
        const entityKey = Number.isFinite(trackId) ? `${sourceKey}:t${trackId}` : sourceKey;
        lastSeenByEntityRef.current.set(entityKey, { tsMs: Date.now(), cellKey: `${r},${c}` });
        recomputePeople();
      } catch {}
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
    wsRef.current = ws;
    const t = window.setInterval(recomputePeople, 250);
    return () => {
      window.clearInterval(t);
      if (wsRef.current === ws) {
        wsRef.current?.close();
        wsRef.current = null;
      } else {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [floorPlanId, mode, showPeople, recomputePeople]);

  const vMax = useMemo(() => computeMax(heatmapCells), [computeMax, heatmapCells]);

  return (
    <div className={`min-h-screen bg-slate-50 ${embed ? "" : "p-4"}`}>
      {!embed ? (
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">热力图展示</div>
          <div className="text-[11px] text-slate-500">
            {selectedFloorPlan ? selectedFloorPlan.name : `floor_plan_id=${String(floorPlanId || "")}`}
            {mode === "history" ? "（历史）" : "（实时）"}
          </div>
        </div>
      ) : null}
      <div className="relative h-[calc(100vh-32px)] w-full overflow-hidden rounded-lg border border-slate-200 bg-white">
        {statusText ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-xs text-slate-600">
            {statusText}
          </div>
        ) : null}
        {selectedFloorPlan && imageUrl ? (
          <FloorPlanCanvas
            imageUrl={imageUrl}
            gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
            gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
            showGrid={showGrid}
            backgroundColor="white"
            heatmapCells={heatmapCells}
            poiCells={showPeople && mode === "current" ? poiCells : undefined}
            heatmapRender={{
              colormap: "greenRed",
              scale,
              clip,
              alphaMode,
              vMax,
            }}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
            未找到平面图，请检查 floor_plan_id
          </div>
        )}
      </div>
    </div>
  );
};

const SharePeoplePage: React.FC<{ params: URLSearchParams }> = ({ params }) => {
  const floorPlanId = Number(params.get("floor_plan_id") || "");
  const embed = params.get("embed") === "1" || params.get("embed") === "true";
  const showGrid = params.get("grid") === "1" || params.get("grid") === "true";
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [poiCells, setPoiCells] = useState<Map<string, number>>(new Map());
  const [running, setRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeenByEntityRef = useRef<Map<string, { tsMs: number; cellKey: string }>>(new Map());
  const sourceStaleMs = 900;

  useEffect(() => {
    fetch(`${API_BASE}/api/floor-plans`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((fps: FloorPlan[]) => setFloorPlans(Array.isArray(fps) ? fps : []))
      .catch(() => setFloorPlans([]));
  }, []);

  const selectedFloorPlan = useMemo(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return null;
    return floorPlans.find((fp) => fp.id === floorPlanId) || null;
  }, [floorPlans, floorPlanId]);

  const imageUrl = useMemo(() => {
    if (!selectedFloorPlan) return "";
    return floorPlanImageUrl(selectedFloorPlan);
  }, [selectedFloorPlan]);

  const recompute = useCallback(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    const nextByEntity = new Map<string, { tsMs: number; cellKey: string }>();
    lastSeenByEntityRef.current.forEach((v, k) => {
      if (now - v.tsMs > sourceStaleMs) return;
      nextByEntity.set(k, v);
      counts.set(v.cellKey, (counts.get(v.cellKey) || 0) + 1);
    });
    lastSeenByEntityRef.current = nextByEntity;
    setPoiCells(counts);
  }, [sourceStaleMs]);

  const handleEvent = useCallback(
    (evt: any) => {
      if (evt.floor_plan_id !== floorPlanId) return;
      const r = Number(evt.floor_row);
      const c = Number(evt.floor_col);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      const sourceKey =
        evt.virtual_view_id != null && Number.isFinite(Number(evt.virtual_view_id))
          ? `virtual:${Number(evt.virtual_view_id)}`
          : evt.camera_id != null && Number.isFinite(Number(evt.camera_id))
            ? `camera:${Number(evt.camera_id)}`
            : "unknown";
      const trackId = evt.track_id != null ? Number(evt.track_id) : NaN;
      const entityKey = Number.isFinite(trackId) ? `${sourceKey}:t${trackId}` : sourceKey;
      lastSeenByEntityRef.current.set(entityKey, { tsMs: Date.now(), cellKey: `${r},${c}` });
      recompute();
    },
    [floorPlanId, recompute],
  );

  useEffect(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    const t = window.setInterval(recompute, 250);
    return () => window.clearInterval(t);
  }, [floorPlanId, recompute]);

  useEffect(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${API_BASE}/api/heatmap/status?floor_plan_id=${floorPlanId}`);
        const st = res.ok ? await res.json() : null;
        const nextRunning = !!st?.running;
        setRunning(nextRunning);
        if (nextRunning) {
          if (!wsRef.current) {
            const ws = new WebSocket(
              `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
                /:\d+$/,
                ":18080",
              )}/ws/heatmap-events`,
            );
            ws.onmessage = (ev) => {
              try {
                handleEvent(JSON.parse(ev.data));
              } catch {}
            };
            ws.onclose = () => {
              wsRef.current = null;
            };
            wsRef.current = ws;
          }
        } else {
          wsRef.current?.close();
          wsRef.current = null;
        }
      } catch {
      } finally {
        window.setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [floorPlanId, handleEvent]);

  return (
    <div className={`min-h-screen bg-slate-50 ${embed ? "" : "p-4"}`}>
      {!embed ? (
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">人员位置展示</div>
          <div className="text-[11px] text-slate-500">
            {selectedFloorPlan ? selectedFloorPlan.name : `floor_plan_id=${String(floorPlanId || "")}`}
          </div>
        </div>
      ) : null}
      <div className="relative h-[calc(100vh-32px)] w-full overflow-hidden rounded-lg border border-slate-200 bg-white">
        {!running ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-xs text-slate-600">
            当前未启动分析
          </div>
        ) : null}
        {selectedFloorPlan && imageUrl ? (
          <FloorPlanCanvas
            imageUrl={imageUrl}
            gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
            gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
            showGrid={showGrid}
            backgroundColor="white"
            poiCells={poiCells}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
            未找到平面图，请检查 floor_plan_id
          </div>
        )}
      </div>
    </div>
  );
};

const SidebarTabButton: React.FC<{
  label: string;
  tab: TabKey;
  activeTab: TabKey;
  onChange: (t: TabKey) => void;
}> = ({ label, tab, activeTab, onChange }) => (
  <button
    onClick={() => onChange(tab)}
    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
      activeTab === tab
        ? "bg-[#694FF9] text-white shadow-sm"
        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
    }`}
  >
    <span>{label}</span>
    <span
      className={`text-xs ${
        activeTab === tab ? "text-white/80" : "text-slate-400"
      }`}
    >
      →
    </span>
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

const MappedCamerasGrid: React.FC<{
  sources: HeatmapSource[];
  analyzing: boolean;
  vvFootfalls: Record<number, Footfall[]>;
}> = ({ sources, analyzing, vvFootfalls }) => {
  const slotCount = 6;
  const sourceKeyOf = useCallback((s: HeatmapSource) => {
    return s.kind === "virtual" && s.virtual_view_id
      ? `virtual:${s.virtual_view_id}`
      : `camera:${s.camera_id}`;
  }, []);
  const [pinnedSlots, setPinnedSlots] = useState<string[]>(() =>
    Array.from({ length: slotCount }, () => ""),
  );
  const [thumbPage, setThumbPage] = useState(1);
  const [thumbRefreshMs, setThumbRefreshMs] = useState<number>(3000);
  const [thumbObjUrl, setThumbObjUrl] = useState<Record<number, string>>({});
  const thumbPollIdxRef = useRef(0);
  const thumbInFlightRef = useRef<Record<number, boolean>>({});
  const [showMappedCamGrid, setShowMappedCamGrid] = useState(false);
  const [showFootfallOnCamGrid, setShowFootfallOnCamGrid] = useState(false);
  const [allVirtualViews, setAllVirtualViews] = useState<(CameraVirtualView & { camera_name?: string })[]>(
    [],
  );
  const [vvGridConfigs, setVvGridConfigs] = useState<Record<number, { polygon: Pt[]; grid_rows: number; grid_cols: number }>>(
    {},
  );

  useEffect(() => {
    fetch(`${API_BASE}/api/cameras/virtual-views/all`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((items) => setAllVirtualViews(items))
      .catch((e) => console.error(e));
  }, []);

  const vvMetaById = useMemo(() => {
    const m = new Map<number, CameraVirtualView>();
    allVirtualViews.forEach((v) => m.set(v.id, v));
    return m;
  }, [allVirtualViews]);

  const sourceByKey = useMemo(() => {
    const m = new Map<string, HeatmapSource>();
    sources.forEach((s) => m.set(sourceKeyOf(s as any), s as any));
    return m;
  }, [sources, sourceKeyOf]);

  useEffect(() => {
    setPinnedSlots((old) => {
      const existing = new Set(Array.from(sourceByKey.keys()));
      const next = old.map((k) => (k && existing.has(k) ? k : ""));
      const used = new Set(next.filter(Boolean));
      const orderedKeys = sources.map((s) => sourceKeyOf(s as any));
      for (let i = 0; i < next.length; i++) {
        if (next[i]) continue;
        const cand = orderedKeys.find((k) => !used.has(k));
        if (!cand) break;
        next[i] = cand;
        used.add(cand);
      }
      return next;
    });
    setThumbPage(1);
  }, [sources, sourceByKey, sourceKeyOf]);

  const remainingSources = useMemo(() => {
    const pinned = new Set(pinnedSlots.filter(Boolean));
    return sources.filter((s) => !pinned.has(sourceKeyOf(s as any))) as HeatmapSource[];
  }, [sources, pinnedSlots, sourceKeyOf]);

  const refreshThumb = useCallback(async (s: HeatmapSource) => {
    if (s.kind !== "virtual" || !s.virtual_view_id) return;
    const vvId = s.virtual_view_id;
    if (thumbInFlightRef.current[vvId]) return;
    thumbInFlightRef.current[vvId] = true;
    const url = `${API_BASE}/api/cameras/${s.camera_id}/virtual-views/${vvId}/snapshot.jpg?t=${Date.now()}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      if (res.status === 204) return;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = objUrl;
      });
      setThumbObjUrl((old) => {
        const prev = old[vvId];
        const next = { ...old, [vvId]: objUrl };
        if (prev && prev !== objUrl) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return next;
      });
    } catch {
    } finally {
      thumbInFlightRef.current[vvId] = false;
    }
  }, []);

  useEffect(() => {
    remainingSources.forEach((s) => {
      if (s.kind === "virtual" && s.virtual_view_id && !thumbObjUrl[s.virtual_view_id]) {
        void refreshThumb(s);
      }
    });
  }, [remainingSources, thumbObjUrl, refreshThumb]);

  useEffect(() => {
    const list = remainingSources.filter((s) => s.kind === "virtual" && !!s.virtual_view_id) as HeatmapSource[];
    if (list.length === 0) return;
    const tickMs = Math.max(200, Math.floor(thumbRefreshMs / Math.max(1, list.length)));
    const t = window.setInterval(() => {
      const idx = thumbPollIdxRef.current % list.length;
      thumbPollIdxRef.current = (thumbPollIdxRef.current + 1) % 1_000_000;
      void refreshThumb(list[idx]);
    }, tickMs);
    return () => window.clearInterval(t);
  }, [remainingSources, thumbRefreshMs, refreshThumb]);

  useEffect(() => {
    return () => {
      try {
        Object.values(thumbObjUrl).forEach((u) => {
          if (typeof u === "string" && u) URL.revokeObjectURL(u);
        });
      } catch {}
    };
  }, [thumbObjUrl]);

  useEffect(() => {
    if (!showMappedCamGrid) return;
    const ids = sources
      .filter((s) => s.kind === "virtual" && !!s.virtual_view_id)
      .map((s) => s.virtual_view_id as number);
    ids.forEach((viewId) => {
      if (vvGridConfigs[viewId]) return;
      fetch(`${API_BASE}/api/cameras/virtual-views/${viewId}/grid-config`)
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
          if (!cfg) return;
          let pts: Pt[] = [];
          try {
            const raw = JSON.parse(cfg.polygon_json || "[]");
            if (Array.isArray(raw)) {
              pts = raw
                .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
                .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
            }
          } catch {
            pts = [];
          }
          if (pts.length !== 4) return;
          const ordered = orderQuad(pts);
          setVvGridConfigs((old) => ({
            ...old,
            [viewId]: {
              polygon: ordered,
              grid_rows: Math.max(1, Number(cfg.grid_rows) || 1),
              grid_cols: Math.max(1, Number(cfg.grid_cols) || 1),
            },
          }));
        })
        .catch(() => {});
    });
  }, [showMappedCamGrid, sources, vvGridConfigs]);

  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">映射摄像头画面</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={showMappedCamGrid}
              onChange={(e) => setShowMappedCamGrid(e.target.checked)}
            />
            显示映射网格
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={showFootfallOnCamGrid}
              onChange={(e) => setShowFootfallOnCamGrid(e.target.checked)}
              disabled={!analyzing}
            />
            显示落脚点
          </label>
          <span className="text-[11px] text-slate-400">用于检查映射坐标</span>
        </div>
      </div>
      {sources.length === 0 ? (
        <p className="text-xs text-slate-500">
          暂无可用摄像头，请先在“摄像头管理”中添加并启用，后续在“映射管理”中关联到平面图。
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid auto-rows-max grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: slotCount }).map((_, slotIdx) => {
              const key = pinnedSlots[slotIdx] || "";
              const src = key ? (sourceByKey.get(key) as HeatmapSource | undefined) : undefined;
              return (
                <div
                  key={`slot-${slotIdx}`}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-black self-start"
                  draggable={!!key}
                  onDragStart={(e) => {
                    if (!key) return;
                    e.dataTransfer.setData("text/heatmap-slot-idx", String(slotIdx));
                    e.dataTransfer.setData("text/heatmap-source-key", key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const fromSlotStr = (e.dataTransfer.getData("text/heatmap-slot-idx") || "").trim();
                    const k = e.dataTransfer.getData("text/heatmap-source-key") || "";
                    if (!k) return;
                    const fromSlot = fromSlotStr ? Number(fromSlotStr) : Number.NaN;
                    if (
                      fromSlotStr &&
                      Number.isFinite(fromSlot) &&
                      fromSlot >= 0 &&
                      fromSlot < slotCount &&
                      fromSlot !== slotIdx
                    ) {
                      setPinnedSlots((old) => {
                        const next = [...old];
                        const tmp = next[slotIdx] || "";
                        next[slotIdx] = next[fromSlot] || "";
                        next[fromSlot] = tmp;
                        return next;
                      });
                      return;
                    }
                    setPinnedSlots((old) => {
                      const next = [...old];
                      next[slotIdx] = k;
                      return next;
                    });
                  }}
                  title={key ? "可拖拽到其他槽位交换顺序，或拖拽缩略图替换" : "拖拽下方缩略图到此槽位进行置顶关注"}
                >
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                    <span className="truncate">
                      {src
                        ? src.kind === "virtual"
                          ? `${src.camera_name} / ${src.virtual_view_name}`
                          : src.camera_name
                        : `槽位 ${slotIdx + 1}`}
                    </span>
                    <span className="text-slate-400">
                      {src
                        ? src.kind === "virtual"
                          ? `VV:${src.virtual_view_id}`
                          : `ID:${src.camera_id}`
                        : "拖拽替换"}
                    </span>
                  </div>
                  <div className="aspect-[4/3] w-full bg-black">
                    {src ? (
                      src.kind === "virtual" && src.virtual_view_id ? (
                        <div className="relative h-full w-full">
                          <img
                            src={`${API_BASE}/api/cameras/${src.camera_id}/virtual-views/${src.virtual_view_id}/${analyzing ? "analyzed" : "preview_shared"}.mjpeg`}
                            className="h-full w-full object-contain"
                            alt={`heatmap-virtual-${src.virtual_view_id}`}
                            draggable={false}
                          />
                          {showMappedCamGrid &&
                          vvGridConfigs[src.virtual_view_id] &&
                          vvMetaById.get(src.virtual_view_id) ? (
                            <VirtualViewGridOverlay
                              view={vvMetaById.get(src.virtual_view_id)!}
                              cfg={vvGridConfigs[src.virtual_view_id]}
                              highlightCells={showFootfallOnCamGrid ? vvFootfalls[src.virtual_view_id] ?? null : null}
                            />
                          ) : null}
                        </div>
                      ) : src.webrtc_url ? (
                        <iframe
                          src={src.webrtc_url}
                          className="h-full w-full border-none"
                          allow="autoplay; fullscreen"
                          title={`heatmap-camera-${src.camera_id}-slot-${slotIdx}`}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">
                          未配置播放地址
                        </div>
                      )
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">
                        拖拽缩略图到此处
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="min-h-0 rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-700">其余缩略图</div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 text-[11px] text-slate-500">
                  <span>刷新</span>
                  <select
                    className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]"
                    value={thumbRefreshMs}
                    onChange={(e) => setThumbRefreshMs(Number(e.target.value) || 3000)}
                    title="缩略图刷新频率（错峰轮询）"
                  >
                    <option value={1000}>1s</option>
                    <option value={3000}>3s</option>
                    <option value={5000}>5s</option>
                  </select>
                </div>
                <div className="text-[11px] text-slate-500">{remainingSources.length} 路</div>
              </div>
            </div>

            {(() => {
              const pageSize = 12;
              const totalPages = Math.max(1, Math.ceil(remainingSources.length / pageSize));
              const page = Math.min(totalPages, Math.max(1, thumbPage));
              const start = (page - 1) * pageSize;
              const items = remainingSources.slice(start, start + pageSize);
              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((s) => {
                      const k = sourceKeyOf(s as any);
                      const vvId = s.virtual_view_id || 0;
                      const snap = s.kind === "virtual" && vvId ? thumbObjUrl[vvId] || "" : "";
                      return (
                        <div
                          key={`thumb-${k}`}
                          className="overflow-hidden rounded border border-slate-200 bg-slate-50"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/heatmap-source-key", k);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          title="拖拽到上方某个槽位"
                        >
                          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-slate-700">
                            <span className="truncate">
                              {s.kind === "virtual" ? `${s.camera_name} / ${s.virtual_view_name}` : s.camera_name}
                            </span>
                            <span className="text-slate-400">
                              {s.kind === "virtual" ? `VV:${s.virtual_view_id}` : `ID:${s.camera_id}`}
                            </span>
                          </div>
                          <div className="aspect-[4/3] w-full bg-black">
                            {s.kind === "virtual" && vvId ? (
                              snap ? (
                                <img
                                  src={snap}
                                  className="h-full w-full object-contain"
                                  alt={`thumb-vv-${vvId}`}
                                  draggable={false}
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-200">
                                  暂无缩略图
                                </div>
                              )
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-200">
                                摄像头预览
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {totalPages > 1 ? (
                    <div className="flex items-center justify-between text-[11px] text-slate-600">
                      <button
                        className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 disabled:opacity-50"
                        disabled={page <= 1}
                        onClick={() => setThumbPage((p) => Math.max(1, p - 1))}
                      >
                        上一页
                      </button>
                      <div>
                        第 {page} / {totalPages} 页
                      </div>
                      <button
                        className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 disabled:opacity-50"
                        disabled={page >= totalPages}
                        onClick={() => setThumbPage((p) => Math.min(totalPages, p + 1))}
                      >
                        下一页
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

const HeatmapView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);
  const [heatmapSources, setHeatmapSources] = useState<HeatmapSource[]>([]);
  const [showHeatmapGrid, setShowHeatmapGrid] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [heatmapCells, setHeatmapCells] = useState<Map<string, number>>(new Map());
  const [heatmapColormap] = useState<"viridis" | "greenRed">("greenRed");
  const [heatmapScale, setHeatmapScale] = useState<"log" | "linear">("log");
  const [heatmapClip] = useState<"p95" | "p99" | "max">("p95");
  const [heatmapAlphaMode, setHeatmapAlphaMode] = useState<"byValue" | "fixed">("byValue");
  const [showHeatmapLegend, setShowHeatmapLegend] = useState(true);
  const [heatmapRecentMode, setHeatmapRecentMode] = useState(true);
  const [heatmapHalfLifeSec, setHeatmapHalfLifeSec] = useState<number>(60);
  const [heatmapDataMode, setHeatmapDataMode] = useState<"live" | "history">("live");
  const heatmapUpdatesEnabledRef = useRef(true);
  const toDatetimeLocal = useCallback((d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }, []);
  const [historyEndLocal, setHistoryEndLocal] = useState<string>(() => toDatetimeLocal(new Date()));
  const [historyStartLocal, setHistoryStartLocal] = useState<string>(() =>
    toDatetimeLocal(new Date(Date.now() - 10 * 60 * 1000)),
  );
  const [recordHistory, setRecordHistory] = useState(true);
  const [vvFootfalls, setVvFootfalls] = useState<Record<number, Footfall[]>>({});
  const [showPeopleOverlay, setShowPeopleOverlay] = useState(false);
  const showPeopleOverlayRef = useRef(false);
  const [poiCells, setPoiCells] = useState<Map<string, number>>(new Map());
  const poiLastSeenByEntityRef = useRef<Map<string, { tsMs: number; cellKey: string }>>(new Map());
  const poiSourceStaleMs = 900;
  const wsRef = useRef<WebSocket | null>(null);
  const lastSampleByEntityRef = useRef<Map<string, { ts: number; cellKey: string }>>(new Map());
  const lastDecayAtRef = useRef<number | null>(null);

  useEffect(() => {
    heatmapUpdatesEnabledRef.current = heatmapDataMode === "live";
  }, [heatmapDataMode]);

  useEffect(() => {
    showPeopleOverlayRef.current = showPeopleOverlay;
    if (!showPeopleOverlay) {
      poiLastSeenByEntityRef.current = new Map();
      setPoiCells(new Map());
    }
  }, [showPeopleOverlay]);

  const recomputePoiOverlay = useCallback(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    const nextByEntity = new Map<string, { tsMs: number; cellKey: string }>();
    poiLastSeenByEntityRef.current.forEach((v, k) => {
      if (now - v.tsMs > poiSourceStaleMs) return;
      nextByEntity.set(k, v);
      counts.set(v.cellKey, (counts.get(v.cellKey) || 0) + 1);
    });
    poiLastSeenByEntityRef.current = nextByEntity;
    setPoiCells(counts);
  }, [poiSourceStaleMs]);

  useEffect(() => {
    if (!analyzing || heatmapDataMode !== "live" || !showPeopleOverlay) return;
    const t = window.setInterval(recomputePoiOverlay, 250);
    return () => window.clearInterval(t);
  }, [analyzing, heatmapDataMode, showPeopleOverlay, recomputePoiOverlay]);

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
      // 方案 A：预加载所有平面图图片
      fpData.forEach((fp) => {
        const url = floorPlanImageUrl(fp);
        void preloadFloorPlanImage(url);
      });
      if (fpData.length > 0 && selectedFloorPlanId === null) {
        setSelectedFloorPlanId(fpData[0].id);
      }
    };
    load();
  }, [selectedFloorPlanId]);

  const applyHeatmapDecay = useCallback((dtSec: number) => {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;
    const halfLife = Math.max(1, Number(heatmapHalfLifeSec) || 60);
    const factor = Math.pow(0.5, dtSec / halfLife);
    setHeatmapCells((old) => {
      if (old.size === 0) return old;
      const next = new Map<string, number>();
      old.forEach((v, k) => {
        const nv = v * factor;
        if (nv > 1e-4) next.set(k, nv);
      });
      return next;
    });
  }, [heatmapHalfLifeSec]);

  useEffect(() => {
    if (!analyzing || !heatmapRecentMode || heatmapDataMode !== "live") {
      lastDecayAtRef.current = null;
      return;
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      const prev = lastDecayAtRef.current;
      lastDecayAtRef.current = now;
      if (prev != null) {
        const dtSec = (now - prev) / 1000;
        applyHeatmapDecay(dtSec);
      }
      setTimeout(tick, 300);
    };
    tick();
    return () => {
      stopped = true;
      lastDecayAtRef.current = null;
    };
  }, [analyzing, heatmapRecentMode, heatmapDataMode, applyHeatmapDecay]);

  const handleHeatmapEvent = useCallback((evt: any, floorPlanId: number) => {
    if (evt.floor_plan_id !== floorPlanId) return;
    const r = Number(evt.floor_row);
    const c = Number(evt.floor_col);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    const cellKey = `${r},${c}`;

    const sourceKey =
      evt.virtual_view_id != null && Number.isFinite(Number(evt.virtual_view_id))
        ? `virtual:${Number(evt.virtual_view_id)}`
        : evt.camera_id != null && Number.isFinite(Number(evt.camera_id))
          ? `camera:${Number(evt.camera_id)}`
          : "unknown";
    const trackId = evt.track_id != null ? Number(evt.track_id) : NaN;
    const entityKey = Number.isFinite(trackId) ? `${sourceKey}:t${trackId}` : sourceKey;

    const tsRaw = Number(evt.ts);
    const ts = Number.isFinite(tsRaw) ? tsRaw : performance.now() / 1000;

    const prev = lastSampleByEntityRef.current.get(entityKey);
    if (prev) {
      const dt = Math.max(0, Math.min(ts - prev.ts, 2));
      if (dt > 0) {
        setHeatmapCells((old) => {
          const next = new Map(old);
          next.set(prev.cellKey, (next.get(prev.cellKey) || 0) + dt);
          return next;
        });
      }
    }
    lastSampleByEntityRef.current.set(entityKey, { ts, cellKey });

    if (
      evt.virtual_view_id != null &&
      Number.isFinite(Number(evt.virtual_view_id)) &&
      evt.camera_row != null &&
      evt.camera_col != null
    ) {
      const vvId = Number(evt.virtual_view_id);
      const rr = Number(evt.camera_row);
      const cc = Number(evt.camera_col);
      if (Number.isFinite(rr) && Number.isFinite(cc)) {
        const now = Date.now();
        setVvFootfalls((old) => {
          const prev = Array.isArray(old[vvId]) ? old[vvId] : [];
          const fresh = prev.filter((p) => now - p.ts <= 1200);
          const withoutSame = fresh.filter((p) => !(p.row === rr && p.col === cc));
          const nextList = [...withoutSame, { row: rr, col: cc, ts: now }].slice(-6);
          return { ...old, [vvId]: nextList };
        });
      }
    }
  }, []);

  const handlePoiOverlayEvent = useCallback(
    (evt: any, floorPlanId: number) => {
      if (!showPeopleOverlayRef.current) return;
      if (heatmapDataMode !== "live") return;
      if (evt.floor_plan_id !== floorPlanId) return;
      const r = Number(evt.floor_row);
      const c = Number(evt.floor_col);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      const sourceKey =
        evt.virtual_view_id != null && Number.isFinite(Number(evt.virtual_view_id))
          ? `virtual:${Number(evt.virtual_view_id)}`
          : evt.camera_id != null && Number.isFinite(Number(evt.camera_id))
            ? `camera:${Number(evt.camera_id)}`
            : "unknown";
      const trackId = evt.track_id != null ? Number(evt.track_id) : NaN;
      const entityKey = Number.isFinite(trackId) ? `${sourceKey}:t${trackId}` : sourceKey;
      poiLastSeenByEntityRef.current.set(entityKey, { tsMs: Date.now(), cellKey: `${r},${c}` });
      recomputePoiOverlay();
    },
    [heatmapDataMode, recomputePoiOverlay],
  );

  const loadCurrentDwellFromBackend = useCallback(async (floorPlanId: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/heatmap/current-dwell?floor_plan_id=${floorPlanId}`);
      const items: { floor_row: number; floor_col: number; dwell_sec: number }[] = res.ok ? await res.json() : [];
      const m = new Map<string, number>();
      items.forEach((it) => {
        const r = Number(it.floor_row);
        const c = Number(it.floor_col);
        const v = Number(it.dwell_sec);
        if (!Number.isFinite(r) || !Number.isFinite(c) || !Number.isFinite(v) || v <= 0) return;
        m.set(`${r},${c}`, v);
      });
      setHeatmapCells(m);
      lastSampleByEntityRef.current = new Map();
    } catch {
      // ignore
    }
  }, []);

  const parseDatetimeLocalToEpochSec = useCallback((s: string) => {
    const ms = new Date(s).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms / 1000;
  }, []);

  const loadHistoryDwellFromBackend = useCallback(async (floorPlanId: number, startLocal: string, endLocal: string) => {
    const startTs = parseDatetimeLocalToEpochSec(startLocal);
    const endTs = parseDatetimeLocalToEpochSec(endLocal);
    if (startTs == null || endTs == null || startTs >= endTs) {
      alert("历史时间范围不合法");
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/api/heatmap/history-dwell?floor_plan_id=${floorPlanId}&start_ts=${encodeURIComponent(
          String(startTs),
        )}&end_ts=${encodeURIComponent(String(endTs))}`,
      );
      const items: { floor_row: number; floor_col: number; dwell_sec: number }[] = res.ok ? await res.json() : [];
      const m = new Map<string, number>();
      items.forEach((it) => {
        const r = Number(it.floor_row);
        const c = Number(it.floor_col);
        const v = Number(it.dwell_sec);
        if (!Number.isFinite(r) || !Number.isFinite(c) || !Number.isFinite(v) || v <= 0) return;
        m.set(`${r},${c}`, v);
      });
      setHeatmapCells(m);
      lastSampleByEntityRef.current = new Map();
    } catch {
      alert("加载历史失败");
    }
  }, [parseDatetimeLocalToEpochSec]);

  // 恢复状态：切换模块回来时，如果后端仍在分析，则自动重连 WS 并恢复按钮状态
  useEffect(() => {
    let cancelled = false;
    const fpId = selectedFloorPlanId;
    if (fpId == null) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/heatmap/status?floor_plan_id=${fpId}`);
        const st = res.ok ? await res.json() : null;
        if (cancelled || !st) return;
        setRecordHistory(!!st.record_history);
        const shouldRun = !!st.running;
        // 如果需要运行且 WS 未连接，则连接
        if (shouldRun) {
          if (wsRef.current) return;
          setHeatmapDataMode("live");
          void loadCurrentDwellFromBackend(fpId);
          lastSampleByEntityRef.current = new Map();
          const ws = new WebSocket(
            `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
              /:\d+$/,
              ":18080",
            )}/ws/heatmap-events`,
          );
          ws.onmessage = (ev) => {
            try {
              const evt = JSON.parse(ev.data);
              if (!heatmapUpdatesEnabledRef.current) return;
              handleHeatmapEvent(evt, fpId);
              handlePoiOverlayEvent(evt, fpId);
            } catch (e) {
              console.error(e);
            }
          };
          ws.onclose = () => {
            wsRef.current = null;
            setAnalyzing(false);
          };
          wsRef.current = ws;
          setAnalyzing(true);
        } else {
          // 后端不在运行：确保前端状态关闭
          wsRef.current?.close();
          wsRef.current = null;
          setAnalyzing(false);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFloorPlanId, handleHeatmapEvent, loadCurrentDwellFromBackend]);

  // 卸载时关闭 WS（不自动 stop 后端分析；回到页面会根据 status 恢复）
  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (selectedFloorPlanId == null) {
      setHeatmapSources([]);
      return;
    }
    fetch(`${API_BASE}/api/floor-plans/${selectedFloorPlanId}/heatmap-sources`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((items) => setHeatmapSources(items))
      .catch((e) => console.error(e));
  }, [selectedFloorPlanId]);

  const mappedCameras = useMemo(() => {
    // 只显示后端给出的 sources（保持顺序），并过滤掉 disabled 的 camera
    const camMap = new Map<number, Camera>();
    cameras.forEach((c) => camMap.set(c.id, c));
    return heatmapSources.filter((s) => {
      const c = camMap.get(s.camera_id);
      return !!c && c.enabled;
    });
  }, [cameras, heatmapSources]);

  const selectedFloorPlan = floorPlans.find((fp) => fp.id === selectedFloorPlanId) || null;
  const floorPlanImageUrlStr =
    selectedFloorPlan && selectedFloorPlan.image_path.startsWith("/data/maps/")
      ? `${API_BASE}/maps/${selectedFloorPlan.image_path.split("/").pop()}`
      : null;

  const computeHeatmapMax = useCallback(() => {
    const vals: number[] = [];
    heatmapCells.forEach((v) => {
      if (Number.isFinite(v) && v > 0) vals.push(v);
    });
    if (vals.length === 0) return 1;
    vals.sort((a, b) => a - b);
    const pick = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * p)))];
    if (heatmapClip === "max") return vals[vals.length - 1];
    if (heatmapClip === "p99") return pick(0.99);
    return pick(0.95);
  }, [heatmapCells, heatmapClip]);

  const legendMax = useMemo(() => {
    const mx = computeHeatmapMax();
    return mx > 0 ? mx : 1;
  }, [computeHeatmapMax]);

  const formatDuration = useCallback((sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0) return "0s";
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    if (m < 60) return `${m}m${s ? `${s}s` : ""}`;
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    return `${h}h${mm ? `${mm}m` : ""}`;
  }, []);

  const heatmapLegendGradient = useMemo(() => {
    if (heatmapColormap === "greenRed") {
      return "linear-gradient(to right, rgb(187,247,208), rgb(34,197,94), rgb(249,115,22), rgb(239,68,68))";
    }
    return "linear-gradient(to right, #440154, #482878, #3E4989, #31688E, #26828E, #1F9E89, #35B779, #6CCE59, #B4DE2C, #FDE725)";
  }, [heatmapColormap]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">热力图与映射摄像头</h2>
      <p className="text-xs text-slate-500">
        左侧显示当前选择的平面图热力图，右侧以宫格形式展示参与该热力图的摄像头画面。
        映射关系和底图上传将在“映射管理”模块中配置。
      </p>

      <div className="mb-2 flex items-center justify-between">
        <div />
        <div className="flex items-center gap-3">
          <button
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              if (!selectedFloorPlanId) return;
              const base = `${window.location.origin}${window.location.pathname}#/share/heatmap`;
              const qp = new URLSearchParams();
              qp.set("floor_plan_id", String(selectedFloorPlanId));
              qp.set("embed", "1");
              qp.set("grid", showHeatmapGrid ? "1" : "0");
              qp.set("refresh_ms", "1000");
              qp.set("scale", heatmapScale);
              qp.set("alpha", heatmapAlphaMode);
              qp.set("clip", heatmapClip);
              qp.set("people", showPeopleOverlay && heatmapDataMode === "live" ? "1" : "0");
              if (heatmapDataMode === "history") {
                const startTs = parseDatetimeLocalToEpochSec(historyStartLocal);
                const endTs = parseDatetimeLocalToEpochSec(historyEndLocal);
                qp.set("mode", "history");
                if (startTs != null) qp.set("start_ts", String(startTs));
                if (endTs != null) qp.set("end_ts", String(endTs));
              } else {
                qp.set("mode", "current");
              }
              const url = `${base}?${qp.toString()}`;
              const ok = await copyToClipboard(url);
              if (ok) alert("已复制分享链接");
              else window.prompt("复制链接", url);
            }}
            title="生成可分享/可嵌入的展示链接（只展示，不包含侧边栏）"
          >
            分享
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={recordHistory}
              onChange={(e) => setRecordHistory(e.target.checked)}
              disabled={analyzing}
            />
            录制历史
          </label>
          <button
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              setHeatmapCells(new Map());
              lastSampleByEntityRef.current = new Map();
              if (selectedFloorPlanId) {
                try {
                  await fetch(`${API_BASE}/api/heatmap/reset-current?floor_plan_id=${selectedFloorPlanId}`, {
                    method: "POST",
                  });
                } catch {}
              }
            }}
            disabled={analyzing && heatmapRecentMode}
            title={analyzing && heatmapRecentMode ? "开启“最近热度(衰减)”时会自动变化，建议先关闭再清空" : "清空热力数据"}
          >
            清空热力
          </button>
          <button
            className={`rounded px-3 py-1 text-xs font-medium text-white ${
              analyzing ? "bg-rose-500 hover:bg-rose-600" : "bg-[#694FF9] hover:bg-[#5b3ff6]"
            }`}
            onClick={async () => {
              if (!selectedFloorPlanId) return;
              try {
                if (!analyzing) {
                  setHeatmapDataMode("live");
                  setHeatmapCells(new Map());
                  lastSampleByEntityRef.current = new Map();
                  await fetch(
                    `${API_BASE}/api/heatmap/start?floor_plan_id=${selectedFloorPlanId}&record_history=${
                      recordHistory ? "true" : "false"
                    }`,
                    { method: "POST" },
                  );
                // 连接 WebSocket
                const ws = new WebSocket(
                  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
                    /:\d+$/,
                    ":18080",
                  )}/ws/heatmap-events`,
                );
                ws.onmessage = (ev) => {
                  try {
                    const evt = JSON.parse(ev.data);
                    if (!heatmapUpdatesEnabledRef.current) return;
                    handleHeatmapEvent(evt, selectedFloorPlanId);
                    handlePoiOverlayEvent(evt, selectedFloorPlanId);
                  } catch (e) {
                    console.error(e);
                  }
                };
                ws.onclose = () => {
                  wsRef.current = null;
                  setAnalyzing(false);
                };
                wsRef.current = ws;
                setAnalyzing(true);
                } else {
                  await fetch(
                    `${API_BASE}/api/heatmap/stop?floor_plan_id=${selectedFloorPlanId}`,
                    { method: "POST" },
                  );
                  wsRef.current?.close();
                  wsRef.current = null;
                  setAnalyzing(false);
                  setVvFootfalls({});
                  lastSampleByEntityRef.current = new Map();
                  poiLastSeenByEntityRef.current = new Map();
                  setPoiCells(new Map());
                  // 视情况决定是否清空热力
                  // setHeatmapCells(new Map());
                }
              } catch (e) {
                console.error(e);
                alert("热力图分析启动/停止失败");
              }
            }}
          >
            {analyzing ? "停止热力图分析" : "启动热力图分析"}
          </button>
        </div>
      </div>

      {/* 参考“映射管理/映射绑定”的高度自适应方案：用固定视口高度 + 内部 min-h-0 */}
      <div className="grid h-[calc(100vh-220px)] min-h-0 gap-4 md:grid-cols-[2fr,3fr]">
        {/* 左侧：热力图区域 */}
        <div className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">热力图预览</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={showHeatmapGrid}
                  onChange={(e) => setShowHeatmapGrid(e.target.checked)}
                />
                显示网格
              </label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={showHeatmapLegend}
                  onChange={(e) => setShowHeatmapLegend(e.target.checked)}
                />
                显示色标
              </label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={heatmapRecentMode}
                  onChange={(e) => setHeatmapRecentMode(e.target.checked)}
                />
                最近热度
              </label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={showPeopleOverlay}
                  onChange={(e) => setShowPeopleOverlay(e.target.checked)}
                  disabled={heatmapDataMode !== "live"}
                  title={heatmapDataMode !== "live" ? "历史回放模式下不叠加人员位置" : "在热力图上叠加显示人员位置 POI"}
                />
                显示人员位置
              </label>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={heatmapScale}
                onChange={(e) => setHeatmapScale(e.target.value as any)}
                title="强度映射"
              >
                <option value="log">对数</option>
                <option value="linear">线性</option>
              </select>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={heatmapAlphaMode}
                onChange={(e) => setHeatmapAlphaMode(e.target.value as any)}
                title="透明度"
              >
                <option value="byValue">随强度</option>
                <option value="fixed">固定</option>
              </select>
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
          {showHeatmapLegend ? (
            <div className="mb-2 flex items-center gap-3">
              <div className="h-2 flex-1 rounded" style={{ background: heatmapLegendGradient }} />
              <div className="flex items-center gap-2 text-[11px] text-slate-600">
                <span>0</span>
                <span className="text-slate-400">→</span>
                <span>{formatDuration(legendMax / 2)}</span>
                <span className="text-slate-400">→</span>
                <span>{formatDuration(legendMax)}</span>
              </div>
              {heatmapRecentMode ? (
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span className="text-slate-400">半衰期</span>
                  <input
                    type="range"
                    min={10}
                    max={300}
                    value={heatmapHalfLifeSec}
                    onChange={(e) => setHeatmapHalfLifeSec(Number(e.target.value) || 60)}
                  />
                  <span className="w-10 text-right">{heatmapHalfLifeSec}s</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">数据源：</span>
            <button
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                heatmapDataMode === "live"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              onClick={() => {
                setHeatmapDataMode("live");
                if (selectedFloorPlanId) void loadCurrentDwellFromBackend(selectedFloorPlanId);
              }}
              disabled={!selectedFloorPlanId}
              title="从后端当前统计同步（即使关闭浏览器后再打开也可查看）"
            >
              当前统计
            </button>
            <button
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                heatmapDataMode === "history"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              onClick={() => setHeatmapDataMode("history")}
              title="历史回放会暂停实时热力更新（不影响后端继续分析）"
            >
              历史回放
            </button>
            {heatmapDataMode === "history" ? (
              <>
                <input
                  type="datetime-local"
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                  value={historyStartLocal}
                  onChange={(e) => setHistoryStartLocal(e.target.value)}
                  title="开始时间"
                />
                <span className="text-[11px] text-slate-400">→</span>
                <input
                  type="datetime-local"
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                  value={historyEndLocal}
                  onChange={(e) => setHistoryEndLocal(e.target.value)}
                  title="结束时间"
                />
                <button
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    if (!selectedFloorPlanId) return;
                    void loadHistoryDwellFromBackend(selectedFloorPlanId, historyStartLocal, historyEndLocal);
                  }}
                  disabled={!selectedFloorPlanId}
                >
                  加载
                </button>
              </>
            ) : (
              <button
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  if (selectedFloorPlanId) void loadCurrentDwellFromBackend(selectedFloorPlanId);
                }}
                disabled={!selectedFloorPlanId}
                title="手动从后端同步一次当前热力"
              >
                同步
              </button>
            )}
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {floorPlanImageUrlStr && selectedFloorPlan ? (
              <FloorPlanCanvas
                imageUrl={floorPlanImageUrlStr}
                gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
                gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
                showGrid={showHeatmapGrid}
                backgroundColor="white"
                heatmapCells={heatmapCells}
                poiCells={showPeopleOverlay ? poiCells : undefined}
                heatmapRender={{
                  colormap: heatmapColormap,
                  scale: heatmapScale,
                  clip: heatmapClip,
                  alphaMode: heatmapAlphaMode,
                  vMax: legendMax,
                }}
                className="w-full h-full"
              />
            ) : (
              <span className="text-xs text-slate-400">
                当前无平面图配置，请在“映射管理”中上传或选择平面图。
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>热力值：估算停留时长（秒）</span>
            <span>上限：{formatDuration(legendMax)}（{heatmapClip} · {heatmapScale}）</span>
          </div>
        </div>

        {/* 右侧：摄像头宫格 */}
        <MappedCamerasGrid sources={mappedCameras} analyzing={analyzing} vvFootfalls={vvFootfalls} />
      </div>
    </div>
  );
};

const PeoplePositionView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);
  const [heatmapSources, setHeatmapSources] = useState<HeatmapSource[]>([]);
  const [showGrid, setShowGrid] = useState(false);
  const [showTrackId, setShowTrackId] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [recordHistory, setRecordHistory] = useState(true);
  const [poiCells, setPoiCells] = useState<Map<string, number>>(new Map());
  const [poiTrackIdsByCell, setPoiTrackIdsByCell] = useState<Map<string, number[]>>(new Map());
  const [vvFootfalls, setVvFootfalls] = useState<Record<number, Footfall[]>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeenByEntityRef = useRef<Map<string, { tsMs: number; cellKey: string; trackId: number | null }>>(new Map());
  const sourceStaleMs = 900;

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
      fpData.forEach((fp) => {
        const url = floorPlanImageUrl(fp);
        void preloadFloorPlanImage(url);
      });
      if (fpData.length > 0 && selectedFloorPlanId === null) {
        setSelectedFloorPlanId(fpData[0].id);
      }
    };
    load();
  }, [selectedFloorPlanId]);

  useEffect(() => {
    if (selectedFloorPlanId == null) {
      setHeatmapSources([]);
      lastSeenByEntityRef.current = new Map();
      setPoiCells(new Map());
      setPoiTrackIdsByCell(new Map());
      return;
    }
    fetch(`${API_BASE}/api/floor-plans/${selectedFloorPlanId}/heatmap-sources`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((items) => setHeatmapSources(items))
      .catch((e) => console.error(e));
  }, [selectedFloorPlanId]);

  const mappedCameras = useMemo(() => {
    const camMap = new Map<number, Camera>();
    cameras.forEach((c) => camMap.set(c.id, c));
    return heatmapSources.filter((s) => {
      const c = camMap.get(s.camera_id);
      return !!c && c.enabled;
    });
  }, [cameras, heatmapSources]);

  const selectedFloorPlan = floorPlans.find((fp) => fp.id === selectedFloorPlanId) || null;
  const floorPlanImageUrlStr =
    selectedFloorPlan && selectedFloorPlan.image_path.startsWith("/data/maps/")
      ? `${API_BASE}/maps/${selectedFloorPlan.image_path.split("/").pop()}`
      : selectedFloorPlan
        ? selectedFloorPlan.image_path
        : null;

  const recomputePoiCells = useCallback(() => {
    const now = Date.now();
    const counts = new Map<string, number>();
    const tidsByCell = new Map<string, number[]>();
    const nextByEntity = new Map<string, { tsMs: number; cellKey: string; trackId: number | null }>();
    lastSeenByEntityRef.current.forEach((v, k) => {
      if (now - v.tsMs > sourceStaleMs) return;
      nextByEntity.set(k, v);
      counts.set(v.cellKey, (counts.get(v.cellKey) || 0) + 1);
      if (v.trackId != null) {
        const arr = tidsByCell.get(v.cellKey) || [];
        arr.push(v.trackId);
        tidsByCell.set(v.cellKey, arr);
      }
    });
    lastSeenByEntityRef.current = nextByEntity;
    setPoiCells(counts);
    setPoiTrackIdsByCell(tidsByCell);
  }, [sourceStaleMs]);

  const handleEvent = useCallback(
    (evt: any, floorPlanId: number) => {
      if (evt.floor_plan_id !== floorPlanId) return;
      const r = Number(evt.floor_row);
      const c = Number(evt.floor_col);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      const cellKey = `${r},${c}`;

      const sourceKey =
        evt.virtual_view_id != null && Number.isFinite(Number(evt.virtual_view_id))
          ? `virtual:${Number(evt.virtual_view_id)}`
          : evt.camera_id != null && Number.isFinite(Number(evt.camera_id))
            ? `camera:${Number(evt.camera_id)}`
            : "unknown";

      const trackId = evt.track_id != null ? Number(evt.track_id) : NaN;
      const entityKey = Number.isFinite(trackId) ? `${sourceKey}:t${trackId}` : sourceKey;
      lastSeenByEntityRef.current.set(entityKey, { tsMs: Date.now(), cellKey, trackId: Number.isFinite(trackId) ? trackId : null });

      if (
        evt.virtual_view_id != null &&
        Number.isFinite(Number(evt.virtual_view_id)) &&
        evt.camera_row != null &&
        evt.camera_col != null
      ) {
        const vvId = Number(evt.virtual_view_id);
        const rr = Number(evt.camera_row);
        const cc = Number(evt.camera_col);
        if (Number.isFinite(rr) && Number.isFinite(cc)) {
          const now = Date.now();
          setVvFootfalls((old) => {
            const prev = Array.isArray(old[vvId]) ? old[vvId] : [];
            const fresh = prev.filter((p) => now - p.ts <= 1200);
            const withoutSame = fresh.filter((p) => !(p.row === rr && p.col === cc));
            const nextList = [...withoutSame, { row: rr, col: cc, ts: now }].slice(-6);
            return { ...old, [vvId]: nextList };
          });
        }
      }

      recomputePoiCells();
    },
    [recomputePoiCells],
  );

  useEffect(() => {
    if (!analyzing) return;
    const t = window.setInterval(() => {
      recomputePoiCells();
    }, 250);
    return () => window.clearInterval(t);
  }, [analyzing, recomputePoiCells]);

  useEffect(() => {
    let cancelled = false;
    const fpId = selectedFloorPlanId;
    if (fpId == null) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/heatmap/status?floor_plan_id=${fpId}`);
        const st = res.ok ? await res.json() : null;
        if (cancelled || !st) return;
        setRecordHistory(!!st.record_history);
        const shouldRun = !!st.running;
        if (shouldRun) {
          if (wsRef.current) return;
          lastSeenByEntityRef.current = new Map();
          setPoiCells(new Map());
          setPoiTrackIdsByCell(new Map());
          const ws = new WebSocket(
            `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
              /:\d+$/,
              ":18080",
            )}/ws/heatmap-events`,
          );
          ws.onmessage = (ev) => {
            try {
              const evt = JSON.parse(ev.data);
              handleEvent(evt, fpId);
            } catch (e) {
              console.error(e);
            }
          };
          ws.onclose = () => {
            wsRef.current = null;
            setAnalyzing(false);
          };
          wsRef.current = ws;
          setAnalyzing(true);
        } else {
          wsRef.current?.close();
          wsRef.current = null;
          setAnalyzing(false);
        }
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFloorPlanId, handleEvent]);

  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">人员位置与映射摄像头</h2>
      <p className="text-xs text-slate-500">
        左侧显示平面图网格内的人员 POI（由 YOLO 落脚点映射得到），右侧展示参与映射的摄像头画面用于核对。
      </p>

      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="text-sm text-slate-600">选择平面图：</label>
          <select
            className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
            value={selectedFloorPlanId ?? ""}
            onChange={(e) => setSelectedFloorPlanId(Number(e.target.value))}
          >
            {floorPlans.map((fp) => (
              <option key={fp.id} value={fp.id}>
                {fp.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              if (!selectedFloorPlanId) return;
              const base = `${window.location.origin}${window.location.pathname}#/share/people`;
              const qp = new URLSearchParams();
              qp.set("floor_plan_id", String(selectedFloorPlanId));
              qp.set("embed", "1");
              qp.set("grid", showGrid ? "1" : "0");
              const url = `${base}?${qp.toString()}`;
              const ok = await copyToClipboard(url);
              if (ok) alert("已复制分享链接");
              else window.prompt("复制链接", url);
            }}
            title="生成可分享/可嵌入的展示链接（只展示，不包含侧边栏）"
          >
            分享
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={recordHistory}
              onChange={(e) => setRecordHistory(e.target.checked)}
              disabled={analyzing}
            />
            录制历史
          </label>
          <button
            className={`rounded px-3 py-1 text-xs font-medium text-white ${
              analyzing ? "bg-rose-500 hover:bg-rose-600" : "bg-[#694FF9] hover:bg-[#5b3ff6]"
            }`}
            onClick={async () => {
              if (!selectedFloorPlanId) return;
              try {
                if (!analyzing) {
                  lastSeenByEntityRef.current = new Map();
                  setPoiCells(new Map());
                  setPoiTrackIdsByCell(new Map());
                  await fetch(
                    `${API_BASE}/api/heatmap/start?floor_plan_id=${selectedFloorPlanId}&record_history=${
                      recordHistory ? "true" : "false"
                    }`,
                    { method: "POST" },
                  );
                  const ws = new WebSocket(
                    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
                      /:\d+$/,
                      ":18080",
                    )}/ws/heatmap-events`,
                  );
                  ws.onmessage = (ev) => {
                    try {
                      const evt = JSON.parse(ev.data);
                      handleEvent(evt, selectedFloorPlanId);
                    } catch (e) {
                      console.error(e);
                    }
                  };
                  ws.onclose = () => {
                    wsRef.current = null;
                    setAnalyzing(false);
                  };
                  wsRef.current = ws;
                  setAnalyzing(true);
                } else {
                  await fetch(`${API_BASE}/api/heatmap/stop?floor_plan_id=${selectedFloorPlanId}`, { method: "POST" });
                  wsRef.current?.close();
                  wsRef.current = null;
                  setAnalyzing(false);
                  setVvFootfalls({});
                  lastSeenByEntityRef.current = new Map();
                  setPoiCells(new Map());
                  setPoiTrackIdsByCell(new Map());
                }
              } catch (e) {
                console.error(e);
                alert("人员位置分析启动/停止失败");
              }
            }}
          >
            {analyzing ? "停止分析" : "启动分析"}
          </button>
        </div>
      </div>

      <div className="grid h-[calc(100vh-220px)] min-h-0 gap-4 md:grid-cols-[2fr,3fr]">
        <div className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">人员位置预览</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                显示网格
              </label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input type="checkbox" checked={showTrackId} onChange={(e) => setShowTrackId(e.target.checked)} />
                显示track_id
              </label>
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {floorPlanImageUrlStr && selectedFloorPlan ? (
              <FloorPlanCanvas
                imageUrl={floorPlanImageUrlStr}
                gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
                gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
                showGrid={showGrid}
                backgroundColor="white"
                poiCells={poiCells}
                poiTrackIds={showTrackId ? poiTrackIdsByCell : undefined}
                showPoiTrackIds={showTrackId}
                className="w-full h-full"
              />
            ) : (
              <span className="text-xs text-slate-400">当前无平面图配置，请在“映射管理”中上传或选择平面图。</span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>POI：根据 YOLO 落脚点实时更新</span>
            <span>同格多人：右上角数字</span>
          </div>
        </div>

        <MappedCamerasGrid sources={mappedCameras} analyzing={analyzing} vvFootfalls={vvFootfalls} />
      </div>
    </div>
  );
};

const VirtualViewGridOverlay: React.FC<{
  view: CameraVirtualView;
  cfg: { polygon: Pt[]; grid_rows: number; grid_cols: number };
  highlightCells?: Footfall[] | null;
}> = ({ view, cfg, highlightCells = null }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // NOTE: 本项目当前的 TS 诊断环境对局部类型收窄有时会误报 never，
  // 这里用显式 any 来避免阻塞编译（运行时仍做严格数值校验）。
  const hcAny = (highlightCells ?? null) as any;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const has = Array.isArray(hcAny) ? hcAny.length > 0 : false;
    if (!has) return;
    const t = window.setInterval(() => setTick((x) => (x + 1) % 1_000_000), 200);
    return () => window.clearInterval(t);
  }, [hcAny]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = Math.max(1, Math.floor(size.w));
    const ch = Math.max(1, Math.floor(size.h));
    if (cw <= 1 || ch <= 1) return;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const outW = Math.max(1, view.out_w || 1);
    const outH = Math.max(1, view.out_h || 1);
    const scale = Math.min(cw / outW, ch / outH);
    const offX = cw / 2 - (outW * scale) / 2;
    const offY = ch / 2 - (outH * scale) / 2;

    const quadScreen = cfg.polygon.map((p) => ({
      x: offX + p.x * scale,
      y: offY + p.y * scale,
    }));
    const H = computeHomography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      quadScreen,
    );
    if (!H) return;

    const rows = Math.max(1, cfg.grid_rows);
    const cols = Math.max(1, cfg.grid_cols);

    const now = Date.now();
    const list: Footfall[] = Array.isArray(hcAny) ? hcAny : [];
    const fresh = list
      .map((p) => ({
        row: Number(p?.row),
        col: Number(p?.col),
        ts: Number(p?.ts),
      }))
      .filter(
        (p) =>
          Number.isFinite(p.row) &&
          Number.isFinite(p.col) &&
          Number.isFinite(p.ts) &&
          p.row >= 0 &&
          p.row < rows &&
          p.col >= 0 &&
          p.col < cols &&
          now - p.ts <= 1200,
      ) as Footfall[];

    if (fresh.length > 0) {
      fresh.forEach((p) => {
        const age = Math.max(0, now - p.ts);
        const k = Math.max(0, Math.min(1, 1 - age / 1200));
        const fillA = 0.15 + 0.55 * k;
        const strokeA = 0.25 + 0.75 * k;
        const u0 = p.col / cols;
        const u1 = (p.col + 1) / cols;
        const v0 = p.row / rows;
        const v1 = (p.row + 1) / rows;
        const p00 = applyHomography(H, { x: u0, y: v0 });
        const p10 = applyHomography(H, { x: u1, y: v0 });
        const p11 = applyHomography(H, { x: u1, y: v1 });
        const p01 = applyHomography(H, { x: u0, y: v1 });
        ctx.fillStyle = `rgba(239,68,68,${fillA})`;
        ctx.strokeStyle = `rgba(239,68,68,${strokeA})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y);
        ctx.lineTo(p10.x, p10.y);
        ctx.lineTo(p11.x, p11.y);
        ctx.lineTo(p01.x, p01.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      });
    }

    // 外框
    ctx.strokeStyle = "rgba(14,165,233,1.0)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(quadScreen[0].x, quadScreen[0].y);
    ctx.lineTo(quadScreen[1].x, quadScreen[1].y);
    ctx.lineTo(quadScreen[2].x, quadScreen[2].y);
    ctx.lineTo(quadScreen[3].x, quadScreen[3].y);
    ctx.closePath();
    ctx.stroke();

    // 内部网格线
    ctx.strokeStyle = "rgba(14,165,233,0.55)";
    ctx.lineWidth = 1;
    for (let r = 1; r < rows; r++) {
      const v = r / rows;
      const p0 = applyHomography(H, { x: 0, y: v });
      const p1 = applyHomography(H, { x: 1, y: v });
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    for (let c = 1; c < cols; c++) {
      const u = c / cols;
      const p0 = applyHomography(H, { x: u, y: 0 });
      const p1 = applyHomography(H, { x: u, y: 1 });
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
  }, [size, view, cfg, tick, highlightCells]);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      <canvas ref={canvasRef} className="h-full w-full" />
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

interface CameraVirtualView {
  id: number;
  camera_id: number;
  name: string;
  enabled: boolean;
  yaw_deg: number;
  pitch_deg: number;
  fov_deg: number;
  out_w: number;
  out_h: number;
}

interface VirtualViewCellMapping {
  id: number;
  virtual_view_id: number;
  floor_plan_id: number;
  camera_row: number;
  camera_col: number;
  floor_row: number;
  floor_col: number;
}

type Pt = { x: number; y: number };

function orderQuad(points: Pt[]): Pt[] {
  // 期望输入 4 个点；按几何中心排序为顺时针，并尽量以左上作为起点
  if (points.length !== 4) return points;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // 旋转到“最像左上角”的点作为第一个（最小 x+y）
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return [...sorted.slice(best), ...sorted.slice(0, best)];
}

function bilinear(quad: Pt[], u: number, v: number): Pt {
  // quad order: [p00, p10, p11, p01] (clockwise starting near top-left)
  const p00 = quad[0];
  const p10 = quad[1];
  const p11 = quad[2];
  const p01 = quad[3];
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = u * v;
  const d = (1 - u) * v;
  return {
    x: a * p00.x + b * p10.x + c * p11.x + d * p01.x,
    y: a * p00.y + b * p10.y + c * p11.y + d * p01.y,
  };
}

function computeHomography(src: Pt[], dst: Pt[]): number[] | null {
  // Solve for H (3x3) mapping src(u,v) -> dst(x,y), with h33 = 1
  // Returns row-major 9 elements.
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const u = src[i].x;
    const v = src[i].y;
    const x = dst[i].x;
    const y = dst[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  // Gaussian elimination on 8x8
  const M = A.map((row, i) => [...row, b[i]]);
  const n = 8;
  for (let col = 0; col < n; col++) {
    // pivot
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    // normalize
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    // eliminate
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const h = M.map((row) => row[n]); // 8 unknowns
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(H: number[], p: Pt): Pt {
  const u = p.x;
  const v = p.y;
  const x = H[0] * u + H[1] * v + H[2];
  const y = H[3] * u + H[4] * v + H[5];
  const w = H[6] * u + H[7] * v + H[8];
  const iw = Math.abs(w) < 1e-9 ? 1e-9 : w;
  return { x: x / iw, y: y / iw };
}

function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  // ray casting
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function worldToImagePoint(
  world: Pt,
  viewport: { w: number; h: number; aspectW: number; aspectH: number },
  opts?: { allowOutside?: boolean },
): Pt | null {
  const { w, h, aspectW, aspectH } = viewport;
  if (!w || !h || !aspectW || !aspectH) return null;
  const scale = Math.min(w / aspectW, h / aspectH);
  const imgW = aspectW * scale;
  const imgH = aspectH * scale;
  const imgX = (w - imgW) / 2;
  const imgY = (h - imgH) / 2;
  const x = world.x - imgX;
  const y = world.y - imgY;
  const allowOutside = !!opts?.allowOutside;
  if (!allowOutside && (x < 0 || y < 0 || x > imgW || y > imgH)) return null;
  return { x: (x / imgW) * aspectW, y: (y / imgH) * aspectH };
}

function floorPlanImageUrl(fp: FloorPlan): string {
  return fp.image_path.startsWith("/data/maps/")
    ? `${API_BASE}/maps/${fp.image_path.split("/").pop()}`
    : fp.image_path;
}

// === FloorPlanCanvas 图片缓存与预加载（用于模块切换时快速显示） ===
const floorPlanImageCache = new Map<string, HTMLImageElement>();
const floorPlanImagePromiseCache = new Map<string, Promise<HTMLImageElement>>();

function preloadFloorPlanImage(url: string): Promise<HTMLImageElement> {
  const cached = floorPlanImageCache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = floorPlanImagePromiseCache.get(url);
  if (existing) return existing;

  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      floorPlanImageCache.set(url, img);
      floorPlanImagePromiseCache.delete(url);
      resolve(img);
    };
    img.onerror = (e) => {
      floorPlanImagePromiseCache.delete(url);
      reject(e);
    };
    img.src = url;
  });

  floorPlanImagePromiseCache.set(url, p);
  return p;
}

const poiIconCache = new Map<string, HTMLImageElement>();
const poiIconPromiseCache = new Map<string, Promise<HTMLImageElement>>();

function preloadPoiIcon(url: string): Promise<HTMLImageElement> {
  const cached = poiIconCache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = poiIconPromiseCache.get(url);
  if (existing) return existing;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      poiIconCache.set(url, img);
      poiIconPromiseCache.delete(url);
      resolve(img);
    };
    img.onerror = (e) => {
      poiIconPromiseCache.delete(url);
      reject(e);
    };
    img.src = url;
  });
  poiIconPromiseCache.set(url, p);
  return p;
}

/** 平面图 Canvas：支持拖拽、缩放、网格叠加与 hover 显示网格编号 */
type FloorPlanCanvasProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  className?: string;
  showGrid?: boolean;
  backgroundColor?: string;
  selectedCell?: { row: number; col: number } | null;
  onCellClick?: (cell: { row: number; col: number } | null) => void;
  onCellHover?: (cell: { row: number; col: number } | null) => void;
  linkedHoverCell?: { row: number; col: number } | null;
  mappedCells?: Set<string>;
  heatmapCells?: Map<string, number>;
  poiCells?: Map<string, number>;
  poiTrackIds?: Map<string, number[]>;
  showPoiTrackIds?: boolean;
  heatmapRender?: {
    colormap: "viridis" | "greenRed";
    scale: "log" | "linear";
    clip: "p95" | "p99" | "max";
    alphaMode: "byValue" | "fixed";
    vMax: number;
  };
  cellFillColors?: Map<string, string>;
};

const FloorPlanCanvas = (props: FloorPlanCanvasProps) => {
  const {
    imageUrl,
    gridRows,
    gridCols,
    className = "",
    showGrid = true,
    backgroundColor,
    selectedCell = null,
    onCellClick,
    onCellHover,
    linkedHoverCell = null,
    mappedCells,
    heatmapCells,
    poiCells,
    poiTrackIds,
    showPoiTrackIds = false,
    heatmapRender,
    cellFillColors,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const poiIconRef = useRef<HTMLImageElement | null>(null);
  const sel: { row: number; col: number } | null = selectedCell ?? null;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 600, h: 400 });
  const [poiIconReadyTick, setPoiIconReadyTick] = useState(0);

  // 加载图片并记录尺寸（使用缓存避免切换页面时重复 decode）
  useEffect(() => {
    let cancelled = false;
    preloadFloorPlanImage(imageUrl)
      .then((img) => {
        if (cancelled) return;
        imageRef.current = img;
        setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch(() => {
        // 加载失败时保持原样，不让 UI 进入异常状态
      });
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    let cancelled = false;
    preloadPoiIcon(POI_ICON_URL)
      .then((img) => {
        if (cancelled) return;
        poiIconRef.current = img;
        setPoiIconReadyTick((t) => t + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, cw, ch);
    } else {
      ctx.clearRect(0, 0, cw, ch);
    }

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    ctx.translate(offsetX, offsetY);
    ctx.scale(fitScale, fitScale);
    ctx.drawImage(img, 0, 0);
    const rows = Math.max(1, gridRows);
    const cols = Math.max(1, gridCols);
    // 网格线（可显示/隐藏）
    if (showGrid) {
      ctx.strokeStyle = "rgba(14,165,233,0.3)";
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
    }
    // 已绑定格子（按来源分色；若未提供分色则使用绿色）
    if (
      (cellFillColors && cellFillColors.size > 0) ||
      (mappedCells && mappedCells.size > 0)
    ) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      ctx.lineWidth = 1.5 / fitScale;
      const keys =
        cellFillColors && cellFillColors.size > 0
          ? Array.from(cellFillColors.keys())
          : mappedCells
            ? Array.from(mappedCells)
            : [];
      keys.forEach((key) => {
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c)) return;
        if (r < 0 || r >= rows || c < 0 || c >= cols) return;
        const x = c * cellW;
        const y = r * cellH;
        const fill = cellFillColors?.get(key) || "rgba(34,197,94,0.18)";
        const stroke = cellFillColors?.get(key)
          ? (cellFillColors.get(key) as string).replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, "rgba($1,$2,$3,0.85)")
          : "rgba(34,197,94,0.85)";
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeRect(x, y, cellW, cellH);
      });
    }

    // selected 高亮（用于“定位”）
    if (sel != null && sel.row >= 0 && sel.row < rows && sel.col >= 0 && sel.col < cols) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      const x = sel.col * cellW;
      const y = sel.row * cellH;
      ctx.fillStyle = "rgba(59,130,246,0.22)";
      ctx.fillRect(x, y, cellW, cellH);
      ctx.strokeStyle = "rgba(59,130,246,0.95)";
      ctx.lineWidth = 2 / fitScale;
      ctx.strokeRect(x, y, cellW, cellH);
    }

    // 热力格子
    if (heatmapCells && heatmapCells.size > 0) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      const opts = heatmapRender || {
        colormap: "viridis" as const,
        scale: "log" as const,
        clip: "p95" as const,
        alphaMode: "byValue" as const,
        vMax: 1,
      };
      const vMax = Math.max(1e-6, Number(opts.vMax) || 1);
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const lerpColor = (c1: [number, number, number], c2: [number, number, number], t: number): [number, number, number] => [
        Math.round(lerp(c1[0], c2[0], t)),
        Math.round(lerp(c1[1], c2[1], t)),
        Math.round(lerp(c1[2], c2[2], t)),
      ];

      const stopsGreenRed: [number, number, number][] = [
        [187, 247, 208],
        [34, 197, 94],
        [249, 115, 22],
        [239, 68, 68],
      ];
      const stopsViridis: [number, number, number][] = [
        [68, 1, 84],
        [72, 40, 120],
        [62, 73, 137],
        [49, 104, 142],
        [38, 130, 142],
        [31, 158, 137],
        [53, 183, 121],
        [109, 205, 89],
        [180, 222, 44],
        [253, 231, 37],
      ];
      const pickColor = (t: number): [number, number, number] => {
        const stops = opts.colormap === "greenRed" ? stopsGreenRed : stopsViridis;
        const n = stops.length;
        const x = Math.min(1, Math.max(0, t)) * (n - 1);
        const i0 = Math.floor(x);
        const i1 = Math.min(n - 1, i0 + 1);
        const tt = x - i0;
        return lerpColor(stops[i0], stops[i1], tt);
      };
      const norm = (v: number) => {
        const vv = Math.max(0, Math.min(v, vMax));
        if (opts.scale === "linear") return vv / vMax;
        return Math.log1p(vv) / Math.log1p(vMax);
      };

      heatmapCells.forEach((value, key) => {
        if (!Number.isFinite(value) || value <= 0) return;
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c)) return;
        if (r < 0 || r >= rows || c < 0 || c >= cols) return;
        const t = Math.min(1, Math.max(0, norm(value)));
        const [rr, gg, bb] = pickColor(t);
        const a = opts.alphaMode === "fixed" ? 0.85 : Math.min(0.92, 0.08 + 0.84 * t);
        const x = c * cellW;
        const y = r * cellH;
        ctx.fillStyle = `rgba(${rr},${gg},${bb},${a})`;
        ctx.fillRect(x, y, cellW, cellH);
      });
    }

    if (poiCells && poiCells.size > 0) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      const icon = poiIconRef.current;
      const drawFallback = (footX: number, footY: number, h: number) => {
        const s = h;
        ctx.fillStyle = "rgba(59,130,246,0.95)";
        const headR = s * 0.18;
        ctx.beginPath();
        ctx.arc(footX, footY - s * 0.78, headR, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(2 / fitScale, s * 0.06);
        ctx.strokeStyle = "rgba(59,130,246,0.95)";
        ctx.beginPath();
        ctx.moveTo(footX, footY - s * 0.62);
        ctx.lineTo(footX, footY - s * 0.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(footX, footY - s * 0.48);
        ctx.lineTo(footX - s * 0.22, footY - s * 0.34);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(footX, footY - s * 0.48);
        ctx.lineTo(footX + s * 0.22, footY - s * 0.34);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(footX, footY - s * 0.2);
        ctx.lineTo(footX - s * 0.18, footY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(footX, footY - s * 0.2);
        ctx.lineTo(footX + s * 0.18, footY);
        ctx.stroke();
      };
      poiCells.forEach((count, key) => {
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c)) return;
        if (r < 0 || r >= rows || c < 0 || c >= cols) return;
        const x = c * cellW;
        const y = r * cellH;
        const cx = x + cellW / 2;
        const cy = y + cellH / 2;
        const iconH = Math.max(24, cellH * 3);
        if (icon && icon.naturalWidth > 0 && icon.naturalHeight > 0) {
          const scale = iconH / icon.naturalHeight;
          const iconW = icon.naturalWidth * scale;
          const footOffset = 16 * scale;
          const drawX = cx - iconW / 2;
          const drawY = cy - (iconH - footOffset);
          ctx.drawImage(icon, drawX, drawY, iconW, iconH);
        } else {
          drawFallback(cx, cy, iconH);
        }
        const n = Math.max(0, Math.floor(Number(count) || 0));
        if (n > 1) {
          const badgeR = Math.max(7 / fitScale, Math.min(cellW, cellH) * 0.15);
          const bx = x + cellW * 0.82;
          const by = y + cellH * 0.2;
          ctx.fillStyle = "rgba(15,23,42,0.92)";
          ctx.beginPath();
          ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = `bold ${Math.max(10 / fitScale, Math.min(18 / fitScale, badgeR * 1.25))}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(n > 99 ? "99+" : String(n), bx, by);
        }

        if (showPoiTrackIds && poiTrackIds) {
          const tids = poiTrackIds.get(key);
          if (tids && tids.length > 0) {
            const uniq = Array.from(new Set(tids.filter((v) => Number.isFinite(v)))).sort((a, b) => a - b);
            if (uniq.length > 0) {
              const s =
                uniq.length <= 3
                  ? `t:${uniq.join(",")}`
                  : `t:${uniq.slice(0, 3).join(",")}+${uniq.length - 3}`;
              const fontPx = Math.max(9 / fitScale, Math.min(14 / fitScale, Math.min(cellW, cellH) * 0.18));
              ctx.font = `bold ${fontPx}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "bottom";
              const tx = cx;
              const ty = y + cellH * 0.94;
              const w = ctx.measureText(s).width;
              const padX = Math.max(4 / fitScale, fontPx * 0.35);
              const padY = Math.max(2 / fitScale, fontPx * 0.25);
              const boxW = w + padX * 2;
              const boxH = fontPx + padY * 2;
              ctx.fillStyle = "rgba(15,23,42,0.78)";
              ctx.fillRect(tx - boxW / 2, ty - boxH, boxW, boxH);
              ctx.fillStyle = "rgba(255,255,255,0.95)";
              ctx.fillText(s, tx, ty - padY);
            }
          }
        }
      });
    }

    // linked hover（对侧面板联动的 hover，高亮但不覆盖当前 hover）
    if (
      linkedHoverCell != null &&
      linkedHoverCell.row >= 0 &&
      linkedHoverCell.row < rows &&
      linkedHoverCell.col >= 0 &&
      linkedHoverCell.col < cols
    ) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      const x = linkedHoverCell.col * cellW;
      const y = linkedHoverCell.row * cellH;
      ctx.fillStyle = "rgba(34,197,94,0.16)";
      ctx.fillRect(x, y, cellW, cellH);
      ctx.strokeStyle = "rgba(34,197,94,0.9)";
      ctx.lineWidth = 2 / fitScale;
      ctx.strokeRect(x, y, cellW, cellH);
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
  }, [pan, zoom, hoverCell, linkedHoverCell, sel, showGrid, gridRows, gridCols, imgSize, canvasSize, poiIconReadyTick, heatmapCells, poiCells, poiTrackIds, showPoiTrackIds, heatmapRender, cellFillColors]);

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

  useEffect(() => {
    onCellHover?.(hoverCell);
  }, [hoverCell, onCellHover]);
  const onClick = (e: React.MouseEvent) => {
    if (!onCellClick) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const cell = getCellAt(cx, cy);
    if (cell && mappedCells?.has(`${cell.row},${cell.col}`)) return;
    onCellClick(cell);
  };

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${className}`}
      style={{ height: "100%", minHeight: 0, userSelect: "none" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      <canvas
        ref={canvasRef}
        width={canvasSize.w}
        height={canvasSize.h}
        className="block cursor-grab active:cursor-grabbing"
        style={{ display: "block", width: "100%", height: "100%" }}
      />

      {/* 角落显示当前缩放倍数 */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-white/80 px-2 py-0.5 text-[11px] text-slate-700">
        zoom {zoom.toFixed(2)}
      </div>
    </div>
  );
};

/** 通用视窗：支持拖拽平移/滚轮缩放，并提供 overlay canvas 作为后续绘制层 */
const PanZoomViewport: React.FC<{
  className?: string;
  children: React.ReactNode;
  mode?: "panzoom" | "draw";
  onClickWorld?: (p: { x: number; y: number }) => void;
  onMoveWorld?: (p: { x: number; y: number }) => void;
  onPointerDownWorld?: (p: { x: number; y: number }) => boolean | void;
  onPointerUpWorld?: (p: { x: number; y: number }) => void;
  renderOverlay?: (ctx: CanvasRenderingContext2D, info: { w: number; h: number; pan: { x: number; y: number }; zoom: number }) => void;
  topLeftOverlay?: React.ReactNode;
}> = ({
  className = "",
  children,
  mode = "panzoom",
  onClickWorld,
  onMoveWorld,
  onPointerDownWorld,
  onPointerUpWorld,
  renderOverlay,
  topLeftOverlay,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 600, height: 400 };
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 保持 overlay canvas 像素尺寸匹配容器（便于后续绘制）
  useEffect(() => {
    const c = overlayCanvasRef.current;
    if (!c) return;
    c.width = Math.max(1, Math.floor(size.w));
    c.height = Math.max(1, Math.floor(size.h));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }, [size]);

  const redrawOverlay = useCallback(() => {
    const c = overlayCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (renderOverlay) {
      renderOverlay(ctx, { w: c.width, h: c.height, pan, zoom });
    }
  }, [renderOverlay, pan, zoom]);

  useEffect(() => {
    redrawOverlay();
  }, [redrawOverlay, size]);

  const cssToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      return {
        x: (cssX - pan.x) / zoom,
        y: (cssY - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  const onWheel = (e: React.WheelEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((oldZoom) => {
      const newZoom = Math.min(5, Math.max(0.3, oldZoom * zoomFactor));
      // 以鼠标位置为缩放中心：让屏幕点 (cssX,cssY) 在缩放前后落在同一“世界点”
      setPan((oldPan) => ({
        x: cssX - ((cssX - oldPan.x) / oldZoom) * newZoom,
        y: cssY - ((cssY - oldPan.y) / oldZoom) * newZoom,
      }));
      return newZoom;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // 如果点在工具栏/控件上，不要触发画布拖拽/绘制（否则按钮点击会“没反应”）
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('[data-viewport-ui="1"]')) {
      return;
    }

    const p = cssToWorld(e.clientX, e.clientY);
    const handled = onPointerDownWorld?.(p);

    // 避免 <img> 默认拖拽、以及浏览器选择行为
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    if (mode === "draw") {
      // 如果 pointerDown 已经被工具逻辑处理（比如命中顶点拖拽），不要再触发“点4次建四边形”
      if (handled) return;
      onClickWorld?.(p);
      return;
    }
    // 如果 pointerDown 被工具逻辑处理（例如命中顶点拖拽），不要触发画布平移拖拽
    if (handled) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('[data-viewport-ui="1"]')) {
      return;
    }
    const p = cssToWorld(e.clientX, e.clientY);
    onMoveWorld?.(p);
    if (!dragging) return;
    if (mode !== "panzoom") return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };
  const endDrag = (e: React.PointerEvent) => {
    const p = cssToWorld(e.clientX, e.clientY);
    onPointerUpWorld?.(p);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setDragging(false);
  };

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${className}`}
      style={{ minHeight: 0, userSelect: "none", touchAction: "none" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={endDrag}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          cursor: dragging ? "grabbing" : "grab",
        }}
      >
        {children}
      </div>

      {/* overlay canvas：用于画点/框/多边形；默认不拦截鼠标事件 */}
      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0"
        style={{ width: "100%", height: "100%", pointerEvents: "none" }}
      />

      {topLeftOverlay && (
        <div className="absolute left-2 top-2" data-viewport-ui="1">
          {topLeftOverlay}
        </div>
      )}

      {/* 角落显示当前缩放倍数（可删） */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-white/80 px-2 py-0.5 text-[11px] text-slate-700">
        zoom {zoom.toFixed(2)}
      </div>
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

  type MappingTabKey = "bind" | "cameras" | "floorPlans" | "panoramaViews";
  const [mappingTab, setMappingTab] = useState<MappingTabKey>("bind");

  // 映射绑定子页使用的摄像头/virtual PTZ 选择状态
  type BindCameraOption =
    | { kind: "camera"; key: string; camera: Camera; label: string }
    | { kind: "virtual"; key: string; view: CameraVirtualView & { camera_name?: string }; label: string };
  const [bindCameraOptions, setBindCameraOptions] = useState<BindCameraOption[]>([]);
  const [bindFloorPlanId, setBindFloorPlanId] = useState<number | "">("");
  const [bindCameraId, setBindCameraId] = useState<string>("");
  const [bindMappedCameraIds, setBindMappedCameraIds] = useState<number[]>([]);
  const [bindMappedCameraIdsLoading, setBindMappedCameraIdsLoading] = useState(false);
  const [bindVvSnapshotRefreshMs, setBindVvSnapshotRefreshMs] = useState<number>(3000);
  const [bindVvSnapshotObjUrl, setBindVvSnapshotObjUrl] = useState<string>("");
  const bindVvSnapshotTimerRef = useRef<number | null>(null);
  const bindVvSnapshotInFlightRef = useRef<boolean>(false);
  const bindVvSnapshotViewIdRef = useRef<number | null>(null);
  // 左侧平面图网格设置（可本地修改，保存时写回平面图）
  const [bindGridRows, setBindGridRows] = useState("");
  const [bindGridCols, setBindGridCols] = useState("");
  const [savingGrid, setSavingGrid] = useState(false);

  // virtual PTZ 画面网格标定（四边形 + 行列）
  const [vpTool, setVpTool] = useState<"none" | "quad">("none");
  const [vpQuadPoints, setVpQuadPoints] = useState<Pt[]>([]);
  const [vpQuad, setVpQuad] = useState<Pt[] | null>(null);
  const [vpRows, setVpRows] = useState("10");
  const [vpCols, setVpCols] = useState("10");
  const [vpHover, setVpHover] = useState<{ row: number; col: number } | null>(null);
  const [vpSaving, setVpSaving] = useState(false);
  const [vpEditEnabled, setVpEditEnabled] = useState(false);
  const [vpDraggingVertex, setVpDraggingVertex] = useState<number | null>(null);
  const [vpSelectedCell, setVpSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const vpViewportSizeRef = useRef<{ w: number; h: number; aspectW: number; aspectH: number }>({
    w: 0,
    h: 0,
    aspectW: 960,
    aspectH: 540,
  });

  const [fpSelectedCell, setFpSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [fpHoverCell, setFpHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [linkedFpHoverCell, setLinkedFpHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [linkedVpHoverCell, setLinkedVpHoverCell] = useState<{ row: number; col: number } | null>(null);

  const [cellMappings, setCellMappings] = useState<VirtualViewCellMapping[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsSaving, setMappingsSaving] = useState(false);
  const [replaceMappingId, setReplaceMappingId] = useState<number | null>(null);
  const [autoAnchors, setAutoAnchors] = useState<{ camera_row: number; camera_col: number; floor_row: number; floor_col: number }[]>([]);
  const [autoOverwrite, setAutoOverwrite] = useState(false);

  const mappedCamCells = useMemo(() => {
    const s = new Set<string>();
    cellMappings.forEach((m) => s.add(`${m.camera_row},${m.camera_col}`));
    return s;
  }, [cellMappings]);
  const mappedFloorCells = useMemo(() => {
    const s = new Set<string>();
    cellMappings.forEach((m) => s.add(`${m.floor_row},${m.floor_col}`));
    return s;
  }, [cellMappings]);

  // === 平面图“按绑定源分色” ===
  type BindSourceItem = { key: string; label: string; color: string };
  const [bindSourceList, setBindSourceList] = useState<BindSourceItem[]>([]);
  const [floorCellToSourceKey, setFloorCellToSourceKey] = useState<Map<string, string>>(new Map());
  const [floorCellFillColors, setFloorCellFillColors] = useState<Map<string, string>>(new Map());
  const floorCellToSourceKeyRef = useRef<Map<string, string>>(new Map());
  const [bindingColorRefreshTick, setBindingColorRefreshTick] = useState(0);

  useEffect(() => {
    floorCellToSourceKeyRef.current = floorCellToSourceKey;
  }, [floorCellToSourceKey]);

  const palette = [
    "#694FF9",
    "#0EA5E9",
    "#22C55E",
    "#F97316",
    "#EF4444",
    "#A855F7",
    "#14B8A6",
    "#F59E0B",
    "#84CC16",
    "#06B6D4",
    "#F43F5E",
    "#8B5CF6",
  ];
  const colorForKey = (k: string) => {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 131 + k.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };
  const withAlpha = (hex: string, a: number) => {
    const m = hex.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  };

  useEffect(() => {
    // 当平面图切换时，加载“与该平面图存在绑定关系的 sources”，并汇总每个 floor cell 属于哪个 source
    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") {
      setBindSourceList([]);
      setFloorCellToSourceKey(new Map());
      setFloorCellFillColors(new Map());
      return;
    }
    const floorPlanId = bindFloorPlanId;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/floor-plans/${floorPlanId}/heatmap-sources`);
        const sources: {
          kind: "camera" | "virtual";
          camera_id: number;
          camera_name: string;
          virtual_view_id?: number | null;
          virtual_view_name?: string | null;
        }[] = res.ok ? await res.json() : [];

        const items: BindSourceItem[] = [];
        const cellToKey = new Map<string, string>();

        // 仅对 virtual PTZ 有 cell-mappings，可实现网格分色；camera 类型先展示在列表但不参与格子分色
        for (const s of sources) {
          if (s.kind === "virtual" && s.virtual_view_id) {
            const key = `vv:${s.virtual_view_id}`;
            const colorHex = colorForKey(key);
            items.push({
              key,
              label: `${s.camera_name} / ${s.virtual_view_name || `VV#${s.virtual_view_id}`} (virtual)`,
              color: colorHex,
            });
            const mRes = await fetch(
              `${API_BASE}/api/cameras/virtual-views/${s.virtual_view_id}/cell-mappings?floor_plan_id=${floorPlanId}`,
            );
            const mappings: VirtualViewCellMapping[] = mRes.ok ? await mRes.json() : [];
            mappings.forEach((m) => {
              const fk = `${m.floor_row},${m.floor_col}`;
              cellToKey.set(fk, key);
            });
          } else if (s.kind === "camera") {
            const key = `cam:${s.camera_id}`;
            const colorHex = colorForKey(key);
            items.push({
              key,
              label: `${s.camera_name} (camera)`,
              color: colorHex,
            });
          }
        }

        // floor cell -> rgba fill
        const fillMap = new Map<string, string>();
        cellToKey.forEach((k, cellKey) => {
          const hex = colorForKey(k);
          fillMap.set(cellKey, withAlpha(hex, 0.22));
        });

        setBindSourceList(items);
        setFloorCellToSourceKey(cellToKey);
        setFloorCellFillColors(fillMap);
      } catch (e) {
        console.error(e);
        setBindSourceList([]);
        setFloorCellToSourceKey(new Map());
        setFloorCellFillColors(new Map());
      }
    })();
  }, [bindFloorPlanId, bindingColorRefreshTick]);

  const camToFloor = useMemo(() => {
    const m = new Map<string, { row: number; col: number }>();
    cellMappings.forEach((x) => m.set(`${x.camera_row},${x.camera_col}`, { row: x.floor_row, col: x.floor_col }));
    return m;
  }, [cellMappings]);
  const floorToCam = useMemo(() => {
    const m = new Map<string, { row: number; col: number }>();
    cellMappings.forEach((x) => m.set(`${x.floor_row},${x.floor_col}`, { row: x.camera_row, col: x.camera_col }));
    return m;
  }, [cellMappings]);

  const loadVirtualGridConfig = useCallback(async (viewId: number) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/cameras/virtual-views/${viewId}/grid-config`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const poly: Pt[] = (() => {
        try {
          return JSON.parse(data.polygon_json || "[]");
        } catch {
          return [];
        }
      })();
      if (Array.isArray(poly) && poly.length === 4) {
        setVpQuad(orderQuad(poly));
        setVpQuadPoints([]);
      } else {
        setVpQuad(null);
        setVpQuadPoints([]);
      }
      setVpRows(String(data.grid_rows ?? 10));
      setVpCols(String(data.grid_cols ?? 10));
      setVpHover(null);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const loadFloorPlans = async () => {
    const res = await fetch(`${API_BASE}/api/floor-plans`);
    const data: FloorPlan[] = await res.json();
    setFloorPlans(data);
    // 方案 A：预加载所有平面图图片，避免切换模块时图片请求排队/延迟
    data.forEach((fp) => {
      const url = floorPlanImageUrl(fp);
      void preloadFloorPlanImage(url);
    });
    if (data.length > 0 && bindFloorPlanId === "") {
      setBindFloorPlanId(data[0].id);
    }
  };

  const loadBindCameras = async () => {
    const res = await fetch(`${API_BASE}/api/cameras/`);
    const cams: Camera[] = await res.json();

    const res2 = await fetch(`${API_BASE}/api/cameras/virtual-views/all`);
    const allViews: (CameraVirtualView & { camera_name: string })[] = res2.ok ? await res2.json() : [];

    const options: BindCameraOption[] = [
      ...cams.map((c) => ({
        kind: "camera" as const,
        key: `cam:${c.id}`,
        camera: c,
        label: `${c.name} #${c.id}`,
      })),
      ...allViews.map((v) => ({
        kind: "virtual" as const,
        key: `vv:${v.id}`,
        view: v,
        label: `${v.camera_name} / ${v.name} (virtual)`,
      })),
    ];

    setBindCameraOptions(options);
    if (options.length > 0 && bindCameraId === "") {
      setBindCameraId(options[0].key);
    }
  };

  useEffect(() => {
    loadFloorPlans();
    loadBindCameras();
  }, []);

  const loadBindMappedCameraIds = useCallback(async (floorPlanId: number) => {
    setBindMappedCameraIdsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/floor-plans/${floorPlanId}/mapped-camera-ids`);
      const ids: number[] = res.ok ? await res.json() : [];
      setBindMappedCameraIds(Array.isArray(ids) ? ids : []);
    } catch {
      setBindMappedCameraIds([]);
    } finally {
      setBindMappedCameraIdsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") {
      setBindMappedCameraIds([]);
      return;
    }
    void loadBindMappedCameraIds(bindFloorPlanId);
  }, [bindFloorPlanId, loadBindMappedCameraIds]);

  const refreshBindVirtualSnapshot = useCallback(async (view: CameraVirtualView) => {
    if (bindVvSnapshotInFlightRef.current) return;
    bindVvSnapshotInFlightRef.current = true;
    const snapshotUrl = `${API_BASE}/api/cameras/${view.camera_id}/virtual-views/${view.id}/snapshot.jpg?t=${Date.now()}`;
    try {
      const res = await fetch(snapshotUrl, { cache: "no-store" });
      if (!res.ok) return;
      if (res.status === 204) return;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = objUrl;
      });
      setBindVvSnapshotObjUrl((prev) => {
        if (prev && prev !== objUrl) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return objUrl;
      });
    } catch {
    } finally {
      bindVvSnapshotInFlightRef.current = false;
    }
  }, []);

  // 切换摄像头（含 virtual PTZ）时重置 hover 等状态
  useEffect(() => {
    setVpHover(null);
    setVpDraggingVertex(null);
    setVpSelectedCell(null);
    setReplaceMappingId(null);
    setLinkedFpHoverCell(null);
    setLinkedVpHoverCell(null);
  }, [bindCameraId]);

  useEffect(() => {
    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    const viewId = mappingTab === "bind" && opt?.kind === "virtual" ? opt.view.id : null;
    if (bindVvSnapshotViewIdRef.current !== viewId) {
      bindVvSnapshotViewIdRef.current = viewId;
      setBindVvSnapshotObjUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return "";
      });
    }
  }, [bindCameraId, bindCameraOptions, mappingTab]);

  useEffect(() => {
    if (bindVvSnapshotTimerRef.current) {
      window.clearInterval(bindVvSnapshotTimerRef.current);
      bindVvSnapshotTimerRef.current = null;
    }
    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    if (mappingTab !== "bind" || !opt || opt.kind !== "virtual") return;
    const view = opt.view;
    void refreshBindVirtualSnapshot(view);
    const t = window.setInterval(() => {
      void refreshBindVirtualSnapshot(view);
    }, Math.max(500, bindVvSnapshotRefreshMs));
    bindVvSnapshotTimerRef.current = t;
    return () => {
      if (bindVvSnapshotTimerRef.current === t) {
        window.clearInterval(t);
        bindVvSnapshotTimerRef.current = null;
      } else {
        window.clearInterval(t);
      }
    };
  }, [bindCameraId, bindCameraOptions, bindVvSnapshotRefreshMs, mappingTab, refreshBindVirtualSnapshot]);

  useEffect(() => {
    return () => {
      if (bindVvSnapshotTimerRef.current) {
        window.clearInterval(bindVvSnapshotTimerRef.current);
        bindVvSnapshotTimerRef.current = null;
      }
      setBindVvSnapshotObjUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return "";
      });
    };
  }, []);

  // hover 联动：右侧摄像头格子 hover -> 左侧平面图格子 hover
  useEffect(() => {
    if (!vpHover) {
      setLinkedFpHoverCell(null);
      return;
    }
    const floor = camToFloor.get(`${vpHover.row},${vpHover.col}`) || null;
    setLinkedFpHoverCell(floor);
  }, [vpHover, camToFloor]);

  // hover 联动：左侧平面图格子 hover -> 右侧摄像头格子 hover
  useEffect(() => {
    if (!fpHoverCell) {
      setLinkedVpHoverCell(null);
      return;
    }
    const cam = floorToCam.get(`${fpHoverCell.row},${fpHoverCell.col}`) || null;
    setLinkedVpHoverCell(cam);
  }, [fpHoverCell, floorToCam]);

  // 选择 virtual PTZ 摄像头时，自动加载已保存的四边形网格配置并显示
  useEffect(() => {
    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    if (!opt || opt.kind !== "virtual") return;
    loadVirtualGridConfig(opt.view.id);
    // 默认不进入编辑模式（仅展示）；需要修改时再点工具按钮进入编辑
    setVpTool("none");
    setVpEditEnabled(false);
  }, [bindCameraId, bindCameraOptions, loadVirtualGridConfig]);

  // 选择 virtual PTZ + 平面图时加载映射关系列表
  useEffect(() => {
    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    // 切换摄像头时先清空，避免看见上一个摄像头的数据残留
    setCellMappings([]);
    if (!opt || opt.kind !== "virtual") {
      return;
    }
    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") {
      return;
    }
    const viewId = opt.view.id;
    const floorPlanId = bindFloorPlanId;
    setMappingsLoading(true);
    fetch(`${API_BASE}/api/cameras/virtual-views/${viewId}/cell-mappings?floor_plan_id=${floorPlanId}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: VirtualViewCellMapping[]) => setCellMappings(data))
      .catch((e) => console.error(e))
      .finally(() => setMappingsLoading(false));
  }, [bindCameraId, bindCameraOptions, bindFloorPlanId]);

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
    if (bindMappedCameraIds.length > 0) {
      alert("该平面图已存在映射关联，修改网格会导致绑定坐标失效。请先清空映射后再修改网格。");
      return;
    }
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

  const saveVirtualGridConfig = async (viewId: number) => {
    if (!vpQuad) return;
    setVpSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/cameras/virtual-views/${viewId}/grid-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          polygon_json: JSON.stringify(vpQuad),
          grid_rows: Math.max(1, Number(vpRows) || 1),
          grid_cols: Math.max(1, Number(vpCols) || 1),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(text);
        alert("保存失败");
        return;
      }
      await loadVirtualGridConfig(viewId);
      // 保存后关闭编辑（隐藏可拖拽顶点）
      setVpEditEnabled(false);
      setVpTool("none");
    } catch (e) {
      console.error(e);
      alert("保存失败");
    } finally {
      setVpSaving(false);
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
      ? "bg-[#694FF9] text-white"
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
          className={subTabClass("panoramaViews")}
          onClick={() => setMappingTab("panoramaViews")}
        >
          virtual PTZ配置
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
        <div className="grid h-[calc(100vh-180px)] min-h-0 grid-cols-1 gap-4 md:grid-cols-[2fr,3fr,1fr]">
          {/* 左侧：选择平面图、网格设置、Canvas 预览（拖拽/缩放/网格/hover） */}
          <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
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
              <div className="mb-2 space-y-2">
                <div className="text-[11px] font-semibold text-slate-700">网格设置</div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-600">
                    网格行数
                    <input
                      type="number"
                      min={1}
                      className="ml-1 w-14 rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:bg-slate-100 disabled:opacity-60"
                      value={bindGridRows}
                      onChange={(e) => setBindGridRows(e.target.value)}
                      disabled={bindMappedCameraIds.length > 0}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    网格列数
                    <input
                      type="number"
                      min={1}
                      className="ml-1 w-14 rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:bg-slate-100 disabled:opacity-60"
                      value={bindGridCols}
                      onChange={(e) => setBindGridCols(e.target.value)}
                      disabled={bindMappedCameraIds.length > 0}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={saveBindGrid}
                    disabled={savingGrid || bindMappedCameraIds.length > 0}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {savingGrid ? "保存中…" : "保存网格设置"}
                  </button>
                </div>
                {bindMappedCameraIdsLoading ? (
                  <div className="text-[11px] text-slate-400">检查映射关联中…</div>
                ) : bindMappedCameraIds.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1">
                    <div className="text-[11px] text-amber-900">
                      该平面图已存在映射关联（摄像头 {bindMappedCameraIds.length} 个），需先清空映射后才能修改网格。
                    </div>
                    <button
                      type="button"
                      className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                      onClick={async () => {
                        if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") return;
                        const ok = confirm(
                          `确认清空该平面图的所有映射关联吗？\n\n- 将删除该平面图下所有 camera 映射与 virtual PTZ cell 映射\n- 操作不可撤销\n\n清空后才可修改网格。`,
                        );
                        if (!ok) return;
                        const code = String(Math.floor(1000 + Math.random() * 9000));
                        const input = prompt(`为防止误操作，请输入验证码：${code}`);
                        if (input === null) return;
                        if ((input || "").trim() !== code) {
                          alert("验证码错误，已取消清空。");
                          return;
                        }
                        try {
                          const res = await fetch(`${API_BASE}/api/floor-plans/${bindFloorPlanId}/clear-mappings`, {
                            method: "POST",
                          });
                          if (!res.ok) throw new Error("clear failed");
                          setCellMappings([]);
                          setReplaceMappingId(null);
                          setBindingColorRefreshTick((t) => t + 1);
                          void loadBindMappedCameraIds(bindFloorPlanId);
                        } catch (e) {
                          console.error(e);
                          alert("清空映射失败，请稍后重试。");
                        }
                      }}
                    >
                      清空映射
                    </button>
                  </div>
                ) : null}

                <div className="text-[11px] font-semibold text-slate-700">摄像头绑定列表</div>
                <div className="max-h-28 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2">
                  {bindSourceList.length === 0 ? (
                    <div className="text-[11px] text-slate-400">暂无绑定关系</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                      {bindSourceList.map((it) => (
                        <div key={it.key} className="flex min-w-0 items-center gap-2 text-[11px] text-slate-700">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full border border-white shadow-sm"
                            style={{ background: it.color }}
                          />
                          <span className="min-w-0 truncate">{it.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mb-2 text-[11px] font-semibold text-slate-700">平面图预览</div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
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
                      selectedCell={fpSelectedCell}
                      onCellClick={(cell) => {
                        setFpSelectedCell(cell);
                        if (!cell) return;
                        const key = `${cell.row},${cell.col}`;
                        const srcKey = floorCellToSourceKey.get(key);
                        if (srcKey) {
                          // 自动切换右侧摄像头选择到该绑定源
                          setBindCameraId(srcKey);
                        }
                      }}
                      onCellHover={(cell) => setFpHoverCell(cell)}
                      linkedHoverCell={linkedFpHoverCell}
                      mappedCells={mappedFloorCells}
                      cellFillColors={floorCellFillColors}
                      className="w-full h-full"
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
          <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800">摄像头选择</span>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                value={bindCameraId}
                onChange={(e) => setBindCameraId(e.target.value || "")}
              >
                {bindCameraOptions.length === 0 && <option value="">无摄像头</option>}
                {bindCameraOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                {bindCameraId !== "" ? (
                  (() => {
                    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
                    if (!opt) {
                      return (
                        <span className="text-xs text-slate-400">
                          未找到对应摄像头，请检查配置。
                        </span>
                      );
                    }
                    if (opt.kind === "camera") {
                      const cam = opt.camera;
                      if (!cam.webrtc_url) {
                        return (
                          <span className="text-xs text-slate-400">
                            该摄像头未配置 WebRTC 播放地址，请在“摄像头管理”中补充。
                          </span>
                        );
                      }
                      return (
                        <PanZoomViewport className="h-full w-full">
                          <iframe
                            src={cam.webrtc_url}
                            className="h-full w-full border-none"
                            allow="autoplay; fullscreen"
                            title={`mapping-bind-camera-${cam.id}`}
                          />
                        </PanZoomViewport>
                      );
                    }
                    // virtual PTZ：轮询 snapshot.jpg 预览
                    const view = opt.view;
                    const aspectW = view.out_w || 960;
                    const aspectH = view.out_h || 540;

                    const toolbar = (
                      <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white/90 p-1 shadow-sm">
                        <button
                          type="button"
                          className={`inline-flex h-8 w-8 items-center justify-center rounded hover:bg-slate-100 ${
                            (vpTool === "quad" || vpEditEnabled) ? "bg-emerald-100 text-emerald-700" : "text-slate-700"
                          }`}
                          onClick={() => {
                            // 有四边形：进入/退出“编辑顶点”模式（不允许新建）
                            if (vpQuad) {
                              setVpEditEnabled((v) => !v);
                              setVpTool("none");
                              return;
                            }
                            // 没有四边形：进入创建模式（点击4次）
                            setVpEditEnabled(true);
                            setVpTool((t) => (t === "quad" ? "none" : "quad"));
                            setVpQuadPoints([]);
                            setVpHover(null);
                            loadVirtualGridConfig(view.id);
                          }}
                          title="绘制四边形网格区域"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M6 7.5L18 5l1.5 12L7 19.5 6 7.5Z"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <circle cx="6" cy="7.5" r="1.5" fill="currentColor" />
                            <circle cx="18" cy="5" r="1.5" fill="currentColor" />
                            <circle cx="19.5" cy="17" r="1.5" fill="currentColor" />
                            <circle cx="7" cy="19.5" r="1.5" fill="currentColor" />
                          </svg>
                        </button>
                        <div className="flex items-center gap-1 px-1 text-[11px] text-slate-600">
                          <span className="text-slate-500">刷新</span>
                          <select
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]"
                            value={bindVvSnapshotRefreshMs}
                            onChange={(e) => setBindVvSnapshotRefreshMs(Number(e.target.value) || 3000)}
                            title="预览刷新频率（轮询 snapshot.jpg）"
                          >
                            <option value={1000}>1s</option>
                            <option value={3000}>3s</option>
                            <option value={5000}>5s</option>
                            <option value={10000}>10s</option>
                          </select>
                        </div>
                      </div>
                    );

                    const renderOverlay = (
                      ctx: CanvasRenderingContext2D,
                      info: { w: number; h: number; pan: { x: number; y: number }; zoom: number },
                    ) => {
                      // 记录 viewport 尺寸，供 click/hover 使用
                      vpViewportSizeRef.current = { w: info.w, h: info.h, aspectW, aspectH };

                      const { w, h, pan, zoom } = info;
                      const scale = Math.min(w / aspectW, h / aspectH);
                      const imgW = aspectW * scale;
                      const imgH = aspectH * scale;
                      const imgX = (w - imgW) / 2;
                      const imgY = (h - imgH) / 2;

                      const toWorld = (pt: Pt): Pt => ({
                        x: imgX + (pt.x / aspectW) * imgW,
                        y: imgY + (pt.y / aspectH) * imgH,
                      });

                      ctx.save();
                      ctx.translate(pan.x, pan.y);
                      ctx.scale(zoom, zoom);

                      const pts = vpQuad ? vpQuad : vpQuadPoints;
                      if (pts.length > 0) {
                        ctx.strokeStyle = "rgba(14,165,233,1.0)";
                        ctx.fillStyle = "rgba(14,165,233,0.12)";
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        const p0 = toWorld(pts[0]);
                        ctx.moveTo(p0.x, p0.y);
                        for (let i = 1; i < pts.length; i++) {
                          const pi = toWorld(pts[i]);
                          ctx.lineTo(pi.x, pi.y);
                        }
                        if (vpQuad && pts.length === 4) ctx.closePath();
                        ctx.stroke();
                        if (vpQuad && pts.length === 4) ctx.fill();

                        // 顶点仅在编辑模式显示（保存后隐藏）
                        if (vpEditEnabled) {
                          for (let i = 0; i < pts.length; i++) {
                            const p = toWorld(pts[i]);
                            ctx.beginPath();
                            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                            ctx.fillStyle = "rgba(14,165,233,1.0)";
                            ctx.fill();
                            ctx.strokeStyle = "white";
                            ctx.lineWidth = 2;
                            ctx.stroke();
                          }
                        }
                      }

                      if (vpQuad) {
                        const rows = Math.max(1, Number(vpRows) || 1);
                        const cols = Math.max(1, Number(vpCols) || 1);
                        const q = vpQuad;
                        // 使用 homography 做“透视网格”分布：在 unit square 上均分，再投影到四边形
                        const H = computeHomography(
                          [
                            { x: 0, y: 0 },
                            { x: 1, y: 0 },
                            { x: 1, y: 1 },
                            { x: 0, y: 1 },
                          ],
                          q,
                        );

                        const camColsForId = Math.max(1, Number(vpCols) || 1);

                        // selected 高亮（用于“定位”）
                        if (vpSelectedCell && H) {
                          const r = vpSelectedCell.row;
                          const c = vpSelectedCell.col;
                          const u0 = c / cols, u1 = (c + 1) / cols;
                          const v0 = r / rows, v1 = (r + 1) / rows;
                          const cellImg: Pt[] = [
                            applyHomography(H, { x: u0, y: v0 }),
                            applyHomography(H, { x: u1, y: v0 }),
                            applyHomography(H, { x: u1, y: v1 }),
                            applyHomography(H, { x: u0, y: v1 }),
                          ];
                          const cellWorld = cellImg.map(toWorld);
                          ctx.beginPath();
                          ctx.moveTo(cellWorld[0].x, cellWorld[0].y);
                          for (let i = 1; i < 4; i++) ctx.lineTo(cellWorld[i].x, cellWorld[i].y);
                          ctx.closePath();
                          ctx.fillStyle = "rgba(59,130,246,0.18)";
                          ctx.fill();
                          ctx.strokeStyle = "rgba(59,130,246,0.95)";
                          ctx.lineWidth = 2;
                          ctx.stroke();

                          const center = applyHomography(H, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
                          const cw = toWorld(center);
                          ctx.fillStyle = "rgba(15,23,42,0.85)";
                          ctx.font = "bold 12px sans-serif";
                          ctx.textAlign = "center";
                          ctx.textBaseline = "middle";
                          const id = r * camColsForId + c;
                          ctx.fillText(`${id} (${r}-${c})`, cw.x, cw.y);
                        }

                        // linked hover（来自左侧平面图 hover 的联动）
                        if (linkedVpHoverCell && H) {
                          const r = linkedVpHoverCell.row;
                          const c = linkedVpHoverCell.col;
                          const u0 = c / cols, u1 = (c + 1) / cols;
                          const v0 = r / rows, v1 = (r + 1) / rows;
                          const cellImg: Pt[] = [
                            applyHomography(H, { x: u0, y: v0 }),
                            applyHomography(H, { x: u1, y: v0 }),
                            applyHomography(H, { x: u1, y: v1 }),
                            applyHomography(H, { x: u0, y: v1 }),
                          ];
                          const cellWorld = cellImg.map(toWorld);
                          ctx.beginPath();
                          ctx.moveTo(cellWorld[0].x, cellWorld[0].y);
                          for (let i = 1; i < 4; i++) ctx.lineTo(cellWorld[i].x, cellWorld[i].y);
                          ctx.closePath();
                          // 左侧平面图 hover 联动：右侧高亮用不透明颜色（更易观察）
                          ctx.fillStyle = "rgba(34,197,94,1.0)";
                          ctx.fill();
                          ctx.strokeStyle = "rgba(34,197,94,1.0)";
                          ctx.lineWidth = 2;
                          ctx.stroke();
                        }

                        // hover 高亮（行列）
                        if (vpHover && H) {
                          const r = vpHover.row;
                          const c = vpHover.col;
                          const u0 = c / cols, u1 = (c + 1) / cols;
                          const v0 = r / rows, v1 = (r + 1) / rows;
                          const cellImg: Pt[] = [
                            applyHomography(H, { x: u0, y: v0 }),
                            applyHomography(H, { x: u1, y: v0 }),
                            applyHomography(H, { x: u1, y: v1 }),
                            applyHomography(H, { x: u0, y: v1 }),
                          ];
                          const cellWorld = cellImg.map(toWorld);
                          ctx.beginPath();
                          ctx.moveTo(cellWorld[0].x, cellWorld[0].y);
                          for (let i = 1; i < 4; i++) ctx.lineTo(cellWorld[i].x, cellWorld[i].y);
                          ctx.closePath();
                          // hover 选中格子：不透明红色
                          ctx.fillStyle = "rgba(239,68,68,1.0)";
                          ctx.fill();
                          ctx.strokeStyle = "rgba(239,68,68,1.0)";
                          ctx.lineWidth = 2;
                          ctx.stroke();

                          const center = applyHomography(H, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
                          const cw = toWorld(center);
                          ctx.fillStyle = "rgba(15,23,42,0.85)";
                          ctx.font = "bold 12px sans-serif";
                          ctx.textAlign = "center";
                          ctx.textBaseline = "middle";
                          const id = r * camColsForId + c;
                          ctx.fillText(`${id} (${r}-${c})`, cw.x, cw.y);
                        }

                        // 网格线（透视效果：四边形内双线性插值）
                        ctx.strokeStyle = "rgba(14,165,233,0.55)";
                        ctx.lineWidth = 1;
                        if (H) {
                          // 已绑定格子：绿色填充+描边（用于提示不可再选）
                          if (mappedCamCells.size > 0) {
                            ctx.fillStyle = "rgba(34,197,94,0.18)";
                            ctx.strokeStyle = "rgba(34,197,94,0.85)";
                            ctx.lineWidth = 1.5;
                            mappedCamCells.forEach((key) => {
                              const [rs, cs] = key.split(",");
                              const r = Number(rs);
                              const c = Number(cs);
                              if (Number.isNaN(r) || Number.isNaN(c)) return;
                              if (r < 0 || r >= rows || c < 0 || c >= cols) return;
                              const u0 = c / cols, u1 = (c + 1) / cols;
                              const v0 = r / rows, v1 = (r + 1) / rows;
                              const poly = [
                                toWorld(applyHomography(H, { x: u0, y: v0 })),
                                toWorld(applyHomography(H, { x: u1, y: v0 })),
                                toWorld(applyHomography(H, { x: u1, y: v1 })),
                                toWorld(applyHomography(H, { x: u0, y: v1 })),
                              ];
                              ctx.beginPath();
                              ctx.moveTo(poly[0].x, poly[0].y);
                              for (let i = 1; i < 4; i++) ctx.lineTo(poly[i].x, poly[i].y);
                              ctx.closePath();
                              ctx.fill();
                              ctx.stroke();
                            });
                          }

                          for (let r = 0; r <= rows; r++) {
                            const v = r / rows;
                            const pA = toWorld(applyHomography(H, { x: 0, y: v }));
                            const pB = toWorld(applyHomography(H, { x: 1, y: v }));
                            ctx.beginPath();
                            ctx.moveTo(pA.x, pA.y);
                            ctx.lineTo(pB.x, pB.y);
                            ctx.stroke();
                          }
                          for (let c = 0; c <= cols; c++) {
                            const u = c / cols;
                            const pA = toWorld(applyHomography(H, { x: u, y: 0 }));
                            const pB = toWorld(applyHomography(H, { x: u, y: 1 }));
                            ctx.beginPath();
                            ctx.moveTo(pA.x, pA.y);
                            ctx.lineTo(pB.x, pB.y);
                            ctx.stroke();
                          }
                        }
                      }

                      ctx.restore();
                    };

                    const onClickWorld = (world: Pt) => {
                      if (vpTool !== "quad") return;
                      const imgPt = worldToImagePoint(world, vpViewportSizeRef.current, { allowOutside: true });
                      if (!imgPt) return;
                      setVpQuadPoints((old) => {
                        const next = [...old, imgPt];
                        if (next.length === 4) {
                          const ordered = orderQuad(next);
                          setVpQuad(ordered);
                          // 绘制完成后关闭“创建”，进入可编辑顶点状态
                          setVpTool("none");
                          setVpEditEnabled(true);
                          return [];
                        }
                        return next;
                      });
                    };

                    const onMoveWorld = (world: Pt) => {
                      if (!vpQuad) return;
                      // 拖拽顶点时更新顶点位置
                      if (vpDraggingVertex != null) {
                        const imgPt = worldToImagePoint(world, vpViewportSizeRef.current, { allowOutside: true });
                        if (!imgPt) return;
                        setVpQuad((q) => {
                          if (!q) return q;
                          const next = [...q];
                          next[vpDraggingVertex] = imgPt;
                          return next;
                        });
                        return;
                      }
                      const imgPt = worldToImagePoint(world, vpViewportSizeRef.current, { allowOutside: true });
                      if (!imgPt) {
                        setVpHover(null);
                        return;
                      }
                      const rows = Math.max(1, Number(vpRows) || 1);
                      const cols = Math.max(1, Number(vpCols) || 1);
                      const H = computeHomography(
                        [
                          { x: 0, y: 0 },
                          { x: 1, y: 0 },
                          { x: 1, y: 1 },
                          { x: 0, y: 1 },
                        ],
                        vpQuad,
                      );
                      if (!H) {
                        setVpHover(null);
                        return;
                      }
                      // 遍历 cell，找到包含该点的 cell（点在四边形内时才有 hover）
                      let found: { row: number; col: number } | null = null;
                      for (let r = 0; r < rows && !found; r++) {
                        const v0 = r / rows, v1 = (r + 1) / rows;
                        for (let c = 0; c < cols; c++) {
                          const u0 = c / cols, u1 = (c + 1) / cols;
                          const cell: Pt[] = [
                            applyHomography(H, { x: u0, y: v0 }),
                            applyHomography(H, { x: u1, y: v0 }),
                            applyHomography(H, { x: u1, y: v1 }),
                            applyHomography(H, { x: u0, y: v1 }),
                          ];
                          if (pointInPoly(imgPt, cell)) {
                            found = { row: r, col: c };
                            break;
                          }
                        }
                      }
                      setVpHover(found);
                    };

                    const onPointerDownWorld = (world: Pt) => {
                      // 非编辑/非创建时：点击选择一个摄像头格子（用于绑定）
                      if (vpTool === "none" && !vpEditEnabled && vpQuad) {
                        const imgPt = worldToImagePoint(world, vpViewportSizeRef.current, { allowOutside: true });
                        if (imgPt) {
                          const rows = Math.max(1, Number(vpRows) || 1);
                          const cols = Math.max(1, Number(vpCols) || 1);
                          const H = computeHomography(
                            [
                              { x: 0, y: 0 },
                              { x: 1, y: 0 },
                              { x: 1, y: 1 },
                              { x: 0, y: 1 },
                            ],
                            vpQuad,
                          );
                          if (H) {
                            let found: { row: number; col: number } | null = null;
                            for (let r = 0; r < rows && !found; r++) {
                              const v0 = r / rows, v1 = (r + 1) / rows;
                              for (let c = 0; c < cols; c++) {
                                const u0 = c / cols, u1 = (c + 1) / cols;
                                const cell: Pt[] = [
                                  applyHomography(H, { x: u0, y: v0 }),
                                  applyHomography(H, { x: u1, y: v0 }),
                                  applyHomography(H, { x: u1, y: v1 }),
                                  applyHomography(H, { x: u0, y: v1 }),
                                ];
                                if (pointInPoly(imgPt, cell)) {
                                  found = { row: r, col: c };
                                  break;
                                }
                              }
                            }
                            if (found && mappedCamCells.has(`${found.row},${found.col}`)) {
                              // 已绑定的格子不可再次选择
                              return;
                            }
                            setVpSelectedCell(found);
                          }
                        }
                      }
                      if (!vpQuad || !vpEditEnabled) return;
                      const imgPt = worldToImagePoint(world, vpViewportSizeRef.current, { allowOutside: true });
                      if (!imgPt) return;
                      // 命中某个顶点则开始拖拽
                      const hitR = 12; // px in image space
                      for (let i = 0; i < 4; i++) {
                        const dx = imgPt.x - vpQuad[i].x;
                        const dy = imgPt.y - vpQuad[i].y;
                        if (dx * dx + dy * dy <= hitR * hitR) {
                          setVpDraggingVertex(i);
                          return true;
                        }
                      }
                    };

                    const onPointerUpWorld = () => {
                      setVpDraggingVertex(null);
                    };

                    return (
                      <div className="flex h-full w-full flex-col">
                        <div className="flex-1">
                          <PanZoomViewport
                            className="h-full w-full"
                            mode={vpTool === "quad" ? "draw" : "panzoom"}
                            topLeftOverlay={toolbar}
                            renderOverlay={renderOverlay}
                            onClickWorld={onClickWorld}
                            onMoveWorld={onMoveWorld}
                            onPointerDownWorld={onPointerDownWorld}
                            onPointerUpWorld={onPointerUpWorld}
                          >
                            {bindVvSnapshotObjUrl ? (
                              <img
                                src={bindVvSnapshotObjUrl}
                                alt={`virtual-view-${view.id}`}
                                draggable={false}
                                onDragStart={(e) => e.preventDefault()}
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                                加载中…
                              </div>
                            )}
                          </PanZoomViewport>
                        </div>

                        {vpTool === "quad" && !vpQuad && (
                          <div className="mt-2 text-[11px] text-slate-500">
                            点击画面 4 次确定四边形四个点（用于生成透视网格）。
                          </div>
                        )}

                        {vpQuad && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label className="text-xs text-slate-600">
                              行数
                              <input
                                type="number"
                                min={1}
                                className="ml-1 w-16 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                                value={vpRows}
                                onChange={(e) => setVpRows(e.target.value)}
                              />
                            </label>
                            <label className="text-xs text-slate-600">
                              列数
                              <input
                                type="number"
                                min={1}
                                className="ml-1 w-16 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                                value={vpCols}
                                onChange={(e) => setVpCols(e.target.value)}
                              />
                            </label>
                            <button
                              type="button"
                              className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-50"
                              disabled={vpSaving}
                              onClick={() => saveVirtualGridConfig(view.id)}
                            >
                              {vpSaving ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              className="rounded border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 hover:bg-rose-50"
                              onClick={async () => {
                                try {
                                  await fetch(
                                    `${API_BASE}/api/cameras/virtual-views/${view.id}/grid-config`,
                                    { method: "DELETE" },
                                  );
                                } catch (e) {
                                  console.error(e);
                                }
                                setVpQuad(null);
                                setVpQuadPoints([]);
                                setVpHover(null);
                                setVpTool("none");
                                setVpEditEnabled(false);
                                setVpDraggingVertex(null);
                              }}
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                              onClick={() => {
                                // 重置回已保存配置（若无保存配置则清空）
                                loadVirtualGridConfig(view.id);
                              }}
                            >
                              重置
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <span className="text-xs text-slate-400">
                    当前无摄像头配置，请在“摄像头管理”子页中添加。
                  </span>
                )}
            </div>
          </div>

          {/* 摄像头预览右侧：映射数据列表（独立面板） */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-0 shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-sm font-semibold text-slate-800">映射数据列表</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                平面图网格ID ↔ 摄像头画面网格ID
              </div>
            </div>
            <div className="border-b border-slate-200 p-3">
              <div className="text-[11px] text-slate-600">
                <div>
                  摄像头格子：
                  <span className="ml-1 font-mono text-slate-800">
                    {vpSelectedCell
                      ? `${vpSelectedCell.row * Math.max(1, Number(vpCols) || 1) + vpSelectedCell.col} (${vpSelectedCell.row}-${vpSelectedCell.col})`
                      : "-"}
                  </span>
                </div>
                <div className="mt-1">
                  平面图格子：
                  <span className="ml-1 font-mono text-slate-800">
                    {fpSelectedCell && bindFloorPlanId !== "" && typeof bindFloorPlanId === "number"
                      ? `${fpSelectedCell.row * (Math.max(1, Number(bindGridCols) || 1)) + fpSelectedCell.col} (${fpSelectedCell.row}-${fpSelectedCell.col})`
                      : "-"}
                  </span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-50"
                  disabled={
                    mappingsSaving ||
                    !vpSelectedCell ||
                    !fpSelectedCell ||
                    bindFloorPlanId === "" ||
                    typeof bindFloorPlanId !== "number"
                  }
                  onClick={async () => {
                    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
                    if (!opt || opt.kind !== "virtual") return;
                    if (!vpSelectedCell || !fpSelectedCell) return;
                    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") return;
                    setMappingsSaving(true);
                    try {
                      const res = await fetch(
                        `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings`,
                        {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            floor_plan_id: bindFloorPlanId,
                            camera_row: vpSelectedCell.row,
                            camera_col: vpSelectedCell.col,
                            floor_row: fpSelectedCell.row,
                            floor_col: fpSelectedCell.col,
                          }),
                        },
                      );
                      if (!res.ok) throw new Error("save failed");
                      // reload list
                      const res2 = await fetch(
                        `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings?floor_plan_id=${bindFloorPlanId}`,
                      );
                      if (res2.ok) setCellMappings(await res2.json());
                      setBindingColorRefreshTick((t) => t + 1);
                      setReplaceMappingId(null);
                    } catch (e) {
                      console.error(e);
                      alert("绑定保存失败");
                    } finally {
                      setMappingsSaving(false);
                    }
                  }}
                >
                  {replaceMappingId ? "替换绑定" : "绑定"}
                </button>
                <button
                  type="button"
                  className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                  onClick={() => {
                    setVpSelectedCell(null);
                    setFpSelectedCell(null);
                    setReplaceMappingId(null);
                  }}
                >
                  清除选择
                </button>
                <button
                  type="button"
                  className="rounded border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  disabled={
                    mappingsSaving ||
                    bindFloorPlanId === "" ||
                    typeof bindFloorPlanId !== "number" ||
                    !(bindCameraOptions.find((o) => o.key === bindCameraId) || null) ||
                    (bindCameraOptions.find((o) => o.key === bindCameraId) || null)?.kind !== "virtual"
                  }
                  onClick={async () => {
                    const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
                    if (!opt || opt.kind !== "virtual") return;
                    if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") return;
                    if (!confirm("确定清除当前摄像头的所有绑定关系吗？")) return;
                    setMappingsSaving(true);
                    try {
                      const res = await fetch(
                        `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings?floor_plan_id=${bindFloorPlanId}`,
                        { method: "DELETE" },
                      );
                      if (!res.ok) throw new Error("delete all failed");
                      setCellMappings([]);
                      setBindingColorRefreshTick((t) => t + 1);
                      setVpSelectedCell(null);
                      setFpSelectedCell(null);
                      setReplaceMappingId(null);
                    } catch (e) {
                      console.error(e);
                      alert("清除失败");
                    } finally {
                      setMappingsSaving(false);
                    }
                  }}
                >
                  清除所有绑定
                </button>
              </div>
              {replaceMappingId && (
                <div className="mt-2 text-[11px] text-rose-600">
                  正在替换：请重新选择平面图格子后点击“替换绑定”。
                </div>
              )}
              <div className="mt-3 rounded border border-slate-200 bg-white p-2">
                <div className="mb-1 text-[11px] font-semibold text-slate-700">锚点自动匹配</div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    disabled={
                      !vpSelectedCell ||
                      !fpSelectedCell ||
                      autoAnchors.length >= 4 ||
                      autoAnchors.some(
                        (a) =>
                          a.camera_row === (vpSelectedCell?.row ?? -1) &&
                          a.camera_col === (vpSelectedCell?.col ?? -1),
                      ) ||
                      autoAnchors.some(
                        (a) =>
                          a.floor_row === (fpSelectedCell?.row ?? -1) &&
                          a.floor_col === (fpSelectedCell?.col ?? -1),
                      )
                    }
                    onClick={() => {
                      if (!vpSelectedCell || !fpSelectedCell) return;
                      if (autoAnchors.length >= 4) return;
                      const newItem = {
                        camera_row: vpSelectedCell.row,
                        camera_col: vpSelectedCell.col,
                        floor_row: fpSelectedCell.row,
                        floor_col: fpSelectedCell.col,
                      };
                      setAutoAnchors((list) => {
                        if (
                          list.some(
                            (a) =>
                              a.camera_row === newItem.camera_row &&
                              a.camera_col === newItem.camera_col,
                          )
                        )
                          return list;
                        if (
                          list.some(
                            (a) =>
                              a.floor_row === newItem.floor_row &&
                              a.floor_col === newItem.floor_col,
                          )
                        )
                          return list;
                        return [...list, newItem].slice(0, 4);
                      });
                    }}
                  >
                    添加锚点
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    disabled={autoAnchors.length === 0}
                    onClick={() => setAutoAnchors([])}
                  >
                    清空锚点
                  </button>
                  <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={autoOverwrite}
                      onChange={(e) => setAutoOverwrite(e.target.checked)}
                    />
                    覆盖冲突
                  </label>
                  <button
                    type="button"
                    className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    disabled={
                      mappingsSaving ||
                      autoAnchors.length < 4 ||
                      bindFloorPlanId === "" ||
                      typeof bindFloorPlanId !== "number" ||
                      !(bindCameraOptions.find((o) => o.key === bindCameraId) || null) ||
                      (bindCameraOptions.find((o) => o.key === bindCameraId) || null)?.kind !== "virtual"
                    }
                    onClick={async () => {
                      const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
                      if (!opt || opt.kind !== "virtual") return;
                      if (bindFloorPlanId === "" || typeof bindFloorPlanId !== "number") return;
                      if (autoAnchors.length < 4) return;
                      setMappingsSaving(true);
                      try {
                        const res = await fetch(
                          `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings/auto-anchors`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              floor_plan_id: bindFloorPlanId,
                              anchors: autoAnchors,
                              overwrite_conflict: autoOverwrite,
                            }),
                          },
                        );
                        if (!res.ok) {
                          const txt = await res.text();
                          throw new Error(txt || "auto-anchors failed");
                        }
                        const res2 = await fetch(
                          `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings?floor_plan_id=${bindFloorPlanId}`,
                        );
                        if (res2.ok) setCellMappings(await res2.json());
                        setBindingColorRefreshTick((t) => t + 1);
                      } catch (e) {
                        console.error(e);
                        alert("自动匹配失败");
                      } finally {
                        setMappingsSaving(false);
                      }
                    }}
                  >
                    自动匹配
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {autoAnchors.map((a, idx) => (
                    <div key={`${a.camera_row},${a.camera_col},${a.floor_row},${a.floor_col}`} className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]">
                      <div className="font-mono text-slate-800">
                        C {a.camera_row}-{a.camera_col} → F {a.floor_row}-{a.floor_col}
                      </div>
                      <button
                        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        onClick={() => setAutoAnchors((list) => list.filter((_, i) => i !== idx))}
                      >
                        删
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {mappingsLoading ? (
                <div className="text-xs text-slate-500">加载中…</div>
              ) : cellMappings.length === 0 ? (
                <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-500">
                  暂无映射关系。先在右侧画面点选一个摄像头格子，再在左侧点选一个平面图格子，点击“绑定”。
                </div>
              ) : (
                <div className="space-y-2">
                  {cellMappings.map((m) => {
                    const camCols = Math.max(1, Number(vpCols) || 1);
                    const floorCols = Math.max(1, Number(bindGridCols) || 1);
                    const camId = m.camera_row * camCols + m.camera_col;
                    const floorId = m.floor_row * floorCols + m.floor_col;
                    return (
                      <div
                        key={m.id}
                        className={`rounded border px-2 py-2 text-[11px] ${
                          replaceMappingId === m.id
                            ? "border-rose-300 bg-rose-50"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-slate-800">
                              C: {camId} ({m.camera_row}-{m.camera_col})
                            </div>
                            <div className="font-mono text-slate-800">
                              F: {floorId} ({m.floor_row}-{m.floor_col})
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button
                              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                              onClick={() => {
                                setVpSelectedCell({ row: m.camera_row, col: m.camera_col });
                                setFpSelectedCell({ row: m.floor_row, col: m.floor_col });
                              }}
                              title="定位高亮"
                            >
                              定位
                            </button>
                            <button
                              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                              onClick={() => {
                                setReplaceMappingId(m.id);
                                setVpSelectedCell({ row: m.camera_row, col: m.camera_col });
                              }}
                              title="替换平面图格子"
                            >
                              替换
                            </button>
                            <button
                              className="rounded border border-rose-300 bg-white px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50"
                              onClick={async () => {
                                const opt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
                                if (!opt || opt.kind !== "virtual") return;
                                try {
                                  const res = await fetch(
                                    `${API_BASE}/api/cameras/virtual-views/${opt.view.id}/cell-mappings/${m.id}`,
                                    { method: "DELETE" },
                                  );
                                  if (!res.ok) throw new Error("delete failed");
                                  setCellMappings((old) => old.filter((x) => x.id !== m.id));
                                  setBindingColorRefreshTick((t) => t + 1);
                                  if (replaceMappingId === m.id) setReplaceMappingId(null);
                                } catch (e) {
                                  console.error(e);
                                  alert("删除失败");
                                }
                              }}
                              title="删除"
                            >
                              删
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. 摄像头管理：复用现有 CameraManageView */}
      {mappingTab === "cameras" && <CameraManageView />}

      {/* 2.5 全景相机视窗配置：virtual PTZ 视口参数 + MJPEG 预览 */}
      {mappingTab === "panoramaViews" && <PanoramaViewsView onViewsChanged={loadBindCameras} />}

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
                    className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-[#694FF9] file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-[#5b3ff6]"
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
                className="mt-1 inline-flex items-center rounded bg-[#694FF9] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#5b3ff6]"
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
                            className="mt-0.5 block w-full text-xs file:rounded file:border-0 file:bg-[#694FF9] file:px-2 file:py-0.5 file:text-white hover:file:bg-[#5b3ff6]"
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
                            className="rounded bg-[#694FF9] px-3 py-1 text-white hover:bg-[#5b3ff6]"
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

const PanoramaViewsView: React.FC<{ onViewsChanged?: () => void }> = ({ onViewsChanged }) => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cameraId, setCameraId] = useState<number | "">("");
  const [views, setViews] = useState<(CameraVirtualView & { camera_name?: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editMode, setEditMode] = useState<Record<number, boolean>>({});
  // 卡片是否开启“实时预览”（默认关闭：只显示缩略图）
  const [livePreview, setLivePreview] = useState<Record<number, boolean>>({});
  // 缩略图 objectURL（预取 blob 后再替换，避免闪烁）
  const [snapshotObjUrl, setSnapshotObjUrl] = useState<Record<number, string>>({});
  // 全局缩略图刷新周期（ms）
  const [snapshotRefreshMs, setSnapshotRefreshMs] = useState<number>(3000);
  // 用于强制 MJPEG 预览重连（保存参数后刷新画面）
  const [previewNonce, setPreviewNonce] = useState<Record<number, number>>({});
  // 为了避免频繁保存导致浏览器保留旧 MJPEG 连接，这里在重连时先短暂卸载 <img>
  const [previewDisabled, setPreviewDisabled] = useState<Record<number, boolean>>({});
  const previewRefreshTimersRef = useRef<Record<number, number>>({});
  const snapshotPollIdxRef = useRef(0);
  const snapshotInFlightRef = useRef<Record<number, boolean>>({});

  const loadCameras = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/cameras/`);
    const data: Camera[] = await res.json();
    setCameras(data);
    if (data.length > 0 && cameraId === "") setCameraId(data[0].id);
  }, [cameraId]);

  const loadViews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/cameras/virtual-views/all`);
      const data: (CameraVirtualView & { camera_name?: string })[] = await res.json();
      setViews(data);
      // 默认只读：新加载的视窗默认不可编辑
      setEditMode((old) => {
        const next: Record<number, boolean> = { ...old };
        const existing = new Set(data.map((v) => v.id));
        // 清理已删除项
        Object.keys(next).forEach((k) => {
          const id = Number(k);
          if (!existing.has(id)) delete next[id];
        });
        // 为新项补默认 false
        data.forEach((v) => {
          if (next[v.id] === undefined) next[v.id] = false;
        });
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCameras();
  }, [loadCameras]);

  useEffect(() => {
    loadViews();
  }, [loadViews]);

  const refreshSnapshot = useCallback(
    async (v: CameraVirtualView) => {
      if (livePreview[v.id]) return;
      if (snapshotInFlightRef.current[v.id]) return;
      snapshotInFlightRef.current[v.id] = true;
      const snapshotUrl = `${API_BASE}/api/cameras/${v.camera_id}/virtual-views/${v.id}/snapshot.jpg?t=${Date.now()}`;
      try {
        const res = await fetch(snapshotUrl, { cache: "no-store" });
        if (!res.ok) return;
        if (res.status === 204) return;
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);

        // 先预解码，确保新图就绪后再替换，避免闪白
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = objUrl;
        });

        setSnapshotObjUrl((old) => {
          const prev = old[v.id];
          const next = { ...old, [v.id]: objUrl };
          if (prev && prev !== objUrl) {
            try {
              URL.revokeObjectURL(prev);
            } catch {}
          }
          return next;
        });
      } catch {
        // ignore
      } finally {
        snapshotInFlightRef.current[v.id] = false;
      }
    },
    [livePreview],
  );

  // 初次进入/视窗列表变化：先拉一轮缩略图
  useEffect(() => {
    views.forEach((v) => {
      if (!livePreview[v.id]) void refreshSnapshot(v);
    });
  }, [views, livePreview, refreshSnapshot]);

  // 缩略图轮询：错峰刷新（整体一轮约 3 秒）
  useEffect(() => {
    if (views.length === 0) return;
    const tickMs = Math.max(200, Math.floor(snapshotRefreshMs / Math.max(1, views.length)));
    const t = window.setInterval(() => {
      const nonLive = views.filter((v) => !livePreview[v.id]);
      if (nonLive.length === 0) return;
      const idx = snapshotPollIdxRef.current % nonLive.length;
      snapshotPollIdxRef.current = (snapshotPollIdxRef.current + 1) % 1_000_000;
      void refreshSnapshot(nonLive[idx]);
    }, tickMs);
    return () => window.clearInterval(t);
  }, [views, livePreview, refreshSnapshot, snapshotRefreshMs]);

  // 组件卸载时回收 objectURL，避免内存泄漏
  useEffect(() => {
    return () => {
      try {
        Object.values(snapshotObjUrl).forEach((u) => {
          if (typeof u === "string" && u) URL.revokeObjectURL(u);
        });
      } catch {}
    };
  }, [snapshotObjUrl]);

  const bumpPreview = (viewId: number) => {
    setPreviewNonce((m) => ({ ...m, [viewId]: Date.now() }));
  };

  const forceRefreshPreview = (viewId: number) => {
    // 连续点击时，取消上一次的定时器，避免永远卡在“无画面/重连中”
    const oldTimer = previewRefreshTimersRef.current[viewId];
    if (oldTimer) {
      window.clearTimeout(oldTimer);
      delete previewRefreshTimersRef.current[viewId];
    }
    // 先卸载 img，确保连接断开
    setPreviewDisabled((m) => ({ ...m, [viewId]: true }));
    // 清除 nonce，保证重新挂载时一定是新 URL
    setPreviewNonce((m) => {
      const next = { ...m };
      delete next[viewId];
      return next;
    });
    const t = window.setTimeout(() => {
      bumpPreview(viewId);
      setPreviewDisabled((m) => ({ ...m, [viewId]: false }));
      delete previewRefreshTimersRef.current[viewId];
    }, 800);
    previewRefreshTimersRef.current[viewId] = t;
  };

  const createView = async () => {
    if (cameraId === "") return;
    setCreating(true);
    try {
      const existingCount = views.filter((x) => x.camera_id === cameraId).length;
      const res = await fetch(`${API_BASE}/api/cameras/${cameraId}/virtual-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          camera_id: cameraId,
          name: `View ${existingCount + 1}`,
          enabled: true,
          yaw_deg: 0,
          pitch_deg: 0,
          fov_deg: 90,
          out_w: 512,
          out_h: 512,
        }),
      });
      if (!res.ok) {
        alert("创建视窗失败");
        return;
      }
      const created: CameraVirtualView = await res.json();
      await loadViews();
      onViewsChanged?.();
      bumpPreview(created.id);
    } finally {
      setCreating(false);
    }
  };

  const updateView = async (v: CameraVirtualView) => {
    // 后端已支持热加载参数：保存后无需强制重连 MJPEG，否则容易出现短时间断流导致空白
    const res = await fetch(`${API_BASE}/api/cameras/${v.camera_id}/virtual-views/${v.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: v.name,
        enabled: v.enabled,
        yaw_deg: v.yaw_deg,
        pitch_deg: v.pitch_deg,
        fov_deg: v.fov_deg,
        out_w: v.out_w,
        out_h: v.out_h,
      }),
    });
    if (!res.ok) {
      alert("保存失败");
      return;
    }
    await loadViews();
    onViewsChanged?.();
    setEditMode((old) => ({ ...old, [v.id]: false }));
  };

  const deleteView = async (viewId: number) => {
    const v = views.find((x) => x.id === viewId);
    if (!v) return;
    if (!confirm("确定删除该视窗吗？")) return;
    const res = await fetch(`${API_BASE}/api/cameras/${v.camera_id}/virtual-views/${viewId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      alert("删除失败");
      return;
    }
    await loadViews();
    onViewsChanged?.();
    setPreviewNonce((m) => {
      const next = { ...m };
      delete next[viewId];
      return next;
    });
    setPreviewDisabled((m) => {
      const next = { ...m };
      delete next[viewId];
      return next;
    });
    setLivePreview((m) => {
      const next = { ...m };
      delete next[viewId];
      return next;
    });
    setSnapshotObjUrl((m) => {
      const next = { ...m };
      const u = next[viewId];
      delete next[viewId];
      if (u) {
        try {
          URL.revokeObjectURL(u);
        } catch {}
      }
      return next;
    });
    setEditMode((m) => {
      const next = { ...m };
      delete next[viewId];
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {/* C 方案：创建区独立模块 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">创建新视窗</span>
            <span className="text-[11px] text-slate-400">选择摄像机后点击新增</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value ? Number(e.target.value) : "")}
            >
              {cameras.length === 0 && <option value="">无摄像机</option>}
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} #{c.id}
                </option>
              ))}
            </select>
            <button
              className="rounded bg-[#694FF9] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-50"
              disabled={cameraId === "" || creating}
              onClick={createView}
            >
              {creating ? "创建中…" : "新增视窗"}
            </button>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          说明：此页面用于 360 全景相机的 virtual PTZ 透视视窗配置。预览使用 MJPEG 流（后续可替换为 WebRTC）。
        </div>
      </div>

      {/* C 方案：已创建列表独立模块 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">已创建视窗</div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-[11px] text-slate-500">
              <span>缩略图刷新</span>
              <select
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]"
                value={snapshotRefreshMs}
                onChange={(e) => setSnapshotRefreshMs(Number(e.target.value) || 3000)}
                title="缩略图刷新频率（错峰轮询，不会同一时间全部刷新）"
              >
                <option value={1000}>1s</option>
                <option value={3000}>3s</option>
                <option value={5000}>5s</option>
              </select>
            </div>
            <div className="text-[11px] text-slate-500">共 {views.length} 个</div>
          </div>
        </div>
        {loading ? (
          <div className="text-xs text-slate-500">加载中…</div>
        ) : views.length === 0 ? (
          <div className="text-xs text-slate-500">暂无视窗配置，点击上方“新增视窗”。</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            {views.map((v, idx) => {
              const previewUrl = `${API_BASE}/api/cameras/${v.camera_id}/virtual-views/${v.id}/preview_shared.mjpeg`;
              const nonce = previewNonce[v.id];
              const previewUrlWithNonce = previewUrl ? (nonce ? `${previewUrl}?t=${nonce}` : previewUrl) : "";
              const snapObj = snapshotObjUrl[v.id] || "";
              const canEdit = !!editMode[v.id];
              const isLive = !!livePreview[v.id];
              return (
                <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800">
                      视窗 {idx + 1}{" "}
                      <span className="text-[11px] font-normal text-slate-400">#{v.id}</span>
                    </div>
                    {v.camera_name && (
                      <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                        摄像机：{v.camera_name} #{v.camera_id}
                      </div>
                    )}
                    <input
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      value={v.name}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setViews((old) => old.map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)))
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {!canEdit && (
                      <button
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        onClick={() => setEditMode((old) => ({ ...old, [v.id]: true }))}
                      >
                        编辑
                      </button>
                    )}
                    <button
                      className={`rounded border px-2 py-1 text-xs font-medium hover:bg-slate-50 ${
                        isLive ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-300 bg-white text-slate-700"
                      }`}
                      onClick={() => {
                        setLivePreview((old) => {
                          const next = { ...old, [v.id]: !old[v.id] };
                          return next;
                        });
                        // 开启实时后，强制让 MJPEG 使用新 nonce（避免复用旧连接）
                        if (!isLive) bumpPreview(v.id);
                      }}
                      title={isLive ? "停止实时预览（回到缩略图）" : "开始实时预览"}
                    >
                      {isLive ? "停止预览" : "开始预览"}
                    </button>
                    <button
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        // 实时：强制重连；缩略图：立即刷新一张
                        if (isLive) {
                          forceRefreshPreview(v.id);
                        } else {
                          void refreshSnapshot(v);
                        }
                      }}
                    >
                      刷新
                    </button>
                    <button
                      className="rounded border border-rose-300 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      onClick={() => deleteView(v.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="flex gap-3">
                  {/* 左侧：预览 */}
                  <div className="w-64 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-100">
                    {isLive ? (
                      previewUrlWithNonce && !previewDisabled[v.id] ? (
                      <img
                        key={`${v.id}-${nonce}`}
                        src={previewUrlWithNonce}
                        alt={`virtual-view-${v.id}`}
                        className="h-48 w-full object-contain"
                        draggable={false}
                      />
                      ) : (
                        <div className="flex h-48 items-center justify-center text-[11px] text-slate-500">
                          {previewDisabled[v.id] ? "重连中…" : "无预览"}
                        </div>
                      )
                    ) : (
                      snapObj ? (
                        <img
                          key={`${v.id}-snap`}
                          src={snapObj}
                          alt={`virtual-view-snap-${v.id}`}
                          className="h-48 w-full object-contain"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-48 items-center justify-center text-[11px] text-slate-500">
                          暂无缩略图
                        </div>
                      )
                    )}
                  </div>

                  {/* 右侧：参数 */}
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center gap-2">
                      <label className="text-xs text-slate-600">
                        <input
                          type="checkbox"
                          className="mr-1 align-middle"
                          checked={v.enabled}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setViews((old) =>
                              old.map((x) => (x.id === v.id ? { ...x, enabled: e.target.checked } : x)),
                            )
                          }
                        />
                        启用
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <label className="text-slate-600">
                        Yaw(°)
                        <input
                          type="number"
                          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
                          value={v.yaw_deg}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setViews((old) =>
                              old.map((x) => (x.id === v.id ? { ...x, yaw_deg: Number(e.target.value) } : x)),
                            )
                          }
                        />
                      </label>
                      <label className="text-slate-600">
                        Pitch(°)
                        <input
                          type="number"
                          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
                          value={v.pitch_deg}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setViews((old) =>
                              old.map((x) => (x.id === v.id ? { ...x, pitch_deg: Number(e.target.value) } : x)),
                            )
                          }
                        />
                      </label>
                      <label className="col-span-2 text-slate-600">
                        输出(w×h)
                        <div className="mt-0.5 flex gap-1">
                          <input
                            type="number"
                            className="w-1/2 rounded border border-slate-300 px-2 py-1"
                            value={v.out_w}
                            disabled={!canEdit}
                            onChange={(e) =>
                              setViews((old) =>
                                old.map((x) => (x.id === v.id ? { ...x, out_w: Number(e.target.value) } : x)),
                              )
                            }
                          />
                          <input
                            type="number"
                            className="w-1/2 rounded border border-slate-300 px-2 py-1"
                            value={v.out_h}
                            disabled={!canEdit}
                            onChange={(e) =>
                              setViews((old) =>
                                old.map((x) => (x.id === v.id ? { ...x, out_h: Number(e.target.value) } : x)),
                              )
                            }
                          />
                        </div>
                      </label>
                      <label className="col-span-2 text-slate-600">
                        FOV(°)
                        <input
                          type="number"
                          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
                          value={v.fov_deg}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setViews((old) =>
                              old.map((x) => (x.id === v.id ? { ...x, fov_deg: Number(e.target.value) } : x)),
                            )
                          }
                        />
                      </label>
                    </div>

                    <div className="mt-2 flex gap-2">
                      {canEdit ? (
                        <button
                          className="rounded bg-[#694FF9] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-50"
                          onClick={() => updateView(v)}
                          disabled={!!previewDisabled[v.id]}
                        >
                          保存参数
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
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
  const [editing, setEditing] = useState<Camera | null>(null);
  const [editName, setEditName] = useState("");
  const [editRtspUrl, setEditRtspUrl] = useState("");
  const [editWebrtcUrl, setEditWebrtcUrl] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editDescription, setEditDescription] = useState("");
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

  const openEdit = (c: Camera) => {
    setEditing(c);
    setEditName(c.name);
    setEditRtspUrl(c.rtsp_url);
    setEditWebrtcUrl(c.webrtc_url || "");
    setEditEnabled(!!c.enabled);
    setEditDescription(c.description || "");
  };

  const closeEdit = () => {
    setEditing(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const id = editing.id;
    const res = await fetch(`${API_BASE}/api/cameras/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        rtsp_url: editRtspUrl,
        webrtc_url: editWebrtcUrl || null,
        enabled: editEnabled,
        description: editDescription || null,
      }),
    });
    if (!res.ok) {
      alert("保存失败");
      return;
    }
    closeEdit();
    await loadCameras();
  };

  const deleteCamera = async (c: Camera) => {
    const ok = confirm(`确认删除摄像头「${c.name}」吗？\n删除后其 virtual PTZ 配置也会被删除。`);
    if (!ok) return;
    const res = await fetch(`${API_BASE}/api/cameras/${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("删除失败");
      return;
    }
    await loadCameras();
  };

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
              className="rounded bg-[#694FF9] px-3 py-1 text-sm font-medium text-white hover:bg-[#5b3ff6] disabled:cursor-not-allowed disabled:bg-slate-300"
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
                      className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
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
              className="mt-1 inline-flex items-center rounded bg-[#694FF9] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#5b3ff6]"
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
                <th className="border border-slate-200 px-2 py-1">操作</th>
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
                  <td className="border border-slate-200 px-2 py-1">
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
                        onClick={() => openEdit(c)}
                      >
                        编辑
                      </button>
                      <button
                        className="rounded border border-rose-300 px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50"
                        onClick={() => deleteCamera(c)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {cameras.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
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

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-xl bg-white p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">
                编辑摄像头（ID: {editing.id}）
              </div>
              <button
                className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
                onClick={closeEdit}
              >
                关闭
              </button>
            </div>
            <div className="space-y-2 text-sm">
              <label className="block text-slate-700">
                名称
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </label>
              <label className="block text-slate-700">
                RTSP URL
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={editRtspUrl}
                  onChange={(e) => setEditRtspUrl(e.target.value)}
                />
              </label>
              <label className="block text-slate-700">
                WebRTC 播放地址
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={editWebrtcUrl}
                  onChange={(e) => setEditWebrtcUrl(e.target.value)}
                />
              </label>
              <label className="flex items-center text-slate-700">
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={editEnabled}
                  onChange={(e) => setEditEnabled(e.target.checked)}
                />
                启用
              </label>
              <label className="block text-slate-700">
                备注
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                onClick={closeEdit}
              >
                取消
              </button>
              <button
                className="rounded bg-[#694FF9] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#5b3ff6]"
                onClick={saveEdit}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
