"""동해시 전체(또는 시연 지역)의 보행 구간망과 속성을 만든다 (DB 적재 전 단계).

사용법:
    python -I donghae_pipeline.py <도엽 폴더(extract_sheets 결과)> <횡단보도 CSV> <출력 폴더>
        [--demo | --bbox X0 Y0 X1 Y1] [--res 5] [--workers 6]
    범위: 기본은 행정경계(N3A_G0010000)의 '동해시' 전체. --demo는 시연 지역 상자만.
    추가 입력: 행정경계, 육교 N3A_A0063321(장애인 이용 여부), 입체교차부 N3A_A0090000, 터널 N3A_A0110020, 철도역 N3P_A0131122

입력 (국토지리정보원 수치지도 2.0, 1:5,000, EPSG:5187):
    도로 중심선 N3L_A0020000, 자전거보행자겸용도로 N3L_A0033330('보행' 포함만), 인도 N3A_A0033320,
    교량 N3A_A0070000, 계단 N3A_C0390000, 옹벽 N3L_F0040000, 절토 N3L_F0030000,
    등고선 N3L_F0010000, 표고점 N3P_F0020000, 삼각점 N3P_H0020000, 산 정상 N3P_H0059153, 건물 N3A_B0010000
    전국횡단보도표준데이터 CSV (CP949)

출력 (<출력 폴더>):
    dem.tif, slope_pct.tif       5m DEM (장력 스플라인)과 최대 경사
    nodes.geojson                교차점·끝점 (WGS84), 횡단보도·턱낮춤 집계 포함
    segments.geojson             보행 구간 (≤100m, WGS84), DEM 경사·인도·계단·교량·옹벽·점검 항목 포함
    crosswalks.geojson           횡단보도 원자료 (가장 가까운 노드 연결)
    places.geojson               주요 기관 (핵심 동선 출발·도착 후보)
    checklist.csv                구간별 현장 점검표 (카카오맵 링크 포함)
    report.txt                   요약
"""
import argparse
import csv
import io
import json
import math
import os
import sys
import warnings
from collections import Counter, defaultdict

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")  # DEM 조각을 여러 프로세스로 풀 때 스레드가 겹치지 않게

import numpy as np
import rasterio
import shapefile
from rasterio.transform import from_origin
from rasterio.warp import transform as warp
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import Delaunay, cKDTree
import shapely
from shapely.geometry import LineString, Point, shape, box
from shapely.ops import unary_union, substring, linemerge
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_dem import spline_grid, densify  # noqa: E402

warnings.simplefilter("ignore")
ENC = "cp949"
CRS = "EPSG:5187"
CITY = "동해시"
DEMO_BBOX = (208300.0, 545600.0, 210900.0, 548600.0)  # 시연 지역: 터미널·청소년센터·시청·병원·보건소 포함
MAX_SEG = 100.0
SNAP_M = 3.0          # 이 거리 안에서 끝난 외톨이 끝점은 옆 선에 잇는다
MIN_COMPONENT = 20    # 이보다 작은 떨어진 조각은 뺀다
SLOPE_WINDOW_M = 30.0 # 최대 경사 창. DEM 높이 오차(약 2m)를 생각하면 10m 창은 잡음이 너무 크다
EXTEND_MAX_TURN_DEG = 45.0  # 짧은 구간 경사를 잴 때 단면을 이웃 구간으로 늘리는 최대 꺾임 (곧게 이어지는 같은 길만)
# 옹벽·절토 보정: 등고선 보간이 수직 단차를 비탈로 펴서, 옆을 지나는 길의 DEM 경사가 부풀려진다.
# 동해 시연 지역 길 위 표본(2.5m 간격 39,185점)에서 진행 방향 경사 중앙값이 옹벽·절토 10m 안 4.4~6.8%,
# 그 밖 3.3~4.5% → 10m 안 표본은 버리고 남은 표본 사이를 직선으로 잇는다 (길 경사는 매끄럽다고 본다).
WALL_MASK_M = 10.0
WALL_MIN_KEPT = 0.5   # 남은 표본이 구간 길이의 이 비율에 못 미치고 보정 전 경사가 MODERATE_MIN 이상이면 DEM 경사를 비운다 (→ 현장 측정)
WALL_CROSS_DEG = 45.0 # 구간이 옹벽·절토 선을 이 각도 이상으로 가로지르면 계단·단차 후보
# 길 위 표고: DEM 면 대신 '길 위에서 확인되는 높이'만으로 도로망 높이를 푼다 (road_profile).
#   관측 = 등고선이 도로 중심선을 가로지르는 점(그 자리 도로 높이 = 등고수치) + 도로 3m 안 표고점·기준점.
#   교량·터널·지하차도 위의 관측은 아래 땅 높이이므로 버린다. 옹벽 위 주차장 같은 길 밖 높이는 들어가지 않는다.
ROAD_OBS_SNAP_M = 3.0   # 표고점이 도로 중심선에서 이 거리 안이면 길 위 관측
SIDEWALK_NEAR_M = 12.0  # 관측 구역의 최대 반폭 (has_sidewalk 기준과 같음)
ZONE_SIDEWALK_M = 4.0   # 관측 구역 반폭 = 도로폭/2 + 이 값 (인도 몫). 3m 이상, SIDEWALK_NEAR_M 이하
ROAD_OBS_W = 10.0       # 관측을 지키는 강도
ROAD_DEM_W = 1e-4       # DEM을 참고하는 강도 (관측이 수백 m 없을 때만 의미가 있을 만큼 약하게)
# 무장애 경로 추천 기준(③ 시간 계산, ④ 긴 경사 벌점)용: 진행 방향(source → target) 경사별 길이와 5.6% 이상 연속 구간
GRADE_EDGES = (-8.3, -5.6, -4.0, -2.0, 2.0, 4.0, 5.6, 8.3)   # 9칸: ≤-8.3 | -8.3~-5.6 | … | -2~2 | … | 5.6~8.3 | >8.3 (부호: + 오르막)
RUN_MIN_PCT = 5.6       # 이 경사 이상이 이어지는 길이 (BF 최우수 1/18)
RUN_KEEP_M = 9.0        # 이보다 짧은 연속은 기록하지 않는다 (쉬는 자리 기준 약 9m)
ROAD_MAX_GAP_M = 150.0  # 구간에서 가장 가까운 관측까지(길 따라) 이보다 멀면 길 위 표고를 쓰지 않고 DEM을 쓴다
SLOPE_DISAGREE_PP = 4.0 # DEM과 길 위 표고의 최대 경사가 이만큼(%p) 다르면 점검 항목. 관측 사이를 직선으로 이어
                        # 짧은 급경사를 펼 수 있으므로, 길 위 표고가 더 완만해도 '완만'으로 단정하지 않고 측정을 앞세운다
DEM_MARGIN = 250.0    # DEM 도엽 조각마다 이웃 도엽 자료를 이만큼 더 써서 이음매를 없앤다
EXCLUDED_ROADS = {"고속국도"}  # 보행자 통행 금지 (도로구분)
# 속성 '자동차전용'이 '자동차전용'인 도로도 보행자 통행 금지 → 뺀다
# 주요 기관: 건물 '주기'(이름)를 쉼표로 나눈 조각마다 규칙을 맞춘다. 동해시 경계 밖은 뺀다.
PLACE_RULES = [  # (분류, 포함 정규식, 제외 정규식)
    ("transport", r"버스터미널|여객선터미널", None),
    ("public", r"^동해시청$|행정복지센터$|교육지원청$|^동해시청소년센터$|국민건강보험|세무서.*민원실|법원", None),
    ("health", r"보건소$|보건진료소$|보건지소$|병원$", r"동물병원|자동차병원"),
    ("welfare", r"복지관$|장애인", r"장학회|^복지관$"),
    ("safety", r"경찰서$|지구대$|파출소$|소방서$|119안전센터$", r"자율방범대"),
    ("library", r"도서관$", r"작은도서관|장난감도서관|고교|중교|캠퍼스"),
    ("culture", r"문화예술회관$|^동해문화원$|^동해체육관$", None),
    ("market", r"시장$", r"가축시장|전시장|화장실|광장"),
    ("post", r"우체국$", None),
]
PLACE_ALIAS = {"동해동인병원": "동인병원"}
FREIGHT_STATIONS = {"묵호항역", "삼화역"}  # 화물역


# ───────────────────────── 읽기 ─────────────────────────
def sheet_bounds(root):
    """{도엽 폴더: 도엽 경계 도형}"""
    out = {}
    for s in sorted(os.listdir(root)):
        p = os.path.join(root, s, "N3A_H0010000.shp")
        if os.path.exists(p):
            out[os.path.join(root, s)] = unary_union([shape(x.__geo_interface__) for x in shapefile.Reader(p, encoding=ENC).shapes()])
    return out


def sheets_in(bounds, area, margin):
    q = area.buffer(margin) if margin else area
    return [f for f, g in bounds.items() if g.intersects(q)]


def city_polygon(bounds, name=CITY):
    parts = [g for g, a in read(list(bounds), "N3A_G0010000") if a.get("명칭") == name]
    if not parts:
        raise SystemExit(f"행정경계에서 '{name}'을 찾지 못했습니다")
    poly = unary_union(parts).buffer(1).buffer(-1)   # 도엽 이음매의 틈 메우기
    return poly


