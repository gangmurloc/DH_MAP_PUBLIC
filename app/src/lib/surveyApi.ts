// 현장 조사 결과를 DB에 저장하고(조사원), 조사된 구간을 지도·길 안내에 내려준다(누구나).
// 저장은 이미 있는 DB 함수만 부른다: record_measurement · register_obstacle · suggest_grade · complete_survey
// 법 기준(편의법 시행규칙 별표1 제1호): 턱 2cm 초과·폭 1.2m 미만만 '장애물'로 등록하고(길 안내에서 뺀다),
// 그 이하 턱·이상 폭은 구간 측정값으로만 남긴다.
// 현장에서 신호가 끊겨도 잃지 않도록 보낼 내용을 이 기기에 대기열로 두고, 단계별로 보내며 몇 단계까지 갔는지 기록한다
// (다시 보낼 때 이미 보낸 측정값을 또 넣지 않는다).
import { rpc } from '@/lib/adminApi'
import type { SlopeSegment, SurveyInfo } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

const URL_: string | undefined = import.meta.env.VITE_SUPABASE_URL
const KEY: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const QUEUE_KEY = 'donghae-survey-queue-v1'

/** DB에 없는 구간(OSM 보완 길·연결 추정)은 조사 기록을 남길 수 없다 */
export function surveyable(s: SlopeSegment): boolean {
  return !String(s.kind ?? '').startsWith('osm') && s.kind !== 'assumed_link'
}

/** 법 기준 (grade.ts PARAMS, grading_params와 같은 값) */
export const KERB_MAX_CM = 2
export const WIDTH_MIN_CM = 120

export type SurveyGrade = 'passable' | 'caution' | 'difficult'
export type SurveyObstacleType = 'kerb' | 'narrow' | 'stairs' | 'damaged' | 'steep'

export interface SurveyObstacle {
  type: SurveyObstacleType
  /** 단차 높이 cm (kerb 필수) */
  kerbCm: number | null
  /** 폭 cm (narrow 필수) */
  widthCm: number | null
}

export interface SurveySubmission {
  /** 대기열 안에서 구분 */
  key: string
  segId: number
  /** 장애물 위치 (구간 가운데) */
  at: LonLat
  /** 구간에서 가장 가파른 곳의 |경사| % (디지털 수평계) */
  incline: number | null
  /** 횡경사 % (참고) */
  cross: number | null
  obstacles: SurveyObstacle[]
  /** 조사 완료면 등급, 측정만 저장이면 null */
  grade: SurveyGrade | null
  reason: string
  createdAt: string
  /** 보낸 단계 수 */
  sent: number
  /** 마지막 실패 메시지 */
  error?: string
}

export class NeedReasonError extends Error {
  suggested: SurveyGrade
  constructor(suggested: SurveyGrade) {
    super(`DB 제안 등급은 '${suggested}'예요. 다르게 정하려면 사유를 적어 주세요`)
    this.suggested = suggested
  }
}

type Step = () => Promise<unknown>

