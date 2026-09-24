import { useRef } from 'react'
import { videoUrl } from '../api.js'
import type { FileRecord, UploadProgress } from '../types.js'

const QUALITY: Record<string, string> = { good: '✓ Great', ok: '~ Usable', warn: '! Rough' }

export default function StagingShelf({ staged, uploading, encoding, errors, onEdit, onDiscard, loading = false }: {
  staged: FileRecord[]
  /** No cached uploads yet: hold the shelf's place so the sheet doesn't jump. */
  loading?: boolean
  uploading: UploadProgress[]
  encoding: Record<string, number>
  errors: Record<string, string>
  onEdit: (fileId: string) => void
  onDiscard: (fileId: string) => void
}) {
  // The shelf's existence IS the "unfinished work" signal. Empty means everything
  // is filed, so it collapses to nothing rather than showing an empty state.
  if (loading && staged.length === 0 && uploading.length === 0) {
    return (
      <section className="shelf" aria-busy="true">
        <div className="shelf-label">Staging · checking for uploads…</div>
        <div className="shelf-rail">
          {[0, 1].map(i => (
            <div key={i} className="shelf-card">
              <div className="thumb square skeleton" />
              <span className="skel-line" style={{ width: '80%' }} />
            </div>
          ))}
        </div>
      </section>
    )
  }
  if (staged.length === 0 && uploading.length === 0) return null

  return (
    <section className="shelf">
      <div className="shelf-label">
        Staging · {staged.length + uploading.length} not in the pack yet
      </div>
      <div className="shelf-rail">
        {staged.map(f => (
          <ShelfCard
            key={f.id}
            file={f}
            progress={f.id in encoding ? encoding[f.id] : null}
            error={errors[f.id] ?? null}
            onEdit={() => onEdit(f.id)}
            onDiscard={() => onDiscard(f.id)}
          />
        ))}
        {uploading.map(u => (
          <div key={u.key} className="shelf-card">
            <div className="thumb square skeleton">
              <span className="status-chip encoding">Uploading… {Math.round(u.progress * 100)}%</span>
              <div className="thumb-progress">
                <div className="progress-fill" style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
            </div>
            <div className="shelf-name" title={u.name}>{u.name}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ShelfCard({ file, progress, error, onEdit, onDiscard }: {
  file: FileRecord
  progress: number | null
  error: string | null
  onEdit: () => void
  onDiscard: () => void
}) {
  const vid = useRef<HTMLVideoElement>(null)
  return (
    <div className="shelf-card">
      <div className="thumb square" onClick={onEdit} title="Edit and add to the pack">
        {file.kind === 'image'
          ? <img className="thumb-cover fade-img" src={videoUrl(file.id)} alt={file.originalName} decoding="async" onLoad={e => e.currentTarget.classList.add('is-ready')} onError={e => e.currentTarget.classList.add('is-ready')} />
          : <video
              ref={vid}
              className="thumb-cover fade-img"
              src={`${videoUrl(file.id)}#t=0.1`}
              muted
              loop
              playsInline
              preload="metadata"
              onLoadedData={e => e.currentTarget.classList.add('is-ready')}
              onError={e => e.currentTarget.classList.add('is-ready')}
              onMouseEnter={() => vid.current?.play().catch(() => {})}
              onMouseLeave={() => { const v = vid.current; if (v) { v.pause(); v.currentTime = 0.1 } }}
            />}
        <span className={`chip chip-${file.quality.level}`}>{QUALITY[file.quality.level]}</span>
        {progress != null && (
          <div className="thumb-progress">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <button
          className="icon-btn remove"
          title="Discard this upload"
          onClick={e => { e.stopPropagation(); onDiscard() }}
        >
          ✕
        </button>
      </div>
      <div className="shelf-name" title={file.originalName}>{file.originalName}</div>
      {error && <div className="warn-line">✗ {error}</div>}
      <button className="btn btn-primary btn-sm" onClick={onEdit}>Edit &amp; add</button>
    </div>
  )
}
