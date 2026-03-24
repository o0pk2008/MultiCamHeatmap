import { API_BASE } from "./config";
import { FloorPlan } from "./types";

export function floorPlanImageUrl(fp: FloorPlan): string {
  return fp.image_path.startsWith("/data/maps/")
    ? `${API_BASE}/maps/${fp.image_path.split("/").pop()}`
    : fp.image_path;
}

const floorPlanImageCache = new Map<string, HTMLImageElement>();
const floorPlanImagePromiseCache = new Map<string, Promise<HTMLImageElement>>();

export function preloadFloorPlanImage(url: string): Promise<HTMLImageElement> {
  const cached = floorPlanImageCache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = floorPlanImagePromiseCache.get(url);
  if (existing) return existing;

  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      floorPlanImageCache.set(url, img);
      floorPlanImagePromiseCache.delete(url);
      resolve(img);
    };
    img.onerror = (e) => {
      floorPlanImagePromiseCache.delete(url);
      reject(e);
    };
    img.src = url;
  });

  floorPlanImagePromiseCache.set(url, p);
  return p;
}

const poiIconCache = new Map<string, HTMLImageElement>();
const poiIconPromiseCache = new Map<string, Promise<HTMLImageElement>>();

export function preloadPoiIcon(url: string): Promise<HTMLImageElement> {
  const cached = poiIconCache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = poiIconPromiseCache.get(url);
  if (existing) return existing;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      poiIconCache.set(url, img);
      poiIconPromiseCache.delete(url);
      resolve(img);
    };
    img.onerror = (e) => {
      poiIconPromiseCache.delete(url);
      reject(e);
    };
    img.src = url;
  });
  poiIconPromiseCache.set(url, p);
  return p;
}
