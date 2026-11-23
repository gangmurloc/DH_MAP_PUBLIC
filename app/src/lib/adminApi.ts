// 관리자·조사원 화면용 Supabase 호출. 로그인은 이메일·비밀번호 (계정은 관리자가 만든다, 회원가입 없음)
// 권한은 DB가 정한다: 역할(app_metadata.role)이 없으면 RLS·함수가 막는다. 화면의 역할 확인은 안내용일 뿐이다.
import type { LonLat } from '@/lib/types'

const URL_: string | undefined = import.meta.env.VITE_SUPABASE_URL
const KEY: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const SESSION_KEY = 'donghae-admin-session-v1'

export type Role = 'admin' | 'surveyor' | null

export interface AdminSession {
  access_token: string
  refresh_token: string
  expires_at: number
  email: string
  role: Role
}

export type ObstacleType = 'kerb' | 'stairs' | 'cross_slope' | 'steep' | 'narrow' | 'damaged' | 'other'

export const OBSTACLE_LABEL: Record<ObstacleType, string> = {
  kerb: '단차(턱)',
  stairs: '계단',
  cross_slope: '횡경사',
  steep: '급경사',
  narrow: '좁은 길',
  damaged: '파손',
  other: '기타',
}

export interface Report {
  id: number
  type: ObstacleType
  text: string | null
  status: 'pending' | 'confirmed' | 'not_found' | 'hidden'
  measured_value: number | null
  measured_unit: 'cm' | '%' | null
  loc_source: string | null
  accuracy_m: number | null
  cluster_id: number | null
  created_at: string
  at: LonLat
}

export interface Obstacle {
  id: number
  type: ObstacleType
  status: 'reported' | 'confirmed' | 'verified' | 'resolved' | 'hidden'
  segment_id: number | null
  created_at: string
  at: LonLat
  /** 기타 장애물 설명 등 (tags.note) */
  tags?: { note?: string } | null
}

export interface StatusEvent {
  id: number
  entity_type: string
  entity_id: number
  from_status: string | null
  to_status: string
  at: string
  note: string | null
}

function decodeRole(token: string): Role {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const r = p?.app_metadata?.role
    return r === 'admin' || r === 'surveyor' ? r : null
  } catch {
    return null
  }
}

function save(s: AdminSession | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // 저장이 막힌 브라우저: 이번 방문 동안만
  }
}

export function loadAdminSession(): AdminSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as AdminSession) : null
  } catch {
    return null
  }
}

async function tokenCall(grant: string, body: unknown, email: string): Promise<AdminSession> {
  if (!URL_ || !KEY) throw new Error('Supabase 설정이 없어요')
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.access_token) {
    const msg = String(d?.error_description || d?.msg || d?.message || res.status)
    throw new Error(/invalid login/i.test(msg) ? '이메일 또는 비밀번호가 맞지 않아요' : `로그인 실패: ${msg}`)
  }
  const s: AdminSession = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(d.expires_in ?? 3600),
    email: d.user?.email ?? email,
    role: decodeRole(d.access_token),
  }
  save(s)
  return s
}

/** 이메일 대신 짧은 아이디(예: admin)로도 로그인: '@'가 없으면 내부 이메일 '<아이디>@donghae.local'로 바꾼다 (테스트용 임시 계정) */
export const loginEmail = (id: string) => (id.includes('@') ? id : `${id}@donghae.local`)
export const adminLogin = (id: string, password: string) => {
  const email = loginEmail(id.trim())
  return tokenCall('password', { email, password }, email)
}
export const adminLogout = () => save(null)

async function token(): Promise<string> {
  const s = loadAdminSession()
  if (!s) throw new Error('다시 로그인해 주세요')
  if (s.expires_at - Math.floor(Date.now() / 1000) > 60) return s.access_token
  return (await tokenCall('refresh_token', { refresh_token: s.refresh_token }, s.email)).access_token
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = await token()
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY!, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const d = await res.json().catch(() => null)
  if (!res.ok) throw new Error(String(d?.message || `서버 오류 ${res.status}`))
  return d as T
}

/** 로그인한 관리자·조사원 권한으로 DB 함수 호출 (조사 기록 저장에도 쓴다: surveyApi.ts) */
export const rpc = <T>(fn: string, args: Record<string, unknown>) => rest<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

type Geo = { geom: { coordinates: [number, number] } }

export async function listReports(status: Report['status'] = 'pending'): Promise<Report[]> {
  const rows = await rest<(Omit<Report, 'at'> & Geo)[]>(
    `reports?select=id,type,text,status,measured_value,measured_unit,loc_source,accuracy_m,cluster_id,created_at,geom&status=eq.${status}&order=created_at.desc&limit=300`,
  )
  return rows.map(({ geom, ...r }) => ({ ...r, at: geom.coordinates }))
}

export async function listObstacles(): Promise<Obstacle[]> {
  const rows = await rest<(Omit<Obstacle, 'at'> & Geo)[]>(
    'obstacles?select=id,type,status,segment_id,created_at,tags,geom&status=in.(reported,confirmed,verified)&order=created_at.desc&limit=500',
  )
  return rows.map(({ geom, ...r }) => ({ ...r, at: geom.coordinates }))
}

export const listEvents = () => rest<StatusEvent[]>('status_events?select=id,entity_type,entity_id,from_status,to_status,at,note&order=at.desc&limit=60')

