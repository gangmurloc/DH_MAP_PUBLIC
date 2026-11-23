"""현장 조사 점검표: 출발→도착 경로 위 구간 목록을 만든다 (CSV, GeoJSON).

사용법:
    python -I survey_sheet.py <파이프라인 출력 폴더> --stops 동해시종합버스터미널 동해시청소년센터 --out <출력 폴더>
        [--stops 이름|경도,위도 ...]   기관 이름(places.geojson, 일부만 써도 됨) 또는 좌표. 2개 이상이면 차례로 잇는다
        [--no-detour]                 우회 경로(B)를 만들지 않음

경로 두 개를 함께 싣는다.
  A: 가장 짧은 길. 앱의 '일반 경로'와 같은 기준
  B: DEM 급경사·보도 없는 지하차도를 피하는 우회 길
무장애 경로는 조사된 구간(통행 가능·주의)만으로 계산하므로, A만 조사하면 A에 통행 어려움이 하나라도 있을 때
무장애 경로가 아예 없다. B까지 조사해야 시연에서 '두 경로가 다르게 나오는' 장면을 만들 수 있다.

출력:
    sheet.csv       점검표 (엑셀에서 열림). 오른쪽 빈칸을 현장에서 채워 load_survey.py로 넣는다
    routes.geojson  경로 A·B 선과 구간 (geojson.io·QGIS에서 확인)
    summary.txt     경로 길이, DEM 추정 구성
"""
import argparse
import csv
import json
import math
import os
import sys

import numpy as np
import rasterio
from rasterio.warp import transform as warp
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

SNAP_MAX_M = 300.0       # DB route()와 같은 값
WINDOW_M = 30.0          # 파이프라인 SLOPE_WINDOW_M과 같은 값
# 우회 경로 비용 = 길이 × 배수. 급경사를 '금지'가 아니라 '비싸게' 해서 다른 길이 없으면 지나가게 한다
DETOUR_FACTOR = {"steep": 10.0, "moderate": 2.0, "unknown": 2.0, "gentle": 1.0}
UNDERPASS_FACTOR = 50.0

GRADE_INPUTS = ["경사%", "횡경사%", "장애물", "턱높이cm", "폭cm", "장애물위도", "장애물경도", "등급", "사유", "완료", "메모"]
CHECK_LABEL = {   # donghae_pipeline.check_items 코드
    "bridge_measure": "교량: 현장 측정", "slope_measure": "경사 측정", "slope_confirm_steep": "급경사 확인",
    "wall_or_cut_nearby": "옹벽·절토 단차", "wall_crossing": "옹벽·절토 가로지름: 계단·단차", "slope_sources_disagree": "경사 추정 불일치: 측정 우선", "osm_steps": "OSM 계단", "osm_path": "OSM 보완 길", "osm_wheelchair_no": "OSM 휠체어 불가", "stairs_nearby": "계단 근처", "tunnel": "터널",
    "underpass_no_sidewalk": "보도 없는 지하차도", "overpass_inaccessible": "육교(장애인 이용 불가): 평면 횡단 확인",
    "no_sidewalk_data": "보도 유무", "narrow_sidewalk": "좁은 보도", "crosswalk_kerb_not_lowered": "횡단보도 턱",
    "crosswalk_which_side": "횡단보도 위치",
}


def load(folder, name):
    with open(os.path.join(folder, name), encoding="utf-8") as f:
        return json.load(f)["features"]


def local_xy(lon, lat, lat0):
    """경위도 → 대략적인 미터 (시 범위 거리 비교용)"""
    k = 111_320.0
    return np.column_stack([(np.asarray(lon) - 129.1) * k * math.cos(math.radians(lat0)), (np.asarray(lat) - lat0) * k])


def resolve_stop(text, places):
    if "," in text:
        lon, lat = (float(v) for v in text.split(","))
        return text, lon, lat
    exact = [p for p in places if p["properties"]["name"] == text]
    part = exact or [p for p in places if text in p["properties"]["name"]]
    if len(part) != 1:
        names = ", ".join(p["properties"]["name"] for p in part[:8]) or "없음"
        sys.exit(f"'{text}'에 맞는 기관이 {len(part)}곳입니다 ({names}). 이름을 더 정확히 쓰거나 경도,위도로 주세요")
    lon, lat = part[0]["geometry"]["coordinates"]
    return part[0]["properties"]["name"], lon, lat


