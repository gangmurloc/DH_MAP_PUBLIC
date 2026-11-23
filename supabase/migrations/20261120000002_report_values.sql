-- 시민 제보 측정값 (선택): 턱 높이(cm), 횡경사(%). 제보는 확인 요청일 뿐이고, 조사원이 현장에서 맞음을 눌러야 장애물이 된다 (HANDOFF 3절)
alter table public.reports
  add column if not exists measured_value real check (measured_value is null or (measured_value >= 0 and measured_value <= 1000)),
  add column if not exists measured_unit  text check (measured_unit is null or measured_unit in ('cm', '%'));

-- 측정값과 단위는 같이 있어야 한다
alter table public.reports
  add constraint reports_measured_pair check ((measured_value is null) = (measured_unit is null));
