import { describe, expect, it } from 'vitest'
import type { SlopeSegment } from './slope'
import { SlopeGraph } from './slopeRoute'
import { buildWalkSegments, offsetPart, walkCoords, WalkKind, type WalkNet } from './walk'

const road = (id: number, s: number, t: number, c: [number, number][], extra: Partial<SlopeSegment> = {}): SlopeSegment => ({
  id, s, t, kind: 'road', c, len: 100, cls: null, name: null, w: 10, sw: true, swW: 2, bridge: false, tunnel: false, est: 'gentle',
  max: 2, avg: 2, raw: 2, src: 'road_obs', basis: 'road_surface', gap: 10, check: [], up: 2, down: 0, ...extra,
})

describe('offsetPart', () => {
  it('동쪽으로 가는 선의 왼쪽(+1)은 북쪽으로 밀린다', () => {
    const out = offsetPart([[129, 37.5], [129.001, 37.5]], 0, 1, +1, 10)
    expect(out[0][1]).toBeGreaterThan(37.5)
    expect((out[0][1] - 37.5) * 111_320).toBeCloseTo(10, 0)
  })
  it('일부 구간 [0.5, 1]만 자른다', () => {
    const out = offsetPart([[129, 37.5], [129.001, 37.5]], 0.5, 1, -1, 5)
    expect(out[0][0]).toBeCloseTo(129.0005, 5)
    expect(out[0][1]).toBeLessThan(37.5)
  })
  it('길이가 다른 두 선분의 모퉁이도 인도 폭을 일정하게 유지한다', () => {
    const kx = 111_320 * Math.cos(37.5 * Math.PI / 180)
    const c: [number, number][] = [[129, 37.5], [129 + 100 / kx, 37.5], [129 + 100 / kx, 37.5 + 10 / 111_320]]
    const out = offsetPart(c, 0, 1, 1, 5)
    expect((out[1][0] - 129) * kx).toBeCloseTo(95, 5)
    expect((out[1][1] - 37.5) * 111_320).toBeCloseTo(5, 5)
    // 구간을 잘라 그려도 같은 모퉁이는 같은 좌표여야 한다.
    expect(offsetPart(c, 0.4, 0.98, 1, 5)[1]).toEqual(out[1])
  })
  it('중복 꼭짓점과 아주 짧은 끝 선분에서도 좌표가 뒤집히거나 NaN이 되지 않는다', () => {
    const c: [number, number][] = [[129.104766, 37.546677], [129.104795, 37.546691], [129.104795, 37.546691], [129.10499, 37.546773], [129.105009, 37.546774]]
    const out = offsetPart(c, 0, 1, -1, 14)
    expect(out.every((p) => p.every(Number.isFinite))).toBe(true)
    // 묵호역 인근에서 끝을 지나쳤다가 되돌아오던 꺾임을 재현한다.
    expect(out.every((p, i) => i === 0 || p[0] > out[i - 1][0])).toBe(true)
  })
  it('옆으로 밀지 않으면 도로의 실제 직각 모양은 그대로 보존한다', () => {
    const c: [number, number][] = [[129, 37.5], [129.001, 37.5], [129.001, 37.501]]
    const out = offsetPart(c, 0, 1, 0, 0)
    for (let i = 0; i < c.length; i++) {
      expect(out[i][0]).toBeCloseTo(c[i][0], 10)
      expect(out[i][1]).toBeCloseTo(c[i][1], 10)
    }
  })
})

describe('buildWalkSegments', () => {
  // 차도 1개(동서) 양쪽 인도 + 가운데 턱낮춤 없는 횡단보도. 노드 1(서)·2(동)
  const parent = road(7, 1, 2, [[129, 37.5], [129.001, 37.5]])
  const walk: WalkNet = {
    v: [[100, 129, 37.50009], [101, 129.001, 37.50009], [102, 129, 37.49991], [103, 129.001, 37.49991], [104, 129.0005, 37.50009], [105, 129.0005, 37.49991]],
    e: [
      [1, 100, 104, 7, 1, 0, 0.5, WalkKind.PARENT, 50],
      [2, 104, 101, 7, 1, 0.5, 1, WalkKind.PARENT, 50],
      [3, 102, 105, 7, -1, 0, 0.5, WalkKind.PARENT, 50],
      [4, 105, 103, 7, -1, 0.5, 1, WalkKind.PARENT, 50],
      [5, 104, 105, 7, 0, 0.5, 0.5, WalkKind.CW_RAISED, 20],
    ],
    d: { '7': 10 },
  }
  const { segs, pos } = buildWalkSegments([parent], walk)

  it('인도 조각은 원래 구간 속성(경사)을 물려받고 길이·끝점만 바뀐다', () => {
    const side = segs.find((s) => s.id === 1)!
    expect(side.max).toBe(2)
    expect(side.len).toBe(50)
    expect(side.s).toBe(100)
  })

  it('턱 있는 횡단보도(법: 단차 2cm 초과)는 휠체어가 건너지 않는다. 일반 경로는 건너고 요약에 센다', () => {
    const g = new SlopeGraph(segs, new Map(), pos)
    const r = g.route(100, 103, 'general')!
    expect(r.segIds).toContain(5)
    expect(r.raisedCrossings).toBe(1)
    expect(g.route(100, 103, 'wheelchair')).toBeNull()
  })
})

