import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../shared/clipboard";
import { API_BASE } from "../shared/config";
import { floorPlanImageUrl, preloadFloorPlanImage } from "../shared/floorPlan";
import { Camera, FloorPlan, Footfall, HeatmapSource } from "../shared/types";

type FloorPlanCanvasLikeProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  showGrid?: boolean;
  backgroundColor?: string;
  poiCells?: Map<string, number>;
  poiTrackIds?: Map<string, number[]>;
  showPoiTrackIds?: boolean;
  className?: string;
};

type MappedGridLikeProps = {
  sources: HeatmapSource[];
  analyzing: boolean;
  vvFootfalls: Record<number, Footfall[]>;
};

type PeoplePositionViewProps = {
  FloorPlanCanvasComponent: React.ComponentType<FloorPlanCanvasLikeProps>;
  MappedCamerasGridComponent: React.ComponentType<MappedGridLikeProps>;
};

const PeoplePositionView: React.FC<PeoplePositionViewProps> = ({
  FloorPlanCanvasComponent,
  MappedCamerasGridComponent,
}) => {
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
              <FloorPlanCanvasComponent
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

        <MappedCamerasGridComponent sources={mappedCameras} analyzing={analyzing} vvFootfalls={vvFootfalls} />
      </div>
    </div>
  );
};

export default PeoplePositionView;
