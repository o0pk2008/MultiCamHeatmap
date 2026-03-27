import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { API_BASE } from "../shared/config";
import { floorPlanImageUrl, preloadFloorPlanImage } from "../shared/floorPlan";
import { worldToImagePoint } from "../shared/geometry";
import { Camera, FloorPlan, Footfall, HeatmapSource } from "../shared/types";

type FloorPlanCanvasLikeProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  className?: string;
  showGrid?: boolean;
  backgroundColor?: string;
  poiCells?: Map<string, number>;
  poiTrackIds?: Map<string, number[]>;
  showPoiTrackIds?: boolean;
};

type MappedGridLikeProps = {
  sources: HeatmapSource[];
  analyzing: boolean;
  vvFootfalls: Record<number, Footfall[]>;
  mjpegStreamEpoch?: number;
};

type FootfallAnalysisViewProps = {
  FloorPlanCanvasComponent: React.ComponentType<FloorPlanCanvasLikeProps>;
  MappedCamerasGridComponent: React.ComponentType<MappedGridLikeProps>;
};

type BindCameraOption =
  | { kind: "camera"; key: string; camera: Camera; label: string }
  | { kind: "virtual"; key: string; view: { id: number; camera_id: number; name: string; out_w: number; out_h: number; camera_name?: string }; label: string };

type Vec2 = { x: number; y: number };
type LineCfg = {
  p1: Vec2;
  p2: Vec2;
  floor_p1?: Vec2;
  floor_p2?: Vec2;
  inLabel: string;
  outLabel: string;
  enabled: boolean;
};

type FootfallStats = {
  inCount: number;
  outCount: number;
  genderMale: number;
  genderFemale: number;
  ageBuckets: { label: string; value: number }[];
  trendIn: { hour: number; value: number }[];
  trendOut: { hour: number; value: number }[];
};

type FaceCaptureItem = {
  id: number;
  track_id: number;
  ts: number;
  gender?: string | null;
  age_bucket?: string | null;
  image_base64: string;
};

const storageKey = "footfall_line_configs_v1";

const readAllLineCfg = (): Record<string, LineCfg> => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
};

const writeAllLineCfg = (v: Record<string, LineCfg>) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(v));
  } catch {}
};

const toDateInputValue = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const toUTCDateInputValue = (d: Date): string => {
  // YYYY-MM-DD in UTC
  return d.toISOString().slice(0, 10);
};

const AGE_BUCKET_LABELS = ["0-12", "18-25", "26-35", "36-45", "46-55", "55+"] as const;

const buildEmptyStats = (): FootfallStats => {
  const ageBuckets = Array.from({ length: AGE_BUCKET_LABELS.length }, (_, idx) => ({
    label: AGE_BUCKET_LABELS[idx],
    value: 0,
  }));
  return {
    inCount: 0,
    outCount: 0,
    genderMale: 0,
    genderFemale: 0,
    ageBuckets,
    trendIn: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 })),
    trendOut: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 })),
  };
};

