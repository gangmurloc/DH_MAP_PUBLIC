# 동해 무장애지도 백엔드

작성: 2026-11-16 · 갱신: 2026-11-19 (현장 조사 도구, 내보내기, OpenAPI) · 독자: 개발자, AI 코딩 에이전트
관련: [TECH_SPEC.md](TECH_SPEC.md) 3~6절을 구현한 내용과, 구현하면서 바뀐 점.

## 구성

| 위치 | 내용 |
| --- | --- |
| `scripts/prep/extract_sheets.py` | 수치지도 zip(1:5,000) 96장에서 필요한 레이어만 도엽별로 풀기 |
| `scripts/prep/build_dem.py` | 등고선·표고점 → 5m DEM (장력 스플라인, TIN 선택 가능) |
| `scripts/prep/donghae_pipeline.py` | 동해시 전체(기본) 또는 시연 지역(`--demo`) 보행 구간망 + 속성 + 횡단보도 + 주요 기관 + 점검표 |
| `scripts/prep/load_db.py` | 파이프라인 결과 → 적재 SQL (`seed.sql`), `--dsn`이면 바로 실행 |
| `scripts/survey/survey_sheet.py` | 출발→도착 경로(최단 A + DEM 우회 B) 위 구간 점검표 `sheet.csv`, `routes.geojson` |
| `scripts/survey/load_survey.py` | 현장에서 채운 점검표 → 조사원 이름으로 측정·장애물·조사 완료 SQL, `--dsn`이면 바로 실행 |
| `scripts/export/export_features.py` | 공개 데이터 GeoJSON·CSV 내보내기 (API 또는 DB), `.github/workflows/export.yml`이 수동 실행 |
| `docs/openapi.yaml` | 공개 API 명세 (OpenAPI 3.1) |
| `supabase/migrations/…_schema.sql` | 테이블 13개, 값 정의, 공간 인덱스, 등급 기준값 |
| `supabase/migrations/…_functions.sql` | `suggest_grade`, `complete_survey`, `record_measurement`, `register_obstacle`, `resolve_report`, `resolve_obstacle`, 제보 트리거, `route`, `features`, `health` |
| `supabase/migrations/…_rls.sql` | RLS: 읽기 정책, 시민 제보 insert만 직접 쓰기 |
| `supabase/functions/{features,route,health}` | 공개 API (로그인 없이, service_role로 DB 함수 호출) |
| `supabase/tests/smoke.sql` | 배포 후 확인 (rollback으로 끝남) |
| `supabase/tests/roles.sql` | 역할·권한·업무 규칙 30개 PASS/FAIL (rollback으로 끝남) |
| `supabase/tests/local_shim.sql` | 로컬 Postgres에서 Supabase 역할·`auth` 함수를 흉내 내는 준비 SQL (운영에 쓰지 않음) |

## 실행 순서

```bash
pip install -r scripts/prep/requirements.txt        # numpy scipy rasterio pyshp pyamg shapely psycopg
cd scripts/prep
python -I extract_sheets.py "../../동해 경사" raw/donghae_5000
python -I donghae_pipeline.py raw/donghae_5000 ../../전국횡단보도표준데이터.csv out/donghae   # 동해시 전체, 약 2분 30초 (--demo: 시연 지역만)
python -I load_db.py out/donghae                    # out/donghae/seed.sql 생성

# Supabase 프로젝트가 생기면 (M-2)
supabase link --project-ref <ref>
supabase db push                                    # 마이그레이션 3개
psql "$DATABASE_URL" -f scripts/prep/out/donghae/seed.sql   # 13.8MB라 SQL Editor 붙여넣기는 안 됨, psql로
supabase functions deploy features route health
# SQL Editor에서 supabase/tests/smoke.sql, supabase/tests/roles.sql 실행 (roles.sql은 마지막 표에 FAIL 0이어야 함)
```

### Supabase 없이 로컬에서 확인 (2026-11-17 실제로 한 방법)

PostgreSQL 17 + PostGIS 3.7 묶음(pgRouting 4.0 포함, download.osgeo.org/postgis/windows/pg17)으로 임시 클러스터를 띄운다.

