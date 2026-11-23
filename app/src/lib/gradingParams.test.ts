import { describe, expect, it } from 'vitest'
import { applyGradingParams } from './gradingParams'
import { ROUTE_PARAMS } from './slopeRoute'

describe('applyGradingParams', () => {
  it('값·곡선을 덮어쓰고 모르는 키·숫자 아닌 값은 버린다', () => {
    const p = structuredClone(ROUTE_PARAMS)
    const n = applyGradingParams(
      [
        { key: 'incline_caution_max_pct', value: 8 },
        { key: 'route_rest_sec', value: 20 },
        { key: 'route_wheelchair_up_pct_8.3', value: 0.3 },
        { key: 'route_wheelchair_up_pct_0', value: 1 },
        { key: 'kerb_passable_max_m', value: 0.02 },
        { key: 'route_detour_ratio', value: null as unknown as number },
      ],
      p,
    )
    expect(n).toBe(4)
    expect(p.maxGradePct).toBe(8)
    expect(p.restSec).toBe(20)
    expect(p.upFactor).toEqual([[0, 1], [8.3, 0.3]])
    expect(p.detourRatio).toBe(ROUTE_PARAMS.detourRatio)
    expect(ROUTE_PARAMS.restSec).toBe(15) // 원본은 그대로
  })

  it('예전 키(수동·전동 구분, 쉬는 간격 9m)는 읽지 않는다', () => {
    const p = structuredClone(ROUTE_PARAMS)
    const n = applyGradingParams(
      [
        { key: 'route_rest_every_m', value: 9 },
        { key: 'route_speed_powered_mps', value: 2 },
        { key: 'route_up_manual_pct_8.3', value: 0.1 },
        { key: 'route_up_manual_pct_0', value: 1 },
      ],
      p,
    )
    expect(n).toBe(0)
    expect(p.restEveryM).toBe(30)
    expect(p.upFactor).toEqual(ROUTE_PARAMS.upFactor)
  })

  it('과도한 우회 기준 두 값을 읽는다', () => {
    const p = structuredClone(ROUTE_PARAMS)
    expect(applyGradingParams([{ key: 'route_detour_warn_ratio', value: 4 }, { key: 'route_detour_warn_extra_m', value: 800 }], p)).toBe(2)
    expect(p.detourWarnRatio).toBe(4)
    expect(p.detourWarnExtraM).toBe(800)
  })
})
