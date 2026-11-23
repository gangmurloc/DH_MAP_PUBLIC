// 등급 제안: supabase/migrations/…_functions.sql 의 suggest_grade와 같은 규칙 (기준값은 grading_params 값)
// 법 기준(편의법 시행규칙 별표1 제1호, 20261120000008): 턱 2cm 초과·폭 1.2m 미만은 '통행 어려움'
import type { Grade, Segment, SurveyRecord } from './types'

export const PARAMS = {
  inclinePassableMaxPct: 5.6,
  inclineCautionMaxPct: 8.3,
  kerbPassableMaxM: 0.02,
  kerbCautionMaxM: 0.02,
  widthCautionMinM: 1.2,
  widthDifficultMinM: 1.2,
  demModerateMinPct: 4.0,
}

export interface Reason {
  code: string
  label: string
}

export interface Suggestion {
  grade: Grade
  reasons: Reason[]
  inclineSource: 'measured' | 'missing' | 'dem'
}

const RANK: Grade[] = ['passable', 'caution', 'difficult']
const fmt = (v: number) => `${Math.round(v * 10) / 10}`

export function suggestGrade(seg: Segment, rec?: SurveyRecord | null): Suggestion {
  let rank = 0
  const reasons: Reason[] = []
  const raise = (r: number) => {
    rank = Math.max(rank, r)
  }
  let inclineSource: Suggestion['inclineSource']

  const inc = rec?.incline != null ? Math.abs(rec.incline) : null
  if (inc != null) {
    inclineSource = 'measured'
    if (inc > PARAMS.inclineCautionMaxPct) {
      raise(2)
      reasons.push({ code: 'incline_over_caution', label: `측정 경사 ${fmt(inc)}% > ${PARAMS.inclineCautionMaxPct}%` })
    } else if (inc > PARAMS.inclinePassableMaxPct) {
      raise(1)
      reasons.push({ code: 'incline_over_passable', label: `측정 경사 ${fmt(inc)}% > ${PARAMS.inclinePassableMaxPct}%` })
    } else {
      reasons.push({ code: 'incline_ok', label: `측정 경사 ${fmt(inc)}%` })
    }
  } else if (seg.bridge || seg.tunnel || seg.demMax == null || seg.assumed) {
    // 추정 연결은 DB에 없는 구간이라 앱에서만 쓰는 규칙: 실제 길을 재기 전까지 주의 이상
    inclineSource = 'missing'
    raise(1)
    reasons.push({ code: 'incline_not_measured', label: seg.assumed ? '추정 연결: 실제 길 경사 측정 필요' : '경사 측정 필요 (DEM 사용 불가)' })
  } else {
    inclineSource = 'dem'
    const d = seg.demMax
    if (d > PARAMS.inclineCautionMaxPct) {
      raise(2)
      reasons.push({ code: 'dem_steep', label: `DEM 추정 ${fmt(d)}% (측정 전)` })
    } else if (d >= PARAMS.demModerateMinPct) {
      raise(1)
      reasons.push({ code: 'dem_moderate_measure_needed', label: `DEM 추정 ${fmt(d)}%: 측정 필요` })
    } else {
      reasons.push({ code: 'incline_from_dem', label: `DEM 추정 ${fmt(d)}%` })
    }
  }

  if (seg.underpass) {
    raise(2)
    reasons.push({ code: 'underpass_no_sidewalk', label: '보도 없는 지하차도' })
  }
  if (seg.tunnel) {
    raise(1)
    reasons.push({ code: 'tunnel', label: '터널' })
  }
  if (seg.overpass === 'inaccessible') {
    reasons.push({ code: 'overpass_inaccessible_info', label: '장애인 이용 불가 육교 (참고)' })
  }
  if (rec?.cross != null) {
    reasons.push({ code: 'cross_slope_info', label: `횡경사 ${fmt(Math.abs(rec.cross))}% (참고)` })
  }

  for (const o of rec?.obstacles ?? []) {
    if (o.type === 'stairs') {
      raise(2)
      reasons.push({ code: 'stairs', label: '계단' })
    } else if (o.type === 'kerb') {
      const m = o.kerbCm != null ? o.kerbCm / 100 : null
      if (m == null) {
        raise(1)
        reasons.push({ code: 'kerb_height_unknown', label: '턱 (높이 미측정)' })
      } else if (m > PARAMS.kerbCautionMaxM) {
        raise(2)
        reasons.push({ code: 'kerb_over_caution', label: `턱 ${fmt(o.kerbCm!)}cm > ${PARAMS.kerbCautionMaxM * 100}cm` })
      } else if (m > PARAMS.kerbPassableMaxM) {
        raise(1)
        reasons.push({ code: 'kerb_over_passable', label: `턱 ${fmt(o.kerbCm!)}cm > ${PARAMS.kerbPassableMaxM * 100}cm` })
      } else {
        reasons.push({ code: 'kerb_ok', label: `턱 ${fmt(o.kerbCm!)}cm` })
      }
    } else if (o.type === 'narrow') {
      const m = o.widthCm != null ? o.widthCm / 100 : null
      if (m != null && m < PARAMS.widthDifficultMinM) {
        raise(2)
        reasons.push({ code: 'too_narrow', label: `폭 ${fmt(o.widthCm!)}cm < ${PARAMS.widthDifficultMinM * 100}cm` })
      } else if (m == null || m < PARAMS.widthCautionMinM) {
        raise(1)
        reasons.push({ code: 'narrow', label: m == null ? '좁음 (폭 미측정)' : `폭 ${fmt(o.widthCm!)}cm < ${PARAMS.widthCautionMinM * 100}cm` })
      }
    } else {
      raise(1)
      reasons.push({ code: o.type, label: o.type === 'damaged' ? '파손' : '급경사 장애물' })
    }
  }

  return { grade: RANK[rank], reasons, inclineSource }
}
