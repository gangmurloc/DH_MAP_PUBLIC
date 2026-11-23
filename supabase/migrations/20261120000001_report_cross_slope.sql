-- 시민 제보에 횡경사 종류와 측정값을 받는다 (11/20, 팀 요청: 턱·계단·횡경사를 제보로 추가)
-- enum 값 추가는 같은 트랜잭션에서 바로 쓸 수 없어 파일을 나눈다 (다음 파일에서 사용)
alter type public.obstacle_type add value if not exists 'cross_slope';
