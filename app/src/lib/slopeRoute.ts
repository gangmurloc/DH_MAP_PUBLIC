// 경사 지도 길 안내 — 「무장애 경로 추천 기준」(2026-11-20) 5단계 + 법 기준 (2026-11-20 팀 결정: "법대로 간다")
// 법 기준: 장애인등편의법 시행규칙 [별표 1] 제1호 '장애인등의 통행이 가능한 접근로' (2023.12.11 개정)
//   기울기 1/18 이하, 지형상 곤란하면 1/12(8.3%)까지 · 유효폭 1.2m 이상 · 단차 2cm 이하 · 미끄럽지 않고 평탄한 바닥
//   · 경사진 접근로가 연속되면 30m마다 참
//   ① 못 가는 길 빼기: 법 기준을 넘는 것으로 '알려진' 구간은 그래프에서 뺀다 (벌점이 아니라 삭제)
//      경사 8.3% 초과, 계단, 폭 1.2m 미만 보도, 턱낮춤 없는 횡단보도, 비포장, 조사원이 확인한 단차·좁음·계단·급경사.
//      추정 경사는 경계값(상한 −0.3%p, 8.0~8.6%)부터 급경사로 본다: 잘못 '통행 가능'으로 안내하는 쪽이 더 위험하다.
//      자료가 없어 법 기준을 확인할 수 없는 구간(경사 모름, 턱낮춤 정보 없는 횡단)은 빼지 않고 벌점을 주며 화면에 밝힌다.
//   ② 실측 경사만 쓰기: 동해는 아직 실측이 없어 길 위 표고 '추정'을 쓰고, 화면에 추정이라고 밝힌다 (실측이 생기면 그 값이 우선).
//   ③ 걸리는 시간으로 비교: 구간 시간 = 길이 ÷ (기본 속도 × 경사 계수). 경사별 길이(h)마다 계수를 따로 쳐서 더한다.
//      휠체어는 수동·전동을 나누지 않고 한 기준(더 느린 수동휠체어 값)으로 계산한다.
//   ④ 긴 경사 벌점: 5.6% 이상이 이어지면 30m(법: 경사 접근로 연속 시 30m마다 참)마다 쉬는 시간을 더한다.
//   ⑤ 너무 돌아가면 거르기: 무장애 최단 경로보다 1.2배 또는 200m 넘게 길면 '추천'이 아니라 '대안'.
//   + 법 기준 안으로 갈 길이 없으면 휠체어 경로를 내지 않는다 (기준을 넘는 길을 경고와 함께 보여 주지 않는다).
// 숫자는 ROUTE_PARAMS에서만 바꾼다. '임시'라고 적은 값은 근거 자료가 없어 동해 현장 측정으로 교체할 값이다.
import { metersBetween, MinHeap } from '@/lib/route'
import type { ConfirmedObstacle } from '@/lib/reports'
import type { SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

type Curve = [number, number][]

export const ROUTE_PARAMS = {
  // ① 제외
  /** 진행 방향 오르막·내리막 상한 % (법: 접근로 1/18, 지형상 곤란 시 1/12까지). 사용자는 4~8.3%로 낮출 수만 있다 */
  maxGradePct: 8.3,
  minUserGradePct: 4,
  /** 추정 경사는 '상한 − 이 값'부터 급경사로 본다 (경계값 8.0~8.6% → 급경사) */
  ambiguousMarginPct: 0.3,
  /** 통행 가능(법 원칙 1/18) / 주의 경계 % */
  cautionOverPct: 5.6,
  // ③ 시간
  /** 평지 속도 m/s: 휠체어 0.6 ([D] TCAT 수동휠체어 — 수동·전동 중 느린 쪽), 일반 보행 1.2 */
  speed: { wheelchair: 0.6, walk: 1.2 },
  /** 경사 % → 속도 계수 (사이는 직선 보간, 끝 밖은 마지막 값). 임시값 (기준 문서 표, 수동휠체어).
   *  8.3%를 넘는 점은 일반 경로 시간 표시에만 쓰인다 (휠체어 경로에는 8.3% 넘는 구간이 없다) */
  upFactor: [[0, 1], [2, 1], [4, 0.7], [5.6, 0.5], [8.3, 0.33], [12, 0.2]] as Curve,
  /** 내리막: 기준 문서 표(5%까지 1.0, 8.3% 0.7). 임시값 */
  downFactor: [[0, 1], [5, 1], [8.3, 0.7], [12, 0.5]] as Curve,
  // ④ 긴 경사 (법: 경사진 접근로가 연속되면 30m마다 참)
  restEveryM: 30,
  restSec: 15,
  // 횡단 (턱낮춤 없음이 확인된 횡단보도는 ①에서 뺀다)
  /** 턱이 있을지 모르는 횡단의 벌점 기준 초 (임시). 실제 벌점 = 이 값 × 턱 있을 확률 */
  uncertainCrossingSec: 90,
  /** 턱낮춤 정보가 없는 횡단보도가 턱 있을 확률: 동해 횡단보도표준데이터 158/1,107 */
  unknownCrosswalkRaisedP: 0.14,
  /** 표시 없는 횡단(4차로 미만 교차로)이 턱 있을 확률 (임시, 근거 없음) */
  freeCrossingRaisedP: 0.5,
  /** 횡단보도 자료가 없는 큰길(4차로 이상) 교차로 횡단: 일반 경로 +m, 휠체어 +초 (신호 대기·확인 안 됨, 임시). 턱은 freeCrossingRaisedP로 */
  junctionCrossingM: 50,
  junctionCrossingSec: 60,
  // ⑤ 우회 상한 (둘 다 만족해야 '추천')
  detourRatio: 1.2,
  detourExtraM: 200,
  // ⑤-2 과도한 우회 (일반 경로 대비). 둘 다 넘으면 '추천'이라 하지 않고 '멀리 돌아가는 길'로 안내한다.
  // 임시값: 기준 문서 E·F(받아들이는 우회 20% 안팎)보다 훨씬 큰 값으로 시작, 휠체어 사용자 선택 실험으로 교체
  detourWarnRatio: 3,
  detourWarnExtraM: 1000,
  // 문서에 없는 우리 조건: 시간 × 배수 (임시)
  /** 경사를 모르는 구간(교량·터널·옹벽에 가림) */
  unknownSlopeFactor: 1.8,
  /** 옹벽·절토 선을 가로지르는 구간 (계단·단차 후보) */
  wallCrossingFactor: 2,
  /** 확인된 주의 장애물 (횡경사·파손·기타) */
  obstacleCautionFactor: 2,
  /** 폭 6m 이상 도로인데 보도 자료가 없음 */
  noSidewalkFactor: 1.4,
  /** DEM과 길 위 표고가 크게 달라 경사가 불확실 */
  uncertainSlopeFactor: 1.15,
  /** OSM으로 보완한 길 (현장 확인 전) */
  osmPathFactor: 1.15,
  /** 도로 자료에 없는 '연결 추정' 구간 (모든 모드) */
  assumedLinkFactor: 1.5,
}
export type RouteParams = typeof ROUTE_PARAMS

export interface RouteOptions {
  /** 사용자 상한 % (4~8.3) */
  limitPct: number
}
export const DEFAULT_OPTIONS: RouteOptions = { limitPct: ROUTE_PARAMS.maxGradePct }

/** 출발·도착 지점을 이 거리 안의 노드에 붙인다 */
export const SNAP_MAX_M = 300

/** general: 가장 짧은 길 / wheelchair: 시간 기준 무장애 / shortest: 무장애 최단(⑤의 비교 기준) */
export type RouteMode = 'general' | 'wheelchair' | 'shortest'

export interface SlopeRoute {
  segIds: number[]
  length: number
  /** 예상 시간 초 (휠체어는 프로필 속도·쉬는 시간·횡단 벌점 포함, 일반은 걷기 1.2m/s) */
  timeSec: number
  /** 진행 방향 가장 가파른 오르막·내리막 % (추정) */
  maxUp: number
  maxDown: number
  /** 휠체어로 지날 수 없는 구간(경사 상한 초과·계단·폭·턱·비포장) 길이와 id (일반 경로에서만 0보다 큼) */
  steepM: number
  steepIds: number[]
  /** 주의 경사(5.6%~상한)·경사 모름·단차 후보 구간 길이 */
  cautionM: number
  /** 경사를 모르는 구간 길이 */
  unknownM: number
  /** 조사 전(추정값만) 구간 길이: 지금 데이터는 전부 추정 */
  estimatedM: number
  /** 진행 방향으로 오르는 높이 합 (m) */
  climbM: number
  noSidewalkM: number
  unpavedM: number
  /** 턱 있는 횡단보도 수 */
  raisedCrossings: number
  /** 횡단보도 자료 없이 큰길(4차로 이상)을 교차로에서 건너는 수 */
  junctionCrossings: number
  /** 5.6% 이상 경사가 가장 길게 이어지는 곳: 길이 m, 그 구간 최대 경사 %, 오르막인가 */
  longestRun: { m: number; pct: number; up: boolean } | null
  /** ④ 쉬는 횟수 (9m마다) */
  rests: number
}

type Kind = 'ok' | 'caution' | 'forbid'
type ObsType = ConfirmedObstacle['type']

/** 확인된 장애물: 계단·급경사·단차(법 2cm)·좁음(법 1.2m)은 금지, 횡경사·파손·기타는 주의
 *  (조사원이 장애물로 확인한 단차·좁음은 법 기준을 넘는 것으로 본다. 높이·폭 값이 없어 정도를 따지지 않는다) */
export const OBSTACLE_KIND: Record<ObsType, Kind> = {
  stairs: 'forbid',
  steep: 'forbid',
  kerb: 'forbid',
  narrow: 'forbid',
  cross_slope: 'caution',
  damaged: 'caution',
  other: 'caution',
}

/** 진행 방향(forward: 구간 s→t)으로 갈 때의 오르막·내리막 최대 경사 */
export function directional(s: SlopeSegment, forward: boolean): { up: number | null; down: number | null } {
  // 현장 측정 경사(구간에서 가장 가파른 곳의 |경사|)가 있으면 추정 대신 쓴다. 방향을 재지 않으므로 오르막·내리막 모두 그 값
  const m = s.survey?.incline
  if (m != null) return { up: m, down: m }
  if (s.bridge || s.tunnel) return { up: null, down: null }
  // 방향별 값이 없는 옛 데이터는 최대 경사를 양쪽에 쓴다
  const up = s.up !== undefined ? s.up : s.max
  const down = s.down !== undefined ? s.down : s.max
  if (up == null || down == null) return { up: null, down: null }
  return forward ? { up, down } : { up: down, down: up }
}

/** 진행 방향 가장 가파른 경사 (모르면 null) */
export function gradeOf(s: SlopeSegment, forward: boolean): number | null {
  const { up, down } = directional(s, forward)
  return up == null || down == null ? null : Math.max(up, down)
}

/** 휠체어로 지날 수 없는 구간 자체 (OSM 계단, OSM 휠체어 불가 표시) */
export function isBarrier(s: SlopeSegment): boolean {
  return s.kind === 'osm_steps' || s.check.includes('osm_wheelchair_no')
}

/** 법 기준을 넘는 것으로 알려진 구간 (경사 제외): 폭 1.2m 미만 보도, 턱낮춤 없는 횡단보도(단차 2cm), 비포장(평탄한 바닥) */
export function breaksLaw(s: SlopeSegment): boolean {
  return (
    s.check.includes('narrow_sidewalk') ||
    s.check.includes('crosswalk_raised') ||
    s.check.includes('crosswalk_kerb_not_lowered') ||
    !!s.unpaved
  )
}

/** 경사와 상관없이 휠체어 경로에서 빼는 구간 */
export const hardForbid = (s: SlopeSegment, obs: ObsType[] = []) =>
  s.survey?.grade === 'difficult' || isBarrier(s) || breaksLaw(s) || obs.some((t) => OBSTACLE_KIND[t] === 'forbid')

/** 추정 경사로 자를 기준 (상한 − 경계 여유) */
export function strictCap(o: RouteOptions, p = ROUTE_PARAMS): number {
  const limit = Math.min(p.maxGradePct, Math.max(p.minUserGradePct, o.limitPct))
  return limit - p.ambiguousMarginPct
}

/** 이 구간에 적용할 경사 상한: 추정이면 cap(경계 여유를 뺀 값), 현장 측정이면 여유 없이 상한 그대로 */
function capFor(s: SlopeSegment, cap: number, p = ROUTE_PARAMS): number {
  return s.survey?.incline != null ? cap + p.ambiguousMarginPct : cap
}

/** 등급: 0 통행 가능(≤5.6%), 1 주의(≤상한), 2 급경사 */
export function gradeClass(pct: number, limitPct: number, p = ROUTE_PARAMS): 0 | 1 | 2 {
  return pct <= p.cautionOverPct ? 0 : pct <= limitPct ? 1 : 2
}

export function segmentKind(s: SlopeSegment, forward = true, o: RouteOptions = DEFAULT_OPTIONS, obs: ObsType[] = [], p = ROUTE_PARAMS): Kind {
  if (hardForbid(s, obs)) return 'forbid'
  const g = gradeOf(s, forward)
  if (g == null) return 'caution'
  if (g > capFor(s, strictCap(o, p), p)) return 'forbid'
  if (g > p.cautionOverPct) return 'caution'
  if (s.survey?.grade === 'caution') return 'caution'
  if (s.check.includes('wall_crossing')) return 'caution'
  return obs.some((t) => OBSTACLE_KIND[t] === 'caution') ? 'caution' : 'ok'
}

function interp(curve: Curve, x: number): number {
  if (x <= curve[0][0]) return curve[0][1]
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]
    if (x <= x1) {
      const [x0, y0] = curve[i - 1]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return curve[curve.length - 1][1]
}

/** 경사별 길이 칸(파이프라인 GRADE_EDGES)의 대표 경사: 칸 가운데, 단 구간 최대 경사를 넘지 않게 */
const BIN_MID = [Infinity, 6.95, 4.8, 3, 0, 3, 4.8, 6.95, Infinity]

/** 구간을 진행 방향으로 지나는 순수 경사 시간(초)과 쉬는 횟수. 경사를 모르면 null */
export function slopeTime(s: SlopeSegment, forward: boolean, p = ROUTE_PARAMS): { sec: number; rests: number } | null {
  const { up, down } = directional(s, forward)
  if (up == null || down == null) return null
  const v = p.speed.wheelchair
  const kUp = (g: number) => interp(p.upFactor, g)
  const kDown = (g: number) => interp(p.downFactor, g)
  const h = s.h
  const total = h ? h.reduce((a, b) => a + b, 0) : 0
  // 현장 측정 경사는 구간 전체를 그 경사로 친다 (경사별 길이 h는 추정 자료)
  if (!h || total <= 0 || s.survey?.incline != null) return { sec: s.len / (v * Math.min(kUp(up), kDown(down))), rests: 0 }
  // 원래 구간의 일부(인도 선 조각)면 같은 비율로 나눠 갖는다
  const frac = s.len / total
  const bins = forward ? h : [...h].reverse()
  let sec = 0
  bins.forEach((m, i) => {
    if (!m) return
    const k = i < 4 ? kDown(Math.min(BIN_MID[i], down)) : i > 4 ? kUp(Math.min(BIN_MID[i], up)) : 1
    sec += (m * frac) / (v * k)
  })
  let rests = 0
  for (const r of s.r ?? []) rests += Math.floor(Math.abs(r) / p.restEveryM)
  return { sec, rests: rests * frac }
}

/** 구간 비용. general·shortest는 m, wheelchair는 초. cap: 이 경사 초과는 뺀다 (기본: 엄격 기준) */
export function segmentCost(
  s: SlopeSegment,
  mode: RouteMode,
  forward = true,
  o: RouteOptions = DEFAULT_OPTIONS,
  obs: ObsType[] = [],
  cap = strictCap(o),
  p = ROUTE_PARAMS,
): number {
  if (s.mtn) return Infinity // 산길 추정: 어느 모드에서도 쓰지 않는다
  const linkF = s.kind === 'assumed_link' ? p.assumedLinkFactor : 1
  if (mode === 'general') return s.len * linkF + (s.kind === 'walk_cross_junction' ? p.junctionCrossingM : 0)
  if (hardForbid(s, obs)) return Infinity
  const g = gradeOf(s, forward)
  if (g != null && g > capFor(s, cap, p)) return Infinity
  if (mode === 'shortest') return s.len * linkF
  const st = slopeTime(s, forward, p)
  let t = st ? st.sec : (s.len / p.speed.wheelchair) * p.unknownSlopeFactor
  t *= linkF
  if (s.check.includes('wall_crossing')) t *= p.wallCrossingFactor
  if (obs.some((k) => OBSTACLE_KIND[k] === 'caution')) t *= p.obstacleCautionFactor
  if (s.check.includes('no_sidewalk_data')) t *= p.noSidewalkFactor
  if (s.check.includes('slope_sources_disagree')) t *= p.uncertainSlopeFactor
  if (s.kind === 'osm_path') t *= p.osmPathFactor
  t += (st?.rests ?? 0) * p.restSec
  // 턱 있는 것이 확인된 횡단보도는 hardForbid에서 이미 뺐다. 여기는 턱이 있을지 모르는 횡단
  const c = p.uncertainCrossingSec
  if (s.check.includes('crosswalk_kerb_unknown')) t += c * p.unknownCrosswalkRaisedP
  else if (s.kind === 'walk_cross_free') t += c * p.freeCrossingRaisedP
  else if (s.kind === 'walk_cross_junction') t += c * p.freeCrossingRaisedP + p.junctionCrossingSec
  return t
}

interface Edge {
  to: number
  seg: SlopeSegment
  forward: boolean
}

export class SlopeGraph {
  adj = new Map<number, Edge[]>()
  pos = new Map<number, LonLat>()
  /** 구간 id → 확인된 장애물 종류 */
  obs: Map<number, ObsType[]>
  seg = new Map<number, SlopeSegment>()
  /** positions: 노드 좌표를 따로 줄 때 (인도 보행망 꼭짓점). 없으면 구간 좌표 끝점 */
  constructor(segments: SlopeSegment[], obstacles: Map<number, ObsType[]> = new Map(), positions?: Map<number, LonLat>) {
    this.obs = obstacles
    for (const s of segments) {
      this.seg.set(s.id, s)
      this.link(s.s, { to: s.t, seg: s, forward: true })
      this.link(s.t, { to: s.s, seg: s, forward: false })
      if (!positions) {
        this.pos.set(s.s, s.c[0])
        this.pos.set(s.t, s.c[s.c.length - 1])
      }
    }
    if (positions) for (const n of this.adj.keys()) {
      const p = positions.get(n)
      if (p) this.pos.set(n, p)
    }
  }
  private link(n: number, e: Edge) {
    const l = this.adj.get(n)
    if (l) l.push(e)
    else this.adj.set(n, [e])
  }

  /** 가장 가까운 노드 (SNAP_MAX_M 밖이면 null). 산길에만 붙은 노드는 고르지 않는다 */
  nearest(p: LonLat, maxM = SNAP_MAX_M): { node: number; dist: number } | null {
    let best: { node: number; dist: number } | null = null
    for (const [n, q] of this.pos) {
      if (!(this.adj.get(n) ?? []).some((e) => !e.seg.mtn)) continue
      const d = metersBetween(p, q)
      if (d <= maxM && (!best || d < best.dist)) best = { node: n, dist: d }
    }
    return best
  }

  /** 다익스트라 (이진 힙). cost가 무한이면 그 구간을 뺀다 */
  private search(from: number, to: number, cost: (e: Edge) => number): Edge[] | null {
    const dist = new Map<number, number>([[from, 0]])
    const prev = new Map<number, { from: number; e: Edge }>()
    const done = new Set<number>()
    const open = new MinHeap()
    open.push(0, from)
    for (let top = open.pop(); top; top = open.pop()) {
      const [d, n] = top
      if (done.has(n)) continue
      done.add(n)
      if (n === to) break
      for (const e of this.adj.get(n) ?? []) {
        const c = cost(e)
        if (!Number.isFinite(c)) continue
        const nd = d + c
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd)
          prev.set(e.to, { from: n, e })
          open.push(nd, e.to)
        }
      }
    }
    if (!done.has(to)) return null
    const steps: Edge[] = []
    for (let n = to; n !== from; ) {
      const p = prev.get(n)!
      steps.push(p.e)
      n = p.from
    }
    return steps.reverse()
  }

  route(from: number, to: number, mode: RouteMode, o: RouteOptions = DEFAULT_OPTIONS, cap = strictCap(o)): SlopeRoute | null {
    const steps = this.search(from, to, (e) => segmentCost(e.seg, mode, e.forward, o, this.obs.get(e.seg.id), cap))
    return steps && this.summarize(steps, mode, o)
  }

  /** 최대 경사 최소화: 출발→도착 길 중 '가장 가파른 곳'이 가장 낮은 값. 경사 말고 다른 이유로 못 가는 구간
   *  (계단·산길·폭·턱·비포장)은 뺀다. 그래도 길이 없으면 null. 경사를 모르는 구간은 0으로 친다 (엄격 경로에서도 쓰는 구간이므로).
   *  법 기준 안으로 갈 길이 없을 때 '왜 없는지'(어느 길로 가도 지나야 하는 경사)를 알려 주는 데만 쓴다 */
  bottleneck(from: number, to: number): number | null {
    const best = new Map<number, number>([[from, 0]])
    const done = new Set<number>()
    const open = new MinHeap()
    open.push(0, from)
    for (let top = open.pop(); top; top = open.pop()) {
      const [b, n] = top
      if (done.has(n)) continue
      done.add(n)
      if (n === to) return b
      for (const e of this.adj.get(n) ?? []) {
        if (e.seg.mtn || hardForbid(e.seg, this.obs.get(e.seg.id))) continue
        const nb = Math.max(b, gradeOf(e.seg, e.forward) ?? 0)
        if (nb < (best.get(e.to) ?? Infinity)) {
          best.set(e.to, nb)
          open.push(nb, e.to)
        }
      }
    }
    return null
  }

  private summarize(steps: Edge[], mode: RouteMode, o: RouteOptions): SlopeRoute {
    const p = ROUTE_PARAMS
    const out: SlopeRoute = {
      segIds: [], length: 0, timeSec: 0, maxUp: 0, maxDown: 0, steepM: 0, steepIds: [], cautionM: 0, unknownM: 0, estimatedM: 0,
      climbM: 0, noSidewalkM: 0, unpavedM: 0, raisedCrossings: 0, junctionCrossings: 0, longestRun: null, rests: 0,
    }
    for (const { seg: s, forward } of steps) {
      const obs = this.obs.get(s.id) ?? []
      out.segIds.push(s.id)
      out.length += s.len
      if (!s.survey?.grade) out.estimatedM += s.len
      const { up, down } = directional(s, forward)
      if (up == null || down == null) out.unknownM += s.len
      else {
        out.maxUp = Math.max(out.maxUp, up)
        out.maxDown = Math.max(out.maxDown, down)
      }
      const g = gradeOf(s, forward)
      if (hardForbid(s, obs) || (g != null && g > capFor(s, strictCap(o)))) {
        out.steepM += s.len
        out.steepIds.push(s.id)
      } else if (segmentKind(s, forward, o, obs) === 'caution') out.cautionM += s.len
      if (s.avg != null && !s.bridge && !s.tunnel) out.climbM += Math.max(0, ((forward ? s.avg : -s.avg) * s.len) / 100)
      if (s.check.includes('no_sidewalk_data')) out.noSidewalkM += s.len
      if (s.unpaved) out.unpavedM += s.len
      if (s.check.includes('crosswalk_kerb_not_lowered') || s.check.includes('crosswalk_raised')) out.raisedCrossings += 1
      if (s.kind === 'walk_cross_junction') out.junctionCrossings += 1
      // 긴 경사: 인도 선 조각이면 원래 구간 비율만큼
      const total = s.h ? s.h.reduce((a, b) => a + b, 0) : s.len
      const frac = total > 0 ? Math.min(1, s.len / total) : 1
      for (const r of s.r ?? []) {
        const m = Math.abs(r) * frac
        const isUp = (r > 0) === forward
        const pct = (isUp ? up : down) ?? 0
        if (m >= p.restEveryM && (!out.longestRun || m > out.longestRun.m)) out.longestRun = { m, pct, up: isUp }
      }
      if (mode === 'general') out.timeSec += s.len / p.speed.walk
      else {
        const t = segmentCost(s, 'wheelchair', forward, o, obs, Infinity)
        out.timeSec += Number.isFinite(t) ? t : s.len / p.speed.wheelchair
        out.rests += slopeTime(s, forward)?.rests ?? 0
      }
    }
    out.rests = Math.round(out.rests)
    return out
  }
}

