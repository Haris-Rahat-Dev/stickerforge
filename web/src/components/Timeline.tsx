import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { keptSeconds, normalizeSpans, type Span } from '../spans.js'

const MIN_SPAN = 0.3
const DRAG_PX = 4
const HANDLE_PX = 14
const MAX_ZOOM = 8

/** Four frames a second so the trim aims at real frames, clamped to a readable 8–80. */
export function stripFrameCount(durationSec: number): number {
  const n = Math.ceil(Math.max(0, durationSec) * 4)
  return Math.min(80, Math.max(8, n))
}

/**
 * Lay proportioned thumbnails across the track. The server's filmstrip is a sprite of
 * `frames` evenly spaced frames; each tile shows the sprite frame nearest its own
 * midpoint in time, so thumbnails keep the source's aspect at any zoom instead of the
 * whole sprite being stretched into slivers.
 */
export function stripTiles(trackPx: number, tilePx: number, frames: number): Array<{ left: number; width: number; index: number }> {
  if (trackPx <= 0 || tilePx <= 0 || frames <= 0) return []
  const count = Math.ceil(trackPx / tilePx)
  const tiles: Array<{ left: number; width: number; index: number }> = []
  for (let i = 0; i < count; i++) {
    const left = i * tilePx
    const width = Math.min(tilePx, trackPx - left)
    const mid = (left + width / 2) / trackPx
    tiles.push({ left, width, index: Math.min(frames - 1, Math.max(0, Math.floor(mid * frames))) })
  }
  return tiles
}

/**
 * Where in the source a point of the output is: `outT` seconds into the kept cuts,
 * played back to back. Drives the playhead while the encoded sticker loops.
 */