def read(folders, name, clip=None):
    """(geometry, attrs) 목록. clip이 있으면 겹치는 것만."""
    if clip is not None:
        shapely.prepare(clip)
    out = []
    for f in folders:
        p = os.path.join(f, name + ".shp")
        if not os.path.exists(p):
            continue
        r = shapefile.Reader(p, encoding=ENC)
        names = [x[0] for x in r.fields[1:]]
        for sr in r.iterShapeRecords():
            gi = sr.shape.__geo_interface__
            if not gi or not gi.get("coordinates"):
                continue
            g = shape(gi)
            if g.is_empty or (clip is not None and not g.intersects(clip)):
                continue
            out.append((g, dict(zip(names, sr.record))))
    return out


def num(v, default=None):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


# ───────────────────────── DEM ─────────────────────────
def _dem_points(folders, clip):
    pts = []
    for g, a in read(folders, "N3L_F0010000", clip):
        h = num(a.get("등고수치"))
        if h is None:
            continue
        for line in getattr(g, "geoms", [g]):
            for x, y in densify(list(line.coords), 2.5):
                pts.append((x, y, h))
    n_contour = len(pts)
    for name, col in (("N3P_F0020000", "수치"), ("N3P_H0020000", "표고"), ("N3P_H0059153", "높이")):
        for g, a in read(folders, name, clip):
            v = num(a.get(col))
            if v is not None:
                pts.append((g.x, g.y, v))
    if not pts:
        return None, None, 0, 0
    arr = np.array(pts)
    x0, y0, x1, y1 = clip.bounds
    arr = arr[(arr[:, 0] >= x0) & (arr[:, 0] <= x1) & (arr[:, 1] >= y0) & (arr[:, 1] <= y1)]
    if len(arr) < 10:
        return None, None, 0, 0
    key = np.round(arr[:, :2], 2)
    _, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    z = np.bincount(inv, weights=arr[:, 2]) / np.bincount(inv)
    return arr[idx, :2], z, n_contour, len(pts) - n_contour


def _dem_tile(job):
    """도엽 하나의 DEM 조각 (이웃 도엽 자료를 DEM_MARGIN만큼 더 씀). 다중 프로세스용."""
    folders, tx0, ty1, tW, tH, res, crop = job
    clip = box(tx0, ty1 - tH * res, tx0 + tW * res, ty1)
    xy, z, nc, ns = _dem_points(folders, clip)
    if xy is None:
        return crop, None, 0, 0
    g, _ = spline_grid(xy, z, tx0, ty1, tW, tH, res, 0.25)
    gx = tx0 + (np.arange(tW) + 0.5) * res; gy = ty1 - (np.arange(tH) + 0.5) * res
    GX, GY = np.meshgrid(gx, gy)
    hull = ~np.isnan(LinearNDInterpolator(Delaunay(xy), z)(GX, GY))
    g = np.where(hull, g, np.nan).astype(np.float32)
    r0, r1, c0, c1 = crop[4:]
    return crop, g[r0:r1, c0:c1], nc, ns


