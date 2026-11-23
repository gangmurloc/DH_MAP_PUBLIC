// Vercel 함수: 음성 → 글자 (서버 STT). 로직은 server/stt.ts
//   POST /api/stt  (본문 = 녹음 바이트, Content-Type = audio/…) → { operationId }
//   GET  /api/stt?op=작업ID → { status, text? }
// ffmpeg 실행 파일은 ffmpeg-static (vercel.json functions.includeFiles로 함수 묶음에 넣는다)
import ffmpegPath from 'ffmpeg-static'
import { handleSttPoll, handleSttSubmit, sttEnv } from '../server/stt.js' // Node ESM: 확장자 필요 (빌드 후 .js)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

export async function POST(request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer())
  const out = await handleSttSubmit(body, request.headers.get('content-type') ?? undefined, sttEnv(process.env, ffmpegPath as unknown as string | null))
  return json(out.status, out.json)
}

export async function GET(request: Request): Promise<Response> {
  const out = await handleSttPoll(new URL(request.url).searchParams.get('op'), sttEnv(process.env, null))
  return json(out.status, out.json)
}
