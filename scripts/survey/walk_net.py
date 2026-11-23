"""차도 중심선 구간망 → 인도 기준 보행망 (양쪽 인도 선 + 모퉁이 + 횡단).

왜: 중심선으로 길 안내를 하면 확대했을 때 차도 한가운데를 걷고 아무 데서나 건너는 것처럼 보인다.
     실제로는 인도를 따라 걷고, 큰길은 횡단보도에서만 건넌다.

규칙:
  - 양쪽 인도(dual): 일반 도로(kind=road) 중 인도가 있거나, 폭 6m 이상이거나, 2차로 이상.
    중심선에서 도로폭/2 + 인도 몫(인도폭/2, 없으면 1m)만큼 양옆에 인도 선을 둔다. 경사·포장 등은 원래 구간 값을 그대로 쓴다.
  - 그 밖(골목·보행자도로·OSM 길·연결 추정)은 한 줄(shared)로 둔다.
  - 교차로: 이웃한 두 길 사이 모퉁이(왼쪽 인도 ↔ 다음 길 오른쪽 인도)를 잇는다 (차도를 건너지 않음).
  - 건너기: 횡단보도(전국횡단보도표준데이터) 자리에서는 어느 길이든 건넌다 (턱낮춤 여부를 함께 둔다).
    교차로에서도 건넌다: 4차로 미만은 표시 없는 횡단, 4차로 이상은 교차로 횡단(횡단보도 자료가 빠진 교차로가 많아 막지 않되 벌점).
  - 2026-11-21 고침 (팀 논의, 팀 결정):
    A. 한 줄 길(골목·OSM 길·연결 추정)이 양쪽 인도 길에 붙는 곳에서 한 줄 길 끝을 도로 한가운데가 아니라
       그 길이 향한 쪽 인도에 붙인다. 한가운데로 들어갔다 나오는 V자, 모퉁이 선으로 벌점 없이 큰길을 건너던 문제를 없앰.
    B. (crossing='junction', 기본) 횡단보도가 없으면 '진짜 교차로'(수치지도 길 세 갈래 이상)에서만 건넌다.
       구간이 그냥 나뉜 점(100m마다 자른 곳 등)에서는 건너지 않는다. 인도가 끝나는 곳(양쪽 인도 길 → 인도 없는 길)은 건넌다.
       crossing='any_node'는 예전 규칙(4차로 미만은 두 갈래 노드에서도 건넘).
    C. 교차로인지 셀 때 OSM 길·연결 추정은 세지 않는다.
    D. 인도 끝 꼭짓점을 이웃한 두 길의 인도 선이 만나는 모퉁이까지 당긴다. 넓은 길이 비스듬히 만나면 옆으로 민 점이
       다른 길 차도 위에 떨어져, 같은 쪽 인도로 가는데 차도를 거쳐 도는 삼각형 경로가 생겼다.
    E. 3m 안의 두 꼭짓점은 사이에 차도 중심선이 없으면(같은 쪽 인도) 바로 잇는다. 옆길 중심선이 큰길 한가운데까지
       짧은 토막으로 들어와 차도 위에 인도 조각이 생기는 곳 등에서 들어갔다 나오는 V자를 없앤다.
출력은 앱이 그릴 때 원래 구간을 옆으로 밀어 모양을 만들도록 '원래 구간 id·쪽·구간 내 위치(0~1)'만 둔다 (파일 크기).
"""
import math
from collections import defaultdict

import numpy as np
from rasterio.warp import transform as warp
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

SRC = "EPSG:5187"
DUAL_MIN_WIDTH_M = 6.0
CROSSWALK_ONLY_LANES = 4
TRIM_MAX_DEG = 160.0       # D: 이웃한 두 길 사이 각이 이보다 작을 때만 인도 끝을 모퉁이로 당긴다
TRIM_MAX_M = 40.0
STITCH_M = 3.0             # E: 이 거리 안의 꼭짓점은 사이에 차도 중심선이 없으면 바로 잇는다          # D: 아무리 좁은 각이어도 이만큼까지만 당긴다
CROSSWALK_SNAP_M = 8.0     # 횡단보도 점이 인도 선 밖으로 이만큼까지 벗어나도 그 길에 붙인다
VID0 = 100_000_000         # 새 꼭짓점 번호 (원래 노드 번호와 겹치지 않게)
EID0 = 200_000_000         # 보행망 구간 번호
# 구간 종류 코드 (앱 slope.ts의 WalkKind와 같게)
K_PARENT, K_CORNER, K_FREE, K_CW_LOWERED, K_CW_RAISED, K_CW_FLUSH, K_CW_UNKNOWN, K_JUNCTION = 0, 1, 2, 3, 4, 5, 6, 7


