import { useState } from 'react'
import { outputPreviewUrl } from '../api.js'
import type { StickerView } from '../types.js'

const MIN = 3
const MAX = 30

export default function StickerSheet({ stickers, onReorder, onFineTune, onReplace, onRemove }: {
  stickers: StickerView[]
  onReorder: (jobIds: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)

  // Native HTML5 DnD: drop onto a tile inserts the dragged sticker at that index.
  const dropOn = (targetJobId: string): void => {
    if (!dragging || dragging === targetJobId) return
    const ids = stickers.map(s => s.jobId)
    const from = ids.indexOf(dragging)
    const to = ids.indexOf(targetJobId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    onReorder(ids)
    setDragging(null)
  }

  const shortfall = Math.max(0, MIN - stickers.length)

  return (
    <section className="sheet">
      <div className="sheet-label">
        Pack · {stickers.length}/{MAX}
        {shortfall > 0 && <span className="muted"> · {shortfall} more to reach WhatsApp's minimum</span>}
      </div>
      <div className="grid sheet-grid">
        {stickers.map(s => (
          <div
            key={s.jobId}
            className={`card sticker-tile${dragging === s.jobId ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragging(s.jobId)}
            onDragEnd={() => setDragging(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); dropOn(s.jobId) }}
          >
            <div className="thumb square">
              <video
                className="thumb-cover"
                src={outputPreviewUrl(s.jobId)}
                muted
                loop
                autoPlay
                playsInline
                preload="metadata"
              />
              <span className="sticker-emoji">{s.emojis[0]}</span>
              {!s.editable && <span className="status-chip locked" title="Source deleted at build">🔒</span>}
            </div>
            <div className="card-body">
              <div className="card-name" title={s.name}>{s.name}</div>
              <div className="meta-line">
                {s.sizeBytes ? `${Math.round(s.sizeBytes / 1024)}KB` : '—'}
                {!s.editable && ' · locked'}
              </div>
              <div className="card-actions">
                {s.editable
                  ? <button className="btn btn-ghost btn-sm" onClick={() => onFineTune(s)}>Fine-tune</button>
                  : <button className="btn btn-ghost btn-sm" onClick={() => onReplace(s)}>Replace</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => onRemove(s)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
        {Array.from({ length: shortfall }, (_, i) => (
          <div key={`slot-${i}`} className="card slot-empty">
            <div className="thumb square"><span className="slot-hint">empty slot</span></div>
          </div>
        ))}
      </div>
    </section>
  )
}