```bash
initdb -D <임시폴더> -U postgres -A trust -E UTF8 --locale=C
pg_ctl -D <임시폴더> -o "-p 55432 -c listen_addresses=127.0.0.1" start
psql -p 55432 -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/local_shim.sql
for f in supabase/migrations/*.sql; do psql -p 55432 -U postgres -v ON_ERROR_STOP=1 -f "$f"; done
psql -p 55432 -U postgres -f scripts/prep/out/donghae/seed.sql
psql -p 55432 -U postgres -f supabase/tests/smoke.sql
psql -p 55432 -U postgres -f supabase/tests/roles.sql
```

Supabase는 pgRouting 3.x다. 쓰는 함수는 `pgr_dijkstra`(4인자) 하나라 두 버전 모두 같다.

조사원 계정: Supabase Auth에서 사용자를 만들고 `app_metadata`에 `{"role": "surveyor"}`를 넣는다 (TK-105).

## 공개 API

| 요청 | 예 |
| --- | --- |
| `GET /features` | `?layer=segments&bbox=129.10,37.51,129.12,37.53&grade=passable,caution&limit=500` |
| | `layer`: `segments` · `obstacles` · `crossings`(횡단보도 노드) · `places`(주요 기관 75곳). 한 번에 최대 1,000건이라 시 전체 구간은 `bbox`로 나눠 받는다 |
| `GET /route` | `?from=129.10404,37.52769&to=129.09933,37.51416&caution=true` (터미널 → 청소년센터) |
| `GET /health` | `{"ok": true}` |

`/route` 응답: `accessible`(조사된 통행 가능·주의 구간만), `general`(전체 구간 최단), `compare`(추가 거리, 일반 경로의 장애물·통행 어려움·미조사 수), 경로가 없으면 `message`와 `blocked_segment_ids`. 전체 명세는 [openapi.yaml](openapi.yaml).

## 현장 조사 입력 (TK-404)

앱 조사 화면이 없어도 점검표(CSV)로 조사 결과를 넣는다. 앱과 같은 DB 함수를 조사원 이름으로 부르므로 검사·기록이 같다.

```bash
cd scripts/survey
python -I survey_sheet.py ../prep/out/donghae --stops 동해시종합버스터미널 동해시청 --out ../prep/out/survey/terminal_cityhall
#   → sheet.csv (점검표), routes.geojson (geojson.io에 끌어다 놓으면 A 빨강·B 파랑), summary.txt
# 현장: 행마다 '측정위도·측정경도'(DEM이 가장 가파르다고 본 곳) 근처에서 구간의 가장 가파른 곳을 디지털 수평계로 잼
#       '진행방위' 쪽을 보고 오르막 +, 내리막 −. 턱·계단은 장애물 칸. 끝나면 완료 칸에 o
python -I load_survey.py 채운파일.csv --net ../prep/out/donghae --surveyor <조사원 User UID> --dry-run   # 오류만 확인
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 채운파일옆/survey_load.sql                                   # 또는 --dsn
```

- **경로 두 개를 함께 조사해야 한다.** 무장애 경로는 조사된 구간만 쓰므로, 최단 경로(A)만 조사하면 A에 통행 어려움이 하나라도 있을 때 무장애 경로가 없다. 점검표에는 DEM 급경사(×10)·보도 없는 지하차도(×50)를 비싸게 친 우회 경로(B)가 함께 들어간다.
- 등급 칸을 비우면 제안 등급을 쓴다. 제안과 다르게 적으면 사유 칸이 필요하다 (없으면 해당 구간·CSV 행 번호와 함께 전체가 거부됨).
- 측정 경사와 DEM 진행 방향 경사의 부호가 반대면(둘 다 4% 이상) 경고한다. 내리막에 +를 붙인 실수를 잡는다.
- 같은 파일을 다시 넣어도 중복되지 않는다 (행 내용 해시를 측정 메모·장애물 태그에 남겨 확인). 값을 고쳐 다시 넣으면 새 측정이 추가되고 제안은 최대 |경사|를 쓰므로, 잘못 넣은 큰 값은 DB에서 지운다.
- 엑셀에서 CSV로 저장해 CP949가 되어도 읽는다.
- **조사를 시작한 뒤에는 파이프라인을 다시 돌려 구간망을 바꾸지 않는다.** 구간 ID가 바뀌어 점검표와 조사 기록이 어긋난다. `load_db.py`는 조사 기록이 있으면 적재를 거부한다 (`--force`는 조사 기록을 지움).

