import React, { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "../shared/config";
import { FloorPlan } from "../shared/types";

type DbStats = {
  floor_plan_id: number | null;
  db_url: string;
  db_file_size_bytes: number | null;
  heatmap_events_count: number;
  footfall_cross_events_count: number;
  heatmap_min_ts: number | null;
  heatmap_max_ts: number | null;
  footfall_min_ts: number | null;
  footfall_max_ts: number | null;
};

const bytesText = (n: number | null): string => {
  if (n == null || !Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const tsText = (ts: number | null): string => {
  if (ts == null || !Number.isFinite(ts)) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
};

const StatRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <div className="text-[11px] text-slate-500">{label}</div>
    <div className="truncate text-right text-xs font-semibold text-slate-800">{value}</div>
  </div>
);

const StatKpi: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="text-[11px] text-slate-500">{label}</div>
    <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
  </div>
);

const filenameFromDisposition = (v: string | null): string | null => {
  if (!v) return null;
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(v);
  const raw = m?.[1] || m?.[2];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const SystemSettingsView: React.FC = () => {
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<number | "">("");
  const [globalStats, setGlobalStats] = useState<DbStats | null>(null);
  const [scopedStats, setScopedStats] = useState<DbStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [purgingHeatmap, setPurgingHeatmap] = useState(false);
  const [purgingFootfall, setPurgingFootfall] = useState(false);
  const [purgeMode, setPurgeMode] = useState<"all" | "range">("all");
  const [purgeStartDate, setPurgeStartDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [purgeEndDate, setPurgeEndDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/floor-plans`);
        const items: FloorPlan[] = res.ok ? await res.json() : [];
        setFloorPlans(items);
        if (items.length > 0) setSelectedFloorPlanId(items[0].id);
      } catch (e) {
        console.error(e);
      }
    };
    void load();
  }, []);

  const refreshStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const [globalRes, scopedRes] = await Promise.all([
        fetch(`${API_BASE}/api/admin/db-stats`),
        selectedFloorPlanId === ""
          ? Promise.resolve(null)
          : fetch(`${API_BASE}/api/admin/db-stats?floor_plan_id=${selectedFloorPlanId}`),
      ]);
      const g = globalRes.ok ? ((await globalRes.json()) as DbStats) : null;
      const s = scopedRes && scopedRes.ok ? ((await scopedRes.json()) as DbStats) : null;
      setGlobalStats(g);
      setScopedStats(s);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingStats(false);
    }
  }, [selectedFloorPlanId]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const selectedFloorPlanName = useMemo(() => {
    if (selectedFloorPlanId === "") return "";
    return floorPlans.find((x) => x.id === Number(selectedFloorPlanId))?.name || `FloorPlan#${selectedFloorPlanId}`;
  }, [floorPlans, selectedFloorPlanId]);

  const confirmDelete = useCallback((title: string): boolean => {
    const ok = window.confirm(`${title}\n\n该操作不可撤销。确认继续吗？`);
    if (!ok) return false;
    const text = window.prompt("请输入 DELETE 进行确认：", "");
    return String(text || "").trim().toUpperCase() === "DELETE";
  }, []);

  const downloadBackup = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/db-backup`);
      if (!res.ok) {
        const msg = await res.text();
        alert(`下载失败: ${msg || res.status}`);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition");
      const filename = filenameFromDisposition(cd) || `app_backup_${Date.now()}.db`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert("下载失败，请稍后重试。");
    } finally {
      setDownloading(false);
    }
  }, []);

  const purgeHeatmap = useCallback(async () => {
    if (selectedFloorPlanId === "") return;
    if (!confirmDelete(`将清理平面图 [${selectedFloorPlanName}] 的热力历史数据`)) return;
    if (purgeMode === "range" && (!purgeStartDate || !purgeEndDate)) {
      alert("请选择起始日期和结束日期。");
      return;
    }
    setPurgingHeatmap(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/purge-heatmap-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_plan_id: Number(selectedFloorPlanId),
          confirm_text: "DELETE",
          purge_mode: purgeMode,
          start_date: purgeMode === "range" ? purgeStartDate : null,
          end_date: purgeMode === "range" ? purgeEndDate : null,
          tz_offset_minutes: new Date().getTimezoneOffset(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`清理失败: ${data?.detail || res.status}`);
        return;
      }
      alert(`清理完成，删除 ${Number(data?.deleted_count || 0)} 条热力历史记录。`);
      void refreshStats();
    } catch (e) {
      console.error(e);
      alert("清理失败，请稍后重试。");
    } finally {
      setPurgingHeatmap(false);
    }
  }, [confirmDelete, purgeEndDate, purgeMode, purgeStartDate, refreshStats, selectedFloorPlanId, selectedFloorPlanName]);

  const purgeFootfall = useCallback(async () => {
    if (selectedFloorPlanId === "") return;
    if (!confirmDelete(`将清理平面图 [${selectedFloorPlanName}] 的人流量历史数据`)) return;
    if (purgeMode === "range" && (!purgeStartDate || !purgeEndDate)) {
      alert("请选择起始日期和结束日期。");
      return;
    }
    setPurgingFootfall(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/purge-footfall-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_plan_id: Number(selectedFloorPlanId),
          confirm_text: "DELETE",
          purge_mode: purgeMode,
          start_date: purgeMode === "range" ? purgeStartDate : null,
          end_date: purgeMode === "range" ? purgeEndDate : null,
          tz_offset_minutes: new Date().getTimezoneOffset(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`清理失败: ${data?.detail || res.status}`);
        return;
      }
      alert(
        `清理完成，删除 ${Number(data?.deleted_count || 0)} 条人流量相关记录（事件 ${Number(
          data?.deleted_cross_events || 0,
        )} 条，抓拍头像 ${Number(data?.deleted_face_captures || 0)} 条）。`,
      );
      void refreshStats();
    } catch (e) {
      console.error(e);
      alert("清理失败，请稍后重试。");
    } finally {
      setPurgingFootfall(false);
    }
  }, [confirmDelete, purgeEndDate, purgeMode, purgeStartDate, refreshStats, selectedFloorPlanId, selectedFloorPlanName]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-800">系统设置</h2>
      <p className="text-xs text-slate-500">
        提供数据库备份下载与历史数据清理功能。所有清理操作不可撤销，请谨慎执行。
      </p>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-800">数据库状态</span>
          <button
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => void refreshStats()}
            disabled={loadingStats}
          >
            {loadingStats ? "刷新中..." : "刷新"}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">全局统计</div>
              <div className="text-[11px] text-slate-500">{bytesText(globalStats?.db_file_size_bytes ?? null)}</div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <StatKpi label="热力事件总数" value={globalStats?.heatmap_events_count ?? "-"} />
              <StatKpi label="人流事件总数" value={globalStats?.footfall_cross_events_count ?? "-"} />
            </div>
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-800">时间范围（UTC 本地显示）</div>
              <div className="space-y-1.5">
                <StatRow label="热力最早时间" value={tsText(globalStats?.heatmap_min_ts ?? null)} />
                <StatRow label="热力最新时间" value={tsText(globalStats?.heatmap_max_ts ?? null)} />
                <div className="my-2 h-px bg-slate-100" />
                <StatRow label="人流最早时间" value={tsText(globalStats?.footfall_min_ts ?? null)} />
                <StatRow label="人流最新时间" value={tsText(globalStats?.footfall_max_ts ?? null)} />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">按平面图统计</div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[11px] text-slate-500">平面图</span>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  value={selectedFloorPlanId}
                  onChange={(e) => setSelectedFloorPlanId(e.target.value ? Number(e.target.value) : "")}
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <StatKpi label="热力事件数量" value={scopedStats?.heatmap_events_count ?? "-"} />
              <StatKpi label="人流事件数量" value={scopedStats?.footfall_cross_events_count ?? "-"} />
            </div>
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 text-xs font-semibold text-slate-800">提示</div>
              <div className="text-[11px] leading-relaxed text-slate-600">
                清理操作将按所选平面图全量删除历史事件。建议先在下方下载数据库备份，再执行清理。
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-semibold text-slate-800">数据库备份下载</div>
        <p className="mb-3 text-xs text-slate-500">下载当前 SQLite 数据库副本（.db）。建议在批量清理前先备份。</p>
        <button
          className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-60"
          onClick={() => void downloadBackup()}
          disabled={downloading}
        >
          {downloading ? "下载中..." : "下载数据库备份"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-amber-900">清理热力图历史数据</div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-900">
            <span>清理范围</span>
            <select
              className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px]"
              value={purgeMode}
              onChange={(e) => setPurgeMode((e.target.value as "all" | "range") || "all")}
            >
              <option value="all">全部数据</option>
              <option value="range">按日期范围</option>
            </select>
            {purgeMode === "range" ? (
              <>
                <input
                  type="date"
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px]"
                  value={purgeStartDate}
                  onChange={(e) => setPurgeStartDate(e.target.value)}
                />
                <span>至</span>
                <input
                  type="date"
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px]"
                  value={purgeEndDate}
                  onChange={(e) => setPurgeEndDate(e.target.value)}
                />
              </>
            ) : null}
          </div>
          <p className="mb-3 text-xs text-amber-800">
            按平面图全量清理 `heatmap_events`。目标平面图：{selectedFloorPlanName || "-"}。
          </p>
          <button
            className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            onClick={() => void purgeHeatmap()}
            disabled={selectedFloorPlanId === "" || purgingHeatmap}
          >
            {purgingHeatmap ? "清理中..." : "清理热力图历史"}
          </button>
        </div>

        <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-rose-900">清理人流量历史数据</div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-rose-900">
            <span>清理范围</span>
            <select
              className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px]"
              value={purgeMode}
              onChange={(e) => setPurgeMode((e.target.value as "all" | "range") || "all")}
            >
              <option value="all">全部数据</option>
              <option value="range">按日期范围</option>
            </select>
            {purgeMode === "range" ? (
              <>
                <input
                  type="date"
                  className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px]"
                  value={purgeStartDate}
                  onChange={(e) => setPurgeStartDate(e.target.value)}
                />
                <span>至</span>
                <input
                  type="date"
                  className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px]"
                  value={purgeEndDate}
                  onChange={(e) => setPurgeEndDate(e.target.value)}
                />
              </>
            ) : null}
          </div>
          <p className="mb-3 text-xs text-rose-800">
            清理 `footfall_cross_events` 与 `footfall_face_captures`（base64 抓拍头像）。目标平面图：
            {selectedFloorPlanName || "-"}。
          </p>
          <button
            className="rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
            onClick={() => void purgeFootfall()}
            disabled={selectedFloorPlanId === "" || purgingFootfall}
          >
            {purgingFootfall ? "清理中..." : "清理人流量历史"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SystemSettingsView;
