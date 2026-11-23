-- 동해 무장애지도: DB 함수 (TECH_SPEC 5절). 데이터 규칙은 DB 안에 둔다.
-- 쓰기는 모두 security definer 함수로만 하고, 함수 안에서 조사원 역할을 확인한다.

-- ─────────────── 도우미 ───────────────
create or replace function public.param(p_key text)
returns double precision
language sql stable
set search_path = public
as $$
  select value from public.grading_params where key = p_key
$$;

create or replace function public.is_surveyor()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'surveyor', false)
$$;

create or replace function public.require_surveyor()
returns uuid
language plpgsql
set search_path = public
as $$
begin
  if not public.is_surveyor() then
    raise exception '조사원 계정만 할 수 있습니다' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function public.nearest_segment(p_geom extensions.geometry, p_max_m double precision default 15)
returns bigint
language sql stable
set search_path = public, extensions
as $$
  select s.id
  from public.segments s
  where st_dwithin(s.geom::geography, p_geom::geography, p_max_m)
  order by s.geom <-> p_geom
  limit 1
$$;

-- ─────────────── 등급 제안 (R-106, PRD 6절) ───────────────
-- 측정값이 있으면 측정값, 없으면 DEM(보수적). 교량 위는 측정 전까지 '주의' 이상.
create or replace function public.suggest_grade(p_segment_id bigint)
returns jsonb
language plpgsql stable
security definer
set search_path = public, extensions
as $$
declare
  seg        public.segments%rowtype;
  v_rank     integer := 1;            -- 1 통행 가능, 2 주의, 3 통행 어려움
  v_reasons  jsonb := '[]'::jsonb;
  v_incline  double precision;
  v_cross    double precision;
  v_src      text;
  r          record;
  p_pass     double precision := public.param('incline_passable_max_pct');
  p_caut     double precision := public.param('incline_caution_max_pct');
  k_pass     double precision := public.param('kerb_passable_max_m');
  k_caut     double precision := public.param('kerb_caution_max_m');
  w_caut     double precision := public.param('width_caution_min_m');
  w_diff     double precision := public.param('width_difficult_min_m');
  d_mod      double precision := public.param('dem_moderate_min_pct');
