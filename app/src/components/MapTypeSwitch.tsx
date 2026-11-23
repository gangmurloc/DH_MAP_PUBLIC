export type MapType = 'roadmap' | 'hybrid'

export function MapTypeSwitch({ value, onChange, disabled = false }: { value: MapType; onChange: (type: MapType) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="지도 종류" className="pointer-events-auto inline-flex shrink-0 overflow-hidden rounded-nav border border-line/20 bg-surface p-1 shadow-subtle">
      {(['roadmap', 'hybrid'] as const).map((type) => (
        <button key={type} type="button" disabled={disabled} aria-pressed={value === type} onClick={() => onChange(type)} className={`relative h-9 px-3 text-ui font-semibold transition-colors disabled:opacity-40 ${type === 'hybrid' ? 'border-l border-line/15' : ''} ${value === type ? 'text-[#2455ae] after:absolute after:right-2 after:bottom-0 after:left-2 after:h-0.5 after:rounded-full after:bg-[#2455ae]' : 'text-fg hover:bg-tint/5'}`}>
          {type === 'roadmap' ? '지도' : '스카이뷰'}
        </button>
      ))}
    </div>
  )
}
