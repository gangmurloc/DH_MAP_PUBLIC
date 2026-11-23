// 앱 안 로드뷰: 카카오맵으로 넘기는 링크(map.kakao.com/link/roadview/위도,경도) 대신 카카오 지도 SDK의 로드뷰를 직접 띄운다.
// 그 링크는 휴대폰에서는 카카오가 거절(403)하고, PC에서도 카카오맵 웹이 넘겨받은 위치를 무시하고 처음 화면을 여는 경우가 있었다.
// 쓰는 법: 어디서든 openRoadview([경도, 위도], '설명') (lib/roadview) → 화면에 하나 둔 <RoadviewHost />가 받아 띄운다.
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { loadKakao } from '@/lib/kakao'
import { ROADVIEW_EVENT } from '@/lib/roadview'
import type { LonLat } from '@/lib/types'

/** 가장 가까운 로드뷰 사진을 찾는 반경 (m). 골목은 사진이 드물어 넓혀 가며 찾는다 */
const RADII = [30, 80, 150]

/** 카카오맵에서 그 위치를 지도로 여는 주소 (로드뷰가 근처에 없을 때 대신) */
const mapLink = (at: LonLat, title?: string) => `https://map.kakao.com/link/map/${encodeURIComponent(title ?? '확인할 곳')},${at[1].toFixed(6)},${at[0].toFixed(6)}`

export function RoadviewHost() {
  const [req, setReq] = useState<{ at: LonLat; title?: string } | null>(null)
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<{ at: LonLat; title?: string }>).detail)
    window.addEventListener(ROADVIEW_EVENT, on)
    return () => window.removeEventListener(ROADVIEW_EVENT, on)
  }, [])
  return req ? <RoadviewModal key={`${req.at[0]},${req.at[1]}`} at={req.at} title={req.title} onClose={() => setReq(null)} /> : null
}

function RoadviewModal({ at, title, onClose }: { at: LonLat; title?: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'none' | 'error'>('loading')
  const [dist, setDist] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    loadKakao()
      .then((kakao) => {
        if (!alive || !box.current) return
        const { maps } = kakao
        const pos = new maps.LatLng(at[1], at[0])
        const client = new maps.RoadviewClient()
        const tryRadius = (i: number) => {
          client.getNearestPanoId(pos, RADII[i], (panoId: number | null) => {
            if (!alive || !box.current) return
            if (panoId == null) {
              if (i + 1 < RADII.length) tryRadius(i + 1)
              else setState('none')
              return
            }
            const rv = new maps.Roadview(box.current)
            rv.setPanoId(panoId, pos)
            // 사진을 찍은 자리가 누른 곳과 얼마나 떨어졌는지 (안내용)
            maps.event.addListener(rv, 'init', () => {
              const p = rv.getPosition()
              const kx = 111_320 * Math.cos((at[1] * Math.PI) / 180)
              if (alive) setDist(Math.round(Math.hypot((p.getLng() - at[0]) * kx, (p.getLat() - at[1]) * 111_320)))
            })
            setState('ok')
          })
        }
        tryRadius(0)
      })
      .catch(() => alive && setState('error'))
    return () => {
      alive = false
    }
  }, [at])

  // Esc로 닫기
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  return (
    <div role="dialog" aria-modal="true" aria-label="로드뷰" className="fixed inset-0 z-[100] flex flex-col bg-black/70 p-0 md:p-8">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface md:rounded-card-lg md:shadow-float">
        <div className="flex shrink-0 items-center gap-2 border-b border-line/10 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-ui font-semibold text-fg-strong">로드뷰{title ? ` · ${title}` : ''}</h2>
            {state === 'ok' && dist != null && dist > 15 && <p className="text-caption text-fg-muted">가장 가까운 로드뷰 사진은 이곳에서 약 {dist}m 떨어진 자리에서 찍었어요.</p>}
          </div>
          <a href={mapLink(at, title)} target="_blank" rel="noreferrer" className="shrink-0 rounded-full px-3 py-1.5 text-caption font-medium text-fg-muted hover:bg-tint/6">
            카카오맵에서 보기 ↗
          </a>
          <button type="button" onClick={onClose} aria-label="로드뷰 닫기" className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-tint/6">
            <X className="size-5" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={box} className="absolute inset-0" />
          {state !== 'ok' && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-ui text-fg-muted">
              {state === 'loading' && '로드뷰를 찾는 중…'}
              {state === 'none' && `이곳 ${RADII[RADII.length - 1]}m 안에는 로드뷰 사진이 없어요. 위의 '카카오맵에서 보기'로 위치를 확인해 주세요.`}
              {state === 'error' && '카카오 지도를 불러오지 못해 로드뷰를 띄울 수 없어요.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
