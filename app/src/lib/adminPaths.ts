// 관리자 추가 길: 카카오 지도에는 흰색 길로 보이지만 우리 길 데이터에 없는 길을 관리자가 그려 넣은 것 (DB admin_paths).
// 공개 지도는 이 길을 구간(SlopeSegment)으로 바꿔 지도에 그리고, 양 끝을 기존 길에 이어 길 안내 그래프에 넣는다.
//   끝점 잇기 순서: ① 8m 안 꺾이는 점(노드) → ② 15m 안 선 위(그 길을 그 자리에서 둘로 나눠 새 노드) → ③ 30m 안 노드 → 없으면 끊긴 끝
//   관리자 길끼리도 잇는다: 먼저 그린 길도 다음 길이 붙을 수 있는 '기존 길'이 되고, 끊긴 끝은 모든 길을 넣은 뒤 한 번 더 잇는다.
import { bboxNear, projectOnPolyline, type Projection } from '@/lib/drawSnap'
import { metersBetween } from '@/lib/route'
import type { SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'
import type { WalkSegment } from '@/lib/walk'

export interface AdminPath {
  id: number
  coords: LonLat[]
  /** 지도가 쓰는 경사 % */
  incline: number
  /** 입력한 각도 (기록용) */
  deg: number | null
  note: string | null
  at: string
}

/** 구간 번호·노드 번호가 원래 데이터와 겹치지 않게 (원래 구간 < 100만, 보행망 꼭짓점 1억대, 보행망 구간 2억대) */
export const ADMIN_SEG0 = 800_000_000
export const ADMIN_NODE0 = 810_000_000
const SPLIT_SEG0 = 830_000_000
const SPLIT_NODE0 = 840_000_000
/** 끝점을 붙이는 거리: 꺾이는 점(노드) / 선 위 / 마지막으로 노드 */
export const ADMIN_NODE_SNAP_M = 8
export const ADMIN_LINE_SNAP_M = 15
export const ADMIN_SNAP_M = 30

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** 공개 목록 (로그인 없이). 못 받으면 빈 목록 */
export async function fetchAdminPaths(): Promise<AdminPath[]> {
  if (!URL_ || !KEY) return []
  try {
    const res = await fetch(`${URL_}/rest/v1/rpc/admin_paths_public`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return []
    const rows = (await res.json()) as AdminPath[]
    return rows.filter((r) => Array.isArray(r.coords) && r.coords.length >= 2).map((r) => ({ ...r, incline: Number(r.incline) }))
  } catch {
    return []
  }
}

export function pathLength(c: LonLat[]): number {
  let L = 0
  for (let i = 1; i < c.length; i++) L += metersBetween(c[i - 1], c[i])
  return L
}

/** 구간 목록의 노드 좌표 (구간 끝점) */
export function nodePositions(segments: SlopeSegment[]): Map<number, LonLat> {
  const pos = new Map<number, LonLat>()
  for (const s of segments) {
    if (s.mtn) continue
    pos.set(s.s, s.c[0])
    pos.set(s.t, s.c[s.c.length - 1])
  }
  return pos
}

function adminSegment(p: AdminPath, s: number, t: number, c: LonLat[]): SlopeSegment {
  return {
    id: ADMIN_SEG0 + p.id,
    s,
    t,
    kind: 'admin_path',
    c,
    len: Math.round(pathLength(c) * 100) / 100,
    cls: '관리자 추가 길',
    name: p.note,
    w: null,
    sw: false,
    swW: null,
    bridge: false,
    tunnel: false,
    est: p.incline > 8.3 ? 'steep' : p.incline >= 4 ? 'moderate' : 'gentle',
    max: p.incline,
    avg: null,
    raw: null,
    src: null,
    basis: null,
    gap: null,
    check: ['admin_path'],
    up: p.incline,
    down: p.incline,
    // 관리자가 잰 경사: 지도 색·길 안내가 추정 대신 이 값을 쓴다 (방향을 재지 않아 오르막·내리막 모두 이 값)
    survey: { grade: null, incline: p.incline, at: p.at },
  }
}

export interface AttachInput {
  /** 그래프 구간 (차도 중심선 구간 또는 인도 보행망 구간) */
  segs: SlopeSegment[]
  /** 그래프 노드 좌표 */
  pos: Map<number, LonLat>
  /** 구간 실제 모양 (보행망 인도 선은 옆으로 민 좌표). 기본: s.c */
  coords?: (s: SlopeSegment) => LonLat[]
  /** 끝점이 중간에 닿았을 때 나눌 수 있는 구간 (기본: 산길 아님) */
  canSplit?: (s: SlopeSegment) => boolean
}

export interface AttachResult {
  /** 관리자 길을 넣고, 닿은 길은 나눈 그래프 구간 */
  segs: SlopeSegment[]
  pos: Map<number, LonLat>
  /** 지도에 그릴 관리자 길 (나누기 전 통째, 끝점은 이어진 자리로 맞춤) */
  admin: SlopeSegment[]
  /** 나뉜 조각 id → 원래 구간 id (장애물 등 원래 구간 기준 정보를 옮길 때) */
  pieceOf: Map<number, number>
  /** 관리자 길 id → [시작 이어짐, 끝 이어짐] */
  linked: Map<number, [boolean, boolean]>
}

export function attachAdminPaths(input: AttachInput, paths: AdminPath[]): AttachResult {
  const coordsOf = input.coords ?? ((s: SlopeSegment) => s.c)
  const canSplit = input.canSplit ?? ((s: SlopeSegment) => !s.mtn)
  const pool = [...input.segs]
  const pos = new Map(input.pos)
  const pieceOf = new Map<number, number>()
  const whole = new Map<number, SlopeSegment>()
  const linked = new Map<number, [boolean, boolean]>()
  let segSeq = 0
  let nodeSeq = 0

  const nearestNode = (p: LonLat, maxM: number, exclude?: number): { node: number; at: LonLat } | null => {
    let best: { node: number; at: LonLat; d: number } | null = null
    const pad = maxM / 80_000
    for (const [id, q] of pos) {
      if (id === exclude || Math.abs(q[0] - p[0]) > pad || Math.abs(q[1] - p[1]) > pad) continue
      const d = metersBetween(p, q)
      if (d <= maxM && (!best || d < best.d)) best = { node: id, at: q, d }
    }
    return best && { node: best.node, at: best.at }
  }

  /** p에서 maxM 안 가장 가까운 선 위 점 (selfRoot: 자기 자신(관리자 길과 그 조각)은 빼고) */
  const nearestLine = (p: LonLat, maxM: number, selfRoot?: number): { idx: number; pr: Projection } | null => {
    let best: { idx: number; pr: Projection } | null = null
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i]
      if (!canSplit(s) || s.c.length < 2) continue
      if (selfRoot != null && (s.id === selfRoot || pieceOf.get(s.id) === selfRoot)) continue
      // 보행망 인도 선은 중심선에서 최대 15m 옆이라 그만큼 넓게 거른다
      if (!bboxNear(s.c, p, maxM + 16)) continue
      const pr = projectOnPolyline(p, coordsOf(s))
      if (pr.dist <= maxM && (!best || pr.dist < best.pr.dist)) best = { idx: i, pr }
    }
    return best
  }

  /** pool[idx]를 pr 자리에서 둘로 나누고 새 노드를 돌려준다 (끝 가까이면 그 끝 노드) */
  const split = (idx: number, pr: Projection): { node: number; at: LonLat } => {
    const seg = pool[idx]
    const c = coordsOf(seg)
    const partA = [...c.slice(0, pr.i + 1), pr.at]
    const partB = [pr.at, ...c.slice(pr.i + 1)]
    const total = pathLength(c) || 1
    const la = pathLength(partA)
    if (la < 0.5) return { node: seg.s, at: pos.get(seg.s) ?? c[0] }
    if (total - la < 0.5) return { node: seg.t, at: pos.get(seg.t) ?? c[c.length - 1] }
    const node = SPLIT_NODE0 + nodeSeq++
    pos.set(node, pr.at)
    const frac = la / total
    const root = pieceOf.get(seg.id) ?? seg.id
    // 보행망 인도 선 조각은 원래 구간을 물려받은 객체라 원형(prototype)을 그대로 두고 복사한다
    const piece = (over: Partial<WalkSegment>) => Object.assign(Object.create(Object.getPrototypeOf(seg)) as SlopeSegment, seg, over)
    const A = piece({ id: SPLIT_SEG0 + segSeq++, t: node, len: seg.len * frac })
    const B = piece({ id: SPLIT_SEG0 + segSeq++, s: node, len: seg.len * (1 - frac) })
    if ('walk' in seg) {
      const w = (seg as WalkSegment).walk
      const f = w.f0 + (w.f1 - w.f0) * frac
      ;(A as WalkSegment).walk = { ...w, f1: f, to: pr.at }
      ;(B as WalkSegment).walk = { ...w, f0: f, from: pr.at }
    } else {
      A.c = partA
      B.c = partB
    }
    pieceOf.set(A.id, root)
    pieceOf.set(B.id, root)
    pool[idx] = A
    pool.push(B)
    return { node, at: pr.at }
  }

  const attach = (p: LonLat, opts: { exclude?: number; selfRoot?: number } = {}): { node: number; at: LonLat } | null => {
    const n1 = nearestNode(p, ADMIN_NODE_SNAP_M, opts.exclude)
    if (n1) return n1
    const ln = nearestLine(p, ADMIN_LINE_SNAP_M, opts.selfRoot)
    if (ln) return split(ln.idx, ln.pr)
    return nearestNode(p, ADMIN_SNAP_M, opts.exclude)
  }

  // ① 차례로 넣는다: 먼저 넣은 관리자 길도 다음 길이 붙을 수 있는 길이 된다
  for (const p of [...paths].sort((a, b) => a.id - b.id)) {
    const c = p.coords.map((x) => [x[0], x[1]] as LonLat)
    if (c.length < 2) continue
    const a = attach(c[0])
    const b = attach(c[c.length - 1])
    const s = a ? a.node : ADMIN_NODE0 + p.id * 2
    const t = b ? b.node : ADMIN_NODE0 + p.id * 2 + 1
    if (a) c[0] = a.at
    else pos.set(s, c[0])
    if (b) c[c.length - 1] = b.at
    else pos.set(t, c[c.length - 1])
    if (s === t || pathLength(c) < 1) continue
    const seg = adminSegment(p, s, t, c)
    pool.push(seg)
    whole.set(p.id, seg)
    linked.set(p.id, [!!a, !!b])
  }

  // ② 끊긴 끝을 한 번 더: 뒤에 넣은 관리자 길의 중간·끝에 닿는 경우
  for (const [pid, [la, lb]] of linked) {
    for (const end of [0, 1] as const) {
      if (end === 0 ? la : lb) continue
      const w = whole.get(pid)!
      const oldNode = end === 0 ? ADMIN_NODE0 + pid * 2 : ADMIN_NODE0 + pid * 2 + 1
      const at = pos.get(oldNode)
      if (!at) continue
      const hit = attach(at, { exclude: oldNode, selfRoot: w.id })
      if (!hit) continue
      // 그 끝을 가진 구간(관리자 길 자신 또는 나뉜 조각)의 끝을 새 노드로
      for (const s of pool) {
        if (s.s === oldNode) {
          s.s = hit.node
          if (!('walk' in s)) s.c = [hit.at, ...s.c.slice(1)]
        }
        if (s.t === oldNode) {
          s.t = hit.node
          if (!('walk' in s)) s.c = [...s.c.slice(0, -1), hit.at]
        }
      }
      if (end === 0) w.c = [hit.at, ...w.c.slice(1)]
      else w.c = [...w.c.slice(0, -1), hit.at]
      pos.delete(oldNode)
      const cur = linked.get(pid)!
      linked.set(pid, end === 0 ? [true, cur[1]] : [cur[0], true])
    }
  }

  return { segs: pool, pos, admin: [...whole.values()], pieceOf, linked }
}
