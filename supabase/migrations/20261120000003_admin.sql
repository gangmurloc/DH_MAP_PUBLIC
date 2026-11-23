-- 관리자 역할 (11/20, 팀 요청: 제보 확인·지도 수정에 관리자 필요)
-- 역할은 Supabase Auth의 app_metadata.role (사용자가 스스로 못 바꾼다, 서버·관리자 함수만 바꾼다)
--   admin    : 관리자. 조사원이 하는 일 전부 + 장애물 숨김 + 역할 주기
--   surveyor : 조사원. 제보 처리, 장애물 등록·해소, 조사 완료
-- 모든 처리는 status_events에 누가·언제·무엇을 남긴다.

create or replace function public.app_role()
returns text
language sql stable
set search_path = public
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

-- 관리자도 조사원 함수를 쓸 수 있게 (기존 is_surveyor를 넓힌다)
create or replace function public.is_surveyor()
returns boolean
language sql stable
set search_path = public
as $$
  select public.app_role() in ('surveyor', 'admin')
$$;

create or replace function public.is_admin()
returns boolean
language sql stable
set search_path = public
as $$
  select public.app_role() = 'admin'
$$;

create or replace function public.require_admin()
returns uuid
language plpgsql
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '관리자 계정만 할 수 있습니다' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- 장애물 숨김 (잘못 등록·중복): 지도·길 안내·공개 API에서 빠진다. 관리자만
create or replace function public.hide_obstacle(p_obstacle_id bigint, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := public.require_admin();
  v_old text;
  v_seg bigint;
begin
  select o.status::text, o.segment_id into v_old, v_seg from public.obstacles o where o.id = p_obstacle_id for update;
  if not found then
    raise exception '장애물 %을 찾을 수 없습니다', p_obstacle_id using errcode = 'P0002';
  end if;
  update public.obstacles set status = 'hidden', updated_at = now() where id = p_obstacle_id;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('obstacle', p_obstacle_id, v_old, 'hidden', v_uid, p_note);
  if v_seg is not null then
    update public.segments set updated_at = now() where id = v_seg;
  end if;
  return jsonb_build_object('obstacle_id', p_obstacle_id, 'segment_id', v_seg);
end;
$$;

-- 역할 주기·빼기 (관리자만). 바뀐 역할은 그 사용자가 다시 로그인하면 반영된다
create or replace function public.admin_set_role(p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid  uuid := public.require_admin();
  v_user uuid;
  v_old  text;
begin
  if p_role not in ('admin', 'surveyor', 'none') then
    raise exception '역할은 admin·surveyor·none 중 하나여야 합니다' using errcode = '22023';
  end if;
  select id, raw_app_meta_data ->> 'role' into v_user, v_old from auth.users where lower(email) = lower(trim(p_email));
  if not found then
    raise exception '% 계정을 찾을 수 없습니다 (Supabase Authentication에서 먼저 만든다)', p_email using errcode = 'P0002';
  end if;
  if v_user = v_uid and p_role <> 'admin' then
    raise exception '자기 자신의 관리자 역할은 뺄 수 없습니다' using errcode = '22023';
  end if;
  update auth.users
  set raw_app_meta_data = case when p_role = 'none' then coalesce(raw_app_meta_data, '{}'::jsonb) - 'role'
                               else coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', p_role) end
  where id = v_user;
  insert into public.status_events (entity_type, entity_id, from_status, to_status, actor_id, note)
  values ('role', 0, v_old, p_role, v_uid, lower(trim(p_email)));
  return jsonb_build_object('email', lower(trim(p_email)), 'role', p_role);
end;
$$;

-- 역할이 있는 계정 목록 (관리자만)
create or replace function public.admin_list_members()
returns table (email text, role text, last_sign_in_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.require_admin();
  return query
    select u.email::text, (u.raw_app_meta_data ->> 'role')::text, u.last_sign_in_at
    from auth.users u
    where u.raw_app_meta_data ->> 'role' in ('admin', 'surveyor')
    order by 2, 1;
end;
$$;

-- 처리 기록 보기: status_events는 조사원 이상 읽기 (기존 정책 events_read가 is_surveyor를 쓴다 → 관리자 포함)

revoke all on function public.app_role(), public.is_admin(), public.require_admin(),
  public.hide_obstacle(bigint, text), public.admin_set_role(text, text), public.admin_list_members() from public, anon;
grant execute on function public.app_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.hide_obstacle(bigint, text) to authenticated;
grant execute on function public.admin_set_role(text, text) to authenticated;
grant execute on function public.admin_list_members() to authenticated;