class Dem:
    def __init__(self, path):
        self.ds = rasterio.open(path)
        self.z = self.ds.read(1).astype(np.float64)
        self.z[self.z <= -9000] = np.nan
        self.crs = self.ds.crs

    def to_xy(self, coords):
        lon, lat = zip(*coords)
        x, y = warp("EPSG:4326", self.crs, list(lon), list(lat))
        return np.array(x), np.array(y)

    def sample(self, xs, ys):
        t = self.ds.transform
        fc = (xs - t.c) / t.a - 0.5
        fr = (ys - t.f) / t.e - 0.5
        H, W = self.z.shape
        c0 = np.clip(np.floor(fc).astype(int), 0, W - 2); r0 = np.clip(np.floor(fr).astype(int), 0, H - 2)
        tc = np.clip(fc - c0, 0, 1); tr = np.clip(fr - r0, 0, 1)
        z = self.z
        return (z[r0, c0] * (1 - tc) * (1 - tr) + z[r0, c0 + 1] * tc * (1 - tr)
                + z[r0 + 1, c0] * (1 - tc) * tr + z[r0 + 1, c0 + 1] * tc * tr)


def steepest_spot(dem, coords, forward):
    """30m 창 경사가 가장 큰 곳: (경도, 위도, 진행 방향 부호 있는 경사%, 진행 방위°). 파이프라인과 같은 계산"""
    if not forward:
        coords = coords[::-1]
    x, y = dem.to_xy(coords)
    seg = np.hypot(np.diff(x), np.diff(y))
    cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]
    if L <= 0:
        return None
    ds = np.linspace(0, L, max(2, int(L // 2.5) + 1))
    px, py = np.interp(ds, cum, x), np.interp(ds, cum, y)
    z = dem.sample(px, py)
    if np.isnan(z).any():
        return None
    step = len(ds) - 1 if L <= WINDOW_M else max(1, int(round(WINDOW_M / (ds[1] - ds[0]))))
    i = int(np.argmax([abs(z[k + step] - z[k]) / (ds[k + step] - ds[k]) for k in range(len(z) - step)]))
    j = i + step
    pct = (z[j] - z[i]) / (ds[j] - ds[i]) * 100
    mx, my = (px[i] + px[j]) / 2, (py[i] + py[j]) / 2
    # 방위: 창 시작→끝. 도엽 좌표계(5187)는 북쪽이 위라 그대로 계산 (자북 보정 없음, 오차 수 도)
    brg = (math.degrees(math.atan2(px[j] - px[i], py[j] - py[i])) + 360) % 360
    lon, lat = warp(dem.crs, "EPSG:4326", [mx], [my])
    return lon[0], lat[0], round(float(pct), 1), round(brg)


def shortest(n, src, tgt, cost, a, b):
    m = csr_matrix((np.concatenate([cost, cost]), (np.concatenate([src, tgt]), np.concatenate([tgt, src]))), shape=(n, n))
    dist, pred = dijkstra(m, directed=True, indices=a, return_predecessors=True)
    if not np.isfinite(dist[b]):
        return None
    path = [b]
    while path[-1] != a:
        path.append(pred[path[-1]])
    return path[::-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--stops", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-detour", action="store_true")
    a = ap.parse_args()
    if len(a.stops) < 2:
        sys.exit("--stops에 출발·도착 두 곳 이상을 주세요")

    segs = load(a.folder, "segments.geojson")
    nodes = load(a.folder, "nodes.geojson")
    places = load(a.folder, "places.geojson")
    dem = Dem(os.path.join(a.folder, "dem.tif"))

    node_ids = np.array([f["properties"]["id"] for f in nodes])
    nlon = np.array([f["geometry"]["coordinates"][0] for f in nodes])
    nlat = np.array([f["geometry"]["coordinates"][1] for f in nodes])
    lat0 = float(nlat.mean())
    tree = cKDTree(local_xy(nlon, nlat, lat0))
    idx_of = {int(v): i for i, v in enumerate(node_ids)}

    P = [s["properties"] for s in segs]
    src = np.array([idx_of[p["source"]] for p in P]); tgt = np.array([idx_of[p["target"]] for p in P])
    length = np.array([p["length_m"] for p in P], dtype=float)
    detour = length * np.array([DETOUR_FACTOR.get(p["dem_estimate"], 2.0) * (UNDERPASS_FACTOR if p["underpass_no_sidewalk"] else 1.0)
                                for p in P])
    edge_of = {}
    for k, p in enumerate(P):
        for key in ((src[k], tgt[k]), (tgt[k], src[k])):
            if key not in edge_of or length[k] < length[edge_of[key]]:
                edge_of[key] = k

    stops = []
    for s in a.stops:
        name, lon, lat = resolve_stop(s, places)
        d, i = tree.query(local_xy([lon], [lat], lat0)[0])
        if d > SNAP_MAX_M:
            sys.exit(f"'{name}'에서 {SNAP_MAX_M:.0f}m 안에 구간망 노드가 없습니다 ({d:.0f}m)")
        stops.append((name, lon, lat, int(i), d))

    def route(cost):
        steps = []   # (구간 index, 정방향 여부)
        for (_, _, _, ia, _), (_, _, _, ib, _) in zip(stops, stops[1:]):
            path = shortest(len(node_ids), src, tgt, cost, ia, ib)
            if path is None:
                return None
            for u, v in zip(path, path[1:]):
                k = edge_of[(u, v)]
                steps.append((k, src[k] == u))
        return steps

    routes = {"A": route(length)}
    if routes["A"] is None:
        sys.exit("출발과 도착이 구간망에서 이어지지 않습니다 (떨어진 조각일 수 있음)")
    if not a.no_detour:
        b = route(detour)
        if b and [k for k, _ in b] != [k for k, _ in routes["A"]]:
            routes["B"] = b

    # 점검표: A 순서대로, B에만 있는 구간은 뒤에 B 순서대로
    member = {}
    for name, steps in routes.items():
        for k, fwd in steps:
            member.setdefault(k, {"routes": "", "fwd": fwd})["routes"] += name
    order = [k for k, _ in routes["A"]] + [k for k, _ in routes.get("B", []) if "A" not in member[k]["routes"]]
    seen, rows, feats = set(), [], []
    for k in order:
        if k in seen:
            continue
        seen.add(k)
        p = P[k]
        coords = segs[k]["geometry"]["coordinates"]
        spot = steepest_spot(dem, coords, member[k]["fwd"])
        mid = coords[len(coords) // 2] if len(coords) > 2 else [(coords[0][0] + coords[-1][0]) / 2, (coords[0][1] + coords[-1][1]) / 2]
        lon, lat = (spot[0], spot[1]) if spot else mid
        items = [CHECK_LABEL.get(c, c) for c in p.get("check_items", [])]
        rows.append({
            "순서": len(rows) + 1, "경로": member[k]["routes"], "구간ID": p["id"], "길이m": p["length_m"],
            "도로구분": p["road_class"], "도로명": p.get("road_name") or "", "인도": "있음" if p["has_sidewalk"] else "없음",
            "DEM최대경사%": p["dem_incline_max_pct"] if p["dem_incline_max_pct"] is not None else "",
            "DEM추정": {"gentle": "완만", "moderate": "측정 필요", "steep": "급경사", "unknown": "판단 불가"}[p["dem_estimate"]],
            "DEM진행경사%": spot[2] if spot else "", "진행방위": spot[3] if spot else "",
            "점검항목": " / ".join(items),
            "측정위도": round(lat, 7), "측정경도": round(lon, 7),
            "카카오지도": f"https://map.kakao.com/link/map/S{p['id']},{lat:.7f},{lon:.7f}",
            "로드뷰": f"https://map.kakao.com/link/roadview/{lat:.7f},{lon:.7f}",
            **{c: "" for c in GRADE_INPUTS},
        })
        feats.append({"type": "Feature", "geometry": segs[k]["geometry"],
                      "properties": {"order": len(rows), "routes": member[k]["routes"], "id": p["id"],
                                     "dem_estimate": p["dem_estimate"], "dem_incline_max_pct": p["dem_incline_max_pct"],
                                     "stroke": {"A": "#d62728", "B": "#1f77b4", "AB": "#9467bd"}[member[k]["routes"]]}})
        if spot:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 7), round(lat, 7)]},
                          "properties": {"order": len(rows), "id": p["id"], "dem_dir_pct": spot[2], "heading": spot[3],
                                         "marker-size": "small"}})
    for name, lon, lat, _, d in stops:
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"stop": name, "snap_m": round(float(d), 1), "marker-color": "#000000"}})

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "sheet.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    with open(os.path.join(a.out, "routes.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)

    lines = [f"경로: {' → '.join(s[0] for s in stops)}",
             "출발·도착을 붙인 노드까지 거리: " + ", ".join(f"{s[0]} {s[4]:.0f}m" for s in stops)]
    for name, steps in routes.items():
        ks = [k for k, _ in steps]
        est = {}
        for k in ks:
            est[P[k]["dem_estimate"]] = est.get(P[k]["dem_estimate"], 0) + length[k]
        desc = ", ".join(f"{lbl} {est.get(e, 0):.0f}m" for e, lbl in
                         (("gentle", "완만"), ("moderate", "측정 필요"), ("steep", "급경사"), ("unknown", "판단 불가")))
        lines.append(f"경로 {name}: {length[ks].sum():.0f}m, 구간 {len(ks)}개 ({desc})")
    if "B" not in routes and not a.no_detour:
        lines.append("우회 경로 B: A와 같음 (DEM 기준으로 피할 급경사가 없거나 다른 길이 없음)")
    lines.append(f"점검표 {len(rows)}행 (A·B 겹치는 구간은 한 번만)")
    lines.append("현장에서: 행마다 '측정위도·측정경도'(DEM이 가장 가파르다고 본 곳)를 중심으로 구간에서 가장 가파른 곳을 찾아 잰다.")
    lines.append("경사%는 '진행방위' 쪽을 보고 오르막 +, 내리막 −. 'DEM진행경사%'와 부호가 반대면 한 번 더 확인한다.")
    with open(os.path.join(a.out, "summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
