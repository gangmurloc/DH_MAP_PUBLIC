"""DEM 경사 현장 검증용 시험 지점을 만든다.

사용법:
    python -I make_fieldtest.py <수치지도 SHP 폴더> <dem.tif> <출력 폴더>
        --center X Y --half 600 [--n 32] [--spacing 50]

하는 일:
    1. 도로 중심선(N3L_A0020000)과 자전거보행자겸용도로(N3L_A0033330)를 따라 15m 간격으로 후보 지점을 만든다
    2. 지점마다 '진행 방향' DEM 경사를 계산한다
         slope10 = (앞 5m 높이 − 뒤 5m 높이) ÷ 10m   ← 현장 3회 측정(−5m, 0, +5m) 평균과 비교
         slope30 = (앞 15m − 뒤 15m) ÷ 30m          ← 참고
       부호: 진행 방향(방위각)으로 오르막이면 +
    3. 옹벽·계단·교량·절토 10m 안이면 주의 표시 (DEM이 틀리기 쉬운 곳)
    4. 경사 구간별로 고르게 n개를 뽑고(서로 spacing m 이상 떨어지게), 걷는 순서를 정한다
    5. checkpoints.csv(엑셀용), checkpoints.json(현장 페이지용), route.png(미리보기)를 쓴다
"""
import argparse
import csv
import json
import math
import os
import warnings

import numpy as np
import rasterio
import shapefile
from rasterio.warp import transform as warp

warnings.simplefilter("ignore")
ENC = "cp949"
BINS = [(0, 2), (2, 4), (4, 6), (6, 9), (9, 15), (15, 30)]
MAX_PLAUSIBLE = 30.0  # 도로에서 30% 넘는 DEM 경사는 DEM 오류(옹벽·절토 뭉개짐)일 가능성이 커서 뺀다


def lines(folder, name):
    p = os.path.join(folder, name + ".shp")
    if not os.path.exists(p):
        return []
    r = shapefile.Reader(p, encoding=ENC)
    out = []
    for s in r.shapes():
        parts = list(s.parts) + [len(s.points)]
        for a, b in zip(parts[:-1], parts[1:]):
            if b - a >= 2:
                out.append(np.array(s.points[a:b], float))
    return out


