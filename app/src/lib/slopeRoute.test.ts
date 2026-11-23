import { describe, expect, it } from 'vitest'
import type { SlopeSegment } from './slope'
import { attachObstacles, chooseRoute, DEFAULT_OPTIONS, planRoute, ROUTE_PARAMS, segmentCost, segmentKind, slopeTime, SlopeGraph } from './slopeRoute'

function seg(id: number, s: number, t: number, len: number, max: number | null, extra: Partial<SlopeSegment> = {}): SlopeSegment {
  // 노드 n은 경도 129 + n*0.001에 놓는다 (약 88m 간격)
  const lon = (n: number) => 129 + n * 0.001
  return {
    id, s, t, kind: 'road', c: [[lon(s), 37.5], [lon(t), 37.5]], len, cls: null, name: null, w: null, sw: false, swW: null,
    bridge: false, tunnel: false, est: 'gentle', max, avg: null, raw: max, src: 'road_obs', basis: 'centerline', gap: 10, check: [],
    ...extra,
  }
}
const up = (id: number, s: number, t: number, len: number, u: number, extra: Partial<SlopeSegment> = {}) => seg(id, s, t, len, u, { up: u, down: 0, ...extra })
const P = ROUTE_PARAMS
const O = DEFAULT_OPTIONS

describe('① 못 가는 길 빼기', () => {
  it('상한 8.3%, 추정은 경계값 8.0%부터 급경사', () => {
    expect(segmentKind(seg(1, 0, 1, 10, 9))).toBe('forbid')
    expect(segmentKind(seg(1, 0, 1, 10, 8.1))).toBe('forbid')
    expect(segmentKind(seg(1, 0, 1, 10, 7.9))).toBe('caution')
    expect(segmentKind(seg(1, 0, 1, 10, 5.6))).toBe('ok')
    expect(segmentKind(seg(1, 0, 1, 10, null))).toBe('caution')
    expect(segmentKind(seg(1, 0, 1, 10, 2, { bridge: true }))).toBe('caution')
    expect(segmentKind(seg(1, 0, 1, 10, 2, { check: ['wall_crossing'] }))).toBe('caution')
  })

  it('사용자가 상한을 6%로 낮추면 5.8%도 뺀다. 8.3%보다 높일 수는 없다', () => {
    expect(segmentKind(seg(1, 0, 1, 10, 5.8), true, { ...O, limitPct: 6 })).toBe('forbid')
    expect(segmentKind(seg(1, 0, 1, 10, 9), true, { ...O, limitPct: 15 })).toBe('forbid')
  })

  it('내리막도 같은 기준, 일반 경로는 거리만', () => {
    expect(segmentCost(seg(1, 0, 1, 100, 9, { up: 0, down: 9 }), 'wheelchair')).toBe(Infinity)
    expect(segmentCost(seg(1, 0, 1, 100, 9), 'general')).toBe(100)
  })

  it('법 기준: 폭 1.2m 미만 보도, 턱낮춤 없는 횡단보도, 비포장은 경사와 상관없이 뺀다 (일반 경로는 지난다)', () => {
    for (const extra of [{ check: ['narrow_sidewalk'] }, { check: ['crosswalk_raised'] }, { check: ['crosswalk_kerb_not_lowered'] }, { unpaved: true }]) {
      const s = up(1, 0, 1, 50, 1, extra)
      expect(segmentKind(s)).toBe('forbid')
      expect(segmentCost(s, 'wheelchair', true, O, [], Infinity)).toBe(Infinity)
      expect(segmentCost(s, 'general')).toBe(50)
    }
  })

  it('OSM 계단은 상한을 풀어도 휠체어로 쓰지 않고, 산길은 어느 모드도 쓰지 않는다', () => {
    const st = seg(1, 0, 1, 20, 1, { kind: 'osm_steps', check: ['osm_steps'] })
    expect(segmentCost(st, 'wheelchair', true, O, [], Infinity)).toBe(Infinity)
    expect(segmentCost(st, 'general')).toBe(20)
    const mtn = seg(1, 0, 1, 100, 1, { mtn: '고도 200m' })
    expect(segmentCost(mtn, 'general')).toBe(Infinity)
    expect(segmentCost(mtn, 'wheelchair')).toBe(Infinity)
  })
})

