// 카카오 지도 Web SDK 불러오기 (HANDOFF 🆕: 바탕 지도는 카카오, 우리 구간은 그 위에 Polyline으로 그린다)
// 키는 VITE_KAKAO_JS_KEY (도메인 제한 키라 브라우저에 있어도 된다). 카카오 개발자 콘솔에 접속 도메인이 등록돼 있어야 한다.

// SDK 전체 타입은 없으므로, 이 프로젝트가 쓰는 부분만 느슨하게 둔다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KakaoNS = any

declare global {
  interface Window {
    kakao?: KakaoNS
  }
}

let loading: Promise<KakaoNS> | null = null

export const KAKAO_JS_KEY: string | undefined = import.meta.env.VITE_KAKAO_JS_KEY

export function loadKakao(timeoutMs = 8000): Promise<KakaoNS> {
  if (loading) return loading
  loading = new Promise<KakaoNS>((resolve, reject) => {
    if (!KAKAO_JS_KEY) {
      reject(new Error('키 없음: app/.env.local의 VITE_KAKAO_JS_KEY'))
      return
    }
    if (window.kakao?.maps) {
      window.kakao.maps.load(() => resolve(window.kakao))
      return
    }
    const s = document.createElement('script')
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false`
    s.async = true
    const timer = window.setTimeout(() => reject(new Error('응답 없음')), timeoutMs)
    s.onload = () => {
      window.clearTimeout(timer)
      // 도메인 미등록이면 스크립트는 받아지지만 kakao.maps가 없다
      if (!window.kakao?.maps) {
        reject(new Error('JavaScript SDK 도메인 등록 확인'))
        return
      }
      window.kakao.maps.load(() => resolve(window.kakao))
    }
    s.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('도메인 미등록 또는 네트워크'))
    }
    document.head.appendChild(s)
  }).catch((e) => {
    loading = null // 다음에 다시 시도할 수 있게
    throw e
  })
  return loading
}