**시연 경로 후보** (2026-11-19, 점검표로 비교)

| 출발 → 도착 | A 최단 | B 우회 | 점검표 행 | 비고 |
| --- | --- | --- | --- | --- |
| **동해시종합버스터미널 → 동해시청** (권장) | 1,214m, DEM 급경사 368m | 1,385m, 급경사 84m | 96 | 일상적인 동선, 두 경로 차이가 뚜렷 |
| 동해시종합버스터미널 → 동해시청소년센터 (기존) | 4,391m, 급경사 2,810m | 4,469m, 급경사 2,574m | 161 | 길고 산길이라 하루 조사로 무리, 우회 효과 작음 |
| 묵호역 → 묵호노인종합복지관 | 313m, 급경사 151m | 597m, 급경사 84m | 31 | 짧은 예비 경로 |
| 동해시청 → 동해시보건소 | 567m, 급경사 107m | 875m, 급경사 79m | 31 | 짧은 예비 경로 |

로컬 DB에서 터미널→시청 점검표를 가짜 값(A에만 있는 DEM 급경사 구간 9.5%, 나머지 ≤4.8%, 턱 1곳)으로 채워 넣었더니 `route`가 일반 경로 1,214m(통행 어려움 13), 무장애 경로 1,385m(+170m)로 갈렸다. 다시 넣어도 추가 0건.

## 내보내기 (TK-308, TK-309)

```bash
python -I scripts/export/export_features.py --api https://<ref>.supabase.co --out data/exports   # 표준 라이브러리만
python -I scripts/export/export_features.py --dsn "$DATABASE_URL" --out data/exports            # DB 직접
```

- 레이어마다 `<layer>.geojson`, `<layer>.csv`(geometry_wkt 열, QGIS에서 열림), `manifest.json`(시각, 건수, 등급별 수)
- 기본은 **조사된 구간만** 내보낸다. 조사 전 구간망은 파이프라인으로 다시 만들 수 있어서다. `--all-segments`면 3만 구간 전부(GeoJSON 약 20MB, 요청 125회, 약 7초)
- 1,000건 한도 때문에 시 범위를 사분할하며 받는다. 로컬에서 전체 30,596건이 빠짐없이 나오고, API 방식과 DB 방식 결과 파일이 같음을 확인
- GitHub Actions `export` 워크플로: Actions 탭에서 수동 실행 → `data/exports/`에 커밋 (데이터가 바뀐 때만). 저장소 변수 `SUPABASE_URL`이 필요하다 (키는 필요 없음)
- 공개 API는 측정 원자료·조사자·등급 변경 사유를 내보내지 않는다. 그것까지 보관하려면 본선 중 `supabase db dump --data-only -f backup.sql` (DB 비밀번호가 필요하므로 운영자가 직접)

## 등급 제안 규칙 (`suggest_grade`)

기준값은 `grading_params` 테이블에 있어 현장 보정(T4) 후 SQL 한 줄로 바꾼다.

| 근거 | 규칙 |
| --- | --- |
| 측정한 진행 방향 경사 | > 8.3% 통행 어려움, > 5.6% 주의 |
| 측정이 없으면 DEM 30m 창 최대 경사 | > 8.3% 통행 어려움, ≥ 4.0% 주의(측정 필요). DEM은 경사를 낮게 보는 경향이라 보수적으로 |
| 교량 위·터널 안 | 측정 전까지 주의 이상 |
| 보도 없는 지하차도 (수치지도 입체교차부 '보도 무') | 통행 어려움 |
| 장애인 이용 불가 육교와 겹침 | 등급 영향 없음, 사유에 참고 (길 건너기 확인용) |
| 계단 | 통행 어려움 |
| 턱 (높이 측정값) | > 5cm 통행 어려움 (임시값), > 2cm 주의, 높이 미측정 주의 |
| 좁은 길 (폭) | < 0.9m 통행 어려움 (임시값), < 1.2m 주의 |
| 파손·급경사 장애물 | 주의 |
| 횡경사 | 기준 미정 → 사유에 참고로만 기록 |

조사원이 제안과 다르게 정하면 사유가 없으면 거부된다 (`complete_survey`, 표 제약 조건 둘 다).

## TECH_SPEC과 달라진 점

