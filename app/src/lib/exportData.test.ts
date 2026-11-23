import { describe, expect, it } from 'vitest'
import type { SlopeSegment } from './slope'
import { obstaclesCsv, segmentsCsv, segmentsGeoJson } from './exportData'

const seg = (id: number, extra: Partial<SlopeSegment> = {}): SlopeSegment => ({
  id, s: 1, t: 2, kind: 'road', c: [[129.1, 37.5], [129.101, 37.5]], len: 88.04, cls: '소로', name: '천곡로', w: 6, sw: true, swW: 2,
  bridge: false, tunnel: false, est: 'moderate', max: 6.24, avg: 3, raw: 7, src: 'road_obs', basis: 'centerline', gap: 10,
  check: ['slope_measure'], ...extra,
})

describe('데이터 다운로드', () => {
  const segs = [
    seg(1),
    seg(2, { survey: { grade: 'difficult', incline: 9.1, at: '2026-11-20T00:00:00Z' } }),
    seg(3, { kind: 'osm_path' }),
    seg(4, { kind: 'assumed_link' }),
  ]

  it('GeoJSON: OSM 보완 길·연결 추정은 빼고, 조사 등급·실측 경사를 싣는다', () => {
    const fc = JSON.parse(segmentsGeoJson(segs))
    expect(fc.count).toBe(2)
    expect(fc.features.map((f: { id: number }) => f.id)).toEqual([1, 2])
    expect(fc.features[0].properties).toMatchObject({ grade: 'unsurveyed', est_incline_max_pct: 6.2, est_class: 'moderate', length_m: 88 })
    expect(fc.features[1].properties).toMatchObject({ grade: 'difficult', measured_incline_max_pct: 9.1, est_class: 'moderate' })
    expect(fc.license).toContain('국토지리정보원')
  })

  it('CSV: 머리글 + 구간마다 한 줄, QGIS용 WKT 열', () => {
    const lines = segmentsCsv(segs).replace('﻿', '').split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].split(',')).toContain('wkt')
    expect(lines[1]).toContain('"LINESTRING(129.1 37.5, 129.101 37.5)"')
  })

  it('장애물 CSV: 경도·위도 열, 장애물이 없어도 머리글', () => {
    const fc = { features: [{ type: 'Feature' as const, id: 7, geometry: { type: 'Point', coordinates: [129.11, 37.52] }, properties: { id: 7, type: 'kerb', status: 'verified', segment_id: 1, kerb_height_m: 0.03, width_m: null, created_at: 'x', tags: null } }] }
    const lines = obstaclesCsv(fc).replace('﻿', '').split('\r\n')
    expect(lines[0]).toBe('id,type,status,segment_id,kerb_height_m,width_m,created_at,lon,lat')
    expect(lines[1]).toBe('7,kerb,verified,1,0.03,,x,129.11,37.52')
    expect(obstaclesCsv({ features: [] })).toContain('lon,lat')
  })
})
