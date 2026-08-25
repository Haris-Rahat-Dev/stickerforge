import { useEffect, useRef, useState } from 'react'
import { uploadFile, deleteFile, videoUrl, batchConvert, getJob, downloadWebm } from './api.js'
import type { BatchItem, FileRecord, UploadProgress } from './types.js'
import Editor from './components/Editor.jsx'

export default function App() {
  const [files, setFiles] = useState<FileRecord[]>([])
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [batch, setBatch] = useState<{ items: BatchItem[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = async (list: File[]): Promise<void> => {
    for (const f of list) {
      if (!/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name) && !f.type.startsWith('video/')) continue
      const key = `${f.name}-${f.size}`
      setUploads(u => [...u, { key, name: f.name, progress: 0 }])
      try {
        const rec = await uploadFile(f, p => {
          setUploads(u => u.map(x => x.key === key ? { ...x, progress: p } : x))
        })
        setFiles(fs => [...fs, rec])
      } catch (err) {
        alert(`Failed: ${f.name}\n${err instanceof Error ? err.message : 'unknown error'}`)
      } finally {
        setUploads(u => u.filter(x => x.key !== key))
      }
    }
  }

  const removeFile = async (id: string): Promise<void> => {
    await deleteFile(id)
    setFiles(fs => fs.filter(f => f.id !== id))
  }

  const editing = files.find(f => f.id === editingId)

  return (
    <div
      className="app"
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        addFiles([...e.dataTransfer.files])
      }}
    >
      <header className="header">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>Sticker<em>Forge</em></h1>
            <p>video → die-cut stickers</p>
          </div>
        </div>
        <div className="spec-chips">
          <span>WebM · VP9</span><span>512×512</span><span>≤30fps</span><span>≤6s</span><span>&lt;500KB</span>
        </div>
      </header>

      {files.length === 0 && uploads.length === 0 ? (
        <EmptyDropzone onClick={() => inputRef.current?.click()} />
      ) : (
        <main className="content">
          <div className="toolbar">
            <button className="btn btn-ghost" onClick={() => inputRef.current?.click()}>＋ Add videos</button>
            <span className="count">{files.length} video{files.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="grid">
            {files.map(f => <FileCard key={f.id} file={f} onEdit={() => setEditingId(f.id)} onRemove={() => removeFile(f.id)} />)}
          </div>
          {batch && <BatchResults batch={batch} files={files} onEdit={setEditingId} setBatch={setBatch} />}
        </main>
      )}

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

      {files.length > 1 && !batch && (
        <button
          className="fab"
          disabled={uploads.length > 0}
          onClick={async () => {
            const jobs = await batchConvert(files.map(f => f.id))
            setBatch({ items: jobs.map(j => ({ ...j, status: 'running', progress: 0 })) })
          }}
        >
          ⚡ Convert all with defaults
        </button>
      )}

      {dragOver && <div className="drop-overlay"><div>⬇ Drop videos to import</div></div>}
      <input ref={inputRef} type="file" accept="video/*,.mkv" multiple hidden onChange={e => { addFiles([...e.target.files!]); e.target.value = '' }} />
      {editing && <Editor file={editing} onClose={() => setEditingId(null)} />}
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
          <span>② Trim 6s · frame · speed</span>
          <span>③ Export spec-perfect WebM</span>
        </div>
      </div>
    </main>
  )
}

interface FileCardProps {
  file: FileRecord
  onEdit: () => void
  onRemove: () => void
}

function FileCard({ file, onEdit, onRemove }: FileCardProps) {
  const vidRef = useRef<HTMLVideoElement>(null)
  const q = QUALITY[file.quality.level]

  return (
    <div className="card" onClick={onEdit}>
      <div className={`thumb ${file.quality.level}`}>
        <video
          ref={vidRef}
          src={`${videoUrl(file.id)}#t=0.1`}
          muted loop playsInline preload="metadata"
          onMouseEnter={() => vidRef.current?.play().catch(() => {})}
          onMouseLeave={() => { const v = vidRef.current; if (v) { v.pause(); v.currentTime = 0.1 } }}
        />
        <span className={`chip chip-${file.quality.level}`}>{q.label}</span>
        <button className="icon-btn remove" onClick={e => { e.stopPropagation(); onRemove() }}>✕</button>
      </div>
      <div className="card-body">
        <div className="card-name" title={file.originalName}>{file.originalName}</div>
        <div className="meta-line">
          {file.meta.width}×{file.meta.height} · {Math.round(file.meta.fps)}fps · {file.meta.duration.toFixed(1)}s
        </div>
        {file.quality.notes.some(n => n.type === 'warn') && (
          <div className="warn-line">⚠ {file.quality.notes.find(n => n.type === 'warn')?.msg}</div>
        )}
      </div>
    </div>
  )
}

interface BatchResultsProps {
  batch: { items: BatchItem[] }
  files: FileRecord[]
  onEdit: (id: string) => void
  setBatch: React.Dispatch<React.SetStateAction<{ items: BatchItem[] } | null>>
}

function BatchResults({ batch, files, onEdit, setBatch }: BatchResultsProps) {
  const anyRunning = batch.items.some(i => i.status === 'running')

  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(async () => {
      const updates = await Promise.all(
        batch.items.filter(i => i.status === 'running').map(async i => ({
          id: i.jobId,
          job: await getJob(i.jobId).catch(() => null)
        }))
      )
      setBatch(b => b && ({
        ...b,
        items: b.items.map((i): BatchItem => {
          const u = updates.find(x => x.id === i.jobId)
          if (!u?.job) return i
          const { fileId, ...safe } = u.job
          return { ...i, ...safe, fileId }
        })
      }))
    }, 700)
    return () => clearInterval(timer)
  }, [anyRunning])

  const doneCount = batch.items.filter(i => i.status === 'done').length

  return (
    <section className="batch-panel">
      <h3>Batch results — {doneCount}/{batch.items.length} done</h3>
      <table>
        <thead><tr><th>Video</th><th>Status</th><th>Size</th><th>Actions</th></tr></thead>
        <tbody>
          {batch.items.map(item => {
            const f = files.find(x => x.id === item.fileId)
            return (
              <tr key={item.jobId} className={item.status}>
                <td title={f?.originalName}>{f?.originalName || '—'}</td>
                <td>{item.status === 'running' ? `⏳ ${Math.round((item.progress || 0) * 100)}%` : item.status === 'done' ? '✅' : `❌ ${item.error || ''}`}</td>
                <td>{item.sizeBytes ? `${(item.sizeBytes / 1024) | 0} KB` : '—'}</td>
                <td className="row-actions">
                  {item.status === 'done' && <button className="btn btn-sm" onClick={() => downloadWebm(item.jobId, (f?.originalName || 'sticker').replace(/\.[^.]+$/, ''))}>⬇ WebM</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => onEdit(item.fileId)}>Fine-tune</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

const QUALITY: Record<string, { label: string }> = {
  good: { label: '✓ Great' },
  ok: { label: '~ Usable' },
  warn: { label: '! Rough' },
}
