"""현장 검증 페이지(HTML)를 만든다: 수치지형도 배경 지도 + 시험 지점 + 측정 입력.

사용법:
    python -I make_fieldpage.py <수치지도 SHP 폴더> <dem.tif> <checkpoints.json> <템플릿.html> <출력.html>
        [--mpp 1.2] [--margin 70]

배경 지도는 외부 타일 없이 PNG로 그려 HTML에 넣는다 (artifact는 외부 이미지를 불러올 수 없음).
"""
import argparse
import base64
import json
import math
import os
import struct
import warnings
import zlib

import numpy as np
import rasterio
import shapefile
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import transform as warp

warnings.simplefilter("ignore")
ENC = "cp949"


def geoms(folder, name):
    p = os.path.join(folder, name + ".shp")
    if not os.path.exists(p):
        return []
    out = []
    for s in shapefile.Reader(p, encoding=ENC).shapes():
        gi = s.__geo_interface__
        if gi and gi.get("coordinates"):
            out.append(gi)
    return out


def png_bytes(rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[r].astype(np.uint8).tobytes() for r in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dem"); ap.add_argument("points"); ap.add_argument("template"); ap.add_argument("out")
    ap.add_argument("--mpp", type=float, default=0.6, help="배경 지도 1픽셀당 미터 (작을수록 확대해도 선명)")
    ap.add_argument("--margin", type=float, default=70)
    a = ap.parse_args()

    pts = json.load(open(a.points, encoding="utf-8"))
    ds = rasterio.open(a.dem)
    xs, ys = warp("EPSG:4326", ds.crs, [p["lon"] for p in pts], [p["lat"] for p in pts])
    x0, x1 = min(xs) - a.margin, max(xs) + a.margin
    y0, y1 = min(ys) - a.margin, max(ys) + a.margin
    W = int(math.ceil((x1 - x0) / a.mpp)); H = int(math.ceil((y1 - y0) / a.mpp))
    T = from_origin(x0, y1, a.mpp, a.mpp)

    # DEM 음영 (격자 → 배경 해상도로 최근접 샘플)
    dem = ds.read(1).astype(float); dem[dem == ds.nodata] = np.nan
    gx = x0 + (np.arange(W) + 0.5) * a.mpp; gy = y1 - (np.arange(H) + 0.5) * a.mpp
    fc = (gx - ds.transform.c) / ds.transform.a - 0.5
    fr = (gy - ds.transform.f) / ds.transform.e - 0.5
    c0 = np.clip(np.floor(fc).astype(int), 0, dem.shape[1] - 2); r0 = np.clip(np.floor(fr).astype(int), 0, dem.shape[0] - 2)
    tc = np.clip(fc - c0, 0, 1)[None, :]; tr = np.clip(fr - r0, 0, 1)[:, None]
    R0, C0 = np.meshgrid(r0, c0, indexing="ij")
    d = (dem[R0, C0] * (1 - tc) * (1 - tr) + dem[R0, C0 + 1] * tc * (1 - tr)
         + dem[R0 + 1, C0] * (1 - tc) * tr + dem[R0 + 1, C0 + 1] * tc * tr)
    d = np.where(np.isnan(d), np.nanmean(d), d)
    sy, sx = np.gradient(d, a.mpp)
    sl = np.arctan(np.hypot(sx, sy)); asp = np.arctan2(-sx, sy)
    hs = np.clip(np.sin(math.radians(50)) * np.cos(sl) + np.cos(math.radians(50)) * np.sin(sl) * np.cos(math.radians(315) - asp), 0, 1)
    base = np.array([238, 236, 228], float)
    rgb = base[None, None, :] * (0.78 + 0.22 * hs[..., None])

    def paint(name, color, kind="poly", width=1):
        g = geoms(a.src, name)
        if not g:
            return
        if kind == "line":
            # 선은 가는 버퍼 대신 래스터화 후 팽창
            m = rasterize([(x, 1) for x in g], out_shape=(H, W), transform=T, all_touched=True).astype(bool)
            for _ in range(width - 1):
                m2 = m.copy(); m2[1:] |= m[:-1]; m2[:-1] |= m[1:]; m2[:, 1:] |= m[:, :-1]; m2[:, :-1] |= m[:, 1:]; m = m2
        else:
            m = rasterize([(x, 1) for x in g], out_shape=(H, W), transform=T).astype(bool)
        rgb[m] = color

    paint("N3A_A0010000", (255, 255, 255))            # 도로 면
    paint("N3A_A0033320", (226, 232, 214))            # 인도
    paint("N3L_A0020000", (252, 252, 250), "line", 3)  # 도로 중심선 (캠퍼스 안 길 포함)
    paint("N3L_A0033330", (214, 226, 200), "line", 2)  # 자전거보행자겸용도로
    paint("N3A_B0010000", (205, 199, 188))            # 건물
    paint("N3L_F0040000", (120, 110, 100), "line")    # 옹벽
    paint("N3A_C0390000", (196, 120, 70))             # 계단·스탠드
    paint("N3A_A0070000", (170, 190, 215))            # 교량
    # 5m 등고선 (DEM에서)
    band = np.floor(d / 5.0)
    edge = np.zeros((H, W), bool)
    edge[:-1] |= band[:-1] != band[1:]; edge[:, :-1] |= band[:, :-1] != band[:, 1:]
    rgb[edge] = rgb[edge] * 0.86
    png = png_bytes(np.clip(rgb, 0, 255))

    for p, x, y in zip(pts, xs, ys):
        p["px"] = round((x - x0) / (x1 - x0) * 100, 3)   # % 좌표
        p["py"] = round((y1 - y) / (y1 - y0) * 100, 3)

    # 위경도 → 지도 % 좌표 변환식 (1km 범위라 1차식으로 충분: 격자 25점으로 최소제곱)
    sx_, sy_ = np.meshgrid(np.linspace(x0, x1, 5), np.linspace(y0, y1, 5))
    slon, slat = warp(ds.crs, "EPSG:4326", sx_.ravel().tolist(), sy_.ravel().tolist())
    A = np.column_stack([slon, slat, np.ones(len(slon))])
    px = (sx_.ravel() - x0) / (x1 - x0) * 100
    py = (y1 - sy_.ravel()) / (y1 - y0) * 100
    cx, rx = np.linalg.lstsq(A, px, rcond=None)[:2]
    cy, ry = np.linalg.lstsq(A, py, rcond=None)[:2]
    fit_err_m = float(np.sqrt(np.mean((A @ cx - px) ** 2)) / 100 * (x1 - x0))

    meta = {"w": W, "h": H, "mpp": a.mpp, "widthM": round(x1 - x0), "heightM": round(y1 - y0),
            "geo": {"x": [float(v) for v in cx], "y": [float(v) for v in cy]}}
    html = open(a.template, encoding="utf-8").read()
    html = html.replace("__BASEMAP__", "data:image/png;base64," + base64.b64encode(png).decode())
    html = html.replace("/*__POINTS__*/[]", json.dumps(pts, ensure_ascii=False))
    html = html.replace("/*__META__*/{}", json.dumps(meta))
    open(a.out, "w", encoding="utf-8").write(html)
    # 독립 실행 버전: 일반 웹 서버(HTTPS)에서 열 때 쓰는 완전한 HTML 문서
    standalone = a.out.replace(".html", "_standalone.html")
    with open(standalone, "w", encoding="utf-8") as f:
        f.write('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'
                + html + "</body></html>")
    print(f"basemap {W}x{H}px ({len(png)/1024:.0f} KB), html {os.path.getsize(a.out)/1024:.0f} KB, "
          f"위경도→지도 변환 오차 {fit_err_m:.2f} m")


if __name__ == "__main__":
    main()
