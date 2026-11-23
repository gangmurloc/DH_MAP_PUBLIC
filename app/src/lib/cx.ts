/** 클래스 이어 붙이기 (빈 값은 뺀다). 충돌 정리는 하지 않으니 같은 속성 클래스를 두 번 주지 않는다. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
