import { useEffect, useRef, useState } from 'react'
import { videoUrl, filmstripUrl, convert, detectCrop, watchJob } from '../api.js'
import type { ConvertRequest, CropRect, FileRecord, FitMode, Job } from '../types.js'
import { capFps, MAX_STICKER_SEC, motionBudget } from '../budget.js'
import Timeline from './Timeline.jsx'

const MIN_SPAN = 0.3
const MAX_OUT_DUR = 6

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

  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(() => {
    if (isImage) return duration
    const keep = motionBudget(duration, meta.fps).maxSeconds
    const joke = duration > 4 ? 4 : duration
    return Math.min(duration, MAX_OUT_DUR, keep, joke)
  })
  const [crop, setCrop] = useState<CropRect>(() => squareCrop(meta.width, meta.height))
  const [pad, setPad] = useState(false)
  const [cropDetecting, setCropDetecting] = useState(false)
  const [border, setBorder] = useState(false)
  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
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
    if (!jobId) return
    void watchJob(jobId, j => setJob(prev => prev ? { ...prev, progress: j.progress, stage: j.stage } : prev))
      .then(j => {
        onAddedToPack?.(jobId, j.sizeBytes, replaceAt)
      })
      .catch(err => {
        setJob({
          status: 'error',
          error: err instanceof Error ? err.message : 'failed',
          progress: 0, stage: '', id: jobId, fileId: file.id,
          settings: {} as ConvertRequest,
        })
      })
  }, [jobId, replaceAt])

  useEffect(() => {
    const v = videoRef.current
    if (!v || isImage) return
    const onTick = () => {
      if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.4) v.currentTime = start
    }
    v.currentTime = start
    v.play().catch(() => {})
    v.addEventListener('timeupdate', onTick)
    return () => v.removeEventListener('timeupdate', onTick)
  }, [start, end, isImage])

  const outDur = end - start
  const budget = motionBudget(outDur, meta.fps)
  const maxSpan = Math.min(MAX_STICKER_SEC, duration)
  const srcAspect = meta.width / meta.height
  const needsFraming = Math.abs(srcAspect - 1) > 0.02
  const fit: FitMode = pad ? 'contain' : 'cover'

  const setRange = (s: number, e: number): void => {
    let span = e - s
    if (span < MIN_SPAN) { e = s + MIN_SPAN; if (e > duration) { e = duration; s = Math.max(0, e - MIN_SPAN) } }
    setStart(s); setEnd(e)
  }

  const keepMotion = (): void => {
    const span = Math.min(budget.maxSeconds, duration - start)
    let s = start
    let e = s + span
    if (e > duration) { e = duration; s = Math.max(0, e - span) }
    setStart(s); setEnd(e)
  }

  const doConvert = async (): Promise<void> => {
    if (!isImage && !budget.ok) return
    setJob({ status: 'running', progress: 0, stage: 'starting', id: '', fileId: file.id, settings: {} as ConvertRequest })
    try {
      const id = await convert({
        fileId: file.id, start, end, speed: 1, fps, fit,
        padColor: '#000000', crop: pad ? null : crop, cropPos: 0.5, border,
      })
      setJobId(id)
    } catch (err) {
      setJob({ status: 'error', error: err instanceof Error ? err.message : 'failed', progress: 0, stage: '', id: '', fileId: file.id, settings: {} as ConvertRequest })
    }
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal editor-modal">
        <div className="modal-head">
          <div>
            <h2 title={file.originalName}>{file.originalName}</h2>
            <span className="meta-line">
              {isImage
                ? `image · ${meta.width}×${meta.height}`
                : `${meta.width}×${meta.height} · ${fps}fps · drag the box to reframe`}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="editor-body editor-solo">
          <div className="preview-col">
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
              {!pad && (
                <>
                  <button className="btn btn-ghost btn-sm" disabled={cropDetecting} onClick={async () => {
                    setCropDetecting(true)
                    const c = await detectCrop(file.id).catch(() => null)
                    setCrop(c ? squareInside(c) : squareCrop(meta.width, meta.height))
                    setCropDetecting(false)
                  }}>{cropDetecting ? 'Detecting…' : 'Auto black borders'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setCrop(squareCrop(meta.width, meta.height))}>Reset crop</button>
                </>
              )}
              <button
                className={`btn btn-ghost btn-sm ${border ? 'active' : ''}`}
                onClick={() => setBorder(!border)}
                title="Insets content so WhatsApp's rounded corners don't clip edge text"
              >{border ? 'White border on' : 'White border'}</button>
            </div>

            {!isImage && (
              <>
                <Timeline duration={duration} start={start} end={end} stripUrl={stripUrl} maxSpan={maxSpan} onChange={setRange} />
                <div className={`budget ${!budget.ok || budget.tight ? 'budget-over' : ''}`}>
                  {!budget.ok
                    ? <span>WhatsApp caps stickers at {MAX_STICKER_SEC}s</span>
                    : budget.tight
                    ? (
                      <>
                        <span>{outDur.toFixed(1)}s may not fit if it's all motion — holds are free</span>
                        <button className="btn btn-sm" onClick={keepMotion}>Safer trim · {budget.maxSeconds.toFixed(1)}s</button>
                      </>
                    )
                    : <span>{outDur.toFixed(1)}s · {fps}fps WhatsApp</span>}
                </div>
              </>
            )}

            <button
              className="btn btn-primary convert-btn"
              disabled={running || (!isImage && !budget.ok)}
              onClick={doConvert}
            >
              {running ? `Encoding… ${Math.round((job?.progress || 0) * 100)}%` : 'Add to pack'}
            </button>
            {running && (
              <div className="progress"><div className="progress-fill" style={{ width: `${Math.round((job?.progress || 0) * 100)}%` }} /></div>
            )}
            {job?.status === 'error' && <div className="error-box">{job.error}</div>}
          </div>
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
