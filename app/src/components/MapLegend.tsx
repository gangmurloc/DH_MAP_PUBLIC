import { useState } from 'react'
import { ChevronDown, Layers } from 'lucide-react'
import { ADMIN_PATH_COLOR, ESTIMATE_CLASSES, KAKAO_MTN_STYLE, SLOPE_LABEL, SLOPE_SHORT, SLOPE_STYLE, SURVEY_CLASSES, type SlopeClass } from '@/lib/slope'

function LineSample({ grade, color, width = 4, dash }: { grade?: SlopeClass; color?: string; width?: number; dash?: string }) {
  const style = grade ? SLOPE_STYLE[grade] : { color, width, dash }
  return (
    <svg width="34" height="12" className="shrink-0" aria-hidden>
      <line x1="3" y1="6" x2="31" y2="6" stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" />
      {grade === 'steep' && <line x1="3" y1="6" x2="31" y2="6" stroke="#fff" strokeWidth="2" strokeDasharray="2 7" />}
    </svg>
  )
}

/** 공개 지도와 관리자 지도의 범례를 한곳에서 관리한다. */
export function MapLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-3 text-caption' : 'space-y-4 text-ui'}>
      <ul className={compact ? 'space-y-2.5' : 'space-y-4'} aria-label="지도 선 범례">
        {ESTIMATE_CLASSES.map((grade) => (
          <li key={grade} className="flex items-center gap-3">
            <LineSample grade={grade} />
            <span>{compact ? SLOPE_SHORT[grade] : SLOPE_LABEL[grade]}</span>
          </li>
        ))}
        <li className="flex items-center gap-3"><LineSample grade="passable" /><span>현장 조사 완료 (굵은 선)</span></li>
        <li className="flex items-center gap-3"><LineSample color={ADMIN_PATH_COLOR} width={6} /><span>관리자 추가 길</span></li>
      </ul>
      {!compact && (
        <>
          <ul className="space-y-3 border-t border-line/10 pt-4" aria-label="현장 조사 등급">
            {SURVEY_CLASSES.map((grade) => <li key={grade} className="flex items-center gap-3"><LineSample grade={grade} /><span>{SLOPE_LABEL[grade]}</span></li>)}
          </ul>
          <div className="flex items-center gap-3"><LineSample color={KAKAO_MTN_STYLE.color} width={2} dash="2 4" /><span>산길 추정 (길 안내에서 뺌)</span></div>
          <div className="flex items-center gap-3"><span className="flex w-[34px] shrink-0 justify-center" aria-hidden><span className="size-2.5 border border-slate-600 bg-red-600" /></span><span>턱낮춤 없는 횡단보도</span></div>
        </>
      )}
      <p className="border-t border-line/10 pt-3 text-caption text-fg-muted">선이 없는 흰색 길 = 데이터가 없는 길</p>
    </div>
  )
}

export function FloatingMapLegend({ status }: { status?: string }) {
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  return (
    <section aria-label="지도 범례" className="absolute top-3 right-3 z-10 w-[230px] max-w-[calc(100%-1.5rem)] rounded-card border border-line/10 bg-surface text-fg shadow-subtle">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-11 w-full items-center gap-2 rounded-card px-3.5 text-ui font-semibold">
        <Layers className="size-4" strokeWidth={1.75} aria-hidden />범례
        <ChevronDown className={`ml-auto size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && <div className="max-h-[min(45dvh,400px)] overflow-y-auto px-3.5 pb-3.5">{status && <p role="status" className="mb-3 text-caption text-fg-muted">{status}</p>}<MapLegend compact /></div>}
    </section>
  )
}
