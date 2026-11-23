// 관리자 지도 (카카오): 우리 길 데이터를 일반 지도와 같은 경사 색으로 그린다 (선이 없는 흰색 길 = 데이터가 빈 길).
// 대기 중 제보(주황)·장애물(빨강/갈색) 표시, 누르면 고르기, '직접 추가' 중에는 지도를 누른 곳을 위치로, '새 길 그리기' 중에는 누른 곳을 점으로 잇는다.
import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, LocateFixed, Minus, Plus } from 'lucide-react'
import { MapTypeSwitch, type MapType } from '@/components/MapTypeSwitch'
import { FloatingMapLegend } from '@/components/MapLegend'
import { OBSTACLE_LABEL, type Obstacle, type Report } from '@/lib/adminApi'
import { loadKakao, type KakaoNS } from '@/lib/kakao'
import { metersBetween } from '@/lib/route'
import { ADMIN_PATH_COLOR, classify, KAKAO_LINE_STYLE, KAKAO_MTN_STYLE, type SlopeSegment } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

export type Pick = { kind: 'report' | 'obstacle'; id: number } | null

/** 지도에 그릴 길: segs는 우리 길 데이터(조사 결과·관리자 추가 길 포함), nearId는 경사를 붙일 가장 가까운 길, draft는 그리는 중인 새 길 */
export interface RoadOverlay {
  segs: SlopeSegment[]
  nearId: number | null
  draft: LonLat[] | null
  /** 그리는 중인 새 길의 [시작, 끝]이 기존 길에 이어지는가 (점 색: 초록 이어짐 / 빨강 끊김) */
  draftLinked?: [boolean, boolean] | null
  /** 고치려고 고른 길 (노랗게 강조) */
  selId?: number | null
}

/** 자석 거리: 화면에서 손가락 하나(약 18px)가 지금 확대 수준에서 몇 m인지 */
const SNAP_PX = 18
/** 누르기 판정: 이만큼(px) 안에서 이 시간(ms) 안에 떼면 한 번 누른 것 */
const TAP_MOVE_PX = 10
const TAP_MS = 600

/** 이보다 멀리 보면(카카오 지도 레벨이 크면) 길 선을 그리지 않는다 (일반 지도와 같음: 선이 너무 많아짐) */
export const ROAD_MAX_LEVEL = 5

type BBox = [number, number, number, number]
function bboxOf(c: LonLat[]): BBox {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of c) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

interface Props {
  center: LonLat
  reports: Report[]
  obstacles: Obstacle[]
  selected: Pick
  onSelect: (p: Pick) => void
  picking: boolean
  /** 지도를 누른 곳. tolM: 지금 확대 수준에서 자석이 붙을 거리 m */
  onPick: (p: LonLat, tolM: number) => void
  point: LonLat | null
  /** 바뀌면 그 위치로 이동 */
  focus: { at: LonLat; key: number } | null
  /** 우리 길 데이터 (항상 경사 색으로 그림) + 가장 가까운 길 강조 + 그리는 중인 새 길 */
  roads?: RoadOverlay | null
  /** 위치 고르기·점 찍기 중이 아닐 때 지도를 누른 곳 (길 고르기용). tolM: 손가락 하나 거리 m */
  onTap?: (p: LonLat, tolM: number) => void
  mapType?: MapType
  onMapTypeChange: (type: MapType) => void
}

type RoadCache = { segs: SlopeSegment[]; lines: Map<number, { line: KakaoNS; box: BBox; shown: boolean }> }

