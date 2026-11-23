// 데이터 개방 (R-501·502): 구간·장애물 레이어 다운로드와 공개 API 안내
import { useState } from 'react'
import type { SlopeSegment } from '@/lib/slope'
import { fetchObstacleFeatures, LICENSE, obstaclesCsv, obstaclesGeoJson, saveText, segmentsCsv, segmentsGeoJson } from '@/lib/exportData'
import { buttonClass } from '@/components/ui/button'
import { Hint, PanelSection } from '@/components/ui/panel'

const day = () => new Date().toISOString().slice(0, 10)

export function DataPanel({ segments }: { segments: SlopeSegment[] }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const btn = buttonClass('hairline', 'md', 'flex-1')
  return (
    <PanelSection title="데이터 받기" aria-label="데이터 받기">
      <div>
        <p className="mb-2 text-caption text-fg-muted">구간 레이어 (경사 추정 + 현장 조사 등급)</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy} className={btn} onClick={() => void run(() => saveText(`donghae_segments_${day()}.geojson`, segmentsGeoJson(segments), 'application/geo+json'))}>
            GeoJSON
          </button>
          <button type="button" disabled={busy} className={btn} onClick={() => void run(() => saveText(`donghae_segments_${day()}.csv`, segmentsCsv(segments), 'text/csv;charset=utf-8'))}>
            CSV
          </button>
        </div>
      </div>
      <div>
        <p className="mb-2 text-caption text-fg-muted">장애물 레이어 (조사원이 확인한 계단·단차 등)</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy} className={btn} onClick={() => void run(async () => saveText(`donghae_obstacles_${day()}.geojson`, obstaclesGeoJson(await fetchObstacleFeatures()), 'application/geo+json'))}>
            GeoJSON
          </button>
          <button type="button" disabled={busy} className={btn} onClick={() => void run(async () => saveText(`donghae_obstacles_${day()}.csv`, obstaclesCsv(await fetchObstacleFeatures()), 'text/csv;charset=utf-8'))}>
            CSV
          </button>
        </div>
      </div>
      {msg && (
        <p role="alert" className="text-caption text-danger">
          {msg}
        </p>
      )}
      <Hint className="leading-relaxed">
        QGIS: GeoJSON은 끌어다 놓기, CSV는 ‘구분자로 분리된 텍스트’ 레이어(구간은 wkt 열, 장애물은 lon·lat 열, EPSG:4326). 시민 제보 원문·사진과 제보자·조사자
        정보는 넣지 않아요. 프로그램에서 쓰려면 공개 API <code className="rounded-icon bg-tint/8 px-1 text-fg">/api/features?layer=segments|obstacles</code>를 쓰세요.
      </Hint>
      <Hint className="leading-relaxed">
        출처: {LICENSE.segments} · 장애물: {LICENSE.obstacles}
      </Hint>
    </PanelSection>
  )
}