def all_vertices(folder, names, step=2.0):
    pts = []
    for n in names:
        p = os.path.join(folder, n + ".shp")
        if not os.path.exists(p):
            continue
        for s in shapefile.Reader(p, encoding=ENC).shapes():
            q = np.array(s.points, float)
            if len(q) == 1:
                pts.append(q[0]); continue
            for a, b in zip(q[:-1], q[1:]):
                d = np.hypot(*(b - a)); k = max(1, int(d // step))
                for t in range(k + 1):
                    pts.append(a + (b - a) * t / k)
    return np.array(pts) if pts else np.zeros((0, 2))


def at_distance(line, cum, d):
    d = min(max(d, 0), cum[-1])
    i = min(np.searchsorted(cum, d, side="right") - 1, len(line) - 2)
    t = (d - cum[i]) / max(cum[i + 1] - cum[i], 1e-9)
    return line[i] + (line[i + 1] - line[i]) * t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dem"); ap.add_argument("out")
    ap.add_argument("--center", nargs=2, type=float, required=True)
    ap.add_argument("--half", type=float, default=600)
    ap.add_argument("--n", type=int, default=32)
    ap.add_argument("--spacing", type=float, default=50)
    ap.add_argument("--start", nargs=2, type=float, help="출발 지점 X Y (없으면 center)")
    ap.add_argument("--n-flagged", type=int, default=4, help="옹벽·계단·교량·절토 근처 지점을 따로 몇 개 넣을지")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cx, cy = a.center
    x0, x1, y0, y1 = cx - a.half, cx + a.half, cy - a.half, cy + a.half

    ds = rasterio.open(a.dem)
    dem = ds.read(1); nod = ds.nodata
    T = ds.transform

    def z(xy):
        xy = np.atleast_2d(xy)
        c = ((xy[:, 0] - T.c) / T.a - 0.5); r = ((xy[:, 1] - T.f) / T.e - 0.5)
        c0 = np.clip(np.floor(c).astype(int), 0, dem.shape[1] - 2); r0 = np.clip(np.floor(r).astype(int), 0, dem.shape[0] - 2)
        tc = c - c0; tr = r - r0
        g = [dem[r0, c0], dem[r0, c0 + 1], dem[r0 + 1, c0], dem[r0 + 1, c0 + 1]]
        v = g[0] * (1 - tc) * (1 - tr) + g[1] * tc * (1 - tr) + g[2] * (1 - tc) * tr + g[3] * tc * tr
        bad = np.any([gg == nod for gg in g], axis=0)
        return np.where(bad, np.nan, v)

    slope_path = os.path.join(os.path.dirname(a.dem), "slope_pct.tif")
    sds = rasterio.open(slope_path) if os.path.exists(slope_path) else None

    hazards = {
        "옹벽": all_vertices(a.src, ["N3L_F0040000"]),
        "계단": all_vertices(a.src, ["N3A_C0390000"]),
        "교량": all_vertices(a.src, ["N3A_A0070000"]),
        "절토": all_vertices(a.src, ["N3L_F0030000"]),
    }
    from scipy.spatial import cKDTree
    trees = {k: cKDTree(v) for k, v in hazards.items() if len(v)}

    cands = []
    for src_name in ("N3L_A0020000", "N3L_A0033330"):
        for ln in lines(a.src, src_name):
            if ln[:, 0].max() < x0 or ln[:, 0].min() > x1 or ln[:, 1].max() < y0 or ln[:, 1].min() > y1:
                continue
            seg = np.hypot(*np.diff(ln, axis=0).T)
            cum = np.concatenate([[0], np.cumsum(seg)])
            L = cum[-1]
            if L < 30:
                continue
            for d in np.arange(15, L - 15 + 1e-6, 15):
                p = at_distance(ln, cum, d)
                if not (x0 <= p[0] <= x1 and y0 <= p[1] <= y1):
                    continue
                pf, pb = at_distance(ln, cum, d + 5), at_distance(ln, cum, d - 5)
                pf15, pb15 = at_distance(ln, cum, d + 15), at_distance(ln, cum, d - 15)
                pf25, pb25 = at_distance(ln, cum, d + 2.5), at_distance(ln, cum, d - 2.5)
                zf, zb, zf15, zb15, z0, zf25, zb25 = z(np.array([pf, pb, pf15, pb15, p, pf25, pb25]))
                if np.isnan([zf, zb, zf15, zb15, z0, zf25, zb25]).any():
                    continue
                s5 = (zf25 - zb25) / 5 * 100
                v = pf - pb
                # 방위각: 북=0, 시계방향 (EPSG:5186은 북쪽이 +y)
                bearing = (math.degrees(math.atan2(v[0], v[1])) + 360) % 360
                s10 = (zf - zb) / 10 * 100
                s30 = (zf15 - zb15) / 30 * 100
                # 오르막 방향으로 방위 통일 → 현장에서 '오르막을 향해' 재면 되도록
                if s10 < 0:
                    bearing = (bearing + 180) % 360; s10, s30, s5 = -s10, -s30, -s5
                flags = [k for k, t in trees.items() if t.query(p, k=1)[0] <= 10]
                smax = float(next(sds.sample([tuple(p)]))[0]) if sds else float("nan")
                cands.append(dict(x=p[0], y=p[1], z=float(z0), bearing=bearing, s5=float(s5), s10=float(s10), s30=float(s30),
                                  smax=smax, flags=flags, src="도로" if src_name.endswith("20000") else "자전거보행자겸용도로"))

    n_all = len(cands)
    implausible = [c for c in cands if c["s10"] > MAX_PLAUSIBLE]
    cands = [c for c in cands if c["s10"] <= MAX_PLAUSIBLE]
    print(f"후보 지점: {n_all} (DEM 경사 {MAX_PLAUSIBLE:.0f}% 초과로 제외 {len(implausible)})")
    rng = np.random.default_rng(1)
    n_plain = a.n - a.n_flagged
    per = max(1, n_plain // len(BINS))
    chosen = []

    def far_enough(c):
        return all(math.hypot(c["x"] - o["x"], c["y"] - o["y"]) >= a.spacing for o in chosen)

    plain = [c for c in cands if not c["flags"]]
    flagged = [c for c in cands if c["flags"]]
    for lo, hi in BINS:
        pool = [c for c in plain if lo <= c["s10"] < hi]
        rng.shuffle(pool)
        got = 0
        for c in pool:
            if got >= per:
                break
            if far_enough(c):
                chosen.append(c); got += 1
        print(f"  경사 {lo}~{hi}%: 후보 {len(pool)}, 선택 {got}")
    rest = [c for c in plain if c not in chosen]
    rng.shuffle(rest)
    for c in rest:
        if len(chosen) >= n_plain:
            break
        if far_enough(c):
            chosen.append(c)
    # 주의 지점: 경사가 있는 곳 위주로 (DEM이 과장하는지 보려고)
    flagged.sort(key=lambda c: -c["s10"])
    fl = 0
    for c in flagged[: max(40, a.n_flagged * 10)]:
        if fl >= a.n_flagged:
            break
        if far_enough(c):
            chosen.append(c); fl += 1
    print(f"  주의 지점(옹벽·계단·교량·절토 10m 안): 후보 {len(flagged)}, 선택 {fl}")

    # 걷는 순서: 가장 가까운 점 잇기 + 2-opt
    sx, sy = a.start if a.start else (cx, cy)
    P = np.array([[c["x"], c["y"]] for c in chosen])
    order = [int(np.argmin(np.hypot(P[:, 0] - sx, P[:, 1] - sy)))]
    left = set(range(len(P))) - set(order)
    while left:
        last = P[order[-1]]
        nxt = min(left, key=lambda i: np.hypot(*(P[i] - last)))
        order.append(nxt); left.remove(nxt)

    def tour_len(o):
        return sum(np.hypot(*(P[o[i + 1]] - P[o[i]])) for i in range(len(o) - 1))

    improved = True
    while improved:
        improved = False
        for i in range(1, len(order) - 2):
            for j in range(i + 1, len(order) - 1):
                new = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                if tour_len(new) < tour_len(order) - 1e-6:
                    order = new; improved = True
    chosen = [chosen[i] for i in order]

    lon, lat = warp(ds.crs, "EPSG:4326", [c["x"] for c in chosen], [c["y"] for c in chosen])
    rows = []
    for i, (c, lo_, la_) in enumerate(zip(chosen, lon, lat), 1):
        cid = f"H{i:02d}"
        rows.append({
            "순서": i, "ID": cid, "위도": round(la_, 7), "경도": round(lo_, 7),
            "오르막방위": round(c["bearing"]), "DEM표고_m": round(c["z"], 2),
            "DEM경사5m_%": round(c["s5"], 2), "DEM경사10m_%": round(c["s10"], 2), "DEM경사30m_%": round(c["s30"], 2),
            "DEM최대경사_%": round(c["smax"], 1), "주의": "/".join(c["flags"]), "선종류": c["src"],
            "카카오지도": f"https://map.kakao.com/link/map/{cid},{la_:.7f},{lo_:.7f}",
            "카카오로드뷰": f"https://map.kakao.com/link/roadview/{la_:.7f},{lo_:.7f}",
            "측정_뒤5m_도": "", "측정_중앙_도": "", "측정_중앙180_도": "", "측정_앞5m_도": "", "비고": "",
        })
    with open(os.path.join(a.out, "checkpoints.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    with open(os.path.join(a.out, "checkpoints.json"), "w", encoding="utf-8") as f:
        json.dump([{"id": r["ID"], "order": r["순서"], "lat": r["위도"], "lon": r["경도"], "bearing": r["오르막방위"],
                    "z": r["DEM표고_m"], "s5": r["DEM경사5m_%"], "s10": r["DEM경사10m_%"], "s30": r["DEM경사30m_%"], "smax": r["DEM최대경사_%"],
                    "flags": r["주의"], "line": r["선종류"]} for r in rows], f, ensure_ascii=False, indent=1)
    Q = np.array([[c["x"], c["y"]] for c in chosen])
    total = float(np.hypot(*np.diff(Q, axis=0).T).sum())
    print(f"선택 {len(rows)}개, 지점 사이 직선거리 합 {total:.0f} m (실제 걷는 거리는 이보다 1.3~1.5배)")
    for r in rows:
        print(f"  {r['ID']} 경사5m {r['DEM경사5m_%']:6.2f}%  10m {r['DEM경사10m_%']:6.2f}%  30m {r['DEM경사30m_%']:6.2f}%  방위 {r['오르막방위']:3d}°  {r['주의']}")


if __name__ == "__main__":
    main()
