import type { EChartsOption, EChartsType } from "echarts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { API_BASE } from "../shared/config";
import { RollingNumber } from "../shared/RollingNumber";
import { floorPlanImageUrl, preloadFloorPlanImage } from "../shared/floorPlan";
import { orderQuad, worldToImagePoint } from "../shared/geometry";
import { Camera, FloorPlan, Pt } from "../shared/types";

type BindCameraOption =
  | { kind: "camera"; key: string; camera: Camera; label: string }
  | {
      kind: "virtual";
      key: string;
      view: { id: number; camera_id: number; name: string; out_w: number; out_h: number; camera_name?: string };
      label: string;
    };

type TrendGranularity = "1h" | "30m" | "1m";

type TrendPoint = { bucket: number; value: number };

type QueueWaitStats = {
  visitCount: number;
  avgQueueSeconds: number;
  avgServiceSeconds: number;
  serviceSampleCount: number;
  /** 离开排队区且未进入服务区（有排队时长、无服务时长） */
  abandonCount: number;
  /** 曾排队且最终完成服务 */
  queuedThenServedCount: number;
  /** 弃单率 = abandon / (abandon + queuedThenServed)，百分比 0–100 */
  abandonRatePercent: number;
  trendQueueAvg: TrendPoint[];
  trendServiceAvg: TrendPoint[];
  trendServiceCount: TrendPoint[];
  trendAvgQueueLength: TrendPoint[];
  /** 与各时间桶一致（由 trend_bucket_abandon 决定桶宽） */
  trendAbandonCount: TrendPoint[];
  trendQueuedThenServedByBucket: TrendPoint[];
  trendAbandonRate: TrendPoint[];
};

type UvQuad = { x: number; y: number }[];

const toUTCDateInputValue = (d: Date): string => d.toISOString().slice(0, 10);

const TREND_GRAN_LABEL: Record<TrendGranularity, string> = {
  "1h": "按小时",
  "30m": "按30分钟",
  "1m": "按1分钟",
};

/** 在 flex 分栏内占满剩余高度，并在容器尺寸变化时 resize ECharts（避免出现左侧趋势区滚动条） */
const FlexHeightReactECharts: React.FC<{ option: EChartsOption; notMerge?: boolean }> = ({ option, notMerge = true }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  const onChartReady = useCallback((chart: EChartsType) => {
    chartRef.current = chart;
    chart.resize();
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="h-full min-h-0 w-full min-w-0">
      <ReactECharts option={option} notMerge={notMerge} style={{ height: "100%", width: "100%" }} onChartReady={onChartReady} />
    </div>
  );
};

function normalizeTrendSeries(raw: unknown, fallbackLen: number): TrendPoint[] {
  if (!Array.isArray(raw)) {
    return Array.from({ length: fallbackLen }, (_, bucket) => ({ bucket, value: 0 }));
  }
  return (raw as { bucket?: number; hour?: number; value?: number }[]).map((t, i) => ({
    bucket: Number(t?.bucket ?? t?.hour ?? i),
    value: Number(t?.value ?? 0),
  }));
}

function trendAxisLabels(n: number, gran: TrendGranularity): string[] {
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    const mins = gran === "1h" ? i * 60 : gran === "30m" ? i * 30 : i;
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    labels.push(`${h}:${String(m).padStart(2, "0")}`);
  }
  return labels;
}

function trendAxisLabelShowIndex(i: number, gran: TrendGranularity): boolean {
  if (gran === "1m") return i % 120 === 0;
  if (gran === "30m") return i % 2 === 0;
  return i % 2 === 0;
}

const emptyStats = (): QueueWaitStats => ({
  visitCount: 0,
  avgQueueSeconds: 0,
  avgServiceSeconds: 0,
  serviceSampleCount: 0,
  abandonCount: 0,
  queuedThenServedCount: 0,
  abandonRatePercent: 0,
  trendQueueAvg: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendServiceAvg: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendServiceCount: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendAvgQueueLength: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendAbandonCount: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendQueuedThenServedByBucket: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
  trendAbandonRate: Array.from({ length: 24 }, (_, bucket) => ({ bucket, value: 0 })),
});

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
        key={`queue-mjpeg-${epoch}`}
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

/** 与 Footfall / 映射管理中 PanZoomViewport 行为一致：绘制时点击，命中顶点可拖拽，否则平移 */
const PanZoomViewport: React.FC<{
  className?: string;
  children: React.ReactNode;
  mode?: "panzoom" | "draw";
  onClickWorld?: (p: { x: number; y: number }) => void;
  onPointerDownWorld?: (p: { x: number; y: number }) => boolean | void;
  onMoveWorld?: (p: { x: number; y: number }) => void;
  onPointerUpWorld?: (p: { x: number; y: number }) => void;
  topLeftOverlay?: React.ReactNode;
  renderOverlay?: (
    ctx: CanvasRenderingContext2D,
    info: { w: number; h: number; pan: { x: number; y: number }; zoom: number },
  ) => void;
  /** 递增则触发 overlay 重绘（用于与分析同步的 ROI 边框动画） */
  redrawSignal?: number;
}> = ({
  className = "",
  children,
  mode = "panzoom",
  onClickWorld,
  onPointerDownWorld,
  onMoveWorld,
  onPointerUpWorld,
  topLeftOverlay,
  renderOverlay,
  redrawSignal = 0,
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
  }, [renderOverlay, pan, zoom, redrawSignal]);

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

const VERTEX_HIT_PX = 12;

