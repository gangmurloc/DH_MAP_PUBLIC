// 지역 데이터는 앱 첫 화면 코드에 넣지 않고 그 주소를 열 때 받는다.
// 동해시 전체(약 12MB, 압축 약 2MB)는 public/data에서, 청소년센터 주변은 별도 조각으로.
import { useEffect, useState } from 'react'
import SlopeApp from '@/SlopeApp'
import type { SlopeArea } from '@/lib/slope'

// eslint-disable-next-line react-refresh/only-export-components
export async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`데이터를 받지 못했어요 (${r.status})`)
  return r.json()
}

export default function AreaLoader({ load }: { load: () => Promise<unknown> }) {
  const [area, setArea] = useState<SlopeArea | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    load()
      .then((d) => !cancelled && setArea(d as SlopeArea))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
    // 주소마다 한 번만 받는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (area) return <SlopeApp area={area} />
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-6 text-center text-ui text-fg-muted" role="status">
      {error ?? '길 데이터를 불러오는 중…'}
    </div>
  )
}
