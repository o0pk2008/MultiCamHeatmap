import React from "react";
import { TabKey } from "../shared/types";

type SidebarTabButtonProps = {
  label: string;
  tab: TabKey;
  activeTab: TabKey;
  onChange: (t: TabKey) => void;
};

const SidebarTabButton: React.FC<SidebarTabButtonProps> = ({ label, tab, activeTab, onChange }) => (
  <button
    onClick={() => onChange(tab)}
    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
      activeTab === tab
        ? "bg-[#694FF9] text-white shadow-sm"
        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
    }`}
  >
    <span>{label}</span>
    <span
      className={`text-xs ${
        activeTab === tab ? "text-white/80" : "text-slate-400"
      }`}
    >
      →
    </span>
  </button>
);

export default SidebarTabButton;
