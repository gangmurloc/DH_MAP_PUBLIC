-- 과도한 우회 안내 기준 (과도한 우회 안내 설계): 휠체어 경로가 일반 경로보다
-- 이 배수 이상 그리고 이 거리 이상 길면 '추천'이라 하지 않고 '멀리 돌아가는 길'로 안내한다.
-- 앱(slopeRoute.ts ROUTE_PARAMS detourWarnRatio·detourWarnExtraM)과 같은 값. 근거 없는 임시값.
insert into public.grading_params (key, value, note, provisional, source) values
  ('route_detour_warn_ratio', 3, '휠체어 경로 ÷ 일반 경로가 이 이상이면 과도한 우회 (거리 조건과 함께)', true, '기준 문서 E·F 참고, 휠체어 사용자 선택 실험으로 교체'),
  ('route_detour_warn_extra_m', 1000, '휠체어 경로 − 일반 경로가 이 m 이상이면 과도한 우회 (배수 조건과 함께)', true, '기준 문서 E·F 참고, 휠체어 사용자 선택 실험으로 교체')
on conflict (key) do nothing;