describe('③ 걸리는 시간', () => {
  const flat = 100 / P.speed.wheelchair

  it('문서 예: 수동휠체어 100m, 3% 오르막 +29초, 8% 오르막 +310초', () => {
    expect(segmentCost(up(1, 0, 1, 100, 0), 'wheelchair')).toBeCloseTo(flat)
    expect(segmentCost(up(1, 0, 1, 100, 3), 'wheelchair') - flat).toBeCloseTo(29, 0)
    expect(segmentCost(up(1, 0, 1, 100, 8), 'wheelchair', true, O, [], Infinity) - flat).toBeCloseTo(310, -1)
  })

  it('경사별 길이(h)가 있으면 칸마다 따로 계산하고, 반대 방향은 칸을 뒤집는다', () => {
    // 100m 중 30m만 5.6~8.3% 오르막, 나머지 평지
    const s = up(1, 0, 1, 100, 7, { h: [0, 0, 0, 0, 70, 0, 0, 30, 0] })
    const fwd = slopeTime(s, true)!.sec
    // 칸 대표 경사 6.95% (5.6~8.3 가운데, 구간 최대 7% 이하)
    expect(fwd).toBeCloseTo(70 / 0.6 + 30 / (0.6 * (0.5 - 0.17 * (1.35 / 2.7))), 1)
    expect(fwd).toBeLessThan(segmentCost(up(1, 0, 1, 100, 7), 'wheelchair')) // 전체를 7%로 치는 것보다 짧다
    const back = slopeTime(s, false)!.sec // 내리막 7%: 계수 0.7~1 사이
    expect(back).toBeLessThan(fwd)
  })

  it('인도 선 조각(길이가 원래 구간의 일부)이면 같은 비율로 나눈다', () => {
    const whole = up(1, 0, 1, 100, 7, { h: [0, 0, 0, 0, 70, 0, 0, 30, 0] })
    const half = { ...whole, len: 50 }
    expect(slopeTime(half, true)!.sec).toBeCloseTo(slopeTime(whole, true)!.sec / 2)
  })

  it('턱낮춤 정보가 없는 횡단보도는 90초 × 턱 있을 확률(0.14)', () => {
    const base = segmentCost(up(1, 0, 1, 10, 0), 'wheelchair')
    const unknown = segmentCost(up(1, 0, 1, 10, 0, { check: ['crosswalk_kerb_unknown'] }), 'wheelchair')
    expect(unknown - base).toBeCloseTo(90 * 0.14)
  })

  it('보도 없는 큰길은 시간 배수', () => {
    const base = segmentCost(up(1, 0, 1, 100, 1), 'wheelchair')
    expect(segmentCost(up(1, 0, 1, 100, 1, { check: ['no_sidewalk_data'] }), 'wheelchair')).toBeCloseTo(base * P.noSidewalkFactor)
  })
})

describe('④ 긴 경사 (법: 경사진 접근로가 연속되면 30m마다 참)', () => {
  it('5.6% 이상이 45m 이어지면 1번, 65m면 2번 15초씩 쉰다', () => {
    const plain = up(1, 0, 1, 100, 6, { h: [0, 0, 0, 0, 35, 0, 0, 65, 0] })
    expect(segmentCost({ ...plain, r: [45] }, 'wheelchair') - segmentCost(plain, 'wheelchair')).toBeCloseTo(1 * P.restSec)
    expect(segmentCost({ ...plain, r: [65] }, 'wheelchair') - segmentCost(plain, 'wheelchair')).toBeCloseTo(2 * P.restSec)
  })
})

