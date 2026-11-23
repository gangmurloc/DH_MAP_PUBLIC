// DB 기준값(grading_params)을 경로 계산 값(ROUTE_PARAMS)에 덮어쓴다.
// 못 읽으면(오프라인·권한) 앱에 넣어 둔 기본값 그대로 쓴다.
// 값 이름은 supabase/migrations/20261120000005_route_params.sql, 20261120000007_route_law.sql (휠체어 한 기준, 법 기준)
import { token } from '@/lib/reports'
import { ROUTE_PARAMS, type RouteParams } from '@/lib/slopeRoute'

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

type Setter = (p: RouteParams, v: number) => void
const SCALAR: Record<string, Setter> = {
  incline_caution_max_pct: (p, v) => (p.maxGradePct = v),
  incline_passable_max_pct: (p, v) => (p.cautionOverPct = v),
  route_min_user_grade_pct: (p, v) => (p.minUserGradePct = v),
  route_ambiguous_margin_pct: (p, v) => (p.ambiguousMarginPct = v),
  route_speed_wheelchair_mps: (p, v) => (p.speed.wheelchair = v),
  route_speed_walk_mps: (p, v) => (p.speed.walk = v),
  // 법(접근로 경사 연속 시 30m마다 참)에서 온 값. 예전 키(route_rest_every_m = 9)는 읽지 않는다
  route_law_rest_every_m: (p, v) => (p.restEveryM = v),
  route_rest_sec: (p, v) => (p.restSec = v),
  route_uncertain_crossing_sec: (p, v) => (p.uncertainCrossingSec = v),
  route_unknown_crosswalk_raised_p: (p, v) => (p.unknownCrosswalkRaisedP = v),
  route_free_crossing_raised_p: (p, v) => (p.freeCrossingRaisedP = v),
  route_junction_crossing_m: (p, v) => (p.junctionCrossingM = v),
  route_junction_crossing_sec: (p, v) => (p.junctionCrossingSec = v),
  route_detour_ratio: (p, v) => (p.detourRatio = v),
  route_detour_extra_m: (p, v) => (p.detourExtraM = v),
  route_detour_warn_ratio: (p, v) => (p.detourWarnRatio = v),
  route_detour_warn_extra_m: (p, v) => (p.detourWarnExtraM = v),
  route_factor_unknown_slope: (p, v) => (p.unknownSlopeFactor = v),
  route_factor_wall_crossing: (p, v) => (p.wallCrossingFactor = v),
  route_factor_obstacle_caution: (p, v) => (p.obstacleCautionFactor = v),
  route_factor_no_sidewalk: (p, v) => (p.noSidewalkFactor = v),
  route_factor_uncertain_slope: (p, v) => (p.uncertainSlopeFactor = v),
  route_factor_osm_path: (p, v) => (p.osmPathFactor = v),
  route_factor_assumed_link: (p, v) => (p.assumedLinkFactor = v),
}
/** 휠체어 한 기준의 경사별 속도 계수: route_wheelchair_<up|down>_pct_<경사%> */
const CURVE = /^route_wheelchair_(up|down)_pct_(\d+(?:\.\d+)?)$/

/** 행 목록을 값에 반영. 반영한 키 수를 돌려준다 (테스트용으로 대상 객체를 받을 수 있다) */
export function applyGradingParams(rows: { key: string; value: number }[], p: RouteParams = ROUTE_PARAMS): number {
  let n = 0
  const curves = new Map<string, [number, number][]>()
  for (const { key, value } of rows) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const set = SCALAR[key]
    if (set) {
      set(p, value)
      n++
      continue
    }
    const m = CURVE.exec(key)
    if (m) {
      curves.set(m[1], [...(curves.get(m[1]) ?? []), [Number(m[2]), value]])
      n++
    }
  }
  for (const [dir, pts] of curves) {
    if (pts.length < 2) continue
    p[dir === 'up' ? 'upFactor' : 'downFactor'] = pts.sort((a, b) => a[0] - b[0])
  }
  return n
}

export async function loadGradingParams(): Promise<number> {
  if (!URL_ || !KEY) return 0
  try {
    const t = await token()
    const res = await fetch(`${URL_}/rest/v1/grading_params?select=key,value`, { headers: { apikey: KEY, Authorization: `Bearer ${t}` } })
    if (!res.ok) return 0
    return applyGradingParams(await res.json())
  } catch {
    return 0
  }
}
