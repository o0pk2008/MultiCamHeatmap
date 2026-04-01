import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { API_BASE } from "../../shared/config";
import { floorPlanImageUrl } from "../../shared/floorPlan";
import { FloorPlan } from "../../shared/types";

type FloorPlanCanvasLikeProps = {
  imageUrl: string;
  gridRows: number;
  gridCols: number;
  className?: string;
  showGrid?: boolean;
  backgroundColor?: string;
  footfallLineUV?: {
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    inLabel: string;
    outLabel: string;
  } | null;
};

type LineRow = {
  id: number;
  floor_plan_id: number;
  virtual_view_id: number;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  floor_p1: { x: number; y: number } | null;
  floor_p2: { x: number; y: number } | null;
  in_label: string;
  out_label: string;
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
  image_url?: string | null;
  image_base64?: string | null;
};

const faceCaptureSrc = (it: FaceCaptureItem): string => {
  const imageUrl = String(it.image_url || "").trim();
  if (imageUrl) {
    return imageUrl.startsWith("http") ? imageUrl : `${API_BASE}${imageUrl}`;
  }
  const b64 = String(it.image_base64 || "").trim();
  return b64 ? `data:image/jpeg;base64,${b64}` : "";
};

const emptyStats = (): FootfallStats => ({
  inCount: 0,
  outCount: 0,
  genderMale: 0,
  genderFemale: 0,
  ageBuckets: [],
  trendIn: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 })),
  trendOut: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 })),
});

type Props = {
  params: URLSearchParams;
  FloorPlanCanvasComponent: React.ComponentType<FloorPlanCanvasLikeProps>;
};