describe('경로', () => {
  // 0 ─(급경사 100m)─ 1      짧지만 가파른 길
  // 0 ─ 2 ─ 3 ─ 1 (완만 3×60m) 돌아가는 길
  const g = new SlopeGraph([up(1, 0, 1, 100, 12), up(2, 0, 2, 60, 1), up(3, 2, 3, 60, 1), up(4, 3, 1, 60, 1)])

  it('일반 경로는 짧은 급경사로, 휠체어는 돌아간다', () => {
    const r = g.route(0, 1, 'general')!
    expect(r.segIds).toEqual([1])
    expect(r.steepM).toBe(100)
    const w = g.route(0, 1, 'wheelchair')!
    expect(w.segIds).toEqual([2, 3, 4])
    expect(w.steepM).toBe(0)
    expect(w.timeSec).toBeCloseTo(180 / P.speed.wheelchair) // 1%는 감속 없음
  })

  it('법 기준 안으로 길이 없으면 휠체어 경로를 내지 않고, 어느 길로 가도 지나야 하는 경사를 알려 준다', () => {
    // 0─1 직접 12%, 0─2─1 9% 두 개: 어느 쪽도 8.3%를 넘는다
    const g2 = new SlopeGraph([up(1, 0, 1, 100, 12), up(2, 0, 2, 100, 9), up(3, 2, 1, 100, 9)])
    expect(g2.route(0, 1, 'wheelchair')).toBeNull()
    const plan = planRoute(g2, [129, 37.5], [129.001, 37.5])!
    expect(plan.wheelchair).toBeNull()
    expect(plan.alternative).toBeNull()
    expect(plan.choice).toBeNull()
    expect(plan.blocked).toEqual({ unavoidablePct: 9 })
    expect(plan.general!.segIds).toEqual([1]) // 일반 경로는 참고용으로 그대로
  })

  it('상한을 살짝 넘는 곳(8.1%, 추정 경계값)도 지나지 않는다', () => {
    // 0─1 직접 8.1% 100m, 우회 평지 1km: 우회
    const g5 = new SlopeGraph([up(1, 0, 1, 100, 8.1), up(2, 0, 2, 500, 0), up(3, 2, 1, 500, 0)])
    expect(planRoute(g5, [129, 37.5], [129.001, 37.5])!.wheelchair!.segIds).toEqual([2, 3])
    // 우회가 없으면 경로 없음
    const p6 = planRoute(new SlopeGraph([up(1, 0, 1, 100, 8.1)]), [129, 37.5], [129.001, 37.5])!
    expect(p6.wheelchair).toBeNull()
    expect(p6.blocked).toEqual({ unavoidablePct: 8.1 })
  })

  it('법 기준 안 경로가 있으면 blocked 없음', () => {
    const plan = planRoute(g, [129, 37.5], [129.001, 37.5])!
    expect(plan.blocked).toBeNull()
    expect(plan.wheelchair?.segIds).toEqual([2, 3, 4])
  })

  it('경사가 아니라 턱 때문에 길이 없으면 unavoidablePct는 null', () => {
    const p = planRoute(new SlopeGraph([up(1, 0, 1, 100, 1, { check: ['crosswalk_raised'] })]), [129, 37.5], [129.001, 37.5])!
    expect(p.wheelchair).toBeNull()
    expect(p.blocked).toEqual({ unavoidablePct: null })
  })

  it('오르는 높이 합은 진행 방향으로 센다', () => {
    const g3 = new SlopeGraph([seg(1, 0, 1, 100, 4, { avg: 4, up: 4, down: 0 })])
    expect(g3.route(0, 1, 'general')!.climbM).toBeCloseTo(4)
    expect(g3.route(1, 0, 'general')!.climbM).toBeCloseTo(0)
  })

  it('가장 가까운 노드에 붙이고, 300m 밖이면 null', () => {
    expect(g.nearest([129.0001, 37.5])?.node).toBe(0)
    expect(g.nearest([129.2, 37.5])).toBeNull()
  })
})