def offset_dist(p):
    w = p.get("road_width_m") or 0
    sw = p.get("sidewalk_width_m")
    return float(min(15.0, max(2.5, w / 2 + ((sw / 2) if sw else 1.0))))


def is_dual(p):
    return p.get("kind") == "road" and (bool(p.get("has_sidewalk")) or (p.get("road_width_m") or 0) >= DUAL_MIN_WIDTH_M or (p.get("lanes") or 0) >= 2)


def build_walk(feats, crosswalks, skip_ids=frozenset(), crossing="junction"):
    """feats: 파이프라인 segments.geojson 피처 (산길 등 skip_ids 제외) + 연결 추정 구간(앱 slim 모양 dict, 'c' 좌표).
    crosswalks: crosswalks.geojson 피처. 돌려줌: 앱용 dict"""
    segs = []
    for f in feats:
        if "properties" in f:
            p = f["properties"]
            if p["id"] in skip_ids:
                continue
            segs.append(dict(id=p["id"], s=p["source"], t=p["target"], c=f["geometry"]["coordinates"], p=p))
        else:   # 연결 추정 등 앱 모양
            segs.append(dict(id=f["id"], s=f["s"], t=f["t"], c=f["c"], p={"kind": f.get("kind"), "length_m": f["len"]}))
    # 좌표를 미터(5187)로 한 번에
    flat = [xy for s in segs for xy in s["c"]]
    X, Y = warp("EPSG:4326", SRC, [c[0] for c in flat], [c[1] for c in flat])
    k = 0
    for s in segs:
        n = len(s["c"])
        s["xy"] = np.column_stack([X[k:k + n], Y[k:k + n]]); k += n
        s["dual"] = is_dual(s["p"])
        s["d"] = offset_dist(s["p"]) if s["dual"] else 0.0
        s["cwonly"] = (s["p"].get("lanes") or 0) >= CROSSWALK_ONLY_LANES

    node_xy = {}
    inc = defaultdict(list)   # 노드 → [(구간, 'S'|'T', 나가는 방향 각도)]
    for s in segs:
        xy = s["xy"]
        node_xy[s["s"]] = xy[0]; node_xy[s["t"]] = xy[-1]
        a0 = math.atan2(xy[1, 1] - xy[0, 1], xy[1, 0] - xy[0, 0])
        a1 = math.atan2(xy[-2, 1] - xy[-1, 1], xy[-2, 0] - xy[-1, 0])
        inc[s["s"]].append((s, "S", a0)); inc[s["t"]].append((s, "T", a1))

    # 횡단보도: 가장 가까운 양쪽 인도 길에 붙인다
    duals = [s for s in segs if s["dual"]]
    lines = [LineString(s["xy"]) for s in duals]
    tree = STRtree(lines)
    cw_at = defaultdict(list)
    cxy = warp("EPSG:4326", SRC, [c["geometry"]["coordinates"][0] for c in crosswalks], [c["geometry"]["coordinates"][1] for c in crosswalks])
    n_cw = 0
    for c, x, y in zip(crosswalks, *cxy):
        pt = Point(x, y)
        cand = tree.query(pt, predicate="dwithin", distance=15.0 + CROSSWALK_SNAP_M)
        best = None
        for j in cand:
            d = lines[j].distance(pt)
            if d <= duals[j]["d"] + CROSSWALK_SNAP_M and (best is None or d < best[0]):
                best = (d, j)
        if best is None:
            continue
        s = duals[best[1]]
        f = min(0.98, max(0.02, lines[best[1]].project(pt, normalized=True)))
        kerb = c["properties"].get("kerb")
        kind = {"lowered": K_CW_LOWERED, "raised": K_CW_RAISED, "flush": K_CW_FLUSH}.get(kerb, K_CW_UNKNOWN)
        cw_at[s["id"]].append((f, kind, bool(c["properties"].get("ped_signal"))))
        n_cw += 1

    # D. 모퉁이 당기기 (2026-11-21): 인도 끝 꼭짓점을 노드에서 옆으로 민 점이 아니라, 이웃한 두 길의 인도 선(또는 한 줄 길 중심선)이
    # 만나는 점까지 길 쪽으로 당긴다. 넓은 길이 비스듬히 만나면 옆으로 민 점이 다른 길 차도 한가운데에 떨어져
    # 같은 쪽 인도로 가는데 차도 위를 거쳐 도는 삼각형 경로가 생겼다 (천곡로 교차로 등).
    lines_by_id = {s["id"]: LineString(s["xy"]) for s in segs if s["dual"]}
    trim = {}       # (구간 id, 쪽, 끝) → 노드에서 길 따라 당길 거리 (m)

    def unit_out(s_, e_):
        xy = s_["xy"]
        v_ = (xy[1] - xy[0]) if e_ == "S" else (xy[-2] - xy[-1])
        L_ = math.hypot(*v_) or 1.0
        return v_ / L_

    for n, lst in inc.items():
        if len(lst) < 2:
            continue
        lst = sorted(lst, key=lambda e: e[2])
        o = node_xy[n]
        for i in range(len(lst)):
            a_, ea, anga = lst[i]
            b_, eb, angb = lst[(i + 1) % len(lst)]
            if not (a_["dual"] or b_["dual"]):
                continue
            inner = (angb - anga) % (2 * math.pi)
            if inner < math.radians(10) or inner > math.radians(TRIM_MAX_DEG):   # 거의 겹치거나 곧게 이어지면 그대로
                continue
            ua, ub = unit_out(a_, ea), unit_out(b_, eb)
            pa = o + a_["d"] * np.array([-ua[1], ua[0]])    # a의 왼쪽 인도 선 (b 쪽)
            pb = o + b_["d"] * np.array([ub[1], -ub[0]])    # b의 오른쪽 인도 선 (a 쪽)
            det = ua[0] * (-ub[1]) - ua[1] * (-ub[0])
            if abs(det) < 1e-6:
                continue
            r = pb - pa
            ta = (r[0] * (-ub[1]) - r[1] * (-ub[0])) / det
            tb = (ua[0] * r[1] - ua[1] * r[0]) / det
            for s_, e_, side_, t_ in ((a_, ea, +1 if ea == "S" else -1, ta), (b_, eb, -1 if eb == "S" else +1, tb)):
                if not s_["dual"] or t_ <= 0:
                    continue
                cap = min(TRIM_MAX_M, lines_by_id[s_["id"]].length * 0.9)
                trim[(s_["id"], side_, e_)] = max(trim.get((s_["id"], side_, e_), 0.0), min(t_, cap))

    # 한 구간 한쪽 인도의 양 끝 당김 합이 길이의 90%를 넘으면 같은 비율로 줄인다 (큰길 안으로 들어온 짧은 토막은 한쪽만 거의 다 당긴다)
    for (sid, side_, e_) in list(trim):
        if e_ != "S":
            continue
        tS, tT = trim.get((sid, side_, "S"), 0.0), trim.get((sid, side_, "T"), 0.0)
        lim = lines_by_id[sid].length * 0.9
        if tS + tT > lim:
            k_ = lim / (tS + tT)
            trim[(sid, side_, "S")] = tS * k_
            if (sid, side_, "T") in trim:
                trim[(sid, side_, "T")] = tT * k_

    verts = {}   # 꼭짓점 → (x, y)
    vkey = {}
    vside = {}   # 인도 꼭짓점 → (구간 id, 끝, 쪽): 같은 구간 끝의 반대쪽끼리 잇지 않으려고 (A)
    attach = {}  # (한 줄 구간 id, 끝) → 붙일 인도 꼭짓점 (A)
    def vid(key, xy):
        if key not in vkey:
            vkey[key] = VID0 + len(vkey)
            verts[vkey[key]] = (float(xy[0]), float(xy[1]))
        return vkey[key]

    def side_end(s, side, end):
        """양쪽 인도 구간 s의 side(+1 왼쪽, -1 오른쪽) 인도 선 끝(end 'S'|'T') 꼭짓점"""
        xy = s["xy"]
        t_ = trim.get((s["id"], side, end), 0.0)
        if t_ > 0:   # D: 모퉁이까지 길 따라 당긴 점, 방향은 그 자리 진행 방향
            line = lines_by_id[s["id"]]
            at = t_ if end == "S" else line.length - t_
            q0, q1 = line.interpolate(max(0.0, at - 0.5)), line.interpolate(min(line.length, at + 0.5))
            q = line.interpolate(at)
            dx, dy = q1.x - q0.x, q1.y - q0.y; base = np.array([q.x, q.y])
        elif end == "S":
            dx, dy = xy[1] - xy[0]; base = xy[0]
        else:
            dx, dy = xy[-1] - xy[-2]; base = xy[-1]
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L, dx / L   # 진행 방향 왼쪽
        v = vid((s["id"], side, end), (base[0] + side * nx * s["d"], base[1] + side * ny * s["d"]))
        vside[v] = (s["id"], end, side)
        return v

    def node_v(n):
        verts.setdefault(n, (float(node_xy[n][0]), float(node_xy[n][1])))
        return n

    def one_end(s, end):   # 한 줄 구간의 끝 꼭짓점: 양쪽 인도 길에 붙으면 그 인도, 아니면 노드 (A)
        return attach.get((s["id"], end)) or node_v(s["s"] if end == "S" else s["t"])

    def out_left(s, end):   # 노드에서 나가는 방향 기준 왼쪽
        if not s["dual"]:
            return one_end(s, end)
        return side_end(s, +1, "S") if end == "S" else side_end(s, -1, "T")

    def out_right(s, end):
        if not s["dual"]:
            return one_end(s, end)
        return side_end(s, -1, "S") if end == "S" else side_end(s, +1, "T")

    edges = []
    def add(s_, t_, parent, side, f0, f1, kind, length):
        if s_ == t_:
            return
        edges.append([EID0 + len(edges), s_, t_, parent, side, round(f0, 4), round(f1, 4), kind, round(float(length), 2)])

    def dist(a, b):
        return math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1])

    # A. 한 줄 길 끝을 그 길이 향한 쪽 인도 꼭짓점에 붙인다 (노드에서 한 줄 길 쪽으로 3m 간 점에 가장 가까운 인도 끝)
    for n, lst in inc.items():
        side_vs = [side_end(s, side, e) for s, e, _ in lst if s["dual"] for side in (+1, -1)]
        if not side_vs:
            continue
        for s, e, _ in lst:
            if s["dual"]:
                continue
            xy = s["xy"]
            p0, p1 = (xy[0], xy[1]) if e == "S" else (xy[-1], xy[-2])
            L = math.hypot(*(p1 - p0)) or 1.0
            q = p0 + (p1 - p0) / L * min(3.0, L)
            attach[(s["id"], e)] = min(side_vs, key=lambda v: (verts[v][0] - q[0]) ** 2 + (verts[v][1] - q[1]) ** 2)

    def crosses(u, v):   # 같은 양쪽 인도 구간 끝의 왼쪽 ↔ 오른쪽 = 차도를 건너는 선
        return u in vside and v in vside and vside[u][:2] == vside[v][:2] and vside[u][2] != vside[v][2]

    real = lambda s: not str(s["p"].get("kind") or "").startswith("osm") and s["p"].get("kind") != "assumed_link"   # C

    # 교차로: 모퉁이와 횡단
    for n, lst in inc.items():
        lst = sorted(lst, key=lambda e: e[2])
        m = len(lst)
        for i in range(m):
            a, ea, _ = lst[i]
            b, eb, _ = lst[(i + 1) % m]
            if m == 1:   # 막다른 길 끝: 돌아 나오기
                l_, r_ = out_left(a, ea), out_right(a, ea)
                add(l_, r_, 0, 0, 0, 1, K_FREE if a["dual"] else K_CORNER, dist(l_, r_))
                continue
            l_, r_ = out_left(a, ea), out_right(b, eb)
            if crosses(l_, r_):   # A: 모퉁이 선으로 차도를 건너지 않는다 (건너기는 아래 규칙으로만)
                continue
            add(l_, r_, 0, 0, 0, 1, K_CORNER, dist(l_, r_))
        if m == 1:
            continue
        m_real = sum(1 for s, _, _ in lst if real(s))   # C: OSM 길·연결 추정은 교차로로 세지 않는다
        n_dual = sum(1 for s, _, _ in lst if s["dual"])
        junction = m_real >= 3
        sidewalk_end = n_dual == 1 and m_real >= 2   # 인도가 끝나고 인도 없는 길로 이어지는 곳
        for s, e, _ in lst:
            if not s["dual"]:
                continue
            if crossing == "any_node":   # 예전 규칙: 4차로 미만은 어느 노드에서나, 4차로 이상은 세 갈래 이상에서
                ok = (not s["cwonly"]) or m_real >= 3
            else:                        # B: 진짜 교차로와 인도 끝에서만 (횡단보도는 아래에서 따로)
                ok = junction or sidewalk_end
            if ok:
                l_, r_ = out_left(s, e), out_right(s, e)
                add(l_, r_, 0, 0, 0, 1, K_JUNCTION if s["cwonly"] else K_FREE, dist(l_, r_))

    # 인도 선·한 줄 구간
    for s in segs:
        L = s["p"].get("length_m") or LineString(s["xy"]).length
        if not s["dual"]:
            add(one_end(s, "S"), one_end(s, "T"), s["id"], 0, 0, 1, K_PARENT, L)
            continue
        line = LineString(s["xy"])
        # D: 모퉁이보다 교차로 안쪽(차도 위)에 찍힌 횡단보도는 모퉁이 바로 바깥(1m)으로 옮긴다
        if s["id"] in cw_at:
            L_ = line.length or 1.0
            lo_ = (max(trim.get((s["id"], +1, "S"), 0.0), trim.get((s["id"], -1, "S"), 0.0)) + 1.0) / L_
            hi_ = 1 - (max(trim.get((s["id"], +1, "T"), 0.0), trim.get((s["id"], -1, "T"), 0.0)) + 1.0) / L_
            if lo_ < hi_:
                cw_at[s["id"]] = [(min(hi_, max(lo_, f)), k, sig) for f, k, sig in cw_at[s["id"]]]
        stops = sorted(set(round(f, 4) for f, _, _ in cw_at.get(s["id"], [])))
        for side in (+1, -1):
            pts = [side_end(s, side, "S")]
            for k_, f in enumerate(stops):
                q = line.interpolate(f, normalized=True)
                q2 = line.interpolate(min(1.0, f + 0.01), normalized=True)
                q1 = line.interpolate(max(0.0, f - 0.01), normalized=True)
                dx, dy = q2.x - q1.x, q2.y - q1.y; Ld = math.hypot(dx, dy) or 1.0
                pts.append(vid((s["id"], side, "c", k_), (q.x - side * dy / Ld * s["d"], q.y + side * dx / Ld * s["d"])))
            pts.append(side_end(s, side, "T"))
            Ll = line.length or 1.0   # D: 당긴 인도 끝부터 그리고 길이도 그만큼 뺀다
            f_s, f_t = trim.get((s["id"], side, "S"), 0.0) / Ll, 1.0 - trim.get((s["id"], side, "T"), 0.0) / Ll
            fs = ([min(f_s, stops[0])] + stops + [max(f_t, stops[-1])]) if stops else [f_s, f_t]
            for (a_, b_), (f0, f1) in zip(zip(pts, pts[1:]), zip(fs, fs[1:])):
                add(a_, b_, s["id"], side, f0, f1, K_PARENT, (f1 - f0) * L)
        for k_, f in enumerate(stops):
            worse = {K_CW_RAISED: 3, K_CW_UNKNOWN: 2, K_CW_LOWERED: 1, K_CW_FLUSH: 0}   # 같은 자리 여러 개면 나쁜 쪽
            kind = max((kk for ff, kk, _ in cw_at[s["id"]] if round(ff, 4) == f), key=worse.get)
            l_, r_ = vkey[(s["id"], +1, "c", k_)], vkey[(s["id"], -1, "c", k_)]
            add(l_, r_, s["id"], 0, f, f, kind, dist(l_, r_))

    # E. 가까운 같은 쪽 꼭짓점 잇기 (2026-11-21): STITCH_M 안에 있는 두 꼭짓점 사이에 차도 중심선(양쪽 인도 길)이 없으면 같은 쪽 인도다.
    # 바로 이어 주지 않으면 1m 옆 같은 인도로 가려고 차도 위 토막·모퉁이를 돌아 나오는 V자·삼각형 경로가 생긴다.
    # 이은 선은 양 끝에서 두 칸 안(끝 꼭짓점 + 한 선으로 이어진 꼭짓점)에 붙은 인도 조각 중 가장 나쁜 원래 구간을 parent로 물려받는다
    # (앱이 그 구간의 경사·폭·턱·장애물을 적용). 짧은 급경사·좁은 조각을 이 선으로 건너뛰어 휠체어 법 기준을 피하지 못하게.
    seg_by_id = {s_["id"]: s_ for s_ in segs}
    def badness(sid):
        p_ = seg_by_id[sid]["p"]
        law = (p_.get("paved") is False or str(p_.get("kind")) in ("osm_steps",)
               or any(k in (p_.get("check_items") or []) for k in ("narrow_sidewalk", "crosswalk_kerb_not_lowered", "osm_wheelchair_no")))
        g_ = [x for x in (p_.get("incline_up_max_pct"), p_.get("incline_down_max_pct"), p_.get("dem_incline_max_pct")) if x is not None]
        return (1 if law else 0, max(g_) if g_ else 99.0)
    par_at = defaultdict(set)
    nbr = defaultdict(set)
    linked = set()
    for e_ in edges:
        linked.add((e_[1], e_[2])); linked.add((e_[2], e_[1]))
        nbr[e_[1]].add(e_[2]); nbr[e_[2]].add(e_[1])
        if e_[7] == K_PARENT and e_[3]:
            par_at[e_[1]].add(e_[3]); par_at[e_[2]].add(e_[3])
    def pars_near(v_):
        out_ = set(par_at.get(v_, ()))
        for w_ in nbr.get(v_, ()):
            out_ |= par_at.get(w_, set())
        return out_
    cell = defaultdict(list)
    for v_, (x_, y_) in verts.items():
        cell[(int(x_ // STITCH_M), int(y_ // STITCH_M))].append(v_)
    n_stitch = 0
    for v_, (x_, y_) in list(verts.items()):
        cx_, cy_ = int(x_ // STITCH_M), int(y_ // STITCH_M)
        for dx_ in (-1, 0, 1):
            for dy_ in (-1, 0, 1):
                for u_ in cell.get((cx_ + dx_, cy_ + dy_), ()):
                    if u_ <= v_ or (v_, u_) in linked:
                        continue
                    dd = dist(v_, u_)
                    if dd > STITCH_M:
                        continue
                    seg_ = LineString([verts[v_], verts[u_]]) if dd > 0 else None
                    if seg_ is not None and any(lines[j].intersects(seg_) for j in tree.query(seg_)):
                        continue
                    pars = pars_near(v_) | pars_near(u_)
                    add(v_, u_, max(pars, key=badness) if pars else 0, 0, 0, 1, K_CORNER, dd)
                    linked.add((v_, u_)); linked.add((u_, v_))
                    n_stitch += 1

    # 꼭짓점 좌표 → 경위도
    ids = list(verts)
    lon, lat = warp(SRC, "EPSG:4326", [verts[i][0] for i in ids], [verts[i][1] for i in ids])
    return {
        "v": [[i, round(a, 6), round(b, 6)] for i, a, b in zip(ids, lon, lat)],
        "e": edges,
        "d": {s["id"]: round(s["d"], 2) for s in segs if s["dual"]},
        "stats": {"dual_segments": len(duals), "crosswalks_attached": n_cw, "stitched": n_stitch, "edges": len(edges), "vertices": len(ids)},
    }
