// GET /route — 무장애 경로와 일반 최단 경로 비교 (R-301, R-302)
// ?from=경도,위도 &to=경도,위도 &caution=true|false
import { badRequest, db, json, parseLonLat, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const q = new URL(req.url).searchParams;

  const from = parseLonLat(q.get("from"));
  const to = parseLonLat(q.get("to"));
  if (!from || !to) return badRequest("from, to는 '경도,위도' 형식이어야 합니다 (예: from=129.1149,37.5242)");
  const cautionParam = q.get("caution") ?? "true";
  if (!["true", "false"].includes(cautionParam)) return badRequest("caution은 true 또는 false입니다");

  const { data, error } = await db().rpc("route", {
    p_from_lon: from[0], p_from_lat: from[1], p_to_lon: to[0], p_to_lat: to[1],
    p_include_caution: cautionParam === "true",
  });
  if (error) return json({ error: "query_failed", message: error.message }, 500);
  return json(data, 200, { "Cache-Control": "no-store" });
});
