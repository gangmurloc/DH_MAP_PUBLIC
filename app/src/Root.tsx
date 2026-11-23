import { lazy, Suspense } from 'react'
import AreaLoader, { fetchJson } from './AreaLoader.tsx'

// 관리자 화면은 따로 받는다 (일반 사용자 첫 화면 코드를 키우지 않게)
const AdminApp = lazy(() => import('./AdminApp.tsx'))

// 주소 끝: (없음) 동해시 전체 경사 지도 + 길 안내 + 시민 제보 + 조사원 구간 조사 + 데이터 받기, #slope 청소년센터 주변, #admin 관리자
// (예전 #survey 현장 조사판은 2026-11-20 없앴다: 조사는 메인 지도에서 조사원으로 로그인해 한다. 옛 주소는 메인 지도로 연다)
export default function Root() {
  const h = window.location.hash
  if (h === '#admin')
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center bg-canvas p-6 text-ui text-fg-muted" role="status">관리자 화면 불러오는 중…</div>}>
        <AdminApp />
      </Suspense>
    )
  if (h === '#slope') return <AreaLoader load={() => import('./data/slope/slope.json').then((m) => m.default)} />
  return <AreaLoader load={() => fetchJson(`${import.meta.env.BASE_URL}data/donghae_city.json`)} />
}