const RollingNumber: React.FC<{ value: number; className?: string; durationMs?: number }> = ({
  value,
  className = "",
  durationMs = 260,
}) => {
  const [prev, setPrev] = useState<number>(value);
  const [animating, setAnimating] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (value === prev) return;
    setAnimating(true);
    setActive(false);
    const raf = window.requestAnimationFrame(() => setActive(true));
    const t = window.setTimeout(() => {
      setAnimating(false);
      setPrev(value);
      setActive(false);
    }, durationMs + 30);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [value, prev, durationMs]);

  if (!animating) return <div className={className}>{value}</div>;

  return (
    <div className={`relative overflow-hidden ${className}`} style={{ lineHeight: 1.15 }}>
      <div
        style={{
          transform: `translateY(${active ? "100%" : "0%"})`,
          opacity: active ? 0 : 1,
          transition: `transform ${durationMs}ms ease, opacity ${durationMs}ms ease`,
        }}
      >
        {prev}
      </div>
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translateY(${active ? "0%" : "-100%"})`,
          opacity: active ? 1 : 0,
          transition: `transform ${durationMs}ms ease, opacity ${durationMs}ms ease`,
        }}
      >
        {value}
      </div>
    </div>
  );
};

const VirtualViewMjpeg: React.FC<{
  mjpegUrl: string;
  title: string;
  frameW: number;
  frameH: number;
  epoch: number;
}> = ({ mjpegUrl, title, frameW, frameH, epoch }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    if (r0.width > 0 && r0.height > 0) setBox({ w: r0.width, h: r0.height });
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setBox({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const iw = Math.max(1, frameW);
  const ih = Math.max(1, frameH);
  const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / iw, box.h / ih) : 1;

  return (
    <div ref={wrapRef} className="relative h-full w-full min-h-0 overflow-hidden bg-black">
      <iframe
        key={`vv-mjpeg-${epoch}`}
        src={mjpegUrl}
        title={title}
        loading="eager"
        scrolling="no"
        className="pointer-events-none"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: iw,
          height: ih,
          border: "none",
          backgroundColor: "#000",
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
    </div>
  );
};

const PanZoomViewport: React.FC<{
  className?: string;
  children: React.ReactNode;
  mode?: "panzoom" | "draw";
  onClickWorld?: (p: { x: number; y: number }) => void;
  onPointerDownWorld?: (p: { x: number; y: number }) => boolean | void;
  onPointerUpWorld?: (p: { x: number; y: number }) => void;
  onMoveWorld?: (p: { x: number; y: number }) => void;
  topLeftOverlay?: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  renderOverlay?: (
    ctx: CanvasRenderingContext2D,
    info: { w: number; h: number; pan: { x: number; y: number }; zoom: number },
  ) => void;
}> = ({
  className = "",
  children,
  mode = "panzoom",
  onClickWorld,
  onPointerDownWorld,
  onPointerUpWorld,
  onMoveWorld,
  topLeftOverlay,
  onContextMenu,
  renderOverlay,
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

  useEffect(() => {
    const c = overlayCanvasRef.current;
    if (!c) return;
    c.width = Math.max(1, Math.floor(size.w));
    c.height = Math.max(1, Math.floor(size.h));
  }, [size]);

  const redraw = useCallback(() => {
    const c = overlayCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (renderOverlay) renderOverlay(ctx, { w: c.width, h: c.height, pan, zoom });
  }, [renderOverlay, pan, zoom]);

  useEffect(() => {
    redraw();
  }, [redraw, size]);

  const cssToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      return { x: (cssX - pan.x) / zoom, y: (cssY - pan.y) / zoom };
    },
    [pan, zoom],
  );

  return (
    <div
      ref={containerRef}
      className={`relative touch-none overflow-hidden ${className}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      onWheel={(e) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const cssY = e.clientY - rect.top;
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((oldZoom) => {
          const newZoom = Math.min(5, Math.max(0.3, oldZoom * zoomFactor));
          setPan((oldPan) => ({
            x: cssX - ((cssX - oldPan.x) * newZoom) / oldZoom,
            y: cssY - ((cssY - oldPan.y) * newZoom) / oldZoom,
          }));
          return newZoom;
        });
      }}
      onPointerDown={(e) => {
        const p = cssToWorld(e.clientX, e.clientY);
        const handled = onPointerDownWorld?.(p);
        if (handled) return;
        if (mode === "draw") onClickWorld?.(p);
        else {
          setDragging(true);
          setDragStart({ x: e.clientX, y: e.clientY });
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        const p = cssToWorld(e.clientX, e.clientY);
        onMoveWorld?.(p);
        if (!dragging) return;
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        setDragStart({ x: e.clientX, y: e.clientY });
        setPan((old) => ({ x: old.x + dx, y: old.y + dy }));
      }}
      onPointerUp={(e) => {
        onPointerUpWorld?.(cssToWorld(e.clientX, e.clientY));
        if (dragging) {
          setDragging(false);
          (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        }
      }}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
      >
        {children}
      </div>
      <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {topLeftOverlay ? (
        <div
          className="absolute left-2 top-2 z-10"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {topLeftOverlay}
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-white/80 px-2 py-0.5 text-[11px] text-slate-700">
        zoom {zoom.toFixed(2)}
      </div>
    </div>
  );
};

const FootfallAnalysisConfigView: React.FC<FootfallAnalysisViewProps> = ({
  FloorPlanCanvasComponent,
  MappedCamerasGridComponent: _MappedCamerasGridComponent,
}) => {
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [bindCameraOptions, setBindCameraOptions] = useState<BindCameraOption[]>([]);
  const [bindCameraId, setBindCameraId] = useState<string>("");
  const [allLineCfg, setAllLineCfg] = useState<Record<string, LineCfg>>(() => readAllLineCfg());
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);
  const [heatmapSources, setHeatmapSources] = useState<HeatmapSource[]>([]);
  const [showGrid, setShowGrid] = useState(false);
  const [lineP1, setLineP1] = useState<Vec2 | null>(null);
  const [lineP2, setLineP2] = useState<Vec2 | null>(null);
  const [savedLineP1, setSavedLineP1] = useState<Vec2 | null>(null);
  const [savedLineP2, setSavedLineP2] = useState<Vec2 | null>(null);
  const [inLabel, setInLabel] = useState("进入");
  const [outLabel, setOutLabel] = useState("离开");
  const [lineEnabled, setLineEnabled] = useState(true);
  const [lineToolEnabled, setLineToolEnabled] = useState(false);
  const [draggingCamVertex, setDraggingCamVertex] = useState<0 | 1 | null>(null);
  const [floorLineP1, setFloorLineP1] = useState<Vec2 | null>(null);
  const [floorLineP2, setFloorLineP2] = useState<Vec2 | null>(null);
  const [draggingFloorVertex, setDraggingFloorVertex] = useState<0 | 1 | null>(null);
  const [floorImgNaturalSize, setFloorImgNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [statsMode, setStatsMode] = useState<"date" | "realtime">("realtime");
  const [statsDate, setStatsDate] = useState<string>(() => toUTCDateInputValue(new Date()));
  const [statsData, setStatsData] = useState<FootfallStats>(() => buildEmptyStats());
  const [lineOverviewStats, setLineOverviewStats] = useState<Record<string, { inCount: number; outCount: number }>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [faceCaptures, setFaceCaptures] = useState<FaceCaptureItem[]>([]);
  const [newFaceCaptureIds, setNewFaceCaptureIds] = useState<number[]>([]);
  const [faceCaptureOffset, setFaceCaptureOffset] = useState(0);
  const [faceCaptureHasMore, setFaceCaptureHasMore] = useState(true);
  const [faceCaptureLoading, setFaceCaptureLoading] = useState(false);
  const [faceScrollTop, setFaceScrollTop] = useState(0);
  const [drawHint, setDrawHint] = useState("点击画面设置第一个点");

  const wsRef = useRef<WebSocket | null>(null);
  /** 用户点击停止或卸载页面时置 true，避免 WS 断线后误触发「后台已停」或自动重连 */
  const footfallWsIntentionalCloseRef = useRef(false);
  const footfallReconnectTimerRef = useRef<number | null>(null);
  const connectFootfallWsLiveRef = useRef<() => void>(() => {});
  const seenEventKeysRef = useRef<Map<string, number>>(new Map());
  const wsConnectSeqRef = useRef(0);
  const statsRefreshTimerRef = useRef<number | null>(null);
  const statsPollTimerRef = useRef<number | null>(null);
  const lineOverviewPollTimerRef = useRef<number | null>(null);
  const faceCapturePollTimerRef = useRef<number | null>(null);
  const faceCaptureContainerRef = useRef<HTMLDivElement | null>(null);
  const faceCaptureReqSeqRef = useRef(0);
  const faceCaptureLoadingRef = useRef(false);
  const faceCaptureOffsetRef = useRef(0);
  const faceCaptureAnimTimerRef = useRef<number | null>(null);
  const faceCapturePageSize = 20;
  const faceCaptureRowH = 84;
  const trackZoneByIdRef = useRef<
    Map<number, { side: -1 | 1; zoneSide: (-1 | 1) | null; lastCrossTs: number }>
  >(new Map());
  const analysisLineRef = useRef<{
    // 过线判定使用“虚拟视窗原图归一化坐标”
    vvP1: Vec2;
    vvP2: Vec2;
    virtualViewId: number;
    filterMode: "date" | "realtime";
    filterDateKey?: string;
  } | null>(null);

  const resetStats = useCallback(() => {
    if (statsRefreshTimerRef.current != null) {
      window.clearTimeout(statsRefreshTimerRef.current);
      statsRefreshTimerRef.current = null;
    }
    trackZoneByIdRef.current = new Map();
    setStatsData(buildEmptyStats());
  }, []);

  const fetchStatsFromBackend = useCallback(async () => {
    if (selectedFloorPlanId == null) return;
    const selectedOpt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    const vvIdNow = selectedOpt?.kind === "virtual" ? selectedOpt.view.id : null;
    if (vvIdNow == null) return;
    const mode = statsMode === "realtime" ? "realtime" : "date";
    const url =
      `${API_BASE}/api/footfall/stats?floor_plan_id=${selectedFloorPlanId}` +
      `&virtual_view_id=${vvIdNow}` +
      `&mode=${mode}` +
      (mode === "date" ? `&date_key=${encodeURIComponent(statsDate)}` : "");
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const data = (await r.json()) as FootfallStats;
      setStatsData(data);
    } catch (e) {
      console.error(e);
    }
  }, [bindCameraId, bindCameraOptions, selectedFloorPlanId, statsDate, statsMode]);

  const scheduleRefreshStats = useCallback(() => {
    if (statsRefreshTimerRef.current != null) return;
    statsRefreshTimerRef.current = window.setTimeout(() => {
      statsRefreshTimerRef.current = null;
      void fetchStatsFromBackend();
    }, 120);
  }, [fetchStatsFromBackend]);

  const fetchLineOverviewStats = useCallback(async () => {
    if (selectedFloorPlanId == null) {
      setLineOverviewStats({});
      return;
    }
    const vvKeys = Object.keys(allLineCfg).filter((k) => /^vv:\d+$/.test(k));
    if (vvKeys.length <= 0) {
      setLineOverviewStats({});
      return;
    }
    const mode = statsMode === "realtime" ? "realtime" : "date";
    const pairs = await Promise.all(
      vvKeys.map(async (key) => {
        const m = key.match(/^vv:(\d+)$/);
        const vvId = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(vvId)) return [key, { inCount: 0, outCount: 0 }] as const;
        const url =
          `${API_BASE}/api/footfall/stats?floor_plan_id=${selectedFloorPlanId}` +
          `&virtual_view_id=${vvId}` +
          `&mode=${mode}` +
          (mode === "date" ? `&date_key=${encodeURIComponent(statsDate)}` : "");
        try {
          const r = await fetch(url);
          if (!r.ok) return [key, { inCount: 0, outCount: 0 }] as const;
          const data = (await r.json()) as FootfallStats;
          return [key, { inCount: Number(data?.inCount || 0), outCount: Number(data?.outCount || 0) }] as const;
        } catch {
          return [key, { inCount: 0, outCount: 0 }] as const;
        }
      }),
    );
    const next: Record<string, { inCount: number; outCount: number }> = {};
    for (const [k, v] of pairs) next[k] = v;
    setLineOverviewStats(next);
  }, [allLineCfg, selectedFloorPlanId, statsDate, statsMode]);

  const fetchFaceCaptures = useCallback(async (reset: boolean = true) => {
    const selectedOpt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
    const vvIdNow = selectedOpt?.kind === "virtual" ? selectedOpt.view.id : null;
    if (vvIdNow == null) {
      setFaceCaptures([]);
      setNewFaceCaptureIds([]);
      setFaceCaptureOffset(0);
      setFaceCaptureHasMore(true);
      return;
    }
    if (faceCaptureLoadingRef.current && !reset) return;
    const thisReqSeq = ++faceCaptureReqSeqRef.current;
    try {
      faceCaptureLoadingRef.current = true;
      setFaceCaptureLoading(true);
      const mode = statsMode === "realtime" ? "realtime" : "date";
      const tzOffsetMin = new Date().getTimezoneOffset();
      const reqOffset = reset ? 0 : faceCaptureOffsetRef.current;
      const r = await fetch(
        `${API_BASE}/api/footfall/face-captures?virtual_view_id=${vvIdNow}` +
          `&floor_plan_id=${selectedFloorPlanId ?? ""}` +
          `&mode=${mode}` +
          (mode === "date" ? `&date_key=${encodeURIComponent(statsDate)}` : "") +
          `&tz_offset_minutes=${encodeURIComponent(String(tzOffsetMin))}` +
          `&offset=${encodeURIComponent(String(reqOffset))}` +
          `&limit=${encodeURIComponent(String(faceCapturePageSize))}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as FaceCaptureItem[];
      if (thisReqSeq !== faceCaptureReqSeqRef.current) return;
      const list = Array.isArray(data) ? data : [];
      if (reset) {
        setFaceCaptures((prev) => {
          const prevIds = new Set(prev.map((x) => x.id));
          const added = list.filter((x) => !prevIds.has(x.id)).map((x) => x.id);
          if (added.length > 0) {
            setNewFaceCaptureIds((old) => Array.from(new Set([...old, ...added])));
            if (faceCaptureAnimTimerRef.current != null) {
              window.clearTimeout(faceCaptureAnimTimerRef.current);
              faceCaptureAnimTimerRef.current = null;
            }
            faceCaptureAnimTimerRef.current = window.setTimeout(() => {
              setNewFaceCaptureIds((old) => old.filter((id) => !added.includes(id)));
              faceCaptureAnimTimerRef.current = null;
            }, 420);
          }
          return list;
        });
        setFaceCaptureOffset(list.length);
        faceCaptureOffsetRef.current = list.length;
      } else {
        setFaceCaptures((old) => [...old, ...list]);
        const nextOffset = reqOffset + list.length;
        setFaceCaptureOffset(nextOffset);
        faceCaptureOffsetRef.current = nextOffset;
      }
      setFaceCaptureHasMore(list.length >= faceCapturePageSize);
    } catch {
      // ignore transient network errors
    } finally {
      faceCaptureLoadingRef.current = false;
      if (thisReqSeq === faceCaptureReqSeqRef.current) {
        setFaceCaptureLoading(false);
      }
    }
  }, [bindCameraId, bindCameraOptions, selectedFloorPlanId, statsDate, statsMode]);

  const loadMoreFaceCaptures = useCallback(() => {
    if (!faceCaptureHasMore || faceCaptureLoading) return;
    void fetchFaceCaptures(false);
  }, [faceCaptureHasMore, faceCaptureLoading, fetchFaceCaptures]);

  // UV near-line hysteresis band
  const LINE_NEAR_ZONE_W = 0.05;

  const [lineFlash, setLineFlash] = useState<null | { kind: "in" | "out"; untilMs: number }>(null);

  const flashLine = useCallback((kind: "in" | "out") => {
    const until = Date.now() + 450;
    setLineFlash({ kind, untilMs: until });
    window.setTimeout(() => {
      setLineFlash((cur) => {
        if (!cur) return null;
        if (Date.now() >= cur.untilMs) return null;
        return cur;
      });
    }, 520);
  }, []);

  const handleHeatmapWsEvent = useCallback(
    (raw: any) => {
      if (selectedFloorPlanId == null) return;
      const selectedOpt = bindCameraOptions.find((o) => o.key === bindCameraId) || null;
      const currentVirtualViewId = selectedOpt?.kind === "virtual" ? selectedOpt.view.id : null;
      if (currentVirtualViewId == null) return;

      const evt = raw ?? {};
      if (evt.floor_plan_id !== selectedFloorPlanId) return;
      const vvId = evt.virtual_view_id ?? null;
      // 闪烁应跟随“当前正在查看”的摄像头，而不是“启动分析当时选中的摄像头”
      if (vvId == null || Number(vvId) !== Number(currentVirtualViewId)) return;

      if (statsMode === "date" && statsDate) {
        const tsSec = Number.isFinite(Number(evt.ts)) ? Number(evt.ts) : NaN;
        if (!Number.isFinite(tsSec)) return;
        const dateKey = toUTCDateInputValue(new Date(tsSec * 1000));
        if (dateKey !== statsDate) return;
      }

      const dirRaw = evt.direction;
      if (dirRaw !== "in" && dirRaw !== "out") return;

      const sid = evt.stable_id != null ? String(evt.stable_id) : "";
      const tid = evt.track_id != null ? String(evt.track_id) : "";
      const ts = Number.isFinite(Number(evt.ts)) ? Number(evt.ts).toFixed(3) : "";
      const dedupKey = `${evt.line_config_id ?? "na"}|${dirRaw}|${sid || tid || "na"}|${ts}`;
      const seenMap = seenEventKeysRef.current;
      const nowMs = Date.now();
      for (const [k, t] of Array.from(seenMap.entries())) {
        if (nowMs - t > 4000) seenMap.delete(k);
      }
      if (seenMap.has(dedupKey)) return;
      seenMap.set(dedupKey, nowMs);

      // 后端是统计权威源：前端仅触发刷新并做视觉闪烁
      scheduleRefreshStats();
      void fetchLineOverviewStats();
      flashLine(dirRaw);
    },
    [
      bindCameraId,
      bindCameraOptions,
      fetchLineOverviewStats,
      flashLine,
      scheduleRefreshStats,
      selectedFloorPlanId,
      statsDate,
      statsMode,
    ],
  );
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });
  const [vvSnapshotRefreshMs, setVvSnapshotRefreshMs] = useState<number>(3000);
  const [mjpegStreamEpoch, setMjpegStreamEpoch] = useState(0);
  const [vvSnapshotObjUrl, setVvSnapshotObjUrl] = useState<string>("");
  const vvSnapshotTimerRef = useRef<number | null>(null);
  const vvSnapshotInFlightRef = useRef<boolean>(false);
  const vvSnapshotViewIdRef = useRef<number | null>(null);
  const vvViewportRef = useRef<{ w: number; h: number; aspectW: number; aspectH: number }>({
    w: 0,
    h: 0,
    aspectW: 16,
    aspectH: 9,
  });
  const floorViewportRef = useRef<{ w: number; h: number; aspectW: number; aspectH: number }>({
    w: 0,
    h: 0,
    aspectW: 1,
    aspectH: 1,
  });

  useEffect(() => {
    const load = async () => {
      const [camRes, fpRes, vvRes] = await Promise.all([
        fetch(`${API_BASE}/api/cameras/`),
        fetch(`${API_BASE}/api/floor-plans`),
        fetch(`${API_BASE}/api/cameras/virtual-views/all`),
      ]);
      const camData: Camera[] = await camRes.json();
      const fpData: FloorPlan[] = await fpRes.json();
      const vvData: { id: number; camera_id: number; name: string; out_w: number; out_h: number; camera_name?: string }[] = vvRes.ok
        ? await vvRes.json()
        : [];
      setCameras(camData);
      setFloorPlans(fpData);
      const options: BindCameraOption[] = [
        ...camData.map((c) => ({
          kind: "camera" as const,
          key: `cam:${c.id}`,
          camera: c,
          label: `${c.name} #${c.id}`,
        })),
        ...vvData.map((v) => ({
          kind: "virtual" as const,
          key: `vv:${v.id}`,
          view: v,
          label: `${v.camera_name || `Camera#${v.camera_id}`} / ${v.name} (virtual)`,
        })),
      ];
      setBindCameraOptions(options);
      if (options.length > 0 && !bindCameraId) setBindCameraId(options[0].key);
      fpData.forEach((fp) => {
        void preloadFloorPlanImage(floorPlanImageUrl(fp));
      });
      if (fpData.length > 0 && selectedFloorPlanId == null) {
        setSelectedFloorPlanId(fpData[0].id);
      }
    };
    void load();
  }, [selectedFloorPlanId, bindCameraId]);

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

  // 从后端加载已保存的判定线配置（用于跨电脑共享）
  useEffect(() => {
    if (selectedFloorPlanId == null) return;
    fetch(`${API_BASE}/api/footfall/lines?floor_plan_id=${selectedFloorPlanId}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((rows: any[]) => {
        const next: Record<string, LineCfg> = {};
        for (const it of rows || []) {
          const vvId = Number(it.virtual_view_id);
          if (!Number.isFinite(vvId)) continue;
          const key = `vv:${vvId}`;
          next[key] = {
            p1: { x: Number(it.p1?.x ?? 0), y: Number(it.p1?.y ?? 0) },
            p2: { x: Number(it.p2?.x ?? 0), y: Number(it.p2?.y ?? 0) },
            floor_p1: it.floor_p1 ? { x: Number(it.floor_p1.x), y: Number(it.floor_p1.y) } : undefined,
            floor_p2: it.floor_p2 ? { x: Number(it.floor_p2.x), y: Number(it.floor_p2.y) } : undefined,
            inLabel: String(it.in_label ?? "进入"),
            outLabel: String(it.out_label ?? "离开"),
            enabled: it.enabled !== false,
          };
        }
        setAllLineCfg(next);
        writeAllLineCfg(next);
      })
      .catch((e) => console.error(e));
  }, [selectedFloorPlanId]);

  const selectedFloorPlan = useMemo(
    () => floorPlans.find((fp) => fp.id === selectedFloorPlanId) || null,
    [floorPlans, selectedFloorPlanId],
  );
  const floorPlanImageUrlStr = selectedFloorPlan ? floorPlanImageUrl(selectedFloorPlan) : null;

  // 用图片实际像素尺寸来计算网格映射，避免 width_px/height_px 元数据与真实图片不一致
  useEffect(() => {
    if (!floorPlanImageUrlStr) {
      setFloorImgNaturalSize(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setFloorImgNaturalSize({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    };
    img.onerror = () => {
      if (cancelled) return;
      setFloorImgNaturalSize(null);
    };
    img.src = floorPlanImageUrlStr;
    return () => {
      cancelled = true;
    };
  }, [floorPlanImageUrlStr]);

  const mappedCameras = useMemo(() => {
    const camMap = new Map<number, Camera>();
    cameras.forEach((c) => camMap.set(c.id, c));
    return heatmapSources.filter((s) => {
      const c = camMap.get(s.camera_id);
      return !!c && c.enabled;
    });
  }, [cameras, heatmapSources]);

  const selectedCameraOpt = useMemo(
    () => bindCameraOptions.find((o) => o.key === bindCameraId) || null,
    [bindCameraOptions, bindCameraId],
  );

  const requiredVirtualViewId = selectedCameraOpt?.kind === "virtual" ? selectedCameraOpt.view.id : null;
  const activeVirtualLines = useMemo(() => {
    return Object.entries(allLineCfg)
      .map(([key, cfg]) => {
        const m = key.match(/^vv:(\d+)$/);
        if (!m || !cfg?.p1 || !cfg?.p2) return null;
        return {
          key,
          virtual_view_id: Number(m[1]),
          p1: cfg.p1,
          p2: cfg.p2,
          floor_p1: cfg.floor_p1 ?? cfg.p1,
          floor_p2: cfg.floor_p2 ?? cfg.p2,
          in_label: cfg.inLabel || "进入",
          out_label: cfg.outLabel || "离开",
          enabled: cfg.enabled !== false,
        };
      })
      .filter((x) => !!x) as Array<{
      key: string;
      virtual_view_id: number;
      p1: Vec2;
      p2: Vec2;
      floor_p1: Vec2;
      floor_p2: Vec2;
      in_label: string;
      out_label: string;
      enabled: boolean;
    }>;
  }, [allLineCfg]);
  const canStartFootfall =
    selectedFloorPlanId != null &&
    selectedFloorPlan != null &&
    activeVirtualLines.length > 0;

  const connectFootfallWs = useCallback(() => {
    if (footfallReconnectTimerRef.current != null) {
      window.clearTimeout(footfallReconnectTimerRef.current);
      footfallReconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      footfallWsIntentionalCloseRef.current = true;
    }
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    wsConnectSeqRef.current += 1;

    if (requiredVirtualViewId == null || selectedFloorPlanId == null) return;

    const fpId = selectedFloorPlanId;
    const vvId = requiredVirtualViewId;
    const thisSeq = ++wsConnectSeqRef.current;

    const ws = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host.replace(
        /:\d+$/,
        ":18080",
      )}/ws/footfall-events`,
    );
    ws.onmessage = (ev) => {
      if (thisSeq !== wsConnectSeqRef.current || wsRef.current !== ws) return;
      try {
        const data = JSON.parse(ev.data);
        handleHeatmapWsEvent(data);
      } catch (e) {
        console.error(e);
      }
    };
    ws.onclose = () => {
      if (thisSeq !== wsConnectSeqRef.current) return;
      if (wsRef.current === ws) wsRef.current = null;
      wsRef.current = null;
      if (footfallWsIntentionalCloseRef.current) {
        footfallWsIntentionalCloseRef.current = false;
        return;
      }
      footfallReconnectTimerRef.current = window.setTimeout(() => {
        footfallReconnectTimerRef.current = null;
        void (async () => {
          try {
            const r = await fetch(
              `${API_BASE}/api/footfall/status?floor_plan_id=${fpId}&virtual_view_id=${vvId}`,
            );
            const data = r.ok ? await r.json() : null;
            if (data?.running) {
              setAnalyzing(true);
              connectFootfallWsLiveRef.current();
            } else {
              setAnalyzing(false);
              analysisLineRef.current = null;
            }
          } catch {
            setAnalyzing(false);
            analysisLineRef.current = null;
          }
        })();
      }, 450);
    };
    ws.onerror = () => {
      if (thisSeq !== wsConnectSeqRef.current) return;
      try {
        ws.close();
      } catch {}
    };
    wsRef.current = ws;
  }, [handleHeatmapWsEvent, requiredVirtualViewId, selectedFloorPlanId]);

  useEffect(() => {
    connectFootfallWsLiveRef.current = connectFootfallWs;
  }, [connectFootfallWs]);

  // 非分析状态下：从后端加载持久化统计（跨电脑共享）
  useEffect(() => {
    if (analyzing) return;
    if (selectedFloorPlanId == null || requiredVirtualViewId == null) {
      setStatsData(buildEmptyStats());
      return;
    }
    void fetchStatsFromBackend();
  }, [analyzing, fetchStatsFromBackend, requiredVirtualViewId, selectedFloorPlanId]);

  // 分析状态同步：若后端已在运行，则本页进入 analyzing，禁止重复 start
  useEffect(() => {
    if (selectedFloorPlanId == null || requiredVirtualViewId == null) return;
    if (!canStartFootfall) return;
    if (analyzing) return;

    const vvP1 = savedLineP1 ?? lineP1;
    const vvP2 = savedLineP2 ?? lineP2;
    if (!vvP1 || !vvP2) return;

    fetch(
      `${API_BASE}/api/footfall/status?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${requiredVirtualViewId}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.resolve(null)))
      .then((data) => {
        if (!data || !data.running) return;
        analysisLineRef.current = {
          vvP1,
          vvP2,
          virtualViewId: requiredVirtualViewId,
          filterMode: statsMode,
          filterDateKey: statsMode === "date" ? statsDate : undefined,
        };
        setMjpegStreamEpoch((n) => n + 1);
        setAnalyzing(true);
        connectFootfallWs();
      })
      .catch((e) => console.error(e));
  }, [
    analyzing,
    canStartFootfall,
    connectFootfallWs,
    requiredVirtualViewId,
    savedLineP1,
    savedLineP2,
    lineP1,
    lineP2,
    selectedFloorPlanId,
    statsMode,
    statsDate,
  ]);

  const startFootfallAnalysis = useCallback(async () => {
    if (!canStartFootfall || !requiredVirtualViewId || !selectedFloorPlanId || activeVirtualLines.length === 0) return;

    // 统计使用的判定线固定在启动瞬间，避免用户在分析过程中移动点导致口径变化
    const vvP1 = savedLineP1 ?? lineP1;
    const vvP2 = savedLineP2 ?? lineP2;
    if (!vvP1 || !vvP2) return;
    analysisLineRef.current = {
      vvP1,
      vvP2,
      virtualViewId: requiredVirtualViewId,
      filterMode: statsMode,
      filterDateKey: statsMode === "date" ? statsDate : undefined,
    };
    trackZoneByIdRef.current = new Map();
    setMjpegStreamEpoch((n) => n + 1);

    try {
      const settled = await Promise.allSettled(
        activeVirtualLines.map((ln) =>
          fetch(`${API_BASE}/api/footfall/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              floor_plan_id: selectedFloorPlanId,
              virtual_view_id: ln.virtual_view_id,
              p1: ln.p1,
              p2: ln.p2,
              floor_p1: ln.floor_p1,
              floor_p2: ln.floor_p2,
              in_label: ln.in_label,
              out_label: ln.out_label,
              enabled: ln.enabled,
              zone_w: LINE_NEAR_ZONE_W,
              emit_interval_sec: 0.03,
            }),
          }),
        ),
      );
      const okCount = settled.filter(
        (x) => x.status === "fulfilled" && x.value && (x.value as Response).ok,
      ).length;
      if (okCount <= 0) throw new Error("footfall start failed");
    } catch (e) {
      console.error(e);
      alert("开始检测分析失败");
      analysisLineRef.current = null;
      return;
    }

    footfallWsIntentionalCloseRef.current = false;
    connectFootfallWs();
    setAnalyzing(true);
  }, [
    canStartFootfall,
    requiredVirtualViewId,
    selectedFloorPlanId,
    statsMode,
    statsDate,
    connectFootfallWs,
    activeVirtualLines,
  ]);

  const stopFootfallAnalysis = useCallback(async () => {
    if (!selectedFloorPlanId) return;
    footfallWsIntentionalCloseRef.current = true;
    if (footfallReconnectTimerRef.current != null) {
      window.clearTimeout(footfallReconnectTimerRef.current);
      footfallReconnectTimerRef.current = null;
    }
    try {
      await Promise.allSettled(
        activeVirtualLines.map((ln) =>
          fetch(
            `${API_BASE}/api/footfall/stop?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${ln.virtual_view_id}`,
            { method: "POST" },
          ),
        ),
      );
    } catch (e) {
      console.error(e);
    }
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    if (statsRefreshTimerRef.current != null) {
      window.clearTimeout(statsRefreshTimerRef.current);
      statsRefreshTimerRef.current = null;
    }
    if (statsPollTimerRef.current != null) {
      window.clearInterval(statsPollTimerRef.current);
      statsPollTimerRef.current = null;
    }
    if (faceCapturePollTimerRef.current != null) {
      window.clearInterval(faceCapturePollTimerRef.current);
      faceCapturePollTimerRef.current = null;
    }
    setMjpegStreamEpoch((n) => n + 1);
    setAnalyzing(false);
    analysisLineRef.current = null;
    trackZoneByIdRef.current = new Map();
  }, [activeVirtualLines, selectedFloorPlanId]);

  useEffect(() => {
    return () => {
      footfallWsIntentionalCloseRef.current = true;
      if (footfallReconnectTimerRef.current != null) {
        window.clearTimeout(footfallReconnectTimerRef.current);
        footfallReconnectTimerRef.current = null;
      }
      if (statsRefreshTimerRef.current != null) {
        window.clearTimeout(statsRefreshTimerRef.current);
        statsRefreshTimerRef.current = null;
      }
      if (statsPollTimerRef.current != null) {
        window.clearInterval(statsPollTimerRef.current);
        statsPollTimerRef.current = null;
      }
      if (lineOverviewPollTimerRef.current != null) {
        window.clearInterval(lineOverviewPollTimerRef.current);
        lineOverviewPollTimerRef.current = null;
      }
      if (faceCapturePollTimerRef.current != null) {
        window.clearInterval(faceCapturePollTimerRef.current);
        faceCapturePollTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      wsConnectSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (footfallReconnectTimerRef.current != null) {
        window.clearTimeout(footfallReconnectTimerRef.current);
        footfallReconnectTimerRef.current = null;
      }
      if (statsRefreshTimerRef.current != null) {
        window.clearTimeout(statsRefreshTimerRef.current);
        statsRefreshTimerRef.current = null;
      }
      if (statsPollTimerRef.current != null) {
        window.clearInterval(statsPollTimerRef.current);
        statsPollTimerRef.current = null;
      }
      if (lineOverviewPollTimerRef.current != null) {
        window.clearInterval(lineOverviewPollTimerRef.current);
        lineOverviewPollTimerRef.current = null;
      }
      if (faceCapturePollTimerRef.current != null) {
        window.clearInterval(faceCapturePollTimerRef.current);
        faceCapturePollTimerRef.current = null;
      }
    };
  }, [selectedFloorPlanId, requiredVirtualViewId]);

  useEffect(() => {
    if (!analyzing) {
      if (statsPollTimerRef.current != null) {
        window.clearInterval(statsPollTimerRef.current);
        statsPollTimerRef.current = null;
      }
      return;
    }
    void fetchStatsFromBackend();
    if (statsPollTimerRef.current != null) {
      window.clearInterval(statsPollTimerRef.current);
      statsPollTimerRef.current = null;
    }
    statsPollTimerRef.current = window.setInterval(() => {
      void fetchStatsFromBackend();
    }, 1200);
    return () => {
      if (statsPollTimerRef.current != null) {
        window.clearInterval(statsPollTimerRef.current);
        statsPollTimerRef.current = null;
      }
    };
  }, [analyzing, fetchStatsFromBackend]);

  useEffect(() => {
    void fetchLineOverviewStats();
    if (lineOverviewPollTimerRef.current != null) {
      window.clearInterval(lineOverviewPollTimerRef.current);
      lineOverviewPollTimerRef.current = null;
    }
    if (!analyzing) return;
    lineOverviewPollTimerRef.current = window.setInterval(() => {
      void fetchLineOverviewStats();
    }, 2000);
    return () => {
      if (lineOverviewPollTimerRef.current != null) {
        window.clearInterval(lineOverviewPollTimerRef.current);
        lineOverviewPollTimerRef.current = null;
      }
    };
  }, [analyzing, fetchLineOverviewStats]);

  useEffect(() => {
    return () => {
      if (faceCaptureAnimTimerRef.current != null) {
        window.clearTimeout(faceCaptureAnimTimerRef.current);
        faceCaptureAnimTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // 无论 analyzing 与否，都先加载一页，避免刷新页面后抓拍列表空白
    void fetchFaceCaptures(true);
    if (faceCapturePollTimerRef.current != null) {
      window.clearInterval(faceCapturePollTimerRef.current);
      faceCapturePollTimerRef.current = null;
    }
    if (!analyzing || requiredVirtualViewId == null) {
      return;
    }
    faceCapturePollTimerRef.current = window.setInterval(() => {
      // 实时模式下仅在列表顶部自动刷新，避免历史滚动中跳动
      const el = faceCaptureContainerRef.current;
      const nearTop = !el || el.scrollTop < 24;
      if (statsMode === "realtime" && nearTop) {
        void fetchFaceCaptures(true);
      }
    }, 1200);
    return () => {
      if (faceCapturePollTimerRef.current != null) {
        window.clearInterval(faceCapturePollTimerRef.current);
        faceCapturePollTimerRef.current = null;
      }
    };
  }, [analyzing, fetchFaceCaptures, requiredVirtualViewId, statsMode, selectedFloorPlanId, bindCameraId, statsDate]);

  const faceVisibleRange = useMemo(() => {
    const el = faceCaptureContainerRef.current;
    const viewportH = Math.max(1, el?.clientHeight || 400);
    const start = Math.max(0, Math.floor(faceScrollTop / faceCaptureRowH) - 3);
    const count = Math.ceil(viewportH / faceCaptureRowH) + 6;
    const end = Math.min(faceCaptures.length, start + count);
    return { start, end };
  }, [faceCaptures.length, faceScrollTop]);

  useEffect(() => {
    if (!analyzing) return;
    if (!analysisLineRef.current) return;
    // 仅更新过滤口径，统计直接读取后端权威结果
    analysisLineRef.current.filterMode = statsMode;
    analysisLineRef.current.filterDateKey = statsMode === "date" ? statsDate : undefined;
    void fetchStatsFromBackend();
  }, [statsMode, statsDate, analyzing, fetchStatsFromBackend]);

  const displayP1 = savedLineP1 ?? lineP1;
  const displayP2 = savedLineP2 ?? lineP2;
  const firstSavedLineCameraKey = useMemo(() => {
    const rows = Object.entries(allLineCfg)
      .map(([key, cfg]) => {
        const opt = bindCameraOptions.find((o) => o.key === key);
        if (!opt || !cfg?.p1 || !cfg?.p2) return null;
        return { key, label: opt.label };
      })
      .filter(Boolean) as { key: string; label: string }[];
    rows.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    return rows[0]?.key || "";
  }, [allLineCfg, bindCameraOptions]);

  const userSelectedCameraRef = useRef(false);

  useEffect(() => {
    if (!firstSavedLineCameraKey) return;
    // 仅在尚未手动选择时进行兜底；避免用户点击后被立刻切回默认摄像头
    if (!userSelectedCameraRef.current && (!bindCameraId || !allLineCfg[bindCameraId])) {
      setBindCameraId(firstSavedLineCameraKey);
    }
  }, [firstSavedLineCameraKey, bindCameraId, allLineCfg]);
  // trendIn/trendOut 由后端实时事件实时累加得到
  const trendIn = statsData.trendIn;
  const trendOut = statsData.trendOut;
  const statsTitleDate = statsMode === "realtime" ? `${toDateInputValue(new Date())} 实时` : statsDate;
  const genderOption = useMemo(
    () => ({
      tooltip: { trigger: "item" },
      legend: { bottom: -8, left: "center", textStyle: { fontSize: 11 } },
      series: [
        {
          type: "pie",
          radius: ["38%", "62%"],
          avoidLabelOverlap: false,
          itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
          label: { show: false },
          labelLine: { show: false },
          data: [
            { value: statsData.genderMale, name: "男", itemStyle: { color: "#3B82F6" } },
            { value: statsData.genderFemale, name: "女", itemStyle: { color: "#EC4899" } },
          ],
        },
      ],
    }),
    [statsData.genderMale, statsData.genderFemale],
  );
  const ageOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      grid: { left: 30, right: 10, top: 20, bottom: 28 },
      xAxis: {
        type: "category",
        data: statsData.ageBuckets.map((x) => x.label),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [
        {
          type: "bar",
          data: statsData.ageBuckets.map((x) => x.value),
          itemStyle: { color: "#6366F1", borderRadius: [4, 4, 0, 0] },
          barWidth: "55%",
        },
      ],
    }),
    [statsData.ageBuckets],
  );
  const trendOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      grid: { left: 32, right: 10, top: 20, bottom: 26 },
      legend: { top: 0, right: 10, textStyle: { fontSize: 11 } },
      xAxis: {
        type: "category",
        data: trendIn.map((x) => `${x.hour}:00`),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [
        {
          type: "line",
          smooth: true,
          name: "进入",
          data: trendIn.map((x) => x.value),
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { color: "#10B981", width: 2.5 },
          itemStyle: { color: "#10B981" },
        },
        {
          type: "line",
          smooth: true,
          name: "离开",
          data: trendOut.map((x) => x.value),
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { color: "#F97316", width: 2.5 },
          itemStyle: { color: "#F97316" },
        },
      ],
    }),
    [trendIn, trendOut],
  );

  useEffect(() => {
    if (!bindCameraId) return;
    const cfg = allLineCfg[bindCameraId];
    if (cfg) {
      setLineP1(cfg.p1);
      setLineP2(cfg.p2);
      setSavedLineP1(cfg.p1);
      setSavedLineP2(cfg.p2);
      setInLabel(cfg.inLabel || "进入");
      setOutLabel(cfg.outLabel || "离开");
      setLineEnabled(cfg.enabled !== false);
      setFloorLineP1(cfg.floor_p1 ?? cfg.p1);
      setFloorLineP2(cfg.floor_p2 ?? cfg.p2);
      setDrawHint("已加载该摄像头的判定线");
      return;
    }
    setLineP1(null);
    setLineP2(null);
    setSavedLineP1(null);
    setSavedLineP2(null);
    setInLabel("进入");
    setOutLabel("离开");
    setLineEnabled(true);
    setFloorLineP1(null);
    setFloorLineP2(null);
    setDrawHint("点击画面设置第一个点");
  }, [bindCameraId, allLineCfg]);

  const refreshVirtualSnapshot = useCallback(async (view: { id: number; camera_id: number }) => {
    if (vvSnapshotInFlightRef.current) return;
    vvSnapshotInFlightRef.current = true;
    const snapshotUrl = `${API_BASE}/api/cameras/${view.camera_id}/virtual-views/${view.id}/snapshot.jpg?t=${Date.now()}`;
    try {
      const res = await fetch(snapshotUrl, { cache: "no-store" });
      if (!res.ok || res.status === 204) return;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = objUrl;
      });
      setVvSnapshotObjUrl((prev) => {
        if (prev && prev !== objUrl) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return objUrl;
      });
    } finally {
      vvSnapshotInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    const viewId = selectedCameraOpt?.kind === "virtual" ? selectedCameraOpt.view.id : null;
    if (vvSnapshotViewIdRef.current !== viewId) {
      vvSnapshotViewIdRef.current = viewId;
      setVvSnapshotObjUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return "";
      });
    }
  }, [selectedCameraOpt]);

  useEffect(() => {
    if (vvSnapshotTimerRef.current) {
      window.clearInterval(vvSnapshotTimerRef.current);
      vvSnapshotTimerRef.current = null;
    }
    // real-time 预览使用 mjpeg iframe（preview_shared/analyzed），不再轮询 snapshot.jpg
    return;
  }, [analyzing, selectedCameraOpt, vvSnapshotRefreshMs, refreshVirtualSnapshot]);

  useEffect(() => {
    return () => {
      if (vvSnapshotTimerRef.current) {
        window.clearInterval(vvSnapshotTimerRef.current);
        vvSnapshotTimerRef.current = null;
      }
      setVvSnapshotObjUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {}
        }
        return "";
      });
    };
  }, []);

  const onVirtualPreviewClick = (world: Vec2) => {
    if (contextMenu.visible) setContextMenu((m) => ({ ...m, visible: false }));
    if (analyzing) return;
    if (!lineToolEnabled) return;
    if (!selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
    const imgPt = worldToImagePoint(world, vvViewportRef.current, { allowOutside: false });
    if (!imgPt) return;
    const p = {
      x: imgPt.x / Math.max(1, selectedCameraOpt.view.out_w || 1),
      y: imgPt.y / Math.max(1, selectedCameraOpt.view.out_h || 1),
    };
    if (!lineP1) {
      setLineP1(p);
      setDrawHint("点击画面设置第二个点");
      return;
    }
    if (lineP1 && lineP2) return;
    setLineP2(p);
    if (!floorLineP1) setFloorLineP1(p);
    if (!floorLineP2) setFloorLineP2(p);
    setDrawHint("线段已生成，点击保存生效；继续点击可重新绘制");
  };

  const findCamVertexHit = useCallback((world: Vec2): 0 | 1 | null => {
    if (analyzing) return null;
    if (!selectedCameraOpt || selectedCameraOpt.kind !== "virtual" || !lineP1 || !lineP2) return null;
    const imgPt = worldToImagePoint(world, vvViewportRef.current, { allowOutside: false });
    if (!imgPt) return null;
    const p = {
      x: imgPt.x / Math.max(1, selectedCameraOpt.view.out_w || 1),
      y: imgPt.y / Math.max(1, selectedCameraOpt.view.out_h || 1),
    };
    const d1 = Math.hypot(p.x - lineP1.x, p.y - lineP1.y);
    const d2 = Math.hypot(p.x - lineP2.x, p.y - lineP2.y);
  const hitR = 0.025;
    if (d1 <= hitR) return 0;
    if (d2 <= hitR) return 1;
    return null;
  }, [selectedCameraOpt, lineP1, lineP2, analyzing]);

  const findFloorVertexHit = useCallback((world: Vec2): 0 | 1 | null => {
    if (analyzing) return null;
    if (!floorLineP1 || !floorLineP2) return null;
    const imgPt = worldToImagePoint(world, floorViewportRef.current, { allowOutside: false });
    if (!imgPt) return null;
    const p = {
      x: imgPt.x / Math.max(1, floorViewportRef.current.aspectW),
      y: imgPt.y / Math.max(1, floorViewportRef.current.aspectH),
    };
    const d1 = Math.hypot(p.x - floorLineP1.x, p.y - floorLineP1.y);
    const d2 = Math.hypot(p.x - floorLineP2.x, p.y - floorLineP2.y);
    const hitR = 0.02;
    if (d1 <= hitR) return 0;
    if (d2 <= hitR) return 1;
    return null;
  }, [floorLineP1, floorLineP2, analyzing]);

  const renderVirtualOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, info: { w: number; h: number; pan: { x: number; y: number }; zoom: number }) => {
      if (!selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
      const aspectW = Math.max(1, selectedCameraOpt.view.out_w || 1);
      const aspectH = Math.max(1, selectedCameraOpt.view.out_h || 1);
      vvViewportRef.current = { w: info.w, h: info.h, aspectW, aspectH };
      const scale = Math.min(info.w / aspectW, info.h / aspectH);
      const imgW = aspectW * scale;
      const imgH = aspectH * scale;
      const imgX = (info.w - imgW) / 2;
      const imgY = (info.h - imgH) / 2;
      const toWorld = (p: Vec2) => ({
        x: imgX + p.x * imgW,
        y: imgY + p.y * imgH,
      });
      ctx.save();
      ctx.translate(info.pan.x, info.pan.y);
      ctx.scale(info.zoom, info.zoom);
      if (lineP1 && lineP2) {
        const p1 = toWorld(lineP1);
        const p2 = toWorld(lineP2);
        if (lineEnabled) {
          const now = Date.now();
          const flashing = lineFlash != null && now <= lineFlash.untilMs;
          const flashColor = lineFlash?.kind === "in" ? "#10B981" : "#FACC15";
          if (flashing) {
            ctx.strokeStyle = flashColor;
            ctx.lineWidth = 6;
          } else {
            // 判定线常态：白色
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = 3;
          }
          ctx.setLineDash([8, 6]);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.setLineDash([]);
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len > 1) {
            const nx = -dy / len;
            const ny = dx / len;
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const d = 26;
            const drawArrow = (from: Vec2, to: Vec2) => {
              ctx.strokeStyle = "#FFFFFF";
              ctx.lineWidth = 2.5;
              ctx.setLineDash([6, 5]);
              ctx.beginPath();
              ctx.moveTo(from.x, from.y);
              ctx.lineTo(to.x, to.y);
              ctx.stroke();
              ctx.setLineDash([]);
              const adx = to.x - from.x;
              const ady = to.y - from.y;
              const al = Math.hypot(adx, ady) || 1;
              const ux = adx / al;
              const uy = ady / al;
              const px = -uy;
              const py = ux;
              const head = 9;
              const wing = 5;
              ctx.fillStyle = "#FFFFFF";
              ctx.beginPath();
              ctx.moveTo(to.x, to.y);
              ctx.lineTo(to.x - ux * head + px * wing, to.y - uy * head + py * wing);
              ctx.lineTo(to.x - ux * head - px * wing, to.y - uy * head - py * wing);
              ctx.closePath();
              ctx.fill();
            };
            const inFrom = { x: mx, y: my };
            const inTo = { x: mx + nx * d, y: my + ny * d };
            const outFrom = { x: mx, y: my };
            const outTo = { x: mx - nx * d, y: my - ny * d };
            drawArrow(inFrom, inTo);
            drawArrow(outFrom, outTo);
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const drawLabelWithBg = (text: string, x: number, y: number) => {
              const padX = 6;
              const padY = 3;
              const m = ctx.measureText(text || "");
              const tw = Math.ceil(m.width);
              const th = 14;
              const rx = x - tw / 2 - padX;
              const ry = y - th / 2 - padY;
              const rw = tw + padX * 2;
              const rh = th + padY * 2;
              ctx.fillStyle = "rgba(0,0,0,0.55)";
              ctx.fillRect(rx, ry, rw, rh);
              ctx.fillStyle = "#FFFFFF";
              ctx.fillText(text, x, y);
            };
            drawLabelWithBg(inLabel, mx + nx * (d + 16), my + ny * (d + 16));
            drawLabelWithBg(outLabel, mx - nx * (d + 16), my - ny * (d + 16));
          }
        } else {
          ctx.strokeStyle = "#94A3B8";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 端点：白色描边 + 不透明白色填充
        ctx.fillStyle = "#FFFFFF";
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
    [selectedCameraOpt, lineP1, lineP2, lineEnabled, inLabel, outLabel, lineFlash],
  );

  const deleteCurrentLine = useCallback(() => {
    if (!bindCameraId) return;
    const m = bindCameraId.match(/^vv:(\d+)$/);
    const vvId = m ? Number(m[1]) : null;
    if (selectedFloorPlanId != null && vvId != null) {
      void fetch(
        `${API_BASE}/api/footfall/lines?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    setAllLineCfg((old) => {
      if (!old[bindCameraId]) return old;
      const next = { ...old };
      delete next[bindCameraId];
      writeAllLineCfg(next);
      return next;
    });
    setLineP1(null);
    setLineP2(null);
    setSavedLineP1(null);
    setSavedLineP2(null);
    setFloorLineP1(null);
    setFloorLineP2(null);
    setDrawHint("已删除该摄像头判定线");
  }, [bindCameraId, selectedFloorPlanId]);

  const lineCfgRows = useMemo(() => {
    const rows = Object.entries(allLineCfg)
      .map(([key, cfg], idx) => {
        const opt = bindCameraOptions.find((o) => o.key === key);
        const cameraId =
          opt?.kind === "virtual"
            ? opt.view.camera_id
            : opt?.kind === "camera"
              ? opt.camera.id
              : "-";
        return {
          key,
          cfg,
          lineId: `L-${String(idx + 1).padStart(3, "0")}`,
          label: opt?.label || key,
          cameraId,
        };
      })
      .filter((it) => !!it.cfg?.p1 && !!it.cfg?.p2);
    rows.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    return rows;
  }, [allLineCfg, bindCameraOptions]);

  const deleteLineByKey = useCallback(
    (cameraKey: string) => {
      const m = cameraKey.match(/^vv:(\d+)$/);
      const vvId = m ? Number(m[1]) : null;
      if (selectedFloorPlanId != null && vvId != null) {
        void fetch(
          `${API_BASE}/api/footfall/lines?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
          { method: "DELETE" },
        ).catch(() => {});
      }
      setAllLineCfg((old) => {
        if (!old[cameraKey]) return old;
        const next = { ...old };
        delete next[cameraKey];
        writeAllLineCfg(next);
        return next;
      });
      if (cameraKey === bindCameraId) {
        setLineP1(null);
        setLineP2(null);
        setSavedLineP1(null);
        setSavedLineP2(null);
        setFloorLineP1(null);
        setFloorLineP2(null);
        setDrawHint("已删除该摄像头判定线");
      }
    },
    [bindCameraId, selectedFloorPlanId],
  );

  const renderFloorOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, info: { w: number; h: number; pan: { x: number; y: number }; zoom: number }) => {
      const aspectW = Math.max(1, floorImgNaturalSize?.w || selectedFloorPlan?.width_px || 1920);
      const aspectH = Math.max(1, floorImgNaturalSize?.h || selectedFloorPlan?.height_px || 1080);
      floorViewportRef.current = { w: info.w, h: info.h, aspectW, aspectH };
      const scale = Math.min(info.w / aspectW, info.h / aspectH);
      const imgW = aspectW * scale;
      const imgH = aspectH * scale;
      const imgX = (info.w - imgW) / 2;
      const imgY = (info.h - imgH) / 2;
      const toWorld = (p: Vec2) => ({ x: imgX + p.x * imgW, y: imgY + p.y * imgH });

      // 可选：绘制简化网格（与 showGrid 开关联动）
      if (showGrid && selectedFloorPlan) {
        const rows = Math.max(1, Number(selectedFloorPlan.grid_rows) || 1);
        const cols = Math.max(1, Number(selectedFloorPlan.grid_cols) || 1);
        ctx.save();
        ctx.translate(info.pan.x, info.pan.y);
        ctx.scale(info.zoom, info.zoom);
        ctx.strokeStyle = "rgba(14,165,233,0.3)";
        ctx.lineWidth = 1;
        for (let r = 0; r <= rows; r++) {
          const y = imgY + (r / rows) * imgH;
          ctx.beginPath();
          ctx.moveTo(imgX, y);
          ctx.lineTo(imgX + imgW, y);
          ctx.stroke();
        }
        for (let c = 0; c <= cols; c++) {
          const x = imgX + (c / cols) * imgW;
          ctx.beginPath();
          ctx.moveTo(x, imgY);
          ctx.lineTo(x, imgY + imgH);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(info.pan.x, info.pan.y);
      ctx.scale(info.zoom, info.zoom);

      const rows = Object.entries(allLineCfg)
        .map(([key, cfg]) => ({
          key,
          p1: cfg.floor_p1 ?? cfg.p1,
          p2: cfg.floor_p2 ?? cfg.p2,
          inLabel: cfg.inLabel || "进入",
          outLabel: cfg.outLabel || "离开",
          enabled: cfg.enabled !== false,
          active: key === bindCameraId,
        }))
        .filter((it) => !!it.p1 && !!it.p2);

      const drawTag = (text: string, x: number, y: number, active: boolean) => {
        ctx.font = "600 11px sans-serif";
        const tw = Math.ceil(ctx.measureText(text).width);
        const th = 16;
        const padX = 5;
        const padY = 2;
        const rx = x - tw / 2 - padX;
        const ry = y - th / 2 - padY;
        const rw = tw + padX * 2;
        const rh = th + padY * 2;
        ctx.fillStyle = active ? "rgba(15,23,42,0.75)" : "rgba(15,23,42,0.62)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x, y);
      };

      for (const row of rows) {
        const p1 = toWorld(row.p1);
        const p2 = toWorld(row.p2);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        const nx = len > 1 ? -dy / len : 0;
        const ny = len > 1 ? dx / len : 0;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const d = 20;

        const mainStroke = row.active ? "#38BDF8" : row.enabled ? "#60A5FA" : "rgba(148,163,184,0.9)";
        // 先画一层深色描边，保证在浅色/亮色平面图上也清晰可见
        ctx.strokeStyle = "rgba(15,23,42,0.65)";
        ctx.lineWidth = row.active ? 5.2 : 3.8;
        if (!row.enabled) {
          ctx.setLineDash([6, 4]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        // 再画主线
        ctx.strokeStyle = mainStroke;
        ctx.lineWidth = row.active ? 3.5 : 2.4;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "#FFFFFF";
        ctx.strokeStyle = row.active ? "#0EA5E9" : "rgba(148,163,184,0.9)";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, row.active ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, row.active ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (len > 1) {
          const st = lineOverviewStats[row.key] || { inCount: 0, outCount: 0 };
          drawTag(`${row.inLabel}${st.inCount}`, mx + nx * (d + 12), my + ny * (d + 12), row.active);
          drawTag(`${row.outLabel}${st.outCount}`, mx - nx * (d + 12), my - ny * (d + 12), row.active);
        }
      }
      ctx.restore();
    },
    [selectedFloorPlan, floorImgNaturalSize, showGrid, allLineCfg, bindCameraId, lineOverviewStats],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-[2fr,1fr,3fr] md:grid-rows-[4fr,2fr]">
      <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:col-start-1 md:row-start-1 md:row-span-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-800">平面图选择</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
            value={selectedFloorPlanId ?? ""}
            onChange={(e) => setSelectedFloorPlanId(e.target.value ? Number(e.target.value) : null)}
          >
            {floorPlans.length === 0 && <option value="">无平面图</option>}
            {floorPlans.map((fp) => (
              <option key={fp.id} value={fp.id}>
                {fp.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-700">平面图预览</span>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            显示网格
          </label>
        </div>
        <div className="order-1 relative flex min-h-0 flex-[2] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white">
          {floorPlanImageUrlStr && selectedFloorPlan ? (
            <PanZoomViewport
              className="h-full w-full"
              mode="panzoom"
              onPointerDownWorld={(p) => {
                const hit = findFloorVertexHit(p);
                if (hit == null) return;
                setDraggingFloorVertex(hit);
                return true;
              }}
              onMoveWorld={(p) => {
                if (draggingFloorVertex == null) return;
                const imgPt = worldToImagePoint(p, floorViewportRef.current, { allowOutside: false });
                if (!imgPt) return;
                const n = {
                  x: imgPt.x / Math.max(1, floorViewportRef.current.aspectW),
                  y: imgPt.y / Math.max(1, floorViewportRef.current.aspectH),
                };
                if (draggingFloorVertex === 0) setFloorLineP1(n);
                else setFloorLineP2(n);
              }}
              onPointerUpWorld={() => setDraggingFloorVertex(null)}
              renderOverlay={renderFloorOverlay}
            >
              <img
                src={floorPlanImageUrlStr}
                alt={`floor-plan-${selectedFloorPlan.id}`}
                className="h-full w-full object-contain"
                draggable={false}
              />
            </PanZoomViewport>
          ) : (
            <span className="text-xs text-slate-400">当前无平面图配置，请在“映射管理”中上传或选择平面图。</span>
          )}
        </div>
        <div className="order-2 mt-3 flex-[3] min-h-0 rounded-lg border border-slate-200 bg-white p-3 flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">数据统计</div>
            <div className="flex items-center gap-2 text-[11px] text-slate-600">
              <input
                type="date"
                className="rounded border border-slate-300 bg-white px-2 py-1"
                value={statsDate}
                onChange={(e) => {
                  setStatsDate(e.target.value || toUTCDateInputValue(new Date()));
                  setStatsMode("date");
                }}
                  disabled={statsMode === "realtime" || analyzing}
                title="选择日期加载统计数据"
              />
              <label className="flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={statsMode === "realtime"}
                  onChange={(e) => setStatsMode(e.target.checked ? "realtime" : "date")}
                    disabled={analyzing}
                />
                <span>实时数据</span>
              </label>
                <button
                  type="button"
                  className={`rounded px-3 py-1 text-xs font-medium text-white ${
                    analyzing ? "bg-rose-500 hover:bg-rose-600" : "bg-[#694FF9] hover:bg-[#5b3ff6]"
                  } disabled:opacity-50`}
                  disabled={!analyzing && !canStartFootfall}
                  onClick={() => {
                    if (analyzing) void stopFootfallAnalysis();
                    else void startFootfallAnalysis();
                  }}
                  title={!canStartFootfall ? "需要：选择平面图 + 选择虚拟摄像头 + 保存判定线" : "启动/停止检测分析"}
                >
                  {analyzing ? "停止检测分析" : "开始检测分析"}
                </button>
            </div>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2">
              <div className="text-[11px] text-emerald-800">{`${statsTitleDate} 累计进入`}</div>
              <RollingNumber value={statsData.inCount} className="text-lg font-semibold text-emerald-700" />
            </div>
            <div className="rounded border border-orange-200 bg-orange-50 p-2">
              <div className="text-[11px] text-orange-800">{`${statsTitleDate} 累计离开`}</div>
              <RollingNumber value={statsData.outCount} className="text-lg font-semibold text-orange-700" />
            </div>
          </div>

          <div className="mb-3 flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            <div className="flex min-h-0 flex-col rounded border border-slate-200 bg-slate-50 p-2 lg:w-[34%]">
              <div className="mb-2 text-xs font-semibold text-slate-700">性别分布（男 / 女）</div>
              <div className="min-h-0 flex-1">
                <ReactECharts option={genderOption} style={{ height: "100%", width: "100%" }} notMerge />
              </div>
              {analyzing && statsData.genderMale + statsData.genderFemale === 0 ? (
                <div className="mt-2 text-[11px] text-amber-600">
                  当前检测不到男/女：请确认后端已配置二阶段性别模型 `YOLO_GENDER_MODEL_PATH`（默认 `yolov8n-gender-classification.pt`），并能正确输出 gender（male/female）。
                </div>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-2 text-xs font-semibold text-slate-700">年龄分布</div>
              <div className="min-h-0 flex-1">
                <ReactECharts option={ageOption} style={{ height: "100%", width: "100%" }} notMerge />
              </div>
              {analyzing &&
              statsData.inCount + statsData.outCount > 0 &&
              statsData.ageBuckets.reduce((a, b) => a + b.value, 0) === 0 ? (
                <div className="mt-2 text-[11px] text-amber-600">
                  当前检测不到年龄分桶：请确认后端已配置两个二阶段模型：性别模型 `YOLO_GENDER_MODEL_PATH`（默认 `yolov8n-gender-classification.pt`），年龄模型 `YOLO_FACE_AGE_MODEL_PATH`（默认 `yolo11n-face-age.pt`），并能正确输出年龄（会被映射到 `18-25/55+` 等分桶）。
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex flex-1 flex-col rounded border border-slate-200 bg-slate-50 p-2">
            <div className="mb-2 text-xs font-semibold text-slate-700">时段流量趋势（按小时）</div>
            <div className="min-h-0 flex-1">
              <ReactECharts option={trendOption} style={{ height: "100%", width: "100%" }} notMerge />
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:col-start-3 md:row-start-1">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-800">监控画面选择</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
            value={bindCameraId}
            onChange={(e) => {
              userSelectedCameraRef.current = true;
              setBindCameraId(e.target.value);
            }}
          >
            {bindCameraOptions.length === 0 && <option value="">无监控画面</option>}
            {bindCameraOptions.map((it) => (
              <option key={it.key} value={it.key}>
                {it.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-2 text-[11px] text-slate-500">
          参考映射绑定交互：先选监控画面，再在画面上两次点击绘制进出判定线。
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
          {selectedCameraOpt ? (
            selectedCameraOpt.kind === "virtual" ? (
              <PanZoomViewport
                className="h-full w-full"
                mode={lineToolEnabled ? "draw" : "panzoom"}
                onClickWorld={onVirtualPreviewClick}
                onPointerDownWorld={(p) => {
                  const hit = findCamVertexHit(p);
                  if (hit == null) return;
                  setDraggingCamVertex(hit);
                  return true;
                }}
                onMoveWorld={(p) => {
                  if (draggingCamVertex == null || !selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
                  const imgPt = worldToImagePoint(p, vvViewportRef.current, { allowOutside: false });
                  if (!imgPt) return;
                  const n = {
                    x: imgPt.x / Math.max(1, selectedCameraOpt.view.out_w || 1),
                    y: imgPt.y / Math.max(1, selectedCameraOpt.view.out_h || 1),
                  };
                  if (draggingCamVertex === 0) setLineP1(n);
                  else setLineP2(n);
                }}
                onPointerUpWorld={() => setDraggingCamVertex(null)}
                onContextMenu={(e) => {
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  setContextMenu({
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                    visible: true,
                  });
                }}
                topLeftOverlay={
                  <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white/90 p-1 shadow-sm">
                    <button
                      type="button"
                      className={`inline-flex h-8 w-8 items-center justify-center rounded hover:bg-slate-100 ${
                        lineToolEnabled ? "bg-emerald-100 text-emerald-700" : "text-slate-700"
                      }`}
                      disabled={analyzing}
                      onClick={() => {
                        setLineToolEnabled((prev) => {
                          const next = !prev;
                          setDrawHint(next ? "点击画面设置第一个点" : "已退出绘制模式");
                          return next;
                        });
                      }}
                      title="绘制进出判定线"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M4 18L20 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="4" cy="18" r="2" fill="currentColor" />
                        <circle cx="20" cy="6" r="2" fill="currentColor" />
                      </svg>
                    </button>
                    {lineToolEnabled && (
                      <>
                        <button
                          type="button"
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          disabled={!lineP1 || !lineP2 || analyzing}
                          onClick={() => {
                            if (!bindCameraId || !lineP1 || !lineP2) return;
                            setAllLineCfg((old) => {
                              const next = {
                                ...old,
                                [bindCameraId]: {
                                  p1: lineP1,
                                  p2: lineP2,
                                  floor_p1: floorLineP1 ?? lineP1,
                                  floor_p2: floorLineP2 ?? lineP2,
                                  inLabel,
                                  outLabel,
                                  enabled: lineEnabled,
                                },
                              };
                              writeAllLineCfg(next);
                              return next;
                            });
                            setSavedLineP1(lineP1);
                            setSavedLineP2(lineP2);
                            if (!floorLineP1 && lineP1) setFloorLineP1(lineP1);
                            if (!floorLineP2 && lineP2) setFloorLineP2(lineP2);
                            setDrawHint("判定线已保存");

                            // 保存成功后收起绘制工具栏，等同于结束绘制
                            setLineToolEnabled(false);

                        // 同步到后端：跨电脑共享判定线配置
                        if (
                          selectedFloorPlanId != null &&
                          selectedCameraOpt?.kind === "virtual" &&
                          lineP1 &&
                          lineP2
                        ) {
                          const vvId = selectedCameraOpt.view.id;
                          void fetch(`${API_BASE}/api/footfall/lines/upsert`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              floor_plan_id: selectedFloorPlanId,
                              virtual_view_id: vvId,
                              p1: lineP1,
                              p2: lineP2,
                              floor_p1: floorLineP1 ?? lineP1,
                              floor_p2: floorLineP2 ?? lineP2,
                              in_label: inLabel,
                              out_label: outLabel,
                              enabled: lineEnabled,
                            }),
                          }).catch(() => {});
                        }
                          }}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
                          disabled={analyzing}
                          onClick={deleteCurrentLine}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                }
                renderOverlay={renderVirtualOverlay}
              >
                <VirtualViewMjpeg
                  mjpegUrl={`${API_BASE}/api/cameras/${selectedCameraOpt.view.camera_id}/virtual-views/${
                    selectedCameraOpt.view.id
                  }/${analyzing ? "analyzed" : "preview_shared"}.mjpeg?stream=${mjpegStreamEpoch}`}
                  title={`footfall-camera-${selectedCameraOpt.view.id}-${analyzing ? "analyzed" : "preview"}`}
                  frameW={Math.max(1, Number(selectedCameraOpt.view.out_w) || 960)}
                  frameH={Math.max(1, Number(selectedCameraOpt.view.out_h) || 540)}
                  epoch={mjpegStreamEpoch}
                />
              </PanZoomViewport>
            ) : selectedCameraOpt.camera.webrtc_url ? (
              <iframe
                src={selectedCameraOpt.camera.webrtc_url}
                className="h-full w-full border-none"
                allow="autoplay; fullscreen"
                title={`footfall-camera-${selectedCameraOpt.camera.id}`}
              />
            ) : (
              <div className="text-xs text-slate-300">该摄像头未配置播放地址</div>
            )
          ) : (
            <div className="text-xs text-slate-300">请先选择摄像头</div>
          )}
          {selectedCameraOpt?.kind === "virtual" && contextMenu.visible && (
            <div
              className="absolute z-20 min-w-24 rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseLeave={() => setContextMenu((m) => ({ ...m, visible: false }))}
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-rose-700 hover:bg-rose-50"
                onClick={() => {
                  deleteCurrentLine();
                  setContextMenu((m) => ({ ...m, visible: false }));
                }}
              >
                删除判定线
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:col-start-2 md:row-start-1 md:row-span-2">
        <div className="mb-2 text-sm font-semibold text-slate-800">人脸分析记录</div>
        <div
          ref={faceCaptureContainerRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1"
          onScroll={(e) => {
            const el = e.currentTarget;
            setFaceScrollTop(el.scrollTop);
            if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 120) {
              loadMoreFaceCaptures();
            }
          }}
        >
          {faceCaptures.length === 0 ? (
            <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
              暂无抓拍记录（仅显示经过判定线“进入”方向的人脸）
            </div>
          ) : (
            <div style={{ position: "relative", height: `${faceCaptures.length * faceCaptureRowH}px` }}>
              {faceCaptures.slice(faceVisibleRange.start, faceVisibleRange.end).map((it, i) => {
                const idx = faceVisibleRange.start + i;
                const top = idx * faceCaptureRowH;
                return (
                  <div
                    key={it.id}
                    className="absolute left-0 right-0 px-0.5 pb-2"
                    style={{
                      top: `${top}px`,
                      height: `${faceCaptureRowH}px`,
                      opacity: newFaceCaptureIds.includes(it.id) ? 0 : 1,
                      transform: newFaceCaptureIds.includes(it.id) ? "translateY(-6px)" : "translateY(0)",
                      transition: "top 220ms ease, opacity 260ms ease, transform 260ms ease",
                    }}
                  >
                    <div className="flex h-[76px] flex-row gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <img
                        src={`data:image/jpeg;base64,${it.image_base64}`}
                        alt={`face-${it.id}`}
                        className="h-16 w-16 flex-shrink-0 rounded object-cover"
                      />
                      <div className="flex flex-col justify-center">
                        <div className="text-xs text-slate-700">
                          性别：{it.gender === "male" ? "男" : it.gender === "female" ? "女" : "未知"}
                        </div>
                        <div className="mt-1 text-xs text-slate-700">年龄：{it.age_bucket || "未知"}</div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          时间：{Number.isFinite(Number(it.ts)) ? new Date(Number(it.ts) * 1000).toLocaleString() : "-"}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {faceCaptureLoading ? <div className="py-1 text-center text-[11px] text-slate-500">加载中...</div> : null}
          {!faceCaptureHasMore && faceCaptures.length > 0 ? (
            <div className="py-1 text-center text-[11px] text-slate-400">已加载全部历史</div>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:col-start-3 md:row-start-2">
        <div className="mb-3 text-sm font-semibold text-slate-800">判定线配置</div>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
          <div className="flex flex-row gap-2 overflow-x-auto pb-1">
            {lineCfgRows.length === 0 ? (
              <div className="flex-shrink-0 min-w-[220px] rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">
                暂无已保存线段，请先在监控画面中绘制并保存。
              </div>
            ) : (
              lineCfgRows.map((row) => (
                <div
                  key={row.key}
                  className={`flex-shrink-0 min-w-[220px] rounded-lg border p-2 transition-opacity ${
                    bindCameraId === row.key
                      ? "border-slate-200 bg-slate-50 opacity-100"
                      : "border-slate-200 bg-slate-50 opacity-50"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-700">线段编号</span>
                    <span className="rounded bg-white px-2 py-0.5 text-xs text-slate-700">{row.lineId}</span>
                  </div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-700">绑定设备</span>
                    <span
                      className="max-w-[170px] truncate rounded bg-white px-2 py-0.5 text-xs text-slate-700"
                      title={row.label}
                    >
                      {row.label}
                    </span>
                  </div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-700">设备编号</span>
                    <span className="rounded bg-white px-2 py-0.5 text-xs text-slate-700">{row.cameraId}</span>
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-2 text-[11px] text-slate-700">
                    <div className="mb-0.5 font-medium text-slate-600">线段坐标</div>
                    <div>A[{`${row.cfg.p1.x.toFixed(3)}, ${row.cfg.p1.y.toFixed(3)}`}]</div>
                    <div>B[{`${row.cfg.p2.x.toFixed(3)}, ${row.cfg.p2.y.toFixed(3)}`}]</div>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        setBindCameraId(row.key);
                        setDrawHint("已切换到该线段绑定设备");
                      }}
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
                      onClick={() => deleteLineByKey(row.key)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const FootfallAnalysisView: React.FC<FootfallAnalysisViewProps> = ({
  FloorPlanCanvasComponent,
  MappedCamerasGridComponent,
}) => {
  return (
    <div className="flex h-[calc(100vh-96px)] min-h-0 flex-col gap-4">
      <h2 className="text-xl font-semibold text-slate-800">人流量分析</h2>
      <p className="text-xs text-slate-500">配置摄像头进出判定线，并同步校准平面图对应线段。</p>
      <div className="min-h-0 flex-1">
        <FootfallAnalysisConfigView
          FloorPlanCanvasComponent={FloorPlanCanvasComponent}
          MappedCamerasGridComponent={MappedCamerasGridComponent}
        />
      </div>
    </div>
  );
};

export default FootfallAnalysisView;
