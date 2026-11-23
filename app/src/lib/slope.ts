// 경사 지도 묶음(scripts/survey/slope_bundle.py가 만든 slope.json)의 모양과 경사 추정 등급

import type { LonLat } from '@/lib/types'

/** 추정 4종 */
export type EstimateClass = 'gentle' | 'moderate' | 'steep' | 'unknown'
/** 추정 4종 + 현장 조사 완료 3종 (조사 완료 구간은 추정 대신 조사 등급으로 그린다) */
export type SlopeClass = EstimateClass | 'passable' | 'caution' | 'difficult'
export type SlopeMode = 'final' | 'raw'

export interface SlopeSegment {
  id: number
  /** 시작·끝 노드 (경로 계산용) */
  s: number
  t: number
  kind: string | null
  c: LonLat[]
  len: number
  cls: string | null
  name: string | null
  w: number | null
  sw: boolean
  swW: number | null
  bridge: boolean
  tunnel: boolean
  est: EstimateClass
  /** 최종 추정 최대 경사 % (길 위 표고, 관측이 멀면 옹벽 보정 DEM) */
  max: number | null
  /** 평균 경사 % (구간 시작 → 끝, 부호 있음) */
  avg: number | null
  /** DEM 그대로 최대 경사 % (비교용) */
  raw: number | null
  src: 'road_obs' | 'dem' | null
  basis: 'road_surface' | 'sidewalk' | 'centerline' | null
  /** 가장 가까운 길 위 관측까지 거리 m (구간에서 가장 먼 지점 기준) */
  gap: number | null
  check: string[]
  /** 구간 시작(s) → 끝(t) 방향 오르막 최대 % / 내리막 최대 % (반대 방향이면 서로 바뀐다) */
  up?: number | null
  down?: number | null
  /** 산길 추정 이유 (경로에서 뺀다) */
  mtn?: string | null
  /** 산길 판정에서 빼고 남긴 길의 도착지 이름 (예: 무릉계곡관광지) */
  keep?: string | null
  /** 비포장 */
  unpaved?: boolean
  /** 연결 추정 구간이면 이어 준 기관 이름 */
  link?: string | null
  /** 진행 방향(s→t) 경사별 길이 m, 9칸: ≤-8.3 | -8.3~-5.6 | -5.6~-4 | -4~-2 | -2~2 | 2~4 | 4~5.6 | 5.6~8.3 | >8.3 (+ 오르막) */
  h?: number[]
  /** 5.6% 이상 경사가 이어지는 길이 m (+ 오르막, − 내리막, s→t 기준, 9m 이상만) */
  r?: number[]
  /** 현장 조사 결과 (DB surveyed_segments). grade: 조사 완료 등급(없으면 측정만), incline: 현장 측정 최대 |경사| % */
  survey?: SurveyInfo
}

export interface SurveyInfo {
  grade: 'passable' | 'caution' | 'difficult' | null
  incline: number | null
  at: string | null
}

/** 추정 구간 위에 현장 조사 결과를 덮어쓴다 (조사된 구간만 새 객체) */
export function applySurvey(segments: SlopeSegment[], survey: Map<number, SurveyInfo>): SlopeSegment[] {
  if (!survey.size) return segments
  return segments.map((s) => {
    const v = survey.get(s.id)
    return v ? { ...s, survey: v } : s
  })
}

export interface SlopeArea {
  name: string
  generated: string
  center: { name: string; lon: number; lat: number }
  /** 데이터 범위 반경 m */
  radius: number
  /** 처음 화면에 보일 반경 m */
  view: number
  /** 반경으로 자르지 않은 동해시 전체 */
  all?: boolean
  segments: SlopeSegment[]
  crossings: { lon: number; lat: number; kerb: 'lowered' | 'raised' | 'flush' | null }[]
  places: { name: string; category: string; lon: number; lat: number }[]
  image: { coords: LonLat[]; w: number; h: number }
}

// donghae_pipeline.dem_estimate와 같은 기준
export const STEEP_PCT = 8.3
export const MODERATE_PCT = 4.0

export function classify(seg: SlopeSegment, mode: SlopeMode): SlopeClass {
  if (seg.survey?.grade) return seg.survey.grade
  // 현장·관리자가 잰 경사가 있으면 추정(교량·터널의 '판단 불가' 포함) 대신 그 값으로 칠한다
  const measured = seg.survey?.incline
  if (measured != null) return measured > STEEP_PCT ? 'steep' : measured >= MODERATE_PCT ? 'moderate' : 'gentle'
  if (seg.bridge || seg.tunnel) return 'unknown'
  const v = mode === 'final' ? seg.max : seg.raw
  if (v == null) return 'unknown'
  if (v > STEEP_PCT) return 'steep'
  if (v >= MODERATE_PCT) return 'moderate'
  return 'gentle'
}

export const SLOPE_LABEL: Record<SlopeClass, string> = {
  gentle: '완만 (4% 미만)',
  moderate: '측정 필요 (4~8.3%)',
  steep: '급경사 추정 (8.3% 초과)',
  unknown: '판단 불가',
  passable: '조사 완료: 통행 가능',
  caution: '조사 완료: 주의',
  difficult: '조사 완료: 통행 어려움',
}

export const SLOPE_SHORT: Record<SlopeClass, string> = {
  gentle: '완만',
  moderate: '측정 필요',
  steep: '급경사 추정',
  unknown: '판단 불가',
  passable: '통행 가능 (조사)',
  caution: '주의 (조사)',
  difficult: '통행 어려움 (조사)',
}

/** 범례에 늘 보이는 추정 등급 / 조사 완료 등급 */
export const ESTIMATE_CLASSES: SlopeClass[] = ['gentle', 'moderate', 'steep', 'unknown']
export const SURVEY_CLASSES: SlopeClass[] = ['passable', 'caution', 'difficult']

