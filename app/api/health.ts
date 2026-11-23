// Vercel 함수: 상태 확인 (UptimeRobot 5분 조회용). 로직은 server/publicApi.ts
import { apiEnv, CORS, handleHealth } from '../server/publicApi.js' // Node ESM: 확장자 필요 (빌드 후 .js)

export async function GET(): Promise<Response> {
  const out = await handleHealth(apiEnv(process.env))
  return new Response(JSON.stringify(out.json), {
    status: out.status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
