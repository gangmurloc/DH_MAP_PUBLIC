import { describe, expect, it } from 'vitest'
import { bearing, orthoLock, rayHitRoad, snapToRoads } from './drawSnap'
import type { SlopeSegment } from './slope'

const seg = (id: number, c: [number, number][]): SlopeSegment => ({
  id, s: 0, t: 1, kind: 'road', c, len: 100, cls: null, name: null, w: null, sw: false, swW: null,
  bridge: false, tunnel: false, est: 'gentle', max: 1, avg: 0, raw: 1, src: null, basis: null, gap: null, check: [],
})
// 동서로 놓인 길 (위도 37.5, 경도 0.001° ≈ 88m)
const road = seg(1, [[129, 37.5], [129.001, 37.5], [129.002, 37.5]])

describe('자석', () => {
  it('꺾이는 점 가까이면 그 점에, 아니면 선 위 가장 가까운 점에 붙는다', () => {
    expect(snapToRoads([129.00101, 37.50001], [road], 10)).toMatchObject({ kind: 'node', at: [129.001, 37.5] })
    const s = snapToRoads([129.0005, 37.50004], [road], 10) // 선 위 약 4.4m
    expect(s.kind).toBe('line')
    expect(s.at[0]).toBeCloseTo(129.0005, 6)
    expect(s.at[1]).toBeCloseTo(37.5, 6)
  })

  it('멀면 붙지 않는다', () => {
    expect(snapToRoads([129.0005, 37.5005], [road], 10).kind).toBeNull()
  })
})

describe('직교 모드', () => {
  it('앞 구간 기준 일직선·직각으로 맞춘다', () => {
    const last: [number, number] = [129.001, 37.5]
    const east = bearing([129, 37.5], last)
    // 거의 북쪽(살짝 동쪽)으로 누르면 정북쪽으로
    const q = orthoLock([129.0011, 37.5005], last, east)
    expect(q[0]).toBeCloseTo(129.001, 6)
    expect(q[1]).toBeGreaterThan(37.5004)
    // 거의 동쪽이면 동쪽 일직선
    const q2 = orthoLock([129.0015, 37.50002], last, east)
    expect(q2[1]).toBeCloseTo(37.5, 6)
  })

  it('직교로 맞춘 선이 길에 닿으면 그 교차점', () => {
    // 북쪽에서 남쪽으로 내려오는 선이 동서 길과 만나는 점
    const hit = rayHitRoad([129.0015, 37.501], [129.0015, 37.50005], [road], 10)!
    expect(hit[0]).toBeCloseTo(129.0015, 6)
    expect(hit[1]).toBeCloseTo(37.5, 6)
  })
})