begin
  select * into seg from public.segments where id = p_segment_id;
  if not found then
    raise exception '구간 %을 찾을 수 없습니다', p_segment_id using errcode = 'P0002';
  end if;

  -- 진행 방향 경사
  select max(abs(m.value)) into v_incline
  from public.measurements m
  where m.target_type = 'segment' and m.target_id = p_segment_id and m.key = 'incline' and m.source <> 'dem';

  if v_incline is not null then
    v_src := 'measured';
    if v_incline > p_caut then
      v_rank := greatest(v_rank, 3);
      v_reasons := v_reasons || jsonb_build_object('code', 'incline_over_caution', 'value_pct', round(v_incline::numeric, 1));
    elsif v_incline > p_pass then
      v_rank := greatest(v_rank, 2);
      v_reasons := v_reasons || jsonb_build_object('code', 'incline_over_passable', 'value_pct', round(v_incline::numeric, 1));
    end if;
  elsif seg.on_bridge or seg.in_tunnel or seg.dem_incline_max_pct is null then
    v_src := 'missing';
    v_rank := greatest(v_rank, 2);
    v_reasons := v_reasons || jsonb_build_object('code', 'incline_not_measured');
  else
    v_src := 'dem';
    v_incline := seg.dem_incline_max_pct;
    if v_incline > p_caut then
      v_rank := greatest(v_rank, 3);
      v_reasons := v_reasons || jsonb_build_object('code', 'dem_steep', 'value_pct', round(v_incline::numeric, 1));
    elsif v_incline >= d_mod then
      v_rank := greatest(v_rank, 2);
      v_reasons := v_reasons || jsonb_build_object('code', 'dem_moderate_measure_needed', 'value_pct', round(v_incline::numeric, 1));
    else
      v_reasons := v_reasons || jsonb_build_object('code', 'incline_from_dem', 'value_pct', round(v_incline::numeric, 1));
    end if;
  end if;

  -- 수치지도 구조물 정보
  if seg.underpass_no_sidewalk then
    v_rank := greatest(v_rank, 3);
    v_reasons := v_reasons || jsonb_build_object('code', 'underpass_no_sidewalk');
  end if;
  if seg.in_tunnel then
    v_rank := greatest(v_rank, 2);
    v_reasons := v_reasons || jsonb_build_object('code', 'tunnel');
  end if;
  if seg.overpass_nearby = 'inaccessible' then
    -- 길을 따라 걷는 데는 영향 없음. 이곳에서 길을 건너는 방법이 육교뿐인지 현장 확인용 참고
    v_reasons := v_reasons || jsonb_build_object('code', 'overpass_inaccessible_info');
  end if;

  -- 횡경사: 기준 미정(PRD 15절) → 참고 사유로만 기록
  select max(abs(m.value)) into v_cross
  from public.measurements m
  where m.target_type = 'segment' and m.target_id = p_segment_id and m.key = 'cross_slope';
  if v_cross is not null then
    v_reasons := v_reasons || jsonb_build_object('code', 'cross_slope_info', 'value_pct', round(v_cross::numeric, 1));
  end if;

  -- 확인된 장애물
  for r in
    select o.id, o.type,
           (select max(m.value) from public.measurements m
             where m.target_type = 'obstacle' and m.target_id = o.id and m.key = 'kerb:height') as kerb_m,
           (select min(m.value) from public.measurements m
             where m.target_type = 'obstacle' and m.target_id = o.id and m.key = 'width') as width_m
    from public.obstacles o
    where o.segment_id = p_segment_id and o.status in ('confirmed', 'verified')
  loop
    if r.type = 'stairs' then
      v_rank := greatest(v_rank, 3);
      v_reasons := v_reasons || jsonb_build_object('code', 'stairs', 'obstacle_id', r.id);
    elsif r.type = 'kerb' then
      if r.kerb_m is null then
        v_rank := greatest(v_rank, 2);
        v_reasons := v_reasons || jsonb_build_object('code', 'kerb_height_unknown', 'obstacle_id', r.id);
      elsif r.kerb_m > k_caut then
        v_rank := greatest(v_rank, 3);
        v_reasons := v_reasons || jsonb_build_object('code', 'kerb_over_caution', 'obstacle_id', r.id, 'value_m', r.kerb_m);
      elsif r.kerb_m > k_pass then
        v_rank := greatest(v_rank, 2);
        v_reasons := v_reasons || jsonb_build_object('code', 'kerb_over_passable', 'obstacle_id', r.id, 'value_m', r.kerb_m);
      end if;
    elsif r.type = 'narrow' then
      if r.width_m is not null and r.width_m < w_diff then
        v_rank := greatest(v_rank, 3);
        v_reasons := v_reasons || jsonb_build_object('code', 'too_narrow', 'obstacle_id', r.id, 'value_m', r.width_m);
      elsif r.width_m is null or r.width_m < w_caut then
        v_rank := greatest(v_rank, 2);
        v_reasons := v_reasons || jsonb_build_object('code', 'narrow', 'obstacle_id', r.id, 'value_m', r.width_m);
      end if;
    else  -- damaged, steep
      v_rank := greatest(v_rank, 2);
      v_reasons := v_reasons || jsonb_build_object('code', r.type::text, 'obstacle_id', r.id);
    end if;
  end loop;

  return jsonb_build_object(
    'segment_id', p_segment_id,
    'grade', (array['passable', 'caution', 'difficult'])[v_rank],
    'incline_pct', round(v_incline::numeric, 1),
    'incline_source', v_src,
    'reasons', v_reasons
  );
end;
$$;

