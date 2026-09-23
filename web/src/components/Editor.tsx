import { useEffect, useRef, useState } from 'react'
import { videoUrl, filmstripUrl, convert, detectCrop, watchJob, estimate, discardDraft, EncodeError } from '../api.js'
import type { ConvertRequest, CropRect, EstimateResult, FileRecord, FitMode, StickerSpec } from '../types.js'
import { capFps, fpsChoices, MAX_STICKER_SEC, motionBudget, nextFitLength } from '../budget.js'
import { keptSeconds, normalizeSpans, splitAt, type Span } from '../spans.js'
import Timeline from './Timeline.jsx'
import StickerPreview from './StickerPreview.jsx'
import { SpecTable } from './StickerSpec.jsx'

function squareCrop(w: number, h: number): CropRect {
  const s = Math.min(w, h)
  return { w: s, h: s, x: Math.round((w - s) / 2), y: Math.round((h - s) / 2) }
}

function squareInside(r: CropRect): CropRect {
  const s = Math.min(r.w, r.h)
  return { w: s, h: s, x: r.x + Math.round((r.w - s) / 2), y: r.y + Math.round((r.h - s) / 2) }
}

/**
 * Short: the source frame rate, as much clip as fits. Long: 15fps, so busy footage
 * keeps ~60–90% more seconds. Custom: the full editor, previewed after generating.
 */
export type EditorMode = 'short' | 'long' | 'custom'
const LONG_FPS = 15
/** Budget failures shrink the preset window to what the encoder measured would fit. */
const FIT_ATTEMPTS = 4

/** Identity of an encode's settings, so a result can tell when the editor has moved on. */
const settingsKey = ({ fileId: _f, ...s }: ConvertRequest): string => JSON.stringify(s)

interface Draft {
  jobId: string
  key: string
  spec?: StickerSpec
  sizeBytes?: number
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
  const sourceFps = capFps(meta.fps)
  const choices = fpsChoices(meta.fps)
  const isImage = file.kind === 'image'
  const needsFraming = Math.abs(meta.width / meta.height - 1) > 0.02
  // A source already at or under 15fps has nothing for Long to trade.
  const offerLong = sourceFps > LONG_FPS

  const [mode, setMode] = useState<EditorMode>(isImage ? 'custom' : 'short')
  const [presetStart, setPresetStart] = useState(0)
  const [presetLen, setPresetLen] = useState(Math.min(MAX_STICKER_SEC, duration))
  const [presetTick, setPresetTick] = useState(0)

  const [spans, setSpans] = useState<Span[]>([{ start: 0, end: Math.min(MAX_STICKER_SEC, duration) }])
  const [crop, setCrop] = useState<CropRect>(() => squareCrop(meta.width, meta.height))
  const [pad, setPad] = useState(needsFraming)
  const [cropDetecting, setCropDetecting] = useState(false)
  const [border, setBorder] = useState(false)
  const [fps, setFps] = useState(sourceFps)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<{ progress: number; stage: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)

  const [stripUrl, setStripUrl] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(!isImage)
  const [est, setEst] = useState<EstimateResult | null>(null)
  const [estimating, setEstimating] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const scrubbing = useRef(false)
  // Every encode run takes a ticket; a run whose ticket is stale drops its result.
  const runRef = useRef(0)
  // The uncommitted draft on the server, so it can be discarded when replaced or abandoned.
  const draftRef = useRef<string | null>(null)
  const committedRef = useRef(false)
  const draftKey = `sf-draft:${file.id}`

  const presetFps = (m: EditorMode): number => (m === 'long' ? Math.min(LONG_FPS, sourceFps) : sourceFps)
  const presetWindow: Span = { start: presetStart, end: Math.min(duration, presetStart + presetLen) }
  const activeSpans = mode === 'custom' ? spans : [presetWindow]
  const spansRef = useRef(activeSpans)
  spansRef.current = activeSpans

  const presetReq = (m: EditorMode, start: number, len: number): ConvertRequest => ({
    fileId: file.id, start, end: start + len, spans: [{ start, end: start + len }],
    speed: 1, fps: presetFps(m), fit: needsFraming ? 'contain' : 'cover', padColor: '#000000',
    crop: needsFraming ? null : squareCrop(meta.width, meta.height), cropPos: 0.5, border: false,
  })
  const fit: FitMode = pad ? 'contain' : 'cover'
  const customReq: ConvertRequest = {
    fileId: file.id, start: spans[0].start, end: spans[spans.length - 1].end, spans,
    speed: 1, fps, fit, padColor: '#000000', crop: pad ? null : crop, cropPos: 0.5, border,
  }