export interface RoutePlan {
  general: SlopeRoute | null
  /** 추천 휠체어 경로 (법 기준 안으로 갈 길이 없으면 null) */
  wheelchair: SlopeRoute | null
  /** ⑤ 추천보다 등급이 낮은(완만한) 시간 기준 경로가 우회 상한을 넘을 때: '완만한 대안' */
  alternative: SlopeRoute | null
  /** 추천이 시간 기준 경로인가, 무장애 최단 경로인가 */
  choice: 'time' | 'shortest' | null
  /** 법 기준 안으로 갈 길이 없을 때 그 이유.
   *  unavoidablePct: 어느 길로 가도 지나야 하는 가장 가파른 곳 % (추정). null이면 경사와 상관없이 계단·산길·턱 등으로 이어지는 길이 없다 */
  blocked: { unavoidablePct: number | null } | null
  /** 일반 경로 대비 우회 정도와, 일반 경로를 휠체어로 못 가게 막는 구간 (assessDetour) */
  detour: DetourInfo
  options: RouteOptions
  snap: { from: number; to: number }
}

/** 일반 경로를 휠체어로 못 가게 막는 대표 구간 */
export interface Blocker {
  /** 그래프 구간 id (보행망이면 보행망 id) */
  segId: number
  /** 원래 구간 id (보행망이면 walk.parent). 화면·제보 문구에 쓴다 */
  parentId: number
  reason: 'steep' | 'stairs' | 'kerb' | 'narrow' | 'unpaved' | 'surveyed_difficult' | 'other'
  /** reason이 steep이면 가장 가파른 경사 % (추정이면 추정값) */
  pct: number | null
  /** 같은 원래 구간에서 막힌 길이 합 m */
  lengthM: number
  /** 현장 조사 전 추정값인가 */
  estimated: boolean
  /** 구간 가운데 좌표 (로드뷰·제보 위치) */
  at: LonLat
}

