import React, { useEffect, useState } from "react";

/** 数字切换时纵向滚入（与人流量分析累计进出一致） */
export const RollingNumber: React.FC<{ value: number; className?: string; durationMs?: number }> = ({
  value,
  className = "",
  durationMs = 260,
}) => {
  const [prev, setPrev] = useState<number>(value);
  const [animating, setAnimating] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (value === prev) return;
    setAnimating(true);
    setActive(false);
    const raf = window.requestAnimationFrame(() => setActive(true));
    const t = window.setTimeout(() => {
      setAnimating(false);
      setPrev(value);
      setActive(false);
    }, durationMs + 30);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [value, prev, durationMs]);

  if (!animating) return <div className={className}>{value}</div>;

  return (
    <div className={`relative overflow-hidden ${className}`} style={{ lineHeight: 1.15 }}>
      <div
        style={{
          transform: `translateY(${active ? "100%" : "0%"})`,
          opacity: active ? 0 : 1,
          transition: `transform ${durationMs}ms ease, opacity ${durationMs}ms ease`,
        }}
      >
        {prev}
      </div>
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translateY(${active ? "0%" : "-100%"})`,
          opacity: active ? 1 : 0,
          transition: `transform ${durationMs}ms ease, opacity ${durationMs}ms ease`,
        }}
      >
        {value}
      </div>
    </div>
  );
};
