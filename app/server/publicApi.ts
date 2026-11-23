// 공개 API 공용 로직 (R-501): GET /api/features, GET /api/health
// 배포는 Vercel 함수(api/features.ts, api/health.ts), 개발 서버는 vite.config.ts가 같은 로직을 돈다.
// DB 함수 features()를 공개 키(publishable)로 부른다: 숨김·개인정보는 DB 함수가 이미 뺀다 (migrations/20261120000009).

export const LICENSE: Record<string, string> = {
  segments: '구간 형상: 국토지리정보원 수치지도(공공누리 제1유형, 출처 표시). 조사 데이터: 동해 무장애지도',
  obstacles: '동해 무장애지도 조사단 (공개 라이선스 동의 제보 포함)',
  crossings: '전국횡단보도표준데이터(공공데이터포털)를 구간망 노드에 연결',
  places: '국토지리정보원 수치지도 건물 이름·철도역 (공공누리 제1유형, 출처 표시)',
}

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

export interface ApiEnv {
  supabaseUrl?: string
  supabaseKey?: string
}

export interface ApiResult {
  status: number
  json: unknown
  headers?: Record<string, string>
}

const LAYERS = ['segments', 'obstacles', 'crossings', 'places']
const GRADES = ['unsurveyed', 'passable', 'caution', 'difficult']
const STATUSES = ['reported', 'confirmed', 'verified', 'resolved'] // hidden은 공개하지 않음

const bad = (message: string): ApiResult => ({ status: 400, json: { error: 'bad_request', message } })
const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null)

async function rpc(env: ApiEnv, fn: string, args: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!env.supabaseUrl || !env.supabaseKey) return { ok: false, status: 500, data: { message: 'server not configured' } }
  const res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.supabaseKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
}

/** GET /api/features?layer=segments|obstacles|crossings|places &bbox=서경,남위,동경,북위 &grade= &status= &since= &limit=1..1000 */
export async function handleFeatures(q: URLSearchParams, env: ApiEnv): Promise<ApiResult> {
  const layer = q.get('layer') ?? 'segments'
  if (!LAYERS.includes(layer)) return bad(`layer는 ${LAYERS.join(', ')} 중 하나여야 합니다`)

  let bbox: number[] | null = null
  if (q.get('bbox')) {
    bbox = q.get('bbox')!.split(',').map(Number)
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      return bad('bbox는 서경,남위,동경,북위 순서의 숫자 4개여야 합니다')
    }
  }
  const grade = list(q.get('grade'))
  if (grade && grade.some((g) => !GRADES.includes(g))) return bad(`grade는 ${GRADES.join(', ')} 중에서 고릅니다`)
  const status = list(q.get('status'))
  if (status && status.some((s) => !STATUSES.includes(s))) return bad(`status는 ${STATUSES.join(', ')} 중에서 고릅니다`)
  const since = q.get('since')
  if (since && Number.isNaN(Date.parse(since))) return bad('since는 ISO 8601 날짜여야 합니다 (예: 2026-11-20)')
  const limit = q.get('limit') ? Number(q.get('limit')) : 1000
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return bad('limit는 1~1000 사이 정수입니다')

  const r = await rpc(env, 'features', { p_bbox: bbox, p_layer: layer, p_grade: grade, p_status: status, p_since: since, p_limit: limit })
  if (!r.ok) return { status: 502, json: { error: 'query_failed', message: (r.data as { message?: string } | null)?.message ?? `db ${r.status}` } }
  const fc = r.data as { type: string; features: unknown[] }
  return {
    status: 200,
    json: { ...fc, license: LICENSE[layer], count: fc.features.length, truncated: fc.features.length === limit },
    headers: { 'Content-Type': 'application/geo+json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  }
}

/** GET /api/health: DB까지 닿는지 (가장 작은 조회 1건). UptimeRobot은 이것만 부른다 */
export async function handleHealth(env: ApiEnv): Promise<ApiResult> {
  const t0 = Date.now()
  const r = await rpc(env, 'features', { p_layer: 'places', p_limit: 1 }).catch(() => ({ ok: false, status: 0, data: null }))
  return { status: r.ok ? 200 : 503, json: { status: r.ok ? 'ok' : 'db_unreachable', ms: Date.now() - t0, time: new Date().toISOString() } }
}

export function apiEnv(env: Record<string, string | undefined>): ApiEnv {
  return { supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL, supabaseKey: env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY }
}
