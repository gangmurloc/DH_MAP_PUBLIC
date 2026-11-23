-- 역할·권한·업무 규칙 확인 (SQL Editor 또는 psql). 결과는 NOTICE의 PASS/FAIL. 마지막에 rollback.
-- PostgREST처럼 역할(set local role)과 JWT(request.jwt.claims)를 바꿔 가며 호출한다.
-- 순서: 마이그레이션 3개 → seed.sql → 이 파일
begin;

create temp table t_result (name text, ok boolean, detail text);
grant all on t_result to public;

-- 기대한 오류가 나는지 확인하는 도우미 (temp 스키마라 rollback 때 사라짐)
create function pg_temp.expect_error(p_name text, p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  insert into t_result values (p_name, false, '오류가 나야 하는데 성공함');
exception when others then
  insert into t_result values (p_name, sqlstate = p_state, sqlstate || ' ' || sqlerrm);
end $$;
create function pg_temp.expect(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;
grant execute on all functions in schema pg_temp to public;

-- 테스트에 쓸 구간: 터미널 → 청소년센터 일반 경로의 구간들, 그 가운데 하나의 중점
create temp table t_route as
  select (jsonb_array_elements_text(route(129.10404, 37.52769, 129.09933, 37.51416) -> 'general' -> 'segment_ids'))::bigint as id;
create temp table t_pick as
  select s.id, st_x(st_lineinterpolatepoint(s.geom, 0.5)) as lon, st_y(st_lineinterpolatepoint(s.geom, 0.5)) as lat
  from segments s where s.id = (select id from t_route order by id limit 1 offset 10);
grant select on t_route, t_pick to public;

-- ───────── 1. anon: 테이블·함수 모두 막혀야 한다 ─────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect_error('anon: segments 읽기 거부', 'select count(*) from segments', '42501');
select pg_temp.expect_error('anon: route 호출 거부', 'select route(129.10404, 37.52769, 129.09933, 37.51416)', '42501');
select pg_temp.expect_error('anon: reports 쓰기 거부',
  $q$insert into reports (geom, type, license_agreed) values (st_setsrid(st_makepoint(129.1,37.52),4326), 'stairs', true)$q$, '42501');
reset role;

-- ───────── 2. 일반 사용자(시민, 익명 로그인) ─────────
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","is_anonymous":true}', true);
select pg_temp.expect('시민: 구간 읽기', (select count(*) from segments) > 0);
select pg_temp.expect('시민: route 호출', (select route(129.10404, 37.52769, 129.09933, 37.51416) ? 'general'));
select pg_temp.expect('시민: 조사 기록 안 보임', (select count(*) from segment_surveys) = 0);
select pg_temp.expect_error('시민: 조사 완료 거부', format('select complete_survey(%s, ''passable'')', (select id from t_pick)), '42501');
select pg_temp.expect_error('시민: 측정 기록 거부', format('select record_measurement(''segment'', %s, ''incline'', 3.0)', (select id from t_pick)), '42501');
select pg_temp.expect_error('시민: 구간 직접 수정 거부', 'update segments set grade = ''passable'' where id = 1', '42501');
select pg_temp.expect_error('시민: 구간 TRUNCATE 거부', 'truncate segments cascade', '42501');
select pg_temp.expect_error('시민: 기준값 수정 거부', 'truncate grading_params', '42501');
select pg_temp.expect_error('시민: 남의 이름으로 제보 거부',
  $q$insert into reports (user_id, geom, type, license_agreed) values ('00000000-0000-0000-0000-0000000000b2', st_setsrid(st_makepoint(129.1,37.52),4326), 'stairs', true)$q$, '42501');

-- 제보: 같은 유형 10m 안이면 한 묶음
insert into reports (geom, type, license_agreed, loc_source) select st_setsrid(st_makepoint(lon, lat), 4326), 'stairs', true, 'gps' from t_pick;
insert into reports (geom, type, license_agreed, loc_source) select st_setsrid(st_makepoint(lon + 0.00005, lat), 4326), 'stairs', true, 'gps' from t_pick; -- 약 4.4m
insert into reports (geom, type, license_agreed, loc_source) select st_setsrid(st_makepoint(lon + 0.0005, lat), 4326), 'stairs', true, 'gps' from t_pick;  -- 약 44m
select pg_temp.expect('시민: 제보 3건 본인 것만 보임', (select count(*) from reports) = 3);
select pg_temp.expect('제보: 4m 떨어진 같은 유형은 한 묶음',
  (select count(distinct cluster_id) from (select cluster_id from reports order by id limit 2) a) = 1);
select pg_temp.expect('제보: 44m 떨어진 것은 다른 묶음',
  (select count(distinct cluster_id) from reports) = 2);

-- 하루 제한 30건
do $$ begin
  for i in 1..27 loop
    insert into reports (geom, type, license_agreed) values (st_setsrid(st_makepoint(129.05 + i * 0.001, 37.50), 4326), 'damaged', true);
  end loop;
end $$;
select pg_temp.expect_error('제보: 31번째는 하루 제한',
  $q$insert into reports (geom, type, license_agreed) values (st_setsrid(st_makepoint(129.2,37.6),4326), 'damaged', true)$q$, '54000');
reset role;

-- ───────── 3. 조사원 ─────────
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","app_metadata":{"role":"surveyor"}}', true);
select pg_temp.expect('조사원: 남의 제보도 보임', (select count(*) from reports) = 30);

-- 사유 없이 제안과 다른 등급 → 거부, 사유 있으면 통과
select pg_temp.expect_error('조사원: 사유 없이 제안과 다른 등급 거부',
  format('select complete_survey(%s, %L)', id,
         case when suggest_grade(id) ->> 'grade' = 'difficult' then 'passable' else 'difficult' end), '22023')
from t_pick;

-- 일반 경로 전체를 측정 2% → 통행 가능으로 완료
select count(record_measurement('segment', id, 'incline', 2.0, 'digital_level')) from t_route;
select count(complete_survey(id, 'passable')) from t_route;
select pg_temp.expect('조사원: 조사 후 무장애 경로 생김',
  (select route(129.10404, 37.52769, 129.09933, 37.51416) -> 'accessible' is not null
     and route(129.10404, 37.52769, 129.09933, 37.51416) -> 'accessible' <> 'null'::jsonb));

-- 제보 묶음 확인 → 계단 등록 → 그 구간 제안이 통행 어려움
select pg_temp.expect('조사원: 경로 위 계단 등록 → 통행 어려움 제안',
  (select register_obstacle('stairs', lon, lat, null, null, '{}', null, (select min(id) from reports))
     -> 'suggested' ->> 'grade' from t_pick) = 'difficult');
select pg_temp.expect('제보: 계단 등록 시 같은 묶음 2건 모두 확인 처리',
  (select count(*) from reports where status = 'confirmed') = 2);
select pg_temp.expect_error('조사원: 계단 구간을 사유 없이 통행 가능 유지 거부',
  format('select complete_survey(%s, ''passable'')', (select id from t_pick)), '22023');
select complete_survey(id, 'difficult') from t_pick;

-- 계단 구간이 통행 어려움이 되면 무장애 경로는 그 구간을 피하거나, 없으면 메시지
select pg_temp.expect('길 안내: 무장애 경로가 계단 구간을 쓰지 않음',
  (select coalesce(not (r -> 'accessible' -> 'segment_ids' @> to_jsonb((select id from t_pick))), true)
     from (select route(129.10404, 37.52769, 129.09933, 37.51416) as r) x));
select pg_temp.expect('길 안내: 일반 경로 비교에 통행 어려움 1건 이상',
  (select (route(129.10404, 37.52769, 129.09933, 37.51416) -> 'compare' ->> 'general_difficult_count')::int >= 1
       or route(129.10404, 37.52769, 129.09933, 37.51416) ->> 'message' is not null));

-- 장애물 해소 → 구간 제안이 다시 통행 가능
select pg_temp.expect('조사원: 장애물 해소 후 제안 회복',
  (select resolve_obstacle((select max(id) from obstacles), '현장 확인: 경사로 설치') is not null));
select pg_temp.expect('조사원: 해소 후 suggest_grade = passable',
  (select suggest_grade(id) ->> 'grade' from t_pick) = 'passable');
reset role;

-- ───────── 4. service_role (Edge Function) ─────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.expect('서버: route 호출', (select route(129.10404, 37.52769, 129.09933, 37.51416) ? 'general'));
select pg_temp.expect('서버: features 장애물 레이어',
  (select features(array[129.0, 37.4, 129.2, 37.6], 'obstacles') ? 'features'));
select pg_temp.expect('서버: health', (select health()));
select pg_temp.expect('공개 데이터에 조사자 id 없음',
  (select position('surveyed_by' in features(null, 'segments')::text) = 0
      and position('created_by' in features(null, 'obstacles')::text) = 0));
reset role;

select case when ok then 'PASS' else 'FAIL' end as result, name, detail from t_result;
select count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail from t_result;

rollback;
