import { ShareKind, ShareRoute } from "./types";

export function parseShareRoute(hash: string): ShareRoute {
  const h = String(hash || "");
  if (!h.startsWith("#/share/")) return null;
  const rest = h.slice("#/share/".length);
  const [pathPart, queryPart] = rest.split("?", 2);
  const kind = pathPart === "heatmap" || pathPart === "people" ? (pathPart as ShareKind) : null;
  if (!kind) return null;
  return { kind, params: new URLSearchParams(queryPart || "") };
}
