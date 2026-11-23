// 메인 지도의 조사원 로그인 (R-101). 계정은 관리자가 만든다 (회원가입 없음). 역할은 DB가 정하고 여기선 안내만 한다.
import { useState } from 'react'
import { adminLogin, adminLogout, type AdminSession } from '@/lib/adminApi'
import { flushQueue, loadQueue } from '@/lib/surveyApi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { Hint, PanelSection } from '@/components/ui/panel'

interface Props {
  session: AdminSession | null
  onSession: (s: AdminSession | null) => void
  /** 대기열을 보낸 뒤 (지도 다시 읽기) */
  onFlushed: () => void
}

export function SurveyorBar({ session, onSession, onFlushed }: Props) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [queued, setQueued] = useState(() => loadQueue().length)

  const login = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const s = await adminLogin(email.trim(), pw)
      setPw('')
      onSession(s)
      if (!s.role) setMsg('조사 권한이 없는 계정이에요. 관리자에게 조사원 역할을 받아 주세요.')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const flush = async () => {
    setBusy(true)
    try {
      const r = await flushQueue()
      setQueued(r.left)
      setMsg(r.left ? `${r.sent}건 보냄, ${r.left}건 남음 (신호·권한을 확인하거나 해당 구간에서 사유를 넣어 주세요)` : `${r.sent}건 모두 보냈어요`)
      onFlushed()
    } finally {
      setBusy(false)
    }
  }

  if (session) {
    const q = loadQueue().length
    return (
      <PanelSection aria-label="조사원" className="relative">
        <div className="flex items-center gap-2 text-ui">
          <span className="min-w-0 flex-1 truncate text-fg-muted">
            조사원 <b className="font-medium text-fg">{session.email}</b> {session.role ? `(${session.role === 'admin' ? '관리자' : '조사원'})` : '(권한 없음)'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              adminLogout()
              onSession(null)
            }}
          >
            로그아웃
          </Button>
        </div>
        <Hint>지도에서 구간을 누르고 ‘이 구간 조사하기’를 눌러요.</Hint>
        {(q > 0 || queued > 0) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void flush()}
            className="h-11 w-full rounded-ui border border-warn/30 bg-peach text-ui font-medium text-warn transition-colors hover:bg-warn/15 disabled:opacity-40"
          >
            대기 중 {q}건 다시 보내기
          </button>
        )}
        {msg && (
          <p role="status" className="text-caption text-fg">
            {msg}
          </p>
        )}
      </PanelSection>
    )
  }

  return (
    <PanelSection aria-label="조사원 로그인" dense={!open}>
      {!open ? (
        <Button size="sm" variant="quiet" className="-ml-3" onClick={() => setOpen(true)}>
          조사원 로그인 →
        </Button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void login()
          }}
        >
          <h2 className="text-body text-fg">조사원 로그인</h2>
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일" className="w-full" aria-label="이메일" />
          <Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" className="w-full" aria-label="비밀번호" />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" className="flex-1" disabled={busy || !email || !pw}>
              {busy ? '…' : '로그인'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              닫기
            </Button>
          </div>
          {msg && (
            <p role="alert" className="text-caption text-danger">
              {msg}
            </p>
          )}
        </form>
      )}
    </PanelSection>
  )
}
