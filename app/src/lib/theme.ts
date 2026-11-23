// 화면 테마: light / dark / system. <html>에 .dark를 붙였다 떼고, 브라우저 위쪽 색(theme-color)도 맞춘다.
// 고른 값은 이 브라우저에만 기억한다 (못 쓰면 system). 처음 그리기 전에는 index.html의 작은 스크립트가 같은 일을 먼저 한다.
import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'dhmap-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
/** 페이지 바탕색과 같게 (index.css --color-canvas) */
const META_COLOR = { light: '#fafaf9', dark: '#111214' }

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // 저장소를 못 쓰면 기기 설정을 따른다
  }
  return 'system'
}

function systemDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? META_COLOR.dark : META_COLOR.light)
}

/** 지금 고른 테마와 바꾸는 함수. system이면 기기 설정이 바뀔 때 바로 따라간다 */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme)
  useEffect(() => {
    applyTheme(choice)
    if (choice !== 'system') return
    let mq: MediaQueryList
    try {
      mq = window.matchMedia(DARK_QUERY)
    } catch {
      return
    }
    const on = () => applyTheme('system')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [choice])
  const set = (t: ThemeChoice) => {
    setChoice(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // 저장 못 해도 이번 화면에서는 바뀐다
    }
  }
  return [choice, set]
}
