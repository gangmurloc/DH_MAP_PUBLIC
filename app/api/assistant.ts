// Vercel 함수: AI 음성 길 안내 (POST { action: "parse", text } | { action: "answer", question, facts })
// 키(BAZE_API_KEY, KAKAO_REST_KEY)는 Vercel 프로젝트 환경 변수에만 둔다 (HANDOFF 10절). VITE_를 붙이지 않는다.
import { handleAssistant } from '../server/assistant.js' // Node ESM: 확장자 필요 (빌드 후 .js)

export async function POST(request: Request): Promise<Response> {
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    // handleAssistant가 bad_request로 답한다
  }
  const { status, json } = await handleAssistant(body, {
    bazeKey: process.env.BAZE_API_KEY,
    bazeBase: process.env.BAZE_BASE_URL,
    model: process.env.BAZE_MODEL,
    kakaoRestKey: process.env.KAKAO_REST_KEY,
  })
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}
