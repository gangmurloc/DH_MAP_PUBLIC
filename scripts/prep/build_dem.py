"""수치지형도(1:5,000, 수치지도 2.0)의 등고선·표고점으로 DEM을 만든다.

사용법:
    python -I build_dem.py <수치지도 SHP 폴더> <출력 폴더> [--res 5] [--holdout 0.1]

입력 레이어 (국토지리정보원 수치지도 2.0 코드):
    N3L_F0010000  등고선 (필드: 등고수치)
    N3P_F0020000  표고점 (필드: 수치)
    N3P_H0020000  삼각점 (필드: 표고)          ← 있으면 사용
    N3P_H0059153  산 정상 (필드: 높이)          ← 있으면 사용
    N3A_H0010000  도엽 경계 (출력 범위)          ← 없으면 입력 데이터 범위

방법 (--method):
    spline (기본)  장력 스플라인. 등고선·표고점이 지나는 칸을 고정하고 그 사이를 매끈하게 채운다.
                   GMT surface와 같은 원리. TIN보다 평평한 삼각형 왜곡이 적다.
    tin            등고선 꼭짓점과 점 표고로 삼각망을 만들고 선형 보간. QGIS TIN 보간과 같은 방식.

주의: slope_pct.tif는 '가장 가파른 방향'의 경사다. 보행 구간의 진행 방향 경사는
     구간 선을 따라 높이 차를 재야 하므로 별도 단계에서 계산한다.

출력:
    dem.tif          표고(m), float32, 입력과 같은 좌표계
    slope_pct.tif    경사(%)
    preview.png      음영기복 + 등고선 미리보기
    report.txt       입력 요약, 품질 지표(표고점 일부를 빼고 예측한 오차, 평평한 삼각형 비율)
"""
import argparse
import math
import os
import struct
import sys
import zlib

import numpy as np
import rasterio
import shapefile
from rasterio.transform import from_origin
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import Delaunay

ENC = "cp949"


def read_layer(folder, name):
    path = os.path.join(folder, name + ".shp")
    if not os.path.exists(path):
        return None
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return shapefile.Reader(path, encoding=ENC)


def densify(coords, step):
    out = []
    for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(math.ceil(d / step)))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(coords[-1])
    return out


def collect_points(folder, step):
    pts, src = [], []
    contours = read_layer(folder, "N3L_F0010000")
    n_contour_lines = 0
    contour_levels = set()
    if contours is not None:
        names = [f[0] for f in contours.fields[1:]]
        hcol = names.index("등고수치")
        for sr in contours.iterShapeRecords():
            h = float(sr.record[hcol])
            contour_levels.add(h)
            n_contour_lines += 1
            parts = list(sr.shape.parts) + [len(sr.shape.points)]
            for a, b in zip(parts[:-1], parts[1:]):
                for x, y in densify(sr.shape.points[a:b], step):
                    pts.append((x, y, h)); src.append(0)
    spot_layers = [("N3P_F0020000", "수치", 1), ("N3P_H0020000", "표고", 2), ("N3P_H0059153", "높이", 3)]
    counts = {}
    for name, col, code in spot_layers:
        lyr = read_layer(folder, name)
        if lyr is None:
            continue
        names = [f[0] for f in lyr.fields[1:]]
        if col not in names:
            continue
        ci = names.index(col)
        c = 0
        for sr in lyr.iterShapeRecords():
            v = sr.record[ci]
            if v in (None, ""):
                continue
            x, y = sr.shape.points[0]
            pts.append((x, y, float(v))); src.append(code); c += 1
        counts[name] = c
    arr = np.array(pts, dtype=float)
    # 같은 위치의 중복 점 제거 (평균)
    key = np.round(arr[:, :2], 2)
    _, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    z = np.bincount(inv, weights=arr[:, 2]) / np.bincount(inv)
    xy = arr[idx, :2]
    srcs = np.array(src)[idx]
    return xy, z, srcs, n_contour_lines, sorted(contour_levels), counts


def sheet_bounds(folder, xy, pad):
    lyr = read_layer(folder, "N3A_H0010000")
    if lyr is not None and len(lyr):
        xs = [p[0] for s in lyr.shapes() for p in s.points]
        ys = [p[1] for s in lyr.shapes() for p in s.points]
        return min(xs), min(ys), max(xs), max(ys), "도엽 경계(N3A_H0010000)"
    return xy[:, 0].min() - pad, xy[:, 1].min() - pad, xy[:, 0].max() + pad, xy[:, 1].max() + pad, "입력 점 범위"


