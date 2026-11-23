// 인도 기준 보행망 (scripts/survey/walk_net.py가 만든 donghae_walk.json)
// 양쪽 인도 선은 원래 구간(차도 중심선)을 옆으로 밀어 만든다: 경사·포장 등 속성은 원래 구간 값을 그대로 쓴다.
// 큰길(4차로 이상)은 횡단보도나 세 갈래 이상 교차로(자료 없는 횡단, 벌점)에서만, 4차로 미만 길은 교차로에서도 건넌다.
import type { SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

/** walk_net.py의 종류 코드와 같게 */
export const WalkKind = { PARENT: 0, CORNER: 1, FREE: 2, CW_LOWERED: 3, CW_RAISED: 4, CW_FLUSH: 5, CW_UNKNOWN: 6, JUNCTION: 7 } as const

export interface WalkNet {
  /** [꼭짓점 id, 경도, 위도] */
  v: [number, number, number][]
  /** [id, 시작, 끝, 원래 구간 id(0=없음), 쪽(+1 왼쪽, -1 오른쪽, 0 가운데), 시작 위치 0~1, 끝 위치, 종류, 길이 m] */
  e: [number, number, number, number, number, number, number, number, number][]
  /** 원래 구간 id → 인도 선까지 거리 m */
  d: Record<string, number>
}

/** 보행망 구간 = 경로 계산용 SlopeSegment (원래 구간 속성을 물려받음) + 그리기 정보 */
export interface WalkSegment extends SlopeSegment {
  walk: { parent: number; side: number; f0: number; f1: number; kind: number; from: LonLat; to: LonLat }
}

const BASE: Omit<SlopeSegment, 'id' | 's' | 't' | 'len' | 'kind' | 'check'> = {
  c: [],
  cls: null,
  name: null,
  w: null,
  sw: true,
  swW: null,
  bridge: false,
  tunnel: false,
  est: 'gentle',
  max: 0,
  avg: 0,
  raw: 0,
  src: null,
  basis: null,
  gap: null,
  up: 0,
  down: 0,
}

const CROSS_KIND: Record<number, string> = {
  [WalkKind.CORNER]: 'walk_corner',
  [WalkKind.FREE]: 'walk_cross_free',
  [WalkKind.JUNCTION]: 'walk_cross_junction',
  [WalkKind.CW_LOWERED]: 'walk_crosswalk',
  [WalkKind.CW_RAISED]: 'walk_crosswalk',
  [WalkKind.CW_FLUSH]: 'walk_crosswalk',
  [WalkKind.CW_UNKNOWN]: 'walk_crosswalk',
}

export function buildWalkSegments(segments: SlopeSegment[], walk: WalkNet): { segs: WalkSegment[]; pos: Map<number, LonLat> } {
  const byId = new Map(segments.map((s) => [s.id, s]))
  const pos = new Map<number, LonLat>(walk.v.map(([id, lon, lat]) => [id, [lon, lat]]))
  const segs: WalkSegment[] = []
  for (const [id, s, t, parent, side, f0, f1, kind, len] of walk.e) {
    const from = pos.get(s)
    const to = pos.get(t)
    if (!from || !to) continue
    const meta = { parent, side, f0, f1, kind, from, to }
    if (kind === WalkKind.PARENT) {
      const p = byId.get(parent)
      if (!p) continue
      // 원래 구간을 물려받고(Object.create) 이 조각의 번호·끝점·길이만 바꾼다. 인도 선에서는 횡단보도 턱 표시는 건너는 구간이 맡는다
      const w = Object.create(p) as WalkSegment
      Object.assign(w, { id, s, t, len, walk: meta, check: side ? p.check.filter((k) => k !== 'crosswalk_kerb_not_lowered') : p.check })
      segs.push(w)
    } else if (kind === WalkKind.CORNER && parent) {
      // 가까운 같은 쪽 꼭짓점을 바로 이은 선(walk_net.py E): 양 끝 인도 조각 중 가장 나쁜 원래 구간을 물려받는다.
      // 그래서 짧은 급경사·좁은 조각·계단을 이 선으로 건너뛰어 법 기준을 피할 수 없다. 모양은 두 꼭짓점 직선
      const p = byId.get(parent)
      if (!p) continue
      const w = Object.create(p) as WalkSegment
      Object.assign(w, { id, s, t, len, c: [from, to], walk: meta, check: p.check.filter((k) => k !== 'crosswalk_kerb_not_lowered') })
      segs.push(w)
    } else {
      const check: string[] = kind === WalkKind.CW_RAISED ? ['crosswalk_raised'] : kind === WalkKind.CW_UNKNOWN ? ['crosswalk_kerb_unknown'] : []
      segs.push({ ...BASE, id, s, t, len, kind: CROSS_KIND[kind], check, c: [from, to], walk: meta })
    }
  }
  return { segs, pos }
}

/** 원래 구간 좌표 c의 [f0, f1] 부분을 side 쪽으로 d m 민 선 (그리기용) */
export function offsetPart(c: LonLat[], f0: number, f1: number, side: number, d: number): LonLat[] {
  if (c.length < 2) return c.map((p) => [...p])
  if (f0 > f1) return offsetPart(c, f1, f0, side, d).reverse()
  const lat0 = c[0][1]
  const kx = 111_320 * Math.cos(lat0 * Math.PI / 180)
  const ky = 111_320
  const P: LonLat[] = []
  for (const [lon, lat] of c) {
    const p: LonLat = [(lon - c[0][0]) * kx, (lat - lat0) * ky]
    const prev = P.at(-1)
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 0.001) P.push(p)
  }
  if (P.length < 2) return [[...c[0]], [...c[0]]]
  const cum = [0]
  const normals: LonLat[] = []
  for (let i = 1; i < P.length; i++) {
    const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1]
    const length = Math.hypot(dx, dy)
    cum.push(cum[i - 1] + length)
    normals.push([-dy / length, dx / length])
  }
  // Offset the entire road first. Unit normals intersect at each bend,
  // so unequal source segment lengths cannot skew the sidewalk corner.
  const offset = P.map(([x, y], i): LonLat => {
    const a = normals[Math.max(0, i - 1)]
    const b = normals[Math.min(normals.length - 1, i)]
    const denom = 1 + a[0] * b[0] + a[1] * b[1]
    let nx = denom > 1e-6 ? (a[0] + b[0]) / denom : a[0]
    let ny = denom > 1e-6 ? (a[1] + b[1]) / denom : a[1]
    const scale = Math.min(1, 4 / (Math.hypot(nx, ny) || 1))
    nx *= scale; ny *= scale
    return [x + nx * side * d, y + ny * side * d]
  })
  // An inner offset corner can extend past the end of a very short
  // source edge. Drop that collapsed join instead of drawing a U-turn.
  const kept = P.map((_, i) => i)
  for (let i = 0; i < kept.length - 1;) {
    const a = kept[i], b = kept[i + 1]
    const progress = (offset[b][0] - offset[a][0]) * (P[b][0] - P[a][0]) + (offset[b][1] - offset[a][1]) * (P[b][1] - P[a][1])
    if (progress < -1e-6 && kept.length > 2) {
      kept.splice(i > 0 ? i : i + 1, 1)
      i = Math.max(0, i - 1)
    } else i++
  }
  const points = kept.map((i) => offset[i])
  const positions = kept.map((i) => cum[i])
  const length = cum.at(-1)!
  const start = Math.max(0, Math.min(1, f0)) * length
  const end = Math.max(0, Math.min(1, f1)) * length
  const at = (distance: number): LonLat => {
    let i = 1
    while (i < positions.length - 1 && positions[i] < distance) i++
    const t = (distance - positions[i - 1]) / (positions[i] - positions[i - 1])
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]
  }
  const pts = [at(start), ...points.filter((_, i) => positions[i] > start && positions[i] < end), at(end)]
  return pts.map(([x, y]) => [c[0][0] + x / kx, lat0 + y / ky])
}

