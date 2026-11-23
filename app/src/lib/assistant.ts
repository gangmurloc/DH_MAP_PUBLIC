// AI 길 안내 클라이언트: 글자 → 의도·장소(서버), 사실 → 답(서버). 말 → 글자는 서버 STT(app/src/lib/voice.ts, 2026-11-21 브라우저 음성 인식에서 교체)
// 서버: 개발 중에는 Vite의 /api/assistant, 배포 후에는 Vercel 함수 /api/assistant (같은 공용 로직 app/server/assistant.ts)

export interface Place {
  name: string
  address: string
  lon: number
  lat: number
  category: string
}

export interface ParseResult {
  intent: { kind: 'route' | 'info' | 'other'; from: string | null; to: string | null; mode: 'wheelchair' | 'general'; question: string | null }
  places: { from: Place[]; to: Place[] }
  /** 서버에 카카오 REST 키가 있는가 */
  kakao: boolean
  placesError: string | null
}

async function call<T>(body: unknown): Promise<T> {
  // 개발 서버와 Vercel 배포 모두 같은 주소의 /api/assistant (키는 서버에만)
  const res = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.message || `서버 오류 ${res.status}`)
  return data as T
}

/** 장소 검색 (카카오, 동해시 범위) */
export const searchPlaces = (query: string) => call<{ places: Place[] }>({ action: 'search', query }).then((r) => r.places)
export const parseRequest = (text: string) => call<ParseResult>({ action: 'parse', text })
export const askQuestion = (question: string, facts: unknown) => call<{ answer: string }>({ action: 'answer', question, facts }).then((r) => r.answer)

/** 카카오톡·네이버·인스타그램 앱 안 브라우저는 마이크·센서를 막는 경우가 많다 (HANDOFF 9절) */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent
  if (/KAKAOTALK/i.test(ua)) return '카카오톡'
  if (/NAVER\(inapp/i.test(ua)) return '네이버'
  if (/Instagram/i.test(ua)) return '인스타그램'
  return null
}

/** 답을 소리로 읽기 (지원하면) */
export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'ko-KR'
  window.speechSynthesis.speak(u)
}