-- ─────────────── 조사 완료 (R-106) ───────────────
create or replace function public.complete_survey(p_segment_id bigint, p_grade public.segment_grade, p_override_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid       uuid := public.require_surveyor();
  v_sug       jsonb;
  v_sug_grade public.segment_grade;
  v_old       public.segment_grade;
begin
  if p_grade = 'unsurveyed' then
    raise exception '조사 완료 등급은 통행 가능·주의·통행 어려움 중 하나여야 합니다' using errcode = '22023';
  end if;
  select grade into v_old from public.segments where id = p_segment_id for update;
  if not found then
    raise exception '구간 %을 찾을 수 없습니다', p_segment_id using errcode = 'P0002';
  end if;
  v_sug := public.suggest_grade(p_segment_id);
  v_sug_grade := (v_sug ->> 'grade')::public.segment_grade;
  if p_grade <> v_sug_grade and nullif(btrim(coalesce(p_override_reason, '')), '') is null then
    raise exception '제안 등급(%)과 다르게 정하려면 사유가 필요합니다', v_sug_grade using errcode = '22023';
  end if;

  insert into public.segment_surveys (segment_id, grade, suggested_grade, reasons, override_reason, surveyor_id)
  values (p_segment_id, p_grade, v_sug_grade, v_sug -> 'reasons', nullif(btrim(coalesce(p_override_reason, '')), ''), v_uid);

  update public.segments
  set grade = p_grade, grade_source = 'survey', surveyed_at = now(), updated_at = now()
  where id = p_segment_id;

  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('segment', p_segment_id, v_old::text, p_grade::text, v_uid, p_override_reason);

  return jsonb_build_object('segment_id', p_segment_id, 'grade', p_grade, 'suggested', v_sug);
end;
$$;

-- ─────────────── 측정값 기록 (R-105) ───────────────
create or replace function public.record_measurement(
  p_target_type public.target_type,
  p_target_id   bigint,
  p_key         public.measure_key,
  p_value       double precision,
  p_source      public.measure_source default 'phone_sensor',
  p_heading_deg real default null,
  p_lon         double precision default null,
  p_lat         double precision default null,
  p_note        text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := public.require_surveyor();
  v_id  bigint;
begin
  if p_source = 'dem' then
    raise exception 'DEM 값은 측정값으로 기록하지 않습니다' using errcode = '22023';
  end if;
  if p_target_type = 'segment' and not exists (select 1 from public.segments where id = p_target_id) then
    raise exception '구간 %을 찾을 수 없습니다', p_target_id using errcode = 'P0002';
  end if;
  if p_target_type = 'obstacle' and not exists (select 1 from public.obstacles where id = p_target_id) then
    raise exception '장애물 %을 찾을 수 없습니다', p_target_id using errcode = 'P0002';
  end if;
  insert into public.measurements (target_type, target_id, key, value, unit, source, heading_deg, geom, note, measured_by)
  values (p_target_type, p_target_id, p_key, p_value,
          case when p_key in ('incline', 'cross_slope') then '%' else 'm' end,
          p_source, p_heading_deg,
          case when p_lon is not null and p_lat is not null then st_setsrid(st_makepoint(p_lon, p_lat), 4326) end,
          p_note, v_uid)
  returning id into v_id;
  if p_target_type = 'segment' then
    update public.segments set updated_at = now() where id = p_target_id;
  end if;
  return v_id;
end;
$$;

-- ─────────────── 시민 제보 처리 (R-108) ───────────────
-- 같은 묶음(cluster)의 대기 중 제보를 함께 처리한다 (R-207)
create or replace function public.resolve_report(
  p_report_id   bigint,
  p_result      public.report_status,
  p_obstacle_id bigint default null,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := public.require_surveyor();
  v_cluster bigint;
  v_ids     bigint[];
  v_id      bigint;
begin
  if p_result = 'pending' then
    raise exception '처리 결과는 confirmed·not_found·hidden 중 하나여야 합니다' using errcode = '22023';
  end if;
  if p_result = 'confirmed' and p_obstacle_id is null then
    raise exception '장애물 맞음으로 처리하려면 연결할 장애물이 필요합니다' using errcode = '22023';
  end if;
  select coalesce(cluster_id, id) into v_cluster from public.reports where id = p_report_id;
  if not found then
    raise exception '제보 %을 찾을 수 없습니다', p_report_id using errcode = 'P0002';
  end if;

  select array_agg(id) into v_ids
  from public.reports
  where (id = p_report_id or (coalesce(cluster_id, id) = v_cluster and status = 'pending'));

  foreach v_id in array v_ids loop
    insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
    select 'report', id, status::text, p_result::text, v_uid, p_note from public.reports where id = v_id;
    if p_result = 'confirmed' then
      insert into public.obstacle_reports (obstacle_id, report_id) values (p_obstacle_id, v_id) on conflict do nothing;
    end if;
  end loop;

  update public.reports set status = p_result where id = any(v_ids);
  return jsonb_build_object('report_id', p_report_id, 'result', p_result, 'affected_report_ids', to_jsonb(v_ids));
end;
$$;

-- ─────────────── 장애물 등록 (R-104) ───────────────
create or replace function public.register_obstacle(
  p_type            public.obstacle_type,
  p_lon             double precision,
  p_lat             double precision,
  p_kerb_height_cm  real default null,
  p_width_cm        real default null,
  p_tags            jsonb default '{}',
  p_photo_path      text default null,
  p_report_id       bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid  uuid := public.require_surveyor();
  v_geom extensions.geometry := st_setsrid(st_makepoint(p_lon, p_lat), 4326);
  v_seg  bigint := public.nearest_segment(v_geom, 15);
  v_id   bigint;
begin
  if p_kerb_height_cm is not null and (p_kerb_height_cm < 0 or p_kerb_height_cm > 100) then
    raise exception '턱 높이는 0~100cm 사이여야 합니다' using errcode = '22023';
  end if;
  if p_width_cm is not null and (p_width_cm <= 0 or p_width_cm > 1000) then
    raise exception '폭은 0~1000cm 사이여야 합니다' using errcode = '22023';
  end if;

  insert into public.obstacles (geom, type, tags, segment_id, status, photo_path, created_by)
  values (v_geom, p_type, coalesce(p_tags, '{}'::jsonb), v_seg, 'verified', p_photo_path, v_uid)
  returning id into v_id;

  if p_kerb_height_cm is not null then
    insert into public.measurements (target_type, target_id, key, value, unit, source, geom, measured_by)
    values ('obstacle', v_id, 'kerb:height', p_kerb_height_cm / 100.0, 'm', 'field_verified', v_geom, v_uid);
  end if;
  if p_width_cm is not null then
    insert into public.measurements (target_type, target_id, key, value, unit, source, geom, measured_by)
    values ('obstacle', v_id, 'width', p_width_cm / 100.0, 'm', 'field_verified', v_geom, v_uid);
  end if;

  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id)
  values ('obstacle', v_id, null, 'verified', v_uid);

  if p_report_id is not null then
    perform public.resolve_report(p_report_id, 'confirmed', v_id, null);
  end if;
  if v_seg is not null then
    update public.segments set updated_at = now() where id = v_seg;
  end if;

  return jsonb_build_object(
    'obstacle_id', v_id,
    'segment_id', v_seg,
    'suggested', case when v_seg is not null then public.suggest_grade(v_seg) end
  );
end;
$$;

-- ─────────────── 장애물 해소 (R-109, P1) ───────────────
create or replace function public.resolve_obstacle(p_obstacle_id bigint, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := public.require_surveyor();
  v_old text;
  v_seg bigint;
begin
  select o.status::text, o.segment_id into v_old, v_seg from public.obstacles o where o.id = p_obstacle_id for update;
  if not found then
    raise exception '장애물 %을 찾을 수 없습니다', p_obstacle_id using errcode = 'P0002';
  end if;
  update public.obstacles set status = 'resolved', updated_at = now() where id = p_obstacle_id;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('obstacle', p_obstacle_id, v_old, 'resolved', v_uid, p_note);
  return jsonb_build_object('obstacle_id', p_obstacle_id, 'segment_id', v_seg,
                            'suggested', case when v_seg is not null then public.suggest_grade(v_seg) end);
end;
$$;

-- ─────────────── 제보 저장 트리거 (R-207, R-208) ───────────────
create or replace function public.on_report_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count   integer;
  v_cluster bigint;
begin
  select count(*) into v_count
  from public.reports
  where user_id = new.user_id
    and created_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul');
  if v_count >= public.param('report_daily_limit') then
    raise exception '오늘 제보할 수 있는 횟수를 모두 썼습니다' using errcode = '54000';
  end if;

  new.status := 'pending';
  select coalesce(r.cluster_id, r.id) into v_cluster
  from public.reports r
  where r.status = 'pending'
    and r.type = new.type
    and st_dwithin(r.geom::geography, new.geom::geography, public.param('report_cluster_radius_m'))
  order by r.geom <-> new.geom
  limit 1;
  new.cluster_id := coalesce(v_cluster, new.id);
  -- 사진 분류(classify-photo, P1)는 Supabase Database Webhook으로 따로 연결한다
  return new;
end;
$$;

create trigger reports_before_insert
before insert on public.reports
for each row execute function public.on_report_insert();

-- ─────────────── 길 안내 (R-301, R-302) ───────────────
create or replace function public.route_path(p_edges text, p_from bigint, p_to bigint)
returns jsonb
language sql stable
security definer
set search_path = public, extensions
as $$
  with path as (
    select d.seq, d.node, d.edge
    from pgr_dijkstra(p_edges, p_from, p_to, false) d
  ), segs as (
    select p.seq, s.*
    from path p
    join public.segments s on s.id = p.edge
  )
  select case when count(*) = 0 then null else jsonb_build_object(
    'length_m', round(sum(segs.length_m)::numeric, 1),
    'segment_ids', jsonb_agg(segs.id order by segs.seq),
    'geometry', st_asgeojson(st_linemerge(st_collect(segs.geom order by segs.seq)), 7)::jsonb,
    'grade_counts', jsonb_build_object(
      'passable',   count(*) filter (where segs.grade = 'passable'),
      'caution',    count(*) filter (where segs.grade = 'caution'),
      'difficult',  count(*) filter (where segs.grade = 'difficult'),
      'unsurveyed', count(*) filter (where segs.grade = 'unsurveyed')),
    'difficult_segment_ids',  coalesce(jsonb_agg(segs.id order by segs.seq) filter (where segs.grade = 'difficult'), '[]'::jsonb),
    'unsurveyed_segment_ids', coalesce(jsonb_agg(segs.id order by segs.seq) filter (where segs.grade = 'unsurveyed'), '[]'::jsonb),
    'obstacles', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'type', o.type, 'segment_id', o.segment_id,
                                          'geometry', st_asgeojson(o.geom, 7)::jsonb))
      from public.obstacles o
      where o.segment_id in (select p2.edge from path p2) and o.status in ('confirmed', 'verified')), '[]'::jsonb),
    'crossings_kerb_not_lowered', (
      select count(*) from public.nodes n
      where n.id in (select p3.node from path p3) and n.crossing_kerb = 'raised')
  ) end
  from segs