describe('walkCoords: 인도 없는 길 끝 (walk_net.py A)', () => {
  it('통째인 한 줄 길은 원래 모양을 쓰되, 양 끝은 보행망 꼭짓점(인도에 붙은 끝)으로 바꾼다', () => {
    const alley = road(9, 1, 2, [[129, 37.5], [129.0005, 37.5004], [129.001, 37.5008]], { sw: false, w: 3 })
    const w = {
      id: 1, s: 10, t: 11, len: 100, kind: 'road', check: [], c: alley.c,
      walk: { parent: 9, side: 0, f0: 0, f1: 1, kind: WalkKind.PARENT, from: [129.00001, 37.50005] as [number, number], to: [129.001, 37.5008] as [number, number] },
    } as unknown as Parameters<typeof walkCoords>[0]
    const out = walkCoords(w, new Map([[9, alley]]), {})
    expect(out[0]).toEqual([129.00001, 37.50005])
    expect(out[1]).toEqual([129.0005, 37.5004])
    expect(out.at(-1)).toEqual([129.001, 37.5008])
  })
  it('동해시청 경로의 시작점을 인도에 붙일 때 시작점 뒤에 남은 옛 꼭짓점을 지운다', () => {
    const c: [number, number][] = [[129.114446, 37.523672], [129.114425, 37.523714], [129.1141, 37.524358]]
    const parent = road(33937, 1, 2, c, { sw: false })
    const from: [number, number] = [129.114383, 37.523797]
    const to: [number, number] = [129.1141, 37.524358]
    const w = { walk: { parent: parent.id, side: 0, f0: 0, f1: 1, kind: WalkKind.PARENT, from, to } } as Parameters<typeof walkCoords>[0]
    expect(walkCoords(w, new Map([[parent.id, parent]]), {})).toEqual([from, to])
  })
  it('끝점을 옮겨도 끝점 너머의 꼭짓점으로 갔다가 돌아오지 않는다', () => {
    const c: [number, number][] = [[129, 37.5], [129.0009, 37.5], [129.001, 37.5]]
    const parent = road(1, 1, 2, c)
    const from: [number, number] = [129, 37.5]
    const to: [number, number] = [129.0008, 37.5]
    const w = { walk: { parent: 1, side: 0, f0: 0, f1: 1, kind: WalkKind.PARENT, from, to } } as Parameters<typeof walkCoords>[0]
    expect(walkCoords(w, new Map([[1, parent]]), {})).toEqual([from, to])
  })
})

describe('가까운 꼭짓점 잇기 (walk_net.py E)', () => {
  it('이은 선은 물려받은 원래 구간의 법 기준(좁은 보도 등)을 그대로 적용받는다', () => {
    const narrow = road(8, 1, 2, [[129, 37.5], [129.00003, 37.5]], { check: ['narrow_sidewalk'] })
    const walk: WalkNet = {
      v: [[100, 129, 37.50009], [101, 129.00003, 37.50009]],
      e: [
        [1, 100, 101, 8, 1, 0, 1, WalkKind.PARENT, 2.5],
        [2, 100, 101, 8, 0, 0, 1, WalkKind.CORNER, 2.5],
      ],
      d: { '8': 10 },
    }
    const { segs, pos } = buildWalkSegments([narrow], walk)
    const stitch = segs.find((s) => s.id === 2)!
    expect(stitch.check).toContain('narrow_sidewalk')
    expect(stitch.c).toHaveLength(2)
    const g = new SlopeGraph(segs, new Map(), pos)
    expect(g.route(100, 101, 'wheelchair')).toBeNull()
    expect(g.route(100, 101, 'general')).not.toBeNull()
  })
})
