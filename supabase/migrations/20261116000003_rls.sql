-- 동해 무장애지도: 권한 (TECH_SPEC 5절 권한)
-- · 테이블 자동 API는 앱 내부용. 외부 공개는 Edge Function(/features, /route)으로만.
-- · 쓰기 정책은 시민 제보 insert 하나뿐. 나머지 쓰기는 security definer 함수가 역할을 확인하고 한다.
-- · 시민은 익명 로그인(authenticated, is_anonymous)이고, 조사원은 app_metadata.role = 'surveyor'.

alter table public.nodes            enable row level security;
alter table public.segments         enable row level security;
alter table public.crosswalks       enable row level security;
alter table public.places           enable row level security;
alter table public.segment_surveys  enable row level security;
alter table public.obstacles        enable row level security;
alter table public.measurements     enable row level security;
alter table public.reports          enable row level security;
alter table public.extractions      enable row level security;
alter table public.obstacle_reports enable row level security;
alter table public.status_events    enable row level security;
alter table public.grading_params   enable row level security;

-- 지도에 그리는 공개 성격의 데이터: 로그인한 사용자(익명 포함) 읽기
create policy nodes_read      on public.nodes      for select to authenticated using (true);
create policy segments_read   on public.segments   for select to authenticated using (true);
create policy crosswalks_read on public.crosswalks for select to authenticated using (true);
create policy places_read     on public.places     for select to authenticated using (true);
create policy params_read     on public.grading_params for select to authenticated using (true);

-- 장애물: 숨김은 조사원만 (사진 경로는 앱에서 조사원 화면에만 사용)
create policy obstacles_read on public.obstacles for select to authenticated
  using (status <> 'hidden' or public.is_surveyor());

-- 조사 기록·측정·이력: 조사원만 직접 읽기 (공개는 /features가 조사자 정보를 빼고 제공)
create policy surveys_read      on public.segment_surveys  for select to authenticated using (public.is_surveyor());
create policy measurements_read on public.measurements     for select to authenticated using (public.is_surveyor());
create policy events_read       on public.status_events    for select to authenticated using (public.is_surveyor());
create policy extractions_read  on public.extractions      for select to authenticated using (public.is_surveyor());
create policy obs_reports_read  on public.obstacle_reports for select to authenticated using (public.is_surveyor());

-- 시민 제보: 본인 것만 쓰고 읽기, 조사원은 모두 읽기. 상태·묶음은 트리거가 정한다.
create policy reports_insert_own on public.reports for insert to authenticated
  with check (user_id = auth.uid() and license_agreed);
create policy reports_read on public.reports for select to authenticated
  using (user_id = auth.uid() or public.is_surveyor());

-- 테이블 권한은 최소로. Supabase 기본값은 새 테이블에 anon·authenticated 모든 권한(TRUNCATE 포함)을 준다.
-- RLS는 TRUNCATE를 막지 못하므로 권한 자체를 거둔다 (로컬 검증에서 확인, 2026-11-17).
-- anon(로그인 안 한 요청): 테이블을 열지 않는다
-- authenticated: 읽기(행은 RLS가 거름) + 시민 제보 insert만
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant insert on public.reports to authenticated;
grant usage on sequence public.reports_id_seq to authenticated;
