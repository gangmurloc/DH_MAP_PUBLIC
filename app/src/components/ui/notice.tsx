// 안내·결과 메시지: 테두리 없이 파스텔 바탕(청록 안개·민트·복숭아)만으로 구분 + 뜻에 맞는 글씨 색 (글씨는 4.5:1 이상)
import * as React from 'react'
import { cx } from '@/lib/cx'

const TONE = {
  info: 'bg-mist text-fg',
  ok: 'bg-mint text-ok',
  warn: 'bg-peach text-warn',
  danger: 'bg-danger/10 text-danger',
} as const

export type NoticeTone = keyof typeof TONE

export function Notice({ tone = 'info', className, ...props }: React.ComponentProps<'p'> & { tone?: NoticeTone }) {
  return <p className={cx('rounded-nav px-4 py-3 text-ui leading-relaxed', TONE[tone], className)} {...props} />
}

/** 작은 꼬리표 (현장 확인 항목·묶음 수 등): 알약 모양은 태그에만 */
export function Chip({ tone = 'info', className, ...props }: React.ComponentProps<'span'> & { tone?: NoticeTone }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-caption font-medium', TONE[tone], className)} {...props} />
}
