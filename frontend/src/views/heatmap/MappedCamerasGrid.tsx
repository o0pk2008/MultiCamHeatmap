import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../../shared/config";
import { applyHomography, computeHomography, orderQuad } from "../../shared/geometry";
import { CameraVirtualView, Footfall, HeatmapSource, Pt } from "../../shared/types";

const VirtualViewGridOverlay: React.FC<{
  view: CameraVirtualView;
  cfg: { polygon: Pt[]; grid_rows: number; grid_cols: number };
  highlightCells?: Footfall[] | null;
}> = ({ view, cfg, highlightCells = null }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
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
    const quadScreen = cfg.polygon.map((p) => ({ x: offX + p.x * scale, y: offY + p.y * scale }));
    const H = computeHomography(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      quadScreen,
    );
    if (!H) return;
    const rows = Math.max(1, cfg.grid_rows);
    const cols = Math.max(1, cfg.grid_cols);

    const now = Date.now();
    const list: Footfall[] = Array.isArray(hcAny) ? hcAny : [];
    const fresh = list
      .map((p) => ({ row: Number(p?.row), col: Number(p?.col), ts: Number(p?.ts) }))
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

    ctx.strokeStyle = "rgba(14,165,233,1.0)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(quadScreen[0].x, quadScreen[0].y);
    ctx.lineTo(quadScreen[1].x, quadScreen[1].y);
    ctx.lineTo(quadScreen[2].x, quadScreen[2].y);
    ctx.lineTo(quadScreen[3].x, quadScreen[3].y);
    ctx.closePath();
    ctx.stroke();

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

/** 主宫格 MJPEG：分批发起连接，减轻首屏争用；每批路数与批次间隔 */
const MJPEG_STAGGER_BATCH = 2;
const MJPEG_STAGGER_INTERVAL_MS = 300;

/**
 * 热力图宫格 MJPEG：SPA 内切换 analyzed 时需「短时卸载 + iframe」断干净旧 multipart 连接（用 img 易再黑屏）。
 * iframe 内联文档易出滚动条：按 virtual view 的 out_w/out_h 与槽位尺寸算 scale，等价 object-contain。
 */
const MJPEG_SWAP_UNMOUNT_MS = 160;

const HeatmapSlotMjpeg: React.FC<{
  staggerAllowed: boolean;
  mjpegUrl: string;
  imgKey: string;
  alt: string;
  frameW: number;
  frameH: number;
  gridOverlay: React.ReactNode;
}> = ({ staggerAllowed, mjpegUrl, imgKey, alt, frameW, frameH, gridOverlay }) => {
  const [streamVisible, setStreamVisible] = useState(false);
  const firstUrlForSlotRef = useRef(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!staggerAllowed) {
      setStreamVisible(false);
      return;
    }
    if (firstUrlForSlotRef.current) {
      firstUrlForSlotRef.current = false;
      setStreamVisible(true);
      return;
    }
    setStreamVisible(false);
    const t = window.setTimeout(() => setStreamVisible(true), MJPEG_SWAP_UNMOUNT_MS);
    return () => window.clearTimeout(t);
  }, [staggerAllowed, mjpegUrl]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || !streamVisible) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height });
  }, [streamVisible, imgKey]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !streamVisible) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setBox({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [streamVisible]);

  const iw = Math.max(1, frameW);
  const ih = Math.max(1, frameH);
  const scale =
    box.w > 0 && box.h > 0 ? Math.min(box.w / iw, box.h / ih) : 1;

  if (!staggerAllowed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">加载中...</div>
    );
  }
  if (!streamVisible) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">加载中...</div>
    );
  }
  return (
    <div ref={wrapRef} className="relative h-full w-full min-h-0 overflow-hidden bg-black">
      <iframe
        key={imgKey}
        src={mjpegUrl}
        title={alt}
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
      {gridOverlay}
    </div>
  );
};

