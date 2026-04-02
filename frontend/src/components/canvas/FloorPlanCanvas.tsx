import React, { useCallback, useEffect, useRef, useState } from "react";
import { POI_ICON_URL } from "../../shared/config";
import { preloadFloorPlanImage, preloadPoiIcon } from "../../shared/floorPlan";

function collectCellsInImageRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rows: number,
  cols: number,
  iw: number,
  ih: number,
): { row: number; col: number }[] {
  const rx1 = Math.min(ax, bx);
  const rx2 = Math.max(ax, bx);
  const ry1 = Math.min(ay, by);
  const ry2 = Math.max(ay, by);
  const out: { row: number; col: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx1 = (c / cols) * iw;
      const cx2 = ((c + 1) / cols) * iw;
      const cy1 = (r / rows) * ih;
      const cy2 = ((r + 1) / rows) * ih;
      if (cx2 < rx1 || cx1 > rx2 || cy2 < ry1 || cy1 > ry2) continue;
      out.push({ row: r, col: c });
    }
  }
  return out;
}

export type FloorPlanCanvasProps = {
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
  /** 人流量判定线（归一化 UV 0–1，与底图同一 pan/zoom 变换） */
  footfallLineUV?: {
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    inLabel: string;
    outLabel: string;
  } | null;
  /** Shift+左键起点（未绑定格）→ 再单击结束：框选与坐标轴对齐的矩形区域内的格子 */
  shiftMarqueeSelect?: boolean;
  onShiftMarqueeComplete?: (cells: { row: number; col: number }[]) => void;
  /** 多格高亮（例如框选结果），key 为 `row,col` */
  multiHighlightCells?: Set<string>;
  /** 变化时取消未完成的 Shift 框选 */
  marqueeCancelKey?: number | string;
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
    footfallLineUV = null,
    shiftMarqueeSelect = false,
    onShiftMarqueeComplete,
    multiHighlightCells,
    marqueeCancelKey,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skipNextClickRef = useRef(false);
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
  const [marqueeAnchor, setMarqueeAnchor] = useState<{ x: number; y: number } | null>(null);
  const [marqueeHover, setMarqueeHover] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    preloadFloorPlanImage(imageUrl)
      .then((img) => {
        if (cancelled) return;
        imageRef.current = img;
        setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch(() => {});
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

  useEffect(() => {
    setMarqueeAnchor(null);
    setMarqueeHover(null);
  }, [marqueeCancelKey]);

  useEffect(() => {
    if (!shiftMarqueeSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMarqueeAnchor(null);
        setMarqueeHover(null);
        skipNextClickRef.current = false;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shiftMarqueeSelect]);

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

    if ((cellFillColors && cellFillColors.size > 0) || (mappedCells && mappedCells.size > 0)) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      ctx.lineWidth = 1.5 / fitScale;
      const keys = cellFillColors && cellFillColors.size > 0 ? Array.from(cellFillColors.keys()) : mappedCells ? Array.from(mappedCells) : [];
      keys.forEach((key) => {
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c) || r < 0 || r >= rows || c < 0 || c >= cols) return;
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

    if (multiHighlightCells && multiHighlightCells.size > 0) {
      const cellW = iw / cols;
      const cellH = ih / rows;
      multiHighlightCells.forEach((key) => {
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c) || r < 0 || r >= rows || c < 0 || c >= cols) return;
        if (sel != null && sel.row === r && sel.col === c) return;
        const x = c * cellW;
        const y = r * cellH;
        ctx.fillStyle = "rgba(59,130,246,0.14)";
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = "rgba(37,99,235,0.55)";
        ctx.lineWidth = 1.2 / fitScale;
        ctx.strokeRect(x, y, cellW, cellH);
      });
    }

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

    if (marqueeAnchor && marqueeHover && shiftMarqueeSelect) {
      const x1 = Math.min(marqueeAnchor.x, marqueeHover.x);
      const y1 = Math.min(marqueeAnchor.y, marqueeHover.y);
      const w = Math.abs(marqueeHover.x - marqueeAnchor.x);
      const h = Math.abs(marqueeHover.y - marqueeAnchor.y);
      ctx.setLineDash([6 / fitScale, 4 / fitScale]);
      ctx.strokeStyle = "rgba(105,79,249,0.95)";
      ctx.lineWidth = 2 / fitScale;
      ctx.fillStyle = "rgba(105,79,249,0.08)";
      ctx.fillRect(x1, y1, w, h);
      ctx.strokeRect(x1, y1, w, h);
      ctx.setLineDash([]);
    }

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
      const stopsGreenRed: [number, number, number][] = [[187, 247, 208], [34, 197, 94], [249, 115, 22], [239, 68, 68]];
      const stopsViridis: [number, number, number][] = [[68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
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
        if (Number.isNaN(r) || Number.isNaN(c) || r < 0 || r >= rows || c < 0 || c >= cols) return;
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
      };
      poiCells.forEach((count, key) => {
        const [rs, cs] = key.split(",");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isNaN(r) || Number.isNaN(c) || r < 0 || r >= rows || c < 0 || c >= cols) return;
        const x = c * cellW;
        const y = r * cellH;
        const cx = x + cellW / 2;
        const cy = y + cellH / 2;
        const iconH = Math.max(24, cellH * 3);
        if (icon && icon.naturalWidth > 0 && icon.naturalHeight > 0) {
          const s = iconH / icon.naturalHeight;
          const iconW = icon.naturalWidth * s;
          const footOffset = 16 * s;
          ctx.drawImage(icon, cx - iconW / 2, cy - (iconH - footOffset), iconW, iconH);
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
              const s = uniq.length <= 3 ? `t:${uniq.join(",")}` : `t:${uniq.slice(0, 3).join(",")}+${uniq.length - 3}`;
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

    if (linkedHoverCell != null && linkedHoverCell.row >= 0 && linkedHoverCell.row < rows && linkedHoverCell.col >= 0 && linkedHoverCell.col < cols) {
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

    if (footfallLineUV) {
      const { p1, p2, inLabel, outLabel } = footfallLineUV;
      const ix1 = p1.x * iw;
      const iy1 = p1.y * ih;
      const ix2 = p2.x * iw;
      const iy2 = p2.y * ih;
      const mx = (ix1 + ix2) / 2;
      const my = (iy1 + iy2) / 2;
      ctx.beginPath();
      ctx.moveTo(ix1, iy1);
      ctx.lineTo(ix2, iy2);
      ctx.strokeStyle = "rgba(15,23,42,0.35)";
      ctx.lineWidth = 5 / fitScale;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ix1, iy1);
      ctx.lineTo(ix2, iy2);
      ctx.strokeStyle = "#0EA5E9";
      ctx.lineWidth = 3 / fitScale;
      ctx.stroke();
      const dotR = 5.5 / fitScale;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#0EA5E9";
      ctx.lineWidth = 2 / fitScale;
      ctx.beginPath();
      ctx.arc(ix1, iy1, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ix2, iy2, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const fontPx = 11 / fitScale;
      ctx.font = `600 ${fontPx}px sans-serif`;
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(inLabel, mx, my - 14 / fitScale);
      ctx.fillText(outLabel, mx, my + 22 / fitScale);
    }

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
      ctx.fillText(`行${hoverCell.row} 列${hoverCell.col}`, x + cellW / 2, y + cellH / 2);
      ctx.restore();
      return;
    }
    ctx.restore();
  }, [
    pan,
    zoom,
    hoverCell,
    linkedHoverCell,
    sel,
    showGrid,
    gridRows,
    gridCols,
    imgSize,
    canvasSize,
    poiIconReadyTick,
    heatmapCells,
    poiCells,
    poiTrackIds,
    showPoiTrackIds,
    heatmapRender,
    cellFillColors,
    backgroundColor,
    mappedCells,
    footfallLineUV,
    multiHighlightCells,
    marqueeAnchor,
    marqueeHover,
    shiftMarqueeSelect,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

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
      return { x: lx / fitScale, y: ly / fitScale };
    },
    [pan, zoom, canvasSize, imgSize],
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
    [canvasToImage, gridRows, gridCols, imgSize],
  );

  const onWheelNative = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!imgSize || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const cx = (cssX * canvasSize.w) / Math.max(1, rect.width);
      const cy = (cssY * canvasSize.h) / Math.max(1, rect.height);
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
        const baseX = offsetX + fitScale * imgX;
        const baseY = offsetY + fitScale * imgY;
        setPan({ x: cx - newZoom * baseX, y: cy - newZoom * baseY });
        return newZoom;
      });
    },
    [imgSize, canvasSize, canvasToImage],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [onWheelNative]);

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !imgSize) return;
    const cx = (e.clientX - rect.left) * (canvasRef.current.width / Math.max(1, rect.width));
    const cy = (e.clientY - rect.top) * (canvasRef.current.height / Math.max(1, rect.height));

    if (shiftMarqueeSelect && e.shiftKey && marqueeAnchor === null) {
      const cell = getCellAt(cx, cy);
      if (!cell || mappedCells?.has(`${cell.row},${cell.col}`)) return;
      const imgPt = canvasToImage(cx, cy);
      setMarqueeAnchor(imgPt);
      setMarqueeHover(imgPt);
      skipNextClickRef.current = true;
      return;
    }

    if (marqueeAnchor !== null) {
      return;
    }

    setDragging(true);
    setHoverCell(null);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (e.clientX - rect.left) * (canvasRef.current!.width / Math.max(1, rect.width));
    const cy = (e.clientY - rect.top) * (canvasRef.current!.height / Math.max(1, rect.height));
    if (marqueeAnchor !== null && shiftMarqueeSelect) {
      setMarqueeHover(canvasToImage(cx, cy));
    }
    if (dragging) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    } else {
      setHoverCell(getCellAt(cx, cy));
    }
  };
  const onMouseUp = () => setDragging(false);
  const onMouseLeave = () => setHoverCell(null);

  useEffect(() => {
    onCellHover?.(hoverCell);
  }, [hoverCell, onCellHover]);

  const onClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !imgSize) return;
    const cx = (e.clientX - rect.left) * (canvasRef.current.width / Math.max(1, rect.width));
    const cy = (e.clientY - rect.top) * (canvasRef.current.height / Math.max(1, rect.height));

    if (skipNextClickRef.current) {
      skipNextClickRef.current = false;
      return;
    }

    if (marqueeAnchor !== null && shiftMarqueeSelect) {
      const end = canvasToImage(cx, cy);
      const rows = Math.max(1, gridRows);
      const cols = Math.max(1, gridCols);
      const iw = imgSize.w;
      const ih = imgSize.h;
      const cells = collectCellsInImageRect(marqueeAnchor.x, marqueeAnchor.y, end.x, end.y, rows, cols, iw, ih);
      onShiftMarqueeComplete?.(cells);
      setMarqueeAnchor(null);
      setMarqueeHover(null);
      return;
    }

    if (!onCellClick) return;
    const cell = getCellAt(cx, cy);
    onCellClick(cell);
  };

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 ${className}`}
      style={{ height: "100%", minHeight: 0, userSelect: "none", overscrollBehavior: "contain" }}
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
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-white/80 px-2 py-0.5 text-[11px] text-slate-700">
        zoom {zoom.toFixed(2)}
      </div>
    </div>
  );
};

export default FloorPlanCanvas;
