// 메인 지도에서 구간 조사 (R-103·104·106): 디지털 수평계로 잰 경사·장애물 입력 → 제안 등급 → 측정만 저장 / 조사 완료.
// 저장은 DB 함수로 (surveyApi.ts). 제안 등급은 앱이 미리 보여 주고, 완료할 때 DB 제안으로 한 번 더 확인한다.
import { useState } from 'react'
import { suggestGrade } from '@/lib/grade'
import type { SlopeSegment } from '@/lib/slope'
import {
  KERB_MAX_CM, NeedReasonError, newSubmission, resendWithReason, send, WIDTH_MIN_CM,
  type SurveyGrade, type SurveyObstacle, type SurveyObstacleType, type SurveySubmission,
} from '@/lib/surveyApi'
import { GRADE_LABEL, type Segment } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { Hint, PanelSection } from '@/components/ui/panel'

const OB_LABEL: Record<SurveyObstacleType, string> = { kerb: '단차(턱)', narrow: '좁은 길', stairs: '계단', damaged: '파손', steep: '급경사' }

// 고른 등급은 등급 색으로 채우고 흰 글씨 (기능 색)
const GRADE_BTN: Record<SurveyGrade, string> = {
  passable: 'border-ok bg-ok text-on-ink',
  caution: 'border-warn bg-warn text-on-ink',
  difficult: 'border-danger bg-danger text-on-ink',
}

function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** 경사 지도 구간 → 등급 제안 규칙(grade.ts)이 쓰는 모양 */
function toSegment(s: SlopeSegment): Segment {
  return {
    id: s.id, s: s.s, t: s.t, c: s.c, len: s.len, cls: s.cls, name: s.name, w: s.w, sw: s.sw, swW: s.swW,
    bridge: s.bridge, stairs: false, tunnel: s.tunnel,
    underpass: s.check.includes('underpass_no_sidewalk'),
    overpass: s.check.includes('overpass_inaccessible') ? 'inaccessible' : null,
    demMax: s.max, demEst: s.est, check: s.check,
  }
}

interface Props {
  seg: SlopeSegment
  onClose: () => void
  /** 저장이 끝나면 (지도·길 안내 다시 읽기) */
  onSaved: () => void
}