const QueueWaitAnalysisView: React.FC = () => {
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [bindCameraOptions, setBindCameraOptions] = useState<BindCameraOption[]>([]);
  const [bindCameraId, setBindCameraId] = useState<string>("");
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | null>(null);
  const [statsMode, setStatsMode] = useState<"date" | "realtime">("realtime");
  const [statsDate, setStatsDate] = useState<string>(() => toUTCDateInputValue(new Date()));
  const [statsData, setStatsData] = useState<QueueWaitStats>(() => emptyStats());
  const [trendGranQueue, setTrendGranQueue] = useState<TrendGranularity>("1h");
  const [trendGranService, setTrendGranService] = useState<TrendGranularity>("1h");
  const [trendGranFootfall, setTrendGranFootfall] = useState<TrendGranularity>("1h");
  const [trendGranAbandon, setTrendGranAbandon] = useState<TrendGranularity>("1h");
  const [analyzing, setAnalyzing] = useState(false);
  const [clearingRoi, setClearingRoi] = useState(false);
  const [mjpegStreamEpoch, setMjpegStreamEpoch] = useState(0);

  /** 与「映射管理」地面四边形一致：顶点为虚拟视窗像素坐标 (0…out_w, 0…out_h) */
  const [queuePolyImg, setQueuePolyImg] = useState<Pt[] | null>(null);
  const [servicePolyImg, setServicePolyImg] = useState<Pt[] | null>(null);
  const [queueQuadPoints, setQueueQuadPoints] = useState<Pt[]>([]);
  const [serviceQuadPoints, setServiceQuadPoints] = useState<Pt[]>([]);
  const [queueTool, setQueueTool] = useState<"none" | "quad">("none");
  const [serviceTool, setServiceTool] = useState<"none" | "quad">("none");
  const [queueEditEnabled, setQueueEditEnabled] = useState(false);
  const [serviceEditEnabled, setServiceEditEnabled] = useState(false);
  const [draggingVertex, setDraggingVertex] = useState<null | { which: "queue" | "service"; index: number }>(null);

  const [drawHint, setDrawHint] = useState("在监控画面上点击 4 次绘制四边形（与热力图映射相同），可拖顶点微调。");

  const vvViewportRef = useRef<{ w: number; h: number; aspectW: number; aspectH: number }>({
    w: 0,
    h: 0,
    aspectW: 16,
    aspectH: 9,
  });
  /** 用户手动改过画面下拉框后为 true；换平面图时置 false 以便重新默认选中「已有 ROI」的视窗 */
  const userPickedBindRef = useRef(false);

  const fetchStats = useCallback(async () => {
    if (selectedFloorPlanId == null) return;
    const opt = bindCameraOptions.find((o) => o.key === bindCameraId);
    const vvId = opt?.kind === "virtual" ? opt.view.id : null;
    if (vvId == null) return;
    const mode = statsMode === "realtime" ? "realtime" : "date";
    const tz = new Date().getTimezoneOffset();
    const url =
      `${API_BASE}/api/queue-wait/stats?floor_plan_id=${selectedFloorPlanId}` +
      `&virtual_view_id=${vvId}&mode=${mode}` +
      (mode === "date" ? `&date_key=${encodeURIComponent(statsDate)}` : "") +
      `&tz_offset_minutes=${encodeURIComponent(String(tz))}` +
      `&trend_bucket_queue=${encodeURIComponent(trendGranQueue)}` +
      `&trend_bucket_service=${encodeURIComponent(trendGranService)}` +
      `&trend_bucket_footfall=${encodeURIComponent(trendGranFootfall)}` +
      `&trend_bucket_abandon=${encodeURIComponent(trendGranAbandon)}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const raw = (await r.json()) as Partial<QueueWaitStats>;
      const base = emptyStats();
      const fallback = 24;
      const abandonLen =
        Array.isArray(raw.trendAbandonRate) && raw.trendAbandonRate.length > 0
          ? raw.trendAbandonRate.length
          : Array.isArray(raw.trendAbandonCount) && raw.trendAbandonCount.length > 0
            ? raw.trendAbandonCount.length
            : fallback;
      setStatsData({
        visitCount: Number(raw.visitCount ?? base.visitCount),
        avgQueueSeconds: Number(raw.avgQueueSeconds ?? base.avgQueueSeconds),
        avgServiceSeconds: Number(raw.avgServiceSeconds ?? base.avgServiceSeconds),
        serviceSampleCount: Number(raw.serviceSampleCount ?? base.serviceSampleCount),
        abandonCount: Number(raw.abandonCount ?? base.abandonCount),
        queuedThenServedCount: Number(raw.queuedThenServedCount ?? base.queuedThenServedCount),
        abandonRatePercent: Number(raw.abandonRatePercent ?? base.abandonRatePercent),
        trendQueueAvg: normalizeTrendSeries(raw.trendQueueAvg, fallback),
        trendServiceAvg: normalizeTrendSeries(raw.trendServiceAvg, fallback),
        trendServiceCount: normalizeTrendSeries(raw.trendServiceCount, fallback),
        trendAvgQueueLength: normalizeTrendSeries(raw.trendAvgQueueLength, fallback),
        trendAbandonCount: normalizeTrendSeries(raw.trendAbandonCount, abandonLen),
        trendQueuedThenServedByBucket: normalizeTrendSeries(raw.trendQueuedThenServedByBucket, abandonLen),
        trendAbandonRate: normalizeTrendSeries(raw.trendAbandonRate, abandonLen),
      });
    } catch {
      /* ignore */
    }
  }, [
    bindCameraId,
    bindCameraOptions,
    selectedFloorPlanId,
    statsDate,
    statsMode,
    trendGranAbandon,
    trendGranFootfall,
    trendGranQueue,
    trendGranService,
  ]);

  useEffect(() => {
    const load = async () => {
      const [camRes, fpRes, vvRes] = await Promise.all([
        fetch(`${API_BASE}/api/cameras/`),
        fetch(`${API_BASE}/api/floor-plans`),
        fetch(`${API_BASE}/api/cameras/virtual-views/all`),
      ]);
      const camData = (await camRes.json()) as Camera[];
      const fpData: FloorPlan[] = await fpRes.json();
      const vvData: { id: number; camera_id: number; name: string; out_w: number; out_h: number; camera_name?: string }[] =
        vvRes.ok ? await vvRes.json() : [];
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
      fpData.forEach((fp) => void preloadFloorPlanImage(floorPlanImageUrl(fp)));
      if (fpData.length > 0 && selectedFloorPlanId == null) setSelectedFloorPlanId(fpData[0].id);
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial bind id bootstrap
  }, []);

  useEffect(() => {
    userPickedBindRef.current = false;
  }, [selectedFloorPlanId]);

  useEffect(() => {
    if (userPickedBindRef.current) return;
    if (selectedFloorPlanId == null || bindCameraOptions.length === 0) return;
    const virtualOpts = bindCameraOptions.filter((o): o is Extract<BindCameraOption, { kind: "virtual" }> => o.kind === "virtual");
    const fallback = virtualOpts[0]?.key ?? bindCameraOptions[0]?.key ?? "";
    if (!fallback) return;
    setBindCameraId(fallback);
    let cancelled = false;
    void (async () => {
      let picked = fallback;
      for (const o of virtualOpts) {
        if (cancelled) return;
        try {
          const r = await fetch(
            `${API_BASE}/api/queue-wait/rois?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${o.view.id}`,
          );
          if (!r.ok) continue;
          const data = (await r.json()) as { queue_quad?: unknown[]; service_quad?: unknown[] } | null;
          if (
            data &&
            Array.isArray(data.queue_quad) &&
            data.queue_quad.length === 4 &&
            Array.isArray(data.service_quad) &&
            data.service_quad.length === 4
          ) {
            picked = o.key;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!cancelled) setBindCameraId(picked);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFloorPlanId, bindCameraOptions]);

  const selectedCameraOpt = useMemo(
    () => bindCameraOptions.find((o) => o.key === bindCameraId) || null,
    [bindCameraOptions, bindCameraId],
  );

  const vvId = selectedCameraOpt?.kind === "virtual" ? selectedCameraOpt.view.id : null;

  const zonePulseRef = useRef({ queue: 0, service: 0 });
  const queuePulseStartRef = useRef<number | null>(null);
  const servicePulseStartRef = useRef<number | null>(null);
  const lastSeenServerPulseRef = useRef({ q: 0, s: 0 });
  const [overlayRedrawTick, setOverlayRedrawTick] = useState(0);

  const uvToImgQuad = useCallback((uv: UvQuad, ow: number, oh: number): Pt[] => {
    return uv.map((p) => ({ x: Number(p.x) * ow, y: Number(p.y) * oh }));
  }, []);

  const imgToUvQuad = useCallback((pts: Pt[], ow: number, oh: number): UvQuad => {
    return pts.map((p) => ({ x: p.x / ow, y: p.y / oh }));
  }, []);

  useEffect(() => {
    setQueueQuadPoints([]);
    setServiceQuadPoints([]);
    setQueueTool("none");
    setServiceTool("none");
    setQueueEditEnabled(false);
    setServiceEditEnabled(false);
    setDraggingVertex(null);
    setQueuePolyImg(null);
    setServicePolyImg(null);

    if (selectedFloorPlanId == null || vvId == null || !selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
    const ow = Math.max(1, selectedCameraOpt.view.out_w || 1);
    const oh = Math.max(1, selectedCameraOpt.view.out_h || 1);
    void (async () => {
      const r = await fetch(
        `${API_BASE}/api/queue-wait/rois?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
      );
      if (!r.ok) return;
      const data = (await r.json()) as {
        queue_quad?: UvQuad;
        service_quad?: UvQuad;
      } | null;
      if (!data) return;
      if (Array.isArray(data.queue_quad) && data.queue_quad.length === 4) {
        setQueuePolyImg(uvToImgQuad(data.queue_quad, ow, oh));
      }
      if (Array.isArray(data.service_quad) && data.service_quad.length === 4) {
        setServicePolyImg(uvToImgQuad(data.service_quad, ow, oh));
      }
    })();
  }, [selectedFloorPlanId, vvId, selectedCameraOpt, uvToImgQuad]);

  useEffect(() => {
    const sync = async () => {
      if (selectedFloorPlanId == null || vvId == null) return;
      const r = await fetch(
        `${API_BASE}/api/queue-wait/status?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
      );
      if (!r.ok) return;
      const j = (await r.json()) as { running?: boolean };
      setAnalyzing(Boolean(j?.running));
    };
    void sync();
    const id = window.setInterval(() => void sync(), 3000);
    return () => window.clearInterval(id);
  }, [selectedFloorPlanId, vvId]);

  useEffect(() => {
    void fetchStats();
    const id = window.setInterval(() => void fetchStats(), 2500);
    return () => window.clearInterval(id);
  }, [fetchStats]);

  useEffect(() => {
    if (analyzing) {
      lastSeenServerPulseRef.current = { q: 0, s: 0 };
      queuePulseStartRef.current = null;
      servicePulseStartRef.current = null;
    }
  }, [analyzing]);

  useEffect(() => {
    if (!analyzing) {
      zonePulseRef.current = { queue: 0, service: 0 };
      return;
    }
    let raf = 0;
    const durMs = 520;
    const tick = () => {
      const now = performance.now();
      let q = 0;
      let s = 0;
      const qs = queuePulseStartRef.current;
      const ss = servicePulseStartRef.current;
      if (qs != null) {
        const elapsed = now - qs;
        if (elapsed < durMs) q = Math.sin(Math.PI * (elapsed / durMs));
        else queuePulseStartRef.current = null;
      }
      if (ss != null) {
        const elapsed = now - ss;
        if (elapsed < durMs) s = Math.sin(Math.PI * (elapsed / durMs));
        else servicePulseStartRef.current = null;
      }
      zonePulseRef.current = { queue: q, service: s };
      setOverlayRedrawTick((t) => t + 1);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [analyzing]);

  useEffect(() => {
    if (!analyzing || selectedFloorPlanId == null || vvId == null) return;
    const poll = async () => {
      try {
        const r = await fetch(
          `${API_BASE}/api/queue-wait/live-occupancy?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
        );
        if (!r.ok) return;
        const j = (await r.json()) as { queue_pulse_ts?: number; service_pulse_ts?: number };
        const qp = Number(j.queue_pulse_ts ?? 0);
        const sp = Number(j.service_pulse_ts ?? 0);
        if (qp > lastSeenServerPulseRef.current.q) {
          queuePulseStartRef.current = performance.now();
          lastSeenServerPulseRef.current.q = qp;
        }
        if (sp > lastSeenServerPulseRef.current.s) {
          servicePulseStartRef.current = performance.now();
          lastSeenServerPulseRef.current.s = sp;
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 380);
    return () => window.clearInterval(id);
  }, [analyzing, selectedFloorPlanId, vvId]);

  const statsTitleDate = statsMode === "realtime" ? "今日" : statsDate;

  const trendQueueOption = useMemo(() => {
    const gran = trendGranQueue;
    const labels = trendAxisLabels(statsData.trendQueueAvg.length, gran);
    const bottom = gran === "1m" ? 40 : 22;
    return {
      grid: { left: 40, right: 12, top: 20, bottom },
      dataZoom:
        gran === "1m"
          ? [
              { type: "inside", xAxisIndex: 0 },
              { type: "slider", xAxisIndex: 0, height: 14, bottom: 4 },
            ]
          : undefined,
      xAxis: {
        type: "category" as const,
        data: labels,
        axisLabel: {
          interval: 0,
          rotate: gran === "1m" ? 50 : 0,
          fontSize: 10,
          formatter: (val: string, idx?: number) => {
            const i = typeof idx === "number" ? idx : labels.indexOf(val);
            return trendAxisLabelShowIndex(i, gran) ? val : "";
          },
        },
      },
      yAxis: { type: "value" as const, name: "秒" },
      series: [
        {
          type: "line" as const,
          smooth: true,
          name: "平均排队",
          data: statsData.trendQueueAvg.map((t) => t.value),
          areaStyle: { opacity: 0.08 },
        },
      ],
      tooltip: { trigger: "axis" as const },
    };
  }, [statsData.trendQueueAvg, trendGranQueue]);

  const trendServiceOption = useMemo(() => {
    const gran = trendGranService;
    const labels = trendAxisLabels(statsData.trendServiceAvg.length, gran);
    const bottom = gran === "1m" ? 40 : 22;
    return {
      grid: { left: 40, right: 12, top: 20, bottom },
      dataZoom:
        gran === "1m"
          ? [
              { type: "inside", xAxisIndex: 0 },
              { type: "slider", xAxisIndex: 0, height: 14, bottom: 4 },
            ]
          : undefined,
      xAxis: {
        type: "category" as const,
        data: labels,
        axisLabel: {
          interval: 0,
          rotate: gran === "1m" ? 50 : 0,
          fontSize: 10,
          formatter: (val: string, idx?: number) => {
            const i = typeof idx === "number" ? idx : labels.indexOf(val);
            return trendAxisLabelShowIndex(i, gran) ? val : "";
          },
        },
      },
      yAxis: { type: "value" as const, name: "秒" },
      series: [
        {
          type: "line" as const,
          smooth: true,
          name: "平均服务",
          data: statsData.trendServiceAvg.map((t) => t.value),
          areaStyle: { opacity: 0.08 },
        },
      ],
      tooltip: { trigger: "axis" as const },
    };
  }, [statsData.trendServiceAvg, trendGranService]);

  const footTrafficTrendOption = useMemo(() => {
    const gran = trendGranFootfall;
    const categories = trendAxisLabels(statsData.trendServiceCount.length, gran);
    const bottom = gran === "1m" ? 40 : 22;
    return {
      tooltip: { trigger: "axis" as const },
      legend: {
        data: ["服务人数", "平均队列长度"],
        top: 0,
        textStyle: { fontSize: 10 },
      },
      grid: { left: 46, right: 46, top: 30, bottom },
      dataZoom:
        gran === "1m"
          ? [
              { type: "inside", xAxisIndex: 0 },
              { type: "slider", xAxisIndex: 0, height: 14, bottom: 4 },
            ]
          : undefined,
      xAxis: {
        type: "category" as const,
        data: categories,
        axisLabel: {
          interval: 0,
          rotate: gran === "1m" ? 50 : 0,
          fontSize: 10,
          formatter: (val: string, idx?: number) => {
            const i = typeof idx === "number" ? idx : categories.indexOf(val);
            return trendAxisLabelShowIndex(i, gran) ? val : "";
          },
        },
      },
      yAxis: [
        {
          type: "value" as const,
          name: "服务人数",
          minInterval: 1,
          nameTextStyle: { fontSize: 11 },
        },
        {
          type: "value" as const,
          name: "队列长度",
          splitLine: { show: false },
          nameTextStyle: { fontSize: 11 },
        },
      ],
      series: [
        {
          name: "服务人数",
          type: "bar" as const,
          yAxisIndex: 0,
          data: statsData.trendServiceCount.map((t) => t.value),
          itemStyle: { color: "#6366f1", borderRadius: [3, 3, 0, 0] },
        },
        {
          name: "平均队列长度",
          type: "line" as const,
          yAxisIndex: 1,
          smooth: true,
          data: statsData.trendAvgQueueLength.map((t) => t.value),
          lineStyle: { width: 2.5, color: "#f97316" },
          itemStyle: { color: "#f97316", borderWidth: 1, borderColor: "#fff" },
          symbol: "circle",
          symbolSize: 7,
        },
      ],
    };
  }, [statsData.trendAvgQueueLength, statsData.trendServiceCount, trendGranFootfall]);

  const abandonRateTrendOption = useMemo(() => {
    const gran = trendGranAbandon;
    const n = statsData.trendAbandonRate.length;
    const labels = trendAxisLabels(n, gran);
    const bottom = gran === "1m" ? 40 : 22;
    return {
      grid: { left: 44, right: 16, top: 18, bottom },
      dataZoom:
        gran === "1m"
          ? [
              { type: "inside", xAxisIndex: 0 },
              { type: "slider", xAxisIndex: 0, height: 14, bottom: 4 },
            ]
          : undefined,
      xAxis: {
        type: "category" as const,
        data: labels,
        axisLabel: {
          interval: 0,
          rotate: gran === "1m" ? 50 : 0,
          fontSize: 10,
          formatter: (val: string, idx?: number) => {
            const i = typeof idx === "number" ? idx : labels.indexOf(val);
            return trendAxisLabelShowIndex(i, gran) ? val : "";
          },
        },
      },
      yAxis: {
        type: "value" as const,
        name: "弃单率（%）",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}" },
      },
      series: [
        {
          type: "line" as const,
          smooth: true,
          name: "弃单率",
          data: statsData.trendAbandonRate.map((t) => t.value),
          lineStyle: { width: 2.2, color: "#e11d48" },
          itemStyle: { color: "#e11d48" },
          areaStyle: { opacity: 0.06, color: "#e11d48" },
          symbol: "circle",
          symbolSize: 5,
        },
      ],
      tooltip: {
        trigger: "axis" as const,
        formatter: (params: unknown) => {
          const arr = params as { axisValue?: string; dataIndex?: number }[];
          const p = arr?.[0];
          const idx = typeof p?.dataIndex === "number" ? p.dataIndex : 0;
          const ab = statsData.trendAbandonCount[idx]?.value ?? 0;
          const sv = statsData.trendQueuedThenServedByBucket[idx]?.value ?? 0;
          const rate = statsData.trendAbandonRate[idx]?.value ?? 0;
          const head = p?.axisValue != null ? String(p.axisValue) : "";
          return `${head}<br/>弃单率：<strong>${rate}%</strong><br/>弃单 <strong>${ab}</strong> · 排队后成交 <strong>${sv}</strong>`;
        },
      },
    };
  }, [
    statsData.trendAbandonCount,
    statsData.trendAbandonRate,
    statsData.trendQueuedThenServedByBucket,
    trendGranAbandon,
  ]);

  const onClickQuadWorld = useCallback(
    (world: Pt, which: "queue" | "service") => {
      if (!selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
      const imgPt = worldToImagePoint(world, vvViewportRef.current, { allowOutside: true });
      if (!imgPt) return;
      if (which === "queue") {
        setQueueQuadPoints((old) => {
          const next = [...old, imgPt];
          if (next.length === 4) {
            setQueuePolyImg(orderQuad(next));
            setQueueTool("none");
            setQueueEditEnabled(true);
            setDrawHint("排队区四边形已生成，可拖顶点调整，然后保存 ROI。");
            return [];
          }
          setDrawHint(`排队区：已点 ${next.length}/4`);
          return next;
        });
      } else {
        setServiceQuadPoints((old) => {
          const next = [...old, imgPt];
          if (next.length === 4) {
            setServicePolyImg(orderQuad(next));
            setServiceTool("none");
            setServiceEditEnabled(true);
            setDrawHint("服务区四边形已生成，可拖顶点调整，然后保存 ROI。");
            return [];
          }
          setDrawHint(`服务区：已点 ${next.length}/4`);
          return next;
        });
      }
    },
    [selectedCameraOpt],
  );

  const onClickWorld = useCallback(
    (world: Pt) => {
      if (queueTool === "quad") onClickQuadWorld(world, "queue");
      else if (serviceTool === "quad") onClickQuadWorld(world, "service");
    },
    [onClickQuadWorld, queueTool, serviceTool],
  );

  const onPointerDownWorld = useCallback(
    (world: Pt): boolean | void => {
      const imgPt = worldToImagePoint(world, vvViewportRef.current, { allowOutside: true });
      if (!imgPt) return;

      if (queuePolyImg && queueEditEnabled) {
        for (let i = 0; i < 4; i++) {
          const dx = imgPt.x - queuePolyImg[i].x;
          const dy = imgPt.y - queuePolyImg[i].y;
          if (dx * dx + dy * dy <= VERTEX_HIT_PX * VERTEX_HIT_PX) {
            setDraggingVertex({ which: "queue", index: i });
            return true;
          }
        }
      }
      if (servicePolyImg && serviceEditEnabled) {
        for (let i = 0; i < 4; i++) {
          const dx = imgPt.x - servicePolyImg[i].x;
          const dy = imgPt.y - servicePolyImg[i].y;
          if (dx * dx + dy * dy <= VERTEX_HIT_PX * VERTEX_HIT_PX) {
            setDraggingVertex({ which: "service", index: i });
            return true;
          }
        }
      }
    },
    [queueEditEnabled, queuePolyImg, serviceEditEnabled, servicePolyImg],
  );

  const onMoveWorld = useCallback(
    (world: Pt) => {
      if (!draggingVertex) return;
      const imgPt = worldToImagePoint(world, vvViewportRef.current, { allowOutside: true });
      if (!imgPt) return;
      if (draggingVertex.which === "queue") {
        setQueuePolyImg((q) => {
          if (!q) return q;
          const next = [...q];
          next[draggingVertex.index] = imgPt;
          return next;
        });
      } else {
        setServicePolyImg((q) => {
          if (!q) return q;
          const next = [...q];
          next[draggingVertex.index] = imgPt;
          return next;
        });
      }
    },
    [draggingVertex],
  );

  const onPointerUpWorld = useCallback(() => {
    setDraggingVertex(null);
  }, []);

  const saveRois = useCallback(async () => {
    if (selectedFloorPlanId == null || vvId == null || !queuePolyImg || !servicePolyImg || !selectedCameraOpt || selectedCameraOpt.kind !== "virtual")
      return;
    const ow = Math.max(1, selectedCameraOpt.view.out_w || 1);
    const oh = Math.max(1, selectedCameraOpt.view.out_h || 1);
    const res = await fetch(`${API_BASE}/api/queue-wait/rois/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        floor_plan_id: selectedFloorPlanId,
        virtual_view_id: vvId,
        queue_quad: imgToUvQuad(queuePolyImg, ow, oh),
        service_quad: imgToUvQuad(servicePolyImg, ow, oh),
      }),
    });
    if (!res.ok) {
      setDrawHint("保存失败，请检查网络或后端日志。");
      return;
    }
    setQueueEditEnabled(false);
    setServiceEditEnabled(false);
    setQueueTool("none");
    setServiceTool("none");
    setQueueQuadPoints([]);
    setServiceQuadPoints([]);
    setDraggingVertex(null);
    setDrawHint(analyzing ? "已保存；分析中的判定与画面 ROI 已切换为当前形状。排队区/服务区已退出编辑。" : "已保存到服务器，排队区/服务区已退出编辑。");
  }, [analyzing, imgToUvQuad, queuePolyImg, selectedCameraOpt, selectedFloorPlanId, servicePolyImg, vvId]);

  const startAnalysis = useCallback(async () => {
    if (selectedFloorPlanId == null || vvId == null) return;
    const r = await fetch(`${API_BASE}/api/queue-wait/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floor_plan_id: selectedFloorPlanId, virtual_view_id: vvId }),
    });
    if (r.ok) {
      setQueueEditEnabled(false);
      setServiceEditEnabled(false);
      setQueueTool("none");
      setServiceTool("none");
      setQueueQuadPoints([]);
      setServiceQuadPoints([]);
      setDraggingVertex(null);
      setAnalyzing(true);
      setMjpegStreamEpoch((e) => e + 1);
    }
  }, [selectedFloorPlanId, vvId]);

  const stopAnalysis = useCallback(async () => {
    if (selectedFloorPlanId == null || vvId == null) return;
    await fetch(
      `${API_BASE}/api/queue-wait/stop?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
      { method: "POST" },
    );
    setAnalyzing(false);
    setMjpegStreamEpoch((e) => e + 1);
  }, [selectedFloorPlanId, vvId]);

  const clearSavedRois = useCallback(async () => {
    if (selectedFloorPlanId == null || vvId == null || selectedCameraOpt?.kind !== "virtual") return;
    const warnRun = analyzing ? "当前正在分析，将先停止分析。\n\n" : "";
    if (
      !window.confirm(
        `${warnRun}将删除服务器上本虚拟视窗已保存的排队区/服务区 ROI，并删除与该 ROI 配置绑定的全部排队时长历史记录（不可恢复）。确定清理？`,
      )
    )
      return;
    setClearingRoi(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/queue-wait/rois?floor_plan_id=${selectedFloorPlanId}&virtual_view_id=${vvId}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        deleted_config?: boolean;
        deleted_visits?: number;
      };
      if (!res.ok) {
        setDrawHint(`清理 ROI 失败：${(data as { detail?: string }).detail || res.status}`);
        return;
      }
      setQueuePolyImg(null);
      setServicePolyImg(null);
      setQueueQuadPoints([]);
      setServiceQuadPoints([]);
      setQueueTool("none");
      setServiceTool("none");
      setQueueEditEnabled(false);
      setServiceEditEnabled(false);
      setDraggingVertex(null);
      setAnalyzing(false);
      setMjpegStreamEpoch((e) => e + 1);
      const dc = Boolean(data?.deleted_config);
      const dv = Number(data?.deleted_visits ?? 0);
      setDrawHint(
        dc
          ? `已清理 ROI，并删除 ${dv} 条排队时长记录。请重新绘制并保存后再开始分析。`
          : "服务器上暂无已保存的 ROI，已重置本地画面。",
      );
    } catch {
      setDrawHint("清理 ROI 失败，请稍后重试。");
    } finally {
      setClearingRoi(false);
    }
  }, [analyzing, selectedCameraOpt, selectedFloorPlanId, vvId]);

  const canSave =
    selectedFloorPlanId != null &&
    vvId != null &&
    queuePolyImg != null &&
    servicePolyImg != null &&
    queuePolyImg.length === 4 &&
    servicePolyImg.length === 4;

  const canStart = canSave;

  const canClearSavedRoi =
    selectedFloorPlanId != null && vvId != null && selectedCameraOpt?.kind === "virtual";

  const renderCamOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, info: { w: number; h: number; pan: { x: number; y: number }; zoom: number }) => {
      if (!selectedCameraOpt || selectedCameraOpt.kind !== "virtual") return;
      const aspectW = Math.max(1, selectedCameraOpt.view.out_w || 1);
      const aspectH = Math.max(1, selectedCameraOpt.view.out_h || 1);
      vvViewportRef.current = { w: info.w, h: info.h, aspectW, aspectH };

      const { w, h, pan, zoom } = info;
      const scale = Math.min(w / aspectW, h / aspectH);
      const imgW = aspectW * scale;
      const imgH = aspectH * scale;
      const imgX = (w - imgW) / 2;
      const imgY = (h - imgH) / 2;

      const toScreen = (pt: Pt): Pt => ({
        x: imgX + (pt.x / aspectW) * imgW,
        y: imgY + (pt.y / aspectH) * imgH,
      });

      const drawPolylineOrPoly = (
        pts: Pt[],
        stroke: string,
        fill: string | null,
        closed: boolean,
        pulse01 = 0,
      ) => {
        if (!pts.length) return;
        ctx.beginPath();
        const p0 = toScreen(pts[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const p = toScreen(pts[i]);
          ctx.lineTo(p.x, p.y);
        }
        if (closed && pts.length === 4) ctx.closePath();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (closed && fill) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        if (closed && pulse01 > 0.02 && pts.length === 4) {
          ctx.save();
          ctx.shadowColor = stroke;
          ctx.shadowBlur = 20 * pulse01;
          ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.45 * pulse01})`;
          ctx.lineWidth = 2 + 12 * pulse01;
          ctx.beginPath();
          const a0 = toScreen(pts[0]);
          ctx.moveTo(a0.x, a0.y);
          for (let i = 1; i < pts.length; i++) {
            const a = toScreen(pts[i]);
            ctx.lineTo(a.x, a.y);
          }
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
      };

      const drawVertices = (pts: Pt[], color: string) => {
        for (let i = 0; i < pts.length; i++) {
          const p = toScreen(pts[i]);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "white";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      };

      const drawZoneLabel = (pts: Pt[], label: string) => {
        if (pts.length < 4) return;
        let sx = 0;
        let sy = 0;
        for (const p of pts) {
          sx += p.x;
          sy += p.y;
        }
        sx /= pts.length;
        sy /= pts.length;
        const c = toScreen({ x: sx, y: sy });
        ctx.font = "bold 13px system-ui,sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const m = ctx.measureText(label);
        const tw = m.width;
        const th = 16;
        const padX = 8;
        const padY = 5;
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.fillRect(c.x - tw / 2 - padX, c.y - th / 2 - padY, tw + padX * 2, th + padY * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, c.x, c.y);
      };

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);

      const qPulse = zonePulseRef.current.queue;
      const sPulse = zonePulseRef.current.service;

      const qPts = queuePolyImg ? queuePolyImg : queueQuadPoints;
      if (qPts.length > 0) {
        const closed = !!(queuePolyImg && queuePolyImg.length === 4);
        drawPolylineOrPoly(
          qPts,
          "rgba(34,211,238,0.95)",
          closed ? "rgba(34,211,238,0.12)" : null,
          closed,
          closed ? qPulse : 0,
        );
        if (queueEditEnabled && queuePolyImg && queuePolyImg.length === 4) {
          drawVertices(queuePolyImg, "rgba(34,211,238,1)");
        }
        if (closed && queuePolyImg && queuePolyImg.length === 4) {
          drawZoneLabel(queuePolyImg, "Queue");
        }
      }

      const sPts = servicePolyImg ? servicePolyImg : serviceQuadPoints;
      if (sPts.length > 0) {
        const closed = !!(servicePolyImg && servicePolyImg.length === 4);
        drawPolylineOrPoly(
          sPts,
          "rgba(249,115,22,0.95)",
          closed ? "rgba(249,115,22,0.10)" : null,
          closed,
          closed ? sPulse : 0,
        );
        if (serviceEditEnabled && servicePolyImg && servicePolyImg.length === 4) {
          drawVertices(servicePolyImg, "rgba(249,115,22,1)");
        }
        if (closed && servicePolyImg && servicePolyImg.length === 4) {
          drawZoneLabel(servicePolyImg, "Service");
        }
      }

      ctx.restore();
    },
    [
      queuePolyImg,
      queueQuadPoints,
      queueEditEnabled,
      servicePolyImg,
      serviceQuadPoints,
      serviceEditEnabled,
      selectedCameraOpt,
    ],
  );

  const panZoomMode = queueTool === "quad" || serviceTool === "quad" ? "draw" : "panzoom";

  const toggleQueueDraw = useCallback(() => {
    if (queuePolyImg) {
      setQueueEditEnabled((v) => {
        const next = !v;
        setDrawHint(next ? "排队区：拖动青色顶点微调。" : "排队区顶点编辑已关闭。");
        return next;
      });
      setQueueTool("none");
      setQueueQuadPoints([]);
      return;
    }
    setQueueEditEnabled(true);
    setQueueTool((t) => (t === "quad" ? "none" : "quad"));
    setQueueQuadPoints([]);
    setServiceTool("none");
    setServiceQuadPoints([]);
    setDrawHint("排队区：在画面上依次点击 4 次（与热力图映射网格四边形相同）。");
  }, [queuePolyImg]);

  const toggleServiceDraw = useCallback(() => {
    if (servicePolyImg) {
      setServiceEditEnabled((v) => {
        const next = !v;
        setDrawHint(next ? "服务区：拖动橙色顶点微调。" : "服务区顶点编辑已关闭。");
        return next;
      });
      setServiceTool("none");
      setServiceQuadPoints([]);
      return;
    }
    setServiceEditEnabled(true);
    setServiceTool((t) => (t === "quad" ? "none" : "quad"));
    setServiceQuadPoints([]);
    setQueueTool("none");
    setQueueQuadPoints([]);
    setDrawHint("服务区：在画面上依次点击 4 次。与排队区重叠时，分析以服务区为准。");
  }, [servicePolyImg]);

  return (
    <div className="flex h-[calc(100vh-96px)] min-h-0 flex-col gap-4">
      <h2 className="shrink-0 text-xl font-semibold text-slate-800">排队时长分析</h2>
      <p className="shrink-0 text-xs text-slate-500">
        基于检测轨迹估计单次<strong className="font-medium text-slate-600">排队停留</strong>与<strong className="font-medium text-slate-600">服务时长</strong>
        ，区分<strong className="font-medium text-slate-600">排队后成交</strong>与<strong className="font-medium text-slate-600">弃单</strong>（离排队区而未进入服务闭环），并汇总<strong className="font-medium text-slate-600">整体弃单率</strong>
        及各时间粒度下的<strong className="font-medium text-slate-600">弃单率趋势</strong>
        ；同时可看<strong className="font-medium text-slate-600">完成服务人数</strong>与<strong className="font-medium text-slate-600">排队区拥挤度（估算同时在队）</strong>
        随时间的变化，用于评估高峰、转化与服务效率。
      </p>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(340px,1fr)_minmax(0,2fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800">数据统计</span>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                value={selectedFloorPlanId ?? ""}
                onChange={(e) => setSelectedFloorPlanId(e.target.value ? Number(e.target.value) : null)}
              >
                {floorPlans.map((fp) => (
                  <option key={fp.id} value={fp.id}>
                    {fp.name}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="rounded border border-slate-300 bg-white px-2 py-1"
                value={statsDate}
                disabled={statsMode === "realtime"}
                onChange={(e) => {
                  setStatsDate(e.target.value || toUTCDateInputValue(new Date()));
                  setStatsMode("date");
                }}
              />
              <label className="flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={statsMode === "realtime"}
                  onChange={(e) => setStatsMode(e.target.checked ? "realtime" : "date")}
                />
                实时数据
              </label>
            </div>
          </div>

          <div className="mb-3 grid shrink-0 grid-cols-3 gap-2">
            <div className="rounded border border-cyan-200 bg-cyan-50 p-2">
              <div className="text-[11px] text-cyan-900">{statsTitleDate} 平均排队（秒）</div>
              <RollingNumber
                value={Math.round(Number(statsData.avgQueueSeconds) || 0)}
                className="text-lg font-semibold text-cyan-800"
              />
            </div>
            <div className="rounded border border-orange-200 bg-orange-50 p-2">
              <div className="text-[11px] text-orange-900">{statsTitleDate} 平均服务（秒）</div>
              <RollingNumber
                value={Math.round(Number(statsData.avgServiceSeconds) || 0)}
                className="text-lg font-semibold text-orange-800"
              />
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-600">完成笔数</div>
              <RollingNumber
                value={statsData.queuedThenServedCount}
                className="text-lg font-semibold text-slate-800"
              />
              <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
                完成服务笔数：含排队后成交，以及直进服务区且服务时长达系统设置阈值
              </div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-600">含服务时长样本</div>
              <RollingNumber
                value={statsData.serviceSampleCount}
                className="text-lg font-semibold text-slate-800"
              />
            </div>
            <div className="rounded border border-rose-200 bg-rose-50 p-2">
              <div className="text-[11px] text-rose-900">弃单（离排队区未进服务区）</div>
              <RollingNumber value={statsData.abandonCount} className="text-lg font-semibold text-rose-800" />
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-600">整体弃单率（排队意向样本）</div>
              <div className="flex flex-wrap items-baseline gap-0.5 text-lg font-semibold text-slate-800">
                <RollingNumber
                  value={Math.round(Number(statsData.abandonRatePercent) || 0)}
                  className="tabular-nums"
                />
                <span>%</span>
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  {(statsData.abandonCount + statsData.queuedThenServedCount) === 0
                    ? "（无排队意向样本）"
                    : `= ${statsData.abandonCount} / (${statsData.abandonCount} + ${statsData.queuedThenServedCount})`}
                </span>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-800">
                  平均排队时长 · {statsTitleDate} · {TREND_GRAN_LABEL[trendGranQueue]}
                </div>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                  value={trendGranQueue}
                  onChange={(e) => setTrendGranQueue(e.target.value as TrendGranularity)}
                >
                  <option value="1h">按小时</option>
                  <option value="30m">按30分钟</option>
                  <option value="1m">按1分钟</option>
                </select>
              </div>
              <div className="min-h-0 flex-1">
                <FlexHeightReactECharts option={trendQueueOption} />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-800">
                  平均服务时长 · {statsTitleDate} · {TREND_GRAN_LABEL[trendGranService]}
                </div>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                  value={trendGranService}
                  onChange={(e) => setTrendGranService(e.target.value as TrendGranularity)}
                >
                  <option value="1h">按小时</option>
                  <option value="30m">按30分钟</option>
                  <option value="1m">按1分钟</option>
                </select>
              </div>
              <div className="min-h-0 flex-1">
                <FlexHeightReactECharts option={trendServiceOption} />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-800">
                  客流趋势 · {statsTitleDate} · {TREND_GRAN_LABEL[trendGranFootfall]}
                </div>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                  value={trendGranFootfall}
                  onChange={(e) => setTrendGranFootfall(e.target.value as TrendGranularity)}
                >
                  <option value="1h">按小时</option>
                  <option value="30m">按30分钟</option>
                  <option value="1m">按1分钟</option>
                </select>
              </div>
              <div className="mb-1.5 shrink-0 text-[10px] leading-snug text-slate-500">
                柱：各时间桶内<strong className="font-medium text-slate-600">完成服务</strong>人数（按 end_ts）；橙线：排队区
                <strong className="font-medium text-slate-600">估算平均同时在队人数</strong>
                {trendGranFootfall === "1h" && "（桶内每分钟采样平均）。"}
                {trendGranFootfall === "30m" && "（桶内每分钟采样，共 30 次取平均）。"}
                {trendGranFootfall === "1m" && "（每桶在中点采样 1 次）。"}
              </div>
              <div className="min-h-0 flex-1">
                <FlexHeightReactECharts option={footTrafficTrendOption} />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-800">
                  弃单率统计 · {statsTitleDate} · {TREND_GRAN_LABEL[trendGranAbandon]}
                </div>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                  value={trendGranAbandon}
                  onChange={(e) => setTrendGranAbandon(e.target.value as TrendGranularity)}
                >
                  <option value="1h">按小时</option>
                  <option value="30m">按30分钟</option>
                  <option value="1m">按1分钟</option>
                </select>
              </div>
              <div className="mb-1.5 shrink-0 text-[10px] leading-snug text-slate-500">
                弃单：曾排队、未记录服务时长。折线为各时间桶内<strong className="font-medium text-slate-600">弃单率</strong>
                = 桶内弃单 ÷（桶内弃单 + 桶内排队后成交），按 <strong className="font-medium text-slate-600">end_ts</strong> 入桶。
              </div>
              <div className="min-h-0 flex-1">
                <FlexHeightReactECharts option={abandonRateTrendOption} />
              </div>
            </div>
          </div>

        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800">监控画面</span>
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              value={bindCameraId}
              onChange={(e) => {
                userPickedBindRef.current = true;
                setBindCameraId(e.target.value);
              }}
            >
              {bindCameraOptions.map((it) => (
                <option key={it.key} value={it.key}>
                  {it.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                queueTool === "quad" || (queuePolyImg && queueEditEnabled)
                  ? "bg-cyan-600 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
              disabled={analyzing}
              onClick={() => void toggleQueueDraw()}
              title={
                analyzing
                  ? "分析进行中，无法开启排队区编辑"
                  : queuePolyImg
                    ? "开关排队区顶点编辑"
                    : "点击 4 次绘制排队区四边形"
              }
            >
              {queuePolyImg ? (queueEditEnabled ? "排队区·编辑顶点" : "排队区·显示") : "绘制排队区"}
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                serviceTool === "quad" || (servicePolyImg && serviceEditEnabled)
                  ? "bg-orange-600 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
              disabled={analyzing}
              onClick={() => void toggleServiceDraw()}
              title={
                analyzing
                  ? "分析进行中，无法开启服务区编辑"
                  : servicePolyImg
                    ? "开关服务区顶点编辑"
                    : "点击 4 次绘制服务区四边形"
              }
            >
              {servicePolyImg ? (serviceEditEnabled ? "服务区·编辑顶点" : "服务区·显示") : "绘制服务区"}
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 disabled:opacity-50"
              disabled={!canSave}
              onClick={() => void saveRois()}
            >
              保存 ROI
            </button>
            <button
              type="button"
              className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50"
              disabled={!canClearSavedRoi || clearingRoi}
              title="删除服务器上的 ROI 与关联的排队时长落地记录；若正在分析会先停止"
              onClick={() => void clearSavedRois()}
            >
              {clearingRoi ? "清理中…" : "清理 ROI"}
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 text-xs font-medium text-white ${analyzing ? "bg-rose-500 hover:bg-rose-600" : "bg-[#694FF9] hover:bg-[#5b3ff6]"} disabled:opacity-50`}
              disabled={analyzing ? false : !canStart}
              onClick={() => {
                if (analyzing) void stopAnalysis();
                else void startAnalysis();
              }}
              title={!canStart ? "需要虚拟视图并已保存两种 ROI" : ""}
            >
              {analyzing ? "停止分析" : "开始分析"}
            </button>
          </div>
          <div className="mb-2 text-[11px] text-amber-800">{drawHint}</div>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {selectedCameraOpt?.kind === "virtual" ? (
              <PanZoomViewport
                className="h-full w-full"
                mode={panZoomMode}
                onClickWorld={onClickWorld}
                onPointerDownWorld={onPointerDownWorld}
                onMoveWorld={onMoveWorld}
                onPointerUpWorld={onPointerUpWorld}
                renderOverlay={renderCamOverlay}
                redrawSignal={overlayRedrawTick}
              >
                <VirtualViewMjpeg
                  mjpegUrl={`${API_BASE}/api/cameras/${selectedCameraOpt.view.camera_id}/virtual-views/${
                    selectedCameraOpt.view.id
                  }/${analyzing ? "analyzed" : "preview_shared"}.mjpeg?stream=${mjpegStreamEpoch}`}
                  title={`queue-vv-${selectedCameraOpt.view.id}`}
                  frameW={Math.max(1, Number(selectedCameraOpt.view.out_w) || 960)}
                  frameH={Math.max(1, Number(selectedCameraOpt.view.out_h) || 540)}
                  epoch={mjpegStreamEpoch}
                />
              </PanZoomViewport>
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-500">
                请选择带 YOLO 标注的<strong className="mx-1">虚拟视窗</strong>；原始摄像头流无法叠加排队分析。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default QueueWaitAnalysisView;