def spline_grid(xy, z, xmin, ymax, W, H, res, tension=0.25, tol=1e-8):
    """장력 스플라인(thin plate + tension) 격자 보간. GMT surface와 같은 에너지를 최소화한다.
    (1-t)·|∇²z|² + t·|∇z|² 를 최소화하고, 등고선·표고점이 지나는 칸은 그 값으로 고정한다."""
    import pyamg
    import scipy.sparse as sp

    c = np.floor((xy[:, 0] - xmin) / res).astype(int)
    r = np.floor((ymax - xy[:, 1]) / res).astype(int)
    m = (r >= 0) & (r < H) & (c >= 0) & (c < W)
    idx = r[m] * W + c[m]
    N = W * H
    s = np.bincount(idx, weights=z[m], minlength=N)
    n = np.bincount(idx, minlength=N)
    fixed = n > 0
    zc = np.zeros(N); zc[fixed] = s[fixed] / n[fixed]

    # 4-이웃 그래프 라플라시안 (가장자리는 Neumann)
    ii = np.arange(N).reshape(H, W)
    rows, cols = [], []
    for a, b in ((ii[:, :-1], ii[:, 1:]), (ii[:-1, :], ii[1:, :])):
        rows += [a.ravel(), b.ravel()]; cols += [b.ravel(), a.ravel()]
    rows = np.concatenate(rows); cols = np.concatenate(cols)
    A = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(N, N))
    L = sp.diags(np.asarray(A.sum(1)).ravel()) - A
    Q = ((1 - tension) * (L.T @ L) + tension * L).tocsr()
    free = ~fixed
    Qff = Q[free][:, free].tocsr()
    b = -(Q[free][:, fixed] @ zc[fixed])
    ml = pyamg.smoothed_aggregation_solver(Qff, symmetry="symmetric")
    zf = ml.solve(b, tol=tol, accel="cg", maxiter=500)
    out = zc.copy(); out[free] = zf
    return out.reshape(H, W), fixed.reshape(H, W)