function steps(s: SurveySubmission): Step[] {
  const [lon, lat] = s.at
  const meas = (key: string, value: number, note: string | null = null) => () =>
    rpc('record_measurement', {
      p_target_type: 'segment', p_target_id: s.segId, p_key: key, p_value: value,
      p_source: 'field_verified', p_heading_deg: null, p_lon: lon, p_lat: lat, p_note: note,
    })
  const obstacle = (o: SurveyObstacle) => () =>
    rpc('register_obstacle', {
      p_type: o.type, p_lon: lon, p_lat: lat,
      p_kerb_height_cm: o.type === 'kerb' ? o.kerbCm : null,
      p_width_cm: o.type === 'narrow' ? o.widthCm : null,
      p_tags: {}, p_photo_path: null, p_report_id: null,
    })
  const out: Step[] = []
  if (s.incline != null) out.push(meas('incline', Math.abs(s.incline)))
  if (s.cross != null) out.push(meas('cross_slope', Math.abs(s.cross)))
  for (const o of s.obstacles) {
    // 법 기준 안의 턱·폭은 장애물이 아니라 측정값 (등록하면 길 안내에서 빠진다)
    if (o.type === 'kerb' && o.kerbCm != null && o.kerbCm <= KERB_MAX_CM) out.push(meas('kerb:height', o.kerbCm / 100))
    else if (o.type === 'narrow' && o.widthCm != null && o.widthCm >= WIDTH_MIN_CM) out.push(meas('width', o.widthCm / 100))
    else out.push(obstacle(o))
  }
  if (s.grade) {
    const grade = s.grade
    out.push(async () => {
      // 최종 제안은 DB가 정한다 (앱 화면 제안은 미리보기). 다르면 사유가 있어야 한다
      const sug = await rpc<{ grade: SurveyGrade }>('suggest_grade', { p_segment_id: s.segId })
      if (sug.grade !== grade && !s.reason.trim()) throw new NeedReasonError(sug.grade)
      return rpc('complete_survey', { p_segment_id: s.segId, p_grade: grade, p_override_reason: s.reason.trim() || null })
    })
  }
  return out
}

// ── 대기열 (이 기기) ──
export function loadQueue(): SurveySubmission[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as SurveySubmission[]
  } catch {
    return []
  }
}
function saveQueue(q: SurveySubmission[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  } catch {
    // 저장이 막힌 브라우저: 이번 화면에서만
  }
}
function upsert(s: SurveySubmission) {
  const q = loadQueue().filter((x) => x.key !== s.key)
  saveQueue([...q, s])
}
function drop(key: string) {
  saveQueue(loadQueue().filter((x) => x.key !== key))
}

export function newSubmission(p: Omit<SurveySubmission, 'key' | 'createdAt' | 'sent'>): SurveySubmission {
  return { ...p, key: `${p.segId}-${Date.now()}`, createdAt: new Date().toISOString(), sent: 0 }
}

/** 한 건을 남은 단계부터 보낸다. 실패하면 대기열에 남기고 오류를 던진다 */
export async function send(s: SurveySubmission): Promise<void> {
  upsert(s)
  const list = steps(s)
  let cur = { ...s }
  for (let i = cur.sent; i < list.length; i++) {
    try {
      await list[i]()
    } catch (e) {
      cur = { ...cur, error: (e as Error).message }
      upsert(cur)
      throw e
    }
    cur = { ...cur, sent: i + 1, error: undefined }
    upsert(cur)
  }
  drop(s.key)
}

/** 대기열에 남은 것을 모두 다시 보낸다. 보낸 수와 남은 수 */
export async function flushQueue(): Promise<{ sent: number; left: number }> {
  let sent = 0
  for (const s of loadQueue()) {
    try {
      await send(s)
      sent++
    } catch {
      // 남겨 둔다 (사유가 필요한 건은 화면에서 고친다)
    }
  }
  return { sent, left: loadQueue().length }
}

/** 사유를 넣어 남은 단계(조사 완료)를 다시 보낸다 */
export const resendWithReason = (s: SurveySubmission, reason: string) => send({ ...s, reason })

/** 조사된 구간 (공개: 로그인 없이). 서버 준비 전이거나 못 받으면 빈 목록 */
export async function fetchSurveyed(): Promise<Map<number, SurveyInfo>> {
  const out = new Map<number, SurveyInfo>()
  if (!URL_ || !KEY) return out
  try {
    const res = await fetch(`${URL_}/rest/v1/rpc/surveyed_segments`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return out
    const rows = (await res.json()) as { id: number; grade: SurveyGrade | null; incline: number | null; at: string | null }[]
    for (const r of rows) out.set(r.id, { grade: r.grade, incline: r.incline == null ? null : Number(r.incline), at: r.at })
  } catch {
    // 오프라인: 추정값만
  }
  return out
}
