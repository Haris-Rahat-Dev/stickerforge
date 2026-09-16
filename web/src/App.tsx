import { useEffect, useReducer, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  uploadFile, deleteFile, listFiles, videoUrl, quickConvert, getJob,
  listPacks, createPack, renamePack, deletePack, setPackStickers, buildPack,
} from './api.js'
import type { FileRecord, UploadProgress } from './types.js'
import type { PackManifest, PackSummary } from './api.js'
import { reducer, initialState, activePack, inActivePack, type Encoded, type Stage } from './flow.js'
import Editor from './components/Editor.jsx'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// Per-browser persistence of finished stickers + the active pack. Files/packs come
// from the server; this remembers which encodes belong to this browser and which
// pack the user was editing.
const ENC_KEY = 'stickerforge.encoded.v1'
const ACTIVE_KEY = 'stickerforge.active.v1'
const loadEncoded = (): Record<string, Encoded> => { try { return JSON.parse(localStorage.getItem(ENC_KEY) || '{}') } catch { return {} } }
const saveEncoded = (e: Record<string, Encoded>): void => { try { localStorage.setItem(ENC_KEY, JSON.stringify(e)) } catch { /* ignore */ } }
const loadActive = (): string | null => { try { return localStorage.getItem(ACTIVE_KEY) } catch { return null } }
const saveActive = (c: string | null): void => { try { c ? localStorage.setItem(ACTIVE_KEY, c) : localStorage.removeItem(ACTIVE_KEY) } catch { /* ignore */ } }

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(loadEncoded(), loadActive()))
  const { stage, files, encoded, encoding, errors, packs, activeCode, building, built, buildError } = state
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => { saveEncoded(encoded) }, [encoded])
  useEffect(() => { saveActive(activeCode) }, [activeCode])

  const refreshPacks = async (): Promise<PackSummary[]> => {
    const packs = await listPacks()
    dispatch({ type: 'setPacks', packs })
    return packs
  }

  // Poll an encode to completion, dispatching progress. Resolves with the finished job.
  const pollJob = async (fileId: string, jobId: string): Promise<Encoded> => {
    for (;;) {
      const j = await getJob(jobId).catch(() => null)
      if (!j) throw new Error('Lost track of the job')
      if (j.status === 'done') { dispatch({ type: 'encDone', id: fileId, jobId, sizeBytes: j.sizeBytes }); return { jobId, sizeBytes: j.sizeBytes } }
      if (j.status === 'error') throw new Error(j.error || 'Encode failed')
      dispatch({ type: 'encProgress', id: fileId, progress: j.progress })
      await sleep(600)
    }
  }

  // Mount: load files + packs from the server, reconcile the saved encodes/active pack.
  useEffect(() => {
    let cancelled = false
    Promise.all([listFiles(), listPacks()]).then(([serverFiles, serverPacks]) => {
      if (cancelled) return
      const ids = new Set(serverFiles.map(f => f.id))
      const saved = loadEncoded()
      const enc: Record<string, Encoded> = {}
      for (const [id, e] of Object.entries(saved)) if (ids.has(id)) enc[id] = e
      const savedActive = loadActive()
      const activeCode = serverPacks.some(p => p.code === savedActive) ? savedActive : serverPacks[0]?.code ?? null
      dispatch({ type: 'hydrate', files: serverFiles, packs: serverPacks, encoded: enc, activeCode })
      // resume any encodes still running server-side
      for (const [id, e] of Object.entries(enc)) {
        getJob(e.jobId).then(j => { if (j.status === 'running') { dispatch({ type: 'encStart', id }); pollJob(id, e.jobId).catch(() => dispatch({ type: 'encError', id, error: 'Encode failed' })) } }).catch(() => {})
      }
    }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = async (list: File[]): Promise<void> => {
    for (const f of list) {
      const ok = /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|gif)$/i.test(f.name) || f.type.startsWith('video/') || f.type.startsWith('image/')
      if (!ok) continue
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`
      setUploads(u => [...u, { key, name: f.name, progress: 0 }])
      try {
        const rec = await uploadFile(f, p => setUploads(u => u.map(x => x.key === key ? { ...x, progress: p } : x)))
        dispatch({ type: 'filesAdded', files: [rec] })
      } catch (err) {
        alert(`Failed: ${f.name}\n${err instanceof Error ? err.message : 'unknown error'}`)
      } finally {
        setUploads(u => u.filter(x => x.key !== key))
      }
    }
  }

  const removeFile = async (id: string): Promise<void> => {
    await deleteFile(id)
    dispatch({ type: 'fileRemoved', id })
    await refreshPacks()   // membership may have dropped
  }

  // Ensure there's an active pack, creating a first one if needed. Returns its code.
  // Guarded so concurrent "Add to pack" clicks share one creation, not three packs.
  const creatingRef = useRef<Promise<string> | null>(null)
  const ensureActivePack = async (): Promise<string> => {
    if (stateRef.current.activeCode) return stateRef.current.activeCode
    if (!creatingRef.current) {
      creatingRef.current = (async () => {
        const p = await createPack('My Pack')
        await refreshPacks()
        dispatch({ type: 'setActive', code: p.code })
        return p.code
      })().finally(() => { creatingRef.current = null })
    }
    return creatingRef.current
  }

  // Serialize membership writes: setPackStickers replaces the whole list, so
  // concurrent add/removes would clobber each other. Chain them, each reading the
  // pack's current membership fresh from the server before applying its change.
  const memChain = useRef<Promise<unknown>>(Promise.resolve())
  const mutateMembership = (code: string, change: (current: string[]) => string[]): Promise<void> => {
    const next = memChain.current.then(async () => {
      const packs = await listPacks()
      const pack = packs.find(p => p.code === code)
      const updated = await setPackStickers(code, change(pack?.jobIds ?? []))
      dispatch({ type: 'setPacks', packs: packs.map(p => p.code === code ? updated : p) })
    })
    memChain.current = next.catch(() => {})
    return next
  }

  const addToActivePack = async (fileId: string): Promise<void> => {
    try {
      const code = await ensureActivePack()
      let enc = stateRef.current.encoded[fileId]
      if (!enc) {
        dispatch({ type: 'encStart', id: fileId })
        enc = await pollJob(fileId, await quickConvert(fileId))
      }
      await mutateMembership(code, ids => [...new Set([...ids, enc!.jobId])])
    } catch (err) {
      dispatch({ type: 'encError', id: fileId, error: err instanceof Error ? err.message : 'Failed' })
    }
  }

  const removeFromActivePack = async (fileId: string): Promise<void> => {
    const s = stateRef.current
    const enc = s.encoded[fileId]; const code = s.activeCode
    if (!enc || !code) return
    await mutateMembership(code, ids => ids.filter(id => id !== enc.jobId))
  }

  const newPack = async (): Promise<void> => {
    const name = prompt('Name this pack', `Pack ${packs.length + 1}`)?.trim()
    if (!name) return
    const p = await createPack(name)
    await refreshPacks()
    dispatch({ type: 'setActive', code: p.code })
  }
  const renameActive = async (): Promise<void> => {
    const p = activePack(state); if (!p) return
    const name = prompt('Rename pack', p.name)?.trim()
    if (!name || name === p.name) return
    await renamePack(p.code, name); await refreshPacks()
  }
  const deleteActive = async (): Promise<void> => {
    const p = activePack(state); if (!p) return
    if (!confirm(`Delete pack "${p.name}"? This removes the built pack, not your videos.`)) return
    await deletePack(p.code); await refreshPacks()
  }

  const doBuild = async (): Promise<void> => {
    const code = activeCode; if (!code) return
    dispatch({ type: 'buildStart' })
    try {
      dispatch({ type: 'buildOk', manifest: await buildPack(code) })
      await refreshPacks()
    } catch (err) {
      dispatch({ type: 'buildFail', error: err instanceof Error ? err.message : 'Pack build failed' })
    }
  }

  const pack = activePack(state)
  const readyInPack = pack?.ready ?? 0
  const anyEncoding = Object.keys(encoding).length > 0
  const canBuild = !!pack && readyInPack >= 3 && !anyEncoding
  const editing = files.find(f => f.id === editingId)

  return (
    <div
      className="app"
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={e => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]) }}
    >
      <header className="header">
        <div className="brand">
          <span className="logo">⚡</span>
          <div><h1>Sticker<em>Forge</em></h1><p>video → die-cut stickers</p></div>
        </div>
        <Steps stage={stage} />
      </header>

      {stage === 'import' && <EmptyDropzone onClick={() => inputRef.current?.click()} />}

      {stage === 'stage' && (
        <main className="content">
          <div className="toolbar">
            <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>＋ Add videos</button>
            <PackSwitcher packs={packs} activeCode={activeCode} onSelect={c => dispatch({ type: 'setActive', code: c })} onNew={newPack} onRename={renameActive} onDelete={deleteActive} />
          </div>
          <div className="grid">
            {files.map(f => (
              <FileCard
                key={f.id} file={f}
                encoding={f.id in encoding ? encoding[f.id] : null}
                error={errors[f.id] ?? null}
                encoded={!!encoded[f.id]}
                inPack={inActivePack(state, f.id)}
                onEdit={() => setEditingId(f.id)}
                onAdd={() => addToActivePack(f.id)}
                onRemoveFromPack={() => removeFromActivePack(f.id)}
                onRemove={() => removeFile(f.id)}
              />
            ))}
          </div>
        </main>
      )}

      {stage === 'install' && built && <InstallStage manifest={built} building={building} onEdit={() => dispatch({ type: 'edit' })} onRebuild={doBuild} />}

      {uploads.length > 0 && (
        <div className="upload-tray">
          {uploads.map(u => (
            <div key={u.key} className="upload-row">
              <span className="upload-name">{u.name}</span>
              <div className="progress slim"><div className="progress-fill" style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
              <span>{Math.round(u.progress * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      {stage === 'stage' && pack && (
        <div className="pack-bar">
          <div className="pack-status">
            <b>{readyInPack}</b> ready in <em>{pack.name}</em>
            {anyEncoding && <span className="muted"> · encoding…</span>}
            {readyInPack < 3 && <span className="muted"> · need {3 - readyInPack} more</span>}
          </div>
          {buildError && <div className="pack-err">✗ {buildError}</div>}
          <button className="btn btn-primary" disabled={!canBuild || building} onClick={doBuild}>
            {building ? 'Building pack…' : '⚡ Build pack'}
          </button>
        </div>
      )}

      {dragOver && <div className="drop-overlay"><div>⬇ Drop videos to import</div></div>}
      <input ref={inputRef} type="file" accept="video/*,image/*,.mkv" multiple hidden onChange={e => { addFiles([...e.target.files!]); e.target.value = '' }} />
      {editing && (
        <Editor
          file={editing}
          onClose={() => setEditingId(null)}
          onAddedToPack={async (jobId, size) => {
            dispatch({ type: 'encDone', id: editing.id, jobId, sizeBytes: size })
            const code = await ensureActivePack()
            await mutateMembership(code, ids => [...new Set([...ids, jobId])])
          }}
        />
      )}
    </div>
  )
}

function Steps({ stage }: { stage: Stage }) {
  const steps: Array<[Stage, string]> = [['import', 'Import'], ['stage', 'Stage & edit'], ['install', 'Build & install']]
  const idx = steps.findIndex(([s]) => s === stage)
  return <ol className="steps">{steps.map(([s, label], i) => <li key={s} className={i === idx ? 'on' : i < idx ? 'done' : ''}>{i + 1}. {label}</li>)}</ol>
}

function PackSwitcher({ packs, activeCode, onSelect, onNew, onRename, onDelete }: {
  packs: PackSummary[]; activeCode: string | null
  onSelect: (code: string) => void; onNew: () => void; onRename: () => void; onDelete: () => void
}) {
  return (
    <div className="pack-switch">
      <span className="switch-label">Pack</span>
      <select value={activeCode ?? ''} onChange={e => onSelect(e.target.value)} disabled={packs.length === 0}>
        {packs.length === 0 && <option value="">— none yet —</option>}
        {packs.map(p => <option key={p.code} value={p.code}>{p.name} ({p.ready})</option>)}
      </select>
      <button className="btn btn-ghost btn-sm" onClick={onNew}>＋ New</button>
      {activeCode && <button className="btn btn-ghost btn-sm" onClick={onRename}>Rename</button>}
      {activeCode && <button className="btn btn-ghost btn-sm" onClick={onDelete}>Delete</button>}
    </div>
  )
}

function EmptyDropzone({ onClick }: { onClick: () => void }) {
  return (
    <main className="empty" onClick={onClick}>
      <div className="empty-box">
        <div className="empty-icon">🎬</div>
        <h2>Feed me <em>videos</em></h2>
        <p>or click to browse — MP4, MOV, WebM, MKV</p>
        <div className="empty-steps">
          <span>① Import &amp; quality check</span>
          <span>② Add to a pack (auto or fine-tune)</span>
          <span>③ Build → scan → WhatsApp</span>
        </div>
      </div>
    </main>
  )
}

function InstallStage({ manifest, building, onEdit, onRebuild }: {
  manifest: PackManifest & { code: string }; building: boolean; onEdit: () => void; onRebuild: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const deepLink = `stickerforge://pack/${manifest.code}`
  useEffect(() => {
    QRCode.toDataURL(deepLink, { margin: 1, width: 320, color: { dark: '#1c2015', light: '#ece5dd' } }).then(setQr).catch(() => setQr(null))
  }, [deepLink])
  return (
    <main className="content install">
      <div className="install-head">
        <h2>✓ Built — <em>{manifest.name}</em> · {manifest.stickers.length} stickers</h2>
        <div className="install-actions">
          <button className="btn btn-ghost" onClick={onEdit}>← Edit pack</button>
          <button className="btn" onClick={onRebuild} disabled={building}>{building ? 'Rebuilding…' : '↻ Rebuild'}</button>
        </div>
      </div>
      <div className="install-cols">
        <div className="qr-col">
          {qr ? <img className="qr" src={qr} alt="Scan to open on phone" /> : <div className="qr placeholder" />}
          <div className="qr-code-text">Pack code: <code>{manifest.code}</code></div>
        </div>
        <div className="handoff-col">
          <div className="sticker-row">
            {manifest.stickers.map(s => (
              <div key={s.image_file} className="sticker-cell">
                <img src={`/api/pack/${manifest.code}/file/${s.image_file}`} alt="" />
                <span>{s.emojis[0]}</span>
              </div>
            ))}
          </div>
          <ol className="handoff">
            <li><b>Scan the QR</b> with your phone camera → open in StickerForge (or type the code in the app).</li>
            <li>Tap <b>Load pack</b>, then <b>Add to WhatsApp</b>.</li>
          </ol>
          <p className="handoff-note">Phone fetches the pack from the StickerForge server over Tailscale (same account).</p>
        </div>
      </div>
    </main>
  )
}

interface FileCardProps {
  file: FileRecord
  encoding: number | null
  error: string | null
  encoded: boolean
  inPack: boolean
  onEdit: () => void; onAdd: () => void; onRemoveFromPack: () => void; onRemove: () => void
}

function FileCard({ file, encoding, error, encoded, inPack, onEdit, onAdd, onRemoveFromPack, onRemove }: FileCardProps) {
  const vidRef = useRef<HTMLVideoElement>(null)
  const q = QUALITY[file.quality.level]
  const status = encoding != null ? 'encoding' : error ? 'error' : inPack ? 'inpack' : encoded ? 'encoded' : 'review'
  const isImage = file.kind === 'image'

  return (
    <div className={`card status-${status}`}>
      <div className="thumb square" onClick={onEdit} title={isImage ? 'Click to fine-tune framing' : 'Click to fine-tune framing, trim, speed'}>
        {isImage ? (
          <img className="thumb-cover" src={videoUrl(file.id)} alt={file.originalName} />
        ) : (
          <video
            ref={vidRef} className="thumb-cover" src={`${videoUrl(file.id)}#t=0.1`}
            muted loop playsInline preload="metadata"
            onMouseEnter={() => vidRef.current?.play().catch(() => {})}
            onMouseLeave={() => { const v = vidRef.current; if (v) { v.pause(); v.currentTime = 0.1 } }}
          />
        )}
        <span className={`chip chip-${file.quality.level}`}>{q.label}</span>
        <span className={`status-chip ${status}`}>{STATUS_LABEL[status]}</span>
        <button className="icon-btn remove" onClick={e => { e.stopPropagation(); onRemove() }}>✕</button>
        {encoding != null && <div className="thumb-progress"><div className="progress-fill" style={{ width: `${Math.round(encoding * 100)}%` }} /></div>}
      </div>
      <div className="card-body">
        <div className="card-name" title={file.originalName}>{file.originalName}</div>
        <div className="meta-line">{isImage ? `image · ${file.meta.width}×${file.meta.height}` : `${file.meta.width}×${file.meta.height} · ${Math.round(file.meta.fps)}fps · ${file.meta.duration.toFixed(1)}s`}</div>
        {error && <div className="warn-line">✗ {error}</div>}
        <div className="card-actions">
          {status === 'review' && <button className="btn btn-primary btn-sm" onClick={onAdd}>＋ Add to pack</button>}
          {status === 'encoded' && <button className="btn btn-primary btn-sm" onClick={onAdd}>＋ Add to pack</button>}
          {status === 'encoding' && <button className="btn btn-sm" disabled>Encoding… {Math.round((encoding ?? 0) * 100)}%</button>}
          {status === 'inpack' && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={onEdit}>Fine-tune</button>
              <button className="btn btn-ghost btn-sm" onClick={onRemoveFromPack}>Remove</button>
            </>
          )}
          {status === 'error' && <button className="btn btn-sm" onClick={onAdd}>↻ Retry</button>}
        </div>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  review: 'Needs review', encoding: 'Encoding…', encoded: 'Ready', inpack: '✓ In pack', error: '✗ Failed',
}
const QUALITY: Record<string, { label: string }> = {
  good: { label: '✓ Great' }, ok: { label: '~ Usable' }, warn: { label: '! Rough' },
}
