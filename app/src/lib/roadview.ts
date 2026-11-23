// 앱 안 로드뷰 열기 신호: 어디서든 openRoadview([경도, 위도], '설명') → 화면에 하나 둔 <RoadviewHost />(components/RoadviewModal)가 받아 띄운다
import type { LonLat } from './types'

export const ROADVIEW_EVENT = 'open-roadview'

export function openRoadview(at: LonLat, title?: string) {
  window.dispatchEvent(new CustomEvent(ROADVIEW_EVENT, { detail: { at, title } }))
}