describe('⑤ 너무 돌아가면 거르기 (기준은 무장애 최단 경로)', () => {
  const plan = (detourLen: number, directPct: number) => {
    // 0─1 직접 300m(오르막 directPct), 0─2─1 평지 우회 detourLen
    const g = new SlopeGraph([up(1, 0, 1, 300, directPct), up(2, 0, 2, detourLen / 2, 0), up(3, 2, 1, detourLen / 2, 0)])
    return planRoute(g, [129, 37.5], [129.001, 37.5])!
  }

  it('1.2배·+200m 안이면 시간 기준 경로를 추천', () => {
    const p = plan(340, 7)
    expect(p.choice).toBe('time')
    expect(p.wheelchair!.length).toBe(340)
    expect(p.alternative).toBeNull()
  })

  it('상한을 넘지만 등급이 내려가면(주의 → 통행 가능) 최단을 추천하고 우회는 완만한 대안', () => {
    const p = plan(500, 7)
    expect(p.choice).toBe('shortest')
    expect(p.wheelchair!.length).toBe(300)
    expect(p.alternative!.length).toBe(500)
  })

  it('상한을 넘고 등급도 그대로면 최단만', () => {
    const p = plan(400, 5.5)
    expect(p.choice).toBe('shortest')
    expect(p.wheelchair!.length).toBe(300)
    expect(p.alternative).toBeNull()
  })

  it('chooseRoute: 둘 다 만족해야 추천 (긴 경로는 +200m가 먼저 걸린다)', () => {
    const r = (length: number, maxUp: number) => ({ length, maxUp, maxDown: 0 }) as never
    expect(chooseRoute(r(4150, 2), r(3900, 6), 8.3).choice).toBe('shortest')
    expect(chooseRoute(r(4050, 2), r(3900, 6), 8.3).choice).toBe('time')
  })
})

describe('현장 조사 결과 반영', () => {
  // 0─1 직접 100m(추정 3%), 0─2─1 우회 평지 2×80m
  const base = [up(1, 0, 1, 100, 3), up(2, 0, 2, 80, 0), up(3, 2, 1, 80, 0)]
  const withSurvey = (sv: SlopeSegment['survey']) => new SlopeGraph([{ ...base[0], survey: sv }, base[1], base[2]])

  it('조사 등급 통행 어려움이면 빼고 돌아간다', () => {
    expect(new SlopeGraph(base).route(0, 1, 'wheelchair')!.segIds).toEqual([1])
    expect(withSurvey({ grade: 'difficult', incline: null, at: null }).route(0, 1, 'wheelchair')!.segIds).toEqual([2, 3])
  })

  it('현장 측정 경사가 추정을 대신한다 (오르막·내리막 모두 그 값)', () => {
    const g = withSurvey({ grade: null, incline: 9, at: null })
    expect(g.route(0, 1, 'wheelchair')!.segIds).toEqual([2, 3])
    expect(g.route(1, 0, 'wheelchair')!.segIds).toEqual([3, 2])
  })

  it('측정값은 경계 여유 없이 8.3%까지 쓴다 (추정은 8.0%부터 뺀다)', () => {
    const only = (sv: SlopeSegment['survey'], est = 8.2) => new SlopeGraph([up(1, 0, 1, 100, est, { survey: sv })]).route(0, 1, 'wheelchair')
    expect(only(undefined)).toBeNull() // 추정 8.2% → 경계값이라 뺌
    expect(only({ grade: null, incline: 8.2, at: null })).not.toBeNull()
    expect(only({ grade: null, incline: 8.4, at: null })).toBeNull()
  })

  it('조사 완료 구간은 추정 구간 길이에서 빠진다', () => {
    const r = withSurvey({ grade: 'passable', incline: 2, at: null }).route(0, 1, 'wheelchair')!
    expect(r.segIds).toEqual([1])
    expect(r.estimatedM).toBe(0)
  })
})

describe('확인된 장애물', () => {
  const segs = [up(1, 0, 1, 100, 1), up(2, 0, 2, 60, 1), up(3, 2, 3, 60, 1), up(4, 3, 1, 60, 1)]

  it('가까운 구간에 붙인다 (15m 밖은 버림)', () => {
    const m = attachObstacles(segs, [
      { id: 1, type: 'stairs', lon: 129.0005, lat: 37.50005 },
      { id: 2, type: 'kerb', lon: 129.0005, lat: 37.51 },
    ])
    expect(m.get(1)).toEqual(['stairs'])
    expect(m.size).toBe(1)
  })

  it('계단이 확인된 구간은 휠체어 경로가 피하고, 최대 경사 최소화에서도 지나지 않는다', () => {
    const g = new SlopeGraph(segs, new Map([[1, ['stairs' as const]]]))
    expect(g.route(0, 1, 'wheelchair')!.segIds).toEqual([2, 3, 4])
    expect(g.route(0, 1, 'general')!.segIds).toEqual([1])
    const only = new SlopeGraph([segs[0]], new Map([[1, ['stairs' as const]]]))
    expect(only.bottleneck(0, 1)).toBeNull()
    const p = planRoute(only, [129, 37.5], [129.001, 37.5])!
    expect(p.wheelchair).toBeNull()
    expect(p.blocked).toEqual({ unavoidablePct: null })
  })

  it('확인된 단차(법 2cm)·좁음(법 1.2m)은 금지, 횡경사·파손은 주의', () => {
    expect(segmentKind(seg(1, 0, 1, 10, 1), true, O, ['kerb'])).toBe('forbid')
    expect(segmentKind(seg(1, 0, 1, 10, 1), true, O, ['narrow'])).toBe('forbid')
    expect(segmentKind(seg(1, 0, 1, 10, 1), true, O, ['cross_slope'])).toBe('caution')
    expect(segmentKind(seg(1, 0, 1, 10, 1), true, O, ['damaged'])).toBe('caution')
  })
})

