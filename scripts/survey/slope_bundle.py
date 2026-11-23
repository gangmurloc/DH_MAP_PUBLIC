"""경사 지도 앱 데이터 묶음: 한 기관 주변 반경 안의 구간 경사 추정 + 배경 지도 PNG.

사용법:
    python -I slope_bundle.py <파이프라인 출력 폴더> <수치지도 도엽 폴더(raw/donghae_5000)> --out <앱 data 폴더>
        [--center 동해시청소년센터] [--radius 700] [--mpp 1.0]

출력:
    slope.json    구간마다 최종 경사 추정(길 위 표고 또는 DEM), DEM 그대로 값, 출처·관측 구역·점검 항목
    basemap.png   area_bundle과 같은 수치지도 배경 그림
"""
import argparse
import datetime
import json
import os
import sys

from rasterio.warp import transform as warp
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from shapely import STRtree
from shapely.geometry import LineString, Point

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from area_bundle import (LINK_ID0, LINK_MAX_M, MOUNTAIN_BUILDING_M, MOUNTAIN_CLASSES,  # noqa: E402
                         MOUNTAIN_MAX_W_M, MOUNTAIN_Z_M, SRC_CRS, read_layer, render_basemap)
from scipy.sparse.csgraph import connected_components  # noqa: E402
from survey_sheet import Dem, load, resolve_stop  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder"); ap.add_argument("raw")
    ap.add_argument("--out", required=True)
    ap.add_argument("--center", default="동해시청소년센터")
    ap.add_argument("--radius", type=float, default=700.0)
    ap.add_argument("--mpp", type=float, default=1.0)
    ap.add_argument("--view", type=float, default=700.0, help="처음 화면에 보일 반경 m (데이터 범위 --radius와 별개)")
    ap.add_argument("--all", action="store_true", help="반경으로 자르지 않고 파이프라인 출력 전체 (동해시 전체 지도)")
    ap.add_argument("--no-basemap", action="store_true", help="배경 지도 PNG를 만들지 않는다 (카카오 지도만 쓰는 큰 지역)")
    ap.add_argument("--file", default="slope.json", help="출력 JSON 파일 이름")
    ap.add_argument("--keep", action="append", default=["무릉계곡관광지,129.01938,37.46347"],
                    help="산길 판정에서 빼고 남길 길의 도착지 '이름,경도,위도'. --keep-from에서 이곳까지 최단 길을 남긴다 (여러 번 쓸 수 있음)")
    ap.add_argument("--keep-from", default="동해시청", help="--keep 길의 출발 기관")
    ap.add_argument("--walk", default=None, help="인도 기준 보행망 파일 이름 (walk_net.py, 같은 --out 폴더에 쓴다)")
    ap.add_argument("--crossing", default="junction", choices=["junction", "any_node"],
                    help="보행망 건너기 규칙: junction(횡단보도·진짜 교차로·인도 끝에서만, 기본) / any_node(예전: 4차로 미만은 어느 노드에서나)")
    a = ap.parse_args()

    segs = load(a.folder, "segments.geojson")
    nodes = load(a.folder, "nodes.geojson")
    places = load(a.folder, "places.geojson")
    name, clon, clat = resolve_stop(a.center, places)
    (cx,), (cy,) = warp("EPSG:4326", SRC_CRS, [clon], [clat])
    circle = Point(cx, cy).buffer(a.radius)
    bb = [cx - a.radius, cy - a.radius, cx + a.radius, cy + a.radius]

    pick = []
    for f in segs:
        co = f["geometry"]["coordinates"]
        if a.all:
            pick.append(f)
            continue
        if abs(co[0][0] - clon) > 0.02 or abs(co[0][1] - clat) > 0.02:
            continue
        x, y = warp("EPSG:4326", SRC_CRS, [c[0] for c in co], [c[1] for c in co])
        if LineString(zip(x, y)).intersects(circle):
            pick.append(f)

    # 산길 추정 (경로에서 뺀다, area_bundle과 같은 규칙): 고도 MOUNTAIN_Z_M 초과,
    # 또는 폭 MOUNTAIN_MAX_W_M 이하 소로·면리간도로·미분류가 급경사 추정인데 MOUNTAIN_BUILDING_M 안에 건물이 없음 (임도·농로)
    geo5 = {}
    for f in pick:
        co = f["geometry"]["coordinates"]
        x, y = warp("EPSG:4326", SRC_CRS, [c[0] for c in co], [c[1] for c in co])
        geo5[f["properties"]["id"]] = LineString(zip(x, y))
    xs = [g.bounds[0] for g in geo5.values()] + [g.bounds[2] for g in geo5.values()]
    ys = [g.bounds[1] for g in geo5.values()] + [g.bounds[3] for g in geo5.values()]
    buildings = read_layer(a.raw, "N3A_B0010000", [min(xs) - 100, min(ys) - 100, max(xs) + 100, max(ys) + 100])
    btree = STRtree(buildings)
    mountain = {}
    for f in pick:
        p = f["properties"]
        z = max(p.get("z_start") or 0, p.get("z_end") or 0)
        if z > MOUNTAIN_Z_M:
            mountain[p["id"]] = f"고도 {z:.0f}m"
        elif (p["dem_estimate"] == "steep" and p["road_class"] in MOUNTAIN_CLASSES and (p["road_width_m"] or 0) <= MOUNTAIN_MAX_W_M
              and len(btree.query(geo5[p["id"]], predicate="dwithin", distance=MOUNTAIN_BUILDING_M)) == 0):
            mountain[p["id"]] = f"급경사·건물 {MOUNTAIN_BUILDING_M:.0f}m 안 없음"
    # 남길 길: --keep-from에서 --keep 도착지까지 최단 길(거리 기준)은 산길이어도 남긴다 (예: 무릉계곡 가는 길)
    nid = sorted({f["properties"][k] for f in pick for k in ("source", "target")})
    ix = {n: i for i, n in enumerate(nid)}
    rows = [ix[f["properties"]["source"]] for f in pick]; cols = [ix[f["properties"]["target"]] for f in pick]
    lens = [f["properties"]["length_m"] for f in pick]
    G = csr_matrix((lens + lens, (rows + cols, cols + rows)), shape=(len(nid), len(nid)))
    edge = {}
    for f, r, c in zip(pick, rows, cols):
        for k in ((r, c), (c, r)):
            if k not in edge or edge[k]["properties"]["length_m"] > f["properties"]["length_m"]:
                edge[k] = f
    node_xy = {}
    for f in pick:
        co = f["geometry"]["coordinates"]
        node_xy[f["properties"]["source"]] = co[0]; node_xy[f["properties"]["target"]] = co[-1]
    nxy = np.array([node_xy[n] for n in nid])

    def nearest(lon, lat):
        d = (nxy[:, 0] - lon) ** 2 * np.cos(np.radians(lat)) ** 2 + (nxy[:, 1] - lat) ** 2
        return int(np.argmin(d))
    kept = {}
    try:
        _, flon, flat = resolve_stop(a.keep_from, places)
        src = nearest(flon, flat)
        _, pred = dijkstra(G, directed=False, indices=src, return_predecessors=True)
        for spec in a.keep:
            kname, klon, klat = spec.split(",")
            t = nearest(float(klon), float(klat))
            ids = []
            while t != src and pred[t] >= 0:
                ids.append(edge[(pred[t], t)]["properties"]["id"]); t = pred[t]
            for i in ids:
                kept[i] = kname
            print(f"남길 길: {a.keep_from} → {kname} {len(ids)}구간, 그중 산길 판정 해제 {sum(1 for i in ids if i in mountain)}")
    except SystemExit as e:   # keep-from 기관이 범위에 없으면 건너뛴다
        print(f"남길 길 건너뜀: {e}")
    for i in kept:
        mountain.pop(i, None)
    print(f"산길 추정 {len(mountain)}구간 ({sum(geo5[i].length for i in mountain)/1000:.1f}km) → 경로에서 뺌")

    # 연결 추정: 산길을 빼서 큰 도로망에서 떨어진 기관(예: 동해시청소년센터)이 있으면, 그 조각과 큰 도로망 사이
    # 가장 가까운 두 노드(LINK_MAX_M 안)를 직선 '연결 추정' 구간으로 잇는다 (area_bundle과 같은 방식, 현장 확인 대상)
    road = [f for f in pick if f["properties"]["id"] not in mountain]
    rn = sorted({f["properties"][k] for f in road for k in ("source", "target")})
    rix = {n: i for i, n in enumerate(rn)}
    RG = csr_matrix(([1] * len(road) * 2, ([rix[f["properties"]["source"]] for f in road] + [rix[f["properties"]["target"]] for f in road],
                                          [rix[f["properties"]["target"]] for f in road] + [rix[f["properties"]["source"]] for f in road])),
                    shape=(len(rn), len(rn)))
    _, comp = connected_components(RG, directed=False)
    main_c = np.bincount(comp).argmax()
    rxy = np.array([node_xy[n] for n in rn])
    kx = np.cos(np.radians(clat)) * 111_320.0
    rm = np.column_stack([rxy[:, 0] * kx, rxy[:, 1] * 111_320.0])
    links, linked = [], set()
    for pl in places:
        lo, la = pl["geometry"]["coordinates"]
        d = np.hypot(rm[:, 0] - lo * kx, rm[:, 1] - la * 111_320.0)
        j = int(np.argmin(d))
        if d[j] > 300 or comp[j] == main_c or comp[j] in linked:
            continue
        inside = np.where(comp == comp[j])[0]
        outside = np.where(comp == main_c)[0]
        best = None
        for a_ in inside:
            dd = np.hypot(rm[outside, 0] - rm[a_, 0], rm[outside, 1] - rm[a_, 1])
            b_ = int(np.argmin(dd))
            if dd[b_] <= LINK_MAX_M and (best is None or dd[b_] < best[0]):
                best = (float(dd[b_]), int(a_), int(outside[b_]))
        if best is None:
            print(f"경고: {pl['properties']['name']} 쪽 길이 큰 도로망과 {LINK_MAX_M:.0f}m 넘게 떨어져 잇지 않습니다")
            continue
        linked.add(comp[j])
        L, a_, b_ = best
        u, v = rn[a_], rn[b_]
        lid = LINK_ID0 + len(links)
        links.append({"id": lid, "s": u, "t": v, "c": [[round(x, 6), round(y, 6)] for x, y in (node_xy[u], node_xy[v])],
                      "len": round(L, 2), "cls": "연결 추정", "kind": "assumed_link", "name": None, "w": None, "sw": False, "swW": None,
                      "bridge": False, "tunnel": False, "est": "unknown", "max": None, "avg": None, "raw": None, "src": None,
                      "basis": None, "gap": None, "check": ["assumed_link"], "up": None, "down": None, "mtn": None,
                      "keep": None, "link": pl["properties"]["name"]})
        mid = node_xy[u]
        print(f"연결 추정 {lid}: {pl['properties']['name']} 쪽 조각 → 큰 도로망 {L:.0f}m (한쪽 끝 {mid[1]:.6f},{mid[0]:.6f})")

    def slim(f):
        p = f["properties"]
        return {"id": p["id"], "s": p["source"], "t": p["target"], "c": [[round(x, 6), round(y, 6)] for x, y in f["geometry"]["coordinates"]],
                "len": p["length_m"], "cls": p["road_class"], "kind": p.get("kind"), "name": p.get("road_name"), "w": p.get("road_width_m"),
                "sw": p["has_sidewalk"], "swW": p.get("sidewalk_width_m"), "bridge": p["on_bridge"], "tunnel": p["in_tunnel"],
                "est": p["dem_estimate"], "max": p["dem_incline_max_pct"], "avg": p["dem_incline_pct"],
                "raw": p.get("dem_incline_raw_max_pct"), "src": p.get("incline_source"), "basis": p.get("incline_basis"),
                "gap": p.get("road_obs_gap_m"), "check": p.get("check_items", []),
                "up": p.get("incline_up_max_pct"), "down": p.get("incline_down_max_pct"),
                "mtn": mountain.get(p["id"]), "keep": kept.get(p["id"]),
                **({"unpaved": True} if p.get("paved") is False else {}),
                # 진행 방향 경사별 길이(9칸, m)와 5.6% 이상 연속 구간(+ 오르막, m): 앱의 시간 계산·쉬는 시간용
                **({"h": [round(x) for x in p["incline_hist"]]} if p.get("incline_hist") else {}),
                **({"r": p["incline_runs"]} if p.get("incline_runs") else {})}

    keep_nodes = {f["properties"][k] for f in pick for k in ("source", "target")}
    crossings = [{"lon": n["geometry"]["coordinates"][0], "lat": n["geometry"]["coordinates"][1],
                  "kerb": n["properties"].get("crossing_kerb")}
                 for n in nodes if n["properties"]["id"] in keep_nodes and n["properties"].get("crossing")]
    near_places = []
    for p in places:
        lo, la = p["geometry"]["coordinates"]
        (px,), (py,) = warp("EPSG:4326", SRC_CRS, [lo], [la])
        if a.all or circle.buffer(100).contains(Point(px, py)):
            near_places.append({"name": p["properties"]["name"], "category": p["properties"]["category"], "lon": lo, "lat": la})

    os.makedirs(a.out, exist_ok=True)
    if a.walk:
        from walk_net import build_walk
        crosswalks = load(a.folder, "crosswalks.geojson")
        walk = build_walk(pick + links, crosswalks, skip_ids=frozenset(mountain), crossing=a.crossing)
        wpath = os.path.join(a.out, a.walk)
        with open(wpath, "w", encoding="utf-8") as f:
            json.dump({k: v for k, v in walk.items() if k != "stats"}, f, ensure_ascii=False, separators=(",", ":"))
        print(f"인도 보행망: {walk['stats']}, {os.path.getsize(wpath)/1024/1024:.1f}MB")
    if a.no_basemap:
        png, image_coords, W, H = b"", [], 0, 0
    else:
        png, image_coords, W, H = render_basemap(a.raw, Dem(os.path.join(a.folder, "dem.tif")), bb, a.mpp, clat)
        with open(os.path.join(a.out, "basemap.png"), "wb") as f:
            f.write(png)
    bundle = {"name": "동해시 전체" if a.all else f"{name} 주변", "generated": datetime.date.today().isoformat(),
              "center": {"name": name, "lon": clon, "lat": clat}, "radius": a.radius, "view": a.view, "all": a.all,
              "segments": [slim(f) for f in pick] + links, "crossings": crossings, "places": near_places,
              "image": {"coords": image_coords, "w": W, "h": H}}
    path = os.path.join(a.out, a.file)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{'동해시 전체' if a.all else f'{name} 반경 {a.radius:.0f}m'}: 구간 {len(pick)}개, 횡단보도 노드 {len(crossings)}곳, 기관 {len(near_places)}곳, "
          f"배경 지도 {W}×{H}px {len(png)/1024:.0f}KB, slope.json {os.path.getsize(path)/1024:.0f}KB")


if __name__ == "__main__":
    main()