| 항목 | TECH_SPEC | 구현 | 이유 |
| --- | --- | --- | --- |
| 구간망 원천 | OSM (OSMnx) | **수치지도 1:5,000 도로 중심선 (2025)** | 오프라인으로 바로 사용, 최신, 도로 폭·차로 수 속성, 공공누리 1유형이라 라이선스 단순. `segments.source_data`에 출처 기록, `osm_way_id` 없음 |
| DEM | 국토지리정보원 공개 DEM | **수치지도 등고선(5m)·표고점으로 만든 5m DEM** | 공개 DEM은 90m 격자 (37905.img 확인, B-2) |
| 국가 데이터 | 보도 SHP 별도 | 같은 수치지도의 인도·계단·교량·옹벽·절토 레이어 | 한 번에 받음 |
| 추가 테이블 | — | `crosswalks`(횡단보도 원자료), `places`(주요 기관), `grading_params`(기준값) | |
| 추가 함수 | — | `record_measurement`, `resolve_obstacle`, `route_path` | 측정 기록과 해소 처리에 필요 |
| 측정 출처 | dem·phone_sensor·field_verified | `digital_level` 추가 | 디지털 수평계 값 구분 |
| 범위 | 시연 지역 | **동해시 전체** (행정경계 '동해시' 폴리곤, 181㎢) | 2026-11-18 팀 결정 |
| 고속국도 | — | 구간망에서 제외 | 보행자 통행 금지. 이전 시연 지역 경로(터미널→청소년센터 3,444m)가 고속국도 구간 14개를 지나고 있었음 |
| 자동차전용도로 | — | 구간망에서 제외 (도로 중심선 속성 '자동차전용', 동해시 안 60개) | 보행자 통행 금지 (2026-11-20) |
| 경사 추정 | DEM 면에서 샘플링 | **길 위 표고** (`road_profile`): 등고선이 길을 가로지르는 점 + 길 위 표고점·기준점만으로 도로망 높이를 풂. 관측 구역은 구간 중심선에 맞닿은 도로 면(`N3A_A0010000`, 인도 포함 도로 전체 폭)과 인도 면, 반폭 = 도로폭/2 + 4m. 도로 면이 없는 골목은 중심선 3m 안. 관측이 150m 넘게 없으면 옹벽·절토 보정 DEM | DEM은 등고선을 면으로 보간하면서 옹벽 위 주차장 같은 길 밖 높이가 섞임 (2026-11-20) |

## 결과 (동해시 전체, 2026-11-18 실행)

- 범위: 행정경계 '동해시' 181.3㎢, 도엽 48장. 파이프라인 약 2분 30초 (DEM은 도엽별로 나눠 6개 프로세스로 풀고 이어 붙임)
- DEM 3,727×4,078 (5m), 표고 −0.8~1,407m. 등고선 점 3,550만 개
- 구간 30,596개 (≤100m), 노드 28,630개, 총 1,017km. 고속국도 168개 제외, 끊긴 끝점 119곳 이음, 20구간 미만 조각 199개 제외 → 가장 큰 연결 요소가 98.7%. 나머지 11개 조각(각 65구간 이하)은 섬처럼 떨어져 있어 길 안내가 안 됨
- 횡단보도: 동해시 1,107건 전부 → 노드 연결 931건, 횡단 노드 486곳 (턱낮춤 없음 94곳, 어느 쪽인지 불명 117곳)
- 구조물: 교량 위 313구간 (다리 밑을 지나는 길은 방향으로 걸러냄), 보도 없는 지하차도 15, 터널 1, 장애인 이용 불가 육교와 겹침 5
- DEM 추정: 완만 14,780 / 경계(측정 필요) 5,351 / 급경사 10,151 / 판단 불가 314. 산지 도로가 많아 급경사 비율이 높다
- '측정 필요' 기준을 바꾸면: 2.5% → 18,629, 3.0% → 17,454, **4.0% → 15,502**(현재), 5.0% → 13,944구간
- 주요 기관 75곳 (건물 이름·철도역에서 자동 추출): 행정 16, 안전 11, 시장 12, 의료 10, 복지 7, 우체국 6, 교통 6(터미널·동해역·묵호역·망상역·추암역·여객선터미널), 도서관 4, 문화 3
- 로컬 DB(PostgreSQL 17 + PostGIS)에서 `smoke.sql`·`roles.sql` 30/30 통과. 길 안내 50~70ms (시 끝에서 끝 망상역→추암역 16.2km 포함), 공개 데이터 1,000건 약 50ms