$$;

create or replace function public.route(
  p_from_lon double precision,
  p_from_lat double precision,
  p_to_lon   double precision,
  p_to_lat   double precision,
  p_include_caution boolean default true
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, extensions
as $$
declare
  v_from    extensions.geometry := st_setsrid(st_makepoint(p_from_lon, p_from_lat), 4326);
  v_to      extensions.geometry := st_setsrid(st_makepoint(p_to_lon, p_to_lat), 4326);
  v_grades  text[] := case when p_include_caution then array['passable', 'caution'] else array['passable'] end;
  v_max_snap double precision := 300;
  g_from bigint; g_to bigint; a_from bigint; a_to bigint;
  v_general jsonb; v_access jsonb; v_msg text;
  v_edges_all text;
  v_edges_acc text;
  v_box     text;
  v_margin  double precision;
begin
  -- 시 전체 구간망(약 3만 개)을 매번 다 읽지 않도록 출발·도착을 감싼 상자 안 구간만 쓴다.
  -- 상자 여유: 두 점 거리의 절반, 최소 약 1.5km. 상자 안에서 경로가 없으면 전체로 다시 계산한다.
  v_margin := greatest(0.015, st_distance(v_from, v_to) * 0.5);
  v_box := format('geom && st_expand(st_makeenvelope(%s, %s, %s, %s, 4326), %s)',
                  least(p_from_lon, p_to_lon), least(p_from_lat, p_to_lat), greatest(p_from_lon, p_to_lon), greatest(p_from_lat, p_to_lat), v_margin);
  v_edges_all := 'select id, source, target, length_m as cost, length_m as reverse_cost from public.segments where ' || v_box;
  v_edges_acc := format(
    'select id, source, target, length_m as cost, length_m as reverse_cost from public.segments where grade::text = any(%L::text[]) and ',
    v_grades) || v_box;

  -- 가까운 노드: 공간 인덱스(KNN)로 후보 16개를 고르고 실제 거리(m)로 하나 정한다.
  -- 경위도 그대로의 <-> 거리는 경도 1도가 위도 1도의 약 0.79배인 것을 무시해서, 후보 없이 쓰면 더 먼 노드를 고를 수 있다
  select c.id into g_from from (select n.id, n.geom from public.nodes n order by n.geom <-> v_from limit 16) c
  order by st_distance(c.geom::geography, v_from::geography) limit 1;
  select c.id into g_to from (select n.id, n.geom from public.nodes n order by n.geom <-> v_to limit 16) c
  order by st_distance(c.geom::geography, v_to::geography) limit 1;
  if not exists (select 1 from public.nodes n where n.id = g_from and st_dwithin(n.geom::geography, v_from::geography, v_max_snap))
     or not exists (select 1 from public.nodes n where n.id = g_to and st_dwithin(n.geom::geography, v_to::geography, v_max_snap)) then
    return jsonb_build_object('accessible', null, 'general', null,
                              'message', '출발지나 도착지가 조사 지역에서 너무 멉니다 (300m 이내로 찍어 주세요)');
  end if;
  v_general := public.route_path(v_edges_all, g_from, g_to);
  if v_general is null then
    v_general := public.route_path('select id, source, target, length_m as cost, length_m as reverse_cost from public.segments', g_from, g_to);
  end if;

  -- 무장애 경로: 조사를 마친 통행 가능(옵션: 주의) 구간만
  -- (source = id or target = id) 형태는 인덱스를 못 써서 느리다 → 조사된 구간의 끝점 집합을 먼저 만든다
  with acc as (
    select s.source as id from public.segments s where s.grade::text = any(v_grades)
    union
    select s.target from public.segments s where s.grade::text = any(v_grades)
  )
  select
    (select n.id from public.nodes n join acc on acc.id = n.id
      where st_dwithin(n.geom::geography, v_from::geography, v_max_snap) order by st_distance(n.geom::geography, v_from::geography) limit 1),
    (select n.id from public.nodes n join acc on acc.id = n.id
      where st_dwithin(n.geom::geography, v_to::geography, v_max_snap) order by st_distance(n.geom::geography, v_to::geography) limit 1)
  into a_from, a_to;
  if a_from is not null and a_to is not null then
    v_access := public.route_path(v_edges_acc, a_from, a_to);
    if v_access is null then
      v_access := public.route_path(format(
        'select id, source, target, length_m as cost, length_m as reverse_cost from public.segments where grade::text = any(%L::text[])', v_grades),
        a_from, a_to);
    end if;
  end if;
  if v_access is null then
    v_msg := '조사된 길로는 갈 수 없습니다';
  end if;

  return jsonb_build_object(
    'include_caution', p_include_caution,
    'accessible', v_access,
    'general', v_general,
    'message', v_msg,
    'compare', case when v_access is not null and v_general is not null then jsonb_build_object(
        'extra_m', round(((v_access ->> 'length_m')::numeric - (v_general ->> 'length_m')::numeric), 1),
        'general_obstacle_count', jsonb_array_length(v_general -> 'obstacles'),
        'general_difficult_count', (v_general -> 'grade_counts' ->> 'difficult')::int,
        'general_unsurveyed_count', (v_general -> 'grade_counts' ->> 'unsurveyed')::int) end,
    -- 경로가 없을 때 막힌 곳 안내용: 일반 경로가 지나는 미조사·통행 어려움 구간
    'blocked_segment_ids', case when v_access is null and v_general is not null then
        (v_general -> 'difficult_segment_ids') || (v_general -> 'unsurveyed_segment_ids') end
  );
end;
$$;

-- ─────────────── 공개 데이터 (R-501) ───────────────
-- 숨김 제외, 제보 원문·사진·제보자·조사자·측정자 정보 없음. 한 번에 최대 1,000건.
create or replace function public.features(
  p_bbox   double precision[] default null,   -- [서경, 남위, 동경, 북위]
  p_layer  text default 'segments',           -- segments / obstacles / crossings / places
  p_grade  text[] default null,
  p_status text[] default null,
  p_since  timestamptz default null,
  p_limit  integer default 1000
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, extensions
as $$
declare
  v_env   extensions.geometry;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_out   jsonb;
begin
  if p_bbox is not null then
    if array_length(p_bbox, 1) <> 4 then
      raise exception 'bbox는 숫자 4개(서경,남위,동경,북위)여야 합니다' using errcode = '22023';
    end if;
    v_env := st_makeenvelope(p_bbox[1], p_bbox[2], p_bbox[3], p_bbox[4], 4326);
  end if;

  if p_layer = 'segments' then
    select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(q.f order by q.id), '[]'::jsonb))
    into v_out
    from (
      select s.id, jsonb_build_object(
        'type', 'Feature', 'id', s.id,
        'geometry', st_asgeojson(s.geom, 7)::jsonb,
        'properties', jsonb_build_object(
          'id', s.id, 'length_m', round(s.length_m::numeric, 1),
          'grade', s.grade, 'grade_source', s.grade_source, 'surveyed_at', s.surveyed_at,
          'measured_incline_max_pct', (select round(max(abs(m.value))::numeric, 1) from public.measurements m
                                        where m.target_type = 'segment' and m.target_id = s.id and m.key = 'incline' and m.source <> 'dem'),
          'dem_incline_pct', s.dem_incline_pct, 'dem_incline_max_pct', s.dem_incline_max_pct, 'dem_estimate', s.dem_estimate,
          'has_sidewalk', s.has_sidewalk, 'sidewalk_width_m', s.sidewalk_width_m, 'on_bridge', s.on_bridge,
          'near_stairs', s.near_stairs, 'in_tunnel', s.in_tunnel, 'underpass_no_sidewalk', s.underpass_no_sidewalk,
          'overpass_nearby', s.overpass_nearby, 'road_class', s.road_class, 'source_data', s.source_data)) as f
      from public.segments s
      where (v_env is null or s.geom && v_env)
        and (p_grade is null or s.grade::text = any(p_grade))
        and (p_since is null or s.updated_at >= p_since)
      order by s.id
      limit v_limit
    ) q;
  elsif p_layer = 'obstacles' then
    select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(q.f order by q.id), '[]'::jsonb))
    into v_out
    from (
      select o.id, jsonb_build_object(
        'type', 'Feature', 'id', o.id,
        'geometry', st_asgeojson(o.geom, 7)::jsonb,
        'properties', jsonb_build_object(
          'id', o.id, 'type', o.type, 'status', o.status, 'tags', o.tags, 'segment_id', o.segment_id,
          'kerb_height_m', (select max(m.value) from public.measurements m where m.target_type = 'obstacle' and m.target_id = o.id and m.key = 'kerb:height'),
          'width_m', (select min(m.value) from public.measurements m where m.target_type = 'obstacle' and m.target_id = o.id and m.key = 'width'),
          'created_at', o.created_at, 'updated_at', o.updated_at)) as f
      from public.obstacles o
      where o.status <> 'hidden'
        and (v_env is null or o.geom && v_env)
        and (p_status is null or o.status::text = any(p_status))
        and (p_since is null or o.updated_at >= p_since)
      order by o.id
      limit v_limit
    ) q;
  elsif p_layer = 'crossings' then
    select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(q.f order by q.id), '[]'::jsonb))
    into v_out
    from (
      select n.id, jsonb_build_object(
        'type', 'Feature', 'id', n.id,
        'geometry', st_asgeojson(n.geom, 7)::jsonb,
        'properties', jsonb_build_object(
          'node_id', n.id, 'crossing_count', n.crossing_count, 'crossing_kerb', n.crossing_kerb,
          'crossing_ambiguous', n.crossing_ambiguous, 'source', n.crossing_source)) as f
      from public.nodes n
      where n.crossing and (v_env is null or n.geom && v_env)
      order by n.id
      limit v_limit
    ) q;
  elsif p_layer = 'places' then
    select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(q.f order by q.id), '[]'::jsonb))
    into v_out
    from (
      select p.id, jsonb_build_object(
        'type', 'Feature', 'id', p.id,
        'geometry', st_asgeojson(p.geom, 7)::jsonb,
        'properties', jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category)) as f
      from public.places p
      where (v_env is null or p.geom && v_env)
      order by p.id
      limit v_limit
    ) q;
  else
    raise exception '알 수 없는 레이어입니다: % (segments·obstacles·crossings·places)', p_layer using errcode = '22023';
  end if;
  return v_out;
