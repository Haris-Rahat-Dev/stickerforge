import type { PackSummary } from '../api.js'

export default function PacksHome({
  packs,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onOpenStickers,
}: {
  packs: PackSummary[]
  onOpen: (code: string) => void
  onNew: () => void
  onRename: (code: string) => void
  onDelete: (code: string) => void
  onOpenStickers?: () => void
}) {
  if (packs.length === 0) {
    return (
      <main className="empty" onClick={onNew}>
        <div className="empty-box">
          <div className="empty-icon">📦</div>
          <h2>No packs <em>yet</em></h2>
          <p>a pack is 3–30 stickers, ready for WhatsApp</p>
          <div className="empty-steps"><span>＋ Start your first pack</span></div>
        </div>
      </main>
    )
  }

  return (
    <main className="content">
      <div className="toolbar">
        <button className="btn btn-primary" onClick={onNew}>＋ New pack</button>
        {onOpenStickers && (
          <button className="btn btn-ghost" onClick={onOpenStickers}>All stickers</button>
        )}
        <span className="switch-label">{packs.length} pack{packs.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid">
        {packs.map(p => (
          <div key={p.code} className="card pack-card" onClick={() => onOpen(p.code)}>
            <div className="thumb square pack-tray">
              {p.stickers && p.stickers.length > 0
                ? <img className="thumb-cover" src={`/api/pack/${p.code}/file/tray.png`} alt=""
                    onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                : <div className="pack-tray-empty">📦</div>}
              <span className={`status-chip ${p.built ? 'inpack' : 'review'}`}>
                {p.built ? '✓ Built' : 'Draft'}
              </span>
            </div>
            <div className="card-body">
              <div className="card-name" title={p.name}>{p.name}</div>
              <div className="meta-line">
                {p.ready} sticker{p.ready === 1 ? '' : 's'}
                {p.ready < 3 && <> · need {3 - p.ready} more</>}
                {p.builtAt && <> · built {new Date(p.builtAt).toLocaleDateString()}</>}
              </div>
              <div className="card-actions">
                <button className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onRename(p.code) }}>Rename</button>
                <button className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onDelete(p.code) }}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
