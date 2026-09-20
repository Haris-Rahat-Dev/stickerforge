import { useState } from 'react'
import StickerPreview from './StickerPreview.jsx'
import { matchesQuery } from '../flow.js'
import type { StickerView } from '../types.js'

export default function StickerPicker({
  stickers,
  exclude,
  onPick,
  onClose,
}: {
  stickers: StickerView[]
  exclude: string[]          // jobIds already in this pack
  onPick: (jobId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const available = stickers.filter(s => !exclude.includes(s.jobId) && matchesQuery(s, q, []))

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose} title="Close">✕</button>
        <h2>Add an existing <em>sticker</em></h2>
        <input className="search" placeholder="search…" value={q} onChange={e => setQ(e.target.value)} />
        {available.length === 0 && <p className="meta-line">nothing else to add</p>}
        <div className="grid">
          {available.map(s => (
            <div key={s.jobId} className="card" onClick={() => onPick(s.jobId)}>
              <div className="thumb square">
                <StickerPreview jobId={s.jobId} className="thumb-cover" />
                <span className="sticker-emoji">{s.emojis.join('')}</span>
              </div>
              <div className="card-body"><div className="card-name" title={s.name}>{s.name}</div></div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
