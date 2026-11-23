// 경사 지도 (#slope 청소년센터 주변, 기본 동해시 전체): 구간 경사(추정 + 현장 조사)와 길 안내, 시민 제보, 조사원 구간 조사.
// 조사를 마친 구간은 조사 등급·실측 경사로, 나머지는 추정값으로 그리고 안내한다. 추정 구간은 '통행 가능'이라고 말하지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { SearchPanel, type RouteState } from '@/components/SearchPanel'
import { KakaoSlopeMap } from '@/components/KakaoSlopeMap'
import { ReportPanel, type ReportPoint, type ReportPreset } from '@/components/ReportPanel'
import { SlopeMap } from '@/components/SlopeMap'
import { DataPanel } from '@/components/DataPanel'
import {
  applySurvey,
  BASIS_LABEL,
  classify,
  midpoint,
  SLOPE_SHORT,
  SOURCE_LABEL,
  type SlopeArea,
  type SlopeClass,
  type SlopeMode,
  type SlopeSegment,
  type SurveyInfo,
} from '@/lib/slope'
import { fetchConfirmedObstacles, type ConfirmedObstacle } from '@/lib/reports'
import { loadGradingParams } from '@/lib/gradingParams'
import { attachAdminPaths, fetchAdminPaths, nodePositions, type AdminPath } from '@/lib/adminPaths'
import { attachObstacles, SlopeGraph, type Blocker } from '@/lib/slopeRoute'
import { fetchSurveyed, surveyable } from '@/lib/surveyApi'
import { buildWalkSegments, walkCoords, type WalkNet, type WalkSegment } from '@/lib/walk'
import { CHECK_LABEL, GRADE_LABEL } from '@/lib/types'
import { Download, Flag, Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip, Notice } from '@/components/ui/notice'
import { Hint, PanelSection } from '@/components/ui/panel'
import { TeamMark } from '@/components/TeamMark'
import { RoadviewHost } from '@/components/RoadviewModal'
import { openRoadview } from '@/lib/roadview'
import { MapTypeSwitch } from '@/components/MapTypeSwitch'
import { routeSections, routeRaisedCrossings, slopeHighlights } from '@/lib/routeDisplay'

