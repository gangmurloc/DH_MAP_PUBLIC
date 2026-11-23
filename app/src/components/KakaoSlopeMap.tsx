// 경사 지도 (카카오 지도 바탕): 구간을 Polyline으로 덧그린다. 카카오에는 경사 데이터를 넣지 않고 그림만 맡긴다 (HANDOFF 5절).
// 동해 전체(구간 3만 개)도 돌도록, 지금 화면에 보이는 구간만 그때그때 선을 만들고 보인다.
// 많이 축소하면(MAX_DRAW_LEVEL 초과) 선을 숨기고 확대 안내를 띄운다.
// 바탕 지도는 카카오 SDK, 지도 종류·확대 버튼은 앱 디자인을 따른다.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import { onHeading, requestHeading } from '@/lib/heading'
import { joinPaths, smoothPath } from '@/lib/routeDisplay'
import { loadKakao, type KakaoNS } from '@/lib/kakao'
import type { ConfirmedObstacle } from '@/lib/reports'
import type { LonLat } from '@/lib/types'
import { classify, KAKAO_LINE_STYLE, KAKAO_MTN_STYLE, ROUTE_HIGHLIGHT, ROUTE_STYLE, ROUTE_CROSSING_COLOR, type RouteOverlay, type SlopeArea, type SlopeMode, type SlopeSegment, type SurveyInfo } from '@/lib/slope'

interface Props {
  area: SlopeArea
  mode: SlopeMode
  highlight: Set<number> | null
  /** 일반·휠체어 경로 (얇은 선 + 흰 테두리, 구간 선 위에) */
  routes: RouteOverlay | null
  selectedId: number | null
  onSelect: (id: number | null) => void
  /** SDK를 못 불러왔을 때 (도메인 미등록·네트워크). 바깥에서 대체 지도로 바꾼다 */
  onFail: (reason: string) => void
  /** 제보 위치 고르기 중이면 지도를 누른 곳을 onPick으로 */
  picking?: boolean
  onPick?: (p: LonLat) => void
  reportPoint?: LonLat | null
  /** 조사원이 확인한 장애물 */
  obstacles?: ConfirmedObstacle[]
  /** 내 위치 표시 켜기 (바깥에서 제어) */
  tracking?: boolean
  onTracking?: (on: boolean) => void
  /** 내 위치를 계속 화면 가운데에 (길 안내 중) */
  follow?: boolean
  /** 현장 조사 결과 (구간 id → 조사 정보). area는 그대로 두고 선 색만 다시 칠한다 (area가 바뀌면 지도를 새로 만든다) */
  survey?: Map<number, SurveyInfo>
  /** 경로(구간) 선을 모두 숨긴다 (임시: 디자인 확인용 켜기/끄기) */
  linesHidden?: boolean
  mapType?: 'roadmap' | 'hybrid'
  controls?: ReactNode
}

const NO_SURVEY = new Map<number, SurveyInfo>()

const OBS_LABEL: Record<ConfirmedObstacle['type'], string> = {
  stairs: '계단',
  kerb: '단차',
  cross_slope: '횡경사',
  steep: '급경사',
  narrow: '좁음',
  damaged: '파손',
  other: '기타',
}

// 카카오 선 모양은 관리자 지도와 함께 쓰므로 slope.ts에 둔다
const KSTYLE = KAKAO_LINE_STYLE
const MTN_STYLE = KAKAO_MTN_STYLE

/** 이 카카오 지도 레벨(1 가장 확대 ~ 14)보다 축소하면 구간 선을 그리지 않는다 (큰 지역만) */
const MAX_DRAW_LEVEL = 5
/** 구간이 이보다 많으면 '큰 지역'으로 보고 축소 시 숨긴다 */
const LARGE_AREA = 4000

/** 넓은 화면은 지도 왼쪽 위에 패널(392px + 여백)이 떠 있다: 영역·경로를 맞출 때 그만큼 비워 둔다 */
function panelPad() {
  try {
    return window.matchMedia('(min-width: 768px)').matches ? 408 : 0
  } catch {
    return 0
  }
}

type Line = { main: KakaoNS; tick: KakaoNS; hit: KakaoNS; shown: boolean }
type BBox = [number, number, number, number]