  // A result is only worth adding while it still matches what the editor shows.
  const fresh = !!draft && (mode !== 'custom' || draft.key === settingsKey(customReq))
  const showingSticker = fresh && !showSource && !busy

  const dropDraft = (): void => {
    const id = draftRef.current
    draftRef.current = null
    sessionStorage.removeItem(draftKey)
    if (id) void discardDraft(id)
  }

  // One encode for review. Resolves null when a newer run superseded it.
  const encodeDraft = async (req: ConvertRequest, ticket: number): Promise<Draft | null> => {
    dropDraft()
    setDraft(null)
    setError(null)
    setBusy({ progress: 0, stage: 'starting' })
    const id = await convert(req, true)
    if (runRef.current !== ticket) { void discardDraft(id); return null }
    draftRef.current = id
    sessionStorage.setItem(draftKey, id)
    try {
      const done = await watchJob(id, e => {
        if (runRef.current === ticket) setBusy({ progress: e.progress, stage: e.stage })
      })
      if (runRef.current !== ticket) return null
      return { jobId: id, key: settingsKey(req), spec: done.spec, sizeBytes: done.sizeBytes }
    } catch (err) {
      // A failed encode is never persisted; nothing left to discard.
      if (draftRef.current === id) { draftRef.current = null; sessionStorage.removeItem(draftKey) }
      throw err
    }
  }

  const failed = (err: unknown, ticket: number): void => {
    if (runRef.current !== ticket) return
    setBusy(null)
    if (err instanceof EncodeError && err.cancelled) return
    setError(err instanceof Error ? err.message : 'Encode failed')
  }

  const stopEncode = (): void => {
    runRef.current++
    dropDraft()
    setBusy(null)
  }

  // A previous visit's unreviewed draft (reload, crash) is stale — never adopt it.
  useEffect(() => {
    const stale = sessionStorage.getItem(draftKey)
    if (stale) { sessionStorage.removeItem(draftKey); void discardDraft(stale) }
    return () => {
      runRef.current++
      if (!committedRef.current) {
        const id = draftRef.current
        draftRef.current = null
        sessionStorage.removeItem(draftKey)
        if (id) void discardDraft(id)
      }
    }
  }, [draftKey])

  // Presets encode as soon as they're picked and whenever the window is let go.
  useEffect(() => {
    if (isImage || mode === 'custom') return
    const ticket = ++runRef.current
    const m = mode
    const start = presetStart
    void (async () => {
      let len = Math.max(0.5, Math.min(MAX_STICKER_SEC, duration - start))
      for (let attempt = 1; attempt <= FIT_ATTEMPTS; attempt++) {
        if (runRef.current !== ticket) return
        setPresetLen(len)
        try {
          const d = await encodeDraft(presetReq(m, start, len), ticket)
          if (!d) return
          setDraft(d)
          setBusy(null)
          setShowSource(false)
          return
        } catch (err) {
          const fitS = err instanceof EncodeError ? err.fitSeconds : undefined
          if (runRef.current !== ticket) return
          const next = fitS != null && attempt < FIT_ATTEMPTS
            ? nextFitLength(len, fitS, attempt === FIT_ATTEMPTS - 1)
            : null
          if (next != null) {
            len = next
            setBusy({ progress: 0, stage: `too big — trying ${len.toFixed(1)}s` })
            continue
          }
          failed(err, ticket)
          return
        }
      }
    })()
    return () => { runRef.current++ }
    // presetTick is the "window released" signal; presetStart alone changes mid-drag.
  }, [mode, presetTick, file.id, isImage, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async (): Promise<void> => {
    if (!isImage && !motionBudget(keptSeconds(spans), fps).ok) return
    const ticket = ++runRef.current
    try {
      const d = await encodeDraft(customReq, ticket)
      if (!d) return
      setDraft(d)
      setBusy(null)
      setShowSource(false)
    } catch (err) {
      failed(err, ticket)
    }
  }

  const addToPack = (): void => {
    if (!draft || !fresh) return
    committedRef.current = true
    draftRef.current = null
    sessionStorage.removeItem(draftKey)
    onAddedToPack?.(draft.jobId, draft.sizeBytes, replaceAt)
  }

  const pickMode = (m: EditorMode): void => {
    if (m === mode) return
    if (m === 'custom') {
      // Custom opens on exactly what the preset made, so its result stays addable.
      setSpans([presetWindow])
      setFps(presetFps(mode))
      setPad(needsFraming)
      setCrop(squareCrop(meta.width, meta.height))
      setBorder(false)
    }
    setError(null)
    setMode(m)
  }

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

  // The source only plays while it is what's on screen.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (showingSticker) v.pause()
    else if (playingRef.current) v.play().catch(() => {})
  }, [showingSticker])

