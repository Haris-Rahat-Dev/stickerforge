import { useState } from 'react'
import StickerPreview from './StickerPreview.jsx'
import type { StickerView } from '../types.js'
import { matchesQuery } from '../flow.js'

export { matchesQuery }

const PALETTE = ['😂', '🔥', '💀', '🤣', '👀', '🎬', '😭', '🫡', '❤️', '👍', '🤔', '🙃']

export default function StickerLibrary({
  stickers,
  packsByJob,
  onBack,
  onDelete,
  onSetEmojis,
}: {
  stickers: StickerView[]
  packsByJob: Record<string, string[]>   // jobId → names of packs containing it
  onBack: () => void
  onDelete: (s: StickerView) => void
  onSetEmojis: (jobId: string, emojis: string[]) => void
}) {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const shown = stickers.filter(s => matchesQuery(s, q, packsByJob[s.jobId] ?? []))

  return (
    <main className="content">
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Packs</button>
        <input
          className="search"
          placeholder="search stickers, emojis, packs…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <span className="switch-label">{shown.length} of {stickers.length}</span>
      </div>

      {shown.length === 0 && (
        <div className="empty-box"><p>no stickers match “{q}”</p></div>
      )}

      <div className="grid">
        {shown.map(s => {
          const packs = packsByJob[s.jobId] ?? []
          return (
            <div key={s.jobId} className="card">
              <div className="thumb square">
                <StickerPreview jobId={s.jobId} className="thumb-cover" />
                <span className="sticker-emoji">{s.emojis.join('')}</span>
                {!s.editable && <span className="status-chip locked" title="Source deleted at build">🔒</span>}
              </div>
              <div className="card-body">
                <div className="card-name" title={s.name}>{s.name}</div>
                <div className="meta-line">
                  {packs.length === 0 ? 'in no pack' : `in ${packs.join(', ')}`}
                </div>
                {editing === s.jobId ? (
                  <div className="emoji-picker">
                    {PALETTE.map(e => (
                      <button
                        key={e}
                        className="emoji-opt"
                        onClick={() => { onSetEmojis(s.jobId, [e]); setEditing(null) }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s.jobId)}>Emoji</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => onDelete(s)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
