// 공용 타입: 좌표, 조사 등급, 등급 제안 규칙(grade.ts)이 쓰는 구간·조사 기록 모양, 점검 항목 라벨

export type Grade = 'passable' | 'caution' | 'difficult'
export type DemEstimate = 'gentle' | 'moderate' | 'steep' | 'unknown'
export type ObstacleType = 'kerb' | 'stairs' | 'narrow' | 'damaged' | 'steep'
export type LonLat = [number, number]

export interface Segment {
  id: number
  s: number // 시작 노드
  t: number // 끝 노드
  c: LonLat[]
  len: number
  cls: string | null
  name: string | null
  w: number | null
  sw: boolean
  swW: number | null
  bridge: boolean
  stairs: boolean
  tunnel: boolean
  underpass: boolean
  overpass: 'accessible' | 'inaccessible' | null
  demMax: number | null
  demEst: DemEstimate
  check: string[]
  assumed?: boolean // 도로 자료에 없는 연결 추정 (현장 확인 대상)
  excluded?: string // 산길 추정으로 뺀 이유
}

export interface Obstacle {
  id: string
  type: ObstacleType
  kerbCm: number | null
  widthCm: number | null
}

export interface SurveyRecord {
  segId: number
  /** 진행 방향 경사 %, 오르막 + (점검표 진행방위 기준) */
  incline: number | null
  cross: number | null
  obstacles: Obstacle[]
  /** 조사 완료 때 정한 등급. done이 false면 무시 */
  grade: Grade | null
  reason: string
  done: boolean
  memo: string
  updatedAt: string
}

export const GRADE_LABEL: Record<Grade | 'unsurveyed', string> = {
  passable: '통행 가능',
  caution: '주의',
  difficult: '통행 어려움',
  unsurveyed: '미조사',
}

// donghae_pipeline.check_items 코드
export const CHECK_LABEL: Record<string, string> = {
  bridge_measure: '교량: 현장 측정',
  slope_measure: '경사 측정',
  slope_confirm_steep: '급경사 확인',
  wall_or_cut_nearby: '옹벽·절토 단차',
  wall_crossing: '옹벽·절토 가로지름: 계단·단차',
  slope_sources_disagree: '경사 추정 불일치: 측정 우선',
  stairs_nearby: '계단 근처',
  tunnel: '터널',
  underpass_no_sidewalk: '보도 없는 지하차도',
  overpass_inaccessible: '장애인 이용 불가 육교: 평면 횡단 확인',
  no_sidewalk_data: '보도 유무',
  narrow_sidewalk: '좁은 보도',
  crosswalk_kerb_not_lowered: '횡단보도 턱',
  crosswalk_which_side: '횡단보도 위치',
  assumed_link: '도로 자료에 없는 연결: 실제 길 확인',
  osm_steps: 'OSM 계단: 휠체어 불가',
  osm_path: 'OSM에서 보완한 길: 현장 확인',
  admin_path: '관리자가 추가한 길 (경사는 현장에서 잰 값)',
  osm_wheelchair_no: 'OSM 휠체어 불가 표시',
}
