// Vercel 함수: 공개 GeoJSON API (R-501). 로직은 server/publicApi.ts
import { apiEnv, CORS, handleFeatures } from '../server/publicApi.js' // Node ESM: 확장자 필요 (빌드 후 .js)

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(request: Request): Promise<Response> {
  const out = await handleFeatures(new URL(request.url).searchParams, apiEnv(process.env))
  return new Response(JSON.stringify(out.json), {
    status: out.status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...(out.headers ?? {}) },
  })
}
