import type { RouteSection, SlopeArea, SlopeSegment } from './slope'
import type { LonLat } from './types'
import { WalkKind, type WalkSegment } from './walk'
import { metersBetween } from './route'

export function routeSections(ids: number[] | undefined, segments: Map<number, SlopeSegment>, coords: (s: SlopeSegment) => LonLat[]): RouteSection[] {
  return (ids ?? []).flatMap((id) => {
    const segment = segments.get(id)
    if (!segment) return []
    const c = coords(segment)
    return c.length < 2 ? [] : [{ c, grade: segment.survey?.grade ?? null }]
  })
}

function distanceToLine(p: LonLat, c: LonLat[]): number {
  const kx = 111_320 * Math.cos(p[1] * Math.PI / 180)
  let best = Infinity
  for (let i = 1; i < c.length; i++) {
    const [a, b] = [c[i - 1], c[i]]
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * 111_320
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * 111_320
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return best
}

/** 인도 선 옆에 있다는 이유로 횡단보도를 표시하지 않는다. 실제 건너는 구간만 고른다. */
export function routeRaisedCrossings(ids: number[], segments: Map<number, SlopeSegment>, coords: (s: SlopeSegment) => LonLat[], crossings: SlopeArea['crossings']): LonLat[] {
  const out: LonLat[] = []
  const add = (p: LonLat) => { if (!out.some((q) => metersBetween(p, q) < 3)) out.push(p) }
  for (const id of new Set(ids)) {
    const s = segments.get(id)
    if (!s) continue
    const walk = 'walk' in s ? (s as WalkSegment).walk : null
    if (walk ? walk.kind !== WalkKind.CW_RAISED : !s.check.some((c) => c === 'crosswalk_raised' || c === 'crosswalk_kerb_not_lowered')) continue
    const c = coords(s)
    if (c.length < 2) continue
    const matches = crossings.filter((p) => p.kerb === 'raised' && distanceToLine([p.lon, p.lat], c) <= 10)
    for (const p of matches) add([p.lon, p.lat])
    if (!matches.length && walk) add([(walk.from[0] + walk.to[0]) / 2, (walk.from[1] + walk.to[1]) / 2])
  }
  return out
}

// ─── 경로 선을 매끄럽게 이어 그리기 ───
// 경로는 길 조각(구간)들의 목록이라, 조각마다 따로 그리면 이음매가 끊기고(흰 테두리가 앞 조각 끝을 덮음) 꺾이는 곳이 각진다.
// → 조각들을 방향을 맞춰 하나의 선으로 잇고(joinPaths), 꺾이는 곳을 작은 반경으로 둥글게 깎는다(smoothPath).

const KY = 111_320
const kxAt = (lat: number) => KY * Math.cos((lat * Math.PI) / 180)

/** 조각들을 차례로 이어 연속된 선들로. 다음 조각은 앞 선 끝에 가까운 쪽부터 붙이고(필요하면 뒤집고), gapM보다 멀면 새 선으로 시작한다.
 *  새 선의 첫 조각은 다음 조각에 가까운 끝이 뒤로 가게 놓는다 (경로 조각의 좌표 방향은 진행 방향과 다를 수 있다) */
export function joinPaths(parts: LonLat[][], gapM = 4): LonLat[][] {
  const P = parts.filter((p) => p.length >= 2)
  const near = (p: LonLat, q: LonLat[]) => Math.min(metersBetween(p, q[0]), metersBetween(p, q[q.length - 1]))
  const out: LonLat[][] = []
  let cur: LonLat[] | null = null
  for (let i = 0; i < P.length; i++) {
    const raw = P[i]
    if (cur) {
      const end = cur[cur.length - 1]
      const dHead = metersBetween(end, raw[0])
      const dTail = metersBetween(end, raw[raw.length - 1])
      const d = Math.min(dHead, dTail)
      if (d <= gapM) {
        const part = dTail < dHead ? [...raw].reverse() : raw
        cur.push(...(d < 0.3 ? part.slice(1) : part))
        continue
      }
    }
    // 새 선 시작
    const next = P[i + 1]
    cur = next && near(raw[0], next) < near(raw[raw.length - 1], next) ? [...raw].reverse() : [...raw]
    out.push(cur)
  }
  return out
}

/** 꺾이는 곳을 둥글게: 각 꼭짓점 앞뒤 radiusM(이웃 변 길이의 절반까지) 지점 사이를 2차 베지어 곡선으로 바꾼다.
 *  곡선은 원래 선에서 많아야 반경만큼만 안쪽으로 들어가므로 길에서 벗어나지 않는다. 거의 곧은 꼭짓점(10° 미만)은 그대로 */
export function smoothPath(c: LonLat[], radiusM = 6, steps = 5): LonLat[] {
  if (c.length < 3) return c
  const kx = kxAt(c[0][1])
  const toM = (p: LonLat): [number, number] => [p[0] * kx, p[1] * KY]
  const toLL = (p: [number, number]): LonLat => [p[0] / kx, p[1] / KY]
  const P = c.map(toM)
  const out: [number, number][] = [P[0]]
  for (let i = 1; i < P.length - 1; i++) {
    const [a, v, b] = [P[i - 1], P[i], P[i + 1]]
    const la = Math.hypot(v[0] - a[0], v[1] - a[1])
    const lb = Math.hypot(b[0] - v[0], b[1] - v[1])
    if (la < 1e-6 || lb < 1e-6) continue
    const ua = [(a[0] - v[0]) / la, (a[1] - v[1]) / la]
    const ub = [(b[0] - v[0]) / lb, (b[1] - v[1]) / lb]
    const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])))
    if (turn < (10 * Math.PI) / 180) {
      out.push(v)
      continue
    }
    const r = Math.min(radiusM, la / 2, lb / 2)
    const p0: [number, number] = [v[0] + ua[0] * r, v[1] + ua[1] * r]
    const p2: [number, number] = [v[0] + ub[0] * r, v[1] + ub[1] * r]
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const q = (1 - t) * (1 - t)
      out.push([q * p0[0] + 2 * (1 - t) * t * v[0] + t * t * p2[0], q * p0[1] + 2 * (1 - t) * t * v[1] + t * t * p2[1]])
    }
  }
  out.push(P[P.length - 1])
  return out.map(toLL)
}

