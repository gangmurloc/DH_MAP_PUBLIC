// 폰이 가리키는 방향(나침반, 북쪽 0°·시계 방향). 지도에서 내 위치 화살표를 돌리는 데 쓴다.
// 아이폰은 버튼을 누른 처리 안에서 requestPermission을 불러야 한다 (HANDOFF 9절). 안드로이드는 deviceorientationabsolute.
type Listener = (deg: number) => void
const listeners = new Set<Listener>()
let started = false
let last: number | null = null

interface OrientationLike {
  alpha: number | null
  absolute?: boolean
  webkitCompassHeading?: number
}

function handle(e: OrientationLike) {
  let h: number | null = null
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading // 아이폰: 이미 나침반 방향
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha // 안드로이드 절대 방향
  if (h == null) return
  const screenAngle = (screen.orientation?.angle ?? 0) as number
  h = (((h + screenAngle) % 360) + 360) % 360
  last = h
  listeners.forEach((f) => f(h!))
}

function start() {
  if (started) return
  started = true
  const w = window as unknown as { ondeviceorientationabsolute?: unknown }
  if ('ondeviceorientationabsolute' in w) window.addEventListener('deviceorientationabsolute', handle as unknown as EventListener, true)
  else window.addEventListener('deviceorientation', handle as unknown as EventListener, true)
}

/** 버튼 클릭 처리 안에서 먼저 부른다 (아이폰 권한 창). 허용되면 true */
export async function requestHeading(): Promise<boolean> {
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent
  if (!DOE) return false
  if (typeof DOE.requestPermission === 'function') {
    try {
      if ((await DOE.requestPermission()) !== 'granted') return false
    } catch {
      return false
    }
  }
  start()
  return true
}

export function onHeading(cb: Listener): () => void {
  listeners.add(cb)
  if (last != null) cb(last)
  return () => {
    listeners.delete(cb)
  }
}
