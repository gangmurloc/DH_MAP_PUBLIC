-- 배포 직후 확인용 (Supabase SQL Editor에서 실행). 마지막에 rollback하므로 데이터는 바뀌지 않는다.
-- 순서: 마이그레이션 3개 → scripts/prep/out/donghae/seed.sql → 이 파일
begin;

-- 1. 적재 확인 (동해시 전체 기대: 노드 28,630 / 구간 30,596 / 횡단보도 1,107 / 기관 75)
select (select count(*) from nodes) as nodes, (select count(*) from segments) as segments,
       (select count(*) from crosswalks) as crosswalks, (select count(*) from places) as places;

-- 2. 공개 데이터: 구간 1,000건 제한, 횡단 노드
select jsonb_array_length(features(null, 'segments') -> 'features') as segments_max_1000,
       jsonb_array_length(features(null, 'crossings') -> 'features') as crossing_nodes;

-- 3. 길 안내: 터미널 → 청소년센터. 조사 전이라 accessible은 null, message '조사된 길로는 갈 수 없습니다'
select r -> 'general' ->> 'length_m' as general_m, r -> 'accessible' as accessible, r ->> 'message' as message,
       jsonb_array_length(r -> 'blocked_segment_ids') as blocked
from (select route(129.10404, 37.52769, 129.09933, 37.51416) as r) t;

-- 4. 조사원 흉내 (이 트랜잭션 안에서만): 일반 경로 구간을 모두 '통행 가능'으로 완료하면 무장애 경로가 나와야 한다
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"surveyor"}}', true);
select is_surveyor() as surveyor_ok;

-- 첫 구간: 등급 제안 → 제안과 다르면 사유가 필요
select suggest_grade(s.id) as suggestion from (
  select (jsonb_array_elements_text(route(129.10404, 37.52769, 129.09933, 37.51416) -> 'general' -> 'segment_ids'))::bigint as id limit 1) s;

-- 측정값 2.0%를 넣으면 DEM 대신 측정값으로 제안 → 통행 가능, 그대로 완료 (측정과 완료는 따로 실행)
create temp table smoke_ids on commit drop as
  select (jsonb_array_elements_text(route(129.10404, 37.52769, 129.09933, 37.51416) -> 'general' -> 'segment_ids'))::bigint as id;
select count(record_measurement('segment', id, 'incline', 2.0, 'digital_level')) as measured from smoke_ids;
select count(complete_survey(id, 'passable')) as surveyed from smoke_ids;

select r -> 'accessible' ->> 'length_m' as accessible_m, r -> 'compare' as compare
from (select route(129.10404, 37.52769, 129.09933, 37.51416) as r) t;

-- 5. 장애물: 경로 위 구간 중점에 계단 등록 → 그 구간 제안이 '통행 어려움'으로 바뀐다
--    (장애물은 15m 안의 구간에 붙는다. 기관 좌표는 건물 중심이라 도로에서 20~140m 떨어져 있어 쓰지 않는다)
select register_obstacle('stairs', st_x(p), st_y(p)) -> 'suggested' ->> 'grade' as grade_after_stairs
from (select st_lineinterpolatepoint(geom, 0.5) as p from segments where id = (select id from smoke_ids order by id limit 1 offset 10)) t;

-- 6. 사유 없이 제안과 다른 등급 → 오류가 나야 정상 (주석을 풀어 확인)
-- select complete_survey((select id from segments limit 1), 'difficult');

rollback;
