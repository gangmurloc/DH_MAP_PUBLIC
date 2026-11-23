// 입력칸·여러 줄 입력·고르기: 흰 칸 + 옅은 1px 테두리, 포커스는 남색 2px 링.
// 한 줄 칸은 버튼과 같은 알약 모양, 여러 줄 칸은 카드와 같은 둥근 모서리 (모양을 버튼·카드 두 가지로만 통일)
// 높이·글자 크기는 fieldSize로만 바꾼다 (className으로 h-·text-를 또 주면 어느 쪽이 이길지 알 수 없다)
import * as React from 'react'
import { cx } from '@/lib/cx'

const FIELD =
  'min-w-0 border border-line/15 bg-surface text-fg outline-none transition-[border-color,box-shadow] hover:border-line/25 focus:border-azure focus:ring-2 focus:ring-azure/30 aria-[invalid=true]:border-danger disabled:opacity-40'

const SIZE = {
  sm: 'h-10 rounded-full px-3.5 text-ui',
  md: 'h-11 rounded-full px-4 text-ui',
  lg: 'h-12 rounded-full px-4 text-subheading',
} as const

type FieldSize = keyof typeof SIZE

export function Input({ className, fieldSize = 'md', ...props }: React.ComponentProps<'input'> & { fieldSize?: FieldSize }) {
  return <input className={cx(FIELD, SIZE[fieldSize], className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cx(FIELD, 'rounded-nav px-4 py-3 text-ui leading-relaxed', className)} {...props} />
}

export function Select({ className, fieldSize = 'md', ...props }: React.ComponentProps<'select'> & { fieldSize?: FieldSize }) {
  return <select className={cx(FIELD, SIZE[fieldSize], className)} {...props} />
}
