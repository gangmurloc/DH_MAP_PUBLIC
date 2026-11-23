-- 기타 장애물 (11/20, 팀 요청: 시민 제보에서 횡경사를 빼고 '기타 장애물'을 받는다)
-- 예: 불법 주차, 공사 자재, 볼라드, 입간판처럼 종류가 정해지지 않은 길막힘. 내용은 제보 메모(text)로 받는다.
-- cross_slope 값은 남겨 둔다 (조사원이 측정값으로 계속 기록할 수 있게)
alter type public.obstacle_type add value if not exists 'other';