def build_dem_tiled(bounds, area, res, out, workers):
    """시 전체 DEM: 도엽마다 따로 풀고(이웃 자료 250m 포함) 한 격자로 잇는다. 한 번에 풀면 메모리가 모자란다."""
    from concurrent.futures import ProcessPoolExecutor
    ax0, ay0, ax1, ay1 = area.buffer(300).bounds
    gx0 = math.floor(ax0 / res) * res; gy1 = math.ceil(ay1 / res) * res
    W = int(math.ceil((ax1 - gx0) / res)); H = int(math.ceil((gy1 - ay0) / res))
    mpx = int(DEM_MARGIN / res)
    jobs = []
    for f in sheets_in(bounds, area, 300):
        sx0, sy0, sx1, sy1 = bounds[f].bounds
        c0 = max(0, int(math.floor((sx0 - gx0) / res))); c1 = min(W, int(math.ceil((sx1 - gx0) / res)))
        r0 = max(0, int(math.floor((gy1 - sy1) / res))); r1 = min(H, int(math.ceil((gy1 - sy0) / res)))
        if c1 <= c0 or r1 <= r0:
            continue
        tc0, tr0 = c0 - mpx, r0 - mpx
        tW, tH = (c1 - c0) + 2 * mpx, (r1 - r0) + 2 * mpx
        tx0, ty1 = gx0 + tc0 * res, gy1 - tr0 * res
        tile_box = box(tx0, ty1 - tH * res, tx0 + tW * res, ty1)
        near = [g for g, b in bounds.items() if b.intersects(tile_box)]
        jobs.append((near, tx0, ty1, tW, tH, res, (r0, r1, c0, c1, mpx, mpx + (r1 - r0), mpx, mpx + (c1 - c0))))
    dem = np.full((H, W), np.nan, dtype=np.float32)
    n_contour = n_spot = 0
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for k, (crop, tile, nc, ns) in enumerate(ex.map(_dem_tile, jobs), 1):
            if tile is not None:
                r0, r1, c0, c1 = crop[:4]
                cur = dem[r0:r1, c0:c1]
                dem[r0:r1, c0:c1] = np.where(np.isnan(tile), cur, tile)
                n_contour += nc; n_spot += ns
            print(f"  DEM 조각 {k}/{len(jobs)}", end="\r", flush=True)
    print()
    sy, sx = np.gradient(dem, res)
    slope = (np.hypot(sx, sy) * 100).astype(np.float32)
    T = from_origin(gx0, gy1, res, res)
    prof = dict(driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=CRS, transform=T, nodata=-9999.0,
                compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    for fn, a in (("dem.tif", dem), ("slope_pct.tif", slope)):
        with rasterio.open(os.path.join(out, fn), "w", **prof) as ds:
            ds.write(np.where(np.isnan(a), -9999.0, a).astype(np.float32), 1)
    info = dict(contour_pts=n_contour, spot_pts=n_spot, grid=f"{W}x{H}", tiles=len(jobs),
                zmin=float(np.nanmin(dem)), zmax=float(np.nanmax(dem)))

    def sample(xs, ys):
        fc = (np.asarray(xs) - gx0) / res - 0.5; fr = (gy1 - np.asarray(ys)) / res - 0.5
        c0 = np.clip(np.floor(fc).astype(int), 0, W - 2); r0 = np.clip(np.floor(fr).astype(int), 0, H - 2)
        tc = np.clip(fc - c0, 0, 1); tr = np.clip(fr - r0, 0, 1)
        return (dem[r0, c0] * (1 - tc) * (1 - tr) + dem[r0, c0 + 1] * tc * (1 - tr)
                + dem[r0 + 1, c0] * (1 - tc) * tr + dem[r0 + 1, c0 + 1] * tc * tr)
    return sample, info


def build_dem(folders, bbox, res, out):
    """작은 범위용 (한 번에 풀기). 시 전체는 build_dem_tiled."""
    m = 250.0
    clip = box(bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m)
    pts = []
    for g, a in read(folders, "N3L_F0010000", clip):
        h = num(a.get("등고수치"))
        if h is None:
            continue
        for line in getattr(g, "geoms", [g]):
            for x, y in densify(list(line.coords), 2.5):
                if clip.contains(Point(x, y)):
                    pts.append((x, y, h))
    n_contour = len(pts)
    for name, col in (("N3P_F0020000", "수치"), ("N3P_H0020000", "표고"), ("N3P_H0059153", "높이")):
        for g, a in read(folders, name, clip):
            v = num(a.get(col))
            if v is not None:
                pts.append((g.x, g.y, v))
    arr = np.array(pts)
    key = np.round(arr[:, :2], 2)
    _, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    z = np.bincount(inv, weights=arr[:, 2]) / np.bincount(inv)
    xy = arr[idx, :2]
    x0, y0, x1, y1 = clip.bounds
    W = int(math.ceil((x1 - x0) / res)); H = int(math.ceil((y1 - y0) / res))
    g, _ = spline_grid(xy, z, x0, y1, W, H, res, 0.25)
    gx = x0 + (np.arange(W) + 0.5) * res; gy = y1 - (np.arange(H) + 0.5) * res
    GX, GY = np.meshgrid(gx, gy)
    hull = ~np.isnan(LinearNDInterpolator(Delaunay(xy), z)(GX, GY))
    dem = np.where(hull, g, np.nan).astype(np.float32)
    sy, sx = np.gradient(dem, res)
    slope = (np.hypot(sx, sy) * 100).astype(np.float32)
    T = from_origin(x0, y1, res, res)
    prof = dict(driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=CRS, transform=T, nodata=-9999.0, compress="deflate")
    for fn, a in (("dem.tif", dem), ("slope_pct.tif", slope)):
        with rasterio.open(os.path.join(out, fn), "w", **prof) as ds:
            ds.write(np.where(np.isnan(a), -9999.0, a).astype(np.float32), 1)
    info = dict(contour_pts=n_contour, spot_pts=len(pts) - n_contour, grid=f"{W}x{H}", zmin=float(np.nanmin(dem)), zmax=float(np.nanmax(dem)))

    def sample(xs, ys):
        fc = (np.asarray(xs) - x0) / res - 0.5; fr = (y1 - np.asarray(ys)) / res - 0.5
        c0 = np.clip(np.floor(fc).astype(int), 0, W - 2); r0 = np.clip(np.floor(fr).astype(int), 0, H - 2)
        tc = np.clip(fc - c0, 0, 1); tr = np.clip(fr - r0, 0, 1)
        return (dem[r0, c0] * (1 - tc) * (1 - tr) + dem[r0, c0 + 1] * tc * (1 - tr)
                + dem[r0 + 1, c0] * (1 - tc) * tr + dem[r0 + 1, c0 + 1] * tc * tr)
    return sample, info


# ───────────────────────── 구간망 ─────────────────────────
def build_network(folders, area, osm_path=None):
    """area: 자를 범위 (시 경계 폴리곤 또는 상자)"""
    lines, attrs = [], []
    n_excluded = n_car_only = 0
    for g, a in read(folders, "N3L_A0020000", area):
        if a.get("도로구분") in EXCLUDED_ROADS:
            n_excluded += 1
            continue
        if str(a.get("자동차전용", "")).strip() == "자동차전용":
            n_car_only += 1
            continue
        for part in getattr(g, "geoms", [g]):
            lines.append(part); attrs.append(dict(kind="road", road_class=a.get("도로구분") or None,
                                                  road_width_m=num(a.get("도로폭")), lanes=int(num(a.get("차로수"), 0) or 0) or None,
                                                  paved=(a.get("포장재질") != "비포장"), road_name=a.get("명칭") or None))
    for g, a in read(folders, "N3L_A0033330", area):
        if "보행" not in str(a.get("구분", "")):
            continue  # 자전거전용도로는 보행 구간이 아님
        for part in getattr(g, "geoms", [g]):
            lines.append(part); attrs.append(dict(kind="ped_bike", road_class=a.get("구분"), road_width_m=num(a.get("폭")), lanes=None, paved=True, road_name=None))
    n_osm = {}
    if osm_path:   # OSM으로 중심선에 없는 보행로·단지/주차장 길·골목·계단 보완 (osm_paths.py)
        from osm_paths import osm_lines
        extra, n_osm = osm_lines(osm_path, area, list(lines))
        for ln, a in extra:
            lines.append(ln); attrs.append(a)
    # 범위로 자르기 (완전히 안에 있는 선은 그대로, 경계에 걸친 선만 자른다)
    shapely.prepare(area)
    arr = np.array(lines, dtype=object)
    inside = shapely.contains(area, arr)
    cut = shapely.intersection(arr[~inside], area) if (~inside).any() else []
    cut_iter = iter(cut)
    clipped = []
    for ln, a, ins in zip(lines, attrs, inside):
        c = ln if ins else next(cut_iter)
        for part in getattr(c, "geoms", [c]):
            if isinstance(part, LineString) and part.length > 0.5:
                clipped.append((part, a))
    # 끊긴 끝점 잇기: 수치지형도 중심선은 교차점 몇 cm~m 앞에서 끝나는 경우가 있다.
    # 다른 선에서 SNAP_M 안에 끝나는 '외톨이 끝점'은 그 선의 가장 가까운 점까지 늘인다.
    geoms = [c[0] for c in clipped]
    gtree = STRtree(geoms)
    ends = defaultdict(int)
    for g in geoms:
        for e in (g.coords[0], g.coords[-1]):
            ends[(round(e[0], 1), round(e[1], 1))] += 1
    fixed, n_snap = [], 0
    for i, (g, a) in enumerate(clipped):
        cs = list(g.coords)
        for pos in (0, -1):
            e = cs[pos]
            if ends[(round(e[0], 1), round(e[1], 1))] > 1:
                continue
            pe = Point(e)
            near_ids = [j for j in gtree.query(pe, predicate="dwithin", distance=SNAP_M) if j != i]
            if not near_ids:
                continue
            j = min(near_ids, key=lambda k: geoms[k].distance(pe))
            if geoms[j].distance(pe) < 0.01:
                continue
            q = geoms[j].interpolate(geoms[j].project(pe))
            if pos == 0:
                cs.insert(0, (q.x, q.y))
            else:
                cs.append((q.x, q.y))
            n_snap += 1
        fixed.append((LineString(cs), a))
    clipped = fixed
    # 교차점에서 쪼개기 (노딩, 1cm 격자로 안정적으로). 입체교차도 교차로 처리되는 한계 → 교량 표시로 보완
    noded = shapely.union_all([c[0] for c in clipped], grid_size=0.01)
    pieces = list(getattr(noded, "geoms", [noded]))
    tree = STRtree([c[0] for c in clipped])
    segs = []
    for pc in pieces:
        if pc.length < 0.5:
            continue
        mid = pc.interpolate(0.5, normalized=True)
        cand = tree.query(mid.buffer(0.1))
        best = min(cand, key=lambda i: clipped[i][0].distance(mid)) if len(cand) else None
        a = clipped[best][1] if best is not None else dict(kind="road")
        n = max(1, int(math.ceil(pc.length / MAX_SEG)))
        for k in range(n):
            sub = substring(pc, pc.length * k / n, pc.length * (k + 1) / n)
            if sub.length >= 0.5:
                segs.append((sub, a))
    # 연결 요소: 큰 망에서 떨어진 작은 조각(MIN_COMPONENT 구간 미만)은 길 안내에 쓸 수 없어 뺀다
    key = lambda xy: (round(xy[0], 2), round(xy[1], 2))
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for sub, _ in segs:
        cs = sub.coords
        ra, rb = find(key(cs[0])), find(key(cs[-1]))
        if ra != rb:
            parent[ra] = rb
    size = defaultdict(int)
    for sub, _ in segs:
        size[find(key(sub.coords[0]))] += 1
    keep = [(s, a) for s, a in segs if size[find(key(s.coords[0]))] >= MIN_COMPONENT]
    stats = dict(osm=n_osm, snapped_ends=n_snap, excluded_roads=n_excluded, excluded_car_only=n_car_only, dropped_segments=len(segs) - len(keep),
                 dropped_components=sum(1 for v in size.values() if v < MIN_COMPONENT), components=sum(1 for v in size.values() if v >= MIN_COMPONENT))
    # 노드
    node_id, nodes = {}, []

    def nid(xy):
        k = key(xy)
        if k not in node_id:
            node_id[k] = len(nodes) + 1
            nodes.append(k)
        return node_id[k]
    out = []
    for sub, a in keep:
        cs = list(sub.coords)
        out.append(dict(geom=sub, source=nid(cs[0]), target=nid(cs[-1]), **a))
    return out, nodes, stats


# ───────────────────────── 속성 ─────────────────────────
def attach_attributes(segs, folders, area, dem_sample):
    area = area.buffer(50)
    walk = read(folders, "N3A_A0033320", area)            # 인도
    bridges = read(folders, "N3A_A0070000", area)
    stairs = read(folders, "N3A_C0390000", area)
    walls = read(folders, "N3L_F0040000", area)
    cuts = read(folders, "N3L_F0030000", area)
    tunnels = read(folders, "N3A_A0110020", area)
    underpasses = [(g, a) for g, a in read(folders, "N3A_A0090000", area) if a.get("구분") == "지하차도"]
    overpasses = read(folders, "N3A_A0063321", area)      # 육교: 형태 '장애인이용여부(가능|불가)'

    def mk(items):
        return (STRtree([g for g, _ in items]), items) if items else (None, [])
    T_walk, T_br, T_st, T_wall, T_cut = mk(walk), mk(bridges), mk(stairs), mk(walls), mk(cuts)
    T_tun, T_und, T_ovp = mk(tunnels), mk(underpasses), mk(overpasses)

    def inside_frac(tr, g):
        """구간 길이 중 면 안에 든 비율과 그 면들의 속성"""
        hits = near(tr, g, 0)
        if not hits:
            return 0.0, []
        return unary_union([h[0] for h in hits]).intersection(g).length / g.length, [h[1] for h in hits]

    def near(tr, geom, d):
        t, items = tr
        if t is None:
            return []
        return [items[i] for i in t.query(geom, predicate="dwithin", distance=d)]

    for s in segs:
        g = s["geom"]; L = g.length
        s["length_m"] = round(L, 2)
        # DEM 단면 (2.5m 간격)
        ds = np.linspace(0, L, max(2, int(L // 2.5) + 1))
        pts = [g.interpolate(d) for d in ds]
        zs = dem_sample([p.x for p in pts], [p.y for p in pts])
        walls_near = near(T_wall, g, WALL_MASK_M) + near(T_cut, g, WALL_MASK_M)
        s["wall_crossing"] = any(crosses_wall(w[0], g) for w in walls_near)
        if np.isnan(zs).any():
            s.update(dem_incline_pct=None, dem_incline_max_pct=None, dem_incline_raw_max_pct=None,
                     incline_up_max_pct=None, incline_down_max_pct=None, incline_hist=None, incline_runs=None,
                     dem_wall_masked_frac=None, z_start=None, z_end=None)
        else:
            s["z_start"], s["z_end"] = round(float(zs[0]), 2), round(float(zs[-1]), 2)
            _, raw_mx = profile_incline(ds, zs)
            s["dem_incline_raw_max_pct"] = round(float(raw_mx), 2)     # 보정 전 (비교용)
            keep = np.ones(len(ds), dtype=bool)
            if walls_near:
                keep = shapely.distance(unary_union([w[0] for w in walls_near]), np.array(pts, dtype=object)) > WALL_MASK_M
            s["dem_wall_masked_frac"] = round(float(1 - keep.mean()), 2)
            span = ds[keep].max() - ds[keep].min() if keep.sum() >= 2 else 0.0
            up = down = None
            use = None
            if keep.all():
                avg, mx = profile_incline(ds, zs); up, down = profile_updown(ds, zs); use = keep
            elif span >= WALL_MIN_KEPT * L and span > 0:
                avg, mx = profile_incline(ds, zs, keep); up, down = profile_updown(ds, zs, keep); use = keep
            elif raw_mx < MODERATE_MIN:
                avg, mx = profile_incline(ds, zs); up, down = profile_updown(ds, zs); use = np.ones(len(ds), dtype=bool)  # 옹벽은 경사를 부풀리기만 하므로, 그래도 완만하면 완만으로 본다
            else:
                avg = mx = None                                      # 옹벽·절토에 가려 급경사인지 알 수 없음 → 현장 측정
            s["dem_incline_pct"] = None if avg is None else round(float(avg), 2)   # source → target 방향, 부호 있음
            s["dem_incline_max_pct"] = None if mx is None else round(float(mx), 2)
            s["incline_up_max_pct"] = None if up is None else round(float(up), 2)       # source → target 방향 오르막 최대
            s["incline_down_max_pct"] = None if down is None else round(float(down), 2) # source → target 방향 내리막 최대
            s["incline_hist"], s["incline_runs"] = profile_detail(ds, zs, use) if use is not None else (None, None)
        # 인도: 구간 표본점의 절반 이상이 인도 면에서 12m 안이면 '인도 있음'
        cand = near(T_walk, g, 12)
        if cand:
            wg = unary_union([c[0] for c in cand])
            frac = float(np.mean([wg.distance(p) <= 12 for p in pts]))
            widths = [num(c[1].get("폭")) for c in cand if num(c[1].get("폭"))]
            s["has_sidewalk"] = frac >= 0.5
            s["sidewalk_width_m"] = max(widths) if widths and frac >= 0.5 else None
            mats = [c[1].get("재질") for c in cand if c[1].get("재질")]
            s["sidewalk_surface"] = max(set(mats), key=mats.count) if mats and frac >= 0.5 else None
        else:
            s["has_sidewalk"], s["sidewalk_width_m"], s["sidewalk_surface"] = False, None, None
        s["on_bridge"] = any(on_bridge(c[0], g) for c in near(T_br, g, 0))
        s["near_stairs"] = bool(near(T_st, g, 8))
        s["near_wall"] = bool(near(T_wall, g, 6))
        s["near_cut"] = bool(near(T_cut, g, 6))
        # 터널·지하차도: 구간의 절반 이상이 안에 있으면
        s["in_tunnel"] = inside_frac(T_tun, g)[0] >= 0.5
        f_und, a_und = inside_frac(T_und, g)
        s["in_underpass"] = f_und >= 0.5
        s["underpass_no_sidewalk"] = f_und >= 0.5 and any(x.get("보도") == "무" for x in a_und)
        # 육교: 보행 구간망에 육교 자체는 없고 아래 도로가 겹친다 → '이곳 길 건너기는 육교' 표시로 쓴다
        ovs = near(T_ovp, g, 0)
        forms = [str(o[1].get("형태", "")) for o in ovs]
        s["overpass_nearby"] = ("inaccessible" if any("불가" in x for x in forms)
                                else "accessible" if any("가능" in x for x in forms) else None)


def road_profile(segs, nodes, folders, area, dem_sample):
    """길 위 관측만으로 도로망 높이를 풀고, 관측이 가까운 구간의 경사를 그것으로 바꾼다.

    꼭짓점 = 노드 + 구간 안의 관측점. 구간을 따라 이웃한 꼭짓점끼리 (높이차)²/거리 를 최소로(길은 매끄럽다),
    관측점은 관측값에 강하게(ROAD_OBS_W), 모든 꼭짓점은 DEM에 아주 약하게(ROAD_DEM_W) 묶어 한 번에 푼다.
    교량·터널·지하차도 구간은 망에서 뺀다: 평면 교차로 처리된 다리 위·아래 길이 같은 높이로 묶이지 않게.
    attach_attributes 뒤에 부른다 (on_bridge·in_tunnel·in_underpass, DEM 경사를 쓴다)."""
    import scipy.sparse as sp
    from scipy.sparse.csgraph import dijkstra
    from scipy.sparse.linalg import spsolve
    ab = area.buffer(50)
    blockers = ([g for g, _ in read(folders, "N3A_A0070000", ab)] + [g for g, _ in read(folders, "N3A_A0110020", ab)]
                + [g for g, _ in read(folders, "N3A_A0090000", ab)])
    T_block = STRtree(blockers) if blockers else None
    blocked = lambda p: T_block is not None and len(T_block.query(p, predicate="intersects")) > 0
    contours = [(g, num(a.get("등고수치"))) for g, a in read(folders, "N3L_F0010000", ab)]
    contours = [(g, h) for g, h in contours if h is not None]
    spots = ([(g, num(a.get("수치"))) for g, a in read(folders, "N3P_F0020000", ab)]
             + [(g, num(a.get("표고"))) for g, a in read(folders, "N3P_H0020000", ab)])
    spots = [(g, h) for g, h in spots if h is not None]

    walks = [shapely.make_valid(g) for g, _ in read(folders, "N3A_A0033320", ab)]          # 인도 면
    T_w = STRtree(walks) if walks else None
    surfs = [shapely.make_valid(g) for g, _ in read(folders, "N3A_A0010000", ab)]  # 도로 면 (도로경계, 인도 포함 도로 전체 폭)
    T_r = STRtree(surfs) if surfs else None

    def strip_union(tree, polys, strip):
        if tree is None:
            return None
        hit = [polys[k] for k in tree.query(strip, predicate="intersects")]
        if not hit:
            return None
        try:
            return shapely.make_valid(unary_union(hit).intersection(strip))
        except shapely.errors.GEOSException:      # 원본 도형이 꼬인 곳: 이 구간은 다음 기준으로
            return None

    usable = [not (s.get("on_bridge") or s.get("in_tunnel") or s.get("in_underpass")) for s in segs]
    # 관측 구역 (구간 양옆 SIDEWALK_NEAR_M, 끝은 잘라 이웃 구간과 겹치지 않게):
    #   1. road_surface: 도로 면 + 인도 면 중 이 구간 중심선에 맞닿은 덩어리만.
    #      옹벽 위로 나란히 지나는 다른 길의 도로 면은 떨어져 있으므로 들어오지 않는다.
    #   2. sidewalk: 도로 면이 중심선에 닿지 않지만 인도 면이 있으면 인도 면
    #   3. centerline: 둘 다 없으면 (좁은 골목 등) 도로 중심선
    zones = [None] * len(segs)
    for i, s in enumerate(segs):
        s["incline_basis"] = None
        if not usable[i]:
            continue
        g = s["geom"]
        # 구역 폭 = 도로 폭의 절반 + 인도 몫. 12m로 고정하면 교차로에서 옆으로 갈라지는 다른 길의 도로 면이 섞인다
        half = min(SIDEWALK_NEAR_M, max(3.0, (s.get("road_width_m") or 3.0) / 2 + ZONE_SIDEWALK_M))
        strip = g.buffer(half, cap_style="flat")
        road = strip_union(T_r, surfs, strip)
        walk = strip_union(T_w, walks, strip) if s.get("has_sidewalk") else None
        parts = [x for x in (road, walk) if x is not None and not x.is_empty]
        try:
            if road is not None and not road.is_empty and road.intersects(g):
                both = unary_union(parts)
                blobs = getattr(both.buffer(0.5), "geoms", [both.buffer(0.5)])   # 0.5m 틈은 이어서 덩어리로
                touch = [b for b in blobs if b.intersects(g)]
                z = both.intersection(unary_union(touch)) if touch else None
                if z is not None and not z.is_empty and z.area > 1:
                    zones[i] = z; s["incline_basis"] = "road_surface"; continue
        except shapely.errors.GEOSException:
            pass
        if walk is not None and not walk.is_empty and walk.area > 1:
            zones[i] = walk; s["incline_basis"] = "sidewalk"; continue
        zones[i] = g; s["incline_basis"] = "centerline"
    obs = defaultdict(list)                       # 구간 번호 → [(거리, 높이, 종류)]
    n_blocked = 0
    T_c = STRtree([g for g, _ in contours])
    for i, s in enumerate(segs):
        if zones[i] is None:
            continue
        g, zone = s["geom"], zones[i]
        for k in T_c.query(zone, predicate="intersects"):
            inter = contours[k][0].intersection(zone)
            for p in getattr(inter, "geoms", [inter]):
                if p.is_empty:
                    continue
                if p.geom_type != "Point":       # 인도 면 안을 지나는 등고선 조각: 가운데 점을 구간에 투영
                    p = p.interpolate(0.5, normalized=True) if p.geom_type == "LineString" else p.representative_point()
                if blocked(p):
                    n_blocked += 1; continue
                obs[i].append((g.project(p), contours[k][1], "contour"))
    T_z = STRtree([z if z is not None else Point(0, 0).buffer(0.01) for z in zones])
    T_g = STRtree([s["geom"] for s in segs])
    for g, h in spots:
        # 표고점은 관측 구역(도로 면·인도 면) 1m 안 또는 도로 중심선 3m 안이면 관측
        # (인도 옆 차도 표고점도 쓴다: 연석 높이 차이는 경사에 영향이 작다). 여러 구간에 걸리면 가장 가까운 구간 하나에만.
        cand = set(int(j) for j in T_g.query(g, predicate="dwithin", distance=ROAD_OBS_SNAP_M))
        cand |= set(int(j) for j in T_z.query(g, predicate="dwithin", distance=1.0)
                    if segs[j]["incline_basis"] in ("road_surface", "sidewalk") and zones[j].distance(g) <= 1.0)
        cand = [j for j in cand if zones[j] is not None]
        if not cand:
            continue
        if blocked(g):
            n_blocked += 1; continue
        j = min(cand, key=lambda j: segs[j]["geom"].distance(g))
        obs[j].append((segs[j]["geom"].project(g), h, "spot"))

    # 꼭짓점과 이음선
    N = len(nodes)
    vx, vy = [x for x, _ in nodes], [y for _, y in nodes]
    obs_val = {}                                  # 꼭짓점 번호 → 관측 높이
    chains = {}                                   # 구간 번호 → [(거리, 꼭짓점)]
    rows, cols, lens = [], [], []
    for i, s in enumerate(segs):
        if not usable[i]:
            continue
        g, L = s["geom"], s["geom"].length
        chain = [(0.0, s["source"] - 1)]
        for d, h, _ in sorted(obs[i]):
            p = g.interpolate(d)
            v = len(vx); vx.append(p.x); vy.append(p.y); obs_val[v] = h
            chain.append((d, v))
        chain.append((L, s["target"] - 1))
        chains[i] = chain
        for (d0, u), (d1, v) in zip(chain, chain[1:]):
            rows.append(u); cols.append(v); lens.append(max(d1 - d0, 0.5))
    V = len(vx)
    rows, cols, lens = np.array(rows), np.array(cols), np.array(lens)
    w = 1.0 / lens
    Lap = sp.coo_matrix((np.r_[-w, -w], (np.r_[rows, cols], np.r_[cols, rows])), shape=(V, V)).tocsr()
    Lap = Lap + sp.diags(-np.asarray(Lap.sum(axis=1)).ravel())
    zdem = np.asarray(dem_sample(vx, vy), dtype=float)
    zdem = np.where(np.isnan(zdem), np.nanmean(zdem), zdem)
    prior = np.full(V, ROAD_DEM_W); target = ROAD_DEM_W * zdem
    oi = np.array(sorted(obs_val)); oh = np.array([obs_val[v] for v in oi])
    prior[oi] += ROAD_OBS_W; target[oi] += ROAD_OBS_W * oh
    z = spsolve((Lap + sp.diags(prior)).tocsc(), target)
    # 각 꼭짓점에서 가장 가까운 관측까지 길 따라 거리
    G = sp.coo_matrix((np.r_[lens, lens], (np.r_[rows, cols], np.r_[cols, rows])), shape=(V, V)).tocsr()
    gap = dijkstra(G, directed=False, indices=oi, min_only=True) if len(oi) else np.full(V, np.inf)

    # 짧은 구간(SLOPE_WINDOW_M 미만) 경사: 구간 양 끝 높이 차만 쓰면 높이 오차가 짧은 길이로 나뉘어 크게 부풀려진다
    # (8m 구간에서 0.8m 오차 → 10%). 교차로 조각이 대부분이라 조각 하나가 튀면 교차로 전체가 막힌다.
    # → 양 끝 노드에서 곧게(EXTEND_MAX_TURN_DEG 안) 이어지는 길을 따라 단면을 늘려, 이 구간을 덮는 SLOPE_WINDOW_M 창으로 잰다.
    ends = defaultdict(list)                      # 노드 꼭짓점 → [(구간 번호, 그 노드가 구간 시작인가)]
    for i in chains:
        ends[segs[i]["source"] - 1].append((i, True))
        ends[segs[i]["target"] - 1].append((i, False))

    def heading(i, at_start):
        """노드에서 구간 i 안쪽으로 향하는 방향(라디안): 노드에서 길 따라 5m 지점까지"""
        g = segs[i]["geom"]; L = g.length; d = min(5.0, L)
        p0, p1 = (g.interpolate(0.0), g.interpolate(d)) if at_start else (g.interpolate(L), g.interpolate(L - d))
        return math.atan2(p1.y - p0.y, p1.x - p0.x)

    def profile_from(i, at_start):
        """구간 i의 (거리, 높이) 단면. at_start면 시작 노드에서, 아니면 끝 노드에서 멀어지는 방향"""
        L = segs[i]["geom"].length
        d = np.array([x for x, _ in chains[i]]); h = np.array([z[v] for _, v in chains[i]])
        return (d, h) if at_start else (L - d[::-1], h[::-1])

    def extend(i, at_start, need):
        """구간 i의 한쪽 끝 노드에서 곧게 이어지는 길을 따라 need m까지의 단면 (노드에서 멀어지는 거리, 높이)"""
        out_d, out_h, got = [], [], 0.0
        cur, cur_start, seen = i, at_start, {i}
        while got < need - 1e-6:
            node = segs[cur]["source"] - 1 if cur_start else segs[cur]["target"] - 1
            ahead = heading(cur, cur_start) + math.pi     # 현재 구간에서 노드를 지나 계속 가는 방향
            best, best_turn = None, math.radians(EXTEND_MAX_TURN_DEG)
            for j, js in ends[node]:
                if j in seen:
                    continue
                turn = abs((heading(j, js) - ahead + math.pi) % (2 * math.pi) - math.pi)
                if turn < best_turn:
                    best, best_turn = (j, js), turn
            if best is None:
                break
            j, js = best
            seen.add(j)
            d, h = profile_from(j, js)
            room = need - got
            k = d <= room
            out_d.extend(got + d[k]); out_h.extend(h[k])
            if d[-1] > room:                          # 필요한 만큼만 잘라 끝점 높이는 보간
                out_d.append(got + room); out_h.append(float(np.interp(room, d, h)))
            got += min(float(d[-1]), room)
            cur, cur_start = j, not js                # 다음 노드는 j의 반대쪽 끝
        return np.array(out_d), np.array(out_h)

    def extended_profile(i):
        """구간 i(시작 → 끝 방향)를 가운데 두고 앞뒤로 늘린 단면. 구간은 거리 [0, L]"""
        L = segs[i]["geom"].length
        need = SLOPE_WINDOW_M - L
        d0, h0 = profile_from(i, True)
        db, hb = extend(i, True, need)                # 시작 노드 뒤쪽 (거리는 음수로)
        da, ha = extend(i, False, need)               # 끝 노드 앞쪽
        d = np.r_[-db[::-1], d0, L + da]; h = np.r_[hb[::-1], h0, ha]
        d, k = np.unique(d, return_index=True)        # 노드에서 겹치는 점 하나만
        return d, h[k]

    n_road = n_short = 0
    for i, s in enumerate(segs):
        s["incline_source"] = "dem" if s.get("dem_incline_max_pct") is not None else None
        s["road_incline_max_pct"] = s["road_obs_gap_m"] = None
        if i not in chains:
            continue
        chain = chains[i]
        L = s["geom"].length
        seg_gap = max(min(gap[u] + (d1 - d0) / 2, gap[v] + (d1 - d0) / 2) for (d0, u), (d1, v) in zip(chain, chain[1:]))
        s["road_obs_gap_m"] = round(float(seg_gap), 1) if np.isfinite(seg_gap) else None
        ds = np.linspace(0, L, max(2, int(L // 2.5) + 1))
        zc = np.interp(ds, [d for d, _ in chain], [z[v] for _, v in chain])
        short = L < SLOPE_WINDOW_M
        if short:
            de, he = extended_profile(i)
            avg, mx, up, down = window_profile(de, he, 0.0, L)
            n_short += 1
        else:
            avg, mx = profile_incline(ds, zc)
        s["road_incline_max_pct"] = round(float(mx), 2)
        if np.isfinite(seg_gap) and seg_gap <= ROAD_MAX_GAP_M:
            s["dem_incline_pct"], s["dem_incline_max_pct"] = round(float(avg), 2), round(float(mx), 2)
            if not short:
                up, down = profile_updown(ds, zc)
            s["incline_up_max_pct"], s["incline_down_max_pct"] = round(float(up), 2), round(float(down), 2)
            s["incline_hist"], s["incline_runs"] = short_detail(L, avg) if short else profile_detail(ds, zc)
            s["z_start"], s["z_end"] = round(float(zc[0]), 2), round(float(zc[-1]), 2)
            s["incline_source"] = "road_obs"
            n_road += 1
    resid = np.abs(z[oi] - oh) if len(oi) else np.array([0.0])
    kinds = Counter(k for v in obs.values() for _, _, k in v)
    return dict(obs_contour=kinds["contour"], obs_spot=kinds["spot"], obs_blocked=n_blocked,
                resid_med=float(np.median(resid)), resid_p95=float(np.percentile(resid, 95)),
                n_road=n_road, n_short=n_short, n_usable=sum(usable), basis=dict(Counter(s.get("incline_basis") for s in segs if s.get("incline_basis"))))


def window_profile(ds, zs, a, b, win=None):
    """늘린 단면(ds 오름차순, zs)에서 구간 [a, b](b - a < win)를 가운데 둔 win 창 하나의 경사, 단위 %. 진행 방향 = ds 증가 방향.
    반환: (경사(부호 있음), |경사|, 오르막, 내리막). 늘려도 창보다 짧으면(막다른 짧은 길) 늘린 전체로.
    구간을 덮는 여러 창 중 가장 가파른 것을 고르면 이웃 길의 급경사를 끌어와 위로 치우친다 (동해 전체에서 급경사 7,673 → 8,364로 늘었음).
    한쪽으로 늘릴 길이 모자라면 창을 반대쪽으로 민다."""
    win = SLOPE_WINDOW_M if win is None else win
    span = ds[-1] - ds[0]
    if span <= win:
        g = float((zs[-1] - zs[0]) / max(span, 0.5) * 100)
    else:
        c = min(max((a + b) / 2 - win / 2, ds[0]), ds[-1] - win)
        g = float((np.interp(c + win, ds, zs) - np.interp(c, ds, zs)) / win * 100)
    return g, abs(g), max(g, 0.0), max(-g, 0.0)


def short_detail(L, g):
    """짧은 구간의 경사별 길이·연속 구간 (profile_detail과 같은 모양): 구간 전체를 가운데 창 경사 g 한 칸으로"""
    hist = [0.0] * (len(GRADE_EDGES) + 1)
    hist[int(np.digitize([g], GRADE_EDGES, right=True)[0])] = round(float(L), 1)
    runs = [round(float(L if g > 0 else -L), 1)] if abs(g) >= RUN_MIN_PCT and L >= RUN_KEEP_M else []
    return hist, runs


def _axis_deg(p, q):
    return math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])) % 180


def profile_incline(ds, zs, keep=None):
    """단면(거리 ds, 표고 zs)의 평균 경사(부호 있음)와 SLOPE_WINDOW_M 창 최대 |경사|, 단위 %.
    keep이 있으면 그 표본만 쓰고, 버린 자리는 남은 표본 사이를 직선으로 잇는다. 남은 표본 범위 밖으로는 늘리지 않는다."""
    if keep is None:
        keep = np.ones(len(ds), dtype=bool)
    dk, zk = ds[keep], zs[keep]
    a, b = dk[0], dk[-1]
    avg = (zk[-1] - zk[0]) / (b - a) * 100
    if b - a <= SLOPE_WINDOW_M:
        return avg, abs(avg)
    zc = np.interp(ds, dk, zk)
    step = max(1, int(round(SLOPE_WINDOW_M / (ds[1] - ds[0]))))
    mx = max(abs(zc[i + step] - zc[i]) / (ds[i + step] - ds[i]) * 100
             for i in range(len(ds) - step) if ds[i] >= a and ds[i + step] <= b)
    return avg, mx


def profile_updown(ds, zs, keep=None):
    """단면의 진행 방향(구간 시작 → 끝) 기준 오르막 최대·내리막 최대 경사(%, 둘 다 0 이상).
    profile_incline과 같은 SLOPE_WINDOW_M 창. 반대 방향으로 가면 둘이 서로 바뀐다."""
    if keep is None:
        keep = np.ones(len(ds), dtype=bool)
    dk, zk = ds[keep], zs[keep]
    a, b = dk[0], dk[-1]
    if b - a <= SLOPE_WINDOW_M:
        g = (zk[-1] - zk[0]) / (b - a) * 100
        return max(g, 0.0), max(-g, 0.0)
    zc = np.interp(ds, dk, zk)
    step = max(1, int(round(SLOPE_WINDOW_M / (ds[1] - ds[0]))))
    gs = [(zc[i + step] - zc[i]) / (ds[i + step] - ds[i]) * 100
          for i in range(len(ds) - step) if ds[i] >= a and ds[i + step] <= b]
    return max(max(gs), 0.0), max(-min(gs), 0.0)


def profile_detail(ds, zs, keep=None):
    """진행 방향(구간 시작 → 끝) 경사별 길이(GRADE_EDGES 9칸, m)와 RUN_MIN_PCT 이상 연속 구간(부호 있는 길이 m, + 오르막).
    표본 사이 한 칸의 경사 = 그 칸을 가운데 둔 SLOPE_WINDOW_M 창 경사 (profile_updown의 최대값과 같은 창).
    앱이 칸별 속도 계수로 구간 시간을 계산하고(③), 연속 구간으로 쉬는 시간을 더한다(④)."""
    if keep is None:
        keep = np.ones(len(ds), dtype=bool)
    dk, zk = ds[keep], zs[keep]
    a, b = dk[0], dk[-1]
    n = len(ds)
    if b - a <= SLOPE_WINDOW_M:
        g = np.full(n - 1, (zk[-1] - zk[0]) / (b - a) * 100)
    else:
        zc = np.interp(ds, dk, zk)
        step = max(1, int(round(SLOPE_WINDOW_M / (ds[1] - ds[0]))))
        starts = np.array([i for i in range(n - step) if ds[i] >= a and ds[i + step] <= b])
        gw = (zc[starts + step] - zc[starts]) / (ds[starts + step] - ds[starts]) * 100
        want = np.arange(n - 1) - step // 2           # 칸 j를 가운데 둔 창의 시작
        k = np.clip(np.searchsorted(starts, want), 0, len(starts) - 1)
        k0 = np.clip(k - 1, 0, len(starts) - 1)
        k = np.where(np.abs(starts[k0] - want) < np.abs(starts[k] - want), k0, k)
        g = gw[k]
    lens = np.diff(ds)
    hist = np.bincount(np.digitize(g, GRADE_EDGES, right=True), weights=lens, minlength=len(GRADE_EDGES) + 1)
    runs, cur = [], 0.0
    for gi, li in zip(g, lens):
        sgn = 1 if gi >= RUN_MIN_PCT else -1 if gi <= -RUN_MIN_PCT else 0
        if sgn and cur * sgn >= 0:
            cur += sgn * li
        else:
            if abs(cur) >= RUN_KEEP_M:
                runs.append(round(float(cur), 1))
            cur = sgn * li
    if abs(cur) >= RUN_KEEP_M:
        runs.append(round(float(cur), 1))
    return [round(float(h), 1) for h in hist], runs


def crosses_wall(wall, seg):
    """구간이 옹벽·절토 선을 가로지르는가 (WALL_CROSS_DEG 이상). 나란히 옆을 지나는 벽은 아니다.
    수치지도에서 보행 구간이 옹벽 선을 가로지르면 실제로는 계단·경사로·단차이거나 자료 오류다."""
    inter = wall.intersection(seg)
    if inter.is_empty:
        return False
    for p in getattr(inter, "geoms", [inter]):
        if p.geom_type != "Point":
            continue                                   # 겹쳐 지나는 선분: 나란한 것
        dirs = []
        for line in (seg, wall):
            line = min(getattr(line, "geoms", [line]), key=lambda x: x.distance(p))
            d = line.project(p)
            q0, q1 = line.interpolate(max(0.0, d - 2.0)), line.interpolate(min(line.length, d + 2.0))
            dirs.append(_axis_deg((q0.x, q0.y), (q1.x, q1.y)))
        diff = abs(dirs[0] - dirs[1]) % 180
        if min(diff, 180 - diff) >= WALL_CROSS_DEG:
            return True
    return False


def on_bridge(bridge, seg):
    """구간이 교량 '위'를 지나는가. 교량 면과 겹치기만 하면 다리 밑을 지나는 길도 걸리므로,
    겹친 부분이 교량의 긴 방향과 나란할 때(30° 안)만 교량 위로 본다. 정사각형에 가까운 작은 교량은 겹치면 위로 본다."""
    inter = bridge.intersection(seg)
    if inter.length < 2:
        return False
    rect = bridge.minimum_rotated_rectangle
    cs = list(rect.exterior.coords)
    e1, e2 = math.dist(cs[0], cs[1]), math.dist(cs[1], cs[2])
    if max(e1, e2) < 1.5 * max(min(e1, e2), 0.1):
        return True
    long_axis = _axis_deg(cs[0], cs[1]) if e1 >= e2 else _axis_deg(cs[1], cs[2])
    parts = getattr(inter, "geoms", [inter])
    longest = max(parts, key=lambda x: x.length)
    a = _axis_deg(longest.coords[0], longest.coords[-1])
    diff = abs(a - long_axis) % 180
    return min(diff, 180 - diff) <= 30


MODERATE_MIN = 4.0  # 보수적 기본값: DEM은 짧은 급경사를 낮게 보므로 올리지 않는다. 동해 현장 측정으로 다시 정한다


def dem_estimate(s):
    """DEM은 짧은 급경사를 펴서 낮게 보는 경향 → 보수적으로 분류. '통행 가능'은 절대 주지 않는다."""
    if s.get("on_bridge") or s.get("in_tunnel") or s.get("dem_incline_max_pct") is None:
        return "unknown"
    m = s["dem_incline_max_pct"]
    if m > 8.3:
        return "steep"        # 급경사 가능성 높음
    if m >= MODERATE_MIN:
        return "moderate"     # 경계 근처 → 현장 측정 필요
    return "gentle"           # 지형은 완만, 턱·계단은 미확인


def check_items(s, node_info):
    items = []
    est = s["dem_estimate"]
    m = s.get("dem_incline_max_pct")
    if s.get("on_bridge"):
        items.append("bridge_measure")            # 교량·육교: DEM 사용 불가, 현장 측정
    elif m is not None and 3.0 <= m <= 9.0:
        items.append("slope_measure")             # 등급 경계 근처: 현장 측정
    elif est == "steep":
        items.append("slope_confirm_steep")
    if s.get("near_wall") or s.get("near_cut"):
        items.append("wall_or_cut_nearby")        # DEM 과장 가능, 단차 확인
    if s.get("wall_crossing"):
        items.append("wall_crossing")             # 옹벽·절토 선을 가로지름: 계단·단차 후보
    if s.get("kind") == "osm_steps":
        items.append("osm_steps")                 # OSM 계단: 휠체어 불가
    elif s.get("kind") == "osm_path":
        items.append("osm_path")                  # OSM에서 보완한 길: 현장 확인
    if s.get("osm_wheelchair") == "no":
        items.append("osm_wheelchair_no")         # OSM에 휠체어 불가로 표시
    if s.get("dem_wall_masked_frac") and s.get("dem_incline_max_pct") is None:
        items.append("slope_measure")             # 옹벽·절토에 가려 DEM 경사를 비움: 현장 측정
    raw = s.get("dem_incline_raw_max_pct")
    if (s.get("incline_source") == "road_obs" and raw is not None and m is not None
            and abs(raw - m) >= SLOPE_DISAGREE_PP and max(raw, m) >= MODERATE_MIN):
        items.append("slope_sources_disagree")    # DEM과 길 위 표고가 크게 다름: 짧은 급경사를 놓쳤을 수 있어 현장 측정 우선
    if s.get("near_stairs"):
        items.append("stairs_nearby")
    if s.get("in_tunnel"):
        items.append("tunnel")                    # 보도·조명 확인
    if s.get("underpass_no_sidewalk"):
        items.append("underpass_no_sidewalk")     # 수치지도상 보도 없는 지하차도
    if s.get("overpass_nearby") == "inaccessible":
        items.append("overpass_inaccessible")     # 장애인 이용 불가 육교: 평면 횡단 가능한지 확인
    if not s.get("has_sidewalk") and s.get("kind") == "road" and (s.get("road_width_m") or 0) >= 6:
        items.append("no_sidewalk_data")
    if s.get("sidewalk_width_m") is not None and s["sidewalk_width_m"] < 1.2:
        items.append("narrow_sidewalk")
    for nid in (s["source"], s["target"]):
        ni = node_info.get(nid)
        if ni and ni.get("crossing_kerb") == "raised":
            items.append("crosswalk_kerb_not_lowered")
        if ni and ni.get("crossing_ambiguous"):
            items.append("crosswalk_which_side")
    return sorted(set(items))


# ───────────────────────── 횡단보도 ─────────────────────────
def load_crosswalks(path, city="동해시"):
    raw = open(path, "rb").read()
    txt = raw.decode("cp949") if not raw.startswith(b"\xef\xbb\xbf") else raw.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(txt)))
    return [r for r in rows if r.get("시군구명") == city]


def attach_crosswalks(rows, nodes_xy, area):
    rows = [r for r in rows if num(r.get("경도")) and num(r.get("위도"))]
    lon = [float(r["경도"]) for r in rows]; lat = [float(r["위도"]) for r in rows]
    xs, ys = warp("EPSG:4326", CRS, lon, lat)
    tree = cKDTree(np.array(nodes_xy))
    inside = shapely.contains_xy(area.buffer(30), np.array(xs), np.array(ys))
    info = defaultdict(lambda: dict(n=0, lowered=0, not_lowered=0, flush=0, coords=set()))
    out = []
    for r, x, y, lo, la, ins in zip(rows, xs, ys, lon, lat, inside):
        if not ins:
            continue
        d, i = tree.query((x, y))
        node = int(i) + 1 if d <= 30 else None
        kerb = "flush" if r.get("고원식적용여부") == "Y" else ("lowered" if r.get("보도턱낮춤여부") == "Y" else ("raised" if r.get("보도턱낮춤여부") == "N" else None))
        out.append(dict(lon=lo, lat=la, node_id=node, node_dist_m=round(float(d), 1),
                        manage_no=r.get("횡단보도관리번호"), kind=r.get("횡단보도종류"), road_name=r.get("도로명"),
                        lanes=int(num(r.get("차로수"), 0) or 0) or None, width_m=num(r.get("횡단보도폭")), length_m=num(r.get("횡단보도연장")),
                        kerb=kerb, kerb_lowered=r.get("보도턱낮춤여부") or None, raised_table=r.get("고원식적용여부") == "Y",
                        tactile=r.get("점자블록유무") == "Y", ped_signal=r.get("보행자신호등유무") == "Y",
                        island=r.get("교통섬유무") == "Y", data_date=r.get("데이터기준일자")))
        if node:
            ni = info[node]; ni["n"] += 1; ni["coords"].add((round(lo, 6), round(la, 6)))
            ni["lowered"] += kerb == "lowered"; ni["not_lowered"] += kerb == "raised"; ni["flush"] += kerb == "flush"
    node_info = {}
    for k, v in info.items():
        kerb = "raised" if v["not_lowered"] else ("lowered" if v["lowered"] else ("flush" if v["flush"] else None))
        node_info[k] = dict(crossing=True, crossing_count=v["n"], crossing_kerb=kerb,
                            crossing_ambiguous=v["n"] > 1 and len(v["coords"]) < v["n"])
    return out, node_info


# ───────────────────────── 주요 기관 ─────────────────────────
def find_places(folders, area):
    """건물 이름(주기·명칭)과 철도역에서 주요 기관을 찾는다. 같은 이름은 가장 큰 건물 하나."""
    import re
    shapely.prepare(area)
    best = {}
    for g, a in read(folders, "N3A_B0010000", area):
        label = f"{a.get('주기') or ''},{a.get('명칭') or ''}"
        for part in (p.strip() for p in label.split(",")):
            if not part:
                continue
            for cat, inc, exc in PLACE_RULES:
                if re.search(inc, part) and not (exc and re.search(exc, part)):
                    name = PLACE_ALIAS.get(part, part)
                    c = g.representative_point()
                    if area.contains(c) and (name not in best or g.area > best[name][2]):
                        best[name] = (cat, c, g.area)
                    break
    for g, a in read(folders, "N3P_A0131122", area):
        name = a.get("명칭") or ""
        if name and name not in FREIGHT_STATIONS and area.contains(g):
            best[name] = ("transport", g, 0)
    return [dict(name=n, category=c, x=p.x, y=p.y) for n, (c, p, _) in sorted(best.items(), key=lambda kv: (kv[1][0], kv[0]))]


# ───────────────────────── 출력 ─────────────────────────
def to_wgs(coords):
    xs, ys = zip(*coords)
    lo, la = warp(CRS, "EPSG:4326", list(xs), list(ys))
    return [[round(a, 7), round(b, 7)] for a, b in zip(lo, la)]


def dump(path, feats):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheets"); ap.add_argument("crosswalk"); ap.add_argument("out")
    ap.add_argument("--bbox", nargs=4, type=float, default=None, help="시연 지역만 (기본: 동해시 전체)")
    ap.add_argument("--demo", action="store_true", help=f"--bbox {' '.join(map(str, DEMO_BBOX))}")
    ap.add_argument("--res", type=float, default=5.0)
    ap.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 2)))
    ap.add_argument("--osm", default=None, help="fetch_osm.py 결과 (OSM으로 중심선에 없는 길 보완, ODbL)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    log = []
    P = lambda *x: (print(*x), log.append(" ".join(map(str, x))))
    import time
    t0 = time.time()

    bounds = sheet_bounds(a.sheets)
    city = city_polygon(bounds)
    bbox = DEMO_BBOX if a.demo else (tuple(a.bbox) if a.bbox else None)
    area = city.intersection(box(*bbox)) if bbox else city
    P(f"범위: {'상자 ' + str(bbox) if bbox else CITY + ' 전체'} · 면적 {area.area/1e6:.1f} km²")
    folders = sheets_in(bounds, area, 300)
    P(f"도엽 {len(folders)}장")
    dem_sample, dinfo = build_dem_tiled({f: bounds[f] for f in folders} if bbox else bounds, area, a.res, a.out, a.workers)
    P(f"DEM: 조각 {dinfo['tiles']}개, 등고선 점 {dinfo['contour_pts']:,}, 점 표고 {dinfo['spot_pts']:,}, 격자 {dinfo['grid']}, "
      f"표고 {dinfo['zmin']:.1f}~{dinfo['zmax']:.1f} m ({time.time()-t0:.0f}s)")

    segs, nodes, nstats = build_network(folders, area, a.osm)
    P(f"구간망: 구간 {len(segs):,}, 노드 {len(nodes):,}, 총 길이 {sum(s['geom'].length for s in segs)/1000:.1f} km "
      f"(고속국도 {nstats['excluded_roads']}개·자동차전용 {nstats['excluded_car_only']}개 제외, 끊긴 끝점 {nstats['snapped_ends']}곳 이음, "
      f"떨어진 조각 {nstats['dropped_components']}개·구간 {nstats['dropped_segments']}개 제외) ({time.time()-t0:.0f}s)")
    if nstats.get("osm"):
        P(f"OSM 보완: {nstats['osm']} (구간 {sum(1 for s in segs if str(s.get('kind','')).startswith('osm')):,}개, {sum(s['geom'].length for s in segs if str(s.get('kind','')).startswith('osm'))/1000:.1f}km)")
    attach_attributes(segs, folders, area, dem_sample)
    P(f"속성 계산 끝 ({time.time()-t0:.0f}s)")
    rp = road_profile(segs, nodes, folders, area, dem_sample)
    P(f"길 위 표고: 관측 {rp['obs_contour'] + rp['obs_spot']:,} (등고선 교차 {rp['obs_contour']:,}, 표고점·기준점 {rp['obs_spot']:,}, "
      f"교량·터널 위라 버림 {rp['obs_blocked']:,}), 관측과 풀이 차이 중앙 {rp['resid_med']:.2f}m·상위5% {rp['resid_p95']:.2f}m, "
      f"길 위 표고로 경사를 정한 구간 {rp['n_road']:,}/{rp['n_usable']:,} (그중 {SLOPE_WINDOW_M:.0f}m 미만이라 이웃 길로 늘려 잰 구간 {rp['n_short']:,}), 관측 구역 {rp['basis']} (관측 {ROAD_MAX_GAP_M:.0f}m 안) ({time.time()-t0:.0f}s)")

    cw_rows = load_crosswalks(a.crosswalk)
    cws, node_info = attach_crosswalks(cw_rows, nodes, area)
    P(f"횡단보도: 동해시 {len(cw_rows)}건 중 범위 안 {len(cws)}건, 노드 연결 {sum(1 for c in cws if c['node_id'])}건 → 횡단 노드 {len(node_info)}곳 "
      f"(턱낮춤 없음 포함 {sum(1 for v in node_info.values() if v['crossing_kerb']=='raised')}곳, 어느 쪽인지 불명 {sum(1 for v in node_info.values() if v['crossing_ambiguous'])}곳)")

    for i, s in enumerate(segs, 1):
        s["id"] = i
        s["dem_estimate"] = dem_estimate(s)
        s["check_items"] = check_items(s, node_info)

    # 노드 차수
    deg = defaultdict(int)
    for s in segs:
        deg[s["source"]] += 1; deg[s["target"]] += 1

    # GeoJSON
    node_feats = []
    nodes_wgs = to_wgs(nodes)
    for i, (xy, ll) in enumerate(zip(nodes, nodes_wgs), 1):
        ni = node_info.get(i, {})
        node_feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": ll},
                           "properties": {"id": i, "degree": deg[i], "crossing": bool(ni.get("crossing")), "crossing_count": ni.get("crossing_count", 0),
                                          "crossing_kerb": ni.get("crossing_kerb"), "crossing_ambiguous": bool(ni.get("crossing_ambiguous")),
                                          "crossing_source": "national_crosswalk_std" if ni else None}})
    dump(os.path.join(a.out, "nodes.geojson"), node_feats)

    keys = ["id", "source", "target", "length_m", "kind", "road_class", "road_name", "road_width_m", "lanes", "paved",
            "has_sidewalk", "sidewalk_width_m", "sidewalk_surface", "on_bridge", "near_stairs", "near_wall", "near_cut",
            "in_tunnel", "underpass_no_sidewalk", "overpass_nearby", "wall_crossing",
            "z_start", "z_end", "dem_incline_pct", "dem_incline_max_pct", "incline_up_max_pct", "incline_down_max_pct", "incline_source", "incline_basis",
            "incline_hist", "incline_runs", "road_incline_max_pct", "road_obs_gap_m", "dem_incline_raw_max_pct", "dem_wall_masked_frac",
            "dem_estimate", "check_items"]
    seg_feats = []
    for s in segs:
        seg_feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": to_wgs(list(s["geom"].coords))},
                          "properties": {k: s.get(k) for k in keys}})
    dump(os.path.join(a.out, "segments.geojson"), seg_feats)

    dump(os.path.join(a.out, "crosswalks.geojson"), [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
                                                      "properties": {k: v for k, v in c.items() if k not in ("lon", "lat")}} for c in cws])

    places = find_places(folders, area)
    pw = to_wgs([(p["x"], p["y"]) for p in places]) if places else []
    ptree = cKDTree(np.array(nodes))
    pf = []
    for p, ll in zip(places, pw):
        d, i = ptree.query((p["x"], p["y"]))
        pf.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": ll},
                   "properties": {"name": p["name"], "category": p["category"], "nearest_node": int(i) + 1, "nearest_node_dist_m": round(float(d), 1)}})
    dump(os.path.join(a.out, "places.geojson"), pf)
    from collections import Counter
    P(f"주요 기관 {len(places)}곳: {dict(Counter(p['category'] for p in places))}")
    far = [f"{f['properties']['name']}({f['properties']['nearest_node_dist_m']:.0f}m)" for f in pf if f["properties"]["nearest_node_dist_m"] > 150]
    P(f"  가장 가까운 노드가 150m 넘게 떨어진 기관 {len(far)}곳: {', '.join(far)}")

    # 점검표
    LABEL = {"bridge_measure": "교량·육교: 현장 경사 측정", "slope_measure": "경사 경계 근처: 현장 측정", "slope_confirm_steep": "급경사 추정: 확인",
             "wall_or_cut_nearby": "옹벽·절토 인접: 단차 확인", "wall_crossing": "옹벽·절토 선을 가로지름: 계단·단차 확인",
             "slope_sources_disagree": "DEM과 길 위 표고가 크게 다름: 경사 측정 우선",
             "osm_steps": "OSM 계단: 휠체어 불가, 현장 확인", "osm_path": "OSM에서 보완한 길: 현장 확인", "osm_wheelchair_no": "OSM 휠체어 불가 표시: 현장 확인", "stairs_nearby": "계단 인접: 확인", "no_sidewalk_data": "인도 데이터 없음: 보도 유무 확인",
             "narrow_sidewalk": "인도 폭 1.2m 미만", "crosswalk_kerb_not_lowered": "횡단보도 턱낮춤 없음: 턱 높이 측정", "crosswalk_which_side": "교차로 횡단보도 위치 불명: 확인",
             "tunnel": "터널: 보도·조명 확인", "underpass_no_sidewalk": "보도 없는 지하차도", "overpass_inaccessible": "장애인 이용 불가 육교: 평면 횡단 가능 여부 확인"}
    with open(os.path.join(a.out, "checklist.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["구간ID", "길이m", "도로구분", "DEM최대경사%", "DEM추정", "인도", "인도폭m", "점검항목", "카카오지도", "로드뷰"])
        for s, ft in zip(segs, seg_feats):
            if not s["check_items"]:
                continue
            cs = ft["geometry"]["coordinates"]; mid = cs[len(cs) // 2]
            w.writerow([s["id"], s["length_m"], s.get("road_class"), s.get("dem_incline_max_pct"), s["dem_estimate"],
                        "있음" if s["has_sidewalk"] else "없음", s.get("sidewalk_width_m") or "",
                        " / ".join(LABEL[c] for c in s["check_items"]),
                        f"https://map.kakao.com/link/map/S{s['id']},{mid[1]},{mid[0]}", f"https://map.kakao.com/link/roadview/{mid[1]},{mid[0]}"])

    est = Counter(s["dem_estimate"] for s in segs)
    items = Counter(c for s in segs for c in s["check_items"])
    P(f"DEM 추정 (주의 기준 {MODERATE_MIN}%): {dict(est)}")
    mx = [s["dem_incline_max_pct"] for s in segs if s.get("dem_incline_max_pct") is not None and not s.get("on_bridge") and not s.get("in_tunnel")]
    P("  기준을 바꾸면 '측정 필요 이상' 구간 수: " + ", ".join(f"{t}% → {sum(1 for v in mx if v >= t):,}" for t in (2.5, 3.0, 4.0, 5.0)) + f" (전체 {len(mx):,})")
    P(f"인도 있음 {sum(s['has_sidewalk'] for s in segs)}/{len(segs)}, 교량 위 {sum(s['on_bridge'] for s in segs)}, 계단 인접 {sum(s['near_stairs'] for s in segs)}, "
      f"옹벽 인접 {sum(s['near_wall'] for s in segs)}, 터널 {sum(s['in_tunnel'] for s in segs)}, 보도 없는 지하차도 {sum(s['underpass_no_sidewalk'] for s in segs)}, "
      f"육교(불가) 겹침 {sum(s['overpass_nearby'] == 'inaccessible' for s in segs)}, 육교(가능) 겹침 {sum(s['overpass_nearby'] == 'accessible' for s in segs)}")
    masked = [s for s in segs if s.get("dem_wall_masked_frac")]
    P(f"옹벽·절토 보정 ({WALL_MASK_M:.0f}m 안 표본 제외): 표본을 버린 구간 {len(masked):,}, "
      f"그중 DEM 경사를 비운 구간 {sum(1 for s in masked if s['dem_incline_max_pct'] is None):,}, "
      f"옹벽·절토 선을 가로지르는 구간 {sum(1 for s in segs if s.get('wall_crossing')):,}")
    P(f"점검 항목이 있는 구간 {sum(1 for s in segs if s['check_items'])}: {dict(items)}")
    comp = connected_components(segs)
    P(f"연결 요소 {len(comp)}개, 가장 큰 요소에 구간 {max(comp)} ({max(comp)/len(segs):.1%}), 크기 상위 {comp[:8]}")
    P(f"전체 {time.time()-t0:.0f}s")
    with open(os.path.join(a.out, "report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log) + "\n")


def connected_components(segs):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for s in segs:
        a, b = find(s["source"]), find(s["target"])
        if a != b:
            parent[a] = b
    sizes = defaultdict(int)
    for s in segs:
        sizes[find(s["source"])] += 1
    return sorted(sizes.values(), reverse=True)


if __name__ == "__main__":
    main()
