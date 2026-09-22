import { useEffect, useRef, useState } from 'react'
import { videoUrl, filmstripUrl, convert, detectCrop, fitSpan, watchJob, cancelJob, estimate } from '../api.js'
import type { ConvertRequest, CropRect, EstimateResult, FileRecord, FitMode, Job } from '../types.js'
import { capFps, MAX_STICKER_SEC, motionBudget, openingTrimEnd } from '../budget.js'
import { keptSeconds, normalizeSpans, spansFromTrim, splitAt, type Span } from '../spans.js'
import Timeline from './Timeline.jsx'

function squareCrop(w: number, h: number): CropRect {
  const s = Math.min(w, h)
  return { w: s, h: s, x: Math.round((w - s) / 2), y: Math.round((h - s) / 2) }
}

function squareInside(r: CropRect): CropRect {
  const s = Math.min(r.w, r.h)
  return { w: s, h: s, x: r.x + Math.round((r.w - s) / 2), y: r.y + Math.round((r.h - s) / 2) }
}

export default function Editor({
  file,
  replaceAt,
  onClose,
  onAddedToPack,
}: {
  file: FileRecord
  replaceAt?: number
  onClose: () => void
  onAddedToPack?: (jobId: string, sizeBytes?: number, replaceAt?: number) => void
}) {
  const meta = file.meta
  const duration = Math.max(meta.duration, 0.5)
  const fps = capFps(meta.fps)
  const isImage = file.kind === 'image'
  const needsFraming = Math.abs(meta.width / meta.height - 1) > 0.02

  const [spans, setSpans] = useState<Span[]>(() =>
    isImage ? [{ start: 0, end: duration }] : spansFromTrim(0, openingTrimEnd(duration, meta.fps)))
  const [crop, setCrop] = useState<CropRect>(() => squareCrop(meta.width, meta.height))
  const [pad, setPad] = useState(needsFraming)
  const [cropDetecting, setCropDetecting] = useState(false)
  const [border, setBorder] = useState(false)
  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [fitting, setFitting] = useState(!isImage)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(!isImage)
  const [est, setEst] = useState<EstimateResult | null>(null)
  const [estimating, setEstimating] = useState(!isImage)

  const videoRef = useRef<HTMLVideoElement>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const scrubbing = useRef(false)
  const trimTouched = useRef(false)
  const encodeKey = `sf-encode:${file.id}`
  const spansRef = useRef(spans)
  spansRef.current = spans
  const running = job?.status === 'running'

  useEffect(() => {
    if (isImage) return
    let url: string | null = null
    let cancelled = false
    filmstripUrl(file.id).then(u => {
      if (!cancelled) { url = u; setStripUrl(u) }
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file.id, isImage])

  useEffect(() => {
    const saved = sessionStorage.getItem(encodeKey)
    if (!saved) return
    setJobId(saved)
    setJob({ status: 'running', progress: 0, stage: 'resuming', id: saved, fileId: file.id, settings: {} as ConvertRequest })
  }, [encodeKey, file.id])

  useEffect(() => {
    if (isImage) return
    let dead = false
    fitSpan(file.id).then(seconds => {
      if (dead || seconds == null) return
      setSpans(prev => trimTouched.current ? prev : [{ start: 0, end: Math.min(duration, Math.max(0.5, seconds)) }])
    }).finally(() => { if (!dead) setFitting(false) })
    return () => { dead = true }
  }, [file.id, isImage, duration])

  useEffect(() => {
    if (!jobId) return
    const forget = (): void => { sessionStorage.removeItem(encodeKey) }
    void watchJob(jobId, j => setJob(prev => prev ? { ...prev, progress: j.progress, stage: j.stage } : prev))
      .then(j => {
        forget()
        onAddedToPack?.(jobId, j.sizeBytes, replaceAt)
      })
      .catch(err => {
        forget()
        const message = err instanceof Error ? err.message : 'failed'
        // A cancel is a choice, not a fault — go back to idle instead of showing red.
        if (message.toLowerCase().includes('cancel')) { setJob(null); setJobId(null); return }
        setJob({
          status: 'error',
          error: message,
          progress: 0, stage: '', id: jobId, fileId: file.id,
          settings: {} as ConvertRequest,
        })
      })
  }, [jobId, replaceAt, encodeKey, file.id])

  useEffect(() => {
    const v = videoRef.current
    if (!v || isImage) return
    const onTick = (): void => {
      setCurrentTime(v.currentTime)
      if (scrubbing.current) return
      const cur = spansRef.current
      if (!cur.length) return
      const ct = v.currentTime
      // Walk the kept ranges in order: which one are we in, or just past?
      let i = -1
      for (let k = 0; k < cur.length; k++) if (ct >= cur[k].start - 0.4) i = k
      if (i === -1) { v.currentTime = cur[0].start; return }   // before the first range
      if (ct >= cur[i].end - 0.03) v.currentTime = (cur[i + 1] ?? cur[0]).start
    }
    v.currentTime = spansRef.current[0]?.start ?? 0
    v.play().then(() => setPlaying(true)).catch(() => {})
    v.addEventListener('timeupdate', onTick)
    return () => v.removeEventListener('timeupdate', onTick)
  }, [file.id, isImage])

  // Live projection of the current framing/trim — drives the readout under the timeline.
  const estKey = JSON.stringify({ s: spans, c: pad ? null : crop, b: border, p: pad })
  useEffect(() => {
    if (isImage) return
    const ctrl = new AbortController()
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setEstimating(true)
    const req: ConvertRequest = {
      fileId: file.id, start: spans[0].start, end: spans[spans.length - 1].end, spans,
      speed: 1, fps, fit: pad ? 'contain' : 'cover', padColor: '#000000',
      crop: pad ? null : crop, cropPos: 0.5, border,
    }
    const debounce = setTimeout(function go(): void {
      estimate(req, ctrl.signal)
        .then(r => {
          if (cancelled) return
          if (r.busy) { retry = setTimeout(go, 700); return }   // one estimate per user — retry
          setEst(r); setEstimating(false)
        })
        .catch(() => { if (!cancelled) setEstimating(false) })
    }, 450)
    return () => { cancelled = true; ctrl.abort(); clearTimeout(debounce); if (retry) clearTimeout(retry) }
    // estKey folds in spans/crop/pad/border; fps is constant per file.
  }, [estKey, file.id, isImage, fps]) // eslint-disable-line react-hooks/exhaustive-deps

  const seekPreview = (t: number): void => {
    const v = videoRef.current
    if (!v) return
    scrubbing.current = true
    v.pause()
    v.currentTime = t
    setCurrentTime(t)
  }

  const endScrub = (): void => {
    scrubbing.current = false
    if (playingRef.current) videoRef.current?.play().catch(() => {})
  }

  const togglePlay = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { v.play().then(() => setPlaying(true)).catch(() => {}) }
    else { v.pause(); setPlaying(false) }
  }

  const cutAtPlayhead = (): void => {
    trimTouched.current = true
    const t = currentTime
    const inSpan = spansRef.current.some(s => t > s.start + 0.05 && t < s.end - 0.05)
    const next = inSpan
      ? splitAt(spansRef.current, t)
      : [...spansRef.current, { start: t, end: Math.min(duration, t + 1) }]
    setSpans(normalizeSpans(next, duration))
  }

  const first = spans[0]
  const outDur = keptSeconds(spans)
  const budget = motionBudget(outDur, meta.fps)
  const maxSpan = Math.min(MAX_STICKER_SEC, duration)
  const fit: FitMode = pad ? 'contain' : 'cover'

  const onSpansChange = (next: Span[]): void => {
    trimTouched.current = true
    setSpans(next.length ? next : spansFromTrim(0, MAX_STICKER_SEC))
  }

  // Collapse to one span of `sec` from the first kept start — the "trim to fit" action.
  const trimTo = (sec: number): void => {
    trimTouched.current = true
    const from = first?.start ?? 0
    let s = from
    let e = s + sec
    if (e > duration) { e = duration; s = Math.max(0, e - sec) }
    setSpans([{ start: s, end: e }])
  }

  const doConvert = async (): Promise<void> => {
    if (!isImage && !budget.ok) return
    trimTouched.current = true
    setJob({ status: 'running', progress: 0, stage: 'starting', id: '', fileId: file.id, settings: {} as ConvertRequest })
    try {
      const id = await convert({
        fileId: file.id,
        start: spans[0].start, end: spans[spans.length - 1].end, spans,
        speed: 1, fps, fit,
        padColor: '#000000', crop: pad ? null : crop, cropPos: 0.5, border,
      })
      sessionStorage.setItem(encodeKey, id)
      setJobId(id)
    } catch (err) {
      setJob({ status: 'error', error: err instanceof Error ? err.message : 'failed', progress: 0, stage: '', id: '', fileId: file.id, settings: {} as ConvertRequest })
    }
  }

  return (
    <div className="editor-screen">
      <div className="editor-topbar">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>← Back</button>
        <div className="editor-title">
          <h2 title={file.originalName}>{file.originalName}</h2>
          <span className="meta-line">
            {isImage
              ? `image · ${meta.width}×${meta.height}`
              : pad
                ? `${meta.width}×${meta.height} · ${fps}fps · whole frame inside the square`
                : `${meta.width}×${meta.height} · ${fps}fps · drag the box to reframe`}
          </span>
        </div>
        <div className="editor-topbar-actions">
          {job?.status === 'error' && <span className="error-inline" title={job.error}>{job.error}</span>}
          <button
            className="btn btn-primary"
            disabled={running || (!isImage && !budget.ok)}
            onClick={doConvert}
          >
            {running ? `Encoding… ${Math.round((job?.progress || 0) * 100)}%` : replaceAt != null ? 'Replace in pack' : 'Add to pack'}
          </button>
        </div>
      </div>

      <div className="editor-2col">
        <div className="editor-preview">
          <div className="stage-outer" style={border ? { background: '#ffffff', padding: '5.08%' } : undefined}>
              <div className="stage">
                {isImage
                  ? <img className="crop-full" src={videoUrl(file.id)} alt={file.originalName} />
                  : <video ref={videoRef} className="crop-full" src={videoUrl(file.id)} muted playsInline loop autoPlay />}
                {!pad && <CropBox meta={meta} crop={crop} onChange={setCrop} />}
              </div>
            </div>

            <div className="stage-tools">
              {needsFraming && (
                <div className="seg">
                  <button className={`seg-btn ${!pad ? 'active' : ''}`} onClick={() => { setPad(false); setCrop(squareCrop(meta.width, meta.height)) }}>Crop</button>
                  <button className={`seg-btn ${pad ? 'active' : ''}`} onClick={() => setPad(true)}>Fit whole</button>
                </div>
              )}
              <button className="btn btn-ghost btn-sm" disabled={pad || cropDetecting} onClick={async () => {
                setCropDetecting(true)
                const c = await detectCrop(file.id).catch(() => null)
                setCrop(c ? squareInside(c) : squareCrop(meta.width, meta.height))
                setCropDetecting(false)
              }}>{cropDetecting ? 'Detecting…' : 'Auto black borders'}</button>
              <button className="btn btn-ghost btn-sm" disabled={pad} onClick={() => setCrop(squareCrop(meta.width, meta.height))}>Reset crop</button>
              <button
                className={`btn btn-ghost btn-sm ${border ? 'active' : ''}`}
                onClick={() => setBorder(!border)}
                title="Insets content so WhatsApp's rounded corners don't clip edge text"
              >White border</button>
            </div>
          </div>

          <div className="editor-controls">
            {!isImage && (
              <>
                <div className="tl-transport">
                  <button className="btn btn-ghost btn-sm tl-play" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
                    {playing ? '⏸' : '▶'}
                  </button>
                  <span className="tl-time">{currentTime.toFixed(2)}s / {duration.toFixed(2)}s</span>
                  <button className="btn btn-ghost btn-sm" onClick={cutAtPlayhead} title="Split the clip here, or keep a new range at the playhead">✂ Cut at playhead</button>
                </div>
                <Timeline
                  duration={duration}
                  spans={spans}
                  stripUrl={stripUrl}
                  maxSpan={maxSpan}
                  currentTime={currentTime}
                  onChange={onSpansChange}
                  onSeek={seekPreview}
                  onSeekEnd={endScrub}
                />
                <p className="tl-hint">
                  Click the strip to move the playhead · drag a cut’s edges to trim, its body to move · ✂ cuts at the playhead{spans.length > 1 ? ' · ✕ removes a cut' : ''}
                </p>
                <div
                  className={`budget est-line ${(!budget.ok || est?.fits === false || est?.quality === 'very soft') ? 'budget-over' : ''}`}
                  data-quality={est?.fits ? est.quality : undefined}
                >
                  {!budget.ok
                    ? <span>WhatsApp caps stickers at {MAX_STICKER_SEC}s — trim below {MAX_STICKER_SEC}s</span>
                    : est?.fits === false
                    ? (
                      <>
                        <span>Won’t fit at {fps}fps — about {(est.maxSeconds ?? 0).toFixed(1)}s fits at this framing{pad ? '' : ' (try Fit whole)'}.</span>
                        <button className="btn btn-sm" onClick={() => trimTo(est.maxSeconds ?? outDur)}>Trim · {(est.maxSeconds ?? 0).toFixed(1)}s</button>
                      </>
                    )
                    : est?.fits
                    ? (
                      <span>
                        <b>≈ {est.projectedKB}KB</b> · {outDur.toFixed(1)}s · {est.effectiveFps}fps
                        {est.effectiveFps != null && est.effectiveFps < fps ? ` (${fps} in motion)` : ''}
                        {' · '}<span className="est-q">{est.quality} · q{est.qNeeded}</span>
                        {estimating ? ' · updating…' : ''}
                      </span>
                    )
                    : (estimating || fitting)
                    ? <span>Checking how this clip fits…</span>
                    : <span>{outDur.toFixed(1)}s · {fps}fps</span>}
                </div>
              </>
            )}
            {isImage && (
              <p className="tl-hint">Still image — it becomes a motionless sticker. Frame it on the left, then add it to the pack.</p>
            )}
            {running && (
              <div className="encode-row">
                <div className="progress slim"><div className="progress-fill" style={{ width: `${Math.round((job?.progress || 0) * 100)}%` }} /></div>
                <button className="btn btn-ghost btn-sm" onClick={() => jobId && void cancelJob(jobId)}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
  )
}

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function CropBox({ meta, crop, onChange }: {
  meta: { width: number; height: number }
  crop: CropRect
  onChange: (c: CropRect) => void
}) {
  const W = meta.width, H = meta.height
  const dispW = W >= H ? 100 : (W / H) * 100
  const dispH = W >= H ? (H / W) * 100 : 100
  const offX = (100 - dispW) / 2, offY = (100 - dispH) / 2
  const style: React.CSSProperties = {
    left: `${offX + (crop.x / W) * dispW}%`,
    top: `${offY + (crop.y / H) * dispH}%`,
    width: `${(crop.w / W) * dispW}%`,
    height: `${(crop.h / H) * dispH}%`
  }

  const drag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const stage = (e.currentTarget as HTMLElement).closest('.stage') as HTMLElement
    const rect = stage.getBoundingClientRect()
    const pxX = (dispW / 100 * rect.width) / W
    const pxY = (dispH / 100 * rect.height) / H
    const sx = e.clientX, sy = e.clientY
    const o = { ...crop }
    const right = o.x + o.w, bottom = o.y + o.h
    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - sx) / pxX
      const dy = (ev.clientY - sy) / pxY
      if (mode === 'move') {
        onChange({ ...o, x: Math.round(clampN(o.x + dx, 0, W - o.w)), y: Math.round(clampN(o.y + dy, 0, H - o.h)) })
        return
      }
      const east = mode.includes('e'), south = mode.includes('s')
      const raw = east ? o.w + dx : o.w - dx
      const rawH = south ? o.h + dy : o.h - dy
      let side = Math.round((Math.abs(raw) + Math.abs(rawH)) / 2)
      let x = east ? o.x : right - side
      let y = south ? o.y : bottom - side
      if (x < 0) { side += x; x = 0 }
      if (y < 0) { side += y; y = 0 }
      if (x + side > W) side = W - x
      if (y + side > H) side = H - y
      side = Math.max(24, side)
      x = east ? o.x : right - side
      y = south ? o.y : bottom - side
      x = Math.round(clampN(x, 0, W - side))
      y = Math.round(clampN(y, 0, H - side))
      onChange({ w: side, h: side, x, y })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="cropbox" style={style} onPointerDown={drag('move')}>
      {(['nw', 'ne', 'sw', 'se'] as const).map(h => (
        <span key={h} className={`crop-handle ${h}`} onPointerDown={drag(h)} />
      ))}
    </div>
  )
}
