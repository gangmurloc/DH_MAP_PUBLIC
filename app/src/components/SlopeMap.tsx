// 경사 지도: 수치지도 배경 그림 + 구간 선 (SVG). 외부 타일 없이 어디서나 열린다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import basemapUrl from '@/data/slope/basemap.png'
import { classify, KAKAO_MTN_STYLE, ROUTE_HIGHLIGHT, ROUTE_STYLE, ROUTE_CROSSING_COLOR, SLOPE_STYLE, type RouteOverlay, type SlopeArea, type SlopeMode } from '@/lib/slope'
import type { LonLat } from '@/lib/types'

interface Props {
  area: SlopeArea
  mode: SlopeMode
  /** 이 구간만 진하게 (나머지는 흐리게). null이면 모두 */
  highlight: Set<number> | null
  routes?: RouteOverlay | null
  linesHidden?: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
}

const K = 111_320

function distToSeg(px: number, py: number, pts: [number, number][]) {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1]
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
  }
  return best
}

const clampK = (k: number) => Math.max(0.2, Math.min(12, k))

export function SlopeMap({ area, mode, highlight, routes = null, selectedId, onSelect, linesHidden = false }: Props) {
  const toXY = useMemo(() => {
    const { lon: lon0, lat: lat0 } = area.center
    const cx = Math.cos((lat0 * Math.PI) / 180)
    return ([lon, lat]: LonLat): [number, number] => [(lon - lon0) * K * cx, -(lat - lat0) * K]
  }, [area])

  const geom = useMemo(() => {
    const segs = area.segments.map((s) => {
      const pts = s.c.map(toXY)
      return { seg: s, pts, d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('') }
    })
    const [ix0, iy0] = toXY(area.image.coords[0])
    const [ix1, iy1] = toXY(area.image.coords[2])
    return { segs, img: { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 } }
  }, [area, toXY])

  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<{ k: number; x: number; y: number } | null>(null)
  const moved = useRef(false)

  const fit = useCallback(() => {
    const r = area.view
    const k = Math.min(size.w, size.h) / (2 * r + 80)
    setView({ k, x: size.w / 2, y: size.h / 2 })
  }, [area, size])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (size.w > 0 && size.h > 0 && !moved.current) fit()
  }, [size, fit])

  // 끌기·두 손가락 확대·휠
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ moved: number; t: number; pinch?: { d: number; k: number; mx: number; my: number; vx: number; vy: number } } | null>(null)
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    svgRef.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, local(e))
    moved.current = true
    if (pointers.current.size === 1) gesture.current = { moved: 0, t: Date.now() }
    if (pointers.current.size === 2 && view) {
      const [a, b] = [...pointers.current.values()]
      gesture.current = {
        moved: 99,
        t: Date.now(),
        pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: view.x, vy: view.y },
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev || !view) return
    const p = local(e)
    pointers.current.set(e.pointerId, p)
    const g = gesture.current
    if (!g) return
    if (pointers.current.size === 1 && !g.pinch) {
      g.moved += Math.hypot(p.x - prev.x, p.y - prev.y)
      setView((v) => (v ? { ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y } : v))
    } else if (pointers.current.size === 2 && g.pinch) {
      const [a, b] = [...pointers.current.values()]
      const k = clampK(g.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.d))
      const wx = (g.pinch.mx - g.pinch.vx) / g.pinch.k
      const wy = (g.pinch.my - g.pinch.vy) / g.pinch.k
      setView({ k, x: (a.x + b.x) / 2 - wx * k, y: (a.y + b.y) / 2 - wy * k })
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) {
      if (g && !g.pinch && g.moved < 8 && Date.now() - g.t < 600 && view) {
        const p = local(e)
        const wx = (p.x - view.x) / view.k
        const wy = (p.y - view.y) / view.k
        let best: number | null = null
        let bd = 22 / view.k
        for (const s of geom.segs) {
          const d = distToSeg(wx, wy, s.pts)
          if (d < bd) {
            bd = d
            best = s.seg.id
          }
        }
        onSelect(best)
      }
      gesture.current = null
    } else if (pointers.current.size === 1 && g) {
      g.pinch = undefined
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!view) return
    moved.current = true
    const p = local(e)
    const k = clampK(view.k * Math.exp(-e.deltaY * 0.0015))
    setView({ k, x: p.x - ((p.x - view.x) / view.k) * k, y: p.y - ((p.y - view.y) / view.k) * k })
  }

  const zoomBy = (f: number) =>
    setView((v) => {
      if (!v) return v
      const k = clampK(v.k * f)
      const cx = size.w / 2
      const cy = size.h / 2
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k }
    })

  const k = view?.k ?? 1
  const inv = 1 / k
  const sel = selectedId != null ? geom.segs.find((g) => g.seg.id === selectedId) : undefined
  const ns = { vectorEffect: 'non-scaling-stroke' as const, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const [cx0, cy0] = toXY([area.center.lon, area.center.lat])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#f1efe9]">
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        role="img"
        aria-label={`${area.name} 경사 지도`}
      >
        {view && (
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <image href={basemapUrl} x={geom.img.x} y={geom.img.y} width={geom.img.w} height={geom.img.h} preserveAspectRatio="none" />
            <circle cx={cx0} cy={cy0} r={area.radius} fill="none" stroke="#334155" strokeOpacity={0.35} strokeDasharray="6 6" {...{ vectorEffect: 'non-scaling-stroke' }} />
            {routes &&
              ([
                [routes.general, ROUTE_STYLE.general],
                [routes.alternative ?? [], ROUTE_STYLE.alternative],
                [routes.wheelchair, ROUTE_STYLE.wheelchair],
                [(routes.highlights ?? []).filter((h) => h.level === 'caution').map((h) => ({ c: h.c, grade: null })), { ...ROUTE_HIGHLIGHT.caution, opacity: 1, casing: 0 }],
                [(routes.highlights ?? []).filter((h) => h.level === 'steep').map((h) => ({ c: h.c, grade: null })), { ...ROUTE_HIGHLIGHT.steep, opacity: 1, casing: 0 }],
              ] as const).map(([lines, st], i) =>
                lines.map((section, j) => (
                  <g key={`r${i}-${j}`}>
                  {st.casing > 0 && <path d={section.c.map((p, k) => { const [x, y] = toXY(p); return `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}` }).join('')} stroke="#ffffff" strokeWidth={st.width + st.casing} strokeOpacity={0.95} {...ns} />}
                  <path
                    d={section.c.map((p, k) => { const [x, y] = toXY(p); return `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}` }).join('')}
                    stroke={st.color}
                    strokeWidth={st.width}
                    strokeOpacity={st.opacity}
                    {...ns}
                  />
                  </g>
                )),
              )}
            {sel && <path d={sel.d} stroke="#111827" strokeWidth={11} strokeOpacity={0.85} {...ns} />}
            {!linesHidden && geom.segs.map((g) => {
              const c = classify(g.seg, mode)
              const st = g.seg.mtn ? { color: KAKAO_MTN_STYLE.color, width: 1.5, dash: '2 4' } : SLOPE_STYLE[c]
              const dim = highlight != null && !highlight.has(g.seg.id)
              return (
                <path
                  key={g.seg.id}
                  d={g.d}
                  stroke={st.color}
                  strokeWidth={dim ? 2 : st.width}
                  strokeOpacity={dim ? 0.25 : 1}
                  strokeDasharray={st.dash}
                  {...ns}
                />
              )
            })}
            {/* 급경사 추정: 흰 눈금을 얹어 색약에서도 구분 */}
            {!linesHidden && geom.segs
              .filter((g) => !g.seg.mtn && classify(g.seg, mode) === 'steep' && (highlight == null || highlight.has(g.seg.id)))
              .map((g) => (
                <path key={`t${g.seg.id}`} d={g.d} stroke="#fff" strokeWidth={2} strokeDasharray="2 7" {...ns} />
              ))}
            {sel && <path d={sel.d} stroke="#fde047" strokeWidth={2.5} {...ns} />}

            {(routes?.raisedCrossings ?? []).map((p, i) => {
              const [x, y] = toXY(p)
              return <g key={`route-crossing-${i}`} transform={`translate(${x} ${y}) scale(${inv})`}><rect x={-4.5} y={-4.5} width={9} height={9} fill={ROUTE_CROSSING_COLOR} stroke="#334155" strokeWidth={1.5} /></g>
            })}
            {!linesHidden && area.crossings.map((c, i) => {
              const [x, y] = toXY([c.lon, c.lat])
              return (
                <g key={`c${i}`} transform={`translate(${x} ${y}) scale(${inv})`}>
                  <rect x={-4} y={-4} width={8} height={8} fill={c.kerb === 'raised' ? '#dc2626' : '#fff'} stroke="#334155" strokeWidth={1.2} />
                </g>
              )
            })}

            {area.places.map((p) => {
              const [x, y] = toXY([p.lon, p.lat])
              const main = p.name === area.center.name
              return (
                <g key={p.name} transform={`translate(${x} ${y}) scale(${inv})`}>
                  <circle r={main ? 9 : 5} fill={main ? '#1d4ed8' : '#7c3aed'} stroke="#fff" strokeWidth={2} />
                  <text x={main ? 13 : 8} y={4} fontSize={main ? 13 : 11} fontWeight={main ? 700 : 500} fill="#111827" stroke="#fff" strokeWidth={3.5} paintOrder="stroke">
                    {p.name}
                  </text>
                </g>
              )
            })}
            {routes &&
              ([
                [routes.from, '출', '#1d4ed8'],
                [routes.to, '도', '#b91c1c'],
              ] as const).map(([p, label, color]) => {
                const [x, y] = toXY([p.lon, p.lat])
                return (
                  <g key={label} transform={`translate(${x} ${y}) scale(${inv})`}>
                    <circle r={12} fill={color} stroke="#fff" strokeWidth={2.5} />
                    <text textAnchor="middle" y={4.5} fontSize={12} fontWeight={700} fill="#fff">
                      {label}
                    </text>
                  </g>
                )
              })}
          </g>
        )}
      </svg>

      <div className="absolute top-4 right-4 flex flex-col gap-2">
        <MapButton label="확대" onClick={() => zoomBy(1.6)}>+</MapButton>
        <MapButton label="축소" onClick={() => zoomBy(1 / 1.6)}>−</MapButton>
        <MapButton
          label="전체 보기"
          onClick={() => {
            moved.current = false
            fit()
          }}
        >
          ⤢
        </MapButton>
      </div>
      <ScaleBar k={k} />
    </div>
  )
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="float-surface flex size-11 items-center justify-center rounded-ui border border-line/15 text-subheading text-fg transition-colors hover:text-fg-strong active:bg-tint/10"
    >
      {children}
    </button>
  )
}

function ScaleBar({ k }: { k: number }) {
  const target = 90 / k
  const nice = [10, 20, 50, 100, 200, 500, 1000].find((v) => v >= target * 0.6) ?? 1000
  return (
    <div className="float-surface pointer-events-none absolute bottom-3 left-3 rounded-ui border border-line/15 px-2 py-1 text-caption text-fg">
      <div className="border-x-2 border-b-2 border-fg" style={{ width: nice * k, height: 6 }} />
      {nice >= 1000 ? `${nice / 1000}km` : `${nice}m`}
    </div>
  )
}
