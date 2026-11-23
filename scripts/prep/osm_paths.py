"""OSM 길로 수치지도 도로 중심선에 없는 보행로·단지/주차장 길·골목·계단을 보완한다.

수치지도 중심선은 시청 같은 단지 안 길, 공영주차장 통로, 건물 사이 좁은 길을 그리지 않고, 도로 면에도 없다 (11/20 확인).
OSM에는 그중 일부(진입로·보행로·계단)가 있다. 우리 길과 OVERLAP_M 안에서 겹치는 부분은 버리고 나머지만 쓴다.
남은 조각의 끝은 가까운 우리 길(LINK_M 안)에 직선으로 잇는다.

라이선스: OSM은 ODbL. 합친 보행 구간망 파일은 ODbL 파생물이 되므로 '© OpenStreetMap contributors' 표기.
우리가 수집한 장애물(DB obstacles)과는 섞지 않는다 (HANDOFF 3절). DB segments에는 OSM 구간을 넣지 않는다 (load_db.py가 건너뜀).
"""
import json

from rasterio.warp import transform as warp
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree

OVERLAP_M = 5.0   # 우리 길에서 이 거리 안의 OSM 부분은 중복으로 보고 버린다 (보행로·단지 길·계단)
OVERLAP_ROAD_M = 10.0  # OSM 골목(residential 등)은 같은 도로가 몇 m 어긋나 그려진 경우가 많아 더 넓게
MIN_PIECE_M = 8.0
LINK_M = 8.0      # 남은 조각 끝 → 우리 길 연결 거리
KIND = {  # OSM highway → (kind, road_class)
    "steps": ("osm_steps", "OSM 계단"),
    "footway": ("osm_path", "OSM 보행로"), "path": ("osm_path", "OSM 보행로"), "pedestrian": ("osm_path", "OSM 보행로"),
    "corridor": ("osm_path", "OSM 보행로"), "cycleway": ("osm_path", "OSM 보행로"),
    "service": ("osm_path", "OSM 단지·주차장 길"),
    "living_street": ("osm_path", "OSM 골목"), "residential": ("osm_path", "OSM 골목"), "unclassified": ("osm_path", "OSM 골목"),
}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "dirt", "ground", "earth", "grass", "sand", "mud", "pebblestone", "compacted"}


def osm_lines(path, area, existing, crs="EPSG:5187"):
    """path: fetch_osm.py 결과. area: 자를 범위(5187). existing: 우리 중심선 목록(5187).
    돌려줌: ([(선, 속성)], 통계)"""
    d = json.load(open(path, encoding="utf-8"))
    near = unary_union([ln.buffer(OVERLAP_M, cap_style="flat") for ln in existing])
    near_road = unary_union([ln.buffer(OVERLAP_ROAD_M, cap_style="flat") for ln in existing])
    T_ex = STRtree(existing)
    out, stats = [], {"ways": 0, "kept_m": 0.0, "links": 0, "steps": 0, "skipped_private": 0}
    for w in d.get("elements", []):
        t = w.get("tags", {})
        hw = t.get("highway")
        if hw not in KIND or len(w.get("geometry", [])) < 2:
            continue
        if t.get("access") in ("private", "no") or t.get("foot") in ("no", "private"):
            stats["skipped_private"] += 1
            continue
        xs, ys = warp("EPSG:4326", crs, [p["lon"] for p in w["geometry"]], [p["lat"] for p in w["geometry"]])
        ln = LineString(zip(xs, ys))
        if not ln.intersects(area):
            continue
        is_road = KIND[hw][1] == "OSM 골목"
        rest = ln.difference(near_road if is_road else near)
        pieces = [p for p in getattr(rest, "geoms", [rest]) if p.geom_type == "LineString" and p.length >= (MIN_PIECE_M * 2 if is_road else MIN_PIECE_M)]
        if not pieces:
            continue
        stats["ways"] += 1
        kind, cls = KIND[hw]
        attrs = dict(kind=kind, road_class=cls, road_width_m=None, lanes=None,
                     paved=t.get("surface") not in UNPAVED, road_name=t.get("name") or None,
                     osm_id=w.get("id"), osm_wheelchair=t.get("wheelchair"))
        for p in pieces:
            coords = list(p.coords)
            # 잘린 끝(원래 OSM 선의 끝이 아닌 곳)과 원래 끝 모두, 우리 길 LINK_M 안이면 가장 가까운 점으로 잇는다
            for end in (0, -1):
                pe = Point(coords[end])
                cand = T_ex.query(pe, predicate="dwithin", distance=LINK_M + (OVERLAP_ROAD_M - OVERLAP_M if is_road else 0))
                if len(cand):
                    j = min(cand, key=lambda k: existing[k].distance(pe))
                    q = existing[j].interpolate(existing[j].project(pe))
                    if q.distance(pe) > 0.3:
                        if end == 0:
                            coords.insert(0, (q.x, q.y))
                        else:
                            coords.append((q.x, q.y))
                        stats["links"] += 1
            out.append((LineString(coords), attrs))
            stats["kept_m"] += p.length
            stats["steps"] += kind == "osm_steps"
    stats["kept_km"] = round(stats.pop("kept_m") / 1000, 1)
    return out, stats