function bboxOf(s: SlopeSegment): BBox {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of s.c) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

export function KakaoSlopeMap({ area, mode, highlight, routes, selectedId, onSelect, onFail, picking = false, onPick, reportPoint = null, obstacles = [], tracking = false, onTracking, follow = false, survey = NO_SURVEY, linesHidden = false, mapType = 'roadmap', controls }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const kref = useRef<{ kakao: KakaoNS; map: KakaoNS; lines: Map<number, Line>; sel: KakaoNS[]; route: KakaoNS[]; refresh: () => void; pin: KakaoNS; obs: KakaoNS[] } | null>(null)
  const [ready, setReady] = useState(false)
  const [zoomHint, setZoomHint] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)
  const locRef = useRef<{ watch: number | null; dot: KakaoNS; ring: KakaoNS; first: boolean; unHeading: (() => void) | null }>({ watch: null, dot: null, ring: null, first: true, unHeading: null })
  const selectRef = useRef(onSelect)
  const failRef = useRef(onFail)
  // 선을 새로 만들 때 지금 보기 방식·강조로 칠하려고 최신 값을 둔다
  const styleRef = useRef({ mode, highlight, survey })
  const pickRef = useRef<{ on: boolean; fn?: (p: LonLat) => void }>({ on: false })
  const hiddenRef = useRef(linesHidden)
  const viewRef = useRef<{ key: string; center: KakaoNS; level: number } | null>(null)
  useEffect(() => {
    selectRef.current = onSelect
    failRef.current = onFail
    styleRef.current = { mode, highlight, survey }
    pickRef.current = { on: picking, fn: onPick }
    hiddenRef.current = linesHidden
  })

  const paint = (l: Line, s: SlopeSegment, map: KakaoNS) => {
    const { mode: m, highlight: h, survey: sv } = styleRef.current
    const info = sv.get(s.id)
    const c = classify(info ? { ...s, survey: info } : s, m)
    const st = s.mtn ? MTN_STYLE : KSTYLE[c]
    const dim = h != null && !h.has(s.id)
    l.main.setOptions({ strokeColor: st.color, strokeWeight: dim ? 2 : st.weight, strokeStyle: st.style, strokeOpacity: dim ? 0.3 : s.mtn ? 0.6 : 1 })
    l.tick.setMap(l.shown && c === 'steep' && !dim && !s.mtn ? map : null)
  }

  // 지도와 변하지 않는 것(반경 원, 기관, 횡단보도) 한 번만 만들고, 화면이 멈출 때마다 보이는 구간을 그린다
  useEffect(() => {
    let cancelled = false
    let ro: ResizeObserver | null = null
    const el = box.current
    loadKakao()
      .then((kakao) => {
        if (cancelled || !box.current) return
        const { maps } = kakao
        const LL = (lon: number, lat: number) => new maps.LatLng(lat, lon)
        const map = new maps.Map(box.current, { center: LL(area.center.lon, area.center.lat), level: 4 })
        // 카카오 로고·축척: 넓은 화면은 지도 왼쪽에 패널이 떠 있어 오른쪽 아래로 옮긴다
        map.setCopyrightPosition(maps.CopyrightPosition.BOTTOMRIGHT, true)
        const large = area.segments.length > LARGE_AREA

        if (!area.all) {
          new maps.Circle({
            map,
            center: LL(area.center.lon, area.center.lat),
            radius: area.radius,
            strokeWeight: 2,
            strokeColor: '#334155',
            strokeOpacity: 0.5,
            strokeStyle: 'dash',
            fillOpacity: 0,
          })
        }
        const b = new maps.LatLngBounds()
        const dLat = area.view / 111_320
        const dLon = dLat / Math.cos((area.center.lat * Math.PI) / 180)
        b.extend(LL(area.center.lon - dLon, area.center.lat - dLat))
        b.extend(LL(area.center.lon + dLon, area.center.lat + dLat))
        // 같은 지역을 다시 만들면(관리자 길이 늦게 도착하는 등) 보던 위치·확대 단계를 그대로 잇는다
        const prev = viewRef.current
        if (prev && prev.key === area.center.name) {
          map.setLevel(prev.level)
          map.setCenter(prev.center)
        } else if (large) map.setLevel(MAX_DRAW_LEVEL)
        else map.setBounds(b, 32, 32, 32, 32 + panelPad())

        const crossingMarks: KakaoNS[] = []
        const placeMarks: { o: KakaoNS; main: boolean }[] = []
        for (const c of area.crossings.filter((c) => c.kerb === 'raised')) {
          const o = new maps.CustomOverlay({
            map,
            position: LL(c.lon, c.lat),
            content: '<div title="턱낮춤 없는 횡단보도" style="width:9px;height:9px;background:#dc2626;border:1.5px solid #334155"></div>',
            zIndex: 3,
          })
          crossingMarks.push(o)
        }
        for (const p of area.places) {
          const main = p.name === area.center.name
          const el = document.createElement('div')
          el.style.cssText = `display:flex;align-items:center;gap:4px;transform:translate(-${main ? 8 : 5}px,-50%);font:${main ? 700 : 500} ${main ? 13 : 11}px var(--font-sans);color:#111827;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;white-space:nowrap`
          const dot = document.createElement('span')
          dot.style.cssText = `display:inline-block;width:${main ? 16 : 10}px;height:${main ? 16 : 10}px;border-radius:50%;background:${main ? '#1d4ed8' : '#7c3aed'};border:2px solid #fff;box-shadow:0 0 0 1px #0002`
          el.append(dot, document.createTextNode(p.name))
          placeMarks.push({ o: new maps.CustomOverlay({ map, position: LL(p.lon, p.lat), content: el, xAnchor: 0, yAnchor: 0.5, zIndex: 4 }), main })
        }

        const boxes = area.segments.map(bboxOf)
        const lines = new Map<number, Line>()
        const make = (s: SlopeSegment): Line => {
          const path = s.c.map(([lon, lat]) => LL(lon, lat))
          const main = new maps.Polyline({ path, strokeWeight: 4, strokeColor: '#64748b', strokeOpacity: 1, zIndex: 2 })
          // 급경사 추정: 흰 점을 얹어 색약에서도 구분
          const tick = new maps.Polyline({ path, strokeWeight: 2, strokeColor: '#ffffff', strokeOpacity: 1, strokeStyle: 'shortdot', zIndex: 3 })
          // 손가락으로 누르기 쉽게 넓은 투명 선
          const hit = new maps.Polyline({ path, strokeWeight: 18, strokeColor: '#000000', strokeOpacity: 0.01, zIndex: 4 })
          maps.event.addListener(hit, 'click', (e: KakaoNS) => {
            if (pickRef.current.on) pickRef.current.fn?.([e.latLng.getLng(), e.latLng.getLat()])
            else selectRef.current(s.id)
          })
          const l = { main, tick, hit, shown: false }
          lines.set(s.id, l)
          return l
        }
        const show = (l: Line, s: SlopeSegment, on: boolean) => {
          if (l.shown === on) return
          l.shown = on
          l.main.setMap(on ? map : null)
          l.hit.setMap(on ? map : null)
          if (on) paint(l, s, map)
          else l.tick.setMap(null)
        }

        const refresh = () => {
          const level = map.getLevel()
          const tooFar = large && level > MAX_DRAW_LEVEL
          const hidden = hiddenRef.current
          setZoomHint(tooFar && !hidden)
          // 큰 지역을 축소해 보면 표시가 빽빽해지므로: 횡단보도는 선과 같이, 기관 이름은 한 단계 더 축소할 때까지 보인다
          for (const o of crossingMarks) o.setMap(tooFar || hidden ? null : map)
          for (const { o, main } of placeMarks) o.setMap(!large || main || level <= MAX_DRAW_LEVEL + 1 ? map : null)
          const bounds = map.getBounds()
          const sw = bounds.getSouthWest()
          const ne = bounds.getNorthEast()
          const pad = 0.002
          const [x0, y0, x1, y1] = [sw.getLng() - pad, sw.getLat() - pad, ne.getLng() + pad, ne.getLat() + pad]
          area.segments.forEach((s, i) => {
            const bb = boxes[i]
            const inView = !hidden && !tooFar && bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1
            const l = lines.get(s.id)
            if (inView) show(l ?? make(s), s, true)
            else if (l) show(l, s, false)
          })
        }
        // 확대·축소 애니메이션 동안 선 SVG 층을 감춘다: 카카오가 층을 두 장 번갈아 써서 애니메이션 중 이전 화면의 선이 뒤에 남아 보이기 때문.
        // 멈추면(idle) 새 위치로 다시 그리고 보인다
        maps.event.addListener(map, 'zoom_start', () => box.current?.setAttribute('data-zooming', ''))
        maps.event.addListener(map, 'idle', () => {
          refresh()
          box.current?.removeAttribute('data-zooming')
        })
        maps.event.addListener(map, 'click', (e: KakaoNS) => {
          if (pickRef.current.on) pickRef.current.fn?.([e.latLng.getLng(), e.latLng.getLat()])
        })

        kref.current = { kakao, map, lines, sel: [], route: [], refresh, pin: null, obs: [] }
        ro = new ResizeObserver(() => map.relayout())
        ro.observe(box.current)
        setReady(true)
        refresh()
      })
      .catch((e: Error) => {
        if (!cancelled) failRef.current(e.message)
      })
    return () => {
      cancelled = true
      ro?.disconnect()
      // 지역 데이터가 바뀌면 지도를 새로 만든다. 예전 지도를 지우지 않으면 같은 칸에 지도가 두 장 겹쳐,
      // 확대·축소 때 위 지도가 움직이는 사이 아래 지도가 비쳐 깜빡인다
      const k = kref.current
      if (k) viewRef.current = { key: area.center.name, center: k.map.getCenter(), level: k.map.getLevel() }
      kref.current = null
      el?.replaceChildren()
      // 내 위치 표시는 다음 위치 갱신 때 새 지도에 다시 만든다
      locRef.current.dot = null
      locRef.current.ring = null
      // 경로·선택 표시 등이 새 지도에 다시 그려지도록
      setReady(false)
    }
    // paint는 styleRef로 최신 값을 읽으므로 의존성에 넣지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area])

  // 경로 선 켜기/끄기 (임시: 디자인 확인용)
  useEffect(() => {
    if (ready) kref.current?.refresh()
  }, [ready, linesHidden])

  // 보기 방식·강조·조사 결과가 바뀌면 지금 만들어진 선만 다시 칠한다
  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    const byId = new Map(area.segments.map((s) => [s.id, s]))
    for (const [id, l] of k.lines) {
      const s = byId.get(id)
      if (s && l.shown) paint(l, s, k.map)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, area, mode, highlight, survey])

  // 경로: 얇은 선 + 흰 테두리. 구간 선(zIndex 2)·급경사 점(3) 위에 그려 묻히지 않게 하고,
  // 누르기용 투명 선(4)보다는 아래라 경로 위에서도 구간을 누를 수 있다. 같은 zIndex는 나중에 만든 것이 위 (일반 → 대안 → 추천 → 급경사 → 일반 경로의 막힌 곳)
  // 일반(가장 짧은 길)은 회색 점선, 조사 등급 색은 추천·대안에만. 막힌 곳은 빨강 + 말풍선으로 왜 돌아가는지 보인다
  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    for (const o of k.route) o.setMap(null)
    k.route = []
    if (!routes) return
    const { maps } = k.kakao
    const b = new maps.LatLngBounds()
    // 경로마다: 조각들을 하나의 선으로 잇고(끊김 없이) 꺾이는 곳을 둥글게 → 흰 테두리 + 실선
    for (const [lines, st] of [
      [routes.general, ROUTE_STYLE.general],
      [routes.alternative ?? [], ROUTE_STYLE.alternative],
      [routes.wheelchair, ROUTE_STYLE.wheelchair],
    ] as const) {
      for (const c of joinPaths(lines.map((s) => s.c))) {
        const path = smoothPath(c).map(([lon, lat]) => new maps.LatLng(lat, lon))
        path.forEach((p: KakaoNS) => b.extend(p))
        if (st.casing) k.route.push(new maps.Polyline({ map: k.map, path, strokeWeight: st.width + st.casing, strokeColor: '#ffffff', strokeOpacity: 0.95, zIndex: 3 }))
        k.route.push(new maps.Polyline({ map: k.map, path, strokeWeight: st.width, strokeColor: st.color, strokeOpacity: st.opacity, zIndex: 3 }))
      }
    }
    // 경사가 있는 곳만 덧칠: 가파른 편 주황 · 급경사 빨강
    for (const h of routes.highlights ?? []) {
      const st = ROUTE_HIGHLIGHT[h.level]
      const path = smoothPath(h.c).map(([lon, lat]) => new maps.LatLng(lat, lon))
      k.route.push(new maps.Polyline({ map: k.map, path, strokeWeight: st.width, strokeColor: st.color, strokeOpacity: 1, zIndex: 3 }))
    }
    for (const p of routes.raisedCrossings ?? []) {
      k.route.push(new maps.CustomOverlay({ map: k.map, position: new maps.LatLng(p[1], p[0]), content: `<div title="턱낮춤 없는 횡단보도" style="width:9px;height:9px;background:${ROUTE_CROSSING_COLOR};border:1.5px solid #334155"></div>`, zIndex: 6 }))
    }
    if (routes.blocker) {
      // 막힌 곳 말풍선: 아래 꼭지가 그 자리를 가리킨다
      const el = document.createElement('div')
      el.style.cssText = 'position:relative;transform:translate(-50%,calc(-100% - 8px));font:700 12px var(--font-sans);color:#fff;background:#f97316;border:2px solid #fff;border-radius:9999px;padding:3px 9px;box-shadow:0 1px 4px #0006;white-space:nowrap'
      el.textContent = `⚠ ${routes.blocker.label}`
      el.title = '가장 짧은 길에서 휠체어로 지나기 어려운 곳'
      const tip = document.createElement('span')
      tip.style.cssText = 'position:absolute;left:50%;bottom:-7px;width:10px;height:10px;background:#f97316;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:translateX(-50%) rotate(45deg)'
      el.append(tip)
      k.route.push(new maps.CustomOverlay({ map: k.map, position: new maps.LatLng(routes.blocker.at[1], routes.blocker.at[0]), content: el, xAnchor: 0, yAnchor: 0, zIndex: 8 }))
    }
    for (const [p, label, color] of [
      [routes.from, '출', '#1d4ed8'],
      [routes.to, '도', '#b91c1c'],
    ] as const) {
      const pos = new maps.LatLng(p.lat, p.lon)
      b.extend(pos)
      const el = document.createElement('div')
      el.style.cssText = `width:26px;height:26px;border-radius:50%;background:${color};color:#fff;border:2.5px solid #fff;box-shadow:0 1px 4px #0006;display:flex;align-items:center;justify-content:center;font:700 13px var(--font-sans)`
      el.textContent = label
      el.title = p.name
      k.route.push(new maps.CustomOverlay({ map: k.map, position: pos, content: el, zIndex: 7 }))
    }
    k.map.setBounds(b, 72, 40, 40, 40 + panelPad())
  }, [ready, area, routes])

  // 제보 위치 고르기: 커서와 고른 곳 표시
  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    k.map.setCursor(picking ? 'crosshair' : '')
    k.pin?.setMap(null)
    k.pin = null
    if (!reportPoint) return
    const el = document.createElement('div')
    el.style.cssText = 'transform:translate(-50%,-100%);font:700 12px var(--font-sans);color:#fff;background:#ea580c;border:2px solid #fff;border-radius:12px 12px 12px 0;padding:3px 7px;box-shadow:0 1px 4px #0006;white-space:nowrap'
    el.textContent = '제보 위치'
    k.pin = new k.kakao.maps.CustomOverlay({ map: k.map, position: new k.kakao.maps.LatLng(reportPoint[1], reportPoint[0]), content: el, xAnchor: 0, yAnchor: 0, zIndex: 9 })
  }, [ready, picking, reportPoint])

  // 조사원이 확인한 장애물
  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    for (const o of k.obs) o.setMap(null)
    k.obs = obstacles.map((o) => {
      const el = document.createElement('div')
      el.style.cssText = `transform:translate(-50%,-50%);font:700 11px var(--font-sans);color:#fff;background:${o.type === 'stairs' || o.type === 'steep' ? '#b91c1c' : '#b45309'};border:2px solid #fff;border-radius:9999px;padding:2px 8px;box-shadow:0 1px 3px #0006;white-space:nowrap`
      el.textContent = OBS_LABEL[o.type]
      el.title = `확인된 장애물: ${OBS_LABEL[o.type]}${o.note ? ` — ${o.note}` : ''}`
      return new k.kakao.maps.CustomOverlay({ map: k.map, position: new k.kakao.maps.LatLng(o.lat, o.lon), content: el, xAnchor: 0, yAnchor: 0, zIndex: 8 })
    })
  }, [ready, obstacles])

  // 고른 구간: 검은 테두리 + 노란 선
  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    for (const p of k.sel) p.setMap(null)
    k.sel = []
    const s = selectedId != null ? area.segments.find((x) => x.id === selectedId) : undefined
    if (!s) return
    const { maps } = k.kakao
    const path = s.c.map(([lon, lat]) => new maps.LatLng(lat, lon))
    k.sel = [
      new maps.Polyline({ map: k.map, path, strokeWeight: 12, strokeColor: '#111827', strokeOpacity: 0.85, zIndex: 5 }),
      new maps.Polyline({ map: k.map, path, strokeWeight: 3, strokeColor: '#fde047', strokeOpacity: 1, zIndex: 6 }),
    ]
  }, [ready, area, selectedId])

  // 내 위치: 브라우저 위치 권한(HTTPS 필요). 위치는 이 기기 안에서만 쓰고 서버로 보내지 않는다.
  // 폰이 가리키는 방향(나침반)이 있으면 내 위치 점에 부채꼴 화살표를 돌려 보인다 (네이버 지도처럼)
  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  })
  const stopLocate = () => {
    const L = locRef.current
    if (L.watch != null) navigator.geolocation.clearWatch(L.watch)
    L.unHeading?.()
    L.dot?.setMap(null)
    L.ring?.setMap(null)
    locRef.current = { watch: null, dot: null, ring: null, first: true, unHeading: null }
  }
  const startLocate = () => {
    const k = kref.current
    if (!k || locRef.current.watch != null) return
    if (!('geolocation' in navigator)) {
      setLocError('이 브라우저는 위치를 지원하지 않아요')
      onTracking?.(false)
      return
    }
    setLocError(null)
    const { maps } = k.kakao
    const L = locRef.current
    // 점 + 방향 부채꼴 (방향을 모르면 부채꼴은 숨김)
    const el = document.createElement('div')
    el.style.cssText = 'position:relative;width:64px;height:64px;transform:translate(-50%,-50%);pointer-events:none'
    el.innerHTML =
      '<svg data-cone width="64" height="64" viewBox="-32 -32 64 64" style="position:absolute;inset:0;opacity:0;transition:transform .15s linear"><defs><linearGradient id="cg" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2563eb" stop-opacity=".55"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs><path d="M0 0 L-15 -30 A34 34 0 0 1 15 -30 Z" fill="url(#cg)"/></svg>' +
      '<div style="position:absolute;left:24px;top:24px;width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 1px #2563eb88,0 1px 4px #0006"></div>'
    el.title = '내 위치'
    const cone = el.querySelector('[data-cone]') as SVGElement
    L.unHeading = onHeading((deg) => {
      cone.style.opacity = '1'
      cone.style.transform = `rotate(${deg}deg)`
    })
    L.watch = navigator.geolocation.watchPosition(
      (p) => {
        const pos = new maps.LatLng(p.coords.latitude, p.coords.longitude)
        if (!L.dot) {
          L.dot = new maps.CustomOverlay({ map: k.map, position: pos, content: el, xAnchor: 0, yAnchor: 0, zIndex: 8 })
          L.ring = new maps.Circle({ map: k.map, center: pos, radius: p.coords.accuracy, strokeWeight: 1, strokeColor: '#2563eb', strokeOpacity: 0.5, fillColor: '#2563eb', fillOpacity: 0.12 })
        } else {
          L.dot.setPosition(pos)
          L.ring.setPosition(pos)
          L.ring.setRadius(p.coords.accuracy)
        }
        if (L.first || followRef.current) {
          if (L.first) k.map.setLevel(Math.min(k.map.getLevel(), 3))
          L.first = false
          k.map.panTo(pos)
        }
      },
      (e) => {
        stopLocate()
        onTracking?.(false)
        setLocError(e.code === e.PERMISSION_DENIED ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요.' : '현재 위치를 가져오지 못했어요.')
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    )
  }
  useEffect(() => {
    if (!ready) return
    if (tracking) startLocate()
    else stopLocate()
    // start/stop은 ref로 상태를 다룬다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, tracking])
  useEffect(() => () => stopLocate(), [])

  useEffect(() => {
    const k = kref.current
    if (!ready || !k) return
    k.map.setMapTypeId(mapType === 'hybrid' ? k.kakao.maps.MapTypeId.HYBRID : k.kakao.maps.MapTypeId.ROADMAP)
  }, [ready, mapType])

  return (
    <div className="relative h-full w-full">
      {/* 숨김: 카카오는 선 SVG 층을 두 장 번갈아 써서, 확대·축소 애니메이션 중 숨기기 전 그림이 잠깐 보인다 → 숨김 동안 SVG 층 자체를 감춘다
          [&>div:first-child]:isolate: 카카오 지도 층(첫 칸)을 한 층으로 묶어, 그 안의 표시(기관 이름 등 z-index 3~10)가 카카오 로고·저작권 칸(z-index 1) 위로 올라가 로고를 가리지 않게 한다 (카카오 지도 API 운영정책: 로고·저작권 표시를 가리면 안 됨) */}
      <div
        ref={box}
        className="h-full w-full bg-surface [&[data-zooming]_svg]:invisible [&>div:first-child]:isolate [&_svg_path]:[stroke-linecap:round] [&_svg_path]:[stroke-linejoin:round]"
        role="application"
        aria-label={`${area.name} 경사 지도 (카카오 지도)`}
      />
      {/* 아래는 지도 위에 얹는 앱 버튼·안내 (지도 자체가 아니라 앱 화면 디자인을 따른다) */}
      {ready && (
        <div className="pointer-events-none absolute right-3 bottom-8 z-10 flex max-h-[calc(100%-3rem)] flex-col items-end gap-2 overflow-y-auto p-1">
          <div role="group" aria-label="지도 확대·축소" className="pointer-events-auto flex shrink-0 flex-col overflow-hidden rounded-full border border-line/10 bg-surface text-fg shadow-subtle">
            <button type="button" aria-label="지도 확대" onClick={() => { const k = kref.current; if (k) k.map.setLevel(Math.max(1, k.map.getLevel() - 1)) }} className="flex size-11 items-center justify-center hover:bg-tint/5 focus-visible:outline focus-visible:-outline-offset-2">
              <Plus className="size-5" strokeWidth={1.75} aria-hidden />
            </button>
            <button type="button" aria-label="지도 축소" onClick={() => { const k = kref.current; if (k) k.map.setLevel(Math.min(14, k.map.getLevel() + 1)) }} className="flex size-11 items-center justify-center border-t border-line/10 hover:bg-tint/5 focus-visible:outline focus-visible:-outline-offset-2">
              <Minus className="size-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              // 아이폰 방향 권한은 버튼 누른 처리 안에서 먼저 묻는다
              if (!tracking) void requestHeading()
              onTracking?.(!tracking)
            }}
            aria-pressed={tracking}
            aria-label={tracking ? (follow ? '안내 중 (내 위치 끄기)' : '내 위치 끄기') : '내 위치'}
            title={tracking ? '내 위치 끄기' : '내 위치'}
            className={`pointer-events-auto flex size-11 shrink-0 items-center justify-center rounded-full transition-colors ${tracking ? 'bg-ink text-on-ink shadow-float' : 'float-surface text-fg hover:text-fg-strong'}`}
          >
            <LocateFixed className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </button>
          {controls}
        </div>
      )}
      {locError && (
        <p role="alert" className="float-surface absolute right-[136px] bottom-8 z-20 max-w-[min(60%,320px)] rounded-nav px-3 py-2 text-caption text-danger">
          {locError}
        </p>
      )}
      {zoomHint && (
        <p role="status" className="float-surface pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full md:left-[calc(50%+204px)] px-4 py-2 text-caption whitespace-nowrap text-fg">
          확대하면 길마다 경사가 보여요
        </p>
      )}
    </div>
  )
}
