/// <reference types="node" />
// 음성 → 글자 (서버 STT). 쓰는 곳: Vercel 함수 app/api/stt.ts(배포), Vite 개발 서버(/api/stt).
// 흐름: 녹음 파일 받기 → FFmpeg 정규화(16kHz·모노·16bit PCM WAV, 음량·잡음·앞쪽 무음) → BAZE 게이트웨이 STT 작업 올리기
//       → 브라우저가 작업 ID로 결과를 확인 (STT가 비동기라 서버 함수를 오래 붙잡지 않는다)
// BAZE STT 문서 (2026-11-21 확인): https://docs.mindlogic.ai/docs/puts/gateway/api-reference/audio-stt
//   POST {base}/audio/transcriptions/ (multipart: file, model=stt-async-v5, language_hints, enable_speaker_diarization)
//   GET  {base}/audio/transcriptions/{operation_id}/ → status processing|completed|failed, completed면 text
//   webm은 거부된다(길이를 못 읽음) → 정규화가 꼭 필요. 요금: 오디오 1분당 6크레딧, 올릴 때 청구. 결과는 1시간 보관
// 개인정보: 음성·인식 글자를 저장하거나 로그에 남기지 않는다. 임시 파일은 바로 지운다.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STT_LIMITS = {
  /** 받는 녹음 파일 최대 크기 */
  maxBytes: 2_000_000,
  /** 정규화 뒤 최대 길이 초 */
  maxSec: 30,
  /** FFmpeg 실행 시간 제한 */
  ffmpegTimeoutMs: 10_000,
  /** 작업을 올린 뒤 서버가 결과를 기다리는 최대 시간 (Vercel 함수 maxDuration 30초 안) */
  serverWaitMs: 12_000,
  /** 서버가 결과를 다시 묻는 간격 (BAZE 결과 확인 한 번에 약 1.5초가 걸려, 실제 간격은 더 길다. 분당 120회 한도 안) */
  serverPollMs: 300,
}

export const STT_MODEL = 'stt-async-v5'

export interface SttEnv {
  bazeKey?: string
  bazeBase?: string
  /** ffmpeg 실행 파일 경로 (ffmpeg-static) */
  ffmpegPath?: string | null
}

export interface SttResult {
  status: number
  json: unknown
}

/** FFmpeg 인자: 입력 → 16kHz 모노 16bit PCM WAV. 사용자 값은 넣지 않는다(파일 경로만) */
export function buildFfmpegArgs(input: string, output: string, maxSec = STT_LIMITS.maxSec): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-t', String(maxSec),
    '-vn', '-ac', '1', '-ar', '16000',
    // 저음(바람·차)·고음 잡음 깎기 → 음량 맞추기 → 앞쪽 무음 자르기(0.2초 남김)
    // → 뒤집어서 같은 방법으로 뒤쪽 무음 자르기(말끝이 잘리지 않게 0.4초 남김) → 다시 뒤집기. 보내는 길이가 줄어 STT가 빨라지고 요금도 준다
    '-af', [
      'highpass=f=80',
      'lowpass=f=7600',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2',
      'areverse',
      'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.4',
      'areverse',
    ].join(','),
    '-c:a', 'pcm_s16le', '-f', 'wav',
    output,
  ]
}

/** 받은 녹음 검사. 문제가 있으면 이유, 없으면 null */
export function checkUpload(contentType: string | undefined, size: number): string | null {
  if (!size) return '녹음이 비어 있어요'
  if (size > STT_LIMITS.maxBytes) return `녹음이 너무 커요 (최대 ${STT_LIMITS.maxBytes / 1_000_000}MB)`
  if (!contentType || !contentType.toLowerCase().startsWith('audio/')) return '오디오 파일이 아니에요'
  return null
}

/** WAV 머리글(44바이트)에서 채널·표본율·비트 읽기 (정규화 확인용) */
export function wavInfo(buf: Uint8Array): { channels: number; sampleRate: number; bits: number; seconds: number } | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (buf.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  // fmt·data 덩어리 찾기 (FFmpeg는 LIST 덩어리를 끼워 넣을 수 있다)
  let o = 12
  let fmt: { channels: number; sampleRate: number; bits: number; byteRate: number } | null = null
  let dataLen = 0
  while (o + 8 <= buf.length) {
    const id = tag(o)
    const len = v.getUint32(o + 4, true)
    if (id === 'fmt ') fmt = { channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), byteRate: v.getUint32(o + 16, true), bits: v.getUint16(o + 22, true) }
    if (id === 'data') {
      dataLen = Math.min(len, buf.length - o - 8)
      break
    }
    o += 8 + len + (len % 2)
  }
  if (!fmt) return null
  return { channels: fmt.channels, sampleRate: fmt.sampleRate, bits: fmt.bits, seconds: fmt.byteRate ? dataLen / fmt.byteRate : 0 }
}