/** 현장·관리자가 남긴 측정값 (경사 입력 등). 기록 목록에 함께 보인다 */
export interface Measurement {
  id: number
  target_type: 'segment' | 'obstacle'
  target_id: number
  key: 'incline' | 'cross_slope' | 'kerb:height' | 'width'
  value: number
  unit: string | null
  note: string | null
  measured_at: string
}
export const listMeasurements = () =>
  rest<Measurement[]>('measurements?select=id,target_type,target_id,key,value,unit,note,measured_at&source=neq.dem&order=measured_at.desc&limit=60')

/** 관리자 추가 길: 우리 데이터에 없는 길(카카오 지도의 흰색 길)을 그려 넣고 경사를 함께 남긴다 (DB admin_paths) */
export const addAdminPath = (coords: LonLat[], pct: number, deg: number, note: string | null) =>
  rpc<number>('add_admin_path', {
    p_coords: coords.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]),
    p_incline_pct: Math.round(pct * 100) / 100,
    p_incline_deg: deg,
    p_note: note,
  })
export const hideAdminPath = (id: number) => rpc('hide_admin_path', { p_id: id, p_note: null })
/** 관리자 추가 길의 경사·설명 고치기 */
export const updateAdminPath = (id: number, pct: number, deg: number, note: string | null) =>
  rpc('update_admin_path', { p_id: id, p_incline_pct: Math.round(pct * 100) / 100, p_incline_deg: deg, p_note: note })

/** 구간 경사 고치기: 이전 실측 경사는 '대체됨'으로 두고 이 값만 지도에 쓴다 */
export const setSegmentIncline = (segmentId: number, deg: number, pct: number, at: LonLat | null) =>
  rpc<number>('set_segment_incline', {
    p_segment_id: segmentId,
    p_incline_pct: Math.round(pct * 100) / 100,
    p_incline_deg: deg,
    p_lon: at?.[0] ?? null,
    p_lat: at?.[1] ?? null,
  })
/** 구간 실측 경사 지우기: 지도는 다시 추정값을 쓴다 */
export const clearSegmentIncline = (segmentId: number) => rpc<number>('clear_segment_incline', { p_segment_id: segmentId })
/** 한 구간의 경사 기록 (대체된 것 포함, 최근 순) */
export const segmentInclineHistory = (segmentId: number) =>
  rest<(Measurement & { superseded_at: string | null })[]>(
    `measurements?select=id,target_type,target_id,key,value,unit,note,measured_at,superseded_at&target_type=eq.segment&target_id=eq.${segmentId}&key=eq.incline&source=neq.dem&order=measured_at.desc&limit=20`,
  )

/** 구간 경사 실측 기록: 각도(°)를 경사(%)로 바꿔 남긴다. 공개 지도가 surveyed_segments로 받아 추정값 대신 쓴다 */
export const recordSlope = (segmentId: number, deg: number, pct: number, at: LonLat) =>
  rpc<number>('record_measurement', {
    p_target_type: 'segment',
    p_target_id: segmentId,
    p_key: 'incline',
    p_value: Math.round(pct * 100) / 100,
    p_source: 'field_verified',
    p_lon: at[0],
    p_lat: at[1],
    p_note: `${deg}° (관리자 입력)`,
  })

export interface RegisterInput {
  type: ObstacleType
  at: LonLat
  kerbCm: number | null
  widthCm: number | null
  crossSlopePct: number | null
  reportId: number | null
  /** 기타 장애물 설명 (tags.note로 남긴다) */
  note?: string | null
}

/** 장애물 등록 (제보 맞음이면 reportId로 그 제보 묶음을 함께 처리). 횡경사 값은 측정값으로 남긴다 */
export async function registerObstacle(i: RegisterInput): Promise<{ obstacle_id: number; segment_id: number | null }> {
  const r = await rpc<{ obstacle_id: number; segment_id: number | null }>('register_obstacle', {
    p_type: i.type,
    p_lon: i.at[0],
    p_lat: i.at[1],
    p_kerb_height_cm: i.type === 'kerb' ? i.kerbCm : null,
    p_width_cm: i.type === 'narrow' ? i.widthCm : null,
    p_tags: i.note?.trim() ? { note: i.note.trim() } : {},
    p_photo_path: null,
    p_report_id: i.reportId,
  })
  if (i.type === 'cross_slope' && i.crossSlopePct != null) {
    await rpc('record_measurement', {
      p_target_type: 'obstacle',
      p_target_id: r.obstacle_id,
      p_key: 'cross_slope',
      p_value: i.crossSlopePct,
      p_source: 'field_verified',
      p_lon: i.at[0],
      p_lat: i.at[1],
    })
  }
  return r
}

export const resolveReport = (id: number, result: 'not_found' | 'hidden', note: string | null) =>
  rpc('resolve_report', { p_report_id: id, p_result: result, p_obstacle_id: null, p_note: note })
export const resolveObstacle = (id: number, note: string | null) => rpc('resolve_obstacle', { p_obstacle_id: id, p_note: note })
export const hideObstacle = (id: number, note: string | null) => rpc('hide_obstacle', { p_obstacle_id: id, p_note: note })
export const listMembers = () => rpc<{ email: string; role: string; last_sign_in_at: string | null }[]>('admin_list_members', {})
export const setRole = (email: string, role: 'admin' | 'surveyor' | 'none') => rpc('admin_set_role', { p_email: email, p_role: role })
