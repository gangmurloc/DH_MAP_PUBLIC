-- 공개 API(R-501)를 Vercel 함수(app/api/features.ts)로 낸다. Supabase Edge Function 대신 (CLI 없이 배포하려고).
-- features()는 처음부터 공개용으로 짰다: 숨김 장애물 제외, 시민 제보 원문·사진·제보자·조사자 정보 없음, 한 번에 최대 1,000건.
-- Vercel 함수는 브라우저용 공개 키(publishable)로 부르므로 anon에게 실행 권한을 준다.
grant execute on function public.features(double precision[], text, text[], text[], timestamptz, integer) to anon;
