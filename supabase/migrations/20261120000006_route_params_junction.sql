-- 횡단보도 자료 없는 큰길 교차로 횡단 벌점, 갈 길이 없을 때 상한 초과 벌점 (slopeRoute.ts ROUTE_PARAMS와 같게)
insert into public.grading_params (key, value, note, provisional, source) values
  ('route_junction_crossing_m', 50, '횡단보도 자료 없는 4차로 이상 교차로 횡단: 일반 경로 +m', true, null),
  ('route_junction_crossing_sec', 60, '횡단보도 자료 없는 4차로 이상 교차로 횡단: 휠체어 +초', true, null),
  ('route_over_cap_penalty_sec', 6, '갈 길이 없을 때 상한 넘는 구간 벌점 초 = 길이 m × (넘는 %p)² × 이 값', true, null)
on conflict (key) do nothing;
