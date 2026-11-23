-- 관리자 추가 길: 카카오 지도에는 흰색 길로 보이지만 우리 길 데이터(수치지도·OSM)에 없는 길을
-- 관리자·조사원이 지도에 직접 그려 넣고 경사(현장에서 잰 값)를 함께 남긴다.
-- 공개 지도는 admin_paths_public()으로 받아 지도에 그리고, 양 끝을 가까운 기존 길에 이어 길 안내에도 쓴다.
create table if not exists public.admin_paths (
  id          bigserial primary key,
  geom        extensions.geometry(LineString, 4326) not null,
  incline_pct double precision not null check (incline_pct >= 0 and incline_pct < 100),  -- 지도가 쓰는 경사 %
  incline_deg double precision,                                                           -- 입력한 각도 (기록용)
  note        text check (note is null or char_length(note) <= 300),
  status      text not null default 'active' check (status in ('active', 'hidden')),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists admin_paths_geom_idx on public.admin_paths using gist (geom);

alter table public.admin_paths enable row level security;
drop policy if exists admin_paths_read on public.admin_paths;
create policy admin_paths_read on public.admin_paths for select to authenticated using (public.is_surveyor());
-- 쓰기는 아래 함수로만

-- 새 길 추가: p_coords = [[경도, 위도], ...] (2~500점, 동해시 범위)
create or replace function public.add_admin_path(
  p_coords      jsonb,
  p_incline_pct double precision,
  p_incline_deg double precision default null,
  p_note        text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid  uuid := public.require_surveyor();
  v_n    integer;
  v_geom geometry;
  v_id   bigint;
begin
  if jsonb_typeof(p_coords) <> 'array' then
    raise exception '좌표는 [[경도, 위도], ...] 배열이어야 합니다' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_coords);
  if v_n < 2 or v_n > 500 then
    raise exception '길은 점 2~500개로 그려야 합니다 (지금 %개)', v_n using errcode = '22023';
  end if;
  select ST_SetSRID(ST_MakeLine(array_agg(ST_MakePoint((e->>0)::float8, (e->>1)::float8) order by i)), 4326)
    into v_geom
    from jsonb_array_elements(p_coords) with ordinality as t(e, i);
  if not ST_Within(v_geom, ST_MakeEnvelope(128.90, 37.38, 129.25, 37.65, 4326)) then
    raise exception '동해시 범위 밖의 좌표가 있습니다' using errcode = '22023';
  end if;
  if ST_Length(v_geom::geography) < 2 then
    raise exception '길이가 너무 짧습니다 (2m 미만)' using errcode = '22023';
  end if;
  if p_incline_pct is null or p_incline_pct < 0 or p_incline_pct >= 100 then
    raise exception '경사는 0~100%% 사이여야 합니다' using errcode = '22023';
  end if;
  insert into public.admin_paths (geom, incline_pct, incline_deg, note, created_by)
  values (v_geom, p_incline_pct, p_incline_deg, nullif(btrim(p_note), ''), v_uid)
  returning id into v_id;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('admin_path', v_id, null, 'active', v_uid, round(p_incline_pct::numeric, 1) || '%');
  return v_id;
end;
$$;

-- 잘못 그린 길 숨기기
create or replace function public.hide_admin_path(p_id bigint, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_surveyor();
begin
  update public.admin_paths set status = 'hidden' where id = p_id and status = 'active';
  if not found then
    raise exception '관리자 추가 길 %을 찾을 수 없습니다 (이미 숨김?)', p_id using errcode = 'P0002';
  end if;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('admin_path', p_id, 'active', 'hidden', v_uid, p_note);
end;
$$;

-- 공개 목록 (로그인 없이): 숨기지 않은 길만, 만든 사람 정보는 내보내지 않는다
create or replace function public.admin_paths_public()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id,
           'coords', ST_AsGeoJSON(geom, 6)::jsonb -> 'coordinates',
           'incline', round(incline_pct::numeric, 2),
           'deg', incline_deg,
           'note', note,
           'at', created_at
         ) order by id), '[]'::jsonb)
  from public.admin_paths
  where status = 'active';
$$;

revoke all on function public.add_admin_path(jsonb, double precision, double precision, text) from public;
revoke all on function public.hide_admin_path(bigint, text) from public;
revoke all on function public.admin_paths_public() from public;
grant execute on function public.add_admin_path(jsonb, double precision, double precision, text) to authenticated;
grant execute on function public.hide_admin_path(bigint, text) to authenticated;
grant execute on function public.admin_paths_public() to anon, authenticated, service_role;
grant select on public.admin_paths to authenticated;
