import { useRef, useEffect } from 'react'

const MIN_SPAN = 0.3

interface TimelineProps {
  duration: number
  start: number
  end: number
  stripUrl: string | null
  maxSpan: number
  onChange: (start: number, end: number) => void
}

interface DragState {
  mode: 'start' | 'end' | 'move'
  grabOffset: number
}

export default function Timeline({ duration, start, end, stripUrl, maxSpan, onChange }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  const posToTime = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const t = posToTime(e.clientX)
      if (drag.mode === 'start') {
        onChange(Math.max(0, Math.min(t, end - MIN_SPAN)), end)
      } else if (drag.mode === 'end') {
        onChange(start, Math.min(duration, Math.max(t, start + MIN_SPAN)))
      } else if (drag.mode === 'move') {
        const span = end - start
        let s = t - drag.grabOffset
        s = Math.max(0, Math.min(s, duration - span))
        onChange(s, s + span)
      }
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  })

  const beginDrag = (mode: DragState['mode']) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      mode,
      grabOffset: mode === 'move' ? posToTime(e.clientX) - start : 0
    }
    document.body.style.userSelect = 'none'
  }

  const pct = (t: number): string => `${(t / duration) * 100}%`
  const span = end - start
  const overLimit = span > maxSpan + 0.01

  return (
    <div className="timeline">
      <div className="tl-track" ref={trackRef}>
        {stripUrl && <img className="tl-strip" src={stripUrl} alt="" draggable={false} />}
        {!stripUrl && <div className="tl-strip tl-strip-empty" />}
        <div className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: 0, width: pct(start) }} />
        <div className={`tl-dim ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(end), right: 0 }} />
        <div
          className={`tl-window ${overLimit ? 'tl-over' : ''}`}
          style={{ left: pct(start), width: pct(span) }}
          onPointerDown={beginDrag('move')}
        >
          <div className="tl-handle tl-handle-left" onPointerDown={beginDrag('start')} />
          <div className="tl-handle tl-handle-right" onPointerDown={beginDrag('end')} />
        </div>
      </div>
      <div className="tl-labels">
        <span>{start.toFixed(2)}s</span>
        <span className={overLimit ? 'tl-span-bad' : ''}>
          {span.toFixed(2)}s{overLimit ? ` — exceeds ${maxSpan.toFixed(1)}s at this speed` : ''}
        </span>
        <span>{end.toFixed(2)}s</span>
      </div>
    </div>
  )
}