export const ShareFootfallPage: React.FC<Props> = ({ params, FloorPlanCanvasComponent }) => {
  const floorPlanId = Number(params.get("floor_plan_id") || "");
  const vvFromUrl = Number(params.get("virtual_view_id") || "");
  const embed = params.get("embed") === "1" || params.get("embed") === "true";
  const showGrid = params.get("grid") === "1" || params.get("grid") === "true";
  const modeParam = (params.get("mode") || "current") as "current" | "history";
  const dateKeyFromUrl = (params.get("date_key") || "").trim();
  const refreshMsRaw = Number(params.get("refresh_ms") || "2000");
  const refreshMs = Math.min(60_000, Math.max(800, Number.isFinite(refreshMsRaw) ? refreshMsRaw : 2000));

  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [vvLabels, setVvLabels] = useState<Record<number, string>>({});
  const [selectedVvId, setSelectedVvId] = useState<number | null>(null);
  const [dataMode, setDataMode] = useState<"live" | "history">(modeParam === "history" ? "history" : "live");
  const [historyDate, setHistoryDate] = useState<string>(() =>
    dateKeyFromUrl || new Date().toISOString().slice(0, 10),
  );
  const [stats, setStats] = useState<FootfallStats>(() => emptyStats());
  const [faces, setFaces] = useState<FaceCaptureItem[]>([]);
  const [faceOffset, setFaceOffset] = useState(0);
  const faceOffsetRef = useRef(0);
  const [faceHasMore, setFaceHasMore] = useState(true);
  const [faceLoading, setFaceLoading] = useState(false);
  const [statusText, setStatusText] = useState<string>("");

  const fetchStatsRef = useRef<() => Promise<void>>(async () => {});
  const fetchFacesRef = useRef<(reset: boolean, opts?: { quiet?: boolean }) => Promise<void>>(async () => {});

  useEffect(() => {
    faceOffsetRef.current = faceOffset;
  }, [faceOffset]);

  useEffect(() => {
    fetch(`${API_BASE}/api/floor-plans`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((fps: FloorPlan[]) => setFloorPlans(Array.isArray(fps) ? fps : []))
      .catch(() => setFloorPlans([]));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/cameras/virtual-views/all`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((rows: { id: number; camera_name?: string; name?: string }[]) => {
        const m: Record<number, string> = {};
        (rows || []).forEach((it) => {
          const label = `${it.camera_name || "Camera"} / ${it.name || "View"}`;
          m[Number(it.id)] = label;
        });
        setVvLabels(m);
      })
      .catch(() => setVvLabels({}));
  }, []);

  const selectedFloorPlan = useMemo(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return null;
    return floorPlans.find((fp) => fp.id === floorPlanId) || null;
  }, [floorPlans, floorPlanId]);

  const imageUrl = useMemo(() => {
    if (!selectedFloorPlan) return "";
    return floorPlanImageUrl(selectedFloorPlan);
  }, [selectedFloorPlan]);

  useEffect(() => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0) return;
    fetch(`${API_BASE}/api/footfall/lines?floor_plan_id=${floorPlanId}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((rows: LineRow[]) => {
        const list = Array.isArray(rows) ? rows : [];
        setLines(list);
        if (list.length === 0) {
          setSelectedVvId(null);
          return;
        }
        const want = Number.isFinite(vvFromUrl) && vvFromUrl > 0 ? vvFromUrl : NaN;
        const pick = list.some((l) => l.virtual_view_id === want) ? want : list[0].virtual_view_id;
        setSelectedVvId(pick);
      })
      .catch(() => {
        setLines([]);
        setSelectedVvId(null);
      });
  }, [floorPlanId, vvFromUrl]);

  const activeLine = useMemo(() => {
    if (selectedVvId == null) return null;
    return lines.find((l) => l.virtual_view_id === selectedVvId) || null;
  }, [lines, selectedVvId]);

  const floorP1 = activeLine?.floor_p1 ?? activeLine?.p1;
  const floorP2 = activeLine?.floor_p2 ?? activeLine?.p2;

  const footfallLineUV = useMemo(() => {
    if (!activeLine || !floorP1 || !floorP2) return null;
    return {
      p1: floorP1,
      p2: floorP2,
      inLabel: activeLine.in_label,
      outLabel: activeLine.out_label,
    };
  }, [activeLine, floorP1, floorP2]);

  const fetchStats = useCallback(async () => {
    if (!Number.isFinite(floorPlanId) || floorPlanId <= 0 || selectedVvId == null) return;
    const mode = dataMode === "live" ? "realtime" : "date";
    const tzOffsetMin = new Date().getTimezoneOffset();
    let url =
      `${API_BASE}/api/footfall/stats?floor_plan_id=${floorPlanId}` +
      `&virtual_view_id=${selectedVvId}` +
      `&mode=${mode}` +
      `&tz_offset_minutes=${encodeURIComponent(String(tzOffsetMin))}`;
    if (mode === "date") url += `&date_key=${encodeURIComponent(historyDate)}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as FootfallStats;
      setStats(data);
      setStatusText("");
    } catch {
      setStatusText("加载统计数据失败");
    }
  }, [floorPlanId, selectedVvId, dataMode, historyDate]);

  const fetchFaces = useCallback(
    async (reset: boolean, opts?: { quiet?: boolean }) => {
      if (!Number.isFinite(floorPlanId) || floorPlanId <= 0 || selectedVvId == null) return;
      const mode = dataMode === "live" ? "realtime" : "date";
      const off = reset ? 0 : faceOffsetRef.current;
      const tzOffsetMin = new Date().getTimezoneOffset();
      const limit = 24;
      const url =
        `${API_BASE}/api/footfall/face-captures?virtual_view_id=${selectedVvId}` +
        `&floor_plan_id=${floorPlanId}` +
        `&mode=${mode}` +
        (mode === "date" ? `&date_key=${encodeURIComponent(historyDate)}` : "") +
        `&tz_offset_minutes=${encodeURIComponent(String(tzOffsetMin))}` +
        `&offset=${off}` +
        `&limit=${limit}`;
      const quiet = Boolean(opts?.quiet);
      if (!quiet) setFaceLoading(true);
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as FaceCaptureItem[];
        const list = Array.isArray(data) ? data : [];
        if (reset) {
          setFaces(list);
          const next = list.length;
          setFaceOffset(next);
          faceOffsetRef.current = next;
        } else {
          setFaces((old) => [...old, ...list]);
          setFaceOffset((o) => {
            const n = o + list.length;
            faceOffsetRef.current = n;
            return n;
          });
        }
        setFaceHasMore(list.length >= limit);
      } finally {
        if (!quiet) setFaceLoading(false);
      }
    },
    [floorPlanId, selectedVvId, dataMode, historyDate],
  );

  useEffect(() => {
    fetchStatsRef.current = fetchStats;
  }, [fetchStats]);

  useEffect(() => {
    fetchFacesRef.current = fetchFaces;
  }, [fetchFaces]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (selectedVvId == null) return;
    setFaceOffset(0);
    faceOffsetRef.current = 0;
    void fetchFaces(true);
  }, [selectedVvId, dataMode, historyDate, floorPlanId, fetchFaces]);

  useEffect(() => {
    if (dataMode !== "live" || selectedVvId == null) return;
    const tick = () => {
      void fetchStatsRef.current();
      void fetchFacesRef.current(true, { quiet: true });
    };
    const t = window.setInterval(tick, refreshMs);
    return () => window.clearInterval(t);
  }, [dataMode, selectedVvId, refreshMs]);

  useEffect(() => {
    if (dataMode !== "live" || selectedVvId == null) return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void fetchStatsRef.current();
        void fetchFacesRef.current(true, { quiet: true });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [dataMode, selectedVvId]);

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
            { value: stats.genderMale, name: "男", itemStyle: { color: "#3B82F6" } },
            { value: stats.genderFemale, name: "女", itemStyle: { color: "#EC4899" } },
          ],
        },
      ],
    }),
    [stats.genderMale, stats.genderFemale],
  );

  const ageOption = useMemo(() => {
    const buckets = stats.ageBuckets?.length ? stats.ageBuckets : [];
    return {
      tooltip: { trigger: "axis" },
      grid: { left: 30, right: 10, top: 20, bottom: 28 },
      xAxis: {
        type: "category",
        data: buckets.map((x) => x.label),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [
        {
          type: "bar",
          data: buckets.map((x) => x.value),
          itemStyle: { color: "#6366F1", borderRadius: [4, 4, 0, 0] },
          barWidth: "55%",
        },
      ],
    };
  }, [stats.ageBuckets]);

  const trendOption = useMemo(
    () => ({
      tooltip: { trigger: "axis" },
      grid: { left: 32, right: 10, top: 20, bottom: 26 },
      legend: { top: 0, right: 10, textStyle: { fontSize: 11 } },
      xAxis: {
        type: "category",
        data: stats.trendIn.map((x) => `${x.hour}:00`),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: "value", axisLabel: { fontSize: 10 } },
      series: [
        { name: "进入", type: "line", data: stats.trendIn.map((x) => x.value), smooth: true },
        { name: "离开", type: "line", data: stats.trendOut.map((x) => x.value), smooth: true },
      ],
    }),
    [stats.trendIn, stats.trendOut],
  );

  const statsTitle =
    dataMode === "live" ? `${new Date().toLocaleDateString()} 实时` : `${historyDate} 历史`;

  return (
    <div className={`min-h-screen bg-slate-50 ${embed ? "" : "p-4"}`}>
      {!embed ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-800">人流量分析（分享）</div>
          <div className="text-[11px] text-slate-500">
            {selectedFloorPlan ? selectedFloorPlan.name : `floor_plan_id=${floorPlanId}`}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
        <div className="flex h-[60vh] min-h-0 flex-col rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800">平面图预览</span>
            <span className="text-[11px] text-slate-500">网格：{showGrid ? "显示" : "隐藏"}</span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {statusText ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-xs text-slate-600">{statusText}</div>
            ) : null}
            {selectedFloorPlan && imageUrl ? (
              <FloorPlanCanvasComponent
                imageUrl={imageUrl}
                gridRows={Math.max(1, selectedFloorPlan.grid_rows || 1)}
                gridCols={Math.max(1, selectedFloorPlan.grid_cols || 1)}
                showGrid={showGrid}
                backgroundColor="white"
                footfallLineUV={footfallLineUV}
                className="h-full w-full min-h-0"
              />
            ) : (
              <div className="flex h-full min-h-0 items-center justify-center text-xs text-slate-400">未找到平面图或判定线</div>
            )}
          </div>
        </div>

        <div className="flex h-[60vh] min-h-0 flex-col overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800">数据统计</span>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
              <input
                type="date"
                className="rounded border border-slate-300 bg-white px-2 py-1"
                value={historyDate}
                onChange={(e) => {
                  setHistoryDate(e.target.value || new Date().toISOString().slice(0, 10));
                  setDataMode("history");
                }}
                disabled={dataMode === "live"}
              />
              <label className="flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={dataMode === "live"}
                  onChange={(e) => setDataMode(e.target.checked ? "live" : "history")}
                />
                <span>实时数据</span>
              </label>
            </div>
          </div>

          <div className="mb-2">
            <label className="mb-1 block text-[11px] font-medium text-slate-600">判定线（虚拟视窗）</label>
            <select
              className="w-full max-w-md rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
              value={selectedVvId ?? ""}
              onChange={(e) => setSelectedVvId(e.target.value ? Number(e.target.value) : null)}
            >
              {lines.length === 0 ? <option value="">暂无判定线配置</option> : null}
              {lines.map((ln) => (
                <option key={ln.id} value={ln.virtual_view_id}>
                  {vvLabels[ln.virtual_view_id] || `virtual_view #${ln.virtual_view_id}`} · #{ln.id}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2">
              <div className="text-[11px] text-emerald-800">{statsTitle} 累计进入</div>
              <div className="text-lg font-semibold text-emerald-700">{stats.inCount}</div>
            </div>
            <div className="rounded border border-orange-200 bg-orange-50 p-2">
              <div className="text-[11px] text-orange-800">{statsTitle} 累计离开</div>
              <div className="text-lg font-semibold text-orange-700">{stats.outCount}</div>
            </div>
          </div>

          <div className="grid min-h-[140px] flex-1 grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex min-h-[120px] flex-col rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1 text-xs font-semibold text-slate-700">性别</div>
              <div className="min-h-0 flex-1">
                <ReactECharts option={genderOption} style={{ height: "100%", minHeight: 110 }} notMerge />
              </div>
            </div>
            <div className="flex min-h-[120px] flex-col rounded border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1 text-xs font-semibold text-slate-700">年龄</div>
              <div className="min-h-0 flex-1">
                <ReactECharts option={ageOption} style={{ height: "100%", minHeight: 110 }} notMerge />
              </div>
            </div>
            <div className="min-h-[120px] md:col-span-3">
              <div className="mb-1 text-xs font-semibold text-slate-700">24h 趋势</div>
              <ReactECharts option={trendOption} style={{ height: 160, width: "100%" }} notMerge />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="mb-2 text-sm font-semibold text-slate-800">人脸分析记录</div>
        <div className="max-h-[420px] overflow-y-auto">
          {faces.length === 0 && !faceLoading ? (
            <div className="py-6 text-center text-xs text-slate-400">暂无记录</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {faces.map((it) => (
                <div key={it.id} className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <img
                    src={faceCaptureSrc(it)}
                    alt=""
                    className="h-16 w-16 flex-shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex flex-col justify-center text-xs text-slate-700">
                    <div>性别：{it.gender === "male" ? "男" : it.gender === "female" ? "女" : "未知"}</div>
                    <div className="mt-0.5">年龄：{it.age_bucket || "未知"}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {Number.isFinite(Number(it.ts)) ? new Date(Number(it.ts) * 1000).toLocaleString() : "-"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {faceLoading ? <div className="py-2 text-center text-[11px] text-slate-500">加载中…</div> : null}
        </div>
        {faceHasMore && faces.length > 0 ? (
          <button
            type="button"
            className="mt-2 w-full rounded border border-slate-300 bg-white py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            onClick={() => void fetchFaces(false)}
            disabled={faceLoading}
          >
            加载更多
          </button>
        ) : null}
      </div>
    </div>
  );
};
