"""도로 중심선이 없는 도로 면(단지 안 길·주차장 통로·건물 사이 길)에서 가운데 선을 뽑아 보행 구간 후보로 만든다.

수치지도 1:5,000 도로 중심선(N3L_A0020000)은 시청·학교 같은 단지 안 도로나 공영주차장 통로를 그리지 않는다.
그런데 도로 면(N3A_A0010000)에는 그 길들이 들어 있다 (시청 반경 150m 도로 면의 67%에 중심선이 없음, 11/20 확인).
OSM은 같은 곳을 거의 덮지 못하고 ODbL이라 섞기 어렵다 → 같은 국가 데이터의 도로 면을 쓴다.

방법:
  1. 기존 중심선이 덮는 폭(도로폭/2 + COVER_PAD_M, 최소 MIN_COVER_M)을 도로 면에서 뺀다 → 남은 면 = 빠진 길
  2. 남은 면 조각마다 RES_M 격자로 그려 골격선(skeletonize)을 뽑고 선으로 잇는다
  3. 끝이 막힌 짧은 곁가지(SPUR_M 미만)를 지우고, 너무 작은 조각(MIN_PIECE_M 미만)은 버린다
  4. 막힌 끝이 기존 보행 가능 중심선에서 (덮는 폭 + LINK_PAD_M) 안이면 가장 가까운 점으로 잇는다
결과 선은 '도로 면 추정 길'로 표시해 현장 확인 대상이 된다.
"""
import math
from collections import defaultdict

import numpy as np
import shapely
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree

RES_M = 1.0          # 골격선 격자
COVER_PAD_M = 2.0    # 중심선이 덮는 폭 = 도로폭/2 + 이 값
MIN_COVER_M = 4.0
MIN_PIECE_AREA = 60  # 이보다 작은 남은 면 조각은 버린다 (㎡)
MIN_WIDTH_M = 2.0    # 이보다 좁은 띠(그리기 오차)는 버린다
SPUR_M = 8.0         # 막힌 끝 곁가지 지우기
MIN_PIECE_M = 15.0   # 남은 선 조각 총길이가 이보다 짧으면 버린다
LINK_PAD_M = 4.0     # 막힌 끝 → 기존 중심선 연결 허용 여유
SIMPLIFY_M = 0.7


