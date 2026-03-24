export const API_BASE =
  import.meta.env.VITE_API_BASE ||
  window.location.protocol + "//" + window.location.hostname + ":18080";

export const POI_ICON_URL = `${API_BASE}/icons/poi.png`;

export const MEDIA_HOST =
  import.meta.env.VITE_MEDIA_HOST || window.location.hostname;
export const MEDIA_RTSP_PORT = Number(import.meta.env.VITE_MEDIA_RTSP_PORT || "8554");
export const MEDIA_WEBRTC_PORT = Number(
  import.meta.env.VITE_MEDIA_WEBRTC_PORT || "8889",
);
