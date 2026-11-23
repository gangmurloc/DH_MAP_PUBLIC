// 공개 API 공통: CORS, JSON 응답, DB 클라이언트
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

export function geojson(body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/geo+json; charset=utf-8", ...extra },
  });
}

export function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, 400);
}

// service_role 키는 Edge Function 환경 변수에만 있다 (브라우저에 넣지 않음, TECH_SPEC 2절)
export function db() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  return null;
}

// "경도,위도" → [lon, lat]
export function parseLonLat(v: string | null): [number, number] | null {
  if (!v) return null;
  const parts = v.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lon, lat] = parts;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

export const LICENSE = {
  segments: "구간 형상: 국토지리정보원 수치지도(공공누리 제1유형, 출처 표시). 조사 데이터: 동해 무장애지도",
  obstacles: "동해 무장애지도 조사단 (공개 라이선스 동의 제보 포함)",
  crossings: "전국횡단보도표준데이터(공공데이터포털)를 구간망 노드에 연결",
  places: "국토지리정보원 수치지도 건물 이름·철도역 (공공누리 제1유형, 출처 표시)",
};
