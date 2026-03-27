import React from "react";
import { TabKey } from "../shared/types";

type SidebarTabButtonProps = {
  label: string;
  icon: React.ReactNode;
  tab: TabKey;
  activeTab: TabKey;
  collapsed?: boolean;
  onChange: (t: TabKey) => void;
};

const SidebarTabButton: React.FC<SidebarTabButtonProps> = ({
  label,
  icon,
  tab,
  activeTab,
  collapsed = false,
  onChange,
}) => (
  <button
    onClick={() => onChange(tab)}
    title={collapsed ? label : undefined}
    className={`flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium transition ${
      activeTab === tab
        ? "bg-[#694FF9] text-white shadow-sm"
        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
    }`}
  >
    <span className={`${collapsed ? "mx-auto" : ""}`}>{icon}</span>
    {!collapsed && <span className="ml-2">{label}</span>}
    {!collapsed && (
      <span
        className={`ml-auto text-xs ${
          activeTab === tab ? "text-white/80" : "text-slate-400"
        }`}
      >
        →
      </span>
    )}
  </button>
);

export default SidebarTabButton;
