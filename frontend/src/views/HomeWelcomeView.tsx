import React, { useEffect, useState } from "react";
import { API_BASE } from "../shared/config";
import { TabKey } from "../shared/types";

type SystemStatus = {
  footfall_sessions: number;
  heatmap_floor_plans: number;
  inference_virtual_views: number;
  virtual_view_decode_streams: number;
};

type Props = {
  onOpenTab: (tab: TabKey) => void;
};

const POLL_MS = 4000;

/** 欢迎页卡片背景：将 PNG 放在 frontend/public/data/images/（访问路径 /data/images/…） */
const cardBg = (filename: string) => {
  const b = String(import.meta.env.BASE_URL || "/");
  const prefix = b.endsWith("/") ? b : `${b}/`;
  return `${prefix}data/images/${filename}`;
};

const HomeWelcomeView: React.FC<Props> = ({ onOpenTab }) => {
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const hr = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
        if (cancelled) return;
        setApiOk(hr.ok);
        if (hr.ok) {
          const sr = await fetch(`${API_BASE}/api/system/status`, { cache: "no-store" });
          if (cancelled) return;
          if (sr.ok) {
            const j = (await sr.json()) as SystemStatus;
            setStatus({
              footfall_sessions: Number(j.footfall_sessions) || 0,
              heatmap_floor_plans: Number(j.heatmap_floor_plans) || 0,
              inference_virtual_views: Number(j.inference_virtual_views) || 0,
              virtual_view_decode_streams: Number(j.virtual_view_decode_streams) || 0,
            });
          } else setStatus(null);
        } else setStatus(null);
      } catch {
        if (!cancelled) {
          setApiOk(false);
          setStatus(null);
        }
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const entries = [
    {
      tab: "heatmap" as const,
      title: "热力图",
      desc: "平面图热度聚合与多机位映射展示",
      bgUrl: cardBg("01_heatmap.png"),
      icon: (
        <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="2.2" fill="currentColor" />
          <circle cx="16" cy="8" r="3" fill="currentColor" className="opacity-80" />
          <circle cx="10" cy="15" r="3" fill="currentColor" className="opacity-55" />
          <circle cx="17" cy="16" r="2.2" fill="currentColor" className="opacity-40" />
        </svg>
      ),
    },
    {
      tab: "footfall" as const,
      title: "人流量",
      desc: "判定线过线与客流统计、分享大屏",
      bgUrl: cardBg("02_pepole.png"),
      icon: (
        <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" aria-hidden="true">
          <path d="M5 6v12M19 6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M8 9h8M8 15h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M11 7l-3 2 3 2M13 17l3-2-3-2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      tab: "mapping" as const,
      title: "虚拟视窗配置",
      desc: "映射管理：平面图与虚拟视窗绑定配置",
      bgUrl: cardBg("03_config.png"),
      icon: (
        <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" aria-hidden="true">
          <path
            d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-8 px-4 py-2 sm:px-5 md:px-6 lg:px-8">
      <header className="rounded-2xl border border-slate-200/90 bg-gradient-to-br from-white via-white to-slate-50 px-8 py-10 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#694FF9]">Welcome</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">NEXUS AI</h1>
        <p className="mt-3 max-w-xl text-base text-slate-600">智能空间定位分析</p>
      </header>

      <section>
        <h2 className="mb-4 text-sm font-semibold text-slate-800">快速入口</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {entries.map((it) => (
            <button
              key={it.tab}
              type="button"
              onClick={() => onOpenTab(it.tab)}
              className="group relative flex w-full min-h-0 flex-col justify-between overflow-hidden rounded-2xl border border-slate-200/90 bg-slate-100 p-5 text-left shadow-md transition hover:-translate-y-0.5 hover:shadow-lg sm:p-6 aspect-video"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center transition duration-500 ease-out group-hover:scale-105"
                style={{ backgroundImage: `url(${it.bgUrl})` }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-b from-white/15 via-white/35 to-white/80"
              />
              <div className="relative z-[2] flex min-h-0 flex-1 flex-col text-slate-900 [text-shadow:0_1px_2px_rgba(255,255,255,0.85)]">
                <span className="shrink-0 text-[#5639e0] [filter:drop-shadow(0_1px_1px_rgba(255,255,255,0.9))]">{it.icon}</span>
                <span className="mt-3 line-clamp-2 text-lg font-semibold tracking-tight">{it.title}</span>
                <span className="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-700 md:line-clamp-3">
                  {it.desc}
                </span>
              </div>
              <span className="relative z-[2] mt-3 shrink-0 text-xs font-semibold text-[#5639e0] [text-shadow:0_1px_2px_rgba(255,255,255,0.9)]">
                进入 →
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-slate-800">系统健康与运行状态</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
              apiOk === null
                ? "bg-slate-100 text-slate-600"
                : apiOk
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-red-100 text-red-800"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${apiOk === null ? "bg-slate-400" : apiOk ? "bg-emerald-500" : "bg-red-500"}`}
            />
            后端 API {apiOk === null ? "检测中…" : apiOk ? "在线" : "不可达"}
          </span>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3">
            <div className="text-[11px] font-medium text-slate-500">人流量分析会话</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
              {status != null ? status.footfall_sessions : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3">
            <div className="text-[11px] font-medium text-slate-500">热力图分析（平面图）</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
              {status != null ? status.heatmap_floor_plans : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3">
            <div className="text-[11px] font-medium text-slate-500">虚拟视窗分析任务</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
              {status != null ? status.inference_virtual_views : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3">
            <div className="text-[11px] font-medium text-slate-500">解码拉流（虚拟视窗）</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
              {status != null ? status.virtual_view_decode_streams : "—"}
            </div>
          </div>
        </div>
        <p className="mt-4 text-[11px] text-slate-500">
          数值每 {POLL_MS / 1000} 秒刷新。人流量会话与推理视窗可能对应同一虚拟视窗，分项含义不同。
        </p>
      </section>
    </div>
  );
};

export default HomeWelcomeView;
