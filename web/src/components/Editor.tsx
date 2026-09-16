import { useEffect, useRef, useState } from 'react'
import { videoUrl, filmstripUrl, convert, getJob, outputPreviewUrl, downloadWebm, downloadTray, detectCrop } from '../api.js'
import type { ConvertRequest, CropRect, FileRecord, FitMode, Job } from '../types.js'
import Timeline from './Timeline.jsx'

const MIN_SPAN = 0.3
const MAX_OUT_DUR = 6

export default function Editor({ file, onClose, onAddedToPack }: { file: FileRecord; onClose: () => void; onAddedToPack?: (jobId: string, sizeBytes?: number) => void }) {
  const meta = file.meta
  const duration = Math.max(meta.duration, 0.5)

  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(Math.min(6, duration))
  const [speed, setSpeed] = useState(1)
  const [fps, setFps] = useState(() => snapFps(meta.fps))
  const [fit, setFit] = useState<FitMode>('cover')
  const [padColor, setPadColor] = useState('#000000')
  const [cropOn, setCropOn] = useState(false)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [cropDetecting, setCropDetecting] = useState(false)
  const [cropPos, setCropPos] = useState(0.5)
  const [border, setBorder] = useState(false)
  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [loopTrim, setLoopTrim] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    filmstripUrl(file.id).then(u => {
      if (!cancelled) { url = u; setStripUrl(u) }
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file.id])

  useEffect(() => {
    if (!jobId) return
    let stop = false
    const timer = setInterval(async () => {
      try {
        const j = await getJob(jobId)
        if (stop) return
        setJob(j)
        if (j.status === 'done') { onAddedToPack?.(jobId, j.sizeBytes); clearInterval(timer) }
        else if (j.status === 'error') clearInterval(timer)
      } catch { clearInterval(timer) }
    }, 600)
    return () => { stop = true; clearInterval(timer) }
  }, [jobId])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!loopTrim) { v.pause(); return }
    v.playbackRate = speed
    const onTick = () => {
      if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.4) v.currentTime = start
    }
    v.currentTime = start
    v.play().catch(() => {})
    v.addEventListener('timeupdate', onTick)
    return () => v.removeEventListener('timeupdate', onTick)
  }, [loopTrim, start, end, speed])

  const maxSpan = Math.min(MAX_OUT_DUR * speed, duration)
  const outDur = (end - start) / speed

  const setRange = (s: number, e: number): void => {
    let span = e - s
    if (span > maxSpan) {
      span = maxSpan
      e = s + span
      if (e > duration) { e = duration; s = Math.max(0, e - span) }
    }
    if (span < MIN_SPAN) { e = s + MIN_SPAN; if (e > duration) { e = duration; s = Math.max(0, e - MIN_SPAN) } }
    setStart(s); setEnd(e)
  }

  const changeSpeed = (v: number): void => {
    const ms = Math.min(MAX_OUT_DUR * v, duration)
    const mid = (start + end) / 2
    const s = Math.max(0, Math.min(duration - ms, mid - ms / 2))
    setSpeed(v)
    setStart(s)
    setEnd(s + ms)
  }

  const toggleCrop = async (): Promise<void> => {
    if (cropOn) { setCropOn(false); return }
    if (!crop) {
      setCropDetecting(true)
      try { setCrop(await detectCrop(file.id)) } catch { /* keep null */ }
      setCropDetecting(false)
    }
    setCropOn(true)
  }

  const activeCrop = cropOn && crop ? crop : null

  const doConvert = async (): Promise<void> => {
    setJob({ status: 'running', progress: 0, stage: 'starting', id: '', fileId: file.id, settings: {} as ConvertRequest } as Job)
    try {
      const id = await convert({ fileId: file.id, start, end, speed, fps, fit, padColor, crop: activeCrop, cropPos, border })
      setJobId(id)
    } catch (err) {
      setJob({ status: 'error', error: err instanceof Error ? err.message : 'failed', progress: 0, stage: '', id: '', fileId: file.id, settings: {} as ConvertRequest })
    }
  }

  const reset = (): void => { setJob(null); setJobId(null) }

  const tall = meta.height > meta.width
  const qualityChip = QUALITY[file.quality.level] ?? QUALITY.ok

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 title={file.originalName}>{file.originalName}</h2>
            <span className="meta-line">
              {meta.width}×{meta.height} · {Math.round(meta.fps)}fps · {meta.duration.toFixed(1)}s · {(file.sizeBytes / 1024 / 1024).toFixed(1)}MB{meta.hasAudio ? ' · 🔊 audio (will be stripped)' : ''}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="quality-strip">
          <span className={`chip chip-${file.quality.level}`}>{qualityChip.label}</span>
          {file.quality.notes.map((n, i) => (
            <span key={i} className={`note note-${n.type}`}>{n.msg}</span>
          ))}
        </div>

        {!job || job.status === 'running' ? (
          <div className="editor-body">
            <div className="preview-col">
              <div
                className="stage-outer"
                style={border ? { background: '#ffffff', padding: '5.08%' } : undefined}
              >
                <div
                  className="stage"
                  style={fit === 'contain' ? { background: padColor } : undefined}
                >
                  <div style={frameStyle(fit, meta, activeCrop, cropPos)}>
                    <video
                      ref={videoRef}
                      src={videoUrl(file.id)}
                      controls muted playsInline preload="auto"
                      style={videoStyle(meta, activeCrop)}
                    />
                  </div>
                  {fit === 'cover' && cropOverlays(meta, activeCrop, cropPos).map((s, i) => (
                    <div key={i} className="crop-dim" style={s} />
                  ))}
                </div>
              </div>
              <Timeline duration={duration} start={start} end={end} stripUrl={stripUrl} maxSpan={maxSpan} onChange={setRange} />
              <div className="trim-tools">
                <button className={`btn btn-ghost btn-sm ${loopTrim ? 'active' : ''}`} onClick={() => setLoopTrim(!loopTrim)}>
                  {loopTrim ? '⏹ Stop loop' : '▶ Loop trim'}
                </button>
                <span className="out-dur">Output: <b>{outDur.toFixed(2)}s</b> @ {fps}fps</span>
              </div>
            </div>

            <div className="controls-col">
              <label className="ctl-label">Framing</label>
              <div className="seg">
                {([['cover', 'Crop'], ['contain', 'Pad'], ['stretch', 'Stretch']] as Array<[FitMode, string]>).map(([val, label]) => (
                  <button key={val} className={`seg-btn ${fit === val ? 'active' : ''}`} onClick={() => setFit(val)}>{label}</button>
                ))}
              </div>
              {fit === 'contain' && (
                <div className="swatches">
                  {['#000000', '#ffffff', '#25d366', '#128c7e', '#ece5dd'].map(c => (
                    <button key={c} className={`swatch ${padColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setPadColor(c)} />
                  ))}
                </div>
              )}

              <button
                className={`btn btn-ghost btn-sm crop-toggle ${cropOn ? 'active' : ''}`}
                onClick={toggleCrop}
                disabled={cropDetecting}
                title="Detects and trims black borders baked into the video"
              >
                {cropDetecting ? '⏳ Detecting borders…' : cropOn ? '✂ Black borders removed' : '✂ Remove black borders'}
              </button>
              {cropOn && crop && (crop.w < meta.width - 2 || crop.h < meta.height - 2) && (
                <span className="note note-good">Found borders — cropping to {crop.w}×{crop.h}</span>
              )}
              {cropOn && crop && crop.w >= meta.width - 2 && crop.h >= meta.height - 2 && (
                <span className="note">No black borders detected</span>
              )}

              {fit === 'cover' && (
                <div className="crop-pos">
                  <label className="ctl-label">Crop position — keep {tall ? 'top' : 'left'} ↔ {tall ? 'bottom' : 'right'}</label>
                  <div className="speed-row">
                    <input
                      type="range" min={0} max={1} step={0.05} value={cropPos}
                      onChange={e => setCropPos(parseFloat(e.target.value))}
                    />
                    <span className="speed-val">{Math.round(cropPos * 100)}%</span>
                  </div>
                </div>
              )}

              <button
                className={`btn btn-ghost btn-sm crop-toggle ${border ? 'active' : ''}`}
                onClick={() => setBorder(!border)}
                title="Insets the sticker with a white frame so WhatsApp's rounded corners and re-crops never clip your content"
              >
                {border ? '⬜ White border on' : '⬜ White border (safe zone)'}
              </button>

              <label className="ctl-label">Speed — squeeze long moments into 6s</label>
              <div className="speed-row">
                <input type="range" min={0.25} max={4} step={0.25} value={speed} onChange={e => changeSpeed(parseFloat(e.target.value))} />
                <span className="speed-val">{speed}×</span>
              </div>

              <label className="ctl-label">Frame rate</label>
              <select value={fps} onChange={e => setFps(parseInt(e.target.value, 10))}>
                {fpsOptions(meta.fps).map(f => <option key={f} value={f}>{f} fps</option>)}
              </select>

              <div className="spec-hint">→ WebM/VP9 · 512×512 · ≤30fps · ≤6s · &lt;500KB · silent</div>

              <button className="btn btn-primary convert-btn" disabled={!!job && job.status === 'running'} onClick={doConvert}>
                {job?.status === 'running' ? `Encoding… ${Math.round((job.progress || 0) * 100)}%` : '⚡ Add to pack'}
              </button>
              {job?.status === 'running' && (
                <div className="progress"><div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
              )}
              {job?.status === 'error' && <div className="error-box">{job.error}</div>}
            </div>
          </div>
        ) : job.status === 'done' ? (
          <ResultPanel job={job} jobId={jobId!} name={file.originalName.replace(/\.[^.]+$/, '')} onBack={reset} />
        ) : null}
      </div>
    </div>
  )
}

interface ResultPanelProps {
  job: Job
  jobId: string
  name: string
  onBack: () => void
}

function ResultPanel({ job, jobId, name, onBack }: ResultPanelProps) {
  const m = job.outMeta
  return (
    <div className="result">
      <div className="result-preview">
        <video src={outputPreviewUrl(jobId)} autoPlay loop muted playsInline />
      </div>
      <div className="result-info">
        <div className="result-title">✅ Sticker ready</div>
        <ul className="result-specs">
          <li>{(job.sizeBytes ?? 0) / 1024 | 0} KB <Check ok={(job.sizeBytes ?? Infinity) < 500 * 1024} req="<500 KB" /></li>
          {m && (
            <>
              <li>{m.width}×{m.height} <Check ok={m.width <= 512 && m.height <= 512} req="≤512px" /></li>
              <li>{Math.round(m.fps)} fps <Check ok={m.fps <= 30.01} req="≤30fps" /></li>
              <li>{m.duration.toFixed(2)}s <Check ok={m.duration <= 6.05} req="≤6s" /></li>
              <li>{m.codec.toUpperCase()} <Check ok={m.codec === 'vp9'} req="VP9" /></li>
            </>
          )}
        </ul>
        <div className="result-actions">
          <button className="btn btn-primary" onClick={() => downloadWebm(jobId, name)}>⬇ WebM</button>
          <button className="btn" onClick={() => downloadTray(jobId, name)} disabled={!job.trayPath}>⬇ Tray PNG</button>
          <button className="btn btn-ghost" onClick={onBack}>↺ Re-adjust</button>
        </div>
        <p className="tray-note">WhatsApp packs need one static tray icon per pack — grab it from any sticker.</p>
      </div>
    </div>
  )
}

function Check({ ok, req }: { ok: boolean; req: string }) {
  return <span className={`check ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'} {req}</span>
}

function snapFps(srcFps: number): number {
  const r = Math.max(10, Math.min(30, Math.round(srcFps)))
  const opts = fpsOptions(srcFps)
  return opts.reduce((best, f) => Math.abs(f - r) < Math.abs(best - r) ? f : best, opts[0])
}

function fpsOptions(srcFps: number): number[] {
  const base = [10, 15, 20, 24, 30]
  const src = Math.round(srcFps * 100) / 100
  const all = [...new Set([...base.filter(f => f <= Math.max(10, src)), Math.min(30, Math.round(src))])]
  return all.sort((a, b) => a - b)
}

interface FrameBox {
  width: string
  height: string
  left: string
  top: string
  transform?: string
}

function frameStyle(fit: FitMode, meta: FileRecord['meta'], crop: CropRect | null, cropPos = 0.5): FrameBox {
  const cw = crop?.w || meta.width
  const ch = crop?.h || meta.height
  const r = cw / ch
  const p = Math.min(1, Math.max(0, cropPos ?? 0.5))
  if (fit === 'stretch') return { width: '100%', height: '100%', left: '0%', top: '0%' }
  if (fit === 'cover') {
    if (r >= 1) {
      const overflow = r - 1
      return { width: `${r * 100}%`, height: '100%', left: `${-p * overflow * 100}%`, top: '0%' }
    }
    const overflow = 1 / r - 1
    return { width: '100%', height: `${(1 / r) * 100}%`, left: '0%', top: `${-p * overflow * 100}%` }
  }
  return r >= 1
    ? { width: '100%', height: `${(1 / r) * 100}%`, left: '0%', top: '50%', transform: 'translateY(-50%)' }
    : { width: `${r * 100}%`, height: '100%', left: '50%', top: '0%', transform: 'translateX(-50%)' }
}

function videoStyle(meta: FileRecord['meta'], crop: CropRect | null): React.CSSProperties {
  const cw = crop?.w || meta.width
  const ch = crop?.h || meta.height
  const x = crop?.x || 0
  const y = crop?.y || 0
  return {
    width: `${(meta.width / cw) * 100}%`,
    height: `${(meta.height / ch) * 100}%`,
    left: `${-(x / cw) * 100}%`,
    top: `${-(y / ch) * 100}%`,
    objectFit: 'fill'
  }
}

function cropOverlays(meta: FileRecord['meta'], crop: CropRect | null, cropPos = 0.5): React.CSSProperties[] {
  const cw = crop?.w || meta.width
  const ch = crop?.h || meta.height
  const r = cw / ch
  const p = Math.min(1, Math.max(0, cropPos ?? 0.5))
  if (r < 1) {
    const ov = (1 / r - 1) * 100
    return [
      { top: '0%', left: '0%', right: '0%', height: `${p * ov}%` },
      { bottom: '0%', left: '0%', right: '0%', height: `${(1 - p) * ov}%` }
    ]
  }
  const ov = (r - 1) * 100
  return [
    { left: '0%', top: '0%', bottom: '0%', width: `${p * ov}%` },
    { right: '0%', top: '0%', bottom: '0%', width: `${(1 - p) * ov}%` }
  ]
}

const QUALITY: Record<string, { label: string }> = {
  good: { label: '✓ Great source' },
  ok: { label: '~ Usable' },
  warn: { label: '! Rough source' },
}
