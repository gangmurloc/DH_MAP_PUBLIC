// 버튼 (Seline Analytics): 모두 알약 모양
//  primary  = 파란색 알약 (상단 배경·로고와 같은 색)
//  ghost    = 옅은 회색 알약 (테두리 없이 바탕색 차이로)
//  hairline = Seline Ghost Pill: 투명 + 1px Stone Border
//  quiet    = 테두리 없음, 마우스를 올리면 칸이 드러난다 (닫기·접기)
//  danger   = 되돌리기 어려운 동작 (빨간 글씨 + 테두리)
// 클래스는 이어 붙이기만 한다: cn(tailwind-merge 방식)은 text-caption 같은 새 글자 크기 토큰을 색으로 보고 지울 수 있다.
import * as React from 'react'
import { Slot } from 'radix-ui'
import { cx } from '@/lib/cx'

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0'

const VARIANT = {
  primary: 'rounded-full bg-ink text-on-ink hover:bg-ink/90 active:shadow-pressed',
  ghost: 'rounded-full bg-tint/5 text-fg hover:bg-tint/9 active:bg-tint/12',
  hairline: 'rounded-full border border-line/12 bg-surface text-fg hover:bg-tint/4 active:bg-tint/8',
  quiet: 'rounded-full text-fg-muted hover:bg-tint/6 hover:text-fg active:bg-tint/10',
  danger: 'rounded-full border border-danger/40 text-danger hover:bg-danger/8 active:bg-danger/12',
} as const

const SIZE = {
  sm: 'h-9 px-3 text-caption',
  md: 'h-11 px-4 text-ui',
  lg: 'h-12 px-5 text-body',
  icon: 'size-11 text-body',
  'icon-sm': 'size-9 text-ui',
} as const

export type ButtonVariant = keyof typeof VARIANT
export type ButtonSize = keyof typeof SIZE

// eslint-disable-next-line react-refresh/only-export-components
export function buttonClass(variant: ButtonVariant = 'hairline', size: ButtonSize = 'md', className?: string) {
  return cx(BASE, VARIANT[variant], SIZE[size], className)
}

export function Button({
  className,
  variant = 'hairline',
  size = 'md',
  asChild = false,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize; asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="button" data-variant={variant} type={asChild ? undefined : type} className={buttonClass(variant, size, className)} {...props} />
}

/** 여럿 중 하나 고르기 (라디오): 알약. 고른 것은 옅은 파란 칸 + 파란 테두리·글씨, 나머지는 테두리만 */
// eslint-disable-next-line react-refresh/only-export-components
export function choiceClass(on: boolean, className?: string) {
  return cx(
    'inline-flex items-center justify-center rounded-full border text-ui font-medium transition-colors disabled:opacity-40',
    on ? 'border-ink bg-hl text-hl-fg' : 'border-line/12 bg-surface text-fg-muted hover:bg-tint/4 hover:text-fg',
    className,
  )
}

/** 탭 묶음 (Seline Tab Pills: 알약, 고른 탭은 먹색 채움). 바깥 틀 (간격·안쪽 여백은 쓰는 곳에서 gap-·p-로) */
// eslint-disable-next-line react-refresh/only-export-components
export const SEGMENT_TRACK = 'flex rounded-full border border-line/10 bg-surface'
/** 탭 하나 */
// eslint-disable-next-line react-refresh/only-export-components
export function segmentClass(on: boolean, className?: string) {
  return cx(
    'flex items-center justify-center rounded-full font-medium transition-colors',
    on ? 'bg-band text-white' : 'text-fg-muted hover:text-fg',
    className,
  )
}
