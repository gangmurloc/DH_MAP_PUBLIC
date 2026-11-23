import { describe, expect, it } from 'vitest'
import type { SlopeSegment } from './slope'
import { degToPct, nearestSegment } from './slopeInput'

const seg = (id: number, c: [number, number][], extra: Partial<SlopeSegment> = {}): SlopeSegment => ({
  id, s: 0, t: 1, kind: 'road', c, len: 100, cls: null, name: null, w: null, sw: false, swW: null,
  bridge: false, tunnel: false, est: 'gentle', max: 2, avg: 0, raw: 2, src: null, basis: null, gap: null, check: [], ...extra,
})

describe('degToPct', () => {
  it('각도를 경사 %로 (tan × 100)', () => {
    expect(degToPct(45)).toBeCloseTo(100)
    expect(degToPct(4.76)).toBeCloseTo(8.33, 1) // 1/12
    expect(degToPct(3.18)).toBeCloseTo(5.56, 1) // 1/18
    expect(degToPct(0)).toBe(0)
  })
})

describe('nearestSegment', () => {
  // 위도 37.5에서 경도 0.001° ≈ 88m
  const a = seg(1, [[129, 37.5], [129.002, 37.5]])
  const b = seg(2, [[129, 37.5003], [129.002, 37.5003]]) // 약 33m 북쪽
  const osm = seg(3, [[129, 37.50005], [129.002, 37.50005]], { kind: 'osm_path' })

  it('가장 가까운 구간과 거리', () => {
    const r = nearestSegment([a, b], [129.001, 37.50002])!
    expect(r.seg.id).toBe(1)
    expect(r.dist).toBeCloseTo(2.2, 0)
  })

  it('30m 밖이면 없음', () => {
    expect(nearestSegment([a], [129.001, 37.501])).toBeNull()
  })

  it('OSM 보탠 길은 DB에 없어 고르지 않는다', () => {
    expect(nearestSegment([osm, a], [129.001, 37.50005])!.seg.id).toBe(1)
  })

  it('길 고르기(all)는 관리자 추가 길·OSM 길도 고른다 (관리자 화면 길 수정)', () => {
    const admin = seg(800_000_002, [[129, 37.5001], [129.002, 37.5001]], { kind: 'admin_path' })
    // 관리자 길 바로 위를 누르면: 경사 기록용(기본)은 관리자 길을 건너뛰고 아래 길을, 길 고르기는 관리자 길을
    expect(nearestSegment([a, admin], [129.001, 37.5001])!.seg.id).toBe(1)
    expect(nearestSegment([a, admin], [129.001, 37.5001], 30, true)!.seg.id).toBe(800_000_002)
    expect(nearestSegment([osm, a], [129.001, 37.50005], 30, true)!.seg.id).toBe(3)
  })
})
