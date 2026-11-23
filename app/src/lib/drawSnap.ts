// 관리자 '새 길 그리기' 도우미 (공개 지도의 관리자 길 잇기에도 같은 계산을 쓴다)
//   자석: 누른 곳 가까이 기존 길이 있으면 그 위에 정확히 붙인다 (꺾이는 점 먼저, 없으면 선 위 가장 가까운 점)
//   직교: 새 구간을 앞 구간(첫 구간이면 붙은 길)과 0°/90°/180°/270°로 맞춘다
// 위경도를 그 자리 기준 평면 미터로 펴서 계산한다 (몇백 m 안이라 충분히 정확)
import type { SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

const M_PER_DEG = 111_320

function frame(lat0: number) {
  return { kx: M_PER_DEG * Math.cos((lat0 * Math.PI) / 180), ky: M_PER_DEG }
}

/** 구간 좌표가 p에서 m 안의 상자에 걸치는가 (빠른 거르기) */
export function bboxNear(c: LonLat[], p: LonLat, m: number): boolean {
  const { kx, ky } = frame(p[1])
  const dx = m / kx
  const dy = m / ky
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of c) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return p[0] >= minX - dx && p[0] <= maxX + dx && p[1] >= minY - dy && p[1] <= maxY + dy
}

export interface Projection {
  /** p에서 선까지 거리 m */
  dist: number
  /** 선 위 가장 가까운 점 */
  at: LonLat
  /** 그 점이 놓인 선분 번호 (c[i] → c[i+1]) */
  i: number
  /** 선분 안 비율 0~1 */
  t: number
  /** 그 선분 방향 (평면 각, 라디안) */
  dir: number
}

/** 점 p에서 폴리라인 c까지 가장 가까운 점 */
export function projectOnPolyline(p: LonLat, c: LonLat[]): Projection {
  const { kx, ky } = frame(p[1])
  let best: Projection = { dist: Infinity, at: c[0], i: 0, t: 0, dir: 0 }
  for (let i = 0; i + 1 < c.length; i++) {
    const ax = (c[i][0] - p[0]) * kx
    const ay = (c[i][1] - p[1]) * ky
    const bx = (c[i + 1][0] - p[0]) * kx
    const by = (c[i + 1][1] - p[1]) * ky
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0
    const d = Math.hypot(ax + t * dx, ay + t * dy)
    if (d < best.dist) {
      best = { dist: d, at: [c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t], i, t, dir: Math.atan2(dy, dx) }
    }
  }
  return best
}

export interface Snap {
  at: LonLat
  /** node: 꺾이는 점(구간 끝·꼭짓점)에 붙음, line: 선 위에 붙음, null: 붙을 길 없음 (at = 원래 점) */
  kind: 'node' | 'line' | null
  segId: number | null
  /** 붙은 길의 방향 (직교 기준으로 쓴다) */
  dir: number | null
  dist: number
}

/** 자석: p에서 tolM 안 기존 길에 붙인다. 꺾이는 점이 tolM의 60% 안이면 그 점을, 아니면 선 위 가장 가까운 점 */
export function snapToRoads(p: LonLat, segs: SlopeSegment[], tolM: number): Snap {
  const { kx, ky } = frame(p[1])
  let node: Snap | null = null
  let line: Snap | null = null
  for (const s of segs) {
    if (s.mtn || s.c.length < 2 || !bboxNear(s.c, p, tolM)) continue
    const pr = projectOnPolyline(p, s.c)
    if (pr.dist > tolM) continue
    if (!line || pr.dist < line.dist) line = { at: pr.at, kind: 'line', segId: s.id, dir: pr.dir, dist: pr.dist }
    for (let i = 0; i < s.c.length; i++) {
      const v = s.c[i]
      const d = Math.hypot((v[0] - p[0]) * kx, (v[1] - p[1]) * ky)
      if (d <= tolM * 0.6 && (!node || d < node.dist)) {
        const j = Math.min(i, s.c.length - 2)
        const dir = Math.atan2((s.c[j + 1][1] - s.c[j][1]) * ky, (s.c[j + 1][0] - s.c[j][0]) * kx)
        node = { at: v, kind: 'node', segId: s.id, dir, dist: d }
      }
    }
  }
  return node ?? line ?? { at: p, kind: null, segId: null, dir: null, dist: Infinity }
}

/** 직교: last에서 p로 가는 방향을 refDir 기준 0°/90°/180°/270° 중 가장 가까운 쪽으로 맞추고, 그 방향으로 p까지의 거리만큼 */
export function orthoLock(p: LonLat, last: LonLat, refDir: number): LonLat {
  const { kx, ky } = frame(last[1])
  const vx = (p[0] - last[0]) * kx
  const vy = (p[1] - last[1]) * ky
  let best = { len: -Infinity, ux: 0, uy: 0 }
  for (let k = 0; k < 4; k++) {
    const a = refDir + (k * Math.PI) / 2
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    const len = vx * ux + vy * uy
    if (len > best.len) best = { len, ux, uy }
  }
  const len = Math.max(0, best.len)
  return [last[0] + (best.ux * len) / kx, last[1] + (best.uy * len) / ky]
}

/** 두 점 방향 (평면 각, 라디안) */
export function bearing(a: LonLat, b: LonLat): number {
  const { kx, ky } = frame(a[1])
  return Math.atan2((b[1] - a[1]) * ky, (b[0] - a[0]) * kx)
}

/** last→q 직선(앞뒤로 tolM 연장)과 q 가까이(tolM) 있는 길이 만나는 점 중 q에 가장 가까운 것. 직교로 맞춘 선을 길에 정확히 닿게 한다 */
export function rayHitRoad(last: LonLat, q: LonLat, segs: SlopeSegment[], tolM: number): LonLat | null {
  const { kx, ky } = frame(q[1])
  const dx = (q[0] - last[0]) * kx
  const dy = (q[1] - last[1]) * ky
  const L = Math.hypot(dx, dy)
  if (L < 0.5) return null
  const ux = dx / L
  const uy = dy / L
  let best: { d: number; at: LonLat } | null = null
  for (const s of segs) {
    if (s.mtn || s.c.length < 2 || !bboxNear(s.c, q, tolM)) continue
    for (let i = 0; i + 1 < s.c.length; i++) {
      // 선분 a→b, 직선 last + r·u. 평면 좌표는 last 기준
      const ax = (s.c[i][0] - last[0]) * kx
      const ay = (s.c[i][1] - last[1]) * ky
      const ex = (s.c[i + 1][0] - last[0]) * kx - ax
      const ey = (s.c[i + 1][1] - last[1]) * ky - ay
      const den = ux * ey - uy * ex
      if (Math.abs(den) < 1e-9) continue // 나란함
      const r = (ax * ey - ay * ex) / den
      const u = (ax * uy - ay * ux) / den
      if (u < 0 || u > 1 || r < 0.5) continue
      const d = Math.abs(r - L)
      if (d <= tolM && (!best || d < best.d)) best = { d, at: [last[0] + (ux * r) / kx, last[1] + (uy * r) / ky] }
    }
  }
  return best?.at ?? null
}
