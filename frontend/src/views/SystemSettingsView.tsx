import React, { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "../shared/config";
import { FloorPlan } from "../shared/types";

type DbStats = {
  floor_plan_id: number | null;
  db_url: string;
  db_file_size_bytes: number | null;
  heatmap_events_count: number;
  footfall_cross_events_count: number;
  queue_wait_visits_count: number;
  heatmap_min_ts: number | null;
  heatmap_max_ts: number | null;
  footfall_min_ts: number | null;
  footfall_max_ts: number | null;
  queue_wait_min_ts: number | null;
  queue_wait_max_ts: number | null;
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

/** 本页锚点导航（单页 + 顶部 sticky 目录） */
const SETTINGS_SECTIONS: { id: string; label: string }[] = [
  { id: "settings-db-stats", label: "数据库状态" },
  { id: "settings-backup", label: "备份下载" },
  { id: "settings-display", label: "画面与标注" },
  { id: "settings-face", label: "人脸保留" },
  { id: "settings-queue-wait", label: "排队分析" },
  { id: "settings-purge", label: "数据清理" },
];

const scrollToSettingsSection = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const [purgingQueueWait, setPurgingQueueWait] = useState(false);
  const [reanalyzingFootfall, setReanalyzingFootfall] = useState(false);
  const [drawFootfallLineOverlay, setDrawFootfallLineOverlay] = useState(false);
  const [savingFootfallOverlay, setSavingFootfallOverlay] = useState(false);
  const [yoloBoxStyle, setYoloBoxStyle] = useState<"rect" | "corners_rounded">("corners_rounded");
  const [yoloBoxColor, setYoloBoxColor] = useState<"green" | "blue" | "white">("white");
  const [yoloFootPointEnabled, setYoloFootPointEnabled] = useState(false);
  const [yoloFootPointStyle, setYoloFootPointStyle] = useState<"circle" | "square">("circle");
  const [yoloFootPointColor, setYoloFootPointColor] = useState<"green" | "blue" | "white">("green");
  const [mappedCamGridColor, setMappedCamGridColor] = useState<"white" | "green" | "blue">("white");
  const [faceRetentionDays, setFaceRetentionDays] = useState<number>(30);
  const [savingFaceRetention, setSavingFaceRetention] = useState(false);
  /** 服务闭环后 N 秒内再踩排队区不计新排队（秒），0 为关闭 */
  const [postServiceQueueIgnoreSec, setPostServiceQueueIgnoreSec] = useState<number>(30);
  /** 直进服务区时，服务停留 ≥ 该秒并离开才落库并计入完成笔数 */
  const [directServiceCompleteMinSec, setDirectServiceCompleteMinSec] = useState<number>(3);
  /** 排队后未进服务区就离开：排队停留 ≥ 该秒才计弃单；低于则视为路过不落库 */
  const [abandonMinQueueSec, setAbandonMinQueueSec] = useState<number>(2);
  const [savingQueueWaitAnalysis, setSavingQueueWaitAnalysis] = useState(false);
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

  useEffect(() => {
    const loadOverlayConfig = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/admin/footfall-overlay-config`);
        if (!r.ok) return;
        const data = await r.json();
        setDrawFootfallLineOverlay(Boolean(data?.draw_footfall_line_overlay));
        setYoloBoxStyle(data?.yolo_box_style === "rect" ? "rect" : "corners_rounded");
        setYoloBoxColor(data?.yolo_box_color === "green" ? "green" : data?.yolo_box_color === "blue" ? "blue" : "white");
        setYoloFootPointEnabled(Boolean(data?.yolo_foot_point_enabled ?? false));
        setYoloFootPointStyle(data?.yolo_foot_point_style === "square" ? "square" : "circle");
        setYoloFootPointColor(
          data?.yolo_foot_point_color === "blue" ? "blue" : data?.yolo_foot_point_color === "white" ? "white" : "green",
        );
        setMappedCamGridColor(
          data?.mapped_cam_grid_color === "green"
            ? "green"
            : data?.mapped_cam_grid_color === "blue"
              ? "blue"
              : "white",
        );
      } catch (e) {
        console.error(e);
      }
    };
    void loadOverlayConfig();
  }, []);

  useEffect(() => {
    const loadFaceRetention = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/admin/face-capture-retention`);
        if (!r.ok) return;
        const data = await r.json();
        const v = Number(data?.retention_days);
        if (Number.isFinite(v) && v >= 0) setFaceRetentionDays(Math.floor(v));
      } catch (e) {
        console.error(e);
      }
    };
    void loadFaceRetention();
  }, []);

  useEffect(() => {
    const loadQueueWaitAnalysis = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/admin/queue-wait-analysis-config`);
        if (!r.ok) return;
        const data = await r.json();
        const v = Number(data?.post_service_queue_ignore_sec);
        if (Number.isFinite(v) && v >= 0) setPostServiceQueueIgnoreSec(v);
        const vd = Number(data?.direct_service_complete_min_sec);
        if (Number.isFinite(vd) && vd >= 0) setDirectServiceCompleteMinSec(vd);
        const va = Number(data?.abandon_min_queue_sec);
        if (Number.isFinite(va) && va >= 0) setAbandonMinQueueSec(va);
      } catch (e) {
        console.error(e);
      }
    };
    void loadQueueWaitAnalysis();
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

  const purgeQueueWait = useCallback(async () => {
    if (selectedFloorPlanId === "") return;
    if (!confirmDelete(`将清理平面图 [${selectedFloorPlanName}] 的排队时长分析历史数据`)) return;
    if (purgeMode === "range" && (!purgeStartDate || !purgeEndDate)) {
      alert("请选择起始日期和结束日期。");
      return;
    }
    setPurgingQueueWait(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/purge-queue-wait-visits`, {
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
      alert(`清理完成，删除 ${Number(data?.deleted_count || 0)} 条排队时长记录（queue_wait_visits）。`);
      void refreshStats();
    } catch (e) {
      console.error(e);
      alert("清理失败，请稍后重试。");
    } finally {
      setPurgingQueueWait(false);
    }
  }, [confirmDelete, purgeEndDate, purgeMode, purgeStartDate, refreshStats, selectedFloorPlanId, selectedFloorPlanName]);

  const reanalyzeFootfallFaceCaptures = useCallback(async () => {
    if (selectedFloorPlanId === "") return;
    const ok = window.confirm(
      `将对平面图 [${selectedFloorPlanName}] 已抓拍人脸重新执行年龄/性别识别，并同步修正统计数据。\n\n确认继续吗？`,
    );
    if (!ok) return;
    if (purgeMode === "range" && (!purgeStartDate || !purgeEndDate)) {
      alert("请选择起始日期和结束日期。");
      return;
    }
    setReanalyzingFootfall(true);
    try {
      const res = await fetch(`${API_BASE}/api/footfall/reanalyze-face-captures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_plan_id: Number(selectedFloorPlanId),
          mode: purgeMode,
          start_date: purgeMode === "range" ? purgeStartDate : null,
          end_date: purgeMode === "range" ? purgeEndDate : null,
          tz_offset_minutes: new Date().getTimezoneOffset(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`重识别失败: ${data?.detail || res.status}`);
        return;
      }
      alert(
        `重识别完成：扫描 ${Number(data?.scanned || 0)} 条，更新抓拍 ${Number(
          data?.updated_captures || 0,
        )} 条，同步统计事件 ${Number(data?.updated_events || 0)} 条。`,
      );
      void refreshStats();
    } catch (e) {
      console.error(e);
      alert("重识别失败，请稍后重试。");
    } finally {
      setReanalyzingFootfall(false);
    }
  }, [purgeEndDate, purgeMode, purgeStartDate, refreshStats, selectedFloorPlanId, selectedFloorPlanName]);

  const saveOverlayConfig = useCallback(
    async (next: {
      draw_footfall_line_overlay?: boolean;
      yolo_box_style?: "rect" | "corners_rounded";
      yolo_box_color?: "green" | "blue" | "white";
      yolo_foot_point_enabled?: boolean;
      yolo_foot_point_style?: "circle" | "square";
      yolo_foot_point_color?: "green" | "blue" | "white";
      mapped_cam_grid_color?: "white" | "green" | "blue";
    }) => {
      setSavingFootfallOverlay(true);
      try {
        const r = await fetch(`${API_BASE}/api/admin/footfall-overlay-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draw_footfall_line_overlay: next.draw_footfall_line_overlay ?? drawFootfallLineOverlay,
            yolo_box_style: next.yolo_box_style ?? yoloBoxStyle,
            yolo_box_color: next.yolo_box_color ?? yoloBoxColor,
            yolo_foot_point_enabled: next.yolo_foot_point_enabled ?? yoloFootPointEnabled,
            yolo_foot_point_style: next.yolo_foot_point_style ?? yoloFootPointStyle,
            yolo_foot_point_color: next.yolo_foot_point_color ?? yoloFootPointColor,
            mapped_cam_grid_color: next.mapped_cam_grid_color ?? mappedCamGridColor,
          }),
        });
        if (!r.ok) throw new Error("save failed");
        const data = await r.json().catch(() => ({}));
        setDrawFootfallLineOverlay(Boolean(data?.draw_footfall_line_overlay));
        setYoloBoxStyle(data?.yolo_box_style === "rect" ? "rect" : "corners_rounded");
        setYoloBoxColor(data?.yolo_box_color === "green" ? "green" : data?.yolo_box_color === "blue" ? "blue" : "white");
        setYoloFootPointEnabled(Boolean(data?.yolo_foot_point_enabled ?? false));
        setYoloFootPointStyle(data?.yolo_foot_point_style === "square" ? "square" : "circle");
        setYoloFootPointColor(
          data?.yolo_foot_point_color === "blue" ? "blue" : data?.yolo_foot_point_color === "white" ? "white" : "green",
        );
        setMappedCamGridColor(
          data?.mapped_cam_grid_color === "green"
            ? "green"
            : data?.mapped_cam_grid_color === "blue"
              ? "blue"
              : "white",
        );
      } catch (e) {
        console.error(e);
        alert("保存失败，请稍后重试。");
      } finally {
        setSavingFootfallOverlay(false);
      }
    },
    [
      drawFootfallLineOverlay,
      mappedCamGridColor,
      yoloBoxColor,
      yoloBoxStyle,
      yoloFootPointColor,
      yoloFootPointEnabled,
      yoloFootPointStyle,
    ],
  );

  const toggleFootfallOverlay = useCallback(async (checked: boolean) => {
    setDrawFootfallLineOverlay(checked);
    await saveOverlayConfig({ draw_footfall_line_overlay: checked });
  }, [saveOverlayConfig]);

  const saveFaceRetention = useCallback(async () => {
    const days = Math.max(0, Math.min(3650, Math.floor(Number(faceRetentionDays) || 0)));
    setSavingFaceRetention(true);
    try {
      const r = await fetch(`${API_BASE}/api/admin/face-capture-retention`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: days }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`保存失败: ${data?.detail || r.status}`);
        return;
      }
      setFaceRetentionDays(Number(data?.retention_days ?? days));
      alert("人脸抓拍保留策略已保存。");
    } catch (e) {
      console.error(e);
      alert("保存失败，请稍后重试。");
    } finally {
      setSavingFaceRetention(false);
    }
  }, [faceRetentionDays]);

  const saveQueueWaitAnalysisConfig = useCallback(async () => {
    const sec = Math.max(0, Math.min(3600, Math.round(Number(postServiceQueueIgnoreSec) || 0)));
    const dsec = Math.max(0, Math.min(3600, Number(directServiceCompleteMinSec) || 0));
    const asec = Math.max(0, Math.min(3600, Number(abandonMinQueueSec) || 0));
    setSavingQueueWaitAnalysis(true);
    try {
      const r = await fetch(`${API_BASE}/api/admin/queue-wait-analysis-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post_service_queue_ignore_sec: sec,
          direct_service_complete_min_sec: dsec,
          abandon_min_queue_sec: asec,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`保存失败: ${data?.detail || r.status}`);
        return;
      }
      setPostServiceQueueIgnoreSec(Number(data?.post_service_queue_ignore_sec ?? sec));
      setDirectServiceCompleteMinSec(Number(data?.direct_service_complete_min_sec ?? dsec));
      setAbandonMinQueueSec(Number(data?.abandon_min_queue_sec ?? asec));
      alert("排队时长分析参数已保存（已进行的分析会话将立即使用新值）。");
    } catch (e) {
      console.error(e);
      alert("保存失败，请稍后重试。");
    } finally {
      setSavingQueueWaitAnalysis(false);
    }
  }, [postServiceQueueIgnoreSec, directServiceCompleteMinSec, abandonMinQueueSec]);

  return (
    <div className="min-w-0 space-y-6">
      <header className="border-b border-slate-100 pb-4">
        <h2 className="text-xl font-semibold text-slate-800">系统设置</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
          数据库运维、画面标注、业务策略与数据清理集中在本页。标题下方为区块目录，向下滚动时将固定在视口顶部以便快速跳转。清理类操作不可撤销，务必先备份。
        </p>
      </header>

      <div className="sticky top-0 z-20 -mx-4 border-b border-slate-200/80 bg-slate-50/95 px-4 py-2.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-slate-50/85">
        <nav aria-label="系统设置目录" className="flex flex-wrap gap-2 sm:flex-nowrap sm:overflow-x-auto sm:pb-0.5">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:text-[#5b3ff6]"
              onClick={() => scrollToSettingsSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="space-y-6">
        <section id="settings-db-stats" className="scroll-mt-24">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">数据库状态</span>
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => void refreshStats()}
                disabled={loadingStats}
              >
                {loadingStats ? "刷新中..." : "刷新"}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-800">全局统计</div>
                  <div className="shrink-0 text-[11px] text-slate-500">
                    {bytesText(globalStats?.db_file_size_bytes ?? null)}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <StatKpi label="热力事件总数" value={globalStats?.heatmap_events_count ?? "-"} />
                  <StatKpi label="人流事件总数" value={globalStats?.footfall_cross_events_count ?? "-"} />
                  <StatKpi label="排队时长记录" value={globalStats?.queue_wait_visits_count ?? "-"} />
                </div>
                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-xs font-semibold text-slate-800">时间范围（UTC 本地显示）</div>
                  <div className="space-y-1.5">
                    <StatRow label="热力最早时间" value={tsText(globalStats?.heatmap_min_ts ?? null)} />
                    <StatRow label="热力最新时间" value={tsText(globalStats?.heatmap_max_ts ?? null)} />
                    <div className="my-2 h-px bg-slate-100" />
                    <StatRow label="人流最早时间" value={tsText(globalStats?.footfall_min_ts ?? null)} />
                    <StatRow label="人流最新时间" value={tsText(globalStats?.footfall_max_ts ?? null)} />
                    <div className="my-2 h-px bg-slate-100" />
                    <StatRow label="排队记录最早（end_ts）" value={tsText(globalStats?.queue_wait_min_ts ?? null)} />
                    <StatRow label="排队记录最新（end_ts）" value={tsText(globalStats?.queue_wait_max_ts ?? null)} />
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <StatKpi label="热力事件数量" value={scopedStats?.heatmap_events_count ?? "-"} />
                  <StatKpi label="人流事件数量" value={scopedStats?.footfall_cross_events_count ?? "-"} />
                  <StatKpi label="排队时长记录" value={scopedStats?.queue_wait_visits_count ?? "-"} />
                </div>
                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-xs font-semibold text-slate-800">提示</div>
                  <div className="text-[11px] leading-relaxed text-slate-600">
                    下方「数据清理」与「按平面图」使用同一选择。建议先备份再清理。
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="settings-backup" className="scroll-mt-24">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-slate-800">数据库备份下载</div>
            <p className="mb-3 text-xs text-slate-500">
              下载当前 SQLite 数据库副本（.db）。建议在批量清理前先备份。
            </p>
            <button
              type="button"
              className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-60"
              onClick={() => void downloadBackup()}
              disabled={downloading}
            >
              {downloading ? "下载中..." : "下载数据库备份"}
            </button>
          </div>
        </section>

        <section id="settings-display" className="scroll-mt-24">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-1 text-sm font-semibold text-slate-800">人流量分析 · 画面与标注</div>
            <p className="mb-4 text-xs text-slate-500">
              仅影响摄像头 YOLO 叠加显示（判定线、检测框、脚部点、映射网格颜色），不参与业务统计计算。
            </p>

            <div className="space-y-5">
              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">显示开关</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!drawFootfallLineOverlay}
                      disabled={savingFootfallOverlay}
                      onChange={(e) => void toggleFootfallOverlay(!e.target.checked)}
                    />
                    <span>隐藏进出判定线（默认勾选）</span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!yoloFootPointEnabled}
                      disabled={savingFootfallOverlay}
                      onChange={(e) => {
                        const hideChecked = e.target.checked;
                        const enabled = !hideChecked;
                        setYoloFootPointEnabled(enabled);
                        void saveOverlayConfig({ yolo_foot_point_enabled: enabled });
                      }}
                    />
                    <span>隐藏脚部点（默认勾选）</span>
                  </label>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">YOLO 检测框</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-xs font-medium text-slate-600 sm:w-[5.5rem] sm:shrink-0">框样式</span>
                    <select
                      className="w-full max-w-xs rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      value={yoloBoxStyle}
                      disabled={savingFootfallOverlay}
                      onChange={(e) => {
                        const v = e.target.value === "corners_rounded" ? "corners_rounded" : "rect";
                        setYoloBoxStyle(v);
                        void saveOverlayConfig({ yolo_box_style: v });
                      }}
                    >
                      <option value="rect">矩形框</option>
                      <option value="corners_rounded">仅四角线段（圆角，默认）</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-xs font-medium text-slate-600 sm:w-[5.5rem] sm:shrink-0">框颜色</span>
                    <select
                      className="w-full max-w-xs rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      value={yoloBoxColor}
                      disabled={savingFootfallOverlay}
                      onChange={(e) => {
                        const v = e.target.value === "blue" ? "blue" : e.target.value === "white" ? "white" : "green";
                        setYoloBoxColor(v);
                        void saveOverlayConfig({ yolo_box_color: v });
                      }}
                    >
                      <option value="green">绿色</option>
                      <option value="blue">蓝色</option>
                      <option value="white">白色（默认）</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">脚部点</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-xs font-medium text-slate-600 sm:w-[5.5rem] sm:shrink-0">点样式</span>
                    <select
                      className="w-full max-w-xs rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      value={yoloFootPointStyle}
                      disabled={savingFootfallOverlay || !yoloFootPointEnabled}
                      onChange={(e) => {
                        const v = e.target.value === "square" ? "square" : "circle";
                        setYoloFootPointStyle(v);
                        void saveOverlayConfig({ yolo_foot_point_style: v });
                      }}
                    >
                      <option value="circle">圆形点</option>
                      <option value="square">正方形点</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-xs font-medium text-slate-600 sm:w-[5.5rem] sm:shrink-0">点颜色</span>
                    <select
                      className="w-full max-w-xs rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                      value={yoloFootPointColor}
                      disabled={savingFootfallOverlay || !yoloFootPointEnabled}
                      onChange={(e) => {
                        const v = e.target.value === "blue" ? "blue" : e.target.value === "white" ? "white" : "green";
                        setYoloFootPointColor(v);
                        void saveOverlayConfig({ yolo_foot_point_color: v });
                      }}
                    >
                      <option value="green">绿色（默认）</option>
                      <option value="blue">蓝色</option>
                      <option value="white">白色</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">映射画面</div>
                <div className="flex flex-col gap-1.5 sm:max-w-md sm:flex-row sm:items-center sm:gap-3">
                  <span className="text-xs font-medium text-slate-600 sm:w-[5.5rem] sm:shrink-0">网格线颜色</span>
                  <select
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs sm:flex-1"
                    value={mappedCamGridColor}
                    disabled={savingFootfallOverlay}
                    onChange={(e) => {
                      const v = e.target.value === "green" ? "green" : e.target.value === "blue" ? "blue" : "white";
                      setMappedCamGridColor(v);
                      void saveOverlayConfig({ mapped_cam_grid_color: v });
                    }}
                  >
                    <option value="white">白色（默认）</option>
                    <option value="green">绿色</option>
                    <option value="blue">蓝色</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="settings-face" className="scroll-mt-24">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-slate-800">人脸抓拍保留策略</div>
            <p className="mb-3 text-xs text-slate-500">
              设置抓拍图片在磁盘和数据库中的保留天数。0 表示不自动清理，建议生产环境设置为 30~180 天。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={0}
                max={3650}
                step={1}
                className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                value={faceRetentionDays}
                onChange={(e) => setFaceRetentionDays(Number(e.target.value || 0))}
                disabled={savingFaceRetention}
              />
              <span className="text-xs text-slate-600">天</span>
              <button
                type="button"
                className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-60"
                onClick={() => void saveFaceRetention()}
                disabled={savingFaceRetention}
              >
                {savingFaceRetention ? "保存中..." : "保存策略"}
              </button>
            </div>
          </div>
        </section>

        <section id="settings-queue-wait" className="scroll-mt-24">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-slate-800">排队时长分析 · 运行参数</div>
            <p className="mb-3 text-xs text-slate-500">
              参数落库于 <span className="font-mono text-[11px] text-slate-600">app_settings</span>
              ，分析进行中的会话会立即读新值。各环境变量名见对应输入说明；无数据库记录时以环境变量为默认。
            </p>
            <div className="mb-3 space-y-3 rounded border border-slate-100 bg-slate-50/80 p-3 text-xs text-slate-600">
              <p>
                <span className="font-mono text-[11px]">QUEUE_WAIT_POST_SERVICE_QUEUE_IGNORE_SEC</span>
                ：一次服务落库后的 N 秒内再踩排队区<strong className="font-medium text-slate-700">不开启新排队</strong>
                ，减轻「经排队区出门」误判弃单。<strong className="font-medium text-slate-700">0</strong> 为关闭。
              </p>
              <p>
                <span className="font-mono text-[11px]">QUEUE_WAIT_DIRECT_SERVICE_COMPLETE_MIN_SEC</span>
                ：脚底<strong className="font-medium text-slate-700">直接进入服务区</strong>
                （未计排队）时，仅当服务停留 ≥ N 秒并离开才落库并计入<strong className="font-medium text-slate-700">完成笔数</strong>。
              </p>
              <p>
                <span className="font-mono text-[11px]">QUEUE_WAIT_ABANDON_MIN_QUEUE_SEC</span>
                ：进排队区后<strong className="font-medium text-slate-700">未进服务区</strong>就离开：若排队停留 &lt; N
                秒则<strong className="font-medium text-slate-700">不落库、不计弃单</strong>（视作路过）。
                达到 N 秒后再离开仍按原逻辑计弃单。
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                <span className="shrink-0">服务后忽略排队区（秒）</span>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                  value={postServiceQueueIgnoreSec}
                  onChange={(e) => setPostServiceQueueIgnoreSec(Number(e.target.value || 0))}
                  disabled={savingQueueWaitAnalysis}
                />
              </label>
              <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                <span className="shrink-0">直进服务区成交最小服务（秒）</span>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                  value={directServiceCompleteMinSec}
                  onChange={(e) => setDirectServiceCompleteMinSec(Number(e.target.value || 0))}
                  disabled={savingQueueWaitAnalysis}
                />
              </label>
              <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                <span className="shrink-0">计弃单的最小排队停留（秒）</span>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                  value={abandonMinQueueSec}
                  onChange={(e) => setAbandonMinQueueSec(Number(e.target.value || 0))}
                  disabled={savingQueueWaitAnalysis}
                />
              </label>
              <button
                type="button"
                className="rounded bg-[#694FF9] px-3 py-1 text-xs font-medium text-white hover:bg-[#5b3ff6] disabled:opacity-60"
                onClick={() => void saveQueueWaitAnalysisConfig()}
                disabled={savingQueueWaitAnalysis}
              >
                {savingQueueWaitAnalysis ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </section>

        <section id="settings-purge" className="scroll-mt-24">
          <div className="rounded-xl border-2 border-rose-200 bg-gradient-to-b from-rose-50/90 to-white p-4 shadow-sm">
            <div className="mb-1 text-sm font-semibold text-rose-900">数据清理（不可撤销）</div>
            <p className="mb-3 text-xs text-rose-800/90">
              以下操作共用「清理范围」与「按平面图」与上方<strong className="font-medium">数据库状态</strong>中的选择一致：
              <span className="font-medium"> {selectedFloorPlanName || "（未选平面图）"}</span>。
            </p>
            <div className="mb-4 rounded-lg border border-rose-200 bg-white p-3">
              <div className="text-[11px] font-medium text-rose-900">共用选项</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-700">
                <span className="text-slate-600">清理范围</span>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
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
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                      value={purgeStartDate}
                      onChange={(e) => setPurgeStartDate(e.target.value)}
                    />
                    <span className="text-slate-500">至</span>
                    <input
                      type="date"
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                      value={purgeEndDate}
                      onChange={(e) => setPurgeEndDate(e.target.value)}
                    />
                  </>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-amber-900">热力图</div>
                <p className="mb-3 text-xs text-amber-900/90">
                  清理表 <code className="rounded bg-white/80 px-1 text-[10px]">heatmap_events</code>。
                </p>
                <button
                  type="button"
                  className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                  onClick={() => void purgeHeatmap()}
                  disabled={selectedFloorPlanId === "" || purgingHeatmap}
                >
                  {purgingHeatmap ? "清理中..." : "清理热力图历史"}
                </button>
              </div>

              <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-rose-900">人流量</div>
                <p className="mb-3 text-xs text-rose-900/90">
                  清理 <code className="rounded bg-white/80 px-1 text-[10px]">footfall_cross_events</code> 与抓拍表。
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
                    onClick={() => void purgeFootfall()}
                    disabled={selectedFloorPlanId === "" || purgingFootfall}
                  >
                    {purgingFootfall ? "清理中..." : "清理人流量历史"}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                    onClick={() => void reanalyzeFootfallFaceCaptures()}
                    disabled={selectedFloorPlanId === "" || reanalyzingFootfall}
                  >
                    {reanalyzingFootfall ? "重识别中..." : "重识别抓拍"}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-violet-200 bg-violet-50/80 p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-violet-900">排队时长</div>
                <p className="mb-3 text-xs text-violet-900/90">
                  清理 <code className="rounded bg-white/80 px-1 text-[10px]">queue_wait_visits</code>，不删 ROI。
                </p>
                <button
                  type="button"
                  className="rounded bg-violet-700 px-3 py-1 text-xs font-medium text-white hover:bg-violet-800 disabled:opacity-60"
                  onClick={() => void purgeQueueWait()}
                  disabled={selectedFloorPlanId === "" || purgingQueueWait}
                >
                  {purgingQueueWait ? "清理中..." : "清理排队时长历史"}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default SystemSettingsView;
