"""현장에서 채운 점검표(survey_sheet.py의 sheet.csv)를 DB에 넣는 SQL을 만들고, 원하면 바로 실행한다.

사용법:
    python -I load_survey.py <sheet.csv> [더 많은 csv ...] --net <파이프라인 출력 폴더> --surveyor <조사원 uuid>
        [--source digital_level|phone_sensor|field_verified]  경사 측정 도구 (기본 digital_level)
        [--sql survey_load.sql]   만들 SQL 경로 (기본: 첫 csv 옆)
        [--dsn postgresql://...]  주면 바로 실행. 환경 변수 DATABASE_URL도 읽는다 (비밀번호가 들어가므로 저장소·채팅에 남기지 않는다)
        [--dry-run]               SQL 끝을 rollback으로: 실제로 넣지 않고 오류만 확인
        [--area app/src/data/area.json]  현장 조사판의 '추정 연결' 구간을 함께 처리한다. 현장에서 길이 확인되어
                                  통행 가능·주의로 완료한 연결은 구간망에 새 구간(같은 번호, kind='field_link')으로 넣고,
                                  통행 어려움(길 없음)으로 완료한 연결은 넣지 않는다. 이 옵션이 없으면 추정 연결은 건너뛴다

조사원 uuid: Supabase Auth 사용자 화면의 User UID (app_metadata.role = 'surveyor'인 계정).
SQL은 그 조사원으로 로그인한 것처럼(request.jwt.claims) 조사 함수(record_measurement, register_obstacle,
complete_survey)를 부른다. 앱에서 입력한 것과 같은 검사·기록이 남는다.

점검표 입력 칸 (빈칸이면 건너뜀):
    경사%       진행방위 쪽을 보고 오르막 +, 내리막 −. 구간에서 가장 가파른 곳
    횡경사%     참고 기록 (등급 기준 미정)
    장애물      턱 · 계단 · 좁음 · 파손 · 급경사
    턱높이cm    장애물이 비어 있으면 턱으로 본다
    폭cm        장애물이 비어 있고 120 미만이면 좁음으로 본다
    장애물위도·장애물경도  비우면 구간 가운데
    등급        통행가능 · 주의 · 통행어려움. 비우면 제안 등급을 그대로 쓴다. 제안과 다르면 사유 필수
    완료        o · 1 · y · v · 완료 중 하나면 조사 완료 처리 (빈칸이면 측정값만 넣고 등급은 그대로)
    메모        측정 기록에 함께 남김

같은 구간을 여러 행에 나눠 적어도 된다 (장애물이 여러 개일 때). 측정·장애물을 먼저 넣고 마지막에 한 번 완료한다.
같은 파일을 다시 넣어도 중복되지 않는다 (행 내용으로 만든 키로 확인). 값을 고쳐 다시 넣으면 새 측정으로 추가되고,
등급 제안은 측정값 중 가장 큰 |경사|를 쓰므로 잘못 넣은 큰 값은 DB에서 지워야 한다.
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys

OBSTACLE = {"턱": "kerb", "단차": "kerb", "계단": "stairs", "좁음": "narrow", "좁은길": "narrow", "좁은 길": "narrow",
            "파손": "damaged", "급경사": "steep",
            "kerb": "kerb", "stairs": "stairs", "narrow": "narrow", "damaged": "damaged", "steep": "steep"}
GRADE = {"통행가능": "passable", "가능": "passable", "passable": "passable",
         "주의": "caution", "caution": "caution",
         "통행어려움": "difficult", "어려움": "difficult", "difficult": "difficult"}
DONE = {"o", "O", "ㅇ", "1", "y", "Y", "v", "V", "✓", "✔", "완료", "yes", "true"}
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
NARROW_CM = 120
ASSUMED_ID0 = 900001   # area_bundle.LINK_ID0


def q(v):
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def read_csv(path):
    # 엑셀에서 'CSV'로 저장하면 CP949가 될 수 있다
    for enc in ("utf-8-sig", "cp949"):
        try:
            with open(path, encoding=enc, newline="") as f:
                return list(csv.DictReader(f))
        except UnicodeDecodeError:
            continue
    sys.exit(f"{path}: 인코딩을 읽을 수 없습니다 (UTF-8 또는 CP949로 저장해 주세요)")


def number(v, name, lo, hi, errs, where):
    v = (v or "").strip().replace("%", "").replace("cm", "").replace("−", "-").replace("＋", "+")
    if not v:
        return None
    try:
        x = float(v)
    except ValueError:
        errs.append(f"{where}: {name} '{v}'는 숫자가 아닙니다")
        return None
    if not lo <= x <= hi:
        errs.append(f"{where}: {name} {x}는 {lo}~{hi} 범위를 벗어났습니다")
        return None
    return x


def midpoint(coords):
    if len(coords) > 2:
        return coords[len(coords) // 2]
    return [(coords[0][0] + coords[-1][0]) / 2, (coords[0][1] + coords[-1][1]) / 2]


def parse(paths, segs, links=None):
    links = links or {}
    errs, warns, groups = [], [], {}
    for path in paths:
        base = os.path.basename(path)
        for i, r in enumerate(read_csv(path), start=2):   # 1행은 머리글
            where = f"{base} {i}행"
            r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
            sid = r.get("구간ID", "")
            if not sid:
                continue
            try:
                sid = int(float(sid))
            except ValueError:
                errs.append(f"{where}: 구간ID '{sid}'가 숫자가 아닙니다"); continue
            if sid >= ASSUMED_ID0 and sid in links:
                segs = {**segs, sid: links[sid]}
            elif sid >= ASSUMED_ID0:
                # area_bundle.py의 '연결 추정' 구간: DB 구간망에 없다. --area를 주면 현장 확인 결과대로 넣는다
                summary = ", ".join(f"{k} {v}" for k, v in r.items() if k in ("경사%", "장애물", "턱높이cm", "등급", "사유", "메모") and v)
                warns.append(f"{where}: 추정 연결 구간 {sid}은 DB에 없어 건너뜁니다 ({summary or '입력 없음'})")
                continue
            if sid not in segs:
                errs.append(f"{where}: 구간 {sid}이 구간망에 없습니다"); continue

            inc = number(r.get("경사%"), "경사%", -60, 60, errs, where)
            cross = number(r.get("횡경사%"), "횡경사%", -30, 30, errs, where)
            kerb = number(r.get("턱높이cm"), "턱높이cm", 0, 100, errs, where)
            width = number(r.get("폭cm"), "폭cm", 1, 1000, errs, where)
            olat = number(r.get("장애물위도"), "장애물위도", 37.3, 37.7, errs, where)
            olon = number(r.get("장애물경도"), "장애물경도", 128.9, 129.3, errs, where)
            heading = number(r.get("진행방위"), "진행방위", 0, 360, errs, where)
            mlat = number(r.get("측정위도"), "측정위도", 37.3, 37.7, errs, where)
            mlon = number(r.get("측정경도"), "측정경도", 128.9, 129.3, errs, where)
            dem_dir = number(r.get("DEM진행경사%"), "DEM진행경사%", -200, 200, errs, where)
            dem_max = number(r.get("DEM최대경사%"), "DEM최대경사%", 0, 200, errs, where)

            otype = None
            if r.get("장애물"):
                otype = OBSTACLE.get(r["장애물"].replace(" ", "")) or OBSTACLE.get(r["장애물"])
                if not otype:
                    errs.append(f"{where}: 장애물 '{r['장애물']}'는 턱·계단·좁음·파손·급경사 중 하나여야 합니다")
            elif kerb is not None:
                otype = "kerb"
            elif width is not None:
                if width < NARROW_CM:
                    otype = "narrow"
                else:
                    warns.append(f"{where}: 폭 {width:.0f}cm는 {NARROW_CM}cm 이상이라 기록하지 않습니다")
            if (olat is None) != (olon is None):
                errs.append(f"{where}: 장애물위도·장애물경도는 둘 다 쓰거나 둘 다 비웁니다")

            grade = None
            if r.get("등급"):
                grade = GRADE.get(r["등급"].replace(" ", ""))
                if not grade:
                    errs.append(f"{where}: 등급 '{r['등급']}'는 통행가능·주의·통행어려움 중 하나여야 합니다")
            done = r.get("완료", "") in DONE
            if r.get("완료") and not done:
                warns.append(f"{where}: 완료 칸 '{r['완료']}'를 완료로 보지 않았습니다 (o를 쓰세요)")
            if grade and not done:
                warns.append(f"{where}: 등급을 적었지만 완료 칸이 비어 있어 등급은 넣지 않습니다")

            # 부호 실수 확인 (내리막에 +를 붙인 경우)
            if inc is not None and dem_dir is not None and abs(inc) >= 4 and abs(dem_dir) >= 4 and inc * dem_dir < 0:
                warns.append(f"{where}: 측정 경사 {inc:+.1f}%와 DEM 진행 방향 경사 {dem_dir:+.1f}%의 부호가 반대입니다. "
                             "진행방위 쪽을 보고 오르막 +로 적었는지 확인 (등급에는 |값|만 쓰므로 영향 없음)")
            if inc is not None and dem_max is not None and abs(inc) < 3 and dem_max >= 10:
                warns.append(f"{where}: DEM은 {dem_max:.0f}%인데 측정은 {inc:+.1f}%입니다. 구간에서 가장 가파른 곳을 잰 게 맞는지")
            if done and inc is None and not grade and not otype:
                warns.append(f"{where}: 경사 측정 없이 완료합니다. 등급은 DEM 추정으로 제안된 값이 들어갑니다")

            memo = r.get("메모") or None
            key = hashlib.sha1(json.dumps([sid, inc, cross, otype, kerb, width, olat, olon, memo],
                                          ensure_ascii=False).encode()).hexdigest()[:12]
            g = groups.setdefault(sid, {"rows": [], "done": False, "grade": None, "reason": None, "link": links.get(sid)})
            if mlat is None or mlon is None:
                mlon, mlat = midpoint(segs[sid]["coords"])
            if otype and olat is None:
                olon, olat = midpoint(segs[sid]["coords"])
            g["rows"].append(dict(where=where, key=key, inc=inc, cross=cross, heading=heading, mlat=mlat, mlon=mlon,
                                  otype=otype, kerb=kerb, width=width if otype == "narrow" else None,
                                  olat=olat, olon=olon, memo=memo))
            if done:
                g["done"] = True
                if grade:
                    g["grade"] = grade
                if r.get("사유"):
                    g["reason"] = r["사유"]
    return groups, errs, warns


def build_sql(groups, surveyor, source, dry_run):
    claims = json.dumps({"sub": surveyor, "role": "authenticated", "app_metadata": {"role": "surveyor"}})
    out = ["-- load_survey.py가 만든 SQL. psql -v ON_ERROR_STOP=1 -f 로 실행", "begin;",
           f"select set_config('request.jwt.claims', {q(claims)}, true);"]
    for sid, g in groups.items():
        wh = ", ".join(r["where"] for r in g["rows"]).replace("'", "''").replace("%", "%%")
        body = []
        link = g.get("link")
        if link:
            if not g["done"] or g["grade"] == "difficult":
                continue   # 길이 없거나 아직 확인 전: 구간망에 넣지 않는다 (main에서 알림)
            wkt = "LINESTRING(" + ",".join(f"{x!r} {y!r}" for x, y in link["coords"]) + ")"
            body.append(
                f"  if not exists (select 1 from public.segments where id = {sid}) then\n"
                f"    insert into public.segments (id, source, target, geom, length_m, kind, road_class, check_items, source_data)\n"
                f"    values ({sid}, {link['s']}, {link['t']}, st_geomfromtext({q(wkt)}, 4326), {link['len']!r}, 'field_link',"
                f" '현장 확인 연결', '{{assumed_link}}', 'field_survey');\n"
                f"    raise notice '구간 {sid}: 현장에서 확인한 연결을 구간망에 추가했습니다 ({link['len']:.0f}m)';\n  end if;")
        for r in g["rows"]:
            tag = f"survey:{r['key']}"
            note = tag + (f" {r['memo']}" if r["memo"] else "")
            for mkey, val in (("incline", r["inc"]), ("cross_slope", r["cross"])):
                if val is None:
                    continue
                body.append(
                    f"  if not exists (select 1 from public.measurements where target_type = 'segment' and target_id = {sid}"
                    f" and key = '{mkey}' and note like {q(tag + '%')}) then\n"
                    f"    perform public.record_measurement('segment', {sid}, '{mkey}', {val!r}, '{source}',"
                    f" {q(r['heading']) if r['heading'] is not None and r['heading'] < 360 else 'null'}, {r['mlon']!r}, {r['mlat']!r}, {q(note)});\n"
                    f"    n_meas := n_meas + 1;\n  end if;")
            if r["otype"]:
                tags = json.dumps({"survey_key": r["key"], **({"memo": r["memo"]} if r["memo"] else {})}, ensure_ascii=False)
                body.append(
                    f"  if not exists (select 1 from public.obstacles where tags ->> 'survey_key' = {q(r['key'])}) then\n"
                    f"    res := public.register_obstacle('{r['otype']}', {r['olon']!r}, {r['olat']!r}, {q(r['kerb'])}, {q(r['width'])}, {q(tags)}::jsonb);\n"
                    f"    if (res ->> 'segment_id') is distinct from '{sid}' then\n"
                    f"      update public.obstacles set segment_id = {sid} where id = (res ->> 'obstacle_id')::bigint;\n"
                    f"      raise notice '구간 {sid}: 장애물 위치가 구간 %에 더 가까워 점검표대로 구간 {sid}에 붙였습니다', coalesce(res ->> 'segment_id', '(15m 밖)');\n"
                    f"    end if;\n    n_obs := n_obs + 1;\n  end if;")
        if g["done"]:
            body.append(
                f"  v_sug := (public.suggest_grade({sid}) ->> 'grade')::public.segment_grade;\n"
                f"  v_grade := coalesce({q(g['grade'])}::public.segment_grade, v_sug);\n"
                f"  if not exists (select 1 from public.segments where id = {sid} and grade_source = 'survey' and grade = v_grade) then\n"
                f"    perform public.complete_survey({sid}, v_grade, {q(g['reason'])});\n    n_done := n_done + 1;\n  end if;")
        if not body:
            continue
        out.append(
            "do $s$\ndeclare\n  res jsonb; v_sug public.segment_grade; v_grade public.segment_grade;\n"
            "  n_meas int := 0; n_obs int := 0; n_done int := 0;\nbegin\n" + "\n".join(body) +
            f"\n  raise notice '구간 {sid}: 측정 % · 장애물 % · 완료 %', n_meas, n_obs, n_done;\n"
            f"exception when others then\n"
            f"  raise exception '구간 {sid} ({wh}): %', sqlerrm using errcode = sqlstate;\nend\n$s$;")
    ids = ",".join(str(s) for s in groups)
    out.append(
        "select s.id as 구간, s.grade as 등급, s.grade_source as 출처,\n"
        "       (select max(abs(value)) from public.measurements m where m.target_type = 'segment' and m.target_id = s.id and m.key = 'incline') as 최대측정경사,\n"
        "       (select count(*) from public.obstacles o where o.segment_id = s.id and o.status in ('confirmed', 'verified')) as 장애물\n"
        f"from public.segments s where s.id in ({ids or 'null'}) order by s.id;")
    out.append("rollback; -- --dry-run" if dry_run else "commit;")
    return "\n".join(out) + "\n"


def load_links(path):
    """현장 조사판 area.json의 추정 연결 구간"""
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        area = json.load(f)
    return {s["id"]: {"coords": s["c"], "s": s["s"], "t": s["t"], "len": s["len"], "on_bridge": False}
            for s in area["segments"] if s.get("assumed")}


def load_net(folder):
    with open(os.path.join(folder, "segments.geojson"), encoding="utf-8") as f:
        feats = json.load(f)["features"]
    return {f["properties"]["id"]: {"coords": f["geometry"]["coordinates"], "on_bridge": f["properties"]["on_bridge"]}
            for f in feats}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--net", required=True, help="donghae_pipeline.py 출력 폴더 (segments.geojson)")
    ap.add_argument("--surveyor", required=True)
    ap.add_argument("--source", default="digital_level", choices=["digital_level", "phone_sensor", "field_verified"])
    ap.add_argument("--sql")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--area", help="현장 조사판 area.json (추정 연결 구간 처리)")
    a = ap.parse_args()
    if not UUID_RE.match(a.surveyor):
        sys.exit("--surveyor는 조사원 계정의 User UID(uuid)여야 합니다")

    groups, errs, warns = parse(a.csv, load_net(a.net), load_links(a.area))
    for sid, g in groups.items():
        if g.get("link"):
            if not g["done"]:
                warns.append(f"추정 연결 {sid}: 완료 표시가 없어 구간망에 넣지 않습니다")
            elif g["grade"] == "difficult":
                warns.append(f"추정 연결 {sid}: 통행 어려움({g['reason'] or '사유 없음'})으로 기록되어 구간망에 넣지 않습니다")
            else:
                warns.append(f"추정 연결 {sid}: 현장 확인됨 → 구간망에 새 구간으로 추가합니다 ({g['link']['len']:.0f}m 직선, 실제 길 모양은 아님)")
    for w in warns:
        print("확인:", w)
    if errs:
        for e in errs:
            print("오류:", e)
        sys.exit(f"오류 {len(errs)}건. 점검표를 고친 뒤 다시 실행하세요 (SQL을 만들지 않았습니다)")
    rows = sum(len(g["rows"]) for g in groups.values())
    n_inc = sum(r["inc"] is not None for g in groups.values() for r in g["rows"])
    n_obs = sum(bool(r["otype"]) for g in groups.values() for r in g["rows"])
    n_done = sum(g["done"] for g in groups.values())
    print(f"구간 {len(groups)}개 (행 {rows}): 경사 측정 {n_inc}, 장애물 {n_obs}, 완료 {n_done}")

    sql = build_sql(groups, a.surveyor, a.source, a.dry_run)
    path = a.sql or os.path.join(os.path.dirname(os.path.abspath(a.csv[0])), "survey_load.sql")
    with open(path, "w", encoding="utf-8") as f:
        f.write(sql)
    print(f"SQL 작성: {path}" + (" (dry-run: rollback으로 끝남)" if a.dry_run else ""))
    if a.dsn:
        import psycopg
        with psycopg.connect(a.dsn, autocommit=True) as conn:
            conn.add_notice_handler(lambda d: print(" ", d.message_primary))
            cur = conn.execute(sql)
        print("DB 반영 완료" if not a.dry_run else "dry-run 완료 (반영 안 함)")


if __name__ == "__main__":
    main()