export interface DetourInfo {
  /** 휠체어 경로가 일반 경로보다 detourWarnRatio배 이상 + detourWarnExtraM 이상 길다 (휠체어 경로가 없으면 false) */
  excessive: boolean
  /** 휠체어 ÷ 일반 길이 */
  ratio: number | null
  /** 휠체어 − 일반 길이 m */
  extraM: number | null
  /** 일반 경로에서 휠체어로 못 가는 구간 중 대표 하나 */
  blocker: Blocker | null
  /** 일반 경로에서 휠체어로 못 가는 구간 길이 합 m (= general.steepM) */
  blockedM: number
}

type Walkish = SlopeSegment & { walk?: { parent: number } }

/** 경사 말고 다른 이유로 못 가는 구간의 이유 */
function barrierReason(s: SlopeSegment, obs: ObsType[]): Blocker['reason'] {
  if (s.survey?.grade === 'difficult') return 'surveyed_difficult'
  if (s.kind === 'osm_steps' || obs.includes('stairs')) return 'stairs'
  if (obs.includes('steep')) return 'steep' // 조사원이 확인한 급경사 장애물 (경사 값은 없음)
  if (s.check.includes('crosswalk_raised') || s.check.includes('crosswalk_kerb_not_lowered') || obs.includes('kerb')) return 'kerb'
  if (s.check.includes('narrow_sidewalk') || obs.includes('narrow')) return 'narrow'
  if (s.unpaved) return 'unpaved'
  return 'other'
}

