// 말로 검색: 마이크 녹음(MediaRecorder) → 서버 /api/stt (FFmpeg 정규화 → BAZE STT) → 글자
// 2026-11-21 팀 결정: 브라우저 음성 인식(Web Speech API)을 없애고 이 방식으로 교체 (팀 설계 문서)
// 빠르게 (11/21): 말이 끝나고 조용하면 녹음이 저절로 멈추고, 서버가 결과까지 기다렸다가 돌려준다
// 녹음은 글자로 바꾸는 데만 쓰고 앱·서버에 저장하지 않는다.

export const MAX_RECORD_SEC = 30
/** 말이 끝난 뒤 이만큼 조용하면 저절로 멈춤 */
const SILENCE_STOP_MS = 1000
/** 말을 시작하지 않고 이만큼 지나면 멈춤 (빈 녹음을 30초 기다리지 않게) */
const NO_SPEECH_STOP_MS = 7000
const POLL_MS = 1000
const POLL_LIMIT_MS = 40_000

/** 녹음할 수 있는 브라우저인가 (마이크 + MediaRecorder) */
export function recordSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined'
}

/** 브라우저가 지원하는 녹음 형식 (서버가 어떤 형식이든 WAV로 바꾼다) */
function pickMime(): string | undefined {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t
  }
  return undefined
}

export interface Recording {
  /** 녹음 멈추기 (멈추면 result가 끝난다) */
  stop: () => void
  /** 녹음 결과 */
  result: Promise<Blob>
}

type AudioCtx = typeof AudioContext

/** 소리 크기를 보고 말이 끝나면 stop을 부른다. 소리를 못 읽는 브라우저면 아무 일도 하지 않는다 (손으로 멈춤·30초 제한은 그대로) */
function watchSilence(ctx: AudioContext | null, stream: MediaStream, stop: () => void): () => void {
  if (!ctx) return () => {}
  let src: MediaStreamAudioSourceNode
  try {
    src = ctx.createMediaStreamSource(stream)
  } catch {
    return () => {}
  }
  const an = ctx.createAnalyser()
  an.fftSize = 1024
  src.connect(an)
  const buf = new Float32Array(an.fftSize)
  const started = performance.now()
  let floor = 0 // 처음 0.3초로 잡은 주변 소음 크기
  let floorN = 0
  let spoke = false
  let quietSince = 0
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const rms = Math.sqrt(sum / buf.length)
    const now = performance.now()
    if (now - started < 300) {
      floor = (floor * floorN + rms) / ++floorN
      return
    }
    const loud = rms > Math.max(0.015, floor * 3)
    if (loud) {
      spoke = true
      quietSince = 0
    } else if (spoke) {
      quietSince ||= now
      if (now - quietSince >= SILENCE_STOP_MS) stop()
    } else if (now - started >= NO_SPEECH_STOP_MS) stop()
  }, 100)
  return () => {
    clearInterval(timer)
    try {
      src.disconnect()
    } catch {
      // 이미 끊김
    }
  }
}

/** 녹음 시작. 아이폰은 버튼을 누른 처리 안에서 바로 불러야 권한을 묻는다.
 *  말이 끝나고 1초 조용하면, 또는 maxSec이 지나면 저절로 멈춘다 */
export async function startRecording(maxSec = MAX_RECORD_SEC): Promise<Recording> {
  // 소리 크기 읽기용: 아이폰 사파리는 버튼 누른 처리 안에서 만들어야 해서 마이크 권한을 묻기 전에 만든다
  const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtx }).webkitAudioContext) as AudioCtx | undefined
  let ctx: AudioContext | null = null
  try {
    ctx = Ctx ? new Ctx() : null
  } catch {
    ctx = null
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    void ctx?.close()
    const name = (e as DOMException).name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('마이크 권한이 꺼져 있어요. 브라우저 설정에서 허용하거나 글자로 입력해 주세요.')
    if (name === 'NotFoundError') throw new Error('마이크를 찾지 못했어요. 글자로 입력해 주세요.')
    throw new Error('마이크를 켜지 못했어요. 글자로 입력해 주세요.')
  }
  void ctx?.resume().catch(() => {})
  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stop = () => rec.state !== 'inactive' && rec.stop()
  const unwatch = watchSilence(ctx, stream, stop)
  const timer = setTimeout(stop, maxSec * 1000)
  const cleanup = () => {
    clearTimeout(timer)
    unwatch()
    stream.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
  }
  const result = new Promise<Blob>((resolve, reject) => {
    rec.onstop = () => {
      cleanup()
      resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }))
    }
    rec.onerror = () => {
      cleanup()
      reject(new Error('녹음 중 문제가 생겼어요. 다시 눌러 말해 주세요.'))
    }
  })
  rec.start()
  return { stop, result }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

/** 서버 응답 하나에서 결과 꺼내기: 글자면 반환, 실패면 오류, 아직이면 null */
function settle(r: Record<string, unknown>): string | null {
  if (r.status === 'completed') {
    const text = String(r.text ?? '').trim()
    if (!text) throw new Error('말소리를 알아듣지 못했어요. 다시 말해 주세요.')
    return text
  }
  if (r.status === 'failed') throw new Error(String(r.message ?? '음성 인식에 실패했어요'))
  return null
}

/** 녹음 → 글자. 서버가 FFmpeg로 정규화하고 STT 결과까지 기다려 준다. 서버 대기 시간 안에 안 끝나면 이어서 확인한다 */
export async function transcribe(audio: Blob): Promise<string> {
  const res = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio })
  const d = await readJson(res)
  if (!res.ok || typeof d.operationId !== 'string') throw new Error(String(d.message ?? `음성 인식 서버 오류 ${res.status}`))
  const first = settle(d)
  if (first != null) return first
  const op = d.operationId
  const until = Date.now() + POLL_LIMIT_MS
  while (Date.now() < until) {
    const p = await fetch(`/api/stt?op=${encodeURIComponent(op)}`)
    const r = await readJson(p)
    if (!p.ok) throw new Error(String(r.message ?? `음성 인식 서버 오류 ${p.status}`))
    const text = settle(r)
    if (text != null) return text
    await new Promise((x) => setTimeout(x, POLL_MS))
  }
  throw new Error('음성 인식이 너무 오래 걸려요. 글자로 입력해 주세요.')
}
