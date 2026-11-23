/// <reference types="node" />
// 서버 STT 공용 로직(app/server/stt.ts) 테스트. 테스트 실행 범위가 src/라서 여기에 둔다.
// FFmpeg는 ffmpeg-static 실행 파일로 실제로 돌린다 (STT 업체 호출은 하지 않는다: 요금이 든다)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, checkUpload, handleSttPoll, handleSttSubmit, normalize, STT_LIMITS, wavInfo } from '../../server/stt'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const dir = mkdtempSync(join(tmpdir(), 'stt-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 시험 음원: 48kHz 스테레오 webm(opus) 2초, 크롬 녹음과 같은 형식 */
function sampleWebm(): Uint8Array {
  const out = join(dir, 'sample.webm')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', out])
  return new Uint8Array(readFileSync(out))
}

describe('FFmpeg 인자', () => {
  it('16kHz 모노 16bit PCM WAV, 최대 30초, 입력·출력 경로만 받는다', () => {
    const a = buildFfmpegArgs('/tmp/in', '/tmp/out.wav')
    expect(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2)).toEqual(['-i', '/tmp/in'])
    expect(a[a.indexOf('-t') + 1]).toBe(String(STT_LIMITS.maxSec))
    expect(a[a.indexOf('-ac') + 1]).toBe('1')
    expect(a[a.indexOf('-ar') + 1]).toBe('16000')
    expect(a[a.indexOf('-c:a') + 1]).toBe('pcm_s16le')
    expect(a[a.indexOf('-af') + 1]).toContain('loudnorm')
    expect(a[a.indexOf('-af') + 1]).toContain('areverse') // 뒤쪽 무음도 자른다
    expect(a.at(-1)).toBe('/tmp/out.wav')
  })
})

describe('받은 녹음 검사', () => {
  it('비었거나, 너무 크거나, 오디오가 아니면 거부', () => {
    expect(checkUpload('audio/webm', 0)).toMatch(/비어/)
    expect(checkUpload('audio/webm', STT_LIMITS.maxBytes + 1)).toMatch(/너무 커요/)
    expect(checkUpload('video/mp4', 1000)).toMatch(/오디오/)
    expect(checkUpload(undefined, 1000)).toMatch(/오디오/)
    expect(checkUpload('audio/webm;codecs=opus', 1000)).toBeNull()
    expect(checkUpload('audio/mp4', 1000)).toBeNull()
  })

  it('서버 함수: 형식이 틀리면 키·FFmpeg가 없어도 먼저 400', async () => {
    const r = await handleSttSubmit(new Uint8Array(10), 'text/plain', {})
    expect(r.status).toBe(400)
  })

  it('서버 함수: 키가 없으면 503 (STT 업체를 부르지 않음)', async () => {
    expect((await handleSttSubmit(new Uint8Array(10), 'audio/webm', { ffmpegPath: ffmpeg })).status).toBe(503)
    expect((await handleSttPoll('soniox:abc-123:ff00', {})).status).toBe(503)
  })

  it('작업 ID 모양이 아니면 400', async () => {
    expect((await handleSttPoll('../../etc', { bazeKey: 'x' })).status).toBe(400)
    expect((await handleSttPoll(null, { bazeKey: 'x' })).status).toBe(400)
  })
})

describe('FFmpeg 정규화 (실제 실행)', () => {
  it('48kHz 스테레오 webm → 16kHz 모노 16bit WAV', async () => {
    const wav = await normalize(sampleWebm(), ffmpeg)
    const info = wavInfo(wav)!
    expect(info).toMatchObject({ channels: 1, sampleRate: 16000, bits: 16 })
    expect(info.seconds).toBeGreaterThan(1.5)
    expect(info.seconds).toBeLessThanOrEqual(2.1)
  }, 30_000)

  it('소리 파일이 아니면 오류. 문구에 서버 임시 파일 경로를 넣지 않는다', async () => {
    const e = await normalize(new TextEncoder().encode('not audio at all'), ffmpeg).catch((x: Error) => x)
    expect(String((e as Error).message)).toMatch(/녹음을 읽지 못했어요/)
    expect(String((e as Error).message)).not.toMatch(/tmp|stt-/)
  }, 30_000)

  it('앞뒤 무음을 자른다: 무음 1초 + 소리 1초 + 무음 2초(4초) → 약 1.6초', async () => {
    const out = join(dir, 'pad.webm')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000', '-af', 'adelay=1000,apad=pad_dur=2', '-c:a', 'libopus', out])
    const info = wavInfo(await normalize(new Uint8Array(readFileSync(out)), ffmpeg))!
    expect(info.seconds).toBeGreaterThan(1.2)
    expect(info.seconds).toBeLessThan(2.0)
  }, 30_000)
})

describe('서버가 결과까지 기다렸다가 돌려준다 (BAZE 응답은 가짜)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('작업 올리기 → 처리 중 → 완료면 POST 한 번에 글자까지', async () => {
    let polls = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (init?.method === 'POST') return json({ operation_id: 'soniox:test-op-1:ab12', status: 'processing' })
      polls++
      return json(polls < 2 ? { status: 'processing' } : { status: 'completed', text: ' 동해역 ' })
    })
    const r = await handleSttSubmit(sampleWebm(), 'audio/webm', { bazeKey: 'k', ffmpegPath: ffmpeg })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ operationId: 'soniox:test-op-1:ab12', status: 'completed', text: '동해역' })
    expect(polls).toBe(2)
  }, 30_000)

  it('결과 확인이 막히면(429 등) 작업 ID만 주고 브라우저가 이어서 확인', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ operation_id: 'soniox:test-op-2:cd34' }), { status: 200 })
        : new Response('{}', { status: 429 }),
    )
    const r = await handleSttSubmit(sampleWebm(), 'audio/webm', { bazeKey: 'k', ffmpegPath: ffmpeg })
    expect(r.json).toMatchObject({ operationId: 'soniox:test-op-2:cd34', status: 'processing' })
  }, 30_000)
})
