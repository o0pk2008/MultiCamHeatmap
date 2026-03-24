import { Pt } from "./types";

export function orderQuad(points: Pt[]): Pt[] {
  if (points.length !== 4) return points;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return [...sorted.slice(best), ...sorted.slice(0, best)];
}

export function bilinear(quad: Pt[], u: number, v: number): Pt {
  const p00 = quad[0];
  const p10 = quad[1];
  const p11 = quad[2];
  const p01 = quad[3];
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = u * v;
  const d = (1 - u) * v;
  return {
    x: a * p00.x + b * p10.x + c * p11.x + d * p01.x,
    y: a * p00.y + b * p10.y + c * p11.y + d * p01.y,
  };
}

export function computeHomography(src: Pt[], dst: Pt[]): number[] | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const u = src[i].x;
    const v = src[i].y;
    const x = dst[i].x;
    const y = dst[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const M = A.map((row, i) => [...row, b[i]]);
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const h = M.map((row) => row[n]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H: number[], p: Pt): Pt {
  const u = p.x;
  const v = p.y;
  const x = H[0] * u + H[1] * v + H[2];
  const y = H[3] * u + H[4] * v + H[5];
  const w = H[6] * u + H[7] * v + H[8];
  const iw = Math.abs(w) < 1e-9 ? 1e-9 : w;
  return { x: x / iw, y: y / iw };
}

export function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function worldToImagePoint(
  world: Pt,
  viewport: { w: number; h: number; aspectW: number; aspectH: number },
  opts?: { allowOutside?: boolean },
): Pt | null {
  const { w, h, aspectW, aspectH } = viewport;
  if (!w || !h || !aspectW || !aspectH) return null;
  const scale = Math.min(w / aspectW, h / aspectH);
  const imgW = aspectW * scale;
  const imgH = aspectH * scale;
  const imgX = (w - imgW) / 2;
  const imgY = (h - imgH) / 2;
  const x = world.x - imgX;
  const y = world.y - imgY;
  const allowOutside = !!opts?.allowOutside;
  if (!allowOutside && (x < 0 || y < 0 || x > imgW || y > imgH)) return null;
  return { x: (x / imgW) * aspectW, y: (y / imgH) * aspectH };
}
