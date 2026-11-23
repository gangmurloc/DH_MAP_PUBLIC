-- 관리자 화면에서 기존 길을 눌러 고치기
-- 1) 구간 경사 고치기: 같은 구간의 이전 실측 경사를 '대체됨'으로 두고 새 값 하나만 쓴다.
--    (surveyed_segments는 여러 기록 중 가장 큰 값을 쓰므로, 고치지 않으면 낮춰 고친 값이 반영되지 않는다)
-- 2) 구간 경사 되돌리기: 실측 경사를 모두 '대체됨'으로 → 지도는 다시 추정값을 쓴다
-- 3) 관리자 추가 길 고치기: 경사·설명
-- 모든 변경은 status_events에 남는다 (기록 탭).

alter table public.measurements add column if not exists superseded_at timestamptz;

create or replace function public.surveyed_segments()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with inc as (
    select m.target_id as id, max(abs(m.value)) as incline, max(m.measured_at) as measured_at
    from public.measurements m
    where m.target_type = 'segment' and m.key = 'incline' and m.source <> 'dem' and m.superseded_at is null
    group by m.target_id
  ),
  sv as (
    select id, grade, surveyed_at from public.segments where grade_source = 'survey' and grade <> 'unsurveyed'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', coalesce(sv.id, inc.id),
           'grade', sv.grade,
           'incline', round(inc.incline::numeric, 2),
           'at', coalesce(sv.surveyed_at, inc.measured_at)
         )), '[]'::jsonb)
  from sv full join inc on inc.id = sv.id;
$$;

create or replace function public.set_segment_incline(
  p_segment_id  bigint,
  p_incline_pct double precision,
  p_incline_deg double precision default null,
  p_lon         double precision default null,
  p_lat         double precision default null
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
  if not exists (select 1 from public.segments where id = p_segment_id) then
    raise exception '구간 %을 찾을 수 없습니다', p_segment_id using errcode = 'P0002';
  end if;
  if p_incline_pct is null or p_incline_pct < 0 or p_incline_pct >= 100 then
    raise exception '경사는 0~100%% 사이여야 합니다' using errcode = '22023';
  end if;
  update public.measurements set superseded_at = now()
   where target_type = 'segment' and target_id = p_segment_id and key = 'incline' and source <> 'dem' and superseded_at is null;
  insert into public.measurements (target_type, target_id, key, value, unit, source, geom, note, measured_by)
  values ('segment', p_segment_id, 'incline', p_incline_pct, '%', 'field_verified',
          case when p_lon is not null and p_lat is not null then st_setsrid(st_makepoint(p_lon, p_lat), 4326) end,
          case when p_incline_deg is not null then p_incline_deg || '° (관리자 수정)' else '관리자 수정' end, v_uid)
  returning id into v_id;
  update public.segments set updated_at = now() where id = p_segment_id;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('segment', p_segment_id, null, 'edited', v_uid, '경사 ' || round(p_incline_pct::numeric, 1) || '%');
  return v_id;
end;
$$;

create or replace function public.clear_segment_incline(p_segment_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_surveyor();
  v_n   integer;
begin
  update public.measurements set superseded_at = now()
   where target_type = 'segment' and target_id = p_segment_id and key = 'incline' and source <> 'dem' and superseded_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception '구간 %에 되돌릴 실측 경사가 없습니다', p_segment_id using errcode = 'P0002';
  end if;
  update public.segments set updated_at = now() where id = p_segment_id;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('segment', p_segment_id, null, 'reverted', v_uid, '실측 경사 지움 → 추정값');
  return v_n;
end;
$$;

create or replace function public.update_admin_path(
  p_id          bigint,
  p_incline_pct double precision,
  p_incline_deg double precision default null,
  p_note        text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_surveyor();
begin
  if p_incline_pct is null or p_incline_pct < 0 or p_incline_pct >= 100 then
    raise exception '경사는 0~100%% 사이여야 합니다' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 300 then
    raise exception '설명은 300자 이하로 써 주세요' using errcode = '22023';
  end if;
  update public.admin_paths
     set incline_pct = p_incline_pct, incline_deg = p_incline_deg, note = nullif(btrim(p_note), '')
   where id = p_id and status = 'active';
  if not found then
    raise exception '관리자 추가 길 %을 찾을 수 없습니다 (숨김?)', p_id using errcode = 'P0002';
  end if;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('admin_path', p_id, 'active', 'edited', v_uid, '경사 ' || round(p_incline_pct::numeric, 1) || '%');
end;
$$;

revoke all on function public.set_segment_incline(bigint, double precision, double precision, double precision, double precision) from public;
revoke all on function public.clear_segment_incline(bigint) from public;
revoke all on function public.update_admin_path(bigint, double precision, double precision, text) from public;
grant execute on function public.set_segment_incline(bigint, double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.clear_segment_incline(bigint) to authenticated;
grant execute on function public.update_admin_path(bigint, double precision, double precision, text) to authenticated;

notify pgrst, 'reload schema';