/** Keep only the road shape between the snapped graph endpoints.
 * Replacing endpoints alone can retain a vertex behind the new start,
 * making an otherwise straight route double back before going forward. */
function anchorPath(c: LonLat[], from: LonLat, to: LonLat): LonLat[] {
  if (c.length < 2) return [from, to]
  const kx = 111_320 * Math.cos(c[0][1] * Math.PI / 180)
  const P = c.map(([x, y]): LonLat => [(x - c[0][0]) * kx, (y - c[0][1]) * 111_320])
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
  const project = ([lon, lat]: LonLat) => {
    const x = (lon - c[0][0]) * kx, y = (lat - c[0][1]) * 111_320
    let best = Infinity, distance = 0
    for (let i = 1; i < P.length; i++) {
      const [ax, ay] = P[i - 1], dx = P[i][0] - ax, dy = P[i][1] - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      const delta = Math.hypot(x - ax - t * dx, y - ay - t * dy)
      if (delta < best) { best = delta; distance = cum[i - 1] + t * (cum[i] - cum[i - 1]) }
    }
    return distance
  }
  const start = project(from), end = project(to)
  return [from, ...c.filter((_, i) => i > 0 && i < c.length - 1 && cum[i] > start + 0.001 && cum[i] < end - 0.001), to]
}

/** Drawing coordinates for one walk edge; graph endpoints stay exact. */
export function walkCoords(w: WalkSegment, parentById: Map<number, SlopeSegment>, d: Record<string, number>): LonLat[] {
  const m = w.walk
  if (m.kind !== WalkKind.PARENT) return [m.from, m.to]
  const p = parentById.get(m.parent)
  if (!p) return [m.from, m.to]
  const part = offsetPart(p.c, m.f0, m.f1, m.side, m.side ? (d[String(m.parent)] ?? 0) : 0)
  return anchorPath(part, m.from, m.to)
}
