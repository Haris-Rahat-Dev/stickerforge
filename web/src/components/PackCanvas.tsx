import StagingShelf from './StagingShelf.jsx'
import StickerSheet from './StickerSheet.jsx'
import type { PackSummary } from '../api.js'
import type { FileRecord, StickerView, UploadProgress } from '../types.js'

export default function PackCanvas(props: {
  pack: PackSummary
  staged: FileRecord[]
  uploading: UploadProgress[]
  encoding: Record<string, number>
  errors: Record<string, string>
  building: boolean
  buildError: string | null
  onBack: () => void
  onRename: () => void
  onAddMedia: () => void
  onAddExisting: () => void
  onEditStaged: (fileId: string) => void
  onDiscardStaged: (fileId: string) => void
  onReorder: (jobIds: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
  onBuild: () => void
  onShowInstall?: () => void
  installOpen?: boolean
}) {
  const { pack, building, buildError } = props
  const encodingNow = Object.keys(props.encoding).length > 0
  const reason =
    pack.ready < 3
      ? `need ${3 - pack.ready} more sticker${3 - pack.ready === 1 ? '' : 's'}`
      : pack.ready > 30
      ? 'over WhatsApp’s 30-sticker limit'
      : encodingNow
      ? 'waiting for encodes to finish'
      : null

  return (
    <>
      <div className="toolbar canvas-bar">
        <button className="btn btn-ghost btn-sm" onClick={props.onBack}>← Packs</button>
        <button className="pack-title" onClick={props.onRename} title="Rename">{pack.name}</button>
        <span className={`status-chip ${pack.built ? 'inpack' : 'review'}`}>
          {pack.built ? '✓ Built' : 'Draft'}
        </span>
        <button className="btn btn-ghost" onClick={props.onAddMedia}>＋ Add media</button>
        <button className="btn btn-ghost" onClick={props.onAddExisting}>⧉ Add existing</button>
      </div>

      <StagingShelf
        staged={props.staged}
        uploading={props.uploading}
        encoding={props.encoding}
        errors={props.errors}
        onEdit={props.onEditStaged}
        onDiscard={props.onDiscardStaged}
      />

      <StickerSheet
        stickers={pack.stickers}
        onReorder={props.onReorder}
        onFineTune={props.onFineTune}
        onReplace={props.onReplace}
        onRemove={props.onRemove}
      />

      <div className="pack-bar">
        <div className="pack-status">
          <b>{pack.ready}</b> in <em>{pack.name}</em>
          {reason && <span className="muted"> · {reason}</span>}
        </div>
        {buildError && <div className="pack-err">✗ {buildError}</div>}
        {pack.built && props.onShowInstall && !props.installOpen && (
          <button className="btn btn-ghost btn-sm" type="button" style={{ marginLeft: 8 }} onClick={() => props.onShowInstall?.()}>Show install</button>
        )}
        <button className="btn btn-primary" disabled={!!reason || building} onClick={props.onBuild}>
          {building ? 'Building pack…' : pack.built ? '↻ Rebuild pack' : '⚡ Build pack'}
        </button>
      </div>
    </>
  )
}