describe('⑤-2 과도한 우회 (일반 경로 대비)', () => {
  const A: [number, number] = [129, 37.5]
  const B: [number, number] = [129.001, 37.5]
  // 0─1 직접 100m (막힘), 0─2─1 우회 detour m (평지)
  const graph = (direct: SlopeSegment, detour: number) => new SlopeGraph([direct, up(2, 0, 2, detour / 2, 0), up(3, 2, 1, detour / 2, 0)])

  it('직접 12% 100m, 우회 1,500m → 과도한 우회, 막는 구간은 12% 급경사(추정) 100m', () => {
    const p = planRoute(graph(up(1, 0, 1, 100, 12), 1500), A, B)!
    expect(p.wheelchair!.length).toBe(1500)
    expect(p.detour.excessive).toBe(true)
    expect(p.detour.ratio).toBeCloseTo(15)
    expect(p.detour.extraM).toBe(1400)
    expect(p.detour.blockedM).toBe(100)
    expect(p.detour.blocker).toMatchObject({ segId: 1, parentId: 1, reason: 'steep', pct: 12, lengthM: 100, estimated: true })
  })

  it('우회가 짧으면(1.2배) 과도하지 않다', () => {
    expect(planRoute(graph(up(1, 0, 1, 100, 12), 120), A, B)!.detour.excessive).toBe(false)
  })

  it('배수는 넘어도 차이가 1,000m 미만이면 과도하지 않다 (둘 다 넘어야)', () => {
    const p = planRoute(graph(up(1, 0, 1, 100, 12), 400), A, B)!
    expect(p.detour.ratio).toBeCloseTo(4)
    expect(p.detour.excessive).toBe(false)
  })

  it('막는 구간이 계단뿐이면 이유는 계단, 경사 값 없음', () => {
    const p = planRoute(graph(up(1, 0, 1, 100, 1, { kind: 'osm_steps', check: ['osm_steps'] }), 1500), A, B)!
    expect(p.detour.excessive).toBe(true)
    expect(p.detour.blocker).toMatchObject({ reason: 'stairs', pct: null })
  })

  it('조사원이 통행 어려움으로 확인한 구간이면 이유는 조사 결과, 추정 아님', () => {
    const p = planRoute(graph(up(1, 0, 1, 100, 1, { survey: { grade: 'difficult', incline: null, at: null } }), 1500), A, B)!
    expect(p.detour.blocker).toMatchObject({ reason: 'surveyed_difficult', estimated: false })
  })

  it('휠체어 경로가 없을 때도 막는 구간을 알려 준다 (과도한 우회는 아님)', () => {
    const p = planRoute(new SlopeGraph([up(1, 0, 1, 100, 12)]), A, B)!
    expect(p.wheelchair).toBeNull()
    expect(p.detour.excessive).toBe(false)
    expect(p.detour.blocker).toMatchObject({ reason: 'steep', pct: 12 })
  })

  it('일반 경로에 막는 구간이 없으면 blocker 없음', () => {
    const p = planRoute(graph(up(1, 0, 1, 100, 1), 1500), A, B)!
    expect(p.detour.blocker).toBeNull()
    expect(p.detour.excessive).toBe(false)
  })
})