def _skeleton_lines(poly):
    """다각형 하나의 골격선 → 선 목록 (EPSG:5187 좌표)"""
    from skimage.morphology import skeletonize
    x0, y0, x1, y1 = poly.bounds
    pad = 2 * RES_M
    W = int(math.ceil((x1 - x0 + 2 * pad) / RES_M)); H = int(math.ceil((y1 - y0 + 2 * pad) / RES_M))
    if W * H > 4_000_000:   # 아주 큰 면(넓은 주차장 등)은 격자를 키운다
        return []
    T = from_origin(x0 - pad, y1 + pad, RES_M, RES_M)
    m = rasterize([(poly, 1)], out_shape=(H, W), transform=T).astype(bool)
    sk = skeletonize(m)
    rs, cs = np.nonzero(sk)
    if len(rs) < 3:
        return []
    pix = set(zip(rs.tolist(), cs.tolist()))
    nb = {}
    for r, c in pix:
        nb[(r, c)] = [(r + dr, c + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr or dc) and (r + dr, c + dc) in pix]
    xy = lambda p: (x0 - pad + (p[1] + 0.5) * RES_M, y1 + pad - (p[0] + 0.5) * RES_M)
    nodes = {p for p, n in nb.items() if len(n) != 2}
    seen = set()
    lines = []
    for s in nodes:
        for n in nb[s]:
            if (s, n) in seen:
                continue
            path = [s, n]; seen.add((s, n)); seen.add((n, s))
            prev, cur = s, n
            while cur not in nodes:
                nxt = [q for q in nb[cur] if q != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                seen.add((prev, cur)); seen.add((cur, prev))
                path.append(cur)
            if len(path) >= 2:
                lines.append(LineString([xy(p) for p in path]))
    if not lines:   # 고리 하나뿐인 경우
        ring = [next(iter(pix))]
        while True:
            nxt = [q for q in nb[ring[-1]] if q not in ring]
            if not nxt:
                break
            ring.append(nxt[0])
        if len(ring) >= 3:
            lines.append(LineString([xy(p) for p in ring]))
    return lines


def _prune(lines):
    """막힌 끝 곁가지(SPUR_M 미만)를 두 번 지운다"""
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    for _ in range(2):
        deg = defaultdict(int)
        for ln in lines:
            deg[key(ln.coords[0])] += 1; deg[key(ln.coords[-1])] += 1
        keep = []
        for ln in lines:
            a, b = deg[key(ln.coords[0])], deg[key(ln.coords[-1])]
            if ln.length < SPUR_M and (a == 1 or b == 1) and not (a == 1 and b == 1 and len(lines) == 1):
                continue
            keep.append(ln)
        lines = keep
    return lines


def surface_paths(surfaces, centerlines, walkable):
    """surfaces: 도로 면 다각형 목록. centerlines: [(선, 도로폭 또는 None)] 모든 중심선(걷지 못하는 길 포함, 덮는 폭 계산용).
    walkable: 보행 구간망에 들어가는 중심선 목록 (연결 대상). 돌려줌: (추정 길 선 목록, 통계)"""
    cover = unary_union([ln.buffer(max(MIN_COVER_M, (w or 0) / 2 + COVER_PAD_M), cap_style="flat") for ln, w in centerlines])
    road = unary_union([shapely.make_valid(s) for s in surfaces])
    gap = road.difference(cover)
    pieces = [g for g in getattr(gap, "geoms", [gap]) if g.geom_type == "Polygon" and g.area >= MIN_PIECE_AREA]
    # 그리기 오차로 생긴 가는 띠는 버린다 (안쪽으로 줄였다 다시 키워 남는 것만)
    pieces = [p for p in pieces if not p.buffer(-MIN_WIDTH_M / 2).is_empty]
    T_walk = STRtree(walkable) if walkable else None
    out, n_link, n_pieces = [], 0, 0
    for poly in pieces:
        lines = _prune([ln.simplify(SIMPLIFY_M) for ln in _skeleton_lines(poly)])
        lines = [ln for ln in lines if ln.length >= 1.0]
        if sum(ln.length for ln in lines) < MIN_PIECE_M:
            continue
        n_pieces += 1
        # 막힌 끝 → 가까운 보행 중심선에 잇기
        key = lambda p: (round(p[0], 1), round(p[1], 1))
        deg = defaultdict(int)
        for ln in lines:
            deg[key(ln.coords[0])] += 1; deg[key(ln.coords[-1])] += 1
        ends = {key(c): c for ln in lines for c in (ln.coords[0], ln.coords[-1]) if deg[key(c)] == 1}
        for e in ends.values():
            pe = Point(e)
            if T_walk is None:
                break
            cand = T_walk.query(pe, predicate="dwithin", distance=MIN_COVER_M * 4 + LINK_PAD_M)
            best = None
            for j in cand:
                d = walkable[j].distance(pe)
                if best is None or d < best[0]:
                    best = (d, j)
            if best is None:
                continue
            # 덮는 폭 안쪽에서 끝났을 것이므로 그 폭 + 여유 안이면 잇는다
            if best[0] <= MIN_COVER_M * 4 + LINK_PAD_M:
                q = walkable[best[1]].interpolate(walkable[best[1]].project(pe))
                if q.distance(pe) > 0.5:
                    lines.append(LineString([e, (q.x, q.y)])); n_link += 1
        out.extend(lines)
    return out, dict(gap_ha=round(sum(p.area for p in pieces) / 1e4, 2), pieces=n_pieces, links=n_link,
                     km=round(sum(ln.length for ln in out) / 1000, 2))