  // Live projection — Custom only. Presets measure the real encode instead.
  const estKey = JSON.stringify({ s: spans, c: pad ? null : crop, b: border, p: pad, f: fps })
  useEffect(() => {
    if (isImage || mode !== 'custom') return
    const ctrl = new AbortController()
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setEstimating(true)
    const req = customReq
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
  }, [estKey, file.id, isImage, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const seekPreview = (t: number): void => {
    const v = videoRef.current
    if (!v) return
    setShowSource(true)
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
    const t = currentTime
    const inSpan = spans.some(s => t > s.start + 0.05 && t < s.end - 0.05)
    const next = inSpan
      ? splitAt(spans, t)
      : [...spans, { start: t, end: Math.min(duration, t + 1) }]
    setSpans(normalizeSpans(next, duration))
  }

  const outDur = keptSeconds(spans)
  const budget = motionBudget(outDur, fps)
  const maxSpan = Math.min(MAX_STICKER_SEC, duration)

  const onSpansChange = (next: Span[]): void => {
    setSpans(next.length ? next : [{ start: 0, end: Math.min(MAX_STICKER_SEC, duration) }])
  }

  const onPresetWindow = (next: Span[]): void => {
    const s = next[0]
    if (!s) return
    setPresetStart(Math.max(0, Math.min(s.start, duration - presetLen)))
  }

  // Collapse to one span of `sec` from the first kept start — the "trim to fit" action.
  const trimTo = (sec: number): void => {
    let s = spans[0]?.start ?? 0
    let e = s + sec
    if (e > duration) { e = duration; s = Math.max(0, e - sec) }
    setSpans([{ start: s, end: e }])
  }

  const primary = fresh
    ? { label: replaceAt != null ? 'Replace in pack' : 'Add to pack', onClick: addToPack, disabled: !!busy }
    : mode === 'custom'
      ? { label: busy ? `Generating… ${Math.round(busy.progress * 100)}%` : 'Generate', onClick: () => void generate(), disabled: !!busy || (!isImage && !budget.ok) }
      : { label: busy ? `Encoding… ${Math.round(busy.progress * 100)}%` : 'Add to pack', onClick: addToPack, disabled: true }

  const modes: Array<{ m: EditorMode; title: string; sub: string }> = [
    { m: 'short', title: 'Short', sub: `${sourceFps}fps · smoothest, as long as fits` },
    ...(offerLong ? [{ m: 'long' as const, title: 'Long', sub: `${LONG_FPS}fps · up to ${MAX_STICKER_SEC}s, a bit choppier` }] : []),
    { m: 'custom', title: 'Custom', sub: 'trim, cut, frame, fps yourself' },
  ]

  return (
    <div className="editor-screen">
      <div className="editor-topbar">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>← Back</button>
        <div className="editor-title">
          <h2 title={file.originalName}>{file.originalName}</h2>
          <span className="meta-line">
            {isImage
              ? `image · ${meta.width}×${meta.height}`
              : `${meta.width}×${meta.height} · ${sourceFps}fps · ${duration.toFixed(1)}s`}
          </span>
        </div>
        <div className="editor-topbar-actions">
          {error && <span className="error-inline" title={error}>{error}</span>}
          <button className="btn btn-primary" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </button>
        </div>
      </div>

      <div className="editor-2col">
        <div className="editor-preview">
          {fresh && !busy && (
            <div className="seg view-toggle">
              <button className={`seg-btn ${!showSource ? 'active' : ''}`} onClick={() => setShowSource(false)}>Sticker</button>
              <button className={`seg-btn ${showSource ? 'active' : ''}`} onClick={() => setShowSource(true)}>Source</button>
            </div>
          )}
          <div className="stage-outer" style={!showingSticker && mode === 'custom' && border ? { background: '#ffffff', padding: '5.08%' } : undefined}>
            <div className="stage">
              {isImage
                ? <img className="crop-full" src={videoUrl(file.id)} alt={file.originalName} style={showingSticker ? { visibility: 'hidden' } : undefined} />
                : <video ref={videoRef} className="crop-full" src={videoUrl(file.id)} muted playsInline loop autoPlay style={showingSticker ? { visibility: 'hidden' } : undefined} />}
              {mode === 'custom' && !pad && !showingSticker && <CropBox meta={meta} crop={crop} onChange={setCrop} />}
              {showingSticker && draft && <StickerPreview jobId={draft.jobId} className="crop-full sticker-result" />}
              {busy && (
                <div className="stage-status">
                  <span>{mode === 'custom' ? 'Generating' : 'Encoding'} · {Math.round(busy.progress * 100)}%</span>
                  <span className="stage-status-sub">{busy.stage}</span>
                  <div className="progress slim"><div className="progress-fill" style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
                  <button className="btn btn-ghost btn-sm" onClick={stopEncode}>Stop</button>
                </div>
              )}
            </div>
          </div>

          {mode === 'custom' && !showingSticker && (
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
          )}
        </div>

        <div className="editor-controls">
          {!isImage && (
            <div className="mode-picker">
              {modes.map(({ m, title, sub }) => (
                <button key={m} className={`mode-btn ${mode === m ? 'active' : ''}`} onClick={() => pickMode(m)}>
                  <b>{title}</b>
                  <span>{sub}</span>
                </button>
              ))}
            </div>
          )}

          {fresh && draft?.spec && !busy && (
            <div className="result-block">
              <span className="ctl-label">This is the real sticker</span>
              <SpecTable spec={draft.spec} />
            </div>
          )}

          {!isImage && (
            <>
              <div className="tl-transport">
                <button className="btn btn-ghost btn-sm tl-play" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
                  {playing ? '⏸' : '▶'}
                </button>
                <span className="tl-time">{currentTime.toFixed(2)}s / {duration.toFixed(2)}s</span>
                {mode === 'custom' && (
                  <button className="btn btn-ghost btn-sm" onClick={cutAtPlayhead} title="Split the clip here, or keep a new range at the playhead">✂ Cut at playhead</button>
                )}
              </div>
              {mode === 'custom' ? (
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
              ) : (
                <Timeline
                  duration={duration}
                  spans={[presetWindow]}
                  stripUrl={stripUrl}
                  maxSpan={maxSpan}
                  currentTime={currentTime}
                  onChange={onPresetWindow}
                  onSeek={seekPreview}
                  onSeekEnd={endScrub}
                  lockLength
                  onDragEnd={() => setPresetTick(t => t + 1)}
                />
              )}
              <p className="tl-hint">
                {mode === 'custom'
                  ? <>Click the strip to move the playhead · drag a cut’s edges to trim, its body to move · ✂ cuts at the playhead{spans.length > 1 ? ' · ✕ removes a cut' : ''}</>
                  : <>Slide the window to pick the moment — it re-encodes when you let go. The length is whatever fits at {presetFps(mode)}fps.</>}
              </p>
            </>
          )}

          {mode === 'custom' && !isImage && choices.length > 1 && (
            <div className="fps-row">
              <span className="ctl-label">Frame rate</span>
              <div className="seg">
                {choices.map(f => (
                  <button
                    key={f}
                    className={`seg-btn ${fps === f ? 'active' : ''}`}
                    disabled={!!busy}
                    onClick={() => setFps(f)}
                  >{f}{f === sourceFps ? ' · source' : ''}</button>
                ))}
              </div>
              <span className="fps-note">Same speed either way. Lower is choppier, but fits more seconds or a sharper picture.</span>
            </div>
          )}

          {mode === 'custom' && !isImage && !fresh && (
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
                    <span className="est-actions">
                      {fps > LONG_FPS && choices.includes(LONG_FPS) && (
                        <button className="btn btn-sm" onClick={() => setFps(LONG_FPS)}>Try {LONG_FPS}fps</button>
                      )}
                      <button className="btn btn-sm" onClick={() => trimTo(est.maxSeconds ?? outDur)}>Trim · {(est.maxSeconds ?? 0).toFixed(1)}s</button>
                    </span>
                  </>
                )
                : est?.fits
                ? (
                  <span>
                    estimate <b>≈ {est.projectedKB}KB</b> · {outDur.toFixed(1)}s · {est.effectiveFps}fps
                    {' · '}<span className="est-q">{est.quality}</span>
                    {estimating ? ' · updating…' : ''} — Generate to see the real thing
                  </span>
                )
                : estimating
                ? <span>Checking how this cut fits…</span>
                : <span>{outDur.toFixed(1)}s · {fps}fps</span>}
            </div>
          )}

          {isImage && !fresh && (
            <p className="tl-hint">Still image — it becomes a motionless sticker. Frame it on the left, then Generate to see it.</p>
          )}
          {mode === 'custom' && draft && !fresh && !busy && (
            <p className="tl-hint">You changed something since the last result — Generate again to see it.</p>
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
