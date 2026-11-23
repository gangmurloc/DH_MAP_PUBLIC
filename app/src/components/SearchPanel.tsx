// 장소 검색 길 안내: 검색 → 결과마다 [출발] [도착]. 도착만 고르면 현재 위치에서 출발하고 내 위치를 따라간다.
// 좌표는 카카오 장소 검색(동해시 범위)과 우리 기관 목록에서만 온다. 경로는 기기 안에서 계산 (위치를 서버로 보내지 않음)
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LocateFixed, Mic, Search, Square } from 'lucide-react'
import { inAppBrowser, parseRequest, searchPlaces, type Place } from '@/lib/assistant'
import { MAX_RECORD_SEC, recordSupported, startRecording, transcribe, type Recording } from '@/lib/voice'
import { requestHeading } from '@/lib/heading'
import { ROUTE_HIGHLIGHT, ROUTE_STYLE, type SlopeArea } from '@/lib/slope'
import { openRoadview } from '@/lib/roadview'
import { DEFAULT_OPTIONS, planRoute, strictCap, type Blocker, type RouteOptions, type RoutePlan, type SlopeGraph, type SlopeRoute } from '@/lib/slopeRoute'
import type { LonLat } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { Hint, PanelSection } from '@/components/ui/panel'

export interface Endpoint {
  name: string
  lon: number
  lat: number
}

export interface RouteState {
  from: Endpoint
  to: Endpoint
  pair: RoutePlan
}

// 경사 상한은 사용자가 바꾸는 값이 아니다: 항상 법 기준 기본값(DEFAULT_OPTIONS, 8.3%)으로 계산한다
// (예전에 이 기기에 저장한 상한 'donghae-route-options'도 읽지 않는다)
const OPTS: RouteOptions = DEFAULT_OPTIONS

interface Props {
  area: SlopeArea
  graph: SlopeGraph
  route: RouteState | null
  onRoute: (r: RouteState | null) => void
  /** 현재 위치에서 출발하는 안내를 시작하면 true (지도가 내 위치를 따라간다) */
  onNavigate: (on: boolean) => void
  /** '이 구간 확인 요청': 막는 구간 위치·메모로 시민 제보 칸을 채운다 */
  onRequestCheck?: (at: LonLat, text: string) => void
  searchContainer: HTMLElement | null
  onSearch: () => void
}

const ALIASES: Record<string, string> = {
  터미널: '동해시종합버스터미널',
  버스터미널: '동해시종합버스터미널',
  청소년센터: '동해시청소년센터',
  시청: '동해시청',
}

function localMatches(area: SlopeArea, q: string): Place[] {
  const key = ALIASES[q.replace(/\s/g, '')] ?? q.replace(/\s/g, '')
  if (!key) return []
  const exact = area.places.filter((p) => p.name === key)
  return (exact.length ? exact : area.places.filter((p) => p.name.includes(key))).map((p) => ({ name: p.name, address: '', lon: p.lon, lat: p.lat, category: p.category }))
}

function currentPosition(): Promise<Endpoint> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('이 브라우저는 위치를 지원하지 않아요'))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ name: '현재 위치', lon: p.coords.longitude, lat: p.coords.latitude }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? '위치 권한이 꺼져 있어요. 출발지를 검색해서 골라 주세요.' : '현재 위치를 가져오지 못했어요. 출발지를 검색해서 골라 주세요.')),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
}

