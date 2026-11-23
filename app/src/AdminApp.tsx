// 관리자·조사원 화면 (#admin): 시민 제보 확인(맞음·없음·숨김), 장애물 관리(해소·숨김), 직접 추가(단차·계단·경사·기타), 기록·계정
// 권한은 DB 함수·RLS가 확인한다 (화면은 안내만). 처리하면 다음 조회부터 지도·길 안내에 반영된다.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'
import { AdminMap, ROAD_MAX_LEVEL, type Pick, type RoadOverlay } from '@/components/AdminMap'
import {
  adminLogin,
  adminLogout,
  addAdminPath,
  clearSegmentIncline,
  hideAdminPath,
  hideObstacle,
  listEvents,
  listMeasurements,
  listMembers,
  listObstacles,
  listReports,
  loadAdminSession,
  OBSTACLE_LABEL,
  registerObstacle,
  resolveObstacle,
  resolveReport,
  segmentInclineHistory,
  setRole,
  setSegmentIncline,
  updateAdminPath,
  type AdminSession,
  type Measurement,
  type Obstacle,
  type ObstacleType,
  type Report,
  type StatusEvent,
} from '@/lib/adminApi'
import { ADMIN_LINE_SNAP_M, ADMIN_SEG0, attachAdminPaths, fetchAdminPaths, nodePositions, pathLength, type AdminPath } from '@/lib/adminPaths'
import { applySurvey, classify, SLOPE_LABEL, type SlopeArea, type SlopeSegment, type SurveyInfo } from '@/lib/slope'
import { bearing, orthoLock, rayHitRoad, snapToRoads } from '@/lib/drawSnap'
import { degToPct, MAX_DEG, nearestSegment, recordable } from '@/lib/slopeInput'
import { fetchSurveyed } from '@/lib/surveyApi'
import type { LonLat } from '@/lib/types'
import { Button, buttonClass, choiceClass } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/field'
import { Chip, Notice } from '@/components/ui/notice'
import { Hint, PanelSection } from '@/components/ui/panel'
import { TeamMark } from '@/components/TeamMark'
import type { MapType } from '@/components/MapTypeSwitch'
import { MapLegend } from '@/components/MapLegend'

const CENTER: LonLat = [129.1143, 37.5247] // 동해시청
type Tab = 'reports' | 'obstacles' | 'add' | 'road' | 'legend' | 'members'
const TYPES: ObstacleType[] = ['kerb', 'stairs', 'other', 'steep', 'narrow', 'damaged', 'cross_slope']
const ROLE_LABEL = { admin: '관리자', surveyor: '조사원' }
/** 새 길 그리기 도우미 */
type DrawOpts = { magnet: boolean; ortho: boolean }

export default function AdminApp() {
  const [session, setSession] = useState<AdminSession | null>(() => loadAdminSession())
  if (!session) return <Login onDone={setSession} />
  if (!session.role)
    return (
      <Center>
        <p className="text-ui text-fg-muted">
          <b className="font-medium text-fg">{session.email}</b> 계정에는 관리자·조사원 역할이 없어요. 관리자에게 역할을 요청하세요.
        </p>
        <Button variant="ghost" className="mt-4" onClick={() => (adminLogout(), setSession(null))}>
          다른 계정으로 로그인
        </Button>
      </Center>
    )
  return <Console session={session} onLogout={() => (adminLogout(), setSession(null))} />
}

/** 가운데 카드: 일반 지도 패널과 같은 모양 (흰→남색 머리띠에 팀 이름, 아래 흰 본문, 맨 위에 덮는 테두리 한 겹) */
function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-canvas p-4 text-fg">
      <div className="relative w-full max-w-sm overflow-hidden rounded-card-lg bg-surface shadow-float after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-line/10 dark:after:border-line/15">
        <div className="panel-band flex items-center gap-2.5 px-6 pt-5 pb-6 text-[#1c1917]">
          <TeamMark />
          <h1 className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="team-name team-name-on-band shrink-0 text-[22px]" title="팀 경사났네">
              경사났네
            </span>
            <span className="truncate font-sans text-caption font-medium text-[#57534e]">관리자 페이지</span>
          </h1>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

