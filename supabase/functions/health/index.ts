// GET /health — UptimeRobot 전용 (TECH_SPEC 10절: /features가 아니라 이것만 5분마다 호출)
import { db, json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const { data, error } = await db().rpc("health");
  if (error || data !== true) return json({ ok: false }, 503, { "Cache-Control": "no-store" });
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
});
