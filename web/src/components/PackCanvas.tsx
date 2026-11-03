import StagingShelf from './StagingShelf.jsx'
import StickerSheet from './StickerSheet.jsx'
import { packDownloadUrl, type PackSummary } from '../api.js'
import type { FileRecord, StickerView, UploadProgress } from '../types.js'

export default function PackCanvas(props: {
  pack: PackSummary
  staged: FileRecord[]
  shelfLoading?: boolean
  uploading: UploadProgress[]
  encoding: Record<string, number>
  errors: Record<string, string>
  building: boolean
  buildProgress: { progress: number; stage: string } | null
  buildError: string | null
  onBack: () => void
  onRename: () => void
  onAddMedia: () => void
  onAddExisting: () => void
  onEditStaged: (fileId: string) => void
  onDiscardStaged: (fileId: string) => void
  onReorder: (jobIds: string[]) => void
  onAddAll?: () => void
  batching?: boolean
  onSetPublisher?: () => void
  onSetTray?: (jobId: string) => void
  onSetEmojis?: (jobId: string, emojis: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
  onBuild: () => void
  onShowInstall?: () => void
  installOpen?: boolean
}) {
  const { pack, building, buildError, buildProgress } = props
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
        <span
          className={`status-chip ${pack.stale ? 'encoding' : pack.built ? 'inpack' : 'review'}`}
          title={pack.stale ? 'Changed since the last build — the phone still has the old version' : undefined}
        >
          {pack.stale ? 'Phone out of date' : pack.built ? '✓ Built' : 'Draft'}
        </span>
        {props.onSetPublisher && (
          <button className="btn btn-ghost btn-sm" onClick={props.onSetPublisher} title="Shown under the pack name in WhatsApp">
            by {pack.publisher}
          </button>
        )}
        <button className="btn btn-ghost" onClick={props.onAddMedia}>＋ Add media</button>
        <button className="btn btn-ghost" onClick={props.onAddExisting}>⧉ Add existing</button>
      </div>

      <StagingShelf
        staged={props.staged}
        loading={props.shelfLoading}
        uploading={props.uploading}
        encoding={props.encoding}
        errors={props.errors}
        onEdit={props.onEditStaged}
        onDiscard={props.onDiscardStaged}
        onAddAll={props.onAddAll}
        batching={props.batching}
      />

      <StickerSheet
        stickers={pack.stickers}
        onReorder={props.onReorder}
        trayJobId={pack.trayJobId}
        onSetTray={props.onSetTray}
        onSetEmojis={props.onSetEmojis}
        onFineTune={props.onFineTune}
        onReplace={props.onReplace}
        onRemove={props.onRemove}
        onAddMedia={props.onAddMedia}
        onAddExisting={props.onAddExisting}
      />

      <div className="pack-bar">
        <div className="pack-status">
          <b>{pack.ready}</b> in <em>{pack.name}</em>
          {reason && <span className="muted"> · {reason}</span>}
        </div>
        {buildError && <div className="pack-err">✗ {buildError}</div>}
        {building && buildProgress && (
          <div className="pack-build-progress" title={buildProgress.stage}>
            <div className="pack-build-bar">
              <div className="pack-build-fill" style={{ width: `${Math.round(buildProgress.progress * 100)}%` }} />
            </div>
            <span className="muted">{buildProgress.stage} · {Math.round(buildProgress.progress * 100)}%</span>
          </div>
        )}
        {pack.built && props.onShowInstall && !props.installOpen && (
          <button className="btn btn-ghost btn-sm" type="button" style={{ marginLeft: 8 }} onClick={() => props.onShowInstall?.()}>Show install</button>
        )}
        {pack.built && (
          <a className="btn btn-ghost btn-sm" href={packDownloadUrl(pack.code)} download title="The built pack as a .zip — for iOS (Sticker.ly) or keeping">⬇ .zip</a>
        )}
        <button className="btn btn-primary" disabled={!!reason || building} onClick={props.onBuild}>
          {building ? 'Building…' : pack.stale ? '↻ Rebuild to update phone' : pack.built ? '↻ Rebuild pack' : '⚡ Build pack'}
        </button>
      </div>
    </>
  )
}
