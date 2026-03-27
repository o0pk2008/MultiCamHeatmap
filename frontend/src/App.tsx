import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SidebarTabButton from "./components/SidebarTabButton";
import { copyToClipboard } from "./shared/clipboard";
import { API_BASE, MEDIA_HOST, MEDIA_RTSP_PORT, MEDIA_WEBRTC_PORT } from "./shared/config";
import { applyHomography, bilinear, computeHomography, orderQuad, pointInPoly, worldToImagePoint } from "./shared/geometry";
import { floorPlanImageUrl, preloadFloorPlanImage } from "./shared/floorPlan";
import { Camera, CameraVirtualView, FloorPlan, Footfall, HeatmapSource, Pt, ShareRoute, TabKey, VirtualViewCellMapping } from "./shared/types";
import { parseShareRoute } from "./shared/routing";
import RealtimeView from "./views/RealtimeView";
import { ShareHeatmapPage, SharePeoplePage } from "./views/share/SharePages";
import PeoplePositionView from "./views/PeoplePositionView";
import HeatmapViewPage from "./views/HeatmapView";
import MappedCamerasGrid from "./views/heatmap/MappedCamerasGrid";
import FloorPlanCanvas from "./components/canvas/FloorPlanCanvas";
import FootfallAnalysisView from "./views/FootfallAnalysisView";
import SystemSettingsView from "./views/SystemSettingsView";

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("realtime");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
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
    if (shareRoute.kind === "heatmap") {
      return <ShareHeatmapPage params={shareRoute.params} FloorPlanCanvasComponent={FloorPlanCanvas} />;
    }
    return <SharePeoplePage params={shareRoute.params} FloorPlanCanvasComponent={FloorPlanCanvas} />;
  }

  const renderTabIcon = (tab: TabKey) => {
    const cls = "h-4 w-4";
    switch (tab) {
      case "realtime":
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="8.5" cy="10" r="1.4" fill="currentColor" />
            <path d="M7 15l3.2-2.8L13 14.7 16.5 11l2.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        );
      case "heatmap":
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="2" fill="currentColor" />
            <circle cx="16" cy="8" r="3" fill="currentColor" opacity="0.8" />
            <circle cx="10" cy="15" r="3" fill="currentColor" opacity="0.55" />
            <circle cx="17" cy="16" r="2" fill="currentColor" opacity="0.4" />
          </svg>
        );
      case "people":
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="17" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4.5 19c.4-3 2.4-4.5 4.5-4.5h.2c2 0 4.1 1.5 4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M14 19c.3-2.1 1.7-3.1 3.1-3.1h.1c1.4 0 2.8 1 3.1 3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        );
      case "footfall":
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <path d="M5 6v12M19 6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M8 9h8M8 15h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M11 7l-3 2 3 2M13 17l3-2-3-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "mapping":
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        );
      case "settings":
      default:
        return (
          <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
            <path d="M12 8.5A3.5 3.5 0 1 1 12 15.5A3.5 3.5 0 0 1 12 8.5Z" stroke="currentColor" strokeWidth="1.8" />
            <path d="M19.4 13.5a7.8 7.8 0 0 0 .1-1.5 7.8 7.8 0 0 0-.1-1.5l2-1.6-2-3.5-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2h-4l-.4 2.4a7.5 7.5 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.6A7.8 7.8 0 0 0 4.5 12c0 .5 0 1 .1 1.5l-2 1.6 2 3.5 2.4-1a7.5 7.5 0 0 0 2.6 1.5L10 22h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="flex min-h-screen">
        {/* 左侧侧边栏 */}
        <aside
          className={`flex shrink-0 flex-col border-r bg-white py-4 shadow-sm transition-[width] duration-200 ${
            sidebarCollapsed ? "w-20 px-2" : "w-60 px-3"
          }`}
        >
          <div className={`mb-4 flex items-center rounded-xl py-3 ${sidebarCollapsed ? "justify-center px-2" : "gap-3 px-3"}`}>
            <div className="flex h-10 w-10 items-center justify-center">
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
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  Spatial Analytics
                </div>
                <div className="text-[11px] text-slate-500">
                  空间定位分析
                </div>
              </div>
            )}
          </div>

          <nav className="flex-1 space-y-2">
            <SidebarTabButton
              label="实时画面"
              icon={renderTabIcon("realtime")}
              tab="realtime"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="热力图"
              icon={renderTabIcon("heatmap")}
              tab="heatmap"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="人员位置"
              icon={renderTabIcon("people")}
              tab="people"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="人流量分析"
              icon={renderTabIcon("footfall")}
              tab="footfall"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="映射管理"
              icon={renderTabIcon("mapping")}
              tab="mapping"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
            <SidebarTabButton
              label="系统设置"
              icon={renderTabIcon("settings")}
              tab="settings"
              activeTab={activeTab}
              collapsed={sidebarCollapsed}
              onChange={setActiveTab}
            />
          </nav>

          <div className="mt-3 border-t border-slate-200 pt-3">
            <button
              type="button"
              className={`flex w-full items-center rounded-lg border border-slate-200 bg-white py-2 text-sm text-slate-700 transition hover:bg-slate-50 ${sidebarCollapsed ? "justify-center px-2" : "gap-2 px-3"}`}
              onClick={() => setSidebarCollapsed((v) => !v)}
              title={sidebarCollapsed ? "展开菜单" : "收起菜单"}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                {sidebarCollapsed ? (
                  <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
              {!sidebarCollapsed && <span>收起菜单</span>}
            </button>
          </div>
        </aside>

        {/* 右侧内容区 */}
        <main className="flex-1 px-4 py-4">
          {activeTab === "realtime" && <RealtimeView />}
          {activeTab === "heatmap" && (
            <HeatmapViewPage
              FloorPlanCanvasComponent={FloorPlanCanvas}
              MappedCamerasGridComponent={MappedCamerasGrid}
            />
          )}
          {activeTab === "people" && (
            <PeoplePositionView
              FloorPlanCanvasComponent={FloorPlanCanvas}
              MappedCamerasGridComponent={MappedCamerasGrid}
            />
          )}
          {activeTab === "footfall" && (
            <FootfallAnalysisView
              FloorPlanCanvasComponent={FloorPlanCanvas}
              MappedCamerasGridComponent={MappedCamerasGrid}
            />
          )}
          {activeTab === "mapping" && <MappingView />}
          {activeTab === "settings" && <SystemSettingsView />}
        </main>
      </div>
    </div>
  );
};