export function sourceTimeAt(spans: Span[], outT: number): number {
  let acc = 0
  for (const s of spans) {
    const len = s.end - s.start
    if (outT < acc + len) return s.start + Math.max(0, outT - acc)
    acc += len
  }
  return spans.length ? spans[spans.length - 1].end : 0
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

/** A "nice" ruler step (1/2/5 × 10ⁿ) so ~`target` labelled ticks span the duration. */
function niceStep(seconds: number, target: number): number {
  const raw = Math.max(seconds / Math.max(1, target), 0.05)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

/** 0:04.47 — minutes only when the source is long enough to need them. */
export function clock(t: number, withMinutes = false): string {
  const s = Math.max(0, t)
  if (!withMinutes) return `${s.toFixed(2)}s`
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

/** Ruler labels carry only the precision the step needs: "2s", "0.5s", "1:30". */
export function rulerLabel(t: number, step: number, withMinutes = false): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  if (!withMinutes) return `${t.toFixed(digits)}s`
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`
}

interface TimelineProps {
  duration: number
  spans: Span[]
  stripUrl: string | null
  /** Source width / height, so filmstrip tiles keep their shape. */
  aspect: number
  maxSpan: number
  currentTime: number
  onChange: (spans: Span[]) => void
  onSeek: (t: number) => void
  onSeekEnd?: () => void
  /** Presets: the window slides but keeps its length — every grab is a move. */
  lockLength?: boolean
  /** Fired once when a window drag is released (not on plain seeks). */
  onDragEnd?: () => void
  /** 'sticker': the playhead is following the encoded sticker's loop, not the source. */
  playhead?: 'source' | 'sticker'
  /** One marker per join (cut or loop), coloured by how visible it is; click to snap. */
  seams?: Array<{ at: number; kind: 'cut' | 'loop'; label: string; title: string; onClick?: () => void }>
  /** Playback speed: the kept source plays in kept/speed seconds of sticker. */
  speed?: number
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

export default function Timeline({
  duration, spans, stripUrl, aspect, maxSpan, currentTime, onChange, onSeek, onSeekEnd,
  lockLength = false, onDragEnd, playhead = 'source', seams = [], speed = 1,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [viewPx, setViewPx] = useState(0)
  const live = useRef({ duration, spans, onChange, onSeek, onSeekEnd, lockLength, onDragEnd, maxSpan })
  live.current = { duration, spans, onChange, onSeek, onSeekEnd, lockLength, onDragEnd, maxSpan }
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const ro = new ResizeObserver(() => setViewPx(sc.clientWidth))
    ro.observe(sc)
    setViewPx(sc.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Keep the playhead in view as it plays or the zoom changes.
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || duration <= 0 || zoom === 1) return
    const x = (currentTime / duration) * sc.scrollWidth
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) {
      sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2)
    }
  }, [currentTime, zoom, duration])

  // Pinch / ctrl-wheel zooms around the pointer, like every editor people already know.
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom(z => Math.min(MAX_ZOOM, Math.max(1, Math.round((z * (e.deltaY < 0 ? 1.25 : 0.8)) * 4) / 4)))
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])

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
    // The ruler always scrubs; only the filmstrip lane grabs cuts.
    const onRuler = (e.target as HTMLElement).closest('.tl-ruler') != null
    const index = onRuler ? -1 : hitSpan(localX, rect.width, d)
    let drag: DragState
    if (index < 0) {
      drag = { kind: 'seek', mode: 'move', grabOffset: 0, originStart: 0, originEnd: 0, originSpans: cur, index: -1, pointerId: e.pointerId, originX: e.clientX, armed: true }
      live.current.onSeek(t)
    } else {
      const sx = d > 0 ? (cur[index].start / d) * rect.width : 0
      const ex = d > 0 ? (cur[index].end / d) * rect.width : 0
      drag = { kind: 'window', mode: live.current.lockLength ? 'move' : hitMode(localX, sx, ex), grabOffset: t - cur[index].start, originStart: cur[index].start, originEnd: cur[index].end, originSpans: cur, index, pointerId: e.pointerId, originX: e.clientX, armed: false }
    }
    dragRef.current = drag
    setDragging(drag.kind === 'window')
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
    live.current.onChange(normalizeSpans(next, d, live.current.maxSpan))
    live.current.onSeek(drag.mode === 'start' ? one.start : drag.mode === 'end' ? one.end : Math.min(one.end, Math.max(one.start, t)))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    setDragging(false)
    // A click on a window (no drag) seeks the playhead there.
    if (drag.kind === 'window' && !drag.armed) live.current.onSeek(pointTime(e.clientX))
    live.current.onSeekEnd?.()
    if (drag.kind === 'window' && drag.armed) live.current.onDragEnd?.()
  }

  const removeSpan = (i: number): void => {
    const d = live.current.duration
    live.current.onChange(normalizeSpans(live.current.spans.filter((_, k) => k !== i), d, live.current.maxSpan))
  }

  const pct = (t: number): string => `${duration > 0 ? (t / duration) * 100 : 0}%`
  const kept = keptSeconds(spans)
  const overLimit = kept > maxSpan + 0.01
  const first = spans[0]
  const last = spans[spans.length - 1]
  const long = duration >= 60

  const gaps: { left: number; width: number }[] = []
  if (first) gaps.push({ left: 0, width: first.start })
  for (let i = 0; i < spans.length - 1; i++) gaps.push({ left: spans[i].end, width: spans[i + 1].start - spans[i].end })
  if (last) gaps.push({ left: last.end, width: Math.max(0, duration - last.end) })

  const trackPx = viewPx * zoom
  // Labels roughly every 90px of track; four minor ticks between each.
  const step = niceStep(duration, Math.max(2, trackPx / 90))
  const minor = step / 5
  const ticks: Array<{ t: number; major: boolean }> = []
  for (let k = 0; k * minor <= duration + 1e-6; k++) {
    ticks.push({ t: Math.round(k * minor * 1000) / 1000, major: k % 5 === 0 })
  }

  const frames = stripFrameCount(duration)
  const laneH = 64
  const tileW = Math.max(24, laneH * (aspect > 0 ? aspect : 1))
  const tiles = stripUrl ? stripTiles(trackPx, tileW, frames) : []

  const zoomTo = (z: number): void => setZoom(Math.min(MAX_ZOOM, Math.max(1, z)))

  return (
    <div className={`tl ${lockLength ? 'tl-locked' : ''} ${dragging ? 'tl-dragging' : ''} ${playhead === 'sticker' ? 'tl-following' : ''}`}>
      <div className="tl-scroll" ref={scrollRef}>
        <div
          className="tl-track"
          ref={trackRef}
          style={{ width: zoom === 1 ? '100%' : `${trackPx}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="tl-ruler">
            {ticks.map(({ t, major }) => (
              <span key={t} className={`tl-tick ${major ? 'tl-tick-major' : ''}`} style={{ left: pct(t) }}>
                {major && <span className="tl-tick-label">{rulerLabel(t, step, long)}</span>}
              </span>
            ))}
          </div>

          <div className="tl-lane">
            {stripUrl
              ? tiles.map(tile => (
                <div
                  key={tile.left}
                  className="tl-thumb"
                  style={{
                    left: tile.left, width: tile.width,
                    backgroundImage: `url(${stripUrl})`,
                    backgroundSize: `${frames * tileW}px 100%`,
                    backgroundPosition: `${-tile.index * tileW}px 0`,
                  }}
                />
              ))
              : <div className="tl-lane-empty" />}
            {gaps.map((g, i) => (
              <div key={`gap${i}`} className="tl-dim" style={{ left: pct(g.left), width: pct(g.width) }} />
            ))}
            {spans.map((s, i) => (
              <div key={i} className={`tl-window ${overLimit ? 'tl-over' : ''}`} style={{ left: pct(s.start), width: pct(s.end - s.start) }}>
                <div className="tl-handle tl-handle-left"><i /></div>
                <div className="tl-handle tl-handle-right"><i /></div>
                <span className="tl-dur">{(s.end - s.start).toFixed(1)}s</span>
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
          </div>

          {seams.map(sm => (
            <button
              key={`${sm.kind}-${sm.at}`}
              type="button"
              className={`tl-seam tl-seam-${sm.label} ${sm.kind === 'loop' ? 'tl-seam-loop' : ''} ${sm.onClick ? '' : 'tl-seam-idle'}`}
              style={{ left: pct(sm.at) }}
              title={sm.title}
              aria-label={sm.title}
              onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}
              onClick={e => { e.stopPropagation(); sm.onClick?.() }}
            >{sm.kind === 'loop' ? '↺' : ''}</button>
          ))}

          <div className="tl-playhead" style={{ left: pct(currentTime) }}>
            <span className="tl-playhead-cap" />
          </div>
        </div>
      </div>

      <div className="tl-foot">
        <span className="tl-io"><b>IN</b> {clock(first?.start ?? 0, long)}</span>
        <span className="tl-io"><b>OUT</b> {clock(last?.end ?? 0, long)}</span>
        <span className={`tl-io ${overLimit ? 'tl-span-bad' : ''}`}>
          <b>KEPT</b> {kept.toFixed(2)}s{speed !== 1 ? ` → ${(kept / speed).toFixed(2)}s at ${speed}×` : ''}{spans.length > 1 ? ` · ${spans.length} cuts` : ''}{overLimit ? ` — over ${maxSpan.toFixed(1)}s` : ''}
        </span>
        <span className="tl-zoom">
          <button className="tl-zoom-btn" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 1.5)} title="Zoom out (⌘/Ctrl + scroll)">−</button>
          <input
            className="tl-zoom-range" type="range" min={1} max={MAX_ZOOM} step={0.25} value={zoom}
            onChange={e => zoomTo(Number(e.target.value))} aria-label="Timeline zoom"
          />
          <button className="tl-zoom-btn" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 1.5)} title="Zoom in (⌘/Ctrl + scroll)">+</button>
        </span>
      </div>
    </div>
  )
}
