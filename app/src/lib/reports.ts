// 시민 확인 요청(제보)과 확인된 장애물 (HANDOFF 3절: 시민 제보는 지도에 바로 올라가지 않고 조사원 점검 목록으로 간다.
// 조사원이 현장에서 '맞음'을 눌러 장애물(obstacles, status confirmed/verified)이 된 것만 지도·길 안내에 쓴다)
// Supabase는 publishable 키 + 익명 로그인으로 부른다 (회원가입 없음). 테이블 쓰기 권한은 reports insert 하나뿐 (RLS).
import type { LonLat } from '@/lib/types'

export type ReportType = 'kerb' | 'stairs' | 'other'

// '턱' 대신 '단차(턱)': 문턱·보도 연석·맨홀 둘레처럼 높이가 갑자기 달라지는 곳 전부 (BF 인증·설계에서 쓰는 말 + 익숙한 말)
export const REPORT_LABEL: Record<ReportType, string> = {
  kerb: '단차(턱)',
  stairs: '계단',
  other: '기타 장애물',
}

export interface ConfirmedObstacle {
  id: number
  type: 'kerb' | 'stairs' | 'steep' | 'narrow' | 'damaged' | 'cross_slope' | 'other'
  lon: number
  lat: number
  /** 기타 장애물 설명 (관리자가 남긴 tags.note) */
  note?: string
}

const URL_: string | undefined = import.meta.env.VITE_SUPABASE_URL
const KEY: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const SESSION_KEY = 'donghae-anon-session-v1'

interface Session {
  access_token: string
  refresh_token: string
  expires_at: number
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function saveSession(s: Session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    // 저장이 막힌 브라우저: 이번 방문 동안만 쓴다
  }
}

async function auth(path: string, body: unknown): Promise<Session> {
  const res = await fetch(`${URL_}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.access_token) {
    const msg = String(d?.msg || d?.error_description || d?.message || res.status)
    if (/anonymous/i.test(msg)) throw new Error('제보 서버 준비 중이에요 (익명 로그인이 꺼져 있음)')
    throw new Error(`로그인 실패: ${msg}`)
  }
  const s = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(d.expires_in ?? 3600) }
  saveSession(s)
  return s
}

/** 익명 로그인 토큰 (있으면 재사용, 곧 끝나면 갱신) */
export async function token(): Promise<string> {
  if (!URL_ || !KEY) throw new Error('Supabase 설정이 없어요')
  const s = loadSession()
  const now = Math.floor(Date.now() / 1000)
  if (s && s.expires_at - now > 60) return s.access_token
  if (s?.refresh_token) {
    try {
      return (await auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token })).access_token
    } catch {
      // 갱신 실패: 새 익명 사용자로
    }
  }
  return (await auth('signup', { data: {} })).access_token
}

export interface NewReport {
  type: ReportType
  at: LonLat
  locSource: 'gps' | 'manual'
  accuracyM: number | null
  /** 단차 높이 cm (선택) */
  measured: number | null
  text: string
}

export async function submitReport(r: NewReport): Promise<void> {
  const t = await token()
  const unit = r.measured == null ? null : r.type === 'kerb' ? 'cm' : null
  const res = await fetch(`${URL_}/rest/v1/reports`, {
    method: 'POST',
    headers: { apikey: KEY!, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      geom: `SRID=4326;POINT(${r.at[0]} ${r.at[1]})`,
      type: r.type,
      loc_source: r.locSource,
      accuracy_m: r.accuracyM,
      pin_adjusted: r.locSource === 'manual',
      user_type: 'citizen',
      text: r.text.trim().slice(0, 500) || null,
      license_agreed: true,
      measured_value: unit ? r.measured : null,
      measured_unit: unit,
    }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    const msg = String(d?.message || res.status)
    if (/횟수/.test(msg)) throw new Error('오늘 제보할 수 있는 횟수를 모두 썼어요')
    if (res.status === 404 || /relation|column|enum|schema cache/i.test(msg)) throw new Error('제보 서버 준비 중이에요 (DB 구조 적용 전)')
    throw new Error(`제보를 보내지 못했어요 (${msg})`)
  }
}

/** 조사원이 확인한 장애물 (숨김 제외). 서버 준비 전이면 빈 목록 */
export async function fetchConfirmedObstacles(): Promise<ConfirmedObstacle[]> {
  try {
    const t = await token()
    const res = await fetch(`${URL_}/rest/v1/obstacles?select=id,type,tags,geom&status=in.(confirmed,verified)`, {
      headers: { apikey: KEY!, Authorization: `Bearer ${t}` },
    })
    if (!res.ok) return []
    const rows = (await res.json()) as { id: number; type: ConfirmedObstacle['type']; tags?: { note?: string } | null; geom: { coordinates: [number, number] } }[]
    return rows
      .filter((r) => r.geom?.coordinates)
      .map((r) => ({ id: r.id, type: r.type, lon: r.geom.coordinates[0], lat: r.geom.coordinates[1], ...(r.tags?.note ? { note: r.tags.note } : {}) }))
  } catch {
    return []
  }
}
