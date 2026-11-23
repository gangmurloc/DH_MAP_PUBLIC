// 데이터 다운로드 (R-502): 구간·장애물 레이어를 GeoJSON·CSV로. 받은 파일은 QGIS에서 바로 열린다
// (GeoJSON은 그대로, CSV는 구간 WKT 열 / 장애물 경도·위도 열로 '구분자로 분리된 텍스트' 레이어).
// 구간: 앱이 가진 동해시 전체 구간(추정) + 현장 조사 결과. OSM으로 보완한 길(ODbL)과 연결 추정 선은 넣지 않는다 (HANDOFF 3절).
// 장애물: DB 공개 함수 features() (숨김·제보 원문·사람 정보 없음).
import { classify, type SlopeSegment } from '@/lib/slope'

const URL_: string | undefined = import.meta.env.VITE_SUPABASE_URL
const KEY: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const LICENSE = {
  segments: '구간 형상·추정 경사: 국토지리정보원 수치지도 1:5,000 (공공누리 제1유형, 출처 표시). 조사 등급·실측 경사: 동해 무장애지도',
  obstacles: '동해 무장애지도 조사단 (공개 라이선스 동의 제보 포함)',
}

type Props = Record<string, string | number | boolean | null>
interface Feature {
  type: 'Feature'
  id: number
  geometry: { type: string; coordinates: unknown }
  properties: Props
}

/** 내보낼 구간: DB에 있는 수치지도 구간만 (OSM 보완 길·연결 추정 제외) */
export function exportable(s: SlopeSegment): boolean {
  return !String(s.kind ?? '').startsWith('osm') && s.kind !== 'assumed_link'
}

function segmentProps(s: SlopeSegment): Props {
  const est = classify({ ...s, survey: undefined }, 'final')
  return {
    id: s.id,
    name: s.name,
    road_class: s.cls,
    length_m: Math.round(s.len * 10) / 10,
    grade: s.survey?.grade ?? 'unsurveyed',
    measured_incline_max_pct: s.survey?.incline ?? null,
    surveyed_at: s.survey?.at ?? null,
    est_incline_max_pct: s.max != null && !s.bridge && !s.tunnel ? Math.round(s.max * 10) / 10 : null,
    est_class: est,
    has_sidewalk: s.sw,
    sidewalk_width_m: s.swW,
    on_bridge: s.bridge,
    in_tunnel: s.tunnel,
    mountain_path_estimate: !!s.mtn,
    check_items: s.check.join('|') || null,
  }
}

export function segmentsGeoJson(segments: SlopeSegment[]): string {
  const features: Feature[] = segments.filter(exportable).map((s) => ({
    type: 'Feature',
    id: s.id,
    geometry: { type: 'LineString', coordinates: s.c },
    properties: segmentProps(s),
  }))
  return JSON.stringify({ type: 'FeatureCollection', license: LICENSE.segments, generated_at: new Date().toISOString(), count: features.length, features })
}

function cell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csv(rows: Props[], extra: (i: number) => Props): string {
  if (!rows.length) return ''
  const all = rows.map((r, i) => ({ ...r, ...extra(i) }))
  const cols = Object.keys(all[0])
  // 엑셀에서 한글이 깨지지 않게 BOM
  return '﻿' + [cols.join(','), ...all.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')
}

export function segmentsCsv(segments: SlopeSegment[]): string {
  const segs = segments.filter(exportable)
  return csv(segs.map(segmentProps), (i) => ({ wkt: `LINESTRING(${segs[i].c.map(([x, y]) => `${x} ${y}`).join(', ')})` }))
}

/** 장애물 레이어 (DB features). 서버 준비 전이면 오류 */
export async function fetchObstacleFeatures(): Promise<{ type: string; features: Feature[] }> {
  if (!URL_ || !KEY) throw new Error('서버 설정이 없어요')
  const res = await fetch(`${URL_}/rest/v1/rpc/features`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_layer: 'obstacles', p_limit: 1000 }),
  })
  if (!res.ok) throw new Error(`장애물을 받지 못했어요 (${res.status})`)
  return res.json()
}

export function obstaclesGeoJson(fc: { features: Feature[] }): string {
  return JSON.stringify({ type: 'FeatureCollection', license: LICENSE.obstacles, generated_at: new Date().toISOString(), count: fc.features.length, features: fc.features })
}

export function obstaclesCsv(fc: { features: Feature[] }): string {
  const f = fc.features
  if (!f.length) return '﻿id,type,status,segment_id,kerb_height_m,width_m,created_at,lon,lat'
  return csv(
    f.map((x) => {
      const { tags: _tags, ...p } = x.properties
      return p
    }),
    (i) => {
      const [lon, lat] = f[i].geometry.coordinates as [number, number]
      return { lon, lat }
    },
  )
}

/** 브라우저에서 파일로 저장 */
export function saveText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
