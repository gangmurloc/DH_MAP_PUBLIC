// 길 안내 공용 도구: 두 점 사이 거리, 다익스트라용 최소 힙 (slopeRoute.ts가 쓴다)

export function metersBetween(a: [number, number], b: [number, number]): number {
  const k = 111_320
  const dx = (a[0] - b[0]) * k * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180))
  const dy = (a[1] - b[1]) * k
  return Math.hypot(dx, dy)
}

export class MinHeap {
  private a: [number, number][] = []
  get size() {
    return this.a.length
  }
  push(k: number, v: number) {
    const a = this.a
    a.push([k, v])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}