/** 일반 경로 대비 우회 정도와 막는 구간 (planRoute가 부른다) */
export function assessDetour(plan: Omit<RoutePlan, 'detour'>, g: SlopeGraph, p = ROUTE_PARAMS): DetourInfo {
  const G = plan.general
  const W = plan.wheelchair
  const ratio = G && W && G.length > 0 ? W.length / G.length : null
  const extraM = G && W ? W.length - G.length : null
  const excessive = ratio != null && extraM != null && ratio >= p.detourWarnRatio && extraM >= p.detourWarnExtraM
  if (!G || !G.steepIds.length) return { excessive, ratio, extraM, blocker: null, blockedM: G?.steepM ?? 0 }

  const cap = strictCap(plan.options, p)
  const lenByParent = new Map<number, number>()
  type Cand = { s: Walkish; obs: ObsType[]; parentId: number; pct: number; steep: boolean }
  const cands: Cand[] = []
  for (const id of G.steepIds) {
    const s = g.seg.get(id) as Walkish | undefined
    if (!s) continue
    const obs = g.obs.get(id) ?? []
    const parentId = s.walk?.parent || s.id
    lenByParent.set(parentId, (lenByParent.get(parentId) ?? 0) + s.len)
    const pct = Math.max(gradeOf(s, true) ?? 0, gradeOf(s, false) ?? 0)
    cands.push({ s, obs, parentId, pct, steep: pct > capFor(s, cap, p) })
  }
  const steep = cands.filter((c) => c.steep)
  // 경사 때문이면 가장 가파른 것, 경사가 아닌 이유만 있으면 가장 긴 것
  const pick = steep.length
    ? steep.reduce((a, b) => (b.pct > a.pct ? b : a))
    : cands.reduce((a, b) => ((lenByParent.get(b.parentId) ?? 0) > (lenByParent.get(a.parentId) ?? 0) ? b : a), cands[0])
  if (!pick) return { excessive, ratio, extraM, blocker: null, blockedM: G.steepM }
  const s = pick.s
  return {
    excessive,
    ratio,
    extraM,
    blockedM: G.steepM,
    blocker: {
      segId: s.id,
      parentId: pick.parentId,
      reason: pick.steep ? 'steep' : barrierReason(s, pick.obs),
      pct: pick.steep ? Math.round(pick.pct * 10) / 10 : null,
      lengthM: Math.round(lenByParent.get(pick.parentId) ?? s.len),
      estimated: !s.survey?.grade && s.survey?.incline == null,
      at: s.c[Math.floor(s.c.length / 2)],
    },
  }
}

