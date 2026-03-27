import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../shared/clipboard";
import { API_BASE } from "../shared/config";
import { floorPlanImageUrl, preloadFloorPlanImage } from "../shared/floorPlan";
import { Camera, FloorPlan, Footfall, HeatmapSource } from "../shared/types";

type FloorPlanCanvasLikeProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  className?: string;
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
};

type MappedGridLikeProps = {
  sources: HeatmapSource[];
  analyzing: boolean;
  vvFootfalls: Record<number, Footfall[]>;
  mjpegStreamEpoch?: number;
};

type HeatmapViewProps = {
  FloorPlanCanvasComponent: React.ComponentType<FloorPlanCanvasLikeProps>;
  MappedCamerasGridComponent: React.ComponentType<MappedGridLikeProps>;
};

const HeatmapView: React.FC<HeatmapViewProps> = ({
  FloorPlanCanvasComponent,
  MappedCamerasGridComponent,
}) => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);
  const [heatmapSources, setHeatmapSources] = useState<HeatmapSource[]>([]);
  const [showHeatmapGrid, setShowHeatmapGrid] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  /** 递增以强制映射宫格 MJPEG 换源、重建连接（与 preview_shared ⇄ analyzed 切换配套） */
  const [heatmapMjpegStreamEpoch, setHeatmapMjpegStreamEpoch] = useState(0);
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
  const heatmapWsIntentionalCloseRef = useRef(false);
  const heatmapReconnectTimerRef = useRef<number | null>(null);
  const openHeatmapWsLiveRef = useRef<(floorPlanId: number) => void>(() => {});
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
          const prevList = Array.isArray(old[vvId]) ? old[vvId] : [];
          const fresh = prevList.filter((p) => now - p.ts <= 1200);
          const withoutSame = fresh.filter((p) => !(p.row === rr && p.col === cc));
          const nextList = [...withoutSame, { row: rr, col: cc, ts: now }].slice(-6);
          return { ...old, [vvId]: nextList };
        });
      }
    }
  }, []);

  const handlePoiOverlayEvent = useCallback(
    (evt: any, floorPlanId: number) => {
      if (!showPeopleOverlayRef.current || heatmapDataMode !== "live" || evt.floor_plan_id !== floorPlanId) return;
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

  const openHeatmapWebSocket = useCallback((floorPlanId: number) => {
    if (heatmapReconnectTimerRef.current != null) {
      window.clearTimeout(heatmapReconnectTimerRef.current);
      heatmapReconnectTimerRef.current = null;
    }
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;

    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(/:\d+$/, ":18080")}/ws/heatmap-events`,
    );
    ws.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (!heatmapUpdatesEnabledRef.current) return;
        handleHeatmapEvent(evt, floorPlanId);
        handlePoiOverlayEvent(evt, floorPlanId);
      } catch (e) {
        console.error(e);
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      if (heatmapWsIntentionalCloseRef.current) {
        heatmapWsIntentionalCloseRef.current = false;
        setHeatmapMjpegStreamEpoch((n) => n + 1);
        return;
      }
      heatmapReconnectTimerRef.current = window.setTimeout(() => {
        heatmapReconnectTimerRef.current = null;
        void (async () => {
          try {
            const r = await fetch(`${API_BASE}/api/heatmap/status?floor_plan_id=${floorPlanId}`);
            const data = r.ok ? await r.json() : null;
            if (data?.running) {
              setAnalyzing(true);
              openHeatmapWsLiveRef.current(floorPlanId);
              setHeatmapMjpegStreamEpoch((n) => n + 1);
            } else {
              setAnalyzing(false);
              setHeatmapMjpegStreamEpoch((n) => n + 1);
            }
          } catch {
            setAnalyzing(false);
          }
        })();
      }, 450);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
    wsRef.current = ws;
  }, [handleHeatmapEvent, handlePoiOverlayEvent]);

  useEffect(() => {
    openHeatmapWsLiveRef.current = openHeatmapWebSocket;
  }, [openHeatmapWebSocket]);

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
    } catch {}
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
          setAnalyzing(true);
          setHeatmapDataMode("live");
          void loadCurrentDwellFromBackend(fpId);
          lastSampleByEntityRef.current = new Map();
          heatmapWsIntentionalCloseRef.current = false;
          openHeatmapWebSocket(fpId);
          setHeatmapMjpegStreamEpoch((n) => n + 1);
        } else {
          heatmapWsIntentionalCloseRef.current = true;
          wsRef.current?.close();
          heatmapWsIntentionalCloseRef.current = false;
          wsRef.current = null;
          setAnalyzing(false);
          setHeatmapMjpegStreamEpoch((n) => n + 1);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFloorPlanId, handleHeatmapEvent, handlePoiOverlayEvent, loadCurrentDwellFromBackend, openHeatmapWebSocket]);

  useEffect(() => {
    return () => {
      heatmapWsIntentionalCloseRef.current = true;
      if (heatmapReconnectTimerRef.current != null) {
        window.clearTimeout(heatmapReconnectTimerRef.current);
        heatmapReconnectTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (heatmapReconnectTimerRef.current != null) {
        window.clearTimeout(heatmapReconnectTimerRef.current);
        heatmapReconnectTimerRef.current = null;
      }
    };
  }, [selectedFloorPlanId]);

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
      <h2 className="text-xl font-semibold text-slate-800">热力图监控</h2>
      <p className="text-xs text-slate-500">
        左侧显示当前选择的平面图热力图，右侧以宫格形式展示参与该热力图的监控画面。映射关系和底图上传将在“映射管理”模块中配置。
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
          >
            分享
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input type="checkbox" checked={recordHistory} onChange={(e) => setRecordHistory(e.target.checked)} disabled={analyzing} />
            录制历史
          </label>
          <button
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              setHeatmapCells(new Map());
              lastSampleByEntityRef.current = new Map();
              if (selectedFloorPlanId) {
                try {
                  await fetch(`${API_BASE}/api/heatmap/reset-current?floor_plan_id=${selectedFloorPlanId}`, { method: "POST" });
                } catch {}
              }
            }}
            disabled={analyzing && heatmapRecentMode}
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
                  const startRes = await fetch(
                    `${API_BASE}/api/heatmap/start?floor_plan_id=${selectedFloorPlanId}&record_history=${recordHistory ? "true" : "false"}`,
                    { method: "POST" },
                  );
                  if (startRes.ok) {
                    try {
                      const st = await startRes.json();
                      if (typeof st?.record_history === "boolean") setRecordHistory(st.record_history);
                    } catch {}
                  }
                  await new Promise((r) => setTimeout(r, 450));
                  heatmapWsIntentionalCloseRef.current = false;
                  openHeatmapWebSocket(selectedFloorPlanId);
                  setAnalyzing(true);
                  setHeatmapMjpegStreamEpoch((n) => n + 1);
                } else {
                  heatmapWsIntentionalCloseRef.current = true;
                  if (heatmapReconnectTimerRef.current != null) {
                    window.clearTimeout(heatmapReconnectTimerRef.current);
                    heatmapReconnectTimerRef.current = null;
                  }
                  await fetch(`${API_BASE}/api/heatmap/stop?floor_plan_id=${selectedFloorPlanId}`, { method: "POST" });
                  wsRef.current?.close();
                  wsRef.current = null;
                  setAnalyzing(false);
                  setHeatmapMjpegStreamEpoch((n) => n + 1);
                  setVvFootfalls({});
                  lastSampleByEntityRef.current = new Map();
                  poiLastSeenByEntityRef.current = new Map();
                  setPoiCells(new Map());
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
      <div className="grid h-[calc(100vh-220px)] min-h-0 gap-4 md:grid-cols-[2fr,3fr]">
        <div className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">热力图预览</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-slate-600"><input type="checkbox" checked={showHeatmapGrid} onChange={(e) => setShowHeatmapGrid(e.target.checked)} />显示网格</label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600"><input type="checkbox" checked={showHeatmapLegend} onChange={(e) => setShowHeatmapLegend(e.target.checked)} />显示色标</label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600"><input type="checkbox" checked={heatmapRecentMode} onChange={(e) => setHeatmapRecentMode(e.target.checked)} />最近热度</label>
              <label className="flex items-center gap-1 text-[11px] text-slate-600"><input type="checkbox" checked={showPeopleOverlay} onChange={(e) => setShowPeopleOverlay(e.target.checked)} disabled={heatmapDataMode !== "live"} />人员位置</label>
              <select className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" value={heatmapScale} onChange={(e) => setHeatmapScale(e.target.value as any)}><option value="log">对数</option><option value="linear">线性</option></select>
              <select className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" value={heatmapAlphaMode} onChange={(e) => setHeatmapAlphaMode(e.target.value as any)}><option value="byValue">随强度</option><option value="fixed">固定</option></select>
              <span className="text-[11px] text-slate-500">选择平面图：</span>
              <select className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" value={selectedFloorPlanId ?? ""} onChange={(e) => setSelectedFloorPlanId(e.target.value ? Number(e.target.value) : null)}>
                {floorPlans.length === 0 && <option value="">无平面图</option>}
                {floorPlans.map((fp) => <option key={fp.id} value={fp.id}>{fp.name}</option>)}
              </select>
            </div>
          </div>
          {showHeatmapLegend ? (
            <div className="mb-2 flex items-center gap-3">
              <div className="h-2 flex-1 rounded" style={{ background: heatmapLegendGradient }} />
              <div className="flex items-center gap-2 text-[11px] text-slate-600"><span>0</span><span className="text-slate-400">→</span><span>{formatDuration(legendMax / 2)}</span><span className="text-slate-400">→</span><span>{formatDuration(legendMax)}</span></div>
              {heatmapRecentMode ? (
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span className="text-slate-400">半衰期</span>
                  <input type="range" min={10} max={300} value={heatmapHalfLifeSec} onChange={(e) => setHeatmapHalfLifeSec(Number(e.target.value) || 60)} />
                  <span className="w-10 text-right">{heatmapHalfLifeSec}s</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">数据源：</span>
            <button className={`rounded px-2 py-1 text-[11px] font-medium ${heatmapDataMode === "live" ? "bg-slate-900 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`} onClick={() => { setHeatmapDataMode("live"); if (selectedFloorPlanId) void loadCurrentDwellFromBackend(selectedFloorPlanId); }} disabled={!selectedFloorPlanId}>当前统计</button>
            <button className={`rounded px-2 py-1 text-[11px] font-medium ${heatmapDataMode === "history" ? "bg-slate-900 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`} onClick={() => setHeatmapDataMode("history")}>历史回放</button>
            {heatmapDataMode === "history" ? (
              <>
                <input type="datetime-local" className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]" value={historyStartLocal} onChange={(e) => setHistoryStartLocal(e.target.value)} />
                <span className="text-[11px] text-slate-400">→</span>
                <input type="datetime-local" className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]" value={historyEndLocal} onChange={(e) => setHistoryEndLocal(e.target.value)} />
                <button className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50" onClick={() => { if (selectedFloorPlanId) void loadHistoryDwellFromBackend(selectedFloorPlanId, historyStartLocal, historyEndLocal); }} disabled={!selectedFloorPlanId}>加载</button>
              </>
            ) : (
              <button className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50" onClick={() => { if (selectedFloorPlanId) void loadCurrentDwellFromBackend(selectedFloorPlanId); }} disabled={!selectedFloorPlanId}>同步</button>
            )}
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {floorPlanImageUrlStr && selectedFloorPlan ? (
              <FloorPlanCanvasComponent
                imageUrl={floorPlanImageUrlStr}
                gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
                gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
                showGrid={showHeatmapGrid}
                backgroundColor="white"
                heatmapCells={heatmapCells}
                poiCells={showPeopleOverlay ? poiCells : undefined}
                heatmapRender={{ colormap: heatmapColormap, scale: heatmapScale, clip: heatmapClip, alphaMode: heatmapAlphaMode, vMax: legendMax }}
                className="w-full h-full"
              />
            ) : (
              <span className="text-xs text-slate-400">当前无平面图配置，请在“映射管理”中上传或选择平面图。</span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>热力值：估算停留时长（秒）</span>
            <span>上限：{formatDuration(legendMax)}（{heatmapClip} · {heatmapScale}）</span>
          </div>
        </div>
        <MappedCamerasGridComponent
          sources={mappedCameras}
          analyzing={analyzing}
          vvFootfalls={vvFootfalls}
          mjpegStreamEpoch={heatmapMjpegStreamEpoch}
        />
      </div>
    </div>
  );
};

export default HeatmapView;
