// 테마 전환: 밝게 / 어둡게 / 시스템.
//  넓은 화면: 알약 탭 묶음 3칸 (Seline Tab Pills)
//  responsive면 휴대폰에서는 44px 버튼 하나로 줄여 차례로 바꾼다 (위쪽 공간 아끼기, 누르기 쉬운 크기)
//  band면 패널 머리띠(위쪽이 밝은 흰→빨강 그라데이션) 위에 놓는 먹색 아이콘 둥근 버튼 하나 (누를 때마다 차례로)
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemeChoice } from '@/lib/theme'
import { SEGMENT_TRACK, segmentClass } from '@/components/ui/button'

const ITEMS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: '밝게', Icon: Sun },
  { value: 'dark', label: '어둡게', Icon: Moon },
  { value: 'system', label: '기기 설정 따르기', Icon: Monitor },
]

export function ThemeToggle({ responsive = false, band = false }: { responsive?: boolean; band?: boolean }) {
  const [choice, setChoice] = useTheme()
  const i = ITEMS.findIndex((x) => x.value === choice)
  const Cur = ITEMS[i].Icon
  const next = ITEMS[(i + 1) % ITEMS.length]
  const cycle = (className: string) => (
    <button
      type="button"
      onClick={() => setChoice(next.value)}
      aria-label={`화면 테마: ${ITEMS[i].label} (누르면 ${next.label})`}
      title={`화면 테마: ${ITEMS[i].label}`}
      className={`flex shrink-0 items-center justify-center rounded-full transition-colors ${className}`}
    >
      <Cur className="size-5" strokeWidth={1.75} aria-hidden />
    </button>
  )
  if (band) return cycle('size-11 text-[#1c1917] hover:bg-black/6 md:size-10')
  return (
    <>
      <div className={`${SEGMENT_TRACK} shrink-0 gap-0.5 p-0.5 ${responsive ? 'hidden md:flex' : ''}`} role="radiogroup" aria-label="화면 테마">
        {ITEMS.map(({ value, label, Icon }) => (
          <button key={value} type="button" role="radio" aria-checked={choice === value} aria-label={label} title={label} onClick={() => setChoice(value)} className={segmentClass(choice === value, 'size-8')}>
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
        ))}
      </div>
      {responsive && cycle('size-11 text-fg hover:bg-tint/6 md:hidden')}
    </>
  )
}
