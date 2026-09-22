import { useRef } from 'react'

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
  start: number
  end: number
  stripUrl: string | null
  maxSpan: number
  frameCount: number
  onChange: (start: number, end: number) => void
  onScrub?: (t: number) => void
  onScrubEnd?: () => void
}

interface DragState {
  mode: TrimMode
  grabOffset: number
  originStart: number
  originEnd: number
  pointerId: number
  originX: number
  armed: boolean
}

export default function Timeline({ duration, start, end, stripUrl, maxSpan, frameCount, onChange, onScrub, onScrubEnd }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const live = useRef({ duration, start, end, onChange, onScrub, onScrubEnd })
  live.current = { duration, start, end, onChange, onScrub, onScrubEnd }
  const dragRef = useRef<DragState | null>(null)

  const pointTime = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return timeAt(clientX, rect.left, rect.width, live.current.duration)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const { start: s, end: en, duration: d } = live.current
    const t = timeAt(e.clientX, rect.left, rect.width, d)
    const startX = d > 0 ? (s / d) * rect.width : 0
    const endX = d > 0 ? (en / d) * rect.width : 0
    dragRef.current = {
      mode: hitMode(e.clientX - rect.left, startX, endX),
      grabOffset: t - s,
      originStart: s,
      originEnd: en,
      pointerId: e.pointerId,
      originX: e.clientX,
      armed: false,
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
    const next = applyTrimDrag(drag.mode, t, drag.originStart, drag.originEnd, live.current.duration, drag.grabOffset)
    live.current.onChange(next.start, next.end)
    const scrub = drag.mode === 'start' ? next.start : drag.mode === 'end' ? next.end : Math.min(next.end, Math.max(next.start, t))
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
  const span = end - start
  const overLimit = span > maxSpan + 0.01

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
          <div className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: 0, width: pct(start) }} />
          <div className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(end), right: 0 }} />
          <div
            className={`tl-window ${overLimit ? 'tl-over' : ''}`}
            style={{ left: pct(start), width: pct(span) }}
          >
            <div className="tl-handle tl-handle-left" />
            <div className="tl-handle tl-handle-right" />
          </div>
        </div>
      </div>
      <div className="tl-labels">
        <span>{start.toFixed(2)}s</span>
        <span className={overLimit ? 'tl-span-bad' : ''}>
          {span.toFixed(2)}s{overLimit ? ` — over ${maxSpan.toFixed(1)}s` : ''}
        </span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
