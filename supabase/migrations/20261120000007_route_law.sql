-- 2026-11-20 팀 결정: "법대로 간다" + 휠체어는 수동·전동 구분 없이 한 기준.
-- 근거: 장애인등편의법 시행규칙 [별표 1] 제1호 '장애인등의 통행이 가능한 접근로' (2023.12.11 개정)
--   기울기 1/18 이하(지형상 곤란 시 1/12까지) · 유효폭 1.2m 이상 · 단차 2cm 이하 · 평탄한 바닥 · 경사 연속 시 30m마다 참
-- 앱(slopeRoute.ts ROUTE_PARAMS, gradingParams.ts)과 같은 키를 쓴다.
-- 폭 1.2m 미만·턱낮춤 없는 횡단보도·비포장은 이제 벌점이 아니라 제외라서 배수 값이 없다.
-- 법 기준을 넘는 길을 경고와 함께 보여 주던 기능을 없애 상한 초과 벌점 값도 없다.

delete from public.grading_params where key in (
  'route_rest_every_m',
  'route_speed_manual_mps', 'route_speed_powered_mps',
  'route_raised_crossing_manual_sec', 'route_raised_crossing_powered_sec',
  'route_over_cap_penalty_sec',
  'route_factor_narrow_sidewalk', 'route_factor_unpaved'
) or key like 'route\_up\_manual\_pct\_%' or key like 'route\_up\_powered\_pct\_%'
  or key like 'route\_down\_manual\_pct\_%' or key like 'route\_down\_powered\_pct\_%';

insert into public.grading_params (key, value, note, provisional, source) values
  ('route_law_rest_every_m', 30, '5.6% 이상 경사가 이어지면 이 거리마다 쉬기', false, '편의법 시행규칙 별표1 제1호 가목(3): 경사진 접근로 연속 시 30m마다 참'),
  ('route_speed_wheelchair_mps', 0.6, '휠체어 평지 속도 m/s (수동·전동 중 느린 수동 값)', false, 'D TCAT Walksheds'),
  ('route_uncertain_crossing_sec', 90, '턱이 있을지 모르는 횡단의 벌점 기준 초 (× 턱 있을 확률)', true, '휠체어 사용자 선택 실험으로 교체'),
  ('route_wheelchair_up_pct_0', 1, '휠체어 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_up_pct_2', 1, '휠체어 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_up_pct_4', 0.7, '휠체어 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_up_pct_5.6', 0.5, '휠체어 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_up_pct_8.3', 0.33, '휠체어 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_up_pct_12', 0.2, '휠체어 오르막 속도 계수 (일반 경로 시간 표시용)', true, null),
  ('route_wheelchair_down_pct_0', 1, '휠체어 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_down_pct_5', 1, '휠체어 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_down_pct_8.3', 0.7, '휠체어 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값 (수동휠체어)'),
  ('route_wheelchair_down_pct_12', 0.5, '휠체어 내리막 속도 계수 (일반 경로 시간 표시용)', true, null)
on conflict (key) do update set value = excluded.value, note = excluded.note, provisional = excluded.provisional, source = excluded.source;

update public.grading_params set source = '편의법 시행규칙 별표1 제1호 나목(1): 지형상 곤란 시 1/12까지' where key = 'incline_caution_max_pct';
update public.grading_params set source = '편의법 시행규칙 별표1 제1호 나목(1): 접근로 1/18 이하' where key = 'incline_passable_max_pct';
