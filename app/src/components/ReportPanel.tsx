// 길 상태 제보 (시민 확인 요청): 단차(턱)·계단·기타 장애물. 지도에 바로 올라가지 않고 조사원 점검 목록으로 간다 (HANDOFF 3절)
import { useState } from 'react'
import { REPORT_LABEL, submitReport, type ReportType } from '@/lib/reports'
import type { LonLat } from '@/lib/types'
import { Button, choiceClass } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { Hint, PanelSection } from '@/components/ui/panel'

export interface ReportPoint {
  at: LonLat
  source: 'gps' | 'manual'
  accuracyM: number | null
}

/** 길 안내의 '이 구간 확인 요청'이 미리 채우는 값. 바뀔 때마다 SlopeApp이 key로 이 칸을 새로 그린다 */
export interface ReportPreset {
  type: ReportType
  text: string
}

interface Props {
  point: ReportPoint | null
  onPoint: (p: ReportPoint | null) => void
  picking: boolean
  onPicking: (on: boolean) => void
  /** 지도에서 고르기를 쓸 수 있는가 (카카오 지도일 때) */
  canPick: boolean
  /** 있으면 열린 채로 종류·메모를 채워 시작한다 (보내기·동의는 사용자가 직접) */
  preset?: ReportPreset | null
  /** 있으면 (제보 탭 안에 놓일 때) 처음부터 열어 두고, 닫기는 접지 않고 이것을 부른다 */
  onClose?: () => void
}

const TYPES: ReportType[] = ['kerb', 'stairs', 'other']

export function ReportPanel({ point, onPoint, picking, onPicking, canPick, preset = null, onClose }: Props) {
  const [open, setOpen] = useState(preset != null || onClose != null)
  const [type, setType] = useState<ReportType>(preset?.type ?? 'kerb')
  const [measured, setMeasured] = useState('')
  const [text, setText] = useState(preset?.text ?? '')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const gps = () => {
    if (!('geolocation' in navigator)) return setMsg({ ok: false, text: '이 브라우저는 위치를 지원하지 않아요. 지도에서 골라 주세요.' })
    setMsg(null)
    navigator.geolocation.getCurrentPosition(
      (p) => onPoint({ at: [p.coords.longitude, p.coords.latitude], source: 'gps', accuracyM: Math.round(p.coords.accuracy) }),
      () => setMsg({ ok: false, text: '현재 위치를 가져오지 못했어요. 지도에서 골라 주세요.' }),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const unit = type === 'kerb' ? 'cm' : null
  const needText = type === 'other' && text.trim() === ''
  const value = measured.trim() === '' ? null : Number(measured)
  const valueBad = value != null && (!Number.isFinite(value) || value < 0 || value > 100)

  const submit = async () => {
    if (!point || !agree || valueBad || needText) return
    setBusy(true)
    setMsg(null)
    try {
      await submitReport({ type, at: point.at, locSource: point.source, accuracyM: point.accuracyM, measured: unit ? value : null, text })
      setMsg({ ok: true, text: '제보가 접수됐어요. 조사원이 현장에서 확인한 뒤 지도와 길 안내에 반영돼요.' })
      setMeasured('')
      setText('')
      onPoint(null)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <PanelSection>
        <Button variant="ghost" className="w-full" onClick={() => setOpen(true)}>
          길 상태 제보하기 (단차·계단·기타 장애물)
        </Button>
      </PanelSection>
    )
  }

  return (
    <PanelSection
      title="길 상태 제보"
      aria-label="길 상태 제보"
      action={
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            if (onClose) onClose()
            else setOpen(false)
            onPicking(false)
            onPoint(null)
          }}
        >
          닫기
        </Button>
      }
    >
      <div className="flex gap-2" role="radiogroup" aria-label="종류">
        {TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={choiceClass(type === t, 'min-h-11 flex-1 px-1')}>
            {REPORT_LABEL[t]}
          </button>
        ))}
      </div>

      {unit && (
        <label className="flex items-center gap-3 text-ui">
          <span className="w-28 shrink-0 text-fg-muted">단차 높이 (선택)</span>
          <Input inputMode="decimal" value={measured} onChange={(e) => setMeasured(e.target.value)} placeholder="예: 5" className="w-20" aria-invalid={valueBad} />
          <span className="text-fg-muted">{unit}</span>
        </label>
      )}
      {valueBad && <p className="text-caption text-danger">값을 확인해 주세요.</p>}

      <div className="space-y-2">
        <p className="text-ui text-fg-muted">위치</p>
        <div className="flex gap-2">
          <Button variant="hairline" className="flex-1" onClick={gps}>
            ◎ 지금 내 위치
          </Button>
          {canPick && (
            <button type="button" onClick={() => onPicking(!picking)} aria-pressed={picking} className={choiceClass(picking, 'h-11 flex-1')}>
              {picking ? '지도를 눌러 주세요' : '지도에서 고르기'}
            </button>
          )}
        </div>
        <Hint>
          {point
            ? `${point.source === 'gps' ? '내 위치' : '지도에서 고른 곳'} ${point.at[1].toFixed(5)}, ${point.at[0].toFixed(5)}${point.accuracyM ? ` (오차 약 ${point.accuracyM}m)` : ''}`
            : '아직 위치를 고르지 않았어요'}
        </Hint>
      </div>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder={type === 'other' ? '무엇이 길을 막나요? (필수) 예) 공사 자재, 불법 주차, 볼라드 간격이 좁음' : '메모 (선택): 예) 편의점 앞 보도 단차가 높아요'}
        aria-required={type === 'other'}
        className="w-full"
      />

      <label className="flex items-start gap-2.5 text-caption leading-relaxed text-fg-muted">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
        제보한 위치·종류·메모를 확인 요청으로 보내고, 확인된 내용이 공공 데이터로 공개되는 데 동의해요. (제보자 정보는 공개하지 않아요)
      </label>

      <Button variant="primary" className="w-full" onClick={submit} disabled={busy || !point || !agree || valueBad || needText}>
        {busy ? '보내는 중…' : '확인 요청 보내기'}
      </Button>
      {msg && (
        <Notice role="status" tone={msg.ok ? 'ok' : 'danger'}>
          {msg.text}
        </Notice>
      )}
    </PanelSection>
  )
}
