-- 무장애 경로 추천 기준(2026-11-20) 값: 앱(slopeRoute.ts ROUTE_PARAMS)과 서버가 같은 값을 읽는다.
-- 상한·주의 경계는 기존 행을 그대로 쓴다: incline_caution_max_pct(8.3), incline_passable_max_pct(5.6).
-- 근거 자료가 없는 값은 provisional = true (동해 현장 측정·선택 실험으로 교체).
-- 경사별 속도 계수 곡선은 꺾이는 점마다 한 행: route_<up|down>_<manual|powered>_pct_<경사%> = 계수 (사이는 직선 보간)

alter table public.grading_params add column if not exists provisional boolean not null default false;
alter table public.grading_params add column if not exists source text;

insert into public.grading_params (key, value, note, provisional, source) values
  ('route_min_user_grade_pct', 4, '사용자 상한 슬라이더 최저값 (8.3보다 높일 수 없음)', false, 'C AccessMap 아이디어'),
  ('route_ambiguous_margin_pct', 0.3, '추정 경사는 상한 − 이 값부터 급경사 (경계값 8.0~8.6%)', false, '무장애 경로 추천 기준'),
  ('route_speed_manual_mps', 0.6, '수동휠체어 평지 속도 m/s', false, 'D TCAT Walksheds'),
  ('route_speed_powered_mps', 2.0, '전동휠체어 평지 속도 m/s', false, 'D TCAT Walksheds'),
  ('route_speed_walk_mps', 1.2, '일반 보행 속도 m/s (일반 경로 시간 표시)', true, null),
  ('route_rest_every_m', 9, '5.6% 이상 경사가 이어지면 이 거리마다 쉬기', false, 'A 신동홍(2020) 높이 0.75m마다 참'),
  ('route_rest_sec', 15, '쉬는 시간 초', true, '경사 주행 시간 측정으로 교체'),
  ('route_raised_crossing_manual_sec', 90, '턱 있는 횡단보도 벌점 초 (수동)', true, '휠체어 사용자 선택 실험으로 교체'),
  ('route_raised_crossing_powered_sec', 240, '턱 있는 횡단보도 벌점 초 (전동)', true, '휠체어 사용자 선택 실험으로 교체'),
  ('route_unknown_crosswalk_raised_p', 0.14, '턱낮춤 정보 없는 횡단보도가 턱 있을 확률', false, '동해 횡단보도표준데이터 158/1107'),
  ('route_free_crossing_raised_p', 0.5, '표시 없는 횡단(4차로 미만 교차로)이 턱 있을 확률', true, null),
  ('route_detour_ratio', 1.2, '무장애 최단 경로보다 이 배수 넘게 길면 대안', true, 'E Kasemsuppakorn(2015), F Džafić(2020)'),
  ('route_detour_extra_m', 200, '무장애 최단 경로보다 이 거리 넘게 길면 대안', true, 'F Džafić(2020)'),
  ('route_factor_unknown_slope', 1.8, '경사 모름(교량·터널·옹벽에 가림) 시간 배수', true, null),
  ('route_factor_wall_crossing', 2, '옹벽·절토 가로지름(계단·단차 후보) 시간 배수', true, null),
  ('route_factor_obstacle_caution', 2, '확인된 주의 장애물 시간 배수', true, null),
  ('route_factor_no_sidewalk', 1.4, '보도 자료 없는 큰길 시간 배수', true, null),
  ('route_factor_narrow_sidewalk', 1.3, '보도 폭 1.2m 미만 시간 배수', true, null),
  ('route_factor_unpaved', 1.5, '비포장 시간 배수', true, null),
  ('route_factor_uncertain_slope', 1.15, '경사 추정 불일치 시간 배수', true, null),
  ('route_factor_osm_path', 1.15, 'OSM 보완 길 시간 배수', true, null),
  ('route_factor_assumed_link', 1.5, '연결 추정 구간 배수 (모든 모드)', true, null),
  ('route_up_manual_pct_0', 1, '수동 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_up_manual_pct_2', 1, '수동 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_up_manual_pct_4', 0.7, '수동 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_up_manual_pct_5.6', 0.5, '수동 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_up_manual_pct_8.3', 0.33, '수동 오르막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_up_manual_pct_12', 0.2, '수동 오르막 속도 계수 (상한 넘는 길은 갈 길이 없을 때만)', true, null),
  ('route_up_powered_pct_0', 1, '전동 오르막 속도 계수', true, null),
  ('route_up_powered_pct_4', 1, '전동 오르막 속도 계수', true, null),
  ('route_up_powered_pct_8.3', 0.8, '전동 오르막 속도 계수', true, null),
  ('route_up_powered_pct_12', 0.6, '전동 오르막 속도 계수', true, null),
  ('route_down_manual_pct_0', 1, '수동 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_down_manual_pct_5', 1, '수동 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_down_manual_pct_8.3', 0.7, '수동 내리막 속도 계수', true, '무장애 경로 추천 기준 임시값'),
  ('route_down_manual_pct_12', 0.5, '수동 내리막 속도 계수', true, null),
  ('route_down_powered_pct_0', 1, '전동 내리막 속도 계수', true, null),
  ('route_down_powered_pct_5', 1, '전동 내리막 속도 계수', true, null),
  ('route_down_powered_pct_8.3', 0.7, '전동 내리막 속도 계수', true, null),
  ('route_down_powered_pct_12', 0.5, '전동 내리막 속도 계수', true, null)
on conflict (key) do nothing;

update public.grading_params set source = 'A 신동홍(2020) 경사로 최대 1/12' where key = 'incline_caution_max_pct' and source is null;
update public.grading_params set source = 'A 신동홍(2020) BF 최우수 1/18' where key = 'incline_passable_max_pct' and source is null;
update public.grading_params set provisional = true where key in ('kerb_caution_max_m', 'width_difficult_min_m');
