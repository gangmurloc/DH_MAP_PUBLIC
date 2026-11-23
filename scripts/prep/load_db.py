"""donghae_pipeline.py 결과(GeoJSON)를 Supabase(Postgres)에 넣는 SQL을 만들고, 원하면 바로 실행한다.

사용법:
    python -I load_db.py <파이프라인 출력 폴더> [--sql seed.sql] [--dsn postgresql://...] [--force]

    --sql   적재 SQL 파일 경로 (기본: <출력 폴더>/seed.sql). Supabase SQL Editor에 붙여 넣어도 된다.
    --dsn   주면 psycopg로 바로 실행. 환경 변수 DATABASE_URL도 읽는다. (DB 비밀번호가 들어가므로 저장소·채팅에 남기지 않는다)
    --force 조사 기록(segment_surveys)이 이미 있어도 구간망을 다시 넣는다. 조사 결과가 지워지므로 주의.
"""
import argparse
import json
import os


def q(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def arr(v):
    return "array[" + ",".join(q(x) for x in v) + "]::text[]" if v else "'{}'::text[]"


def pt(c):
    return f"st_setsrid(st_makepoint({c[0]!r},{c[1]!r}),4326)"


def line(cs):
    return "st_geomfromtext('LINESTRING(" + ",".join(f"{x!r} {y!r}" for x, y in cs) + ")',4326)"


def batches(rows, n=500):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


def build_sql(folder, force):
    load = lambda n: json.load(open(os.path.join(folder, n), encoding="utf-8"))["features"]
    nodes, segs, cws, places = load("nodes.geojson"), load("segments.geojson"), load("crosswalks.geojson"), load("places.geojson")
    out = ["-- 동해 무장애지도 구간망 적재 (scripts/prep/load_db.py가 생성)", "begin;"]
    if not force:
        out.append("do $$ begin if exists (select 1 from public.segment_surveys) or exists (select 1 from public.obstacles) then "
                   "raise exception '조사 기록이나 장애물이 이미 있습니다. 구간망을 다시 넣으면 연결이 끊깁니다. --force로만 진행하세요.'; end if; end $$;")
    out.append("truncate public.places, public.crosswalks, public.segments, public.nodes restart identity cascade;")

    for b in batches(nodes):
        vals = []
        for f in b:
            p = f["properties"]
            vals.append(f"({p['id']},{pt(f['geometry']['coordinates'])},{p['degree']},{q(p['crossing'])},{p['crossing_count']},"
                        f"{q(p['crossing_kerb'])}::public.kerb_kind,{q(p['crossing_ambiguous'])},{q(p['crossing_source'])})")
        out.append("insert into public.nodes (id,geom,degree,crossing,crossing_count,crossing_kerb,crossing_ambiguous,crossing_source) values\n" + ",\n".join(vals) + ";")

    cols = ["id", "source", "target", "length_m", "kind", "road_class", "road_name", "road_width_m", "lanes", "paved", "has_sidewalk",
            "sidewalk_width_m", "sidewalk_surface", "on_bridge", "near_stairs", "near_wall", "near_cut",
            "in_tunnel", "underpass_no_sidewalk", "overpass_nearby", "z_start", "z_end",
            "dem_incline_pct", "dem_incline_max_pct"]
    # OSM으로 보완한 구간(kind osm_*)은 ODbL이라 DB에 넣지 않는다 (osm_paths.py, HANDOFF 3절)
    segs = [f for f in segs if not str(f["properties"].get("kind") or "").startswith("osm")]
    for b in batches(segs):
        vals = []
        for f in b:
            p = f["properties"]
            vals.append("(" + ",".join(q(p.get(c)) for c in cols) + f",{q(p['dem_estimate'])}::public.dem_estimate,{arr(p['check_items'])},"
                        f"{line(f['geometry']['coordinates'])})")
        out.append(f"insert into public.segments ({','.join(cols)},dem_estimate,check_items,geom) values\n" + ",\n".join(vals) + ";")

    ccols = ["node_id", "node_dist_m", "manage_no", "kind", "road_name", "lanes", "width_m", "length_m"]
    for b in batches(cws):
        vals = []
        for f in b:
            p = f["properties"]
            vals.append("(" + ",".join(q(p.get(c)) for c in ccols) + f",{q(p['kerb'])}::public.kerb_kind,{q(p['raised_table'])},{q(p['tactile'])},"
                        f"{q(p['ped_signal'])},{q(p['island'])},{q(p['data_date'])}::date,{pt(f['geometry']['coordinates'])})")
        if vals:
            out.append(f"insert into public.crosswalks ({','.join(ccols)},kerb,raised_table,tactile,ped_signal,island,data_date,geom) values\n" + ",\n".join(vals) + ";")

    if places:
        vals = [f"({q(f['properties']['name'])},{q(f['properties']['category'])},{pt(f['geometry']['coordinates'])},{f['properties']['nearest_node']})" for f in places]
        out.append("insert into public.places (name,category,geom,nearest_node) values\n" + ",\n".join(vals) + ";")

    out.append("analyze public.nodes; analyze public.segments;")
    out.append("commit;")
    return "\n".join(out) + "\n", dict(nodes=len(nodes), segments=len(segs), crosswalks=len(cws), places=len(places))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--sql")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    sql, counts = build_sql(a.folder, a.force)
    path = a.sql or os.path.join(a.folder, "seed.sql")
    with open(path, "w", encoding="utf-8") as f:
        f.write(sql)
    print(f"SQL 작성: {path} ({os.path.getsize(path)/1024/1024:.1f} MB) {counts}")
    if a.dsn:
        import psycopg
        with psycopg.connect(a.dsn, autocommit=True) as conn:
            conn.execute(sql)
        print("DB 적재 완료")


if __name__ == "__main__":
    main()
