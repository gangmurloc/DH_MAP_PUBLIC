import { describe, expect, it } from 'vitest'
import { ADMIN_NODE0, ADMIN_SEG0, attachAdminPaths, nodePositions, pathLength, type AdminPath } from './adminPaths'
import type { SlopeSegment } from './slope'
import { classify } from './slope'
import { planRoute, SlopeGraph } from './slopeRoute'
import type { WalkSegment } from './walk'

// 위도 37.5에서 경도 0.001° ≈ 88m, 위도 0.001° ≈ 111m
const seg = (id: number, s: number, t: number, c: [number, number][], extra: Partial<SlopeSegment> = {}): SlopeSegment => ({
  id, s, t, kind: 'road', c, len: pathLength(c), cls: null, name: null, w: null, sw: false, swW: null,
  bridge: false, tunnel: false, est: 'gentle', max: 1, avg: 0, raw: 1, src: null, basis: null, gap: null, check: [], up: 1, down: 1, ...extra,
})
const path = (id: number, coords: [number, number][], incline = 3): AdminPath => ({ id, coords, incline, deg: null, note: '시험 길', at: '2026-11-21T00:00:00Z' })
const attach = (segs: SlopeSegment[], paths: AdminPath[]) => attachAdminPaths({ segs, pos: nodePositions(segs) }, paths)

describe('관리자 추가 길 잇기', () => {
  // 노드 0(129.000) ─ 1(129.001) ─ 2(129.002), 따로 떨어진 길 3(129.004) ─ 4(129.005)
  const base = [seg(1, 0, 1, [[129, 37.5], [129.001, 37.5]]), seg(2, 1, 2, [[129.001, 37.5], [129.002, 37.5]]), seg(3, 3, 4, [[129.004, 37.5], [129.005, 37.5]])]

  it('끝이 8m 안 노드면 그 노드에 붙고, 경사는 관리자가 넣은 값', () => {
    const r = attach(base, [path(7, [[129.00205, 37.50003], [129.003, 37.5003], [129.00395, 37.50003]], 9.6)])
    const a = r.admin[0]
    expect(a.id).toBe(ADMIN_SEG0 + 7)
    expect([a.s, a.t]).toEqual([2, 3])
    expect(a.c[0]).toEqual([129.002, 37.5])
    expect(r.linked.get(7)).toEqual([true, true])
    expect(a.survey?.incline).toBe(9.6)
    expect(classify(a, 'final')).toBe('steep')
  })

  it('끝이 길 중간(노드에서 먼 곳)에 닿으면 그 길을 둘로 나눠 잇는다 (T자 갈림길)', () => {
    // 구간 1의 가운데(129.0005) 바로 위 5m에서 북쪽으로 뻗는 길
    const r = attach(base, [path(8, [[129.0005, 37.50004], [129.0005, 37.501]])])
    const a = r.admin[0]
    expect(r.linked.get(8)).toEqual([true, false])
    expect(a.c[0][0]).toBeCloseTo(129.0005, 6)
    expect(a.c[0][1]).toBeCloseTo(37.5, 6)
    // 구간 1은 두 조각으로 나뉘고 길이 합은 그대로
    const pieces = r.segs.filter((s) => r.pieceOf.get(s.id) === 1)
    expect(pieces).toHaveLength(2)
    expect(pieces[0].len + pieces[1].len).toBeCloseTo(base[0].len, 1)
    expect(r.segs.some((s) => s.id === 1)).toBe(false)
    // 길 안내: 노드 0에서 새 길 끝까지 이어진다
    const g = new SlopeGraph(r.segs, new Map(), r.pos)
    const plan = planRoute(g, [129, 37.5], [129.0005, 37.501])!
    expect(plan.general!.segIds).toContain(ADMIN_SEG0 + 8)
  })

  it('관리자 길끼리 끝을 맞대면 이어진다', () => {
    const r = attach(base, [path(1, [[129.002, 37.5], [129.002, 37.501]]), path(2, [[129.00201, 37.50101], [129.004, 37.501]])])
    expect(r.linked.get(2)).toEqual([true, false])
    const p1 = r.admin.find((s) => s.id === ADMIN_SEG0 + 1)!
    const p2 = r.admin.find((s) => s.id === ADMIN_SEG0 + 2)!
    expect(p2.s).toBe(p1.t)
  })

  it('먼저 그린 길의 끝이 나중에 그린 길 중간에 닿아도 (두 번째 차례에서) 잇는다', () => {
    // 1번: 북쪽 공중에서 끝남(끊김) → 2번: 그 끝 아래를 가로지르는 동서 길
    const r = attach(base, [path(1, [[129.002, 37.5], [129.0025, 37.50105]]), path(2, [[129.002, 37.5011], [129.003, 37.5011]])])
    expect(r.linked.get(1)).toEqual([true, true])
    const g = new SlopeGraph(r.segs, new Map(), r.pos)
    const plan = planRoute(g, [129, 37.5], [129.003, 37.5011])!
    expect(plan.general!.segIds).toEqual(expect.arrayContaining([ADMIN_SEG0 + 1]))
  })

  it('붙일 곳이 없는 끝은 새 노드 (끊김)', () => {
    const r = attach(base, [path(9, [[129.002, 37.5], [129.002, 37.503]])])
    expect(r.admin[0].t).toBe(ADMIN_NODE0 + 9 * 2 + 1)
    expect(r.linked.get(9)).toEqual([true, false])
  })

  it('보행망 인도 선 조각을 나누면 원래 구간 위치(f0~f1)를 나눠 갖는다', () => {
    const parent = seg(5, 0, 1, [[129, 37.5], [129.002, 37.5]])
    const w = Object.create(parent) as WalkSegment
    Object.assign(w, { id: 200, s: 100, t: 101, len: parent.len, walk: { parent: 5, side: 0, f0: 0, f1: 1, kind: 0, from: [129, 37.5], to: [129.002, 37.5] } })
    const pos = new Map<number, [number, number]>([[100, [129, 37.5]], [101, [129.002, 37.5]]])
    const r = attachAdminPaths({ segs: [w], pos }, [path(3, [[129.001, 37.50003], [129.001, 37.501]])])
    const pieces = r.segs.filter((s) => r.pieceOf.get(s.id) === 200) as WalkSegment[]
    expect(pieces).toHaveLength(2)
    expect(pieces[0].walk.f1).toBeCloseTo(0.5, 2)
    expect(pieces[1].walk.f0).toBeCloseTo(0.5, 2)
    expect(pieces[0].max).toBe(1) // 원래 구간 속성 물려받음
  })

  it('급경사로 넣으면 휠체어 추천에서 빠진다 (일반 경로는 지남)', () => {
    const r = attach(base, [path(9, [[129.002, 37.5], [129.004, 37.5]], 12)])
    const g = new SlopeGraph(r.segs, new Map(), r.pos)
    const p = planRoute(g, [129, 37.5], [129.005, 37.5])!
    expect(p.general!.segIds).toContain(ADMIN_SEG0 + 9)
    expect(p.wheelchair).toBeNull()
  })
})
