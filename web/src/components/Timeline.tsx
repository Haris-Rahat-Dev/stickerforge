import { useRef } from 'react'
import { keptSeconds, normalizeSpans, type Span } from '../spans.js'

const MIN_SPAN = 0.3
const DRAG_PX = 4
const HANDLE_PX = 20

/** Four frames a second so the trim aims at real frames, clamped to a readable 8–80. */
export function stripFrameCount(durationSec: number): number {
  const n = Math.ceil(Math.max(0, durationSec) * 4)
  return Math.min(80, Math.max(8, n))
}

export function timeAt(x: number, left: number, width: number, duration: number): number {
  if (width <= 0) return 0
  return Math.min(duration, Math.max(0, ((x - left) / width) * duration))
}

export type TrimMode = 'start' | 'end' | 'move'

export function hitMode(x: number, startX: number, endX: number, handle = HANDLE_PX): TrimMode {
  if (endX - startX <= handle * 2) return x < (startX + endX) / 2 ? 'start' : 'end'
  if (Math.abs(x - startX) <= handle) return 'start'
  if (Math.abs(x - endX) <= handle) return 'end'
  if (x > startX && x < endX) return 'move'
  return x < startX ? 'start' : 'end'
}

export function applyTrimDrag(
  mode: TrimMode,
  t: number,
  originStart: number,
  originEnd: number,
  duration: number,
  grabOffset: number,
  minSpan = MIN_SPAN,
): { start: number; end: number } {
  if (mode === 'start') {
    return { start: Math.max(0, Math.min(t, originEnd - minSpan)), end: originEnd }
  }
  if (mode === 'end') {
    return { start: originStart, end: Math.min(duration, Math.max(t, originStart + minSpan)) }
  }
  const span = originEnd - originStart
  const s = Math.max(0, Math.min(t - grabOffset, duration - span))
  return { start: s, end: s + span }
}

interface TimelineProps {
  duration: number
  spans: Span[]
  stripUrl: string | null
  maxSpan: number
  frameCount: number
  onChange: (spans: Span[]) => void
  onScrub?: (t: number) => void
  onScrubEnd?: () => void
}

interface DragState {
  mode: TrimMode
  grabOffset: number
  originStart: number
  originEnd: number
  /** All spans as they were when the drag began — the drag replaces just one of them. */
  originSpans: Span[]
  index: number
  pointerId: number
  originX: number
  armed: boolean
}

export default function Timeline({ duration, spans, stripUrl, maxSpan, frameCount, onChange, onScrub, onScrubEnd }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const live = useRef({ duration, spans, onChange, onScrub, onScrubEnd })
  live.current = { duration, spans, onChange, onScrub, onScrubEnd }
  const dragRef = useRef<DragState | null>(null)

  const pointTime = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return timeAt(clientX, rect.left, rect.width, live.current.duration)
  }

  /** Topmost span (last drawn) whose window or handles cover x, or -1 for a gap. */
  const hitSpan = (localX: number, width: number, d: number): number => {
    const cur = live.current.spans
    for (let i = cur.length - 1; i >= 0; i--) {
      const sx = d > 0 ? (cur[i].start / d) * width : 0
      const ex = d > 0 ? (cur[i].end / d) * width : 0
      if (localX >= sx - HANDLE_PX && localX <= ex + HANDLE_PX) return i
    }
    return -1
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const d = live.current.duration
    const localX = e.clientX - rect.left
    const t = timeAt(e.clientX, rect.left, rect.width, d)
    let cur = live.current.spans
    let index = hitSpan(localX, rect.width, d)
    let mode: TrimMode = 'move'
    if (index < 0) {
      // A press in a gap opens a new one-second window and drags its end to size it.
      const add: Span = { start: t, end: Math.min(duration, t + 1) }
      cur = normalizeSpans([...cur, add], d)
      index = cur.findIndex(s => t >= s.start - 0.001 && t <= s.end + 0.001)
      if (index < 0) return
      mode = 'end'
      live.current.onChange(cur)
    } else {
      const sx = d > 0 ? (cur[index].start / d) * rect.width : 0
      const ex = d > 0 ? (cur[index].end / d) * rect.width : 0
      mode = hitMode(localX, sx, ex)
    }
    dragRef.current = {
      mode,
      grabOffset: t - cur[index].start,
      originStart: cur[index].start,
      originEnd: cur[index].end,
      originSpans: cur,
      index,
      pointerId: e.pointerId,
      originX: e.clientX,
      armed: mode === 'end',
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    if (!drag.armed) {
      if (Math.abs(e.clientX - drag.originX) < DRAG_PX) return
      drag.armed = true
    }
    const t = pointTime(e.clientX)
    const d = live.current.duration
    const one = applyTrimDrag(drag.mode, t, drag.originStart, drag.originEnd, d, drag.grabOffset)
    const next = drag.originSpans.map((s, i) => i === drag.index ? one : s)
    live.current.onChange(normalizeSpans(next, d))
    const scrub = drag.mode === 'start' ? one.start : drag.mode === 'end' ? one.end : Math.min(one.end, Math.max(one.start, t))
    live.current.onScrub?.(scrub)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (!drag.armed) {
      const t = pointTime(e.clientX)
      if (t >= drag.originStart && t <= drag.originEnd) live.current.onScrub?.(t)
    }
    live.current.onScrubEnd?.()
  }

  const pct = (t: number): string => `${duration > 0 ? (t / duration) * 100 : 0}%`
  const kept = keptSeconds(spans)
  const overLimit = kept > maxSpan + 0.01
  const first = spans[0]
  const last = spans[spans.length - 1]

  // Dim every stretch that is not kept: before the first span, between spans, after the last.
  const gaps: { left: number; width: number }[] = []
  if (first) gaps.push({ left: 0, width: first.start })
  for (let i = 0; i < spans.length - 1; i++) gaps.push({ left: spans[i].end, width: spans[i + 1].start - spans[i].end })
  if (last) gaps.push({ left: last.end, width: Math.max(0, duration - last.end) })

  return (
    <div className="timeline">
      <div className="tl-scroll">
        <div
          className="tl-track"
          ref={trackRef}
          style={{ ['--strip-w' as string]: `${frameCount * 64}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {stripUrl && <img className="tl-strip" src={stripUrl} alt="" draggable={false} />}
          {!stripUrl && <div className="tl-strip tl-strip-empty" />}
          {gaps.map((g, i) => (
            <div key={`gap${i}`} className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(g.left), width: pct(g.width) }} />
          ))}
          {spans.map((s, i) => (
            <div
              key={i}
              className={`tl-window ${overLimit ? 'tl-over' : ''}`}
              style={{ left: pct(s.start), width: pct(s.end - s.start) }}
            >
              <div className="tl-handle tl-handle-left" />
              <div className="tl-handle tl-handle-right" />
            </div>
          ))}
        </div>
      </div>
      <div className="tl-labels">
        <span>{(first?.start ?? 0).toFixed(2)}s</span>
        <span className={overLimit ? 'tl-span-bad' : ''}>
          {kept.toFixed(2)}s{spans.length > 1 ? ` · ${spans.length} cuts` : ''}{overLimit ? ` — over ${maxSpan.toFixed(1)}s` : ''}
        </span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