const MappedCamerasGrid: React.FC<{
  sources: HeatmapSource[];
  analyzing: boolean;
  vvFootfalls: Record<number, Footfall[]>;
  /** 递增则强制换 MJPEG URL/重建 img，避免 SPA 内切换 analyzed 时沿用旧长连接导致无画面 */
  mjpegStreamEpoch?: number;
}> = ({ sources, analyzing, vvFootfalls, mjpegStreamEpoch = 0 }) => {
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

  const pinnedSlotsKey = useMemo(() => pinnedSlots.join("\0"), [pinnedSlots]);
  const [mjpegStaggerWave, setMjpegStaggerWave] = useState(0);
  const mjpegStaggerTimersRef = useRef<number[]>([]);

  useEffect(() => {
    mjpegStaggerTimersRef.current.forEach((id) => window.clearTimeout(id));
    mjpegStaggerTimersRef.current = [];
    setMjpegStaggerWave(0);
    const extraWaves = Math.max(0, Math.ceil(slotCount / MJPEG_STAGGER_BATCH) - 1);
    for (let b = 1; b <= extraWaves; b++) {
      const tid = window.setTimeout(() => {
        setMjpegStaggerWave(b);
      }, b * MJPEG_STAGGER_INTERVAL_MS);
      mjpegStaggerTimersRef.current.push(tid);
    }
    return () => {
      mjpegStaggerTimersRef.current.forEach((id) => window.clearTimeout(id));
      mjpegStaggerTimersRef.current = [];
    };
  }, [pinnedSlotsKey, slotCount]);

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
      if (next.length === old.length && next.every((v, i) => v === old[i])) return old;
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
      if (!res.ok || res.status === 204) return;
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
    const ids = sources.filter((s) => s.kind === "virtual" && !!s.virtual_view_id).map((s) => s.virtual_view_id as number);
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
              pts = raw.map((p) => ({ x: Number(p.x), y: Number(p.y) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
            }
          } catch {}
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
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">监控画面</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input type="checkbox" checked={showMappedCamGrid} onChange={(e) => setShowMappedCamGrid(e.target.checked)} />
            映射网格
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-600">
            <input type="checkbox" checked={showFootfallOnCamGrid} onChange={(e) => setShowFootfallOnCamGrid(e.target.checked)} disabled={!analyzing} />
            落点分布
          </label>
          <span className="text-[11px] text-slate-400">用于检查映射坐标</span>
        </div>
      </div>
      {sources.length === 0 ? (
        <p className="text-xs text-slate-500">暂无可用监控画面，请先在“设备管理”中添加并启用，后续在“映射管理”中关联到平面图。</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
                    if (fromSlotStr && Number.isFinite(fromSlot) && fromSlot >= 0 && fromSlot < slotCount && fromSlot !== slotIdx) {
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
                >
                  <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                    <span className="truncate">{src ? (src.kind === "virtual" ? `${src.camera_name} / ${src.virtual_view_name}` : src.camera_name) : `槽位 ${slotIdx + 1}`}</span>
                    <span className="text-slate-400">{src ? (src.kind === "virtual" ? `VV:${src.virtual_view_id}` : `ID:${src.camera_id}`) : "拖拽替换"}</span>
                  </div>
                  <div className="aspect-square w-full bg-black">
                    {src ? (
                      src.kind === "virtual" && src.virtual_view_id ? (
                        (() => {
                          const batchIdx = Math.floor(slotIdx / MJPEG_STAGGER_BATCH);
                          const canStartMjpeg = batchIdx <= mjpegStaggerWave;
                          const path = `${API_BASE}/api/cameras/${src.camera_id}/virtual-views/${src.virtual_view_id}/${analyzing ? "analyzed" : "preview_shared"}.mjpeg`;
                          const mjpegUrl = `${path}?stream=${mjpegStreamEpoch}&slot=${slotIdx}`;
                          const vvMeta = vvMetaById.get(src.virtual_view_id);
                          const fw = vvMeta?.out_w || 960;
                          const fh = vvMeta?.out_h || 540;
                          return (
                            <HeatmapSlotMjpeg
                              staggerAllowed={canStartMjpeg}
                              mjpegUrl={mjpegUrl}
                              imgKey={`${key}-${analyzing}-e${mjpegStreamEpoch}-s${slotIdx}`}
                              alt={`heatmap-virtual-${src.virtual_view_id}`}
                              frameW={fw}
                              frameH={fh}
                              gridOverlay={
                                showMappedCamGrid && vvGridConfigs[src.virtual_view_id] && vvMetaById.get(src.virtual_view_id) ? (
                                  <VirtualViewGridOverlay
                                    view={vvMetaById.get(src.virtual_view_id)!}
                                    cfg={vvGridConfigs[src.virtual_view_id]}
                                    highlightCells={showFootfallOnCamGrid ? vvFootfalls[src.virtual_view_id] ?? null : null}
                                  />
                                ) : null
                              }
                            />
                          );
                        })()
                      ) : src.webrtc_url ? (
                        <iframe src={src.webrtc_url} className="h-full w-full border-none" allow="autoplay; fullscreen" title={`heatmap-camera-${src.camera_id}-slot-${slotIdx}`} />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">未配置播放地址</div>
                      )
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">拖拽缩略图到此处</div>
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
                  <select className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]" value={thumbRefreshMs} onChange={(e) => setThumbRefreshMs(Number(e.target.value) || 3000)}>
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
                        <div key={`thumb-${k}`} className="overflow-hidden rounded border border-slate-200 bg-slate-50" draggable onDragStart={(e) => {
                          e.dataTransfer.setData("text/heatmap-source-key", k);
                          e.dataTransfer.effectAllowed = "move";
                        }}>
                          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-slate-700">
                            <span className="truncate">{s.kind === "virtual" ? `${s.camera_name} / ${s.virtual_view_name}` : s.camera_name}</span>
                            <span className="text-slate-400">{s.kind === "virtual" ? `VV:${s.virtual_view_id}` : `ID:${s.camera_id}`}</span>
                          </div>
                          <div className="aspect-square w-full bg-black">
                            {s.kind === "virtual" && vvId ? (
                              snap ? <img src={snap} className="h-full w-full object-contain" alt={`thumb-vv-${vvId}`} draggable={false} /> : <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-200">暂无缩略图</div>
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-200">摄像头预览</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {totalPages > 1 ? (
                    <div className="flex items-center justify-between text-[11px] text-slate-600">
                      <button className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 disabled:opacity-50" disabled={page <= 1} onClick={() => setThumbPage((p) => Math.max(1, p - 1))}>上一页</button>
                      <div>第 {page} / {totalPages} 页</div>
                      <button className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 disabled:opacity-50" disabled={page >= totalPages} onClick={() => setThumbPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
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

export default MappedCamerasGrid;
