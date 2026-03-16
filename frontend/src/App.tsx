import React, { useEffect, useState } from "react";

type TabKey = "realtime" | "heatmap" | "cameras" | "mapping";

// 后端 API 基础地址：优先使用环境变量，未配置时退回到当前主机的 18080 端口
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  window.location.protocol + "//" + window.location.hostname + ":18080";

// mediamtx 转发服务地址（按你的规则生成 CameraXX）
// 从 Vite 环境变量中读取，便于通过 .env 配置：
// VITE_MEDIA_HOST=192.168.2.94
// VITE_MEDIA_RTSP_PORT=8554
// VITE_MEDIA_WEBRTC_PORT=8889
const MEDIA_HOST =
  import.meta.env.VITE_MEDIA_HOST || window.location.hostname;
const MEDIA_RTSP_PORT = Number(import.meta.env.VITE_MEDIA_RTSP_PORT || "8554");
const MEDIA_WEBRTC_PORT = Number(
  import.meta.env.VITE_MEDIA_WEBRTC_PORT || "8889",
);

interface Camera {
  id: number;
  name: string;
  rtsp_url: string;
  enabled: boolean;
  description?: string | null;
  webrtc_url?: string | null;
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("realtime");

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>MultiCam Heatmap</h1>

      <div style={{ marginBottom: 16 }}>
        <TabButton label="实时画面" tab="realtime" activeTab={activeTab} onChange={setActiveTab} />
        <TabButton label="热力图" tab="heatmap" activeTab={activeTab} onChange={setActiveTab} />
        <TabButton label="摄像头管理" tab="cameras" activeTab={activeTab} onChange={setActiveTab} />
        <TabButton label="映射管理" tab="mapping" activeTab={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === "realtime" && <RealtimeView />}
      {activeTab === "heatmap" && <HeatmapView />}
      {activeTab === "cameras" && <CameraManageView />}
      {activeTab === "mapping" && <MappingView />}
    </div>
  );
};

const TabButton: React.FC<{
  label: string;
  tab: TabKey;
  activeTab: TabKey;
  onChange: (t: TabKey) => void;
}> = ({ label, tab, activeTab, onChange }) => (
  <button
    onClick={() => onChange(tab)}
    style={{
      marginRight: 8,
      padding: "6px 14px",
      borderRadius: 4,
      border: "1px solid #ccc",
      backgroundColor: activeTab === tab ? "#1677ff" : "#f5f5f5",
      color: activeTab === tab ? "#fff" : "#000",
      cursor: "pointer",
    }}
  >
    {label}
  </button>
);

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

const HeatmapView: React.FC = () => {
  return <p>这里将来显示平面图上的实时热力图（暂为占位）。</p>;
};

const MappingView: React.FC = () => {
  return <p>这里将来做摄像头与平面图映射（标定）管理（暂为占位）。</p>;
};

const CameraManageView: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [webrtcUrl, setWebrtcUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [description, setDescription] = useState("");
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
      <h2 className="text-xl font-semibold text-slate-800">摄像头管理</h2>

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
              className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
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
                      className="rounded border border-blue-500 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50"
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
              className="mt-1 inline-flex items-center rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
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
                </tr>
              ))}
              {cameras.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
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
    </div>
  );
};

export default App;