export function SearchPanel({ area, graph, route, onRoute, onNavigate, onRequestCheck, searchContainer, onSearch }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [from, setFrom] = useState<Endpoint | null>(null)
  const [to, setTo] = useState<Endpoint | null>(null)
  const searchVersion = useRef(0)
  const editVersion = useRef(0)
  // 음성 입력: 마이크 녹음 → 서버(FFmpeg 정규화 → STT) → 글자 → 검색. 녹음을 못 하는 브라우저에서는 마이크를 숨기고 글자 입력만
  const [canSpeak] = useState(recordSupported)
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [secLeft, setSecLeft] = useState(MAX_RECORD_SEC)
  const recording = useRef<Recording | null>(null)
  useEffect(() => () => recording.current?.stop(), [])
  const listening = voiceState === 'recording'

  const compute = (a: Endpoint, b: Endpoint, navigating: boolean) => {
    const pair = planRoute(graph, [a.lon, a.lat], [b.lon, b.lat], OPTS)
    if (!pair) {
      onRoute(null)
      setMsg(area.all ? '출발이나 도착이 동해시 길 데이터 밖이에요.' : `이 지도는 ${area.center.name} 반경 ${(area.radius / 1000).toFixed(1)}km 안만 다뤄요.`)
      return
    }
    setMsg(null)
    onRoute({ from: a, to: b, pair })
    onNavigate(navigating)
  }

  // 문장으로 길을 물으면 ("A에서 B로 가는 길 알려줘", "천곡동굴 가는 길"): 서버 AI가 출발·도착을 뽑고 카카오로 장소를 찾아 바로 경로를 낸다.
  // search(useCallback)가 최신 compute·pickTo를 쓰도록 ref로 둔다 (아래 pickTo 뒤의 효과에서 채움)
  const routeFromText = useRef<(query: string, version: number) => Promise<boolean>>(async () => false)

  const search = useCallback(async (text: string) => {
    const query = text.trim()
    if (!query) return
    const version = ++searchVersion.current
    setBusy(true)
    setMsg(null)
    try {
      if (await routeFromText.current(query, version)) return
      if (version !== searchVersion.current) return
      const local = localMatches(area, query)
      let kakao: Place[] = []
      try {
        kakao = await searchPlaces(query)
      } catch (e) {
        if (!local.length) throw e
      }
      const merged = [...local]
      for (const p of kakao) if (!merged.some((m) => m.name === p.name || (Math.abs(m.lon - p.lon) < 0.0005 && Math.abs(m.lat - p.lat) < 0.0005))) merged.push(p)
      if (version !== searchVersion.current) return
      setResults(merged.slice(0, 10))
      if (!merged.length) setMsg(`"${query}"을(를) 동해시에서 찾지 못했어요.`)
    } catch (e) {
      if (version === searchVersion.current) setMsg((e as Error).message)
    } finally {
      if (version === searchVersion.current) setBusy(false)
    }
  }, [area])

  // 마이크: 누르면 녹음, 다시 누르면(또는 30초) 멈추고 서버에서 글자로 바꾼 뒤 검색창에 넣고 바로 검색
  const voice = async () => {
    if (voiceState === 'recording') {
      recording.current?.stop()
      return
    }
    if (voiceState !== 'idle') return
    onSearch()
    setMsg(null)
    let tick: ReturnType<typeof setInterval> | null = null
    try {
      // 아이폰은 버튼 누른 처리 안에서 바로 마이크 권한을 물어야 한다
      const rec = await startRecording(MAX_RECORD_SEC)
      recording.current = rec
      // 검색창에 남은 예전 글자를 비워, 검색창 안내('듣고 있어요…' → '말을 글자로 바꾸는 중…')가 보이게 한다 (아래에 같은 안내를 또 쓰지 않는다)
      setQ('')
      setVoiceState('recording')
      const started = Date.now()
      setSecLeft(MAX_RECORD_SEC)
      tick = setInterval(() => setSecLeft(Math.max(0, MAX_RECORD_SEC - Math.floor((Date.now() - started) / 1000))), 250)
      const audio = await rec.result
      clearInterval(tick)
      tick = null
      setVoiceState('transcribing')
      const said = (await transcribe(audio)).trim().replace(/[.?!。]+$/, '')
      setQ(said)
      setVoiceState('idle')
      onSearch()
      await search(said)
    } catch (e) {
      const app = inAppBrowser()
      setMsg(`${(e as Error).message}${app ? ` (${app} 앱 안 브라우저는 마이크를 막을 수 있어요. 크롬·사파리로 열어 주세요.)` : ''}`)
    } finally {
      if (tick) clearInterval(tick)
      recording.current = null
      setVoiceState('idle')
    }
  }

  const pickFrom = (p: Endpoint) => {
    editVersion.current++
    searchVersion.current++
    setFrom(p)
    setResults(null)
    if (to) compute(p, to, false)
  }

  const pickTo = async (p: Endpoint) => {
    const version = ++editVersion.current
    searchVersion.current++
    // 아이폰 방향 권한은 버튼 누른 처리 안에서 먼저 묻는다
    void requestHeading()
    setTo(p)
    setResults(null)
    if (from) return compute(from, p, from.name === '현재 위치')
    setBusy(true)
    try {
      const here = await currentPosition()
      if (version !== editVersion.current) return
      setFrom(here)
      compute(here, p, true)
    } catch (e) {
      if (version === editVersion.current) setMsg((e as Error).message)
    } finally {
      if (version === editVersion.current) setBusy(false)
    }
  }

  // 출발이 없으면 현재 위치에서. 장소를 못 찾으면 false → 일반 장소 검색으로 넘어간다
  useEffect(() => {
    routeFromText.current = async (query, version) => {
      if (!ROUTE_SENTENCE.test(query)) return false
      const r = await parseRequest(query).catch(() => null)
      if (version !== searchVersion.current || !r || r.intent.kind !== 'route' || !r.places.to.length) return false
      const t = r.places.to[0]
      const f = r.intent.from ? r.places.from[0] : undefined
      if (r.intent.from && !f) return false
      const toE = { name: t.name, lon: t.lon, lat: t.lat }
      setResults(null)
      if (f) {
        const fromE = { name: f.name, lon: f.lon, lat: f.lat }
        editVersion.current++
        setFrom(fromE)
        setTo(toE)
        compute(fromE, toE, false)
      } else {
        await pickTo(toE)
      }
      return true
    }
  })

  const startFromHere = async () => {
    const version = ++editVersion.current
    searchVersion.current++
    setResults(null)
    void requestHeading()
    setBusy(true)
    try {
      const here = await currentPosition()
      if (version !== editVersion.current) return
      setFrom(here)
      if (to) compute(here, to, true)
    } catch (e) {
      if (version === editVersion.current) setMsg((e as Error).message)
    } finally {
      if (version === editVersion.current) setBusy(false)
    }
  }

  const clear = () => {
    editVersion.current++
    searchVersion.current++
    setFrom(null)
    setTo(null)
    setResults(null)
    setBusy(false)
    onRoute(null)
    onNavigate(false)
    setMsg(null)
  }

  const searchForm = (
      <form
        className="flex items-center gap-2" role="search"
        onSubmit={(e) => {
          e.preventDefault()
          onSearch()
          void search(q)
        }}
      >
        <div className="search-glass flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full px-3">
          <Search className="size-4 shrink-0 text-[#2455ae]/85" strokeWidth={1.75} aria-hidden />
        <input
          value={q}
          onFocus={() => { searchVersion.current++; setBusy(false); setResults(null); onSearch() }}
          onChange={(e) => { setQ(e.target.value); searchVersion.current++; setBusy(false); setResults(null) }}
          placeholder={listening ? '듣고 있어요… 장소 이름을 말해 주세요' : voiceState === 'transcribing' ? '말을 글자로 바꾸는 중…' : '장소 검색 (예: 묵호역, 동해시청)'}
          aria-label="장소 검색"
          className="h-full min-w-0 flex-1 bg-transparent text-ui text-[#243c65] outline-none placeholder:text-[#435774]"
          autoComplete="off"
        />
        </div>
        {canSpeak && (
          <button
            type="button"
            className={`search-glass flex size-11 shrink-0 items-center justify-center rounded-full ${listening ? 'text-danger' : 'text-[#2455ae]/85'} disabled:opacity-50`}
            onClick={() => void voice()}
            disabled={(busy && !listening) || voiceState === 'transcribing'}
            aria-pressed={listening}
            aria-label={listening ? '듣기 멈추기' : '말로 검색'}
            title={listening ? '듣기 멈추기' : '말로 검색'}
          >
            {listening ? <Square className="size-4 fill-current" aria-hidden /> : <Mic className="size-5" strokeWidth={1.75} aria-hidden />}
          </button>
        )}
        <button type="submit" className="search-glass h-11 shrink-0 rounded-full px-3 text-ui font-semibold text-[#2455ae]/85" disabled={busy || voiceState !== 'idle' || !q.trim()}>
          {busy ? '…' : '검색'}
        </button>
      </form>
  )

  return (
    <>
      {searchContainer && createPortal(searchForm, searchContainer)}
    <PanelSection title="길 찾기" aria-label="장소 검색 길 안내">

      {listening && (
        <p role="status" className="flex items-center gap-2 text-caption text-danger">
          <span className="inline-block size-2 animate-pulse rounded-full bg-danger" aria-hidden />
          듣고 있어요. 장소 이름을 말해 주세요. 말이 끝나면 저절로 멈춰요. ({secLeft}초 남음)
        </p>
      )}
      {canSpeak && voiceState !== 'idle' && <Hint>녹음은 글자로 바꾸는 데만 쓰고 저장하지 않아요. (음성 인식 업체 서버에 변환 결과가 1시간 남아요)</Hint>}


      {/* 검색 결과는 검색창 바로 아래(출발·도착 칸 위): 휴대폰에서 키보드가 올라와도 결과가 키보드 위에 보이게 */}
      {results && results.length > 0 && (
        <ul className="divide-y divide-line/6 overflow-hidden rounded-nav bg-tint/4" aria-label="검색 결과">
          {results.map((p) => (
            <li key={`${p.name}${p.lon}`} className="flex items-center gap-2 py-2 pr-2 pl-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui font-semibold text-fg">{p.name}</div>
                {(p.address || p.category) && <div className="truncate text-caption text-fg-muted">{p.address || (p.category && (PLACE_KIND[p.category] ?? p.category))}</div>}
              </div>
              <Button variant="hairline" onClick={() => pickFrom({ name: p.name, lon: p.lon, lat: p.lat })}>
                출발
              </Button>
              <Button variant="primary" onClick={() => void pickTo({ name: p.name, lon: p.lon, lat: p.lat })}>
                도착
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* 출발·도착: 테두리 없이 옅은 칸 하나, 두 줄 사이만 아주 옅은 선 */}
      <div className="rounded-nav bg-tint/4 p-1 text-ui">
        <div className="flex min-h-12 items-center gap-3 px-3">
          <EndpointDot label="출" color={ENDPOINT.from} />
          <span className={`min-w-0 flex-1 truncate ${from ? 'font-medium text-fg' : 'text-fg-subtle'}`} title={from?.name}>{from?.name ?? '출발 (비우면 현재 위치)'}</span>
            <Button variant="quiet" className="-mr-1 px-1.5!" onClick={() => void startFromHere()} disabled={busy}>
              <LocateFixed className="size-4" strokeWidth={1.75} aria-hidden />
              현재 위치
            </Button>
        </div>
        <div className="mx-3 border-t border-line/6" />
        <div className="flex min-h-12 items-center gap-3 px-3">
          <EndpointDot label="도" color={ENDPOINT.to} />
          <span className={`min-w-0 flex-1 truncate ${to ? 'font-medium text-fg' : 'text-fg-subtle'}`} title={to?.name}>{to?.name ?? '도착 (검색해서 고르기)'}</span>
        </div>
      </div>

      {(from || to) && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            className="flex-1"
            disabled={!from || !to}
            onClick={() => {
              if (!from || !to) return
              setFrom(to)
              setTo(from)
              compute(to, from, false)
            }}
          >
            ⇅ 출발·도착 바꾸기
          </Button>
          <Button variant="ghost" className="flex-1" onClick={clear}>
            지우기
          </Button>
        </div>
      )}

      {msg && <Notice role="status">{msg}</Notice>}
      {route && <RouteSummary route={route} onRequestCheck={onRequestCheck} />}
    </PanelSection>
    </>
  )
}

/** 우리 데이터의 주요 기관 분류(영어 코드) → 화면 글자. 카카오 검색 결과는 이미 한글 분류라 그대로 */
const PLACE_KIND: Record<string, string> = {
  transport: '교통', public: '공공기관', health: '병원·보건', welfare: '복지시설', safety: '경찰·소방',
  library: '도서관', culture: '문화시설', market: '시장', post: '우체국',
}

/** 장소 이름이 아니라 길을 묻는 문장인가: "…에서/부터 …", "… 가는 길", "…까지 가려면" 등 */
const ROUTE_SENTENCE = /(에서|부터)\s*\S|가는\s*길|가려면|가고\s*싶|까지\s*(가|어떻게)|(으로|로)\s*가/

/** 지도 위 출발·도착 표시와 같은 색 (KakaoSlopeMap) */
const ENDPOINT = { from: '#1d4ed8', to: '#b91c1c' }

function EndpointDot({ label, color }: { label: string; color: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-white text-caption font-semibold text-white" style={{ background: color }} aria-hidden>
      {label}
    </span>
  )
}

/** 경로 선 견본 (지도 위 선과 같은 색·모양) */
function RouteSwatch({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return dashed ? (
    <span className="inline-block h-0 w-5 shrink-0 border-t-[3px] border-dashed" style={{ borderColor: color }} aria-hidden />
  ) : (
    <span className="inline-block h-1.5 w-5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
  )
}

const m = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${Math.round(v)}m`)
const min = (sec: number) => {
  const mm = Math.round(sec / 60)
  if (mm < 1) return '1분 미만'
  return mm < 60 ? `약 ${mm}분` : `약 ${Math.floor(mm / 60)}시간${mm % 60 ? ` ${mm % 60}분` : ''}`
}
const pct = (v: number) => `${v.toFixed(1)}%`
/** 경사를 말로: 휠체어 기준 (5.6% = 1/18, 8.3% = 1/12) */
const feel = (v: number) => (v > 8.3 ? '아주 가파름' : v > 5.6 ? '가파른 편' : v >= 4 ? '약간 경사' : '완만')

function Detail({ r, wheelchair }: { r: SlopeRoute; wheelchair: boolean }) {
  const steepest = Math.max(r.maxUp, r.maxDown)
  return (
    <ul className="mt-1.5 space-y-1 text-caption text-fg-muted">
      <li>
        가장 가파른 곳 {pct(steepest)} {r.maxUp >= r.maxDown ? '오르막' : '내리막'} ({feel(steepest)})
        {r.climbM >= 1 && ` · 모두 ${Math.round(r.climbM)}m 올라가요`}
      </li>
      {(r.cautionM > 0 || r.steepM > 0) && (
        <li>
          {r.cautionM > 0 && `조금 가파른 길 ${m(r.cautionM)}`}
          {r.cautionM > 0 && r.steepM > 0 && ' · '}
          {r.steepM > 0 && <span className="font-semibold text-danger">아주 가파른 길 {m(r.steepM)}</span>}
        </li>
      )}
      {wheelchair && r.longestRun && (
        <li className="text-warn">
          {pct(r.longestRun.pct)} {r.longestRun.up ? '오르막' : '내리막'}이 {Math.round(r.longestRun.m)}m 계속돼요{r.rests > 0 && ` (중간에 ${r.rests}번 쉬어 가는 시간 포함)`}
        </li>
      )}
      {(r.noSidewalkM > 0 || r.unpavedM > 0 || r.raisedCrossings > 0 || r.unknownM > 0 || r.junctionCrossings > 0) && (
        <li>
          {[
            r.noSidewalkM > 0 && `인도 없는 큰길 ${m(r.noSidewalkM)}`,
            r.unpavedM > 0 && `포장 안 된 길 ${m(r.unpavedM)}`,
            r.raisedCrossings > 0 && `턱이 있는 횡단보도 ${r.raisedCrossings}곳`,
            r.junctionCrossings > 0 && `횡단보도가 있는지 모르는 큰길 건너기 ${r.junctionCrossings}곳`,
            r.unknownM > 0 && `경사를 모르는 곳(다리 등) ${m(r.unknownM)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </li>
      )}
    </ul>
  )
}

/** 막는 구간 한 줄: "아주 가파른 길(21.3%, 추정) 64m", "계단 12m" … (뒤에 '구간이'를 붙여 읽는다) */
function blockerLabel(b: Blocker): string {
  const len = m(b.lengthM)
  const est = b.estimated ? ', 추정' : ''
  switch (b.reason) {
    case 'steep':
      return b.pct != null ? `아주 가파른 길(${pct(b.pct)}${est}) ${len}` : `아주 가파른 길(현장 확인) ${len}`
    case 'stairs':
      return `계단 ${len}`
    case 'kerb':
      return `턱이 있는 곳 ${len}`
    case 'narrow':
      return `폭이 좁은 인도(1.2m 미만) ${len}`
    case 'unpaved':
      return `포장 안 된 길${b.estimated ? '(추정)' : ''} ${len}`
    case 'surveyed_difficult':
      return `현장 확인 결과 지나기 어려운 길 ${len}`
    default:
      return `휠체어로 지날 수 없는 길 ${len}`
  }
}

/** 막는 구간: 로드뷰로 보기 + 이 구간 확인 요청 (시민 제보 칸을 채운다) */
function BlockerActions({ b, onRequestCheck }: { b: Blocker; onRequestCheck?: (at: LonLat, text: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="sm" variant="hairline" onClick={() => openRoadview(b.at, blockerLabel(b))}>
        로드뷰로 보기
      </Button>
      {onRequestCheck && (
        <Button size="sm" variant="ghost" onClick={() => onRequestCheck(b.at, `${b.reason === 'steep' ? '경사' : '통행'} 확인 요청: 구간 ${b.parentId}, ${blockerLabel(b)} (길 안내에서 막힘)`)}>
          이 구간 확인 요청
        </Button>
      )}
    </div>
  )
}

function RouteSummary({ route, onRequestCheck }: { route: RouteState; onRequestCheck?: (at: LonLat, text: string) => void }) {
  const { general: g, wheelchair: w, alternative: alt, blocked, options, detour } = route.pair
  const far = detour.excessive && w && g
  const b = detour.blocker
  return (
    <div data-route-summary className="scroll-mt-3 space-y-2 text-ui" role="status" aria-live="polite">
      <div className="truncate pt-2 text-body font-semibold text-fg">
        {route.from.name} <span className="font-normal text-fg-muted">→</span> {route.to.name}
      </div>
      {blocked && (
        <div role="alert" className="rounded-nav bg-danger/10 p-4 text-fg">
          <div className="text-ui font-semibold text-danger">⚠ 휠체어로 안전하게 갈 수 있는 길을 찾지 못했어요</div>
          <p className="mt-1 text-caption leading-relaxed">
            {blocked.unavoidablePct != null && blocked.unavoidablePct > strictCap(options) ? (
              <>
                어느 길로 가도 <b>{pct(blocked.unavoidablePct)} 경사(추정)</b>를 지나야 해요. 휠체어 길은 경사 {pct(options.limitPct)} 이하만 안내해요.
              </>
            ) : (
              <>계단, 산길, 턱 있는 횡단보도, 좁은 인도, 포장 안 된 길을 피하면 이어지는 길이 없어요.</>
            )}
            {b && <> 가장 짧은 길에서 걸리는 곳: <b>{blockerLabel(b)}</b> 구간.</>}
          </p>
          <p className="mt-2 text-caption font-semibold leading-relaxed">저상버스나 장애인콜택시를 이용해 주세요. 아래 가장 짧은 길은 걸어서 가는 길이라 참고만 해 주세요.</p>
          <p className="mt-1 text-caption leading-relaxed">지도: <b style={{ color: ROUTE_STYLE.wheelchair.color }}>파란 선</b>은 휠체어 경로, <b style={{ color: ROUTE_STYLE.general.color }}>청록 선</b>은 가장 짧은 길, <b style={{ color: ROUTE_HIGHLIGHT.steep.color }}>주황 부분</b>은 경사가 있는 곳(굵을수록 가파름)이에요.</p>
          {b && <BlockerActions b={b} onRequestCheck={onRequestCheck} />}
        </div>
      )}
      {far && (
        <div role="alert">
          <Notice tone="warn">
            <b>⚠ 휠체어로 안전한 길은 많이 돌아가요</b>
            <br />
            가장 짧은 길({m(g.length)})보다 {Math.round(detour.ratio ?? 0)}배 먼 {m(w.length)}, {min(w.timeSec)} 걸려요.
            {b && <> 짧은 길 중간에 <b>{blockerLabel(b)}</b> 구간이 있어서 휠체어 길로 안내하지 않았어요.</>} 저상버스나 장애인콜택시도 생각해 보세요.
            <span className="mt-1 block text-caption">지도: <b style={{ color: ROUTE_STYLE.wheelchair.color }}>파란 선</b>은 휠체어 경로, <b style={{ color: ROUTE_STYLE.general.color }}>청록 선</b>은 가장 짧은 길, <b style={{ color: ROUTE_HIGHLIGHT.steep.color }}>주황 부분</b>은 경사가 있는 곳(굵을수록 가파름)이에요.</span>
          </Notice>
          {b && <BlockerActions b={b} onRequestCheck={onRequestCheck} />}
        </div>
      )}
      {w && (
        <RouteCard swatch={<RouteSwatch color={ROUTE_STYLE.wheelchair.color} />} title={far ? '휠체어 안전 경로 (돌아가는 길)' : '휠체어·유모차 추천 경로'} emphasis={!far}>
          <div className="font-heading text-heading-sm font-bold text-fg-strong">
            {m(w.length)} <span className="font-sans text-body font-medium text-fg">· {min(w.timeSec)}</span>
          </div>
          <div className="text-caption text-fg-muted">휠체어로 갈 때 걸리는 시간</div>
          <Detail r={w} wheelchair />
        </RouteCard>
      )}
      {alt && w && (
        <RouteCard swatch={<RouteSwatch color={ROUTE_STYLE.alternative.color} />} title={`더 완만한 길 (${m(alt.length - w.length)} 더 멀어요)`}>
          <div className="text-body font-medium text-fg tabular-nums">
            {m(alt.length)} · {min(alt.timeSec)}
          </div>
          <Detail r={alt} wheelchair />
        </RouteCard>
      )}
      <RouteCard swatch={<RouteSwatch color={ROUTE_STYLE.general.color} />} title={`가장 짧은 길 (걸어서${blocked ? ', 휠체어로는 어려워요' : ''})`}>
        {g ? (
          <>
            <div className="text-body font-medium text-fg tabular-nums">
              {m(g.length)} · 걸어서 {min(g.timeSec)}
            </div>
            <Detail r={g} wheelchair={false} />
          </>
        ) : (
          <div className="text-caption text-fg-muted">길을 찾지 못했어요</div>
        )}
      </RouteCard>
      <Hint>휠체어 경로는 경사 8.3% 이하, 인도 폭 1.2m 이상, 턱 2cm 이하인 길만 안내해요 (장애인등편의법 기준).</Hint>
      <Hint>경사는 지도 자료로 계산한 추정값이라 실제와 다를 수 있어요. 걸리는 시간도 대략이에요.</Hint>
    </div>
  )
}

/** 경로 하나. 주인공은 추천 경로 하나: 떠 있는 카드(그림자, 다크는 옅은 테두리). 나머지는 테두리·바탕 없는 조용한 줄.
 *  색은 지도 위 경로 선과 짝인 견본에만 */
function RouteCard({ swatch, title, emphasis = false, children }: { swatch: ReactNode; title: string; emphasis?: boolean; children: ReactNode }) {
  return (
    <div className={emphasis ? 'rounded-nav border border-transparent bg-surface p-4 shadow-card dark:border-line/10 dark:bg-tint/5' : 'px-4 py-2'}>
      <div className="mb-1.5 flex items-center gap-2 text-caption font-semibold text-fg-muted">
        <span className="flex w-5 shrink-0 justify-center">{swatch}</span>
        {title}
      </div>
      {children}
    </div>
  )
}