export function AdminMap({ center, reports, obstacles, selected, onSelect, picking, onPick, point, focus, roads = null, onTap, mapType = 'roadmap', onMapTypeChange }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const k = useRef<{ kakao: KakaoNS; map: KakaoNS; marks: KakaoNS[]; pin: KakaoNS; roads: RoadCache | null; extra: KakaoNS[] } | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooFar, setTooFar] = useState(false)
  const [linesHidden, setLinesHidden] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)
  const cb = useRef({ onSelect, onPick, picking, roads, onTap, linesHidden })
  useEffect(() => {
    cb.current = { onSelect, onPick, picking, roads, onTap, linesHidden }
  })
  // 누른 곳 + 자석 거리(화면 SNAP_PX가 지금 몇 m인지)
  const pickAt = (ll: KakaoNS) => {
    const c = k.current
    if (!c) return
    const b = c.map.getBounds()
    const sw = b.getSouthWest()
    const ne = b.getNorthEast()
    const lat = (sw.getLat() + ne.getLat()) / 2
    const widthM = metersBetween([sw.getLng(), lat], [ne.getLng(), lat])
    const p: LonLat = [ll.getLng(), ll.getLat()]
    const tolM = (widthM / (box.current?.clientWidth || 1)) * SNAP_PX
    // 위치 고르기·점 찍기 중이면 그 점, 아니면 길 고르기
    if (cb.current.picking) cb.current.onPick(p, tolM)
    else cb.current.onTap?.(p, tolM)
  }
  // pickAt은 ref만 읽으므로 처음 것을 그대로 써도 된다
  const pickRef = useRef(pickAt)

  // 길 선: 확대했을 때 화면 안에 있는 구간만 지도에 올린다 (선은 한 번 만들어 두고 보이기만 바꾼다)
  const showRoads = useRef(() => {})
  useEffect(() => {
    showRoads.current = () => {
      const c = k.current
      const r = cb.current.roads
      if (!c) return
      const { maps } = c.kakao
      // 길 목록이 바뀌면(조사 결과·관리자 추가 길 다시 받음) 새로 만든다
      if (c.roads && c.roads.segs !== r?.segs) {
        for (const { line } of c.roads.lines.values()) line.setMap(null)
        c.roads = null
      }
      if (!r) return
      c.roads ??= { segs: r.segs, lines: new Map() }
      const level = c.map.getLevel()
      setTooFar(level > ROAD_MAX_LEVEL)
      const b = c.map.getBounds()
      const [w, s0, e, n] = [b.getSouthWest().getLng(), b.getSouthWest().getLat(), b.getNorthEast().getLng(), b.getNorthEast().getLat()]
      const visible = (bx: BBox) => !cb.current.linesHidden && level <= ROAD_MAX_LEVEL && bx[2] >= w && bx[0] <= e && bx[3] >= s0 && bx[1] <= n
      for (const seg of r.segs) {
        let it = c.roads.lines.get(seg.id)
        if (!it) {
          const bx = bboxOf(seg.c)
          if (!visible(bx)) continue
          const admin = seg.kind === 'admin_path'
          const st = admin ? { color: ADMIN_PATH_COLOR, weight: 6, style: 'solid' } : seg.mtn ? KAKAO_MTN_STYLE : KAKAO_LINE_STYLE[classify(seg, 'final')]
          const line = new maps.Polyline({
            path: seg.c.map(([x, y]) => new maps.LatLng(y, x)),
            strokeWeight: st.weight,
            strokeColor: st.color,
            strokeStyle: st.style,
            strokeOpacity: seg.mtn ? 0.6 : 0.95,
            zIndex: admin ? 4 : 3,
          })
          it = { line, box: bx, shown: false }
          c.roads.lines.set(seg.id, it)
        }
        const show = visible(it.box)
        if (show !== it.shown) {
          it.line.setMap(show ? c.map : null)
          it.shown = show
        }
      }
      // 가장 가까운 길 강조 + 그리는 중인 새 길
      for (const o of c.extra) o.setMap(null)
      c.extra = []
      const near = r.nearId != null ? r.segs.find((x) => x.id === r.nearId) : undefined
      if (near) {
        c.extra.push(new maps.Polyline({ map: c.map, path: near.c.map(([x, y]) => new maps.LatLng(y, x)), strokeWeight: 14, strokeColor: '#2563eb', strokeOpacity: 0.45, zIndex: 2 }))
      }
      const sel = r.selId != null ? r.segs.find((x) => x.id === r.selId) : undefined
      if (sel) {
        c.extra.push(new maps.Polyline({ map: c.map, path: sel.c.map(([x, y]) => new maps.LatLng(y, x)), strokeWeight: 16, strokeColor: '#facc15', strokeOpacity: 0.7, zIndex: 2 }))
      }
      if (r.draft && r.draft.length) {
        const path = r.draft.map(([x, y]) => new maps.LatLng(y, x))
        if (path.length > 1) c.extra.push(new maps.Polyline({ map: c.map, path, strokeWeight: 6, strokeColor: ADMIN_PATH_COLOR, strokeOpacity: 0.9, strokeStyle: 'shortdash', zIndex: 6 }))
        const lastI = r.draft.length - 1
        r.draft.forEach(([x, y], i) => {
          const el = document.createElement('div')
          // 시작·끝 점: 기존 길에 이어지면 초록, 아니면 빨강 (중간 점은 보라)
          const endIdx = i === 0 ? 0 : i === lastI ? 1 : -1
          const ok = r.draftLinked ? (endIdx === 0 ? r.draftLinked[0] : r.draftLinked[1]) : false
          const color = endIdx >= 0 && r.draftLinked ? (ok ? '#16a34a' : '#dc2626') : ADMIN_PATH_COLOR
          const size = endIdx >= 0 ? 16 : 10
          el.style.cssText = `transform:translate(-50%,-50%);width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px #0006`
          c.extra.push(new maps.CustomOverlay({ map: c.map, position: new maps.LatLng(y, x), content: el, xAnchor: 0, yAnchor: 0, zIndex: 7 }))
        })
      }
    }
  })

  useEffect(() => {
    let cancelled = false
    loadKakao()
      .then((kakao) => {
        if (cancelled || !box.current) return
        const { maps } = kakao
        // 처음부터 길 선이 보이는 확대 수준으로 연다 (ROAD_MAX_LEVEL보다 멀면 선을 그리지 않음)
        const map = new maps.Map(box.current, { center: new maps.LatLng(center[1], center[0]), level: Math.min(4, ROAD_MAX_LEVEL) })
        // 카카오 로고·축척: 넓은 화면은 지도 왼쪽에 패널이 떠 있어 오른쪽 아래로 옮긴다 (일반 지도와 같음)
        map.setCopyrightPosition(maps.CopyrightPosition.BOTTOMRIGHT, true)
        // 누르기(탭): 카카오 click 대신 포인터 이벤트로 직접 판정한다 (마우스·터치 같게).
        // 카카오 click은 휴대폰에서 선 위를 누르면 선·지도 둘 다 와서 점이 두 번 찍히고, 기기에 따라 오지 않기도 한다.
        // 손가락을 대고 TAP_MOVE_PX 안에서 TAP_MS 안에 떼면 한 번 누른 것. 두 손가락(확대)·끌기는 아님. 카카오 버튼·제보 표시 위는 뺀다
        const el = box.current
        let down: { x: number; y: number; t: number; id: number } | null = null
        let last = { x: -1e9, y: -1e9, t: -1e9 }
        el.addEventListener('pointerdown', (e) => {
          down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId } : null
        }, true)
        el.addEventListener('pointercancel', () => (down = null), true)
        el.addEventListener('pointerup', (e) => {
          const d = down
          down = null
          if (!d || e.pointerId !== d.id || e.button > 0) return
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MOVE_PX || e.timeStamp - d.t > TAP_MS) return
          const t = e.target as Element
          if (!el.firstElementChild?.contains(t) || t.closest('button')) return
          // 두 번 누르기(확대)로 같은 자리에 점이 두 개 찍히지 않게
          if (e.timeStamp - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 12) return
          last = { x: e.clientX, y: e.clientY, t: e.timeStamp }
          const r = el.getBoundingClientRect()
          pickRef.current(map.getProjection().coordsFromContainerPoint(new maps.Point(e.clientX - r.left, e.clientY - r.top)))
        }, true)
        // 확대·축소 애니메이션 동안 선 SVG 층을 감춘다 (카카오가 층을 두 장 번갈아 써서 이전 화면의 선이 뒤에 남아 보임). 멈추면 다시 그리고 보인다
        maps.event.addListener(map, 'zoom_start', () => box.current?.setAttribute('data-zooming', ''))
        maps.event.addListener(map, 'idle', () => {
          showRoads.current()
          box.current?.removeAttribute('data-zooming')
        })
        k.current = { kakao, map, marks: [], pin: null, roads: null, extra: [] }
        new ResizeObserver(() => map.relayout()).observe(box.current)
        setReady(true)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 제보·장애물 표시
  useEffect(() => {
    const c = k.current
    if (!ready || !c) return
    for (const m of c.marks) m.setMap(null)
    const { maps } = c.kakao
    const mk = (at: LonLat, label: string, bg: string, sel: boolean, onClick: () => void) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.textContent = label
      el.style.cssText = `transform:translate(-50%,-50%);font:700 11px var(--font-sans);color:#fff;background:${bg};border:${sel ? '3px solid #fde047' : '2px solid #fff'};border-radius:9999px;padding:2px 8px;box-shadow:0 1px 4px #0006;white-space:nowrap;cursor:pointer`
      el.onclick = (ev) => {
        ev.stopPropagation()
        onClick()
      }
      return new maps.CustomOverlay({ map: c.map, position: new maps.LatLng(at[1], at[0]), content: el, xAnchor: 0, yAnchor: 0, zIndex: sel ? 9 : 5, clickable: true })
    }
    c.marks = [
      ...obstacles.map((o) =>
        mk(o.at, OBSTACLE_LABEL[o.type], o.type === 'stairs' || o.type === 'steep' ? '#b91c1c' : '#92400e', selected?.kind === 'obstacle' && selected.id === o.id, () =>
          cb.current.onSelect({ kind: 'obstacle', id: o.id }),
        ),
      ),
      ...reports.map((r) =>
        mk(r.at, `제보·${OBSTACLE_LABEL[r.type]}`, '#ea580c', selected?.kind === 'report' && selected.id === r.id, () => cb.current.onSelect({ kind: 'report', id: r.id })),
      ),
    ]
  }, [ready, reports, obstacles, selected])

  // 직접 추가 위치
  useEffect(() => {
    const c = k.current
    if (!ready || !c) return
    c.map.setCursor(picking ? 'crosshair' : '')
    c.pin?.setMap(null)
    c.pin = null
    if (!point) return
    const el = document.createElement('div')
    el.style.cssText = 'transform:translate(-50%,-100%);font:700 12px var(--font-sans);color:#fff;background:#2563eb;border:2px solid #fff;border-radius:12px 12px 12px 0;padding:3px 7px;box-shadow:0 1px 4px #0006'
    el.textContent = '추가할 위치'
    c.pin = new c.kakao.maps.CustomOverlay({ map: c.map, position: new c.kakao.maps.LatLng(point[1], point[0]), content: el, xAnchor: 0, yAnchor: 0, zIndex: 10 })
  }, [ready, picking, point])

  // 길 선 다시 그리기 (길 목록을 다시 받았거나, 가장 가까운 길·그리는 중인 새 길이 바뀔 때)
  useEffect(() => {
    if (ready) showRoads.current()
  }, [ready, roads, linesHidden])

  useEffect(() => {
    const c = k.current
    if (!ready || !c) return
    c.map.setMapTypeId(mapType === 'hybrid' ? c.kakao.maps.MapTypeId.HYBRID : c.kakao.maps.MapTypeId.ROADMAP)
  }, [ready, mapType])

  useEffect(() => {
    const c = k.current
    if (!ready || !c || !tracking) return
    if (!navigator.geolocation) {
      setLocError('이 브라우저는 위치를 지원하지 않아요.')
      setTracking(false)
      return
    }
    setLocError(null)
    let active = true
    let first = true
    let dot: KakaoNS = null
    const watch = navigator.geolocation.watchPosition((p) => {
      if (!active) return
      const position = new c.kakao.maps.LatLng(p.coords.latitude, p.coords.longitude)
      if (!dot) dot = new c.kakao.maps.Circle({ map: c.map, center: position, radius: 5, strokeWeight: 3, strokeColor: '#ffffff', fillColor: '#2455ae', fillOpacity: 1, zIndex: 10 })
      else dot.setPosition(position)
      if (first) {
        first = false
        c.map.setLevel(Math.min(c.map.getLevel(), 3))
        c.map.panTo(position)
      }
    }, (e) => {
      if (!active) return
      setLocError(e.code === e.PERMISSION_DENIED ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요.' : '현재 위치를 가져오지 못했어요.')
      setTracking(false)
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 })
    return () => {
      active = false
      navigator.geolocation.clearWatch(watch)
      dot?.setMap(null)
    }
  }, [ready, tracking])

  useEffect(() => {
    const c = k.current
    if (!ready || !c || !focus) return
    c.map.setLevel(Math.min(c.map.getLevel(), 3))
    c.map.panTo(new c.kakao.maps.LatLng(focus.at[1], focus.at[0]))
  }, [ready, focus])

  if (error) return <div className="flex h-full items-center justify-center bg-surface p-6 text-ui text-fg-muted">카카오 지도를 불러오지 못했어요 ({error})</div>
  return (
    <div className="relative h-full w-full">
      {/* [&>div:first-child]:isolate: 카카오 지도 층(첫 칸)을 한 층으로 묶어, 그 안의 표시(기관 이름 등 z-index 3~10)가 카카오 로고·저작권 칸(z-index 1) 위로 올라가 로고를 가리지 않게 한다 (카카오 지도 API 운영정책: 로고·저작권 표시를 가리면 안 됨) */}
      <div ref={box} className="h-full w-full bg-surface [&[data-zooming]_svg]:invisible [&>div:first-child]:isolate" role="application" aria-label="관리자 지도" />
      {ready && <div className="pointer-events-none absolute right-3 bottom-8 z-10 flex max-h-[calc(100%-6rem)] flex-col items-end gap-2 overflow-y-auto p-1 md:max-h-[calc(100%-3rem)]">
        <div role="group" aria-label="지도 확대·축소" className="pointer-events-auto flex shrink-0 flex-col overflow-hidden rounded-full border border-line/10 bg-surface text-fg shadow-subtle">
          <button type="button" aria-label="지도 확대" onClick={() => { const c = k.current; if (c) c.map.setLevel(Math.max(1, c.map.getLevel() - 1)) }} className="flex size-11 items-center justify-center hover:bg-tint/5"><Plus className="size-5" strokeWidth={1.75} aria-hidden /></button>
          <button type="button" aria-label="지도 축소" onClick={() => { const c = k.current; if (c) c.map.setLevel(Math.min(14, c.map.getLevel() + 1)) }} className="flex size-11 items-center justify-center border-t border-line/10 hover:bg-tint/5"><Minus className="size-5" strokeWidth={1.75} aria-hidden /></button>
        </div>
        <button type="button" aria-label={tracking ? '내 위치 끄기' : '내 위치'} title={tracking ? '내 위치 끄기' : '내 위치'} aria-pressed={tracking} onClick={() => setTracking(!tracking)} className={`pointer-events-auto flex size-11 shrink-0 items-center justify-center rounded-full ${tracking ? 'bg-ink text-on-ink shadow-float' : 'float-surface text-fg'}`}><LocateFixed className="size-[18px]" strokeWidth={1.75} aria-hidden /></button>
        <button type="button" aria-pressed={linesHidden} onClick={() => setLinesHidden(!linesHidden)} className="pointer-events-auto flex h-11 shrink-0 items-center gap-2 rounded-full border border-transparent bg-surface px-3.5 text-caption font-semibold text-fg shadow-subtle dark:border-line/10">
          {linesHidden ? <Eye className="size-4" strokeWidth={1.75} aria-hidden /> : <EyeOff className="size-4" strokeWidth={1.75} aria-hidden />}
          {linesHidden ? '경로 보이기' : '경로 숨기기'}
        </button>
        <MapTypeSwitch value={mapType} onChange={onMapTypeChange} />
      </div>}
      {ready && <FloatingMapLegend status={roads == null ? '길 데이터를 받는 중…' : tooFar ? '지도를 확대하면 길 선이 보여요' : linesHidden ? '경로를 숨긴 상태입니다.' : undefined} />}
      {locError && <p role="alert" className="float-surface absolute right-3 bottom-3 z-20 max-w-[min(80%,320px)] rounded-nav px-3 py-2 text-caption text-danger">{locError}</p>}
    </div>
  )
}
