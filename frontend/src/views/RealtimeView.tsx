import React, { useEffect, useState } from "react";
import { API_BASE } from "../shared/config";
import { Camera } from "../shared/types";

const RealtimeView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`${API_BASE}/api/cameras/`);
      const data: Camera[] = await res.json();
      setCameras(data);
    };
    load();
  }, []);

  const enabled = cameras.filter((c) => c.enabled && c.webrtc_url);
  const display = enabled.slice(0, 9);

  if (display.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        暂无可用的摄像头画面，请先在“摄像头管理”中添加并启用摄像头，并配置 WebRTC 播放地址。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold text-slate-800">实时画面（最多 9 路）</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {display.map((cam) => (
          <div
            key={cam.id}
            className="overflow-hidden rounded-lg border border-slate-200 bg-black shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
              <span className="font-semibold">{cam.name}</span>
              <span className="text-slate-400">ID: {cam.id}</span>
            </div>
            <div className="aspect-video w-full bg-black">
              {cam.webrtc_url ? (
                <iframe
                  src={cam.webrtc_url}
                  className="h-full w-full border-none"
                  allow="autoplay; fullscreen"
                  title={`camera-${cam.id}`}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs text-slate-200">
                  未配置 WebRTC 地址
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RealtimeView;