export function SurveyPanel({ seg, onClose, onSaved }: Props) {
  const [incline, setIncline] = useState(seg.survey?.incline != null ? String(seg.survey.incline) : '')
  const [cross, setCross] = useState('')
  const [obstacles, setObstacles] = useState<(SurveyObstacle & { id: number })[]>([])
  const [grade, setGrade] = useState<SurveyGrade | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, setPending] = useState<SurveySubmission | null>(null)

  const inc = parseNum(incline)
  const crs = parseNum(cross)
  const sug = suggestGrade(toSegment(seg), {
    segId: seg.id, incline: inc, cross: crs, grade: null, reason: '', done: false, memo: '', updatedAt: '',
    obstacles: obstacles.map((o) => ({ id: String(o.id), type: o.type, kerbCm: o.kerbCm, widthCm: o.widthCm })),
  })
  const chosen = grade ?? sug.grade
  const needsReason = chosen !== sug.grade

  const validate = (): string | null => {
    if (inc != null && (inc < 0 || inc > 60)) return '경사는 0~60% 사이로 적어 주세요'
    if (crs != null && (crs < 0 || crs > 30)) return '횡경사는 0~30% 사이로 적어 주세요'
    for (const o of obstacles) {
      if (o.type === 'kerb' && (o.kerbCm == null || o.kerbCm < 0 || o.kerbCm > 100)) return '단차 높이(0~100cm)를 적어 주세요 (법 기준 2cm 판정에 필요)'
      if (o.type === 'narrow' && (o.widthCm == null || o.widthCm <= 0 || o.widthCm > 1000)) return '폭(cm)을 적어 주세요 (법 기준 1.2m 판정에 필요)'
    }
    return null
  }

  const submit = async (done: boolean) => {
    const v = validate()
    if (v) return setMsg({ ok: false, text: v })
    if (!done && inc == null && crs == null && !obstacles.length) return setMsg({ ok: false, text: '저장할 측정값이나 장애물이 없어요' })
    if (done && needsReason && !reason.trim()) return setMsg({ ok: false, text: `제안(${GRADE_LABEL[sug.grade]})과 다르게 정하려면 사유를 적어 주세요` })
    const mid = seg.c[Math.floor(seg.c.length / 2)]
    const sub = newSubmission({
      segId: seg.id, at: mid, incline: inc, cross: crs,
      obstacles: obstacles.map(({ type, kerbCm, widthCm }) => ({ type, kerbCm, widthCm })),
      grade: done ? chosen : null, reason: done && needsReason ? reason.trim() : '',
    })
    await run(() => send(sub), sub, done)
  }

  const run = async (fn: () => Promise<void>, sub: SurveySubmission, done: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      setPending(null)
      setMsg({ ok: true, text: done ? '조사 완료했어요. 지도와 길 안내에 바로 반영돼요.' : '측정값을 저장했어요.' })
      onSaved()
    } catch (e) {
      if (e instanceof NeedReasonError) {
        // 측정값은 이미 저장됨. 사유를 받아 완료만 다시 보낸다
        setPending(sub)
        setMsg({ ok: false, text: `측정값은 저장했어요. DB 제안 등급은 '${GRADE_LABEL[e.suggested]}'예요. 다르게 정하려면 사유를 적고 다시 보내 주세요.` })
      } else {
        setMsg({ ok: false, text: `보내지 못했어요 (${(e as Error).message}). 이 기기에 저장해 두었으니 '대기 중 다시 보내기'로 보낼 수 있어요.` })
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const add = (type: SurveyObstacleType) => setObstacles((l) => [...l, { id: Date.now() + l.length, type, kerbCm: null, widthCm: null }])
  const patch = (id: number, p: Partial<SurveyObstacle>) => setObstacles((l) => l.map((o) => (o.id === id ? { ...o, ...p } : o)))

  return (
    <PanelSection aria-label="구간 조사" gap="loose">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-subheading text-fg-strong">구간 {seg.id} 조사</h2>
          <Hint>
            {seg.name ?? seg.cls ?? '이름 없는 길'} · {Math.round(seg.len)}m · 추정 최대 경사 {seg.max != null ? `${seg.max.toFixed(1)}%` : '—'}
          </Hint>
        </div>
        <Button size="icon-sm" variant="quiet" onClick={onClose} aria-label="조사 닫기">
          ✕
        </Button>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-ui font-medium text-fg">경사 (디지털 수평계, 구간에서 가장 가파른 곳)</legend>
        <label className="flex items-center gap-3 text-ui text-fg-muted">
          <span className="w-24 shrink-0">진행 방향</span>
          <Input inputMode="decimal" value={incline} onChange={(e) => setIncline(e.target.value)} placeholder="예: 6.5" fieldSize="lg" className="w-28 tabular-nums" aria-label="진행 방향 경사 퍼센트" />
          <span className="text-fg">%</span>
        </label>
        <label className="flex items-center gap-3 text-ui text-fg-muted">
          <span className="w-24 shrink-0">횡경사(참고)</span>
          <Input inputMode="decimal" value={cross} onChange={(e) => setCross(e.target.value)} className="w-24 tabular-nums" aria-label="횡경사 퍼센트" />
          <span className="text-fg">%</span>
        </label>
        <Hint>오르막·내리막 구분 없이 크기만 적어요. 길 안내는 양쪽 방향 모두 이 값으로 계산해요.</Hint>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-ui font-medium text-fg">장애물</legend>
        {obstacles.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-ui border border-line/10 bg-tint/3 p-2.5 text-ui">
            <span className="font-medium text-fg">{OB_LABEL[o.type]}</span>
            {o.type === 'kerb' && (
              <label className="flex flex-wrap items-center gap-1.5 text-fg-muted">
                높이
                <Input inputMode="decimal" fieldSize="sm" className="w-16" value={o.kerbCm ?? ''} aria-label="단차 높이 cm" onChange={(e) => patch(o.id, { kerbCm: parseNum(e.target.value) })} />
                cm
                {o.kerbCm != null && <span className={`text-caption ${o.kerbCm > KERB_MAX_CM ? 'text-danger' : 'text-ok'}`}>{o.kerbCm > KERB_MAX_CM ? '법 기준 초과 → 길 안내에서 뺌' : '법 기준 안 (측정값으로만 기록)'}</span>}
              </label>
            )}
            {o.type === 'narrow' && (
              <label className="flex flex-wrap items-center gap-1.5 text-fg-muted">
                폭
                <Input inputMode="decimal" fieldSize="sm" className="w-16" value={o.widthCm ?? ''} aria-label="폭 cm" onChange={(e) => patch(o.id, { widthCm: parseNum(e.target.value) })} />
                cm
                {o.widthCm != null && <span className={`text-caption ${o.widthCm < WIDTH_MIN_CM ? 'text-danger' : 'text-ok'}`}>{o.widthCm < WIDTH_MIN_CM ? '법 기준 미달 → 길 안내에서 뺌' : '법 기준 안 (측정값으로만 기록)'}</span>}
              </label>
            )}
            <Button size="sm" variant="danger" className="ml-auto" onClick={() => setObstacles((l) => l.filter((x) => x.id !== o.id))}>
              삭제
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(OB_LABEL) as SurveyObstacleType[]).map((t) => (
            <Button key={t} variant="ghost" onClick={() => add(t)}>
              + {OB_LABEL[t]}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="glass rounded-card border border-line/10 p-4">
        <p className="text-ui text-fg-muted">
          제안 등급 <b className="ml-1 font-medium text-fg-strong">{GRADE_LABEL[sug.grade]}</b>
        </p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-caption text-fg-muted">
          {sug.reasons.map((r, i) => (
            <li key={i}>{r.label}</li>
          ))}
        </ul>
        <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="조사 등급">
          {(['passable', 'caution', 'difficult'] as SurveyGrade[]).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={chosen === g}
              onClick={() => setGrade(g === sug.grade ? null : g)}
              className={`h-14 rounded-ui border text-ui font-medium transition-colors ${chosen === g ? GRADE_BTN[g] : 'border-line/22 text-fg-muted hover:bg-tint/8 hover:text-fg'}`}
            >
              {GRADE_LABEL[g]}
              {g === sug.grade && <span className="block text-caption font-normal opacity-80">제안</span>}
            </button>
          ))}
        </div>
        {(needsReason || pending) && <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="제안과 다르게 정한 사유 (필수)" className="mt-3 w-full" aria-label="등급 변경 사유" />}
      </div>

      {msg && (
        <Notice role={msg.ok ? 'status' : 'alert'} tone={msg.ok ? 'ok' : 'danger'}>
          {msg.text}
        </Notice>
      )}

      <div className="flex flex-col gap-2">
        {pending ? (
          <Button size="lg" variant="primary" disabled={busy || !reason.trim()} onClick={() => void run(() => resendWithReason(pending, reason), pending, true)}>
            사유 넣고 조사 완료 다시 보내기
          </Button>
        ) : (
          <>
            <Button size="lg" variant="primary" disabled={busy} onClick={() => void submit(true)}>
              {busy ? '보내는 중…' : '조사 완료'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void submit(false)}>
              측정만 저장
            </Button>
          </>
        )}
      </div>
      <Hint>같은 구간을 다시 재면 측정값이 덧붙고(덮어쓰지 않음), 길 안내는 가장 가파른 측정값을 써요.</Hint>
    </PanelSection>
  )
}
