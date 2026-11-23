// AI 음성 길 안내: POST { action: "parse", text } | { action: "answer", question, facts }
// 키(BAZE_API_KEY, KAKAO_REST_KEY)는 Supabase Edge Function Secrets에만 둔다 (HANDOFF 10절)
// 예비 경로: 배포는 Vercel 함수(app/api/assistant.ts)로 한다 (11/20). 이 함수로 바꿀 때는 공용 로직 파일 위치를 확인할 것
import { handleAssistant } from "../../../app/server/assistant.ts";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
  }
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // 아래에서 bad_request
  }
  const { status, json } = await handleAssistant(body, {
    bazeKey: Deno.env.get("BAZE_API_KEY"),
    bazeBase: Deno.env.get("BAZE_BASE_URL"),
    model: Deno.env.get("BAZE_MODEL"),
    kakaoRestKey: Deno.env.get("KAKAO_REST_KEY"),
  });
  return new Response(JSON.stringify(json), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
});
