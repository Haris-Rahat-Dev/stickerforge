import { useEffect, useRef, useState } from 'react'
import { keptSeconds, normalizeSpans, type Span } from '../spans.js'

const MIN_SPAN = 0.3
const DRAG_PX = 4
const HANDLE_PX = 14

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

/** A "nice" ruler step (1/2/5 × 10ⁿ) so ~`target` ticks span the duration. */
function niceStep(seconds: number, target: number): number {
  const raw = Math.max(seconds / Math.max(1, target), 0.05)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

function fmt(t: number): string {
  return `${t.toFixed(t < 10 ? 1 : 0)}s`
}

interface TimelineProps {
  duration: number
  spans: Span[]
  stripUrl: string | null
  maxSpan: number
  currentTime: number
  onChange: (spans: Span[]) => void
  onSeek: (t: number) => void
  onSeekEnd?: () => void
  /** Presets: the window slides but keeps its length — every grab is a move. */
  lockLength?: boolean
  /** Fired once when a window drag is released (not on plain seeks). */
  onDragEnd?: () => void
}

interface DragState {
  kind: 'window' | 'seek'
  mode: TrimMode
  grabOffset: number
  originStart: number
  originEnd: number
  originSpans: Span[]
  index: number
  pointerId: number
  originX: number
  armed: boolean
}

export default function Timeline({ duration, spans, stripUrl, maxSpan, currentTime, onChange, onSeek, onSeekEnd, lockLength = false, onDragEnd }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const live = useRef({ duration, spans, onChange, onSeek, onSeekEnd, lockLength, onDragEnd })
  live.current = { duration, spans, onChange, onSeek, onSeekEnd, lockLength, onDragEnd }
  const dragRef = useRef<DragState | null>(null)

  // Keep the playhead in view as it plays or the zoom changes.
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || duration <= 0) return
    const x = (currentTime / duration) * sc.scrollWidth
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) {
      sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2)
    }
  }, [currentTime, zoom, duration])

  const pointTime = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return timeAt(clientX, rect.left, rect.width, live.current.duration)
  }

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
    const rect = trackRef.current!.getBoundingClientRect()
    const d = live.current.duration
    const localX = e.clientX - rect.left
    const t = timeAt(e.clientX, rect.left, rect.width, d)
    const cur = live.current.spans
    const index = hitSpan(localX, rect.width, d)
    let drag: DragState
    if (index < 0) {
      // Empty timeline: move the playhead (and scrub while dragging).
      drag = { kind: 'seek', mode: 'move', grabOffset: 0, originStart: 0, originEnd: 0, originSpans: cur, index: -1, pointerId: e.pointerId, originX: e.clientX, armed: true }
      live.current.onSeek(t)
    } else {
      const sx = d > 0 ? (cur[index].start / d) * rect.width : 0
      const ex = d > 0 ? (cur[index].end / d) * rect.width : 0
      drag = { kind: 'window', mode: live.current.lockLength ? 'move' : hitMode(localX, sx, ex), grabOffset: t - cur[index].start, originStart: cur[index].start, originEnd: cur[index].end, originSpans: cur, index, pointerId: e.pointerId, originX: e.clientX, armed: false }
    }
    dragRef.current = drag
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
    if (drag.kind === 'seek') { live.current.onSeek(t); return }
    const one = applyTrimDrag(drag.mode, t, drag.originStart, drag.originEnd, d, drag.grabOffset)
    const next = drag.originSpans.map((s, i) => i === drag.index ? one : s)
    live.current.onChange(normalizeSpans(next, d))
    live.current.onSeek(drag.mode === 'start' ? one.start : drag.mode === 'end' ? one.end : Math.min(one.end, Math.max(one.start, t)))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    // A click on a window (no drag) seeks the playhead there.
    if (drag.kind === 'window' && !drag.armed) live.current.onSeek(pointTime(e.clientX))
    live.current.onSeekEnd?.()
    if (drag.kind === 'window' && drag.armed) live.current.onDragEnd?.()
  }

  const removeSpan = (i: number): void => {
    const d = live.current.duration
    live.current.onChange(normalizeSpans(live.current.spans.filter((_, k) => k !== i), d))
  }

  const pct = (t: number): string => `${duration > 0 ? (t / duration) * 100 : 0}%`
  const kept = keptSeconds(spans)
  const overLimit = kept > maxSpan + 0.01
  const first = spans[0]
  const last = spans[spans.length - 1]

  const gaps: { left: number; width: number }[] = []
  if (first) gaps.push({ left: 0, width: first.start })
  for (let i = 0; i < spans.length - 1; i++) gaps.push({ left: spans[i].end, width: spans[i + 1].start - spans[i].end })
  if (last) gaps.push({ left: last.end, width: Math.max(0, duration - last.end) })

  const step = niceStep(duration, 6 * zoom)
  const ticks: number[] = []
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(Math.round(t * 100) / 100)

  return (
    <div className={`tl ${lockLength ? 'tl-locked' : ''}`}>
      <div className="tl-zoom">
        <button className="btn btn-ghost btn-sm" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 1))} title="Zoom out">−</button>
        <span className="tl-zoom-label">{zoom}×</span>
        <button className="btn btn-ghost btn-sm" disabled={zoom >= 8} onClick={() => setZoom(z => Math.min(8, z + 1))} title="Zoom in">＋</button>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div
          className="tl-track"
          ref={trackRef}
          style={{ ['--tl-zoom' as string]: String(zoom) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {stripUrl ? <img className="tl-strip" src={stripUrl} alt="" draggable={false} /> : <div className="tl-strip tl-strip-empty" />}
          {gaps.map((g, i) => (
            <div key={`gap${i}`} className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(g.left), width: pct(g.width) }} />
          ))}
          {spans.map((s, i) => (
            <div key={i} className={`tl-window ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(s.start), width: pct(s.end - s.start) }}>
              <div className="tl-handle tl-handle-left" />
              <div className="tl-handle tl-handle-right" />
              {spans.length > 1 && (
                <button
                  className="tl-del"
                  title="Remove this cut"
                  onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}
                  onClick={e => { e.stopPropagation(); removeSpan(i) }}
                >✕</button>
              )}
            </div>
          ))}
          <div className="tl-playhead" style={{ left: pct(currentTime) }} />
          <div className="tl-ruler">
            {ticks.map(t => (
              <span key={t} className="tl-tick" style={{ left: pct(t) }}>{fmt(t)}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="tl-labels">
        <span>{(first?.start ?? 0).toFixed(2)}s</span>
        <span className={overLimit ? 'tl-span-bad' : ''}>
          keeping {kept.toFixed(2)}s{spans.length > 1 ? ` · ${spans.length} cuts` : ''}{overLimit ? ` — over ${maxSpan.toFixed(1)}s` : ''}
        </span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