/** ⑤ 시간 기준 경로(T)와 무장애 최단 경로(S) 중 추천 고르기 */
export function chooseRoute(T: SlopeRoute, S: SlopeRoute, limitPct: number, p = ROUTE_PARAMS): Pick<RoutePlan, 'wheelchair' | 'alternative' | 'choice'> {
  if (T.length <= S.length * p.detourRatio && T.length - S.length <= p.detourExtraM) return { wheelchair: T, alternative: null, choice: 'time' }
  const cls = (r: SlopeRoute) => gradeClass(Math.max(r.maxUp, r.maxDown), limitPct, p)
  if (cls(T) < cls(S)) return { wheelchair: S, alternative: T, choice: 'shortest' }
  return { wheelchair: S, alternative: null, choice: 'shortest' }
}

/** 두 지점 사이 일반·휠체어 경로. 어느 한쪽이 데이터 범위 밖이면 null */
export function planRoute(g: SlopeGraph, a: LonLat, b: LonLat, o: RouteOptions = DEFAULT_OPTIONS): RoutePlan | null {
  const na = g.nearest(a)
  const nb = g.nearest(b)
  if (!na || !nb) return null
  const opts = { ...o, limitPct: Math.min(ROUTE_PARAMS.maxGradePct, Math.max(ROUTE_PARAMS.minUserGradePct, o.limitPct)) }
  const general = g.route(na.node, nb.node, 'general', opts)
  const cap = strictCap(opts)
  const T = g.route(na.node, nb.node, 'wheelchair', opts, cap)
  const base = { general, options: opts, snap: { from: na.dist, to: nb.dist } }
  let plan: Omit<RoutePlan, 'detour'>
  if (T) {
    const S = g.route(na.node, nb.node, 'shortest', opts, cap) ?? T
    plan = { ...base, blocked: null, ...chooseRoute(T, S, opts.limitPct) }
  } else {
    // 법 기준 안으로 갈 길이 없다: 휠체어 경로를 내지 않고 이유만 알려 준다
    plan = { ...base, blocked: { unavoidablePct: g.bottleneck(na.node, nb.node) }, wheelchair: null, alternative: null, choice: null }
  }
  return { ...plan, detour: assessDetour(plan, g) }
}

