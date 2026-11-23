import { describe, expect, it } from 'vitest'
import { joinPaths, routeRaisedCrossings, routeSections, slopeHighlights, smoothPath } from './routeDisplay'
import type { SlopeArea, SlopeSegment, SurveyInfo } from './slope'
import { WalkKind, type WalkSegment } from './walk'
import type { LonLat } from './types'

const line: LonLat[] = [[129, 37], [129.0001, 37]]
const coords = (s: SlopeSegment) => s.c
const segment = (id: number, grade: SurveyInfo['grade'] = null, extra: Partial<SlopeSegment> = {}) => ({
  id, c: line, check: [], max: 0,
  survey: grade ? { grade, incline: 0, at: null } : undefined,
  ...extra,
} as SlopeSegment)
const crossing = (lon: number, kerb: SlopeArea['crossings'][number]['kerb'] = 'raised') => ({ lon, lat: 37, kerb })

describe('추천 경로에 한정한 조사 표시', () => {
  it('선택된 구간의 실제 조사 등급만 사용하고 추정 완만 구간은 조사 완료로 바꾸지 않는다', () => {
    const map = new Map([segment(1, 'passable'), segment(2, 'caution'), segment(3, 'difficult'), segment(4), segment(5, 'passable')].map((s) => [s.id, s]))
    expect(routeSections([1, 2, 3, 4, 99], map, coords).map((s) => s.grade)).toEqual(['passable', 'caution', 'difficult', null])
  })

  it('인도 보행망 조각이 원래 구간에서 상속한 조사 등급을 보존한다', () => {
    const parent = segment(1, 'caution')
    const child = Object.assign(Object.create(parent) as SlopeSegment, { id: 10 })
    expect(routeSections([10], new Map([[10, child]]), coords)[0].grade).toBe('caution')
  })

  it('아직 경로가 없을 때는 조사선도 표시하지 않는다', () => {
    expect(routeSections(undefined, new Map(), coords)).toEqual([])
    expect(routeRaisedCrossings([], new Map(), coords, [crossing(129.00005)])).toEqual([])
  })

  it('경로의 턱 있는 횡단보도만 고르고 경로 밖·턱 낮춘 횡단보도는 제외하며 중복을 제거한다', () => {
    const s = segment(1, null, { check: ['crosswalk_kerb_not_lowered'] })
    const offRoute = segment(2, null, { c: [[129.001, 37], [129.0011, 37]], check: ['crosswalk_raised'] })
    expect(routeRaisedCrossings([1, 1], new Map([[1, s], [2, offRoute]]), coords, [crossing(129.00005), crossing(129.00006, 'lowered'), crossing(129.00105)])).toEqual([[129.00005, 37]])
  })

  it('횡단보도 가까이의 평행한 인도를 걷기만 하면 표식을 올리지 않는다', () => {
    const s = Object.assign(segment(1, null, { check: ['crosswalk_kerb_not_lowered'] }), { walk: { kind: WalkKind.PARENT, from: line[0], to: line[1] } }) as WalkSegment
    expect(routeRaisedCrossings([1], new Map([[1, s]]), coords, [crossing(129.00005)])).toEqual([])
  })

  it('실제로 건너는 보행망 횡단보도는 경로 좌표의 가운데에 표시할 수 있다', () => {
    const s = Object.assign(segment(1), { walk: { kind: WalkKind.CW_RAISED, from: line[0], to: line[1] } }) as WalkSegment
    expect(routeRaisedCrossings([1], new Map([[1, s]]), coords, [])).toEqual([[129.00005, 37]])
  })
})

describe('경로 선 매끄럽게', () => {
  // 위도 37.5에서 경도 0.0001° ≈ 8.8m
  it('방향이 제각각인 조각을 하나의 선으로 잇는다', () => {
    const a: [number, number][] = [[129.0001, 37.5], [129, 37.5]] // 거꾸로 놓인 첫 조각
    const b: [number, number][] = [[129.0001, 37.5], [129.0002, 37.5]]
    const c: [number, number][] = [[129.0003, 37.5], [129.0002, 37.5]] // 거꾸로
    const out = joinPaths([a, b, c])
    expect(out).toHaveLength(1)
    expect(out[0].map((p) => p[0])).toEqual([129, 129.0001, 129.0002, 129.0003])
  })

  it('멀리 떨어진 조각은 새 선으로', () => {
    expect(joinPaths([[[129, 37.5], [129.0001, 37.5]], [[129.01, 37.5], [129.0101, 37.5]]])).toHaveLength(2)
  })

  it('직각 꺾임을 둥글게 깎되 반경 안에서만 (길에서 벗어나지 않음)', () => {
    const corner: [number, number][] = [[129, 37.5], [129.001, 37.5], [129.001, 37.501]]
    const s = smoothPath(corner, 6)
    expect(s.length).toBeGreaterThan(3)
    expect(s[0]).toEqual(corner[0])
    expect(s[s.length - 1]).toEqual(corner[2])
    // 꼭짓점에서 가장 가까운 곡선 점까지 거리는 반경보다 작다 (모서리를 6m 안에서 깎음)
    const kx = 111_320 * Math.cos((37.5 * Math.PI) / 180)
    const dmin = Math.min(...s.map((p) => Math.hypot((p[0] - 129.001) * kx, (p[1] - 37.5) * 111_320)))
    expect(dmin).toBeGreaterThan(1)
    expect(dmin).toBeLessThan(6)
  })

  it('경사 강조: 5.6% 이상 주의, 8.3% 초과 또는 상한 초과로 센 구간은 급경사, 이어진 같은 단계는 하나로', () => {
    const mk = (id: number, x0: number, max: number) => ({ id, c: [[x0, 37.5], [x0 + 0.0001, 37.5]] as [number, number][], max, up: max, down: 0, survey: undefined, bridge: false, tunnel: false }) as unknown as SlopeSegment
    const segs = new Map([mk(1, 129, 2), mk(2, 129.0001, 6), mk(3, 129.0002, 7), mk(4, 129.0003, 12), mk(5, 129.0004, 3)].map((s) => [s.id, s]))
    const h = slopeHighlights([1, 2, 3, 4, 5], segs, (s) => s.c)
    expect(h.map((x) => x.level)).toEqual(['caution', 'steep'])
    expect(h[0].c).toHaveLength(3) // 2·3번이 이어짐
    expect(slopeHighlights([1], segs, (s) => s.c, new Set([1]))[0].level).toBe('steep')
  })
})
