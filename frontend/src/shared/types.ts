export type TabKey = "realtime" | "heatmap" | "people" | "footfall" | "mapping" | "settings";

export type ShareKind = "heatmap" | "people";
export type ShareRoute =
  | {
      kind: ShareKind;
      params: URLSearchParams;
    }
  | null;

export interface Camera {
  id: number;
  name: string;
  rtsp_url: string;
  enabled: boolean;
  description?: string | null;
  webrtc_url?: string | null;
}

export type HeatmapSource = {
  kind: "camera" | "virtual";
  camera_id: number;
  camera_name: string;
  webrtc_url?: string | null;
  virtual_view_id?: number | null;
  virtual_view_name?: string | null;
};

export type Footfall = { row: number; col: number; ts: number };

export interface FloorPlan {
  id: number;
  name: string;
  image_path: string;
  width_px: number;
  height_px: number;
  grid_rows: number;
  grid_cols: number;
}

export interface CameraVirtualView {
  id: number;
  camera_id: number;
  name: string;
  enabled: boolean;
  yaw_deg: number;
  pitch_deg: number;
  fov_deg: number;
  out_w: number;
  out_h: number;
}

export interface VirtualViewCellMapping {
  id: number;
  virtual_view_id: number;
  floor_plan_id: number;
  camera_row: number;
  camera_col: number;
  floor_row: number;
  floor_col: number;
}

export type Pt = { x: number; y: number };
