// 관리자 '경사' 직접 입력: 각도(°) → 지도가 쓰는 경사(%) 변환, 고른 위치에서 가장 가까운 구간 찾기
import type { SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

/** 각도(°) → 경사(%) = tan(각도) × 100. 예: 4.76° ≈ 8.3% (1/12) */
export function degToPct(deg: number): number {
  return Math.tan((deg * Math.PI) / 180) * 100
}

/** 입력할 수 있는 각도 범위 (0° 초과 ~ 45° 미만: 45°면 100%) */
export const MAX_DEG = 45

/** DB(segments)에 있는 구간만 경사를 기록할 수 있다: OSM으로 보탠 길·연결 추정 구간·관리자 추가 길은 DB segments에 없다 */
export function recordable(s: SlopeSegment): boolean {
  return !(s.kind ?? '').startsWith('osm') && s.kind !== 'assumed_link' && s.kind !== 'admin_path' && !s.check.includes('assumed_link')
}

/** p에서 가장 가까운 구간 (maxM 밖이면 null). 위경도를 그 자리 기준 미터로 펴서 점-선분 거리를 잰다 */
/** all: 경사를 기록할 수 없는 길(관리자 추가 길·OSM 보완 길)도 후보로 (길 고르기용) */
export function nearestSegment(segments: SlopeSegment[], p: LonLat, maxM = 30, all = false): { seg: SlopeSegment; dist: number } | null {
  const ky = 111_320
  const kx = ky * Math.cos((p[1] * Math.PI) / 180)
  const padLon = maxM / kx
  const padLat = maxM / ky
  let best: { seg: SlopeSegment; dist: number } | null = null
  for (const s of segments) {
    if (!all && !recordable(s)) continue
    // 상자로 먼저 거른다
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of s.c) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (p[0] < minX - padLon || p[0] > maxX + padLon || p[1] < minY - padLat || p[1] > maxY + padLat) continue
    for (let i = 0; i + 1 < s.c.length; i++) {
      const ax = (s.c[i][0] - p[0]) * kx
      const ay = (s.c[i][1] - p[1]) * ky
      const bx = (s.c[i + 1][0] - p[0]) * kx
      const by = (s.c[i + 1][1] - p[1]) * ky
      const dx = bx - ax
      const dy = by - ay
      const L2 = dx * dx + dy * dy
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0
      const d = Math.hypot(ax + t * dx, ay + t * dy)
      if (d <= maxM && (!best || d < best.dist)) best = { seg: s, dist: d }
    }
  }
  return best
}