/** 휴대폰 아래 시트 높이 (접기 = 손잡이·팀 이름 줄만, 낮게 = 머리띠·탭 + 검색창까지 보이게) */
type Sheet = 'mini' | 'peek' | 'half' | 'full'
const SHEET_ORDER: Sheet[] = ['mini', 'peek', 'half', 'full']
const SHEET_H: Record<Sheet, string> = { mini: 'calc(4.5rem + env(safe-area-inset-bottom))', peek: '16.25rem', half: '52dvh', full: 'calc(100dvh - 6rem)' }
const SHEET_LABEL: Record<Sheet, string> = { mini: '접기', peek: '낮게', half: '절반', full: '높게' }
const nextSheet = (s: Sheet): Sheet => (s === 'mini' ? 'peek' : s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek')
/** 끌기를 놓았을 때 가까운 높이를 고르려고 px로 (SHEET_H와 같은 값) */
const sheetPx = (vh: number): Record<Sheet, number> => ({ mini: 72, peek: 260, half: vh * 0.52, full: vh - 96 })
/** 이보다 빠르게(px/ms) 쓸고 놓으면 가까운 높이가 아니라 쓴 방향의 다음 높이로 */
const SHEET_FLICK = 0.35
/** 낮은 시트(접기·낮게)는 탭·길 선택 때 절반으로 올린다 */
const raiseSheet = (s: Sheet): Sheet => (s === 'mini' || s === 'peek' ? 'half' : s)

/** 패널 탭 (카카오맵 왼쪽 패널처럼) */
type Tab = 'route' | 'report' | 'data'
const PANEL_LABEL: Record<Tab, string> = { route: '길찾기', report: '제보', data: '데이터' }

/** 패널 위 등급 글씨 색: 지도 선 색과 같은 계열을 모드마다 대비가 맞게 (index.css --slope-*) */
const SLOPE_TEXT = (c: SlopeClass) => `var(--slope-${c})`

/** 지도 말풍선용 짧은 이유: 가장 짧은 길을 막는 곳 */
function blockerShort(b: Blocker): string {
  switch (b.reason) {
    case 'steep':
      return b.pct != null ? `급경사 ${b.pct.toFixed(1)}%${b.estimated ? '(추정)' : ''}` : '급경사'
    case 'stairs':
      return '계단'
    case 'kerb':
      return '턱'
    case 'narrow':
      return '좁은 인도'
    case 'unpaved':
      return '포장 안 된 길'
    case 'surveyed_difficult':
      return '통행 어려움'
    default:
      return '휠체어 통행 불가'
  }
}

export default function SlopeApp({ area }: { area: SlopeArea }) {
  const mode: SlopeMode = 'final'
  const [selected, setSelected] = useState<number | null>(null)
  const [kakaoError, setKakaoError] = useState<string | null>(null)
  const [route, setRoute] = useState<RouteState | null>(null)
  const [tracking, setTracking] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [reportPoint, setReportPoint] = useState<ReportPoint | null>(null)
  // 길 안내의 '이 구간 확인 요청'이 채우는 제보 값. key가 바뀌면 제보 칸을 새로 그려 그 값으로 연다
  const [reportPreset, setReportPreset] = useState<(ReportPreset & { key: number }) | null>(null)
  const [picking, setPicking] = useState(false)
  const [obstacles, setObstacles] = useState<ConfirmedObstacle[]>([])
  const [surveyed, setSurveyed] = useState<Map<number, SurveyInfo>>(() => new Map())
  const [adminPaths, setAdminPaths] = useState<AdminPath[]>([])
  /** 공개 지도는 경로(구간) 선을 항상 숨긴다. 검색한 안내 경로는 별도로 표시한다. */
  const linesHidden = true
  const [mapType, setMapType] = useState<'roadmap' | 'hybrid'>('roadmap')
  // 조사 결과·확인된 장애물·관리자 추가 길 다시 읽기 (지도 수정은 관리자 화면 #admin에서만 한다)
  const reload = useCallback(() => {
    void fetchConfirmedObstacles().then(setObstacles)
    void fetchSurveyed().then(setSurveyed)
    void fetchAdminPaths().then(setAdminPaths)
  }, [])
  useEffect(() => {
    reload()
    // 경로 기준값(DB grading_params): 못 읽으면 앱 기본값
    void loadGradingParams()
  }, [reload])
  // 추정 구간 위에 현장 조사 결과를 덮어쓴 구간 (길 안내·통계·상세에 쓴다. 카카오 지도는 area를 그대로 두고 survey만 받는다)
  const baseSegments = useMemo(() => applySurvey(area.segments, surveyed), [area, surveyed])
  // 관리자 추가 길 (우리 데이터에 없던 흰색 길을 관리자가 그려 넣은 것): 끝을 기존 길(노드 또는 길 중간)에 이어 지도·길 안내에 더한다
  const adminCL = useMemo(() => attachAdminPaths({ segs: baseSegments, pos: nodePositions(baseSegments) }, adminPaths), [adminPaths, baseSegments])
  // 지도·상세·통계용 구간: 원래 구간(나누지 않음) + 관리자 길 통째
  const segments = useMemo(() => (adminCL.admin.length ? [...baseSegments, ...adminCL.admin] : baseSegments), [baseSegments, adminCL])
  const kakaoArea = useMemo(() => (adminCL.admin.length ? { ...area, segments: [...area.segments, ...adminCL.admin] } : area), [area, adminCL])
  // 인도 기준 보행망 (동해 전체에서만, 받는 동안은 차도 중심선으로 계산)
  const [walk, setWalk] = useState<WalkNet | null>(null)
  useEffect(() => {
    if (!area.all) return
    let cancelled = false
    fetch(`${import.meta.env.BASE_URL}data/donghae_walk.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => !cancelled && w && setWalk(w as WalkNet))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [area])
  // 보행망이 도착하면 그 전에 차도 중심선으로 계산한 경로는 지운다 (구간 번호 체계가 다르다)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (walk) setRoute(null)
  }, [walk])
  const segById = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments])
  // 확인된 장애물(계단·단차 등)을 가까운 구간에 붙여 길 안내 비용에 넣는다 (보행망이면 원래 구간을 따라)
  const graph = useMemo(() => {
    const obsByParent = attachObstacles(segments, obstacles)
    // 관리자 길이 중간에 닿아 나뉜 조각은 원래 구간의 장애물을 물려받는다
    const obsOf = (id: number, pieceOf: Map<number, number>) => obsByParent.get(pieceOf.get(id) ?? id)
    if (!walk) {
      const obs = new Map<number, ConfirmedObstacle['type'][]>()
      for (const s of adminCL.segs) {
        const o = obsOf(s.id, adminCL.pieceOf)
        if (o) obs.set(s.id, o)
      }
      return new SlopeGraph(adminCL.segs, obs, adminCL.pos)
    }
    const built = buildWalkSegments(baseSegments, walk)
    // 관리자 길은 보행망에 다시 잇는다 (인도 선 끝·꼭짓점 또는 인도 선 중간을 나눠서). 건너기 구간은 나누지 않는다
    const wa = attachAdminPaths(
      {
        segs: built.segs,
        pos: built.pos,
        coords: (s) => ('walk' in s ? walkCoords(s as WalkSegment, segById, walk.d) : s.c),
        canSplit: (s) => !s.mtn && !(s.kind ?? '').startsWith('walk_'),
      },
      adminPaths,
    )
    const obs = new Map<number, ConfirmedObstacle['type'][]>()
    for (const s of wa.segs) {
      const o = 'walk' in s ? obsByParent.get((s as WalkSegment).walk.parent) : obsOf(s.id, wa.pieceOf)
      if (o) obs.set(s.id, o)
    }
    return new SlopeGraph(wa.segs, obs, wa.pos)
  }, [segments, baseSegments, adminCL, adminPaths, obstacles, walk, segById])
  const routeOverlay = useMemo(() => {
    if (!route) return null
    const coords = (s: SlopeSegment) => 'walk' in s ? walkCoords(s as WalkSegment, segById, walk?.d ?? {}) : s.c
    const lines = (ids: number[] | undefined) => routeSections(ids, graph.seg, coords)
    const w = route.pair.wheelchair
    return {
      general: lines(route.pair.general?.segIds),
      wheelchair: lines(w?.segIds),
      alternative: lines(route.pair.alternative?.segIds),
      // 경사가 있는 곳만 강조: 세 경로 위 5.6% 이상(주황)·8.3% 초과 또는 경로 계산이 상한 초과로 센 구간(빨강)
      highlights: (() => {
        const steep = new Set([...(route.pair.general?.steepIds ?? []), ...(w?.steepIds ?? [])])
        return [route.pair.general, route.pair.alternative, w].flatMap((r) => slopeHighlights(r?.segIds, graph.seg, coords, steep))
      })(),
      blocker: route.pair.detour.blocker ? { at: route.pair.detour.blocker.at, label: blockerShort(route.pair.detour.blocker) } : null,
      raisedCrossings: routeRaisedCrossings([...(route.pair.general?.segIds ?? []), ...(w?.segIds ?? []), ...(route.pair.alternative?.segIds ?? [])], graph.seg, coords, area.crossings),
      from: route.from,
      to: route.to,
    }
  }, [route, graph, segById, walk, area.crossings])

  const areaView = useMemo(() => ({ ...area, segments }), [area, segments])
  const seg = selected != null ? segById.get(selected) : undefined

  // 휴대폰 아래 시트: 낮게(검색창) · 절반(경로·상세) · 높게(전체). 넓은 화면에서는 쓰지 않는다(md:h-auto)
  const [sheet, setSheet] = useState<Sheet>('peek')
  const [tab, setTab] = useState<Tab>('route')
  const [searchContainer, setSearchContainer] = useState<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 탭을 누르면: 내용을 맨 위부터, 휴대폰은 시트를 적어도 절반으로
  const openTab = (t: Tab) => {
    setTab(t)
    setSheet(raiseSheet)
    bodyRef.current?.scrollTo({ top: 0 })
  }
  const showSearch = useCallback(() => {
    setTab('route')
    setSheet(raiseSheet)
    bodyRef.current?.scrollTo({ top: 0 })
  }, [])
  // 검색창을 누르거나 검색할 때 (휴대폰): 시트를 거의 전체 높이로 올린다. 절반 높이면 키보드가 검색창을 가려
  // 브라우저가 화면을 통째로 밀어 올리고, 검색 결과 목록은 키보드 밑에 숨는다. 전체 높이면 검색창이 화면 위쪽, 결과가 그 아래(키보드 위)에 온다
  const focusSearch = useCallback(() => {
    setTab('route')
    setSheet((s) => (window.matchMedia('(max-width: 767px)').matches ? 'full' : raiseSheet(s)))
    bodyRef.current?.scrollTo({ top: 0 })
  }, [])
  const reportRef = useRef<HTMLDivElement>(null)
  const requestCheck = useCallback((at: [number, number], text: string) => {
    setReportPoint({ at, source: 'manual', accuracyM: null })
    setReportPreset({ type: 'other', text: text.slice(0, 500), key: Date.now() })
    setTab('report')
    // 휴대폰: 아래쪽 패널을 높게 펴서 제보 칸이 보이게
    setSheet('full')
    setTimeout(() => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }, [])
  const [dragH, setDragH] = useState<number | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  // 길을 누르면: 시트를 적어도 절반으로 올린다 (상세는 아래 효과에서 시트 안 맨 위로 보낸다)
  const selectSegment = (id: number | null) => {
    setSelected(id)
    if (id != null) {
      setTab('route')
      setSheet(raiseSheet)
    }
  }
  useEffect(() => {
    if (selected == null) return
    const t = requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    return () => cancelAnimationFrame(t)
  }, [selected])
  // 경로가 나오면 (휴대폰): 결과 카드가 시트 맨 위에 오게 스크롤한다. 결과는 출발·도착 입력 아래라 절반 높이 시트에서는 화면 밖에 있다.
  // 시트가 절반으로 커지는 애니메이션(200ms) 뒤에 옮긴다
  useEffect(() => {
    if (!route || !window.matchMedia('(max-width: 767px)').matches) return
    const t = setTimeout(() => bodyRef.current?.querySelector('[data-route-summary]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 260)
    return () => clearTimeout(t)
  }, [route])
  // 시트 끌기 (휴대폰): 손잡이뿐 아니라 머리띠(팀 이름·탭 줄) 어디를 잡아도 끈다.
  // 손을 떼면 가까운 높이로, 빠르게 쓸었으면 쓴 방향의 다음 높이로. 끌었으면 그 뒤 탭 누름은 무시한다.
  // 거의 안 움직였으면: 손잡이는 다음 높이로, 그 밖(탭 등)은 원래 누름 그대로
  const dragged = useRef(false)
  const onSheetDown = (e: ReactPointerEvent<HTMLElement>) => {
    const el = asideRef.current
    if (!el || window.matchMedia('(min-width: 768px)').matches) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const onHandle = !!(e.target as HTMLElement).closest('[data-sheet-handle]')
    const startY = e.clientY
    const startH = el.getBoundingClientRect().height
    const px = sheetPx(window.innerHeight)
    const samples: [number, number][] = [[e.clientY, e.timeStamp]]
    let moved = false
    dragged.current = false
    const move = (ev: PointerEvent) => {
      const dy = startY - ev.clientY
      if (Math.abs(dy) > 6) moved = dragged.current = true
      samples.push([ev.clientY, ev.timeStamp])
      while (samples.length > 2 && ev.timeStamp - samples[0][1] > 120) samples.shift()
      if (moved) setDragH(Math.max(px.mini, Math.min(px.full, startH + dy)))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDragH(null)
      if (!moved) {
        if (onHandle && ev.type === 'pointerup') setSheet(nextSheet)
        return
      }
      const h = startH + (startY - ev.clientY)
      const [y0, t0] = samples[0]
      const v = (y0 - ev.clientY) / Math.max(1, ev.timeStamp - t0) // + 위로
      let target: Sheet
      if (v > SHEET_FLICK) target = SHEET_ORDER.find((k) => px[k] > h + 8) ?? 'full'
      else if (v < -SHEET_FLICK) target = [...SHEET_ORDER].reverse().find((k) => px[k] < h - 8) ?? 'mini'
      else target = SHEET_ORDER.reduce((a, b) => (Math.abs(px[b] - h) < Math.abs(px[a] - h) ? b : a))
      setSheet(target)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    // 배치 (카카오맵식 A안): 지도를 화면 가득 깔고, 넓은 화면은 왼쪽에 떠 있는 패널(먹색 머리띠 + 탭), 휴대폰은 지도 아래 시트.
    // 카카오 로고는 오른쪽 아래로 옮겨 패널에 가리지 않는다.
    <div className="relative flex h-full flex-col bg-canvas text-fg md:block">
      {/* 지도: 휴대폰에서는 아래 시트 높이만큼 줄어든다 (시트가 지도를 덮지 않음) */}
      <div className="relative min-h-0 flex-1 md:absolute md:inset-0">
        {/* 대체 지도 안내: 지도 왼쪽 위 (넓은 화면은 패널 오른쪽) */}
        {kakaoError != null && area.image.w !== 0 && (
          <p role="status" className="float-surface absolute top-3 right-3 left-3 z-10 rounded-nav px-3 py-2 text-caption text-fg md:top-4 md:right-auto md:left-[424px]">
            카카오 지도를 불러오지 못해 수치지도 배경으로 보여 줍니다. ({kakaoError})
          </p>
        )}
        {kakaoError == null ? (
          <KakaoSlopeMap
            area={kakaoArea}
            mode={mode}
            highlight={null}
            routes={routeOverlay}
            selectedId={selected}
            onSelect={selectSegment}
            onFail={setKakaoError}
            picking={picking}
            onPick={(p) => {
              setReportPoint({ at: p, source: 'manual', accuracyM: null })
              setPicking(false)
            }}
            reportPoint={reportPoint?.at ?? null}
            obstacles={obstacles}
            tracking={tracking}
            onTracking={(on) => {
              setTracking(on)
              if (!on) setNavigating(false)
            }}
            follow={navigating}
            survey={surveyed}
            linesHidden={linesHidden}
            mapType={mapType}
            controls={<MapTypeSwitch value={mapType} onChange={setMapType} />}
          />
        ) : area.image.w === 0 ? (
          <div role="alert" className="flex h-full items-center justify-center bg-surface p-6 text-center text-ui text-fg-muted">
            동해시 전체 지도는 카카오 지도로만 보여 줍니다. 카카오 지도를 불러오지 못했어요. ({kakaoError})
          </div>
        ) : (
          <SlopeMap linesHidden={linesHidden} area={areaView} mode={mode} highlight={null} routes={routeOverlay} selectedId={selected} onSelect={selectSegment} />
        )}
      </div>

      {/* 패널: 휴대폰은 끌어서 높이를 바꾸는 아래 시트(낮게·절반·높게), 넓은 화면은 지도 왼쪽에 떠 있는 패널 */}
      <aside
        ref={asideRef}
        style={{ '--sheet-h': dragH != null ? `${dragH}px` : SHEET_H[sheet] } as CSSProperties}
        // 테두리는 맨 위에 덮는 after 한 겹으로 그린다: 머리띠·본문 모두 같은 선이 둥근 모서리를 따라 이어진다 (border로 그리면 머리띠가 1px 안쪽으로 밀려 가장자리에 흰 줄이 생긴다)
        className={`relative z-20 flex h-[var(--sheet-h)] shrink-0 flex-col overflow-hidden rounded-t-card-lg bg-surface shadow-float after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-line/10 md:absolute md:top-4 md:bottom-4 md:left-4 md:h-auto md:w-[392px] md:rounded-card-lg dark:after:border-line/15 ${dragH == null ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none' : ''}`}
      >
        {/* 머리띠: 팀 이름 + 지도 이름, 그 아래 유리 질감 검색창 */}
        <div
          className="panel-band shrink-0 touch-none px-5 pb-4 text-[#1c1917] select-none md:touch-auto md:pt-5 md:select-auto"
          onPointerDown={onSheetDown}
          onClickCapture={(e) => {
            // 끌고 놓은 손가락 아래 탭·버튼이 눌리지 않게
            if (dragged.current) {
              e.stopPropagation()
              e.preventDefault()
              dragged.current = false
            }
          }}
        >
          {/* 손잡이: 끌어서 높이 조절, 누르면(또는 키보드 Enter) 낮게 → 절반 → 높게 차례로 */}
          <button
            type="button"
            data-sheet-handle
            onClick={(e) => {
              if (e.detail === 0) setSheet(nextSheet)
            }}
            aria-label={`패널 높이: ${SHEET_LABEL[sheet]} (누르면 ${SHEET_LABEL[nextSheet(sheet)]})`}
            className="-mx-5 flex h-7 w-[calc(100%+2.5rem)] cursor-grab items-center justify-center md:hidden"
          >
            <span className="h-1.5 w-12 rounded-full bg-black/25" aria-hidden />
          </button>
          <div className="flex items-center gap-2.5">
            <TeamMark />
            <h1 className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="team-name team-name-on-band shrink-0 text-[22px]" title="팀 경사났네">
                경사났네
              </span>
              <span className="truncate font-sans text-caption font-medium text-[#57534e]">{area.name} 경사 지도</span>
            </h1>
          </div>
          <div ref={setSearchContainer} className="mt-4" />
        </div>

        <div ref={bodyRef} role="region" aria-label={PANEL_LABEL[tab]} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div hidden={tab !== 'route'}>
            <>
              <SearchPanel
                searchContainer={searchContainer}
                onSearch={focusSearch}
                area={areaView}
                graph={graph}
                route={route}
                onRoute={(r) => {
                  setRoute(r)
                  if (r) setSheet('half')
                }}
                onNavigate={(on) => {
                  setNavigating(on)
                  if (on) {
                    setTracking(true)
                    setSheet('peek')
                  }
                }}
                onRequestCheck={requestCheck}
              />
              {seg ? (
                // 일반 지도는 보기 전용: 현장 조사·경사 입력은 관리자 화면(#admin)에서만
                <div ref={detailRef} className="scroll-mt-2">
                  <Detail seg={seg} mode={mode} onClose={() => setSelected(null)} onSurvey={null} />
                </div>
              ) : (
                <PanelSection dense>
                  {/* 경사 색 선을 숨긴 뒤로는 길을 눌러 볼 수 없으므로, 대신 경로 정확도의 한계를 알린다 */}
                  <div className="flex items-center gap-3 rounded-nav bg-tint/4 px-4 py-3.5 text-ui text-fg-muted">
                    <Info className="size-5 shrink-0" strokeWidth={1.5} aria-hidden />
                    경사는 지도 자료로 계산한 추정값이라, 추천 경로가 실제와 다를 수 있어요.
                  </div>
                </PanelSection>
              )}
              <PanelSection dense>
                <div className="grid grid-cols-2 gap-2 pb-5">
                  <Button variant="hairline" className="border-azure/50! text-azure-fg!" onClick={() => openTab('report')}><Flag className="size-4" strokeWidth={1.75} aria-hidden />제보</Button>
                  <Button variant="hairline" className="border-azure/50! text-azure-fg!" onClick={() => openTab('data')}><Download className="size-4" strokeWidth={1.75} aria-hidden />데이터</Button>
                </div>
              </PanelSection>
            </>
          </div>

          <div ref={reportRef} hidden={tab !== 'report'}>
              <ReportPanel
                key={reportPreset?.key ?? 0}
                preset={reportPreset}
                point={reportPoint}
                onPoint={setReportPoint}
                picking={picking}
                onPicking={setPicking}
                canPick={kakaoError == null}
                onClose={() => setTab('route')}
              />
          </div>

          <div hidden={tab !== 'data'}>
            <>
              <div className="flex justify-end px-5 pt-3"><Button variant="quiet" size="icon" onClick={showSearch} aria-label="데이터 닫기"><X className="size-5" aria-hidden /></Button></div>
              <DataPanel segments={segments} />
              <PanelSection>
                <div className="space-y-2 pb-4 text-caption leading-relaxed text-fg-muted">
                  <p>
                    <b className="font-medium text-fg">길 위 표고</b>: 등고선이 길(도로 면·인도 면)을 가로지르는 점과 길 위 표고점만으로 높이를 이어 계산합니다. 옹벽 위 주차장 같은 길 밖 높이는 쓰지 않습니다.
                  </p>
                  <p>관측 사이(약 20m)보다 짧은 급경사와 턱은 잡지 못합니다. 현장 조사를 마친 구간은 조사 등급과 실측 경사로, 나머지는 추정값으로 길을 안내합니다.</p>
                  <p>
                    출처: 국토지리정보원 수치지도 1:5,000(2025), 행정안전부 전국횡단보도표준데이터, 보완 길 © OpenStreetMap contributors (ODbL). 지도: 카카오. 위치 정보는 이 기기 안에서만 쓰고 서버로 보내지 않습니다.
                  </p>
                </div>
              </PanelSection>
            </>
          </div>
        </div>
      </aside>
      <RoadviewHost />
    </div>
  )
}


function Detail({ seg, mode, onClose, onSurvey }: { seg: SlopeSegment; mode: SlopeMode; onClose: () => void; onSurvey: (() => void) | null }) {
  const c = classify(seg, mode)
  const value = mode === 'final' ? seg.max : seg.raw
  const other = mode === 'final' ? seg.raw : seg.max
  const tone = SLOPE_TEXT(c)
  return (
    <PanelSection aria-live="polite">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-subheading text-fg-strong">{seg.name ?? seg.cls ?? '이름 없는 길'}</h2>
          <Hint>
            구간 {seg.id} · {seg.len.toFixed(0)}m{seg.w ? ` · 도로 폭 ${seg.w}m` : ''}
          </Hint>
        </div>
        <Button size="icon" variant="quiet" className="-mt-1 -mr-2" onClick={onClose} aria-label="닫기">
          <X className="size-5" strokeWidth={1.75} aria-hidden />
        </Button>
      </div>

      {/* 큰 숫자: 제목 글씨체(Wanted Sans) 700, 40px. 테두리 없이 옅은 칸으로만 구분 */}
      <div className="flex items-end gap-4 rounded-nav bg-tint/4 p-4">
        <div className="font-heading text-stat font-bold" style={{ color: tone }}>
          {value != null && !seg.bridge && !seg.tunnel ? `${value.toFixed(1)}%` : '—'}
        </div>
        <div className="pb-0.5">
          <div className="text-ui font-semibold" style={{ color: tone }}>
            {SLOPE_SHORT[c]}
          </div>
          <div className="text-caption text-fg-muted">최대 경사</div>
        </div>
      </div>

      {seg.survey && (
        <Notice tone="ok">
          <b className="font-semibold">현장 조사</b>
          {seg.survey.grade ? ` · ${GRADE_LABEL[seg.survey.grade]}` : ' · 측정만 (등급 미정)'}
          {seg.survey.incline != null && ` · 실측 경사 ${seg.survey.incline.toFixed(1)}%`}
          {seg.survey.at && <span className="block text-caption opacity-80">{new Date(seg.survey.at).toLocaleString('ko-KR')}</span>}
        </Notice>
      )}

      {onSurvey &&
        (surveyable(seg) ? (
          <Button variant="primary" className="w-full" onClick={onSurvey}>
            이 구간 조사하기
          </Button>
        ) : (
          <Notice>OSM 보완 길·연결 추정 구간은 DB에 없어 조사 기록을 남길 수 없어요.</Notice>
        ))}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ui text-fg">
        {mode === 'final' && (
          <>
            <dt className="text-fg-muted">근거</dt>
            <dd>
              {seg.src ? SOURCE_LABEL[seg.src] : '—'}
              {seg.src === 'road_obs' && seg.basis ? ` · ${BASIS_LABEL[seg.basis]}` : ''}
            </dd>
            {seg.gap != null && (
              <>
                <dt className="text-fg-muted">가까운 관측</dt>
                <dd>{seg.gap.toFixed(0)}m 안</dd>
              </>
            )}
          </>
        )}
        {seg.avg != null && mode === 'final' && (
          <>
            <dt className="text-fg-muted">평균 경사</dt>
            <dd>{Math.abs(seg.avg).toFixed(1)}%</dd>
          </>
        )}
        <dt className="text-fg-muted">{mode === 'final' ? 'DEM 그대로' : '길 위 표고'}</dt>
        <dd>
          {other != null ? `${other.toFixed(1)}%` : '—'}
          {other != null && value != null && <span className="text-fg-muted"> ({value - other >= 0 ? '+' : ''}{(value - other).toFixed(1)}%p 차이)</span>}
        </dd>
        {seg.up != null && seg.down != null && !seg.bridge && !seg.tunnel && (
          <>
            <dt className="text-fg-muted">방향별 오르막</dt>
            <dd>
              한쪽 {seg.up.toFixed(1)}% · 반대쪽 {seg.down.toFixed(1)}%
              <span className="mt-0.5 block text-caption text-fg-muted">휠체어 경로는 가는 방향의 오르막·내리막으로 비용을 매겨요</span>
            </dd>
          </>
        )}
        <dt className="text-fg-muted">인도</dt>
        <dd>{seg.sw ? `있음${seg.swW ? ` (폭 ${seg.swW}m)` : ''}` : '자료 없음'}</dd>
      </dl>

      {seg.mtn && <Notice>산길 추정 ({seg.mtn}): 길 안내에서 뺀 구간이에요.</Notice>}
      {seg.link && (
        <Notice tone="warn">
          도로 자료에 없는 연결 추정이에요 ({seg.link} 쪽 길이 끊겨 있어 직선으로 이었어요). 실제 길이 있는지 현장 확인이 필요해요.
        </Notice>
      )}
      {seg.keep && <Notice tone="ok">{seg.keep} 가는 길이라 산길 판정에서 빼고 남겼어요.</Notice>}
      {seg.check.length > 0 && (
        <div>
          <h3 className="mb-2 text-caption font-medium text-fg-muted">현장에서 확인할 것</h3>
          <ul className="flex flex-wrap gap-1.5">
            {seg.check.map((k) => (
              <li key={k}>
                <Chip tone="warn">{CHECK_LABEL[k] ?? k}</Chip>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button variant="ghost" className="w-full" onClick={() => openRoadview(midpoint(seg.c), seg.name ?? undefined)}>
        로드뷰로 보기
      </Button>
      {!seg.survey?.grade && <Hint>추정값입니다. 현장 조사 전까지 이 길을 ‘통행 가능’이라고 하지 않습니다.</Hint>}
    </PanelSection>
  )
}