// 색만으로 구분하지 않는다 (PRD R-401): 굵기·점선 모양을 함께 바꾼다
// '측정 필요'(추정 4~8.3%)는 파랑 점선: 위험이 아니라 '아직 재야 함'이고, 노랑 '조사 완료: 주의'와 헷갈리지 않게 (주황이던 것을 바꿈)
export const SLOPE_STYLE: Record<SlopeClass, { color: string; width: number; dash?: string }> = {
  gentle: { color: '#0f766e', width: 3.5 },
  moderate: { color: '#2563eb', width: 4.5, dash: '9 4' },
  steep: { color: '#dc2626', width: 5.5 },
  unknown: { color: '#64748b', width: 3, dash: '2 5' },
  // 조사 완료: 추정보다 굵은 실선 (색·굵기·라벨로 구분)
  passable: { color: '#15803d', width: 8 },
  caution: { color: '#ca8a04', width: 8 },
  difficult: { color: '#b91c1c', width: 8 },
}

/** 카카오 지도 선 (일반 지도·관리자 지도 공통): SLOPE_STYLE과 같은 색, 카카오 Polyline 점선 이름으로 모양도 바꾼다 (색만으로 구분하지 않음, PRD R-401) */
export const KAKAO_LINE_STYLE: Record<SlopeClass, { color: string; weight: number; style: string }> = {
  gentle: { color: '#0f766e', weight: 4, style: 'solid' },
  moderate: { color: '#2563eb', weight: 5, style: 'dash' },
  steep: { color: '#dc2626', weight: 6, style: 'solid' },
  unknown: { color: '#64748b', weight: 4, style: 'shortdot' },
  passable: { color: '#15803d', weight: 8, style: 'solid' },
  caution: { color: '#ca8a04', weight: 8, style: 'solid' },
  difficult: { color: '#b91c1c', weight: 8, style: 'solid' },
}
/** 산길 추정(경로에서 뺀 구간): 흐린 회색 점선 */
export const KAKAO_MTN_STYLE = { color: '#94a3b8', weight: 2, style: 'shortdot' }
/** 관리자 추가 길 (관리자 지도에서 구분용, 보라) */
export const ADMIN_PATH_COLOR = '#7c3aed'

export const SOURCE_LABEL: Record<NonNullable<SlopeSegment['src']>, string> = {
  road_obs: '길 위 표고',
  dem: 'DEM (옹벽·절토 보정)',
}

export const BASIS_LABEL: Record<NonNullable<SlopeSegment['basis']>, string> = {
  road_surface: '도로 면 (인도 포함)',
  sidewalk: '인도 면',
  centerline: '도로 중심선',
}

export function midpoint(c: LonLat[]): LonLat {
  return c[Math.floor(c.length / 2)]
}

export function roadviewUrl(c: LonLat[]): string {
  const [lon, lat] = midpoint(c)
  return `https://map.kakao.com/link/roadview/${lat},${lon}`
}

/** 지도에 그릴 경로 (일반·휠체어 구간 id와 출발·도착) */
export interface RouteOverlay {
  /** 그릴 선들 (인도 보행망이면 인도 위 좌표) */
  general: RouteSection[]
  wheelchair: RouteSection[]
  /** 완만한 대안 (점선) */
  alternative?: RouteSection[]
  /** 경로 위 경사 강조: 가파른 편(주황, 5.6% 이상)·급경사(빨강, 8.3% 초과): 왜 돌아가는지 지도에서 보이게 */
  highlights?: { c: LonLat[]; level: 'caution' | 'steep' }[]
  /** 가장 짧은 길을 막는 곳 말풍선 (예: '급경사 17.9%') */
  blocker?: { at: LonLat; label: string } | null
  /** 이번에 표시한 경로를 실제로 지나는 턱낮춤 없는 횡단보도만 */
  raisedCrossings?: LonLat[]
  from: { name: string; lon: number; lat: number }
  to: { name: string; lon: number; lat: number }
}

export interface RouteSection {
  c: LonLat[]
  /** 추정 경사는 조사 완료 등급으로 바꾸지 않는다. */
  grade: SurveyInfo['grade']
}

export const ROUTE_SURVEY_COLORS = { passable: '#c4b5fd', caution: '#8b5cf6', difficult: '#4c1d95' } as const
export const ROUTE_CROSSING_COLOR = '#f97316'

// 경로 선은 세 색만: 휠체어 경로 파랑(앱 머리띠와 같은 색, 굵게) · 가장 짧은 길(걸어서) 청록 · 경사 구간 주황(파랑의 반대색).
// 더 완만한 길은 휠체어 파랑을 옅게. 경사는 가파른 편(5.6~8.3%)·급경사(8.3% 초과) 모두 주황, 급경사는 더 굵게 (ROUTE_HIGHLIGHT).
// 조각들은 하나의 선으로 잇고 꺾이는 곳을 둥글게 그린다 (routeDisplay joinPaths·smoothPath).
// 굵기: 얇은 선 + 흰 테두리(casing). 구간 선 위에 그려 묻히지 않게 한다 (KakaoSlopeMap)
export const ROUTE_STYLE = {
  general: { color: '#0f766e', width: 5, opacity: 0.95, casing: 3 },
  wheelchair: { color: '#2455ae', width: 7, opacity: 1, casing: 4 },
  alternative: { color: '#2455ae', width: 5, opacity: 0.5, casing: 3 },
}
export const ROUTE_HIGHLIGHT = {
  caution: { color: '#f97316', width: 6 },
  steep: { color: '#f97316', width: 9 },
} as const