end;
$$;

-- ─────────────── 상태 확인 (UptimeRobot 전용) ───────────────
create or replace function public.health()
returns boolean
language sql stable
as $$
  select true
$$;

-- ─────────────── 실행 권한 ───────────────
-- Supabase는 새 함수에 anon·authenticated 실행 권한을 기본으로 준다 → 모두 거두고 필요한 것만 연다
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_surveyor() to authenticated;
grant execute on function public.suggest_grade(bigint) to authenticated;
grant execute on function public.complete_survey(bigint, public.segment_grade, text) to authenticated;
grant execute on function public.record_measurement(public.target_type, bigint, public.measure_key, double precision, public.measure_source, real, double precision, double precision, text) to authenticated;
grant execute on function public.resolve_report(bigint, public.report_status, bigint, text) to authenticated;
grant execute on function public.register_obstacle(public.obstacle_type, double precision, double precision, real, real, jsonb, text, bigint) to authenticated;
grant execute on function public.resolve_obstacle(bigint, text) to authenticated;
-- 공개 API는 Edge Function(service_role)으로 나간다. 앱(로그인 사용자)도 지도·길 안내에 쓴다.
grant execute on function public.route(double precision, double precision, double precision, double precision, boolean) to authenticated, service_role;
grant execute on function public.features(double precision[], text, text[], text[], timestamptz, integer) to authenticated, service_role;
grant execute on function public.health() to service_role;
