// AI 음성 길 안내 공용 로직 (HANDOFF 🆕 6절). 쓰는 곳: Vercel 함수(app/api/assistant.ts, 배포),
// Vite 개발 서버(/api/assistant), Supabase Edge Function(supabase/functions/assistant, 예비).
// fetch만 쓰고 런타임 전용 API는 쓰지 않는다. 키는 호출하는 쪽이 env로 넘긴다 (브라우저로 가지 않음).
//
// 원칙: AI는 장소 '이름'과 질문 종류만 뽑는다. 좌표는 카카오 장소 검색, 경사·거리는 우리 데이터에서 온다.
// 정보 질문의 답도 앱이 넘긴 사실(facts)만 근거로 문장을 만든다. AI가 수치를 지어내지 않는다 (HANDOFF 3절).

export interface AssistantEnv {
  bazeKey?: string
  bazeBase?: string
  model?: string
  kakaoRestKey?: string
}

export type IntentKind = "route" | "info" | "other"

export interface Intent {
  kind: IntentKind
  from: string | null
  to: string | null
  mode: "wheelchair" | "general"
  question: string | null
}

export interface Place {
  name: string
  address: string
  lon: number
  lat: number
  category: string
}

// 동해시 대략 범위 (카카오 장소 검색 rect: 왼쪽 경도, 아래 위도, 오른쪽 경도, 위 위도)
const DONGHAE_RECT = "128.98,37.42,129.17,37.61"
const DEFAULT_BASE = "https://factchat-cloud.mindlogic.ai/v1/gateway"
const DEFAULT_MODEL = "gpt-6-luna"

async function chat(env: AssistantEnv, system: string, user: string, maxTokens = 400): Promise<string> {
  if (!env.bazeKey) throw new Error("BAZE_API_KEY not set")
  const res = await fetch(`${env.bazeBase || DEFAULT_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.bazeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.model || DEFAULT_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: maxTokens,
    }),
  })
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return String(data?.choices?.[0]?.message?.content ?? "")
}

function firstJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

const INTENT_SYSTEM = `너는 강원도 동해시 무장애(휠체어·유모차) 지도 앱의 입력 해석기다.
사용자 말에서 아래 JSON 하나만 출력한다. 설명 문장은 쓰지 않는다.
{"kind":"route"|"info"|"other","from":string|null,"to":string|null,"mode":"wheelchair"|"general","question":string|null}
- kind: 길을 묻거나 어디로 가고 싶다 → "route". 길·구간·경사·장소에 대한 질문 → "info". 그 밖 → "other".
- from/to: 사용자가 말한 장소 이름 그대로 (예: "터미널", "동해시청소년센터", "묵호역"). 말하지 않았으면 null. "여기", "지금 위치"는 null.
- 좌표·주소·거리·경사 같은 수치는 절대 만들지 않는다.
- mode: 휠체어·유모차·보행 보조기·무장애를 말하거나 언급이 없으면 "wheelchair". "그냥 걸어서", "빠른 길"이면 "general".
- question: kind가 "info"면 질문을 한 문장으로 다듬어 넣는다. 아니면 null.`

export async function parseIntent(text: string, env: AssistantEnv): Promise<Intent> {
  const out = firstJson(await chat(env, INTENT_SYSTEM, text, 300)) ?? {}
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const kind = out.kind === "route" || out.kind === "info" ? out.kind : "other"
  return {
    kind,
    from: str(out.from),
    to: str(out.to),
    mode: out.mode === "general" ? "general" : "wheelchair",
    question: str(out.question) ?? (kind === "info" ? text : null),
  }
}

/** 카카오 로컬 키워드 검색 (동해시 범위). 키가 없으면 빈 목록 */
export async function searchPlaces(query: string, env: AssistantEnv, size = 5): Promise<Place[]> {
  if (!env.kakaoRestKey || !query) return []
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&rect=${DONGHAE_RECT}&size=${size}`
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${env.kakaoRestKey}` } })
  if (!res.ok) throw new Error(`카카오 장소 검색 ${res.status}`)
  const data = await res.json()
  return (data?.documents ?? []).map((d: Record<string, string>) => ({
    name: d.place_name,
    address: d.road_address_name || d.address_name,
    lon: Number(d.x),
    lat: Number(d.y),
    category: d.category_group_name || d.category_name || "",
  }))
}

const ANSWER_SYSTEM = `너는 강원도 동해시 무장애 지도 앱의 안내원이다. 휠체어·유모차 이용자에게 한국어로 2~3문장, 쉬운 말로 답한다.
- 아래 '사실' JSON에 있는 내용만 근거로 쓴다. 사실에 없는 경사·거리·장소·시설은 말하지 않고 "아직 자료가 없다"고 한다.
- 경사 값은 현장 측정 전 '추정'이라는 점을 밝힌다. '통행 가능하다'고 단정하지 않는다.
- 숫자는 사실에 있는 값을 반올림해서만 쓴다.`

export async function answerQuestion(question: string, facts: unknown, env: AssistantEnv): Promise<string> {
  const factsText = JSON.stringify(facts ?? {}).slice(0, 6000)
  return (await chat(env, ANSWER_SYSTEM, `사실: ${factsText}\n\n질문: ${question}`, 500)).trim()
}

/** 요청 하나 처리. body.action: "search" {query} | "parse" {text} | "answer" {question, facts} */
export async function handleAssistant(body: unknown, env: AssistantEnv): Promise<{ status: number; json: unknown }> {
  const b = (body ?? {}) as Record<string, unknown>
  try {
    if (b.action === "parse") {
      const text = typeof b.text === "string" ? b.text.trim().slice(0, 500) : ""
      if (!text) return { status: 400, json: { error: "bad_request", message: "text가 비었습니다" } }
      const intent = await parseIntent(text, env)
      let places: { from: Place[]; to: Place[] } = { from: [], to: [] }
      let placesError: string | null = null
      try {
        const [from, to] = await Promise.all([
          intent.from ? searchPlaces(intent.from, env) : Promise.resolve([]),
          intent.to ? searchPlaces(intent.to, env) : Promise.resolve([]),
        ])
        places = { from, to }
      } catch (e) {
        placesError = (e as Error).message
      }
      return { status: 200, json: { intent, places, kakao: Boolean(env.kakaoRestKey), placesError } }
    }
    if (b.action === "search") {
      // 장소 검색 (AI 없이 카카오 키워드 검색, 동해시 범위)
      const q = typeof b.query === "string" ? b.query.trim().slice(0, 60) : ""
      if (!q) return { status: 400, json: { error: "bad_request", message: "query가 비었습니다" } }
      if (!env.kakaoRestKey) return { status: 503, json: { error: "no_key", message: "장소 검색 키가 없습니다" } }
      return { status: 200, json: { places: await searchPlaces(q, env, 10) } }
    }
    if (b.action === "answer") {
      const q = typeof b.question === "string" ? b.question.trim().slice(0, 500) : ""
      if (!q) return { status: 400, json: { error: "bad_request", message: "question이 비었습니다" } }
      return { status: 200, json: { answer: await answerQuestion(q, b.facts, env) } }
    }
    return { status: 400, json: { error: "bad_request", message: "action은 search·parse·answer 중 하나" } }
  } catch (e) {
    return { status: 502, json: { error: "upstream", message: (e as Error).message } }
  }
}