function Login({ onDone }: { onDone: (s: AdminSession) => void }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Center>
      <Hint className="mb-5">관리자·조사원 계정으로 로그인하세요. 계정은 관리자가 만들어요.</Hint>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr(null)
          try {
            onDone(await adminLogin(email.trim(), pw))
          } catch (x) {
            setErr((x as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Input type="text" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="아이디 또는 이메일" aria-label="아이디 또는 이메일" className="w-full" />
        <Input type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" aria-label="비밀번호" className="w-full" />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </Button>
        {err && (
          <Notice role="alert" tone="danger">
            {err}
          </Notice>
        )}
      </form>
      <a href="./" className={buttonClass('quiet', 'sm', 'mt-4 w-full')}>
        ← 지도로 돌아가기
      </a>
    </Center>
  )
}

function Console({ session, onLogout }: { session: AdminSession; onLogout: () => void }) {
  const isAdmin = session.role === 'admin'
  const [tab, setTab] = useState<Tab>('reports')
  const [mapType, setMapType] = useState<MapType>('roadmap')
  const [reports, setReports] = useState<Report[]>([])
  const [obstacles, setObstacles] = useState<Obstacle[]>([])
  const [selected, setSelected] = useState<Pick>(null)
  const [focus, setFocus] = useState<{ at: LonLat; key: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const [point, setPoint] = useState<LonLat | null>(null)
  // 지도에 그릴 우리 길 데이터: 공개 지도와 같은 길 + 조사 결과(실측 경사) + 관리자 추가 길
  const [baseSegs, setBaseSegs] = useState<SlopeSegment[] | null>(null)
  const [surveyed, setSurveyed] = useState<Map<number, SurveyInfo>>(() => new Map())
  const [paths, setPaths] = useState<AdminPath[]>([])
  /** 새 길 그리기 중이면 찍은 점들 (아니면 null) */
  const [draft, setDraft] = useState<LonLat[] | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** 고치려고 지도에서 누른 길 (구간 번호 + 누른 곳) */
  const [road, setRoad] = useState<{ id: number; at: LonLat } | null>(null)
  /** 저장할 때마다 올려 길 수정 탭의 기록을 다시 받게 한다 */
  const [saved, setSaved] = useState(0)

  const reload = useCallback(async () => {
    void fetchSurveyed().then(setSurveyed)
    void fetchAdminPaths().then(setPaths)
    try {
      const [r, o] = await Promise.all([listReports('pending'), listObstacles()])
      setReports(r)
      setObstacles(o)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [])
  useEffect(() => {
    let alive = true
    loadCitySegments().then(
      (s) => alive && setBaseSegs(s),
      (e: Error) => alive && setMsg({ ok: false, text: `지도 길 데이터: ${e.message}` }),
    )
    return () => {
      alive = false
    }
  }, [])
  const segments = useMemo(() => {
    if (!baseSegs) return null
    const withSurvey = applySurvey(baseSegs, surveyed)
    // 원래 구간(나누지 않음: 경사 기록은 DB 구간 번호로) + 관리자 길 통째 (끝은 이어진 자리로 맞춘 모양)
    return paths.length ? [...withSurvey, ...attachAdminPaths({ segs: withSurvey, pos: nodePositions(withSurvey) }, paths).admin] : withSurvey
  }, [baseSegs, surveyed, paths])
  // 새 길 그리기 도우미: 자석(기존 길에 붙이기)·직교(앞 구간과 직각) 켜기/끄기
  const [drawOpts, setDrawOpts] = useState<DrawOpts>({ magnet: true, ortho: false })
  // 그리는 길의 시작·끝이 기존 길에 이어지는가: 공개 지도가 잇는 기준(선 위 15m 안)과 같게
  const draftLinked = useMemo<[boolean, boolean] | null>(() => {
    if (!draft?.length || !segments) return null
    const linked = (p: LonLat) => snapToRoads(p, segments, ADMIN_LINE_SNAP_M).kind != null
    return [linked(draft[0]), draft.length > 1 && linked(draft[draft.length - 1])]
  }, [draft, segments])
  const roads = useMemo<RoadOverlay | null>(
    () =>
      segments
        ? { segs: segments, nearId: null, draft: tab === 'add' ? draft : null, draftLinked: tab === 'add' ? draftLinked : null, selId: tab === 'road' ? (road?.id ?? null) : null }
        : null,
    [segments, draft, draftLinked, tab, road],
  )
  /** 새 길에 점을 찍을 때: 직교로 방향을 맞추고, 자석으로 기존 길에 붙인다 (tolM: 지금 확대 수준의 손가락 하나 거리) */
  const drawPick = (p: LonLat, tolM: number): LonLat => {
    const segs = segments ?? []
    const last = draft?.[draft.length - 1]
    const prev = draft && draft.length > 1 ? draft[draft.length - 2] : undefined
    let q = p
    if (drawOpts.ortho && last) {
      // 기준 방향: 앞 구간, 첫 구간이면 시작점이 붙은 길
      const ref = prev ? bearing(prev, last) : snapToRoads(last, segs, 1).dir
      if (ref != null) q = orthoLock(p, last, ref)
    }
    if (drawOpts.magnet) {
      // 직교로 맞춘 선이 길에 닿으면 그 교차점에 (각도를 지키며 정확히 붙음)
      if (drawOpts.ortho && last) {
        const hit = rayHitRoad(last, q, segs, tolM)
        if (hit) return hit
      }
      const s = snapToRoads(q, segs, tolM)
      if (s.kind) return s.at
    }
    return q
  }
  useEffect(() => {
    // 처음 열 때 한 번 받는다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: ok })
      setSelected(null)
      await reload()
      setSaved((n) => n + 1)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  // 같은 곳 같은 종류 제보 묶음 크기
  const clusterSize = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of reports) m.set(r.cluster_id ?? r.id, (m.get(r.cluster_id ?? r.id) ?? 0) + 1)
    return m
  }, [reports])

  const sel = selected?.kind === 'report' ? reports.find((r) => r.id === selected.id) : selected?.kind === 'obstacle' ? obstacles.find((o) => o.id === selected.id) : undefined
  const choose = (p: Pick, at?: LonLat) => {
    setSelected(p)
    if (p) setTab(p.kind === 'report' ? 'reports' : 'obstacles')
    if (at) setFocus({ at, key: Date.now() })
  }

  return (
    // 배치: 일반 지도(SlopeApp)와 같다. 지도를 화면 가득 깔고, 넓은 화면은 왼쪽에 떠 있는 패널(흰→남색 머리띠 + 흰 알약 탭), 휴대폰은 지도 아래 패널
    <div className="relative flex h-full flex-col bg-canvas text-fg md:block">
      <div className="relative min-h-0 flex-1 md:absolute md:inset-0">
        <div className="relative h-full">
          <AdminMap
            center={CENTER}
            mapType={mapType}
            onMapTypeChange={setMapType}
            reports={reports}
            obstacles={obstacles}
            selected={selected}
            onSelect={(p) => choose(p)}
            picking={picking || (tab === 'add' && draft != null)}
            onPick={(p, tolM) => {
              // 새 길 그리기 중이면 누른 곳을 점으로 잇는다 (직교·자석 적용)
              if (tab === 'add' && draft != null) return setDraft([...draft, drawPick(p, tolM)])
              setPoint(p)
              setPicking(false)
            }}
            point={tab === 'add' && draft == null ? point : null}
            focus={focus}
            roads={roads}
            onTap={(p, tolM) => {
              // 길 고르기: 누른 곳에서 손가락 하나 거리(최소 10m) 안의 가장 가까운 길
              const hit = segments ? nearestSegment(segments, p, Math.max(10, tolM), true) : null
              if (hit) {
                setRoad({ id: hit.seg.id, at: p })
                setTab('road')
                setMsg(null)
              } else if (tab === 'road') setRoad(null)
            }}
          />
        </div>
      </div>
      {/* 패널: 일반 지도와 같은 떠 있는 패널. 테두리는 맨 위에 덮는 after 한 겹 (머리띠까지 같은 선) */}
      <aside className="relative z-20 flex h-[58dvh] shrink-0 flex-col overflow-hidden rounded-t-card-lg bg-surface shadow-float after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-line/10 md:absolute md:top-4 md:bottom-4 md:left-4 md:h-auto md:w-[392px] md:rounded-card-lg dark:after:border-line/15">
        {/* 머리띠 (위 흰색 → 아래 남색): 팀 이름 + 관리 + 테마, 계정 줄, 그 아래 탭 */}
        <div className="panel-band shrink-0 px-5 pt-4 pb-4 text-[#1c1917] md:pt-5">
          <div className="flex items-center gap-2.5">
            <TeamMark />
            <h1 className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="team-name team-name-on-band shrink-0 text-[22px]" title="팀 경사났네">
                경사났네
              </span>
              <span className="truncate font-sans text-caption font-medium text-[#57534e]">관리자 페이지</span>
            </h1>
            <button type="button" onClick={() => setTab('members')} aria-label={isAdmin ? '기록 및 계정' : '기록'} title={isAdmin ? '기록 및 계정' : '기록'} aria-pressed={tab === 'members'} className={`flex size-10 shrink-0 items-center justify-center rounded-full border bg-white text-[#2455ae] shadow-subtle transition-colors hover:bg-[#eaf0fa] ${tab === 'members' ? 'border-[#2455ae]' : 'border-line/10'}`}>
              <UserRound className="size-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <p className="mt-2 truncate text-caption text-[#44403c]" title={`${session.email} · ${ROLE_LABEL[session.role!]}`}>
            {session.email} · {ROLE_LABEL[session.role!]} · 대기 제보 {reports.length} · 장애물 {obstacles.length}
          </p>
          {/* 탭: 같은 너비 칸, 고른 것까지 모두 똑같은 흰 알약 (일반 지도와 같음) */}
          <div className="mt-3 grid grid-cols-5 gap-1.5" role="tablist" aria-label="관리">
            {([
              ['reports', `제보 ${reports.length}`],
              ['obstacles', `장애물 ${obstacles.length}`],
              ['add', '직접 추가'],
              ['road', '길 수정'],
              ['legend', '범례'],
            ] as [Tab, string][]).map(([t, label]) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                type="button"
                onClick={() => setTab(t)}
                className="flex h-9 min-w-0 items-center justify-center rounded-full bg-white px-1 text-caption font-semibold whitespace-nowrap text-[#1c1917] shadow-subtle transition-colors hover:bg-[#f5f5f4]"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {msg && (
            <div className="px-5 pt-4">
              <Notice role="status" tone={msg.ok ? 'ok' : 'danger'}>
                {msg.text}
              </Notice>
            </div>
          )}

          {tab === 'reports' && (
            <div className="space-y-2 p-5">
              {reports.length === 0 && <EmptyState>대기 중인 제보가 없어요.</EmptyState>}
              {reports.map((r) => (
                <ReportCard
                  key={r.id}
                  r={r}
                  cluster={clusterSize.get(r.cluster_id ?? r.id) ?? 1}
                  open={sel === r}
                  busy={busy}
                  onOpen={() => choose({ kind: 'report', id: r.id }, r.at)}
                  onConfirm={(type, val) =>
                    act(
                      () =>
                        registerObstacle({
                          type,
                          at: r.at,
                          kerbCm: type === 'kerb' ? val : null,
                          widthCm: null,
                          crossSlopePct: type === 'cross_slope' ? val : null,
                          reportId: r.id,
                        }),
                      '장애물로 등록했어요. 지도와 길 안내에 반영돼요.',
                    )
                  }
                  onReject={(result, note) => act(() => resolveReport(r.id, result, note), result === 'not_found' ? '없음으로 처리했어요.' : '숨겼어요.')}
                />
              ))}
            </div>
          )}

          {tab === 'obstacles' && (
            <div className="space-y-2 p-5">
              {obstacles.length === 0 && <EmptyState>등록된 장애물이 없어요.</EmptyState>}
              {obstacles.map((o) => (
                <div key={o.id} className={`rounded-nav border p-3 text-ui transition-colors ${sel === o ? 'border-ink bg-hl' : 'border-line/10 bg-tint/3 hover:bg-tint/5'}`}>
                  <button type="button" className="w-full text-left" onClick={() => choose({ kind: 'obstacle', id: o.id }, o.at)}>
                    <b className="font-medium text-fg-strong">{OBSTACLE_LABEL[o.type]}</b>{' '}
                    <span className="mt-0.5 block text-caption text-fg-muted">
                      #{o.id} · {o.status} · 구간 {o.segment_id ?? '없음'} · {new Date(o.created_at).toLocaleString('ko-KR')}
                    </span>
                    {o.tags?.note && <span className="mt-1.5 block text-fg">“{o.tags.note}”</span>}
                  </button>
                  {sel === o && (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="ghost" className="flex-1" disabled={busy} onClick={() => act(() => resolveObstacle(o.id, null), '해소로 처리했어요 (없어짐).')}>
                        해소 (없어짐)
                      </Button>
                      {isAdmin && (
                        <Button size="sm" variant="danger" className="flex-1" disabled={busy} onClick={() => act(() => hideObstacle(o.id, null), '숨겼어요.')}>
                          숨김 (잘못 등록)
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'add' && (
            <AddForm
              point={point}
              picking={picking}
              onPicking={setPicking}
              busy={busy}
              onObstacle={(i) =>
                act(
                  () => registerObstacle({ ...i, widthCm: null, crossSlopePct: null, at: point!, reportId: null }).then(() => setPoint(null)),
                  '장애물을 등록했어요. 지도와 길 안내에 반영돼요.',
                )
              }
              draft={draft}
              onDraft={setDraft}
              paths={paths}
              onNewPath={(coords, deg, pct, note) =>
                act(
                  () => addAdminPath(coords, pct, deg, note).then(() => setDraft([])),
                  `새 길(${Math.round(pathLength(coords))}m, 경사 ${pct.toFixed(1)}%)을 추가했어요. 일반 지도를 새로 열면 지도와 길 안내에 반영돼요.`,
                )
              }
              onHidePath={(id) => act(() => hideAdminPath(id), `관리자 추가 길 #${id}을 숨겼어요.`)}
              drawOpts={drawOpts}
              onDrawOpts={setDrawOpts}
              draftLinked={draftLinked}
            />
          )}

          {tab === 'road' && (
            <RoadEditor
              key={road?.id ?? 'none'}
              seg={road && segments ? (segments.find((x) => x.id === road.id) ?? null) : null}
              path={road && road.id >= ADMIN_SEG0 ? (paths.find((x) => x.id === road.id - ADMIN_SEG0) ?? null) : null}
              at={road?.at ?? null}
              saved={saved}
              busy={busy}
              onSlope={(segId, deg, pct) =>
                act(() => setSegmentIncline(segId, deg, pct, road?.at ?? null), `구간 #${segId} 경사를 ${deg}° → ${pct.toFixed(1)}%로 고쳤어요. 일반 지도를 새로 열면 반영돼요.`)
              }
              onClear={(segId) => act(() => clearSegmentIncline(segId), `구간 #${segId}의 실측 경사를 지웠어요. 지도는 다시 추정값을 써요.`)}
              onPath={(id, deg, pct, note) => act(() => updateAdminPath(id, pct, deg, note), `관리자 추가 길 #${id}을 고쳤어요 (경사 ${pct.toFixed(1)}%).`)}
              onHidePath={(id) =>
                act(async () => {
                  await hideAdminPath(id)
                  setRoad(null)
                }, `관리자 추가 길 #${id}을 숨겼어요.`)
              }
            />
          )}

          {tab === 'legend' && <PanelSection title="통합 범례"><MapLegend /></PanelSection>}
          {tab === 'members' && <Members isAdmin={isAdmin} />}
        </div>
        {/* 아래 단: 새로고침 · 지도 · 로그아웃 (같은 알약 세 개) */}
        <div className="flex shrink-0 gap-2 border-t border-line/8 px-5 py-3">
          <Button size="sm" variant="hairline" className="flex-1" onClick={() => void reload()}>
            새로고침
          </Button>
          <a href="./" className={buttonClass('hairline', 'sm', 'flex-1')}>
            지도
          </a>
          <Button size="sm" variant="hairline" className="flex-1" onClick={onLogout}>
            로그아웃
          </Button>
        </div>
      </aside>
    </div>
  )
}

function ReportCard({
  r,
  cluster,
  open,
  busy,
  onOpen,
  onConfirm,
  onReject,
}: {
  r: Report
  cluster: number
  open: boolean
  busy: boolean
  onOpen: () => void
  onConfirm: (type: ObstacleType, value: number | null) => void
  onReject: (result: 'not_found' | 'hidden', note: string | null) => void
}) {
  const [type, setType] = useState<ObstacleType>(r.type)
  const [val, setVal] = useState(r.measured_value != null ? String(r.measured_value) : '')
  const num = val.trim() === '' ? null : Number(val)
  return (
    <div className={`rounded-nav border p-3 text-ui transition-colors ${open ? 'border-ink bg-hl' : 'border-line/10 bg-tint/3 hover:bg-tint/5'}`}>
      <button type="button" className="w-full text-left" onClick={onOpen}>
        <span className="flex flex-wrap items-center gap-2">
          <b className="font-medium text-fg-strong">{OBSTACLE_LABEL[r.type]}</b>
          {r.measured_value != null && (
            <span className="text-fg tabular-nums">
              {r.measured_value}
              {r.measured_unit}
            </span>
          )}
          {cluster > 1 && <Chip tone="warn">같은 곳 {cluster}건</Chip>}
        </span>
        <span className="mt-0.5 block text-caption text-fg-muted">
          #{r.id} · {new Date(r.created_at).toLocaleString('ko-KR')} · {r.loc_source === 'gps' ? `GPS${r.accuracy_m ? ` ±${Math.round(r.accuracy_m)}m` : ''}` : '지도에서 고름'}
        </span>
        {r.text && <span className="mt-1.5 block text-fg">“{r.text}”</span>}
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-line/10 pt-3">
          <Hint>현장에서 확인한 뒤 처리하세요. 맞음이면 장애물로 등록되고 같은 묶음 제보도 함께 처리돼요.</Hint>
          <div className="flex items-center gap-2">
            <Select fieldSize="sm" value={type} onChange={(e) => setType(e.target.value as ObstacleType)} aria-label="확인한 종류">
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {OBSTACLE_LABEL[t]}
                </option>
              ))}
            </Select>
            {(type === 'kerb' || type === 'cross_slope') && (
              <label className="flex items-center gap-1.5 text-caption text-fg-muted">
                <Input fieldSize="sm" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} className="w-16" aria-label={type === 'kerb' ? '단차 높이 cm' : '횡경사 %'} />
                {type === 'kerb' ? 'cm (잰 값)' : '% (잰 값)'}
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" className="flex-[1.6]" disabled={busy || (num != null && !Number.isFinite(num))} onClick={() => onConfirm(type, num)}>
              맞음 → 장애물 등록
            </Button>
            <Button size="sm" variant="ghost" className="flex-1" disabled={busy} onClick={() => onReject('not_found', null)}>
              없음
            </Button>
            <Button size="sm" variant="danger" className="flex-1" disabled={busy} onClick={() => onReject('hidden', '부적절')}>
              숨김
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-nav border border-dashed border-line/15 px-3 py-6 text-center text-ui text-fg-muted">{children}</p>
}

// 직접 추가: 단차·계단·기타는 장애물로, 경사는 가까운 구간의 실측 경사(%)로 남긴다
type AddType = 'kerb' | 'stairs' | 'slope' | 'other'
const ADD_LABEL: Record<AddType, string> = { kerb: '단차(턱)', stairs: '계단', slope: '경사', other: '기타' }

// 경사를 붙일 구간을 찾으려고 공개 지도 데이터를 한 번만 받는다 (구간 번호가 DB와 같다)
let citySegments: Promise<SlopeSegment[]> | null = null
function loadCitySegments(): Promise<SlopeSegment[]> {
  citySegments ??= fetch('./data/donghae_city.json')
    .then((r) => {
      if (!r.ok) throw new Error('지도 데이터를 받지 못했어요')
      return r.json() as Promise<SlopeArea>
    })
    .then((a) => a.segments)
    .catch((e) => {
      citySegments = null
      throw e
    })
  return citySegments
}

function AddForm({ point, picking, onPicking, busy, onObstacle, draft, onDraft, paths, onNewPath, onHidePath, drawOpts, onDrawOpts, draftLinked }: {
  point: LonLat | null
  picking: boolean
  onPicking: (on: boolean) => void
  busy: boolean
  onObstacle: (i: { type: ObstacleType; kerbCm: number | null; note: string | null }) => void
  /** 새 길 그리기 중 찍은 점 (그리기 중이 아니면 null) */
  draft: LonLat[] | null
  onDraft: React.Dispatch<React.SetStateAction<LonLat[] | null>>
  paths: AdminPath[]
  onNewPath: (coords: LonLat[], deg: number, pct: number, note: string | null) => void
  onHidePath: (id: number) => void
  drawOpts: DrawOpts
  onDrawOpts: (o: DrawOpts) => void
  /** 그리는 길의 [시작, 끝]이 기존 길에 이어지는가 */
  draftLinked: [boolean, boolean] | null
}) {
  const [type, setType] = useState<AddType>('kerb')
  const [val, setVal] = useState('')
  const [note, setNote] = useState('')
  const [pathNote, setPathNote] = useState('')
  const num = val.trim() === '' ? null : Number(val)
  const badNum = num != null && !Number.isFinite(num)
  // 경사 = 우리 데이터에 없는 길(카카오 지도의 흰색 길)을 그려 넣기. 기존 색 선의 경사는 '길 수정' 탭에서 길을 눌러 넣는다
  const drawing = type === 'slope'
  // 경사를 고르면 지도 클릭이 점 찍기가 된다
  useEffect(() => onDraft((d) => (drawing ? (d ?? []) : null)), [drawing, onDraft])
  useEffect(() => () => onDraft(null), [onDraft])
  const deg = type === 'slope' ? num : null
  const degOk = deg != null && Number.isFinite(deg) && deg > 0 && deg < MAX_DEG
  const pct = degOk ? degToPct(deg) : null
  const draftLen = draft && draft.length > 1 ? pathLength(draft) : 0

  const canSubmit =
    !busy &&
    !badNum &&
    (drawing
      ? degOk && !!draft && draft.length >= 2 && draftLen >= 2
      : !!point && (type === 'other' ? note.trim().length > 0 : true))

  const submit = () => {
    if (drawing) return draft && pct != null && onNewPath(draft, deg!, pct, pathNote.trim() || null)
    onObstacle({ type, kerbCm: type === 'kerb' ? num : null, note: type === 'other' ? note.trim() : null })
  }

  return (
    <div className="space-y-3 p-5 text-ui">
      <Hint>현장에서 확인한 내용을 바로 등록해요 (제보 없이). 단차·계단·기타는 길에서 15m 안이면 가까운 구간에 붙어요.</Hint>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="종류">
        {(Object.keys(ADD_LABEL) as AddType[]).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            onClick={() => {
              setType(t)
              setVal('')
            }}
            className={choiceClass(type === t, 'h-11 px-1')}
          >
            {ADD_LABEL[t]}
          </button>
        ))}
      </div>

      {type === 'kerb' && (
        <label className="flex items-center gap-3">
          <Input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} className="w-24" aria-label="단차 높이 cm" />
          <span className="text-caption text-fg-muted">cm (단차 높이) · 선택</span>
        </label>
      )}

      {type === 'slope' && (
        <div className="glass space-y-2 rounded-card border border-line/10 p-4">
          <label className="flex items-center gap-2">
            <Input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder="예: 3.5" className="w-24 tabular-nums" aria-label="경사 각도 (도)" />
            <span className="text-caption text-fg-muted">° (각도)</span>
            <span className="ml-auto text-right">
              {pct != null ? (
                <>
                  → <b className="font-medium text-fg-strong tabular-nums">{pct.toFixed(1)}%</b>
                  <span className={`ml-1 text-caption font-medium ${pct > 8.3 ? 'text-danger' : pct > 5.6 ? 'text-warn' : 'text-ok'}`}>
                    {pct > 8.3 ? '급경사' : pct > 5.6 ? '주의' : '통행 가능'}
                  </span>
                </>
              ) : (
                <span className="text-caption text-fg-subtle">지도는 %로 써요</span>
              )}
            </span>
          </label>
          {deg != null && !degOk && <p className="text-caption text-danger">0°보다 크고 {MAX_DEG}°보다 작게 넣어 주세요.</p>}
          <Hint>경사(%) = tan(각도) × 100 · 기준: 3.2° ≈ 5.6% (1/18), 4.8° ≈ 8.3% (1/12)</Hint>
          <p className="text-caption text-fg-muted">이미 색 선이 있는 길의 경사는 [길 수정] 탭에서 그 길을 눌러 넣어요.</p>
            <div className="space-y-2">
              <p className="text-caption text-fg">
                지도의 <b className="font-medium">흰색 길을 따라 차례로 누르세요</b>. 첫 점과 끝 점을 색 선(또는 보라색 관리자 길) 위에 찍으면 길 안내에도 이어져요.
              </p>
              {/* 휴대폰에서도 쓰도록 키(Shift) 대신 켜기/끄기 버튼 */}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" aria-pressed={drawOpts.magnet} onClick={() => onDrawOpts({ ...drawOpts, magnet: !drawOpts.magnet })} className={choiceClass(drawOpts.magnet, 'h-10 px-2 text-caption')}>
                  자석 {drawOpts.magnet ? '켜짐' : '꺼짐'}
                </button>
                <button type="button" aria-pressed={drawOpts.ortho} onClick={() => onDrawOpts({ ...drawOpts, ortho: !drawOpts.ortho })} className={choiceClass(drawOpts.ortho, 'h-10 px-2 text-caption')}>
                  직교 모드 {drawOpts.ortho ? '켜짐' : '꺼짐'}
                </button>
              </div>
              <Hint>
                자석: 누른 곳 가까이(화면에서 손가락 하나) 길이 있으면 그 위에 정확히 붙어요. 직교: 다음 구간을 앞 구간과 일직선·직각으로 맞춰요 (첫 구간은 시작점이 붙은 길 기준).
              </Hint>
              <p className="text-caption text-fg-muted">
                점 {draft?.length ?? 0}개 · 길이 {Math.round(draftLen)}m
              </p>
              {draftLinked && (
                <p className="text-caption">
                  <span className={draftLinked[0] ? 'text-ok' : 'text-danger'}>시작점 {draftLinked[0] ? '이어짐 ✓' : '끊김 ✗'}</span>
                  {draft && draft.length > 1 && (
                    <>
                      {' · '}
                      <span className={draftLinked[1] ? 'text-ok' : 'text-danger'}>끝점 {draftLinked[1] ? '이어짐 ✓' : '끊김 ✗'}</span>
                    </>
                  )}
                  {(!draftLinked[0] || (draft && draft.length > 1 && !draftLinked[1])) && <span className="block text-fg-muted">끊긴 끝은 길 안내에서 다른 길로 이어지지 않아요. 막다른 길이 맞으면 그대로 저장해도 돼요.</span>}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" className="flex-1" disabled={!draft?.length} onClick={() => onDraft((d) => (d ? d.slice(0, -1) : d))}>
                  마지막 점 지우기
                </Button>
                <Button size="sm" variant="ghost" className="flex-1" disabled={!draft?.length} onClick={() => onDraft([])}>
                  처음부터
                </Button>
              </div>
              <Input value={pathNote} onChange={(e) => setPathNote(e.target.value)} maxLength={300} placeholder="길 설명 (선택, 예: 웰빙레포츠타운 안쪽 길)" className="w-full" aria-label="길 설명" />
            </div>
        </div>
      )}

      {type === 'other' && (
        <label className="block">
          <span className="mb-1.5 block text-caption text-fg-muted">기타 사항 (필수)</span>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="예: 공사 펜스로 인도가 막힘, 볼라드 간격이 좁음"
            className="w-full"
          />
        </label>
      )}

      {!drawing && (
        <button type="button" onClick={() => onPicking(!picking)} aria-pressed={picking} className={choiceClass(picking, 'h-11 w-full px-3')}>
          {picking ? '지도를 눌러 위치를 고르세요' : point ? `위치: ${point[1].toFixed(5)}, ${point[0].toFixed(5)} (다시 고르기)` : '지도에서 위치 고르기'}
        </button>
      )}
      <Button variant="primary" className="w-full" disabled={!canSubmit} onClick={submit}>
        {drawing ? '새 길 저장' : `${ADD_LABEL[type]} 등록`}
      </Button>

      {drawing && paths.length > 0 && (
        <section className="space-y-1.5 pt-2">
          <h3 className="text-caption font-medium text-fg-strong">추가한 길 {paths.length}개 (지도에 보라색)</h3>
          <ul className="divide-y divide-line/8 rounded-nav border border-line/10">
            {paths.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-caption">
                <span className="min-w-0 flex-1 truncate">
                  #{p.id} · {Math.round(pathLength(p.coords))}m · {p.incline.toFixed(1)}%{p.deg != null ? ` (${p.deg}°)` : ''}
                  {p.note ? ` · ${p.note}` : ''}
                </span>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => onHidePath(p.id)}>
                  숨김
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const pctToDeg = (pct: number) => Math.round(((Math.atan(pct / 100) * 180) / Math.PI) * 10) / 10

/** 길 수정: 관리자 지도에서 누른 길의 경사를 고치거나(실측값), 실측값을 지워 추정값으로 되돌리고, 관리자 추가 길은 경사·설명을 고치거나 숨긴다 */
function RoadEditor({ seg, path, at, saved, busy, onSlope, onClear, onPath, onHidePath }: {
  seg: SlopeSegment | null
  /** 고른 길이 관리자 추가 길이면 그 원본 */
  path: AdminPath | null
  at: LonLat | null
  /** 저장할 때마다 바뀜 (기록 다시 받기) */
  saved: number
  busy: boolean
  onSlope: (segmentId: number, deg: number, pct: number) => void
  onClear: (segmentId: number) => void
  onPath: (id: number, deg: number, pct: number, note: string | null) => void
  onHidePath: (id: number) => void
}) {
  const survey = seg?.survey?.incline ?? null
  const start = path ? (path.deg ?? pctToDeg(path.incline)) : survey != null ? pctToDeg(survey) : null
  const [val, setVal] = useState(start != null ? String(start) : '')
  const [note, setNote] = useState(path?.note ?? '')
  const [hist, setHist] = useState<(Measurement & { superseded_at: string | null })[] | null>(null)
  const canRecord = !!seg && !path && recordable(seg)
  const segId = seg?.id ?? null
  useEffect(() => {
    if (!canRecord || segId == null) return
    let alive = true
    segmentInclineHistory(segId).then(
      (h) => alive && setHist(h),
      () => alive && setHist([]),
    )
    return () => {
      alive = false
    }
  }, [canRecord, segId, saved])

  if (!seg) return <div className="p-5"><EmptyState>지도에서 고칠 길(색 선이나 보라색 관리자 길)을 누르세요. 선은 지도를 확대하면 보여요 (레벨 {ROAD_MAX_LEVEL} 이하).</EmptyState></div>

  const deg = val.trim() === '' ? null : Number(val)
  const degOk = deg != null && Number.isFinite(deg) && deg > 0 && deg < MAX_DEG
  const pct = degOk ? degToPct(deg) : null
  const cls = classify(seg, 'final')
  const title = path ? `관리자 추가 길 #${path.id}` : `${seg.name ?? seg.cls ?? '이름 없는 길'} · 구간 #${seg.id}`

  return (
    <div className="space-y-3 p-5 text-ui">
      <div className="glass space-y-1 rounded-card border border-line/10 p-4">
        <h3 className="text-subheading text-fg-strong">{title}</h3>
        <p className="text-caption text-fg-muted">
          길이 {Math.round(seg.len)}m · 지금 지도 표시: <b className="font-medium text-fg">{SLOPE_LABEL[cls]}</b>
          {at && ` · 누른 곳 ${at[1].toFixed(5)}, ${at[0].toFixed(5)}`}
        </p>
        {path ? (
          <p className="text-caption text-fg">
            입력한 경사 {path.incline.toFixed(1)}%{path.deg != null ? ` (${path.deg}°)` : ''} · {fmtDate(path.at)} 추가{path.note ? ` · “${path.note}”` : ''}
          </p>
        ) : (
          <p className="text-caption text-fg">
            추정 최대 경사 {seg.max != null ? `${seg.max.toFixed(1)}%` : '모름'}
            {survey != null ? (
              <>
                {' · '}
                <b className="font-medium text-ok">실측 {survey.toFixed(1)}%</b> (지도는 실측값을 써요)
              </>
            ) : (
              ' · 실측 없음 (지도는 추정값을 써요)'
            )}
          </p>
        )}
      </div>

      {!path && !canRecord ? (
        <Notice tone="danger">이 길은 보완용으로 이은 길(OSM·연결선)이라 DB 구간 번호가 없어 경사를 고칠 수 없어요. 경사를 넣으려면 [직접 추가 → 경사 → 흰색 길 새로 그리기]로 같은 자리에 길을 그려 주세요.</Notice>
      ) : (
        <div className="glass space-y-2 rounded-card border border-line/10 p-4">
          <label className="flex items-center gap-2">
            <Input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder="예: 3.5" className="w-24 tabular-nums" aria-label="경사 각도 (도)" />
            <span className="text-caption text-fg-muted">° (각도)</span>
            <span className="ml-auto text-right">
              {pct != null ? (
                <>
                  → <b className="font-medium text-fg-strong tabular-nums">{pct.toFixed(1)}%</b>
                  <span className={`ml-1 text-caption font-medium ${pct > 8.3 ? 'text-danger' : pct > 5.6 ? 'text-warn' : 'text-ok'}`}>{pct > 8.3 ? '급경사' : pct > 5.6 ? '주의' : '통행 가능'}</span>
                </>
              ) : (
                <span className="text-caption text-fg-subtle">지도는 %로 써요</span>
              )}
            </span>
          </label>
          {deg != null && !degOk && <p className="text-caption text-danger">0°보다 크고 {MAX_DEG}°보다 작게 넣어 주세요.</p>}
          {path && <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="길 설명 (선택)" className="w-full" aria-label="길 설명" />}
          <Button
            variant="primary"
            className="w-full"
            disabled={busy || !degOk}
            onClick={() => (path ? onPath(path.id, deg!, pct!, note.trim() || null) : onSlope(seg.id, deg!, pct!))}
          >
            {path ? '고친 내용 저장' : survey != null ? '실측 경사 고치기' : '실측 경사 넣기'}
          </Button>
          {path ? (
            <Button variant="danger" className="w-full" disabled={busy} onClick={() => onHidePath(path.id)}>
              이 길 숨기기 (지도·길 안내에서 빼기)
            </Button>
          ) : (
            survey != null && (
              <Button variant="ghost" className="w-full" disabled={busy} onClick={() => onClear(seg.id)}>
                실측 경사 지우기 (추정값으로 되돌리기)
              </Button>
            )
          )}
        </div>
      )}

      {canRecord && hist && hist.length > 0 && (
        <section className="space-y-1.5">
          <h4 className="text-caption font-medium text-fg-strong">이 구간 경사 기록</h4>
          <ul className="divide-y divide-line/8 rounded-nav border border-line/10">
            {hist.map((m) => (
              <li key={m.id} className={`px-3 py-2 text-caption ${m.superseded_at ? 'text-fg-subtle line-through' : 'text-fg'}`}>
                {fmtDate(m.measured_at)} · {Number(m.value).toFixed(1)}%{m.note ? ` · ${m.note}` : ''} · admin
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// 기록: 누가 했는지는 계정 대신 'admin'으로, 언제 기입했는지만 보인다
const ENTITY_LABEL: Record<string, string> = { report: '제보', obstacle: '장애물', segment: '구간', admin_path: '관리자 추가 길' }
const STATUS_LABEL: Record<string, string> = {
  active: '추가',
  edited: '수정',
  reverted: '추정값으로 되돌림',
  pending: '대기',
  confirmed: '확인(등록)',
  not_found: '없음',
  hidden: '숨김',
  reported: '제보됨',
  verified: '등록',
  resolved: '해소',
}
const fmtDate = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function measurementText(m: Measurement): string {
  const where = `${ENTITY_LABEL[m.target_type] ?? m.target_type} #${m.target_id}`
  if (m.key === 'incline') return `경사 기록 · ${where} → ${Number(m.value).toFixed(1)}%${m.note ? ` (${m.note.replace(' (관리자 입력)', '')})` : ''}`
  if (m.key === 'cross_slope') return `횡경사 기록 · ${where} → ${Number(m.value).toFixed(1)}%`
  if (m.key === 'kerb:height') return `단차 높이 · ${where} → ${m.value}${m.unit ?? ''}`
  return `폭 · ${where} → ${m.value}${m.unit ?? ''}`
}
function eventText(e: StatusEvent): string {
  const to = STATUS_LABEL[e.to_status] ?? e.to_status
  const from = e.from_status ? `${STATUS_LABEL[e.from_status] ?? e.from_status} → ` : ''
  return `${ENTITY_LABEL[e.entity_type] ?? e.entity_type} #${e.entity_id} · ${from}${to}${e.note ? ` (${e.note})` : ''}`
}

function Members({ isAdmin }: { isAdmin: boolean }) {
  const [members, setMembers] = useState<{ email: string; role: string; last_sign_in_at: string | null }[]>([])
  const [rows, setRows] = useState<{ key: string; at: string; text: string }[]>([])
  const [email, setEmail] = useState('')
  const [role, setRoleSel] = useState<'surveyor' | 'admin' | 'none'>('surveyor')
  const [msg, setMsg] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const [ev, ms] = await Promise.all([listEvents(), listMeasurements().catch(() => [] as Measurement[])])
      setRows(
        [
          ...ev.map((e) => ({ key: `e${e.id}`, at: e.at, text: eventText(e) })),
          ...ms.map((m) => ({ key: `m${m.id}`, at: m.measured_at, text: measurementText(m) })),
        ]
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 80),
      )
      if (isAdmin) setMembers(await listMembers())
    } catch (e) {
      setMsg((e as Error).message)
    }
  }, [isAdmin])
  useEffect(() => {
    // 탭을 열 때 받는다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  return (
    <div className="space-y-6 p-5 text-ui">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-body text-fg">기록</h2>
          <Button size="sm" variant="quiet" onClick={() => void load()}>
            새로고침
          </Button>
        </div>
        {rows.length === 0 ? (
          <EmptyState>아직 기록이 없어요.</EmptyState>
        ) : (
          <div className="overflow-hidden rounded-nav border border-line/10">
            <table className="w-full table-fixed border-collapse text-caption">
              <thead className="bg-tint/4">
                <tr className="border-b border-line/10 text-left text-fg-muted">
                  <th className="w-[7.5rem] px-3 py-2 font-medium">날짜</th>
                  <th className="w-16 py-2 font-medium">기록자</th>
                  <th className="py-2 pr-3 font-medium">내용</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-line/8 align-top last:border-0">
                    <td className="px-3 py-2 text-fg-muted tabular-nums">{fmtDate(r.at)}</td>
                    <td className="py-2 font-medium text-fg">admin</td>
                    <td className="py-2 pr-3 break-words text-fg">{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="space-y-3 rounded-card border border-line/10 p-4">
          <h2 className="text-body text-fg">계정 역할</h2>
          <Hint>관리자·조사원 권한이 있는 계정이에요. 기록에는 계정 대신 'admin'으로 남아요.</Hint>
          <ul className="divide-y divide-line/8 overflow-hidden rounded-nav border border-line/10 bg-tint/3">
            {members.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="truncate text-fg">{m.email}</span>
                <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-caption ${m.role === 'admin' ? 'bg-ink text-on-ink' : 'border border-line/15 text-fg-muted'}`}>
                  {ROLE_LABEL[m.role as 'admin' | 'surveyor'] ?? m.role}
                </span>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              setMsg(null)
              try {
                await setRole(email.trim(), role)
                setMsg(`${email.trim()} → ${role === 'none' ? '역할 없음' : ROLE_LABEL[role]} (그 사람이 다시 로그인하면 반영)`)
                setEmail('')
                await load()
              } catch (x) {
                setMsg((x as Error).message)
              }
            }}
          >
            <Input fieldSize="sm" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일 (Supabase에 먼저 만든 계정)" aria-label="이메일" className="flex-1" />
            <Select fieldSize="sm" value={role} onChange={(e) => setRoleSel(e.target.value as 'surveyor' | 'admin' | 'none')} aria-label="역할">
              <option value="surveyor">조사원</option>
              <option value="admin">관리자</option>
              <option value="none">역할 빼기</option>
            </Select>
            <Button type="submit" size="sm" variant="primary">
              적용
            </Button>
          </form>
          {msg && (
            <p role="status" className="text-caption text-fg">
              {msg}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
