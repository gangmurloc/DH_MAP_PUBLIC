-- 현장 조사 결과를 지도·길 안내에 반영 (MVP 1·2단계)
-- 1) 등급 제안 기준을 법에 맞춘다 (2026-11-20 팀 결정 "법대로 간다")
--    장애인등편의법 시행규칙 [별표 1] 제1호: 단차 2cm 이하, 유효폭 1.2m 이상 "하여야 한다"
--    → 2cm 넘는 턱, 1.2m 미만 폭은 '주의'가 아니라 '통행 어려움'.
update public.grading_params set value = 0.02, provisional = false,
  note = '이 높이를 넘는 턱은 통행 어려움 (법: 단차 2cm 이하)',
  source = '편의법 시행규칙 별표1 제1호 나목(2)'
where key = 'kerb_caution_max_m';
update public.grading_params set value = 1.2, provisional = false,
  note = '이 폭보다 좁으면 통행 어려움 (법: 유효폭 1.2m 이상)',
  source = '편의법 시행규칙 별표1 제1호 가목(1)'
where key = 'width_difficult_min_m';
update public.grading_params set source = '편의법 시행규칙 별표1 제1호 가목(1)' where key = 'width_caution_min_m';
update public.grading_params set source = '편의법 시행규칙 별표1 제1호 나목(2)' where key = 'kerb_passable_max_m';

-- 2) 조사된 구간 목록 (공개): 조사 등급 또는 현장 측정 경사가 있는 구간만.
--    측정자·메모 등 사람 정보는 내보내지 않는다. 앱이 시작할 때 한 번 받아 추정값 위에 덮어쓴다.
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
    where m.target_type = 'segment' and m.key = 'incline' and m.source <> 'dem'
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

revoke all on function public.surveyed_segments() from public;
grant execute on function public.surveyed_segments() to anon, authenticated, service_role;