def sample_bilinear(grid, xmin, ymax, res, x, y):
    fc = (x - xmin) / res - 0.5; fr = (ymax - y) / res - 0.5
    c0 = np.clip(np.floor(fc).astype(int), 0, grid.shape[1] - 2); r0 = np.clip(np.floor(fr).astype(int), 0, grid.shape[0] - 2)
    tc = np.clip(fc - c0, 0, 1); tr = np.clip(fr - r0, 0, 1)
    g = grid
    return (g[r0, c0] * (1 - tc) * (1 - tr) + g[r0, c0 + 1] * tc * (1 - tr)
            + g[r0 + 1, c0] * (1 - tc) * tr + g[r0 + 1, c0 + 1] * tc * tr)


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[r].astype(np.uint8).tobytes() for r in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--res", type=float, default=5.0, help="격자 크기(m)")
    ap.add_argument("--step", type=float, default=2.5, help="등고선 꼭짓점 보강 간격(m)")
    ap.add_argument("--holdout", type=float, default=0.1, help="검증용으로 빼둘 표고점 비율")
    ap.add_argument("--method", choices=["tin", "spline"], default="spline", help="tin: 삼각망 선형, spline: 장력 스플라인")
    ap.add_argument("--tension", type=float, default=0.25, help="spline 장력 (0=매끈, 1=팽팽)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    xy, z, src, n_lines, levels, counts = collect_points(a.src, a.step)
    xmin, ymin, xmax, ymax, bsrc = sheet_bounds(a.src, xy, 0)
    with open(os.path.join(a.src, "N3L_F0010000.prj"), encoding="ascii", errors="ignore") as f:
        crs_wkt = f.read()

    # ── 품질 검증: 표고점 일부를 빼고 예측해 본다
    rng = np.random.default_rng(0)
    spot_idx = np.where(src == 1)[0]
    hold = rng.choice(spot_idx, size=max(1, int(len(spot_idx) * a.holdout)), replace=False)
    keep = np.ones(len(z), bool); keep[hold] = False

    W = int(math.ceil((xmax - xmin) / a.res)); H = int(math.ceil((ymax - ymin) / a.res))
    gx = xmin + (np.arange(W) + 0.5) * a.res
    gy = ymax - (np.arange(H) + 0.5) * a.res
    GX, GY = np.meshgrid(gx, gy)

    # TIN은 두 방법 모두에서 범위(볼록 껍질)와 평평한 삼각형 진단에 쓴다
    tri = Delaunay(xy)
    tin_grid = LinearNDInterpolator(tri, z)(GX, GY)
    hull = ~np.isnan(tin_grid)
    tz = z[tri.simplices]
    flat = (tz.max(1) - tz.min(1)) < 1e-6
    p = xy[tri.simplices]
    area = 0.5 * np.abs((p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1]))

    if a.method == "tin":
        pred = LinearNDInterpolator(xy[keep], z[keep])(xy[hold])
        dem = tin_grid.astype(np.float32)
    else:
        g_hold, _ = spline_grid(xy[keep], z[keep], xmin, ymax, W, H, a.res, a.tension)
        pred = sample_bilinear(g_hold, xmin, ymax, a.res, xy[hold, 0], xy[hold, 1])
        g, _ = spline_grid(xy, z, xmin, ymax, W, H, a.res, a.tension)
        dem = np.where(hull, g, np.nan).astype(np.float32)
    ok = ~np.isnan(pred)
    err = pred[ok] - z[hold][ok]
    nodata = -9999.0
    valid = ~np.isnan(dem)

    dz_dy, dz_dx = np.gradient(np.where(valid, dem, np.nan), a.res)
    slope = (np.hypot(dz_dx, dz_dy) * 100).astype(np.float32)

    transform = from_origin(xmin, ymax, a.res, a.res)
    prof = dict(driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=crs_wkt,
                transform=transform, nodata=nodata, compress="deflate")
    with rasterio.open(os.path.join(a.out, "dem.tif"), "w", **prof) as ds:
        ds.write(np.where(valid, dem, nodata).astype(np.float32), 1)
    with rasterio.open(os.path.join(a.out, "slope_pct.tif"), "w", **prof) as ds:
        ds.write(np.where(np.isnan(slope), nodata, slope).astype(np.float32), 1)

    # ── 미리보기: 음영기복 + 표고 색 + 5m 등고선 + 입력 표고점
    d = np.where(valid, dem, np.nanmin(dem))
    sy, sx = np.gradient(d, a.res)
    sl = np.arctan(np.hypot(sx, sy)); asp = np.arctan2(-sx, sy)
    hs = np.clip(np.sin(math.radians(45)) * np.cos(sl) + np.cos(math.radians(45)) * np.sin(sl) * np.cos(math.radians(315) - asp), 0, 1)
    e = (d - np.nanmin(dem)) / max(1e-6, np.nanmax(dem) - np.nanmin(dem))
    rgb = np.dstack([(70 + 170 * e), (130 + 90 * e), (80 + 60 * e)]) * (0.4 + 0.6 * hs)[..., None]
    band = np.floor(d / 5.0)
    edge = np.zeros_like(valid)
    edge[:-1, :] |= band[:-1, :] != band[1:, :]
    edge[:, :-1] |= band[:, :-1] != band[:, 1:]
    rgb[edge & valid] = rgb[edge & valid] * 0.55
    rgb[~valid] = (235, 235, 235)
    for (x, y), s in zip(xy, src):
        if s == 0:
            continue
        c = int((x - xmin) / a.res); r = int((ymax - y) / a.res)
        if 0 <= r < H and 0 <= c < W:
            rgb[max(0, r - 1):r + 2, max(0, c - 1):c + 2] = (200, 30, 30)
    write_png(os.path.join(a.out, "preview.png"), np.clip(rgb, 0, 255))

    sv = slope[valid & ~np.isnan(slope)]
    lines = [
        f"입력 폴더: {a.src}",
        f"방법: {a.method}" + (f" (장력 {a.tension})" if a.method == "spline" else ""),
        f"출력 범위: {bsrc}  x {xmin:.1f}~{xmax:.1f}, y {ymin:.1f}~{ymax:.1f}",
        f"격자: {a.res} m, {W} x {H} = {W*H:,} 칸, 값 있는 칸 {valid.mean():.1%}",
        f"등고선: {n_lines}개, 높이 {levels[0] if levels else '-'}~{levels[-1] if levels else '-'} m, 간격 {np.diff(levels).min() if len(levels) > 1 else '-'} m",
        f"점 표고: {counts}",
        f"보간에 쓴 점: {len(z):,}개 (등고선 꼭짓점 {int((src==0).sum()):,}, 점 표고 {int((src>0).sum())})",
        f"표고 범위: {np.nanmin(dem):.2f} ~ {np.nanmax(dem):.2f} m",
        "",
        "[품질 1] 표고점 일부를 빼고 예측한 오차",
        f"  뺀 점 {len(hold)}개 중 예측 가능 {ok.sum()}개: 평균오차 {err.mean():+.2f} m, RMSE {np.sqrt((err**2).mean()):.2f} m, 최대 |오차| {np.abs(err).max():.2f} m",
        "",
        "[품질 2] TIN의 평평한 삼각형 (세 꼭짓점이 같은 등고선 위 → TIN에서는 경사 0으로 왜곡. spline은 이 영역을 매끈하게 채움)",
        f"  {flat.sum():,} / {len(flat):,} 개, 면적 비율 {area[flat].sum() / area.sum():.1%}",
        "",
        "[경사 분포] (%)",
        "  " + ", ".join(f"p{q}={np.percentile(sv, q):.1f}" for q in (10, 25, 50, 75, 90, 99)),
        "  " + ", ".join(f">{t}%: {(sv > t).mean():.1%}" for t in (5.6, 8.3, 20)),
        f"  경사 0.1% 미만 칸: {(sv < 0.1).mean():.1%}",
    ]
    report = "\n".join(lines)
    with open(os.path.join(a.out, "report.txt"), "w", encoding="utf-8") as f:
        f.write(report + "\n")
    sys.stdout.buffer.write((report + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