/** FFmpeg로 정규화. 임시 파일은 끝나면 지운다 */
export async function normalize(audio: Uint8Array, ffmpegPath: string): Promise<Uint8Array> {
  const id = randomUUID()
  const input = join(tmpdir(), `stt-${id}.in`)
  const output = join(tmpdir(), `stt-${id}.wav`)
  try {
    await writeFile(input, audio)
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath, buildFfmpegArgs(input, output), { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', (d) => (err = (err + String(d)).slice(-500)))
      const timer = setTimeout(() => {
        p.kill('SIGKILL')
        reject(new Error('소리 변환 시간이 너무 오래 걸려요'))
      }, STT_LIMITS.ffmpegTimeoutMs)
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`소리 변환 프로그램을 실행하지 못했어요 (${e.message})`))
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        // 오류 문구에서 서버 임시 파일 경로는 뺀다 (사용자에게 필요 없는 정보)
        const last = err.trim().split('\n').pop()?.replace(/\S*stt-[\w-]+\.(in|wav):?\s*/g, '').trim()
        if (code === 0) resolve()
        else reject(new Error(`녹음을 읽지 못했어요${last ? ` (${last})` : ''}`))
      })
    })
    return new Uint8Array(await readFile(output))
  } finally {
    await Promise.all([unlink(input).catch(() => {}), unlink(output).catch(() => {})])
  }
}

const base = (env: SttEnv) => (env.bazeBase ?? 'https://factchat-cloud.mindlogic.ai/v1/gateway').replace(/\/+$/, '')

/** POST /api/stt: 녹음 받기 → 정규화 → STT 작업 올리기 → 결과까지 기다리기(최대 serverWaitMs)
 *  → { operationId, seconds, status: 'completed', text } | { …, status: 'failed', message } | { …, status: 'processing' }(브라우저가 이어서 확인) */
export async function handleSttSubmit(body: Uint8Array, contentType: string | undefined, env: SttEnv): Promise<SttResult> {
  const bad = checkUpload(contentType, body.byteLength)
  if (bad) return { status: 400, json: { error: 'bad_request', message: bad } }
  if (!env.bazeKey) return { status: 503, json: { error: 'no_key', message: '음성 인식 키가 없어요' } }
  if (!env.ffmpegPath) return { status: 503, json: { error: 'no_ffmpeg', message: '소리 변환 프로그램이 없어요' } }
  let wav: Uint8Array
  try {
    wav = await normalize(body, env.ffmpegPath)
  } catch (e) {
    return { status: 400, json: { error: 'bad_audio', message: (e as Error).message } }
  }
  const info = wavInfo(wav)
  if (!info || info.seconds < 0.3) return { status: 400, json: { error: 'too_short', message: '말소리가 들리지 않아요. 다시 말해 주세요' } }

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav')
  form.append('model', STT_MODEL)
  form.append('language_hints', 'ko')
  form.append('enable_speaker_diarization', 'false')
  const res = await fetch(`${base(env)}/audio/transcriptions/`, { method: 'POST', headers: { Authorization: `Bearer ${env.bazeKey}` }, body: form })
  const d = (await res.json().catch(() => null)) as { operation_id?: string; status?: string; error?: unknown; message?: unknown } | null
  if (!res.ok || !d?.operation_id) {
    return { status: 502, json: { error: 'stt_failed', message: `음성 인식을 시작하지 못했어요 (${res.status}${d?.message || d?.error ? `: ${String(d.message ?? d.error)}` : ''})` } }
  }
  const op = d.operation_id
  const seconds = Math.round(info.seconds * 10) / 10
  // 서버가 바로 결과를 확인해 기다린다 (브라우저가 쉬었다가 다시 묻는 왕복을 없앰). 시간 안에 안 끝나면 작업 ID만 주고 브라우저가 이어서 확인
  const until = Date.now() + STT_LIMITS.serverWaitMs
  while (Date.now() < until) {
    const p = await handleSttPoll(op, env).catch(() => null)
    const j = p?.json as { status?: string } | undefined
    if (!p || p.status !== 200) break // 오류(429 등)는 브라우저 확인으로 넘긴다
    if (j?.status === 'completed' || j?.status === 'failed') return { status: 200, json: { operationId: op, seconds, ...(p.json as object) } }
    await new Promise((r) => setTimeout(r, STT_LIMITS.serverPollMs))
  }
  return { status: 200, json: { operationId: op, seconds, status: 'processing' } }
}

/** GET /api/stt?op=…: 작업 결과 확인 → { status: 'processing' } | { status: 'completed', text } | { status: 'failed', message } */
export async function handleSttPoll(op: string | null, env: SttEnv): Promise<SttResult> {
  // 작업 ID는 BAZE가 준 값(예: soniox:uuid:hex)만 받는다
  if (!op || !/^[A-Za-z0-9:_-]{8,200}$/.test(op)) return { status: 400, json: { error: 'bad_request', message: '작업 ID가 올바르지 않아요' } }
  if (!env.bazeKey) return { status: 503, json: { error: 'no_key', message: '음성 인식 키가 없어요' } }
  const res = await fetch(`${base(env)}/audio/transcriptions/${encodeURIComponent(op)}/`, { headers: { Authorization: `Bearer ${env.bazeKey}` } })
  const d = (await res.json().catch(() => null)) as { status?: string; text?: string; error?: unknown } | null
  if (!res.ok || !d?.status) return { status: 502, json: { error: 'stt_failed', message: `음성 인식 결과를 받지 못했어요 (${res.status})` } }
  if (d.status === 'completed') return { status: 200, json: { status: 'completed', text: (d.text ?? '').trim() } }
  if (d.status === 'failed') return { status: 200, json: { status: 'failed', message: `음성 인식 실패${d.error ? ` (${String(d.error)})` : ''}` } }
  return { status: 200, json: { status: 'processing' } }
}

export function sttEnv(env: Record<string, string | undefined>, ffmpegPath: string | null): SttEnv {
  return { bazeKey: env.BAZE_API_KEY, bazeBase: env.BAZE_BASE_URL, ffmpegPath }
}
