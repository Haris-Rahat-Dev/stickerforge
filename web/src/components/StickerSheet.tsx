import { useRef, useState } from 'react'
import StickerPreview from './StickerPreview.jsx'
import { SpecBadge } from './StickerSpec.jsx'
import EmojiPicker from './EmojiPicker.jsx'
import { useReorderFlip } from '../flip.js'
import { stickerDownloadUrl } from '../api.js'
import type { StickerView } from '../types.js'

const MIN = 3
const MAX = 30

export default function StickerSheet({ stickers, onReorder, onFineTune, onReplace, onRemove, onAddMedia, onAddExisting, trayJobId = null, onSetTray, onSetEmojis }: {
  stickers: StickerView[]
  onReorder: (jobIds: string[]) => void
  /** The chosen tray sticker; null means the build uses the first one. */
  trayJobId?: string | null
  onSetTray?: (jobId: string) => void
  onSetEmojis?: (jobId: string, emojis: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
  onAddMedia?: () => void
  onAddExisting?: () => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [emojiFor, setEmojiFor] = useState<string | null>(null)
  const tray = stickers.some(s => s.jobId === trayJobId) ? trayJobId : stickers[0]?.jobId ?? null
  const gridRef = useRef<HTMLDivElement>(null)
  const captureFlip = useReorderFlip(gridRef, stickers.map(s => s.jobId).join(','))

  // Native HTML5 DnD: drop onto a tile inserts the dragged sticker at that index.
  const dropOn = (targetJobId: string): void => {
    if (!dragging || dragging === targetJobId) return
    const ids = stickers.map(s => s.jobId)
    const from = ids.indexOf(dragging)
    const to = ids.indexOf(targetJobId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    captureFlip()
    onReorder(ids)
    setDragging(null)
  }

  const shortfall = Math.max(0, MIN - stickers.length)
  const empty = stickers.length === 0

  return (
    <section className="sheet">
      <div className="sheet-label">
        Pack · {stickers.length}/{MAX}
        {shortfall > 0 && <span className="muted"> · {shortfall} more to reach WhatsApp's minimum</span>}
      </div>

      {empty && (
        <div className="empty-state sheet-empty">
          <div className="empty-box">
            <div className="empty-icon">✂️</div>
            <h2>Nothing on the sheet</h2>
            <p>the pack is built from what lands here · drop media anywhere in this window</p>
            {onAddMedia && (
              <div className="empty-actions">
                <button className="btn btn-primary" onClick={onAddMedia}>＋ Add media</button>
                {onAddExisting && <button className="btn btn-ghost" onClick={onAddExisting}>⧉ Add existing</button>}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid sheet-grid" ref={gridRef}>
        {stickers.map(s => (
          <div
            key={s.jobId}
            data-flip-key={s.jobId}
            className={`card sticker-tile${dragging === s.jobId ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragging(s.jobId)}
            onDragEnd={() => setDragging(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); dropOn(s.jobId) }}
          >
            <div className="thumb square">
              <StickerPreview jobId={s.jobId} className="thumb-cover" />
              <button
                type="button"
                className="sticker-emoji emoji-btn"
                title="Emojis WhatsApp searches this sticker by — tap to change"
                onClick={() => setEmojiFor(emojiFor === s.jobId ? null : s.jobId)}
              >{s.emojis.join('')}</button>
              {s.jobId === tray && <span className="tray-chip" title="The pack's icon in WhatsApp">★ tray</span>}
              {!s.editable && <span className="status-chip locked" title="Source deleted at build">🔒</span>}
            </div>
            <div className="card-body">
              <div className="card-name" title={s.name}>{s.name}</div>
              <SpecBadge spec={s.spec} />
              {!s.editable && <div className="meta-line">locked · source retired at build</div>}
              {emojiFor === s.jobId && onSetEmojis && (
                <EmojiPicker value={s.emojis} onChange={e => { if (e.length) onSetEmojis(s.jobId, e) }} />
              )}
              <div className="card-actions">
                {s.editable
                  ? <button className="btn btn-ghost btn-sm" onClick={() => onFineTune(s)}>Fine-tune</button>
                  : <button className="btn btn-ghost btn-sm" onClick={() => onReplace(s)}>Replace</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => onRemove(s)}>Remove</button>
                {onSetTray && s.jobId !== tray && (
                  <button className="btn btn-ghost btn-sm" onClick={() => onSetTray(s.jobId)} title="Use this sticker as the pack's icon">★ Tray</button>
                )}
                <a className="btn btn-ghost btn-sm" href={stickerDownloadUrl(s.jobId)} download title="Download this sticker (.webp)">⬇</a>
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
