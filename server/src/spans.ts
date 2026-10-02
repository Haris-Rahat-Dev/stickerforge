import { MAX_STICKER_SEC } from './budget.js'

export interface Span { start: number; end: number }

const MIN_SPAN = 0.3
const MAX_KEPT = MAX_STICKER_SEC

export function keptSeconds(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
}

export function spansFromTrim(start: number, end: number): Span[] {
  return [{ start, end }]
}

/**
 * Clamp, sort, merge, and cap the kept total at `maxKept` source seconds — the sticker
 * cap at 1×, but cap × speed when sped up, since WhatsApp's cap is on the sticker.
 */
export function normalizeSpans(spans: Span[], duration: number, maxKept = MAX_KEPT): Span[] {
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
  while (keptSeconds(merged) > maxKept + 0.01 && merged.length > 0) {
    const last = merged[merged.length - 1]
    const over = keptSeconds(merged) - maxKept
    if (last.end - last.start - over >= MIN_SPAN) last.end = Math.round((last.end - over) * 100) / 100
    else merged.pop()
  }
  return merged
}

/**
 * Razor: split the span under `t` into two kept ranges separated by `gap` seconds.
 * The gap (a frame or so) keeps the two pieces from re-merging in normalizeSpans, so
 * the user can drag them apart to drop the middle. A span too short to leave two legal
 * halves, or a `t` in a gap, is returned unchanged.
 */
export function splitAt(spans: Span[], t: number, gap = 0.06): Span[] {
  return spans.flatMap(s => {
    if (t > s.start + MIN_SPAN && t < s.end - MIN_SPAN - gap) {
      return [{ start: s.start, end: t }, { start: Math.round((t + gap) * 100) / 100, end: s.end }]
    }
    return [s]
  })
}

/** `offset` is where the input was seeked to: trims are relative to the first decoded frame. */
export function concatPrefix(spans: Span[], offset = 0): string | null {
  if (spans.length < 2) return null
  const at = (t: number): number => Math.round((t - offset) * 1000) / 1000
  const parts = spans.map((s, i) =>
    `[0:v]trim=start=${at(s.start)}:end=${at(s.end)},setpts=PTS-STARTPTS[v${i}]`,
  )
  const inputs = spans.map((_, i) => `[v${i}]`).join('')
  return `${parts.join(';')};${inputs}concat=n=${spans.length}:v=1:a=0,`
}
