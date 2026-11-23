// 팀 표시 (경사났네): 바다(동해) 위로 떠오르는 해. 해 아래쪽은 물결 모양으로 잘리고, 그 아래 활 모양 바다.
// 해 = 팀 이름 빨강(#a8494d), 바다 = 시안의 파란색(#2455ae).
// 모든 모드에서 같은 색을 쓴다. 같은 모양·색이 public/favicon.svg에도 있다.
import { useId } from 'react'

export function TeamMark() {
  const clip = useId()
  return (
    <svg viewBox="0 0 48 40" className="h-9 w-[43px] shrink-0" aria-hidden>
      <defs>
        <clipPath id={clip}>
          {/* 물결 아랫단: 오른쪽 끝(48,25)에서 왼쪽으로 6px마다 물결 하나 */}
          <path d="M0 0H48V25q-3 2.4-6 0t-6 0t-6 0t-6 0t-6 0t-6 0t-6 0t-6 0Z" />
        </clipPath>
      </defs>
      <circle cx="24" cy="17" r="15" fill="#a8494d" clipPath={`url(#${clip})`} />
      <path d="M3 35Q24 22 45 35Q24 31 3 35Z" fill="#2455ae" />
    </svg>
  )
}
