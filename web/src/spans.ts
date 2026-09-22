export interface Span { start: number; end: number }

const MIN_SPAN = 0.3
const MAX_KEPT = 6

export function keptSeconds(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
}

export function spansFromTrim(start: number, end: number): Span[] {
  return [{ start, end }]
}

export function normalizeSpans(spans: Span[], duration: number): Span[] {
  const cleaned = spans
    .map(s => ({
      start: Math.max(0, Math.min(duration, s.start)),
      end: Math.max(0, Math.min(duration, s.end)),
    }))
    .filter(s => s.end - s.start >= MIN_SPAN - 0.001)
    .sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const s of cleaned) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end + 0.001) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  while (keptSeconds(merged) > MAX_KEPT + 0.01 && merged.length > 0) {
    const last = merged[merged.length - 1]
    const over = keptSeconds(merged) - MAX_KEPT
    if (last.end - last.start - over >= MIN_SPAN) last.end = Math.round((last.end - over) * 100) / 100
    else merged.pop()
  }
  return merged
}

export function concatPrefix(spans: Span[]): string | null {
  if (spans.length < 2) return null
  const parts = spans.map((s, i) =>
    `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`,
  )
  const inputs = spans.map((_, i) => `[v${i}]`).join('')
  return `${parts.join(';')};${inputs}concat=n=${spans.length}:v=1:a=0,`
}
