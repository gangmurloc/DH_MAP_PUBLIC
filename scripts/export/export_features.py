"""공개 데이터 내보내기 (TK-308, TK-309): 레이어별 GeoJSON·CSV와 manifest.json을 만든다.

사용법:
    python -I export_features.py --api https://<ref>.supabase.co --out data/exports       # 공개 API(/features), 표준 라이브러리만
    python -I export_features.py --dsn postgresql://... --out data/exports               # DB 함수 public.features 직접 (psycopg)
        [--all-segments]   구간 전체(약 3만 개, GeoJSON 약 20MB). 기본은 조사된 구간(통행 가능·주의·통행 어려움)만
        [--layers segments obstacles crossings places]

/features는 한 번에 1,000건까지라 시 범위를 사분할하며 받는다 (꽉 찬 칸만 다시 나눔, id로 중복 제거).
조사 전 구간망은 파이프라인(donghae_pipeline.py)으로 다시 만들 수 있으므로 기본 내보내기는 조사 결과만 담는다.
공개 API는 측정 원자료·조사자·등급 변경 사유를 내보내지 않는다. 그것까지 보관하려면 `supabase db dump --data-only`.
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CITY_BBOX = (128.95, 37.42, 129.20, 37.62)   # 동해시 행정경계를 넉넉히 감싼 범위
LIMIT = 1000
MIN_SPAN = 0.0005                            # 이보다 작은 칸은 더 나누지 않음 (같은 곳에 1,000건 이상 = 이상)
SURVEYED = ["passable", "caution", "difficult"]


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/") + "/functions/v1/features"

    def get(self, layer, bbox, grade):
        q = {"layer": layer, "bbox": ",".join(f"{v:.6f}" for v in bbox), "limit": LIMIT}
        if grade:
            q["grade"] = ",".join(grade)
        url = self.base + "?" + urllib.parse.urlencode(q)
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "donghae-barrier-free-export"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r)["features"]
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 3:
                    raise
                print(f"  재시도 {attempt + 1}: {e}", file=sys.stderr)
                time.sleep(2 ** attempt)


class Db:
    def __init__(self, dsn):
        import psycopg
        self.conn = psycopg.connect(dsn, autocommit=True)

    def get(self, layer, bbox, grade):
        row = self.conn.execute("select public.features(%s::float8[], %s, %s::text[], null, null, %s)",
                                (list(bbox), layer, grade, LIMIT)).fetchone()
        return row[0]["features"]


def fetch(src, layer, grade, stats):
    found, stack = {}, [CITY_BBOX]
    while stack:
        b = stack.pop()
        feats = src.get(layer, b, grade)
        stats["requests"] += 1
        for f in feats:
            found[f["id"]] = f
        if len(feats) >= LIMIT:
            w, s, e, n = b
            if e - w < MIN_SPAN:
                sys.exit(f"{layer}: {b} 안에 {LIMIT}건 이상이 몰려 있어 나눌 수 없습니다")
            mx, my = (w + e) / 2, (s + n) / 2
            stack += [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]
    return [found[k] for k in sorted(found)]


def wkt(g):
    t, c = g["type"], g["coordinates"]
    if t == "Point":
        return f"POINT({c[0]} {c[1]})"
    if t == "LineString":
        return "LINESTRING(" + ",".join(f"{x} {y}" for x, y in c) + ")"
    if t == "MultiLineString":
        return "MULTILINESTRING(" + ",".join("(" + ",".join(f"{x} {y}" for x, y in p) + ")" for p in c) + ")"
    return json.dumps(g)


def write(out, layer, feats, license_text):
    with open(os.path.join(out, f"{layer}.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "license": license_text, "features": feats}, f, ensure_ascii=False)
    keys = []
    for ft in feats:
        for k in ft["properties"]:
            if k not in keys:
                keys.append(k)
    with open(os.path.join(out, f"{layer}.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(keys + ["geometry_wkt"])
        for ft in feats:
            p = ft["properties"]
            w.writerow([json.dumps(p.get(k), ensure_ascii=False) if isinstance(p.get(k), (dict, list)) else p.get(k)
                        for k in keys] + [wkt(ft["geometry"])])


LICENSE = {   # supabase/functions/_shared/http.ts의 LICENSE와 같은 문구
    "segments": "구간 형상: 국토지리정보원 수치지도(공공누리 제1유형, 출처 표시). 조사 데이터: 동해 무장애지도",
    "obstacles": "동해 무장애지도 조사단 (공개 라이선스 동의 제보 포함)",
    "crossings": "전국횡단보도표준데이터(공공데이터포털)를 구간망 노드에 연결",
    "places": "국토지리정보원 수치지도 건물 이름·철도역 (공공누리 제1유형, 출처 표시)",
}


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--api", default=os.environ.get("SUPABASE_URL"))
    g.add_argument("--dsn")
    ap.add_argument("--out", required=True)
    ap.add_argument("--all-segments", action="store_true")
    ap.add_argument("--layers", nargs="+", default=["segments", "obstacles", "crossings", "places"], choices=list(LICENSE))
    a = ap.parse_args()
    src = Db(a.dsn) if a.dsn else Api(a.api)
    os.makedirs(a.out, exist_ok=True)

    manifest = {"exported_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "source": "db" if a.dsn else "api", "segments_scope": "all" if a.all_segments else "surveyed", "layers": {}}
    t0 = time.time()
    for layer in a.layers:
        stats = {"requests": 0}
        grade = None if (layer != "segments" or a.all_segments) else SURVEYED
        feats = fetch(src, layer, grade, stats)
        write(a.out, layer, feats, LICENSE[layer])
        info = {"count": len(feats), "requests": stats["requests"]}
        if layer == "segments":
            info["grades"] = {}
            for f in feats:
                info["grades"][f["properties"]["grade"]] = info["grades"].get(f["properties"]["grade"], 0) + 1
        manifest["layers"][layer] = info
        print(f"{layer}: {len(feats)}건 (요청 {stats['requests']}회)")
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"완료 {time.time() - t0:.1f}초 → {a.out}")


if __name__ == "__main__":
    main()
