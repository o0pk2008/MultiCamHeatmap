import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../../shared/config";
import { floorPlanImageUrl } from "../../shared/floorPlan";
import { FloorPlan } from "../../shared/types";

type FloorPlanCanvasLikeProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  showGrid?: boolean;
  backgroundColor?: string;
  heatmapCells?: Map<string, number>;
  poiCells?: Map<string, number>;
  heatmapRender?: {
    colormap: "viridis" | "greenRed";
    scale: "log" | "linear";
    clip: "p95" | "p99" | "max";
    alphaMode: "byValue" | "fixed";
    vMax: number;
  };
  className?: string;
};

type SharePageProps = {
  params: URLSearchParams;
  FloorPlanCanvasComponent: React.ComponentType<FloorPlanCanvasLikeProps>;
};

export const ShareHeatmapPage: React.FC<SharePageProps> = ({ params, FloorPlanCanvasComponent }) => {
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
          <FloorPlanCanvasComponent
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

export const SharePeoplePage: React.FC<SharePageProps> = ({ params, FloorPlanCanvasComponent }) => {
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
          <FloorPlanCanvasComponent
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
