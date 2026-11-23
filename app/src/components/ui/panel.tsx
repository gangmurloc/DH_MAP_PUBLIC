// 옆 패널(휴대폰은 아래 시트)의 한 묶음: 묶음 사이는 선 대신 여백으로 나눈다.
// 제목은 Wanted Sans 700 17px. 여백·간격은 prop으로만 바꾼다 (className으로 py·space-y를 또 주면 어느 쪽이 이길지 알 수 없다)
import * as React from 'react'
import { cx } from '@/lib/cx'

export function PanelSection({
  title,
  action,
  dense = false,
  gap = 'normal',
  className,
  children,
  ...props
}: React.ComponentProps<'section'> & { title?: React.ReactNode; action?: React.ReactNode; dense?: boolean; gap?: 'normal' | 'loose' }) {
  return (
    <section className={cx('px-5', dense ? 'py-2' : 'py-5', gap === 'loose' ? 'space-y-4' : 'space-y-3', className)} {...props}>
      {(title || action) && (
        <div className="flex min-h-9 items-center gap-2">
          {title && <h2 className="flex-1 text-title text-fg-strong">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** 보조 설명 (13px, 보조 글씨색) */
export function Hint({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cx('text-caption leading-relaxed text-fg-muted', className)} {...props} />
}
