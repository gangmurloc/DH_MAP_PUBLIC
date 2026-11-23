// GET /features — 공개 GeoJSON (R-501)
// ?layer=segments|obstacles|crossings|places &bbox=서경,남위,동경,북위 &grade=passable,caution &status=verified &since=ISO8601 &limit=1..1000
import { badRequest, db, geojson, json, LICENSE, preflight } from "../_shared/http.ts";

const LAYERS = ["segments", "obstacles", "crossings", "places"] as const;
const GRADES = ["unsurveyed", "passable", "caution", "difficult"];
const STATUSES = ["reported", "confirmed", "verified", "resolved"]; // hidden은 공개하지 않음

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const q = new URL(req.url).searchParams;

  const layer = (q.get("layer") ?? "segments") as (typeof LAYERS)[number];
  if (!LAYERS.includes(layer)) return badRequest(`layer는 ${LAYERS.join(", ")} 중 하나여야 합니다`);

  let bbox: number[] | null = null;
  if (q.get("bbox")) {
    bbox = q.get("bbox")!.split(",").map(Number);
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      return badRequest("bbox는 서경,남위,동경,북위 순서의 숫자 4개여야 합니다");
    }
  }
  const grade = list(q.get("grade"));
  if (grade && grade.some((g) => !GRADES.includes(g))) return badRequest(`grade는 ${GRADES.join(", ")} 중에서 고릅니다`);
  const status = list(q.get("status"));
  if (status && status.some((s) => !STATUSES.includes(s))) return badRequest(`status는 ${STATUSES.join(", ")} 중에서 고릅니다`);
  const since = q.get("since");
  if (since && Number.isNaN(Date.parse(since))) return badRequest("since는 ISO 8601 날짜여야 합니다 (예: 2026-11-20)");
  const limit = q.get("limit") ? Number(q.get("limit")) : 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return badRequest("limit는 1~1000 사이 정수입니다");

  const { data, error } = await db().rpc("features", {
    p_bbox: bbox, p_layer: layer, p_grade: grade, p_status: status, p_since: since, p_limit: limit,
  });
  if (error) return json({ error: "query_failed", message: error.message }, 500);

  const fc = data as { type: string; features: unknown[] };
  return geojson(
    { ...fc, license: LICENSE[layer], count: fc.features.length, truncated: fc.features.length === limit },
    { "Cache-Control": "public, max-age=60" },
  );
});