/** 확인된 장애물을 가장 가까운 구간(maxM 안)에 붙인다. 구간 id → 장애물 종류 목록 */
export function attachObstacles(segments: SlopeSegment[], obstacles: ConfirmedObstacle[], maxM = 15): Map<number, ObsType[]> {
  const out = new Map<number, ObsType[]>()
  const k = 111_320
  for (const o of obstacles) {
    const cx = Math.cos((o.lat * Math.PI) / 180)
    const pad = maxM / k / cx
    let best: { id: number; d: number } | null = null
    for (const s of segments) {
      if (s.mtn) continue
      // 상자로 먼저 거른다
      let near = false
      for (const [x, y] of s.c) if (Math.abs(x - o.lon) < pad * 20 && Math.abs(y - o.lat) < pad * 20) near = true
      if (!near) continue
      for (let i = 0; i + 1 < s.c.length; i++) {
        const [ax, ay] = [(s.c[i][0] - o.lon) * k * cx, (s.c[i][1] - o.lat) * k]
        const [bx, by] = [(s.c[i + 1][0] - o.lon) * k * cx, (s.c[i + 1][1] - o.lat) * k]
        const dx = bx - ax
        const dy = by - ay
        const L2 = dx * dx + dy * dy
        const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0
        const d = Math.hypot(ax + t * dx, ay + t * dy)
        if (d <= maxM && (!best || d < best.d)) best = { id: s.id, d }
      }
    }
    if (best) out.set(best.id, [...(out.get(best.id) ?? []), o.type])
  }
  return out
}