/** 구간의 가장 가파른 경사 % (현장 실측이 있으면 그 값). 다리·터널·모름이면 null */
export function segmentPct(s: SlopeSegment): number | null {
  if (s.survey?.incline != null) return s.survey.incline
  if (s.bridge || s.tunnel) return null
  const up = s.up ?? s.max
  const down = s.down ?? s.max
  return up == null || down == null ? null : Math.max(up, down)
}

/** 경로에서 강조할 경사 구간: 가파른 편(caution: 5.6% 이상)·급경사(steep: 8.3% 초과 또는 경로 계산이 상한 초과로 센 구간) */
export function slopeHighlights(
  ids: number[] | undefined,
  segments: Map<number, SlopeSegment>,
  coords: (s: SlopeSegment) => LonLat[],
  steepIds: Set<number> = new Set(),
): { c: LonLat[]; level: 'caution' | 'steep' }[] {
  const out: { c: LonLat[]; level: 'caution' | 'steep' }[] = []
  for (const id of ids ?? []) {
    const s = segments.get(id)
    if (!s) continue
    const pct = segmentPct(s)
    const level = steepIds.has(id) || (pct != null && pct > 8.3) ? 'steep' : pct != null && pct >= 5.6 ? 'caution' : null
    if (!level) continue
    const c = coords(s)
    if (c.length < 2) continue
    // 이어진 같은 단계 조각은 하나로 (끊김 없이)
    const last = out[out.length - 1]
    if (last && last.level === level && metersBetween(last.c[last.c.length - 1], c[0]) < 4) last.c.push(...c.slice(1))
    else if (last && last.level === level && metersBetween(last.c[last.c.length - 1], c[c.length - 1]) < 4) last.c.push(...[...c].reverse().slice(1))
    else out.push({ c: [...c], level })
  }
  return out
}