/** 平面图 Canvas：支持拖拽、缩放、网格叠加与 hover 显示网格编号 */
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
        管理热力图底图（平面图）、监控设备以及它们之间的映射绑定关系。
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
          设备管理
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
                        if (typeof bindFloorPlanId !== "number") return;
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

                <div className="text-[11px] font-semibold text-slate-700">设备绑定列表</div>
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
              <span className="text-sm font-semibold text-slate-800">监控画面选择</span>
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
              <div className="text-sm font-semibold text-slate-800">空间数据映射</div>
            </div>
            <div className="border-b border-slate-200 p-3">
              <div className="text-[11px] text-slate-600">
                <div>
                  映射网格：
                  <span className="ml-1 font-mono text-slate-800">
                    {vpSelectedCell
                      ? `${vpSelectedCell.row * Math.max(1, Number(vpCols) || 1) + vpSelectedCell.col} (${vpSelectedCell.row}-${vpSelectedCell.col})`
                      : "-"}
                  </span>
                </div>
                <div className="mt-1">
                  平面图网格：
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
                  暂无映射关系。先在右侧画面点选一个映射网格，再在左侧点选一个平面图网格，点击“绑定”。
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
  const [pickTarget, setPickTarget] = useState<{ viewId: number; corner: "tl" | "br" } | null>(null);
  const [sourceSizeByView, setSourceSizeByView] = useState<Record<number, { w: number; h: number }>>({});

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
      setViews(
        (data || []).map((v) => ({
          ...v,
          view_mode: v.view_mode || "panorama_perspective",
        })),
      );
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

  useEffect(() => {
    if (!pickTarget) return;
    const v = views.find((x) => x.id === pickTarget.viewId);
    if (!v) {
      setPickTarget(null);
      return;
    }
    if ((v.view_mode || "panorama_perspective") !== "native_resize") {
      setPickTarget(null);
    }
  }, [pickTarget, views]);

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

  const updateCropCorner = useCallback(
    (viewId: number, corner: "tl" | "br", x: number, y: number) => {
      setViews((old) =>
        old.map((it) => {
          if (it.id !== viewId) return it;
          if (corner === "tl") return { ...it, crop_x1: x, crop_y1: y };
          return { ...it, crop_x2: x, crop_y2: y };
        }),
      );
    },
    [],
  );

  const ensureSourceSize = useCallback(
    async (view: CameraVirtualView & { camera_name?: string }) => {
      if (sourceSizeByView[view.id]) return true;
      try {
        const res = await fetch(`${API_BASE}/api/cameras/${view.camera_id}/virtual-views/${view.id}/source-size`);
        if (!res.ok) return false;
        const data = await res.json();
        const w = Number(data?.width);
        const h = Number(data?.height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
        setSourceSizeByView((old) => ({ ...old, [view.id]: { w: Number(w), h: Number(h) } }));
        return true;
      } catch {
        return false;
      }
    },
    [sourceSizeByView],
  );

  const onPickPointFromPreview = useCallback(
    (e: React.MouseEvent<HTMLImageElement>, view: CameraVirtualView & { camera_name?: string }) => {
      if (!pickTarget || pickTarget.viewId !== view.id) return;
      const img = e.currentTarget;
      const rect = img.getBoundingClientRect();
      const boxW = rect.width;
      const boxH = rect.height;
      if (boxW <= 1 || boxH <= 1) return;
      const outW = Math.max(1, Number(view.out_w) || 1);
      const outH = Math.max(1, Number(view.out_h) || 1);
      const scale = Math.min(boxW / outW, boxH / outH);
      const renderW = outW * scale;
      const renderH = outH * scale;
      const offX = (boxW - renderW) / 2;
      const offY = (boxH - renderH) / 2;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const relX = Math.max(0, Math.min(renderW - 1, px - offX));
      const relY = Math.max(0, Math.min(renderH - 1, py - offY));
      const u = renderW > 1 ? relX / (renderW - 1) : 0;
      const v = renderH > 1 ? relY / (renderH - 1) : 0;
      const raw = sourceSizeByView[view.id];
      const rawW = Math.max(1, Number(raw?.w || 1));
      const rawH = Math.max(1, Number(raw?.h || 1));
      const cx1 = Math.max(0, Math.min(rawW - 1, Number(view.crop_x1 ?? 0) || 0));
      const cy1 = Math.max(0, Math.min(rawH - 1, Number(view.crop_y1 ?? 0) || 0));
      const cx2 = Math.max(cx1 + 1, Math.min(rawW, Number(view.crop_x2 ?? rawW) || rawW));
      const cy2 = Math.max(cy1 + 1, Math.min(rawH, Number(view.crop_y2 ?? rawH) || rawH));
      const cropW = Math.max(1, cx2 - cx1);
      const cropH = Math.max(1, cy2 - cy1);
      const srcX = Math.max(0, Math.min(rawW - 1, Math.round(cx1 + u * (cropW - 1))));
      const srcY = Math.max(0, Math.min(rawH - 1, Math.round(cy1 + v * (cropH - 1))));
      updateCropCorner(view.id, pickTarget.corner, srcX, srcY);
      setPickTarget(null);
    },
    [pickTarget, sourceSizeByView, updateCropCorner],
  );

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
          view_mode: "panorama_perspective",
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
        view_mode: v.view_mode || "panorama_perspective",
        yaw_deg: v.yaw_deg,
        pitch_deg: v.pitch_deg,
        fov_deg: v.fov_deg,
        out_w: v.out_w,
        out_h: v.out_h,
        crop_x1: v.crop_x1 ?? null,
        crop_y1: v.crop_y1 ?? null,
        crop_x2: v.crop_x2 ?? null,
        crop_y2: v.crop_y2 ?? null,
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
          说明：支持两种视窗模式：全景透视（yaw/pitch/fov）和原生缩放（适配 PTZ 相机，可设置输出宽高与裁剪区域）。
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
                        className={`h-48 w-full object-contain ${
                          canEdit && pickTarget?.viewId === v.id ? "cursor-crosshair" : ""
                        }`}
                        draggable={false}
                        onClick={(e) => onPickPointFromPreview(e, v)}
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
                          className={`h-48 w-full object-contain ${
                            canEdit && pickTarget?.viewId === v.id ? "cursor-crosshair" : ""
                          }`}
                          draggable={false}
                          onClick={(e) => onPickPointFromPreview(e, v)}
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
                      <label className="col-span-2 text-slate-600">
                        视窗模式
                        <select
                          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
                          value={v.view_mode || "panorama_perspective"}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setViews((old) =>
                              old.map((x) =>
                                x.id === v.id
                                  ? {
                                      ...x,
                                      view_mode:
                                        e.target.value === "native_resize" ? "native_resize" : "panorama_perspective",
                                    }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="panorama_perspective">全景透视（Panorama）</option>
                          <option value="native_resize">原生缩放（PTZ）</option>
                        </select>
                      </label>
                      {(v.view_mode || "panorama_perspective") === "panorama_perspective" ? (
                        <>
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
                        </>
                      ) : null}
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
                      {(v.view_mode || "panorama_perspective") === "native_resize" ? (
                        <>
                          <label className="col-span-2 text-slate-600">
                            裁剪左上坐标 (x1, y1)
                            <div className="mt-0.5 flex gap-1">
                              <input
                                type="number"
                                className="w-1/2 rounded border border-slate-300 px-2 py-1"
                                value={v.crop_x1 ?? ""}
                                disabled={!canEdit}
                                onChange={(e) =>
                                  setViews((old) =>
                                    old.map((x) =>
                                      x.id === v.id ? { ...x, crop_x1: e.target.value === "" ? null : Number(e.target.value) } : x,
                                    ),
                                  )
                                }
                              />
                              <input
                                type="number"
                                className="w-1/2 rounded border border-slate-300 px-2 py-1"
                                value={v.crop_y1 ?? ""}
                                disabled={!canEdit}
                                onChange={(e) =>
                                  setViews((old) =>
                                    old.map((x) =>
                                      x.id === v.id ? { ...x, crop_y1: e.target.value === "" ? null : Number(e.target.value) } : x,
                                    ),
                                  )
                                }
                              />
                              <button
                                type="button"
                                className={`rounded border px-2 py-1 ${
                                  pickTarget?.viewId === v.id && pickTarget.corner === "tl"
                                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                    : "border-slate-300 bg-white text-slate-700"
                                }`}
                                disabled={!canEdit}
                                onClick={() => {
                                  void (async () => {
                                    const nextIsActive = !(pickTarget?.viewId === v.id && pickTarget?.corner === "tl");
                                    if (nextIsActive) {
                                      const ok = await ensureSourceSize(v);
                                      if (!ok) {
                                        alert("无法获取原始画面尺寸，请稍后重试。");
                                        return;
                                      }
                                    }
                                    setPickTarget((old) =>
                                      old?.viewId === v.id && old?.corner === "tl" ? null : { viewId: v.id, corner: "tl" },
                                    );
                                  })();
                                }}
                                title="从左侧画面点击采集左上坐标"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                                  <path d="M12 21s7-4.3 7-10a7 7 0 1 0-14 0c0 5.7 7 10 7 10Z" stroke="currentColor" strokeWidth="1.6" />
                                  <circle cx="12" cy="11" r="2.5" fill="currentColor" />
                                </svg>
                              </button>
                            </div>
                          </label>
                          <label className="col-span-2 text-slate-600">
                            裁剪右下坐标 (x2, y2)
                            <div className="mt-0.5 flex gap-1">
                              <input
                                type="number"
                                className="w-1/2 rounded border border-slate-300 px-2 py-1"
                                value={v.crop_x2 ?? ""}
                                disabled={!canEdit}
                                onChange={(e) =>
                                  setViews((old) =>
                                    old.map((x) =>
                                      x.id === v.id ? { ...x, crop_x2: e.target.value === "" ? null : Number(e.target.value) } : x,
                                    ),
                                  )
                                }
                              />
                              <input
                                type="number"
                                className="w-1/2 rounded border border-slate-300 px-2 py-1"
                                value={v.crop_y2 ?? ""}
                                disabled={!canEdit}
                                onChange={(e) =>
                                  setViews((old) =>
                                    old.map((x) =>
                                      x.id === v.id ? { ...x, crop_y2: e.target.value === "" ? null : Number(e.target.value) } : x,
                                    ),
                                  )
                                }
                              />
                              <button
                                type="button"
                                className={`rounded border px-2 py-1 ${
                                  pickTarget?.viewId === v.id && pickTarget.corner === "br"
                                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                    : "border-slate-300 bg-white text-slate-700"
                                }`}
                                disabled={!canEdit}
                                onClick={() => {
                                  void (async () => {
                                    const nextIsActive = !(pickTarget?.viewId === v.id && pickTarget?.corner === "br");
                                    if (nextIsActive) {
                                      const ok = await ensureSourceSize(v);
                                      if (!ok) {
                                        alert("无法获取原始画面尺寸，请稍后重试。");
                                        return;
                                      }
                                    }
                                    setPickTarget((old) =>
                                      old?.viewId === v.id && old?.corner === "br" ? null : { viewId: v.id, corner: "br" },
                                    );
                                  })();
                                }}
                                title="从左侧画面点击采集右下坐标"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                                  <path d="M12 21s7-4.3 7-10a7 7 0 1 0-14 0c0 5.7 7 10 7 10Z" stroke="currentColor" strokeWidth="1.6" />
                                  <circle cx="12" cy="11" r="2.5" fill="currentColor" />
                                </svg>
                              </button>
                            </div>
                          </label>
                        </>
                      ) : null}
                      {(v.view_mode || "panorama_perspective") === "panorama_perspective" ? (
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
                      ) : null}
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
      <h2 className="text-xl font-semibold text-slate-800">设备管理</h2>

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