## 로컬 검증에서 고친 것 (2026-11-17)

| 발견 | 조치 |
| --- | --- |
| 일반 사용자(`authenticated`)가 `TRUNCATE segments`에 성공. Supabase 기본 권한이 새 테이블에 모든 권한을 주고, RLS는 TRUNCATE를 막지 못함. PostgREST API로는 TRUNCATE를 못 하지만 한 겹 더 막음 | `…_rls.sql`: anon·authenticated 테이블 권한을 모두 거두고 `select` + `reports insert`만 다시 줌 |
| `route` 한 번에 약 230ms. 무장애 출발 노드 찾기의 `exists (source = id or target = id)`가 인덱스를 못 씀 | 조사된 구간 끝점 집합을 먼저 만들고 KNN으로 고름 → **약 10ms** |
| 스모크 테스트의 계단을 기관 좌표(도로에서 86m)에 찍어 구간에 안 붙음 | 경로 위 구간 중점에 찍도록 수정 |
| (11-18) 시 전체 3만 구간에서 길 안내가 전체 망을 매번 읽음 | 출발·도착을 감싼 상자(여유 ≥1.5km) 안 구간만 쓰고, 경로가 없으면 전체로 다시 계산 |
| (11-19) 시청에서 출발점 노드를 실제로 더 먼 것으로 고름. 경위도 그대로의 `<->`는 경도 1도(약 88km)와 위도 1도(약 111km)를 같게 봄 | KNN 후보 16개를 뽑아 실제 거리(m)로 고름. 점검표 경로 A와 `route` 일반 경로가 1,214m로 일치 |
| (11-19) `load_db.py --dsn`이 psycopg 트랜잭션 안에서 `begin`을 또 열어 경고 | `autocommit=True`로 연결 (SQL 파일 안의 begin/commit이 트랜잭션을 맡음) |

## 알려진 한계

- **작은 보행로·계단 지름길이 도로 중심선에 없다.** 터미널→청소년센터 경로가 4.4km로 직선거리(1.6km)의 약 2.8배다. 현장 조사(TK-404) 때 지름길을 확인해 구간을 추가해야 한다.
- 도로 중심선 하나에 양쪽 보도가 겹쳐 있다. 어느 쪽 보도를 조사했는지는 아직 구분하지 않는다.
- 입체교차(육교·지하도)도 평면 교차로 처리된다. 교량 위 구간은 `on_bridge`로 표시하고 측정 전까지 주의 이상으로 둔다. 육교 자체는 구간망에 없어서, 육교로만 건널 수 있는 곳은 아직 경로에 반영되지 않는다.
- 기관 위치는 가장 큰 건물의 안쪽 점이다. 입구 위치가 아니다.
- DEM 30m 창 최대 경사도 잡음이 있다. 동해 현장 시험(T5) 결과로 기준(`dem_moderate_min_pct`)과 창 크기를 다시 정한다.
- 길 위 표고는 관측(동해 전체 18,720개, 길 따라 중앙 약 20m) 사이를 직선으로 잇는다. 그보다 짧은 급경사는 펴진다. DEM과 4%p 넘게 다른 구간은 `slope_sources_disagree`로 측정을 앞세운다. 실측 대조는 아직 없다.
- `segments.dem_incline_max_pct`에는 최종 추정이 들어간다 (출처는 GeoJSON `incline_source`: `road_obs`/`dem`). `incline_source`·`incline_basis`·`road_obs_gap_m`·`dem_incline_raw_max_pct`는 아직 DB에 적재하지 않는다.
- **Supabase 자체에서는 아직 실행하지 않았다.** 로컬 PostgreSQL 17.9 + PostGIS 3.7 + pgRouting 4.0에서 마이그레이션·적재·`smoke.sql`·`roles.sql`(30/30 PASS)을 실제로 실행했다 (2026-11-17). Edge Functions는 `deno check`까지만 했고 HTTP 호출은 배포 후 확인한다.
- 기관 좌표는 건물 중심이라 가장 가까운 도로에서 20~140m 떨어져 있다. 경로 길이에는 건물→도로 구간이 빠져 있다 (화면에서 점선으로 이어 그리면 됨).
- 사진 저장(Storage 버킷)과 사진 분류 웹훅(P1)은 아직 없다.
