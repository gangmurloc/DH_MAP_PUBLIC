import { describe, expect, it } from 'vitest'
import { suggestGrade } from './grade'
import type { Segment, SurveyRecord } from './types'

const seg = (p: Partial<Segment> = {}): Segment => ({
  id: 1, s: 1, t: 2, c: [[129.1, 37.5], [129.101, 37.5]], len: 88, cls: '미분류', name: null, w: 6, sw: true, swW: 2,
  bridge: false, stairs: false, tunnel: false, underpass: false, overpass: null, demMax: 2, demEst: 'gentle', check: [], ...p,
})
const rec = (p: Partial<SurveyRecord> = {}): SurveyRecord => ({
  segId: 1, incline: null, cross: null, obstacles: [], grade: null, reason: '', done: false, memo: '', updatedAt: '', ...p,
})

describe('suggestGrade: PRD 6절 경계값 (DB suggest_grade와 같음)', () => {
  it.each([
    [5.6, 'passable'], [5.7, 'caution'], [8.3, 'caution'], [8.4, 'difficult'], [-9, 'difficult'], [-5.6, 'passable'],
  ])('측정 경사 %s%% → %s', (inc, g) => {
    expect(suggestGrade(seg(), rec({ incline: inc })).grade).toBe(g)
  })
  it.each([
    [3.9, 'passable'], [4.0, 'caution'], [8.3, 'caution'], [8.31, 'difficult'],
  ])('측정 없으면 DEM %s%% → %s', (d, g) => {
    expect(suggestGrade(seg({ demMax: d }), null).grade).toBe(g)
  })
  it('측정값이 DEM보다 우선', () => {
    expect(suggestGrade(seg({ demMax: 20 }), rec({ incline: 3 })).grade).toBe('passable')
  })
  it('교량·추정 연결은 측정 전까지 주의', () => {
    expect(suggestGrade(seg({ bridge: true }), null).grade).toBe('caution')
    expect(suggestGrade(seg({ assumed: true, demMax: 1 }), null).grade).toBe('caution')
  })
  it('보도 없는 지하차도는 통행 어려움', () => {
    expect(suggestGrade(seg({ underpass: true }), rec({ incline: 1 })).grade).toBe('difficult')
  })
  it.each([
    [2, 'passable'], [2.1, 'difficult'], [5, 'difficult'], [null, 'caution'],
  ])('턱 %scm → %s (법: 단차 2cm 이하)', (cm, g) => {
    expect(suggestGrade(seg(), rec({ incline: 1, obstacles: [{ id: 'a', type: 'kerb', kerbCm: cm, widthCm: null }] })).grade).toBe(g)
  })
  it.each([
    [89, 'difficult'], [119, 'difficult'], [120, 'passable'], [null, 'caution'],
  ])('좁음 폭 %scm → %s (법: 유효폭 1.2m 이상)', (cm, g) => {
    expect(suggestGrade(seg(), rec({ incline: 1, obstacles: [{ id: 'a', type: 'narrow', kerbCm: null, widthCm: cm }] })).grade).toBe(g)
  })
  it('계단은 통행 어려움, 파손은 주의', () => {
    expect(suggestGrade(seg(), rec({ incline: 1, obstacles: [{ id: 'a', type: 'stairs', kerbCm: null, widthCm: null }] })).grade).toBe('difficult')
    expect(suggestGrade(seg(), rec({ incline: 1, obstacles: [{ id: 'a', type: 'damaged', kerbCm: null, widthCm: null }] })).grade).toBe('caution')
  })
})
