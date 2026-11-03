import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { packDownloadUrl, type PackManifest } from '../api.js'
import type { StickerView } from '../types.js'
import { PackVerdict } from './StickerSpec.jsx'

export default function InstallDrawer({
  manifest,
  stickers = [],
  building,
  buildProgress,
  onClose,
  onRebuild,
}: {
  manifest: PackManifest & { code: string }
  stickers?: StickerView[]
  building?: boolean
  buildProgress?: { progress: number; stage: string } | null
  onClose: () => void
  onRebuild?: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const deepLink = `stickerforge://pack/${manifest.code}`

  useEffect(() => {
    QRCode.toDataURL(deepLink, {
      margin: 1,
      width: 320,
      color: { dark: '#1c2015', light: '#ece5dd' },
    })
      .then(setQr)
      .catch(() => setQr(null))
  }, [deepLink])

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose} title="Close">✕</button>
        <div className="install-head">
          <h2>✓ Built — <em>{manifest.name}</em> · {manifest.stickers.length} stickers</h2>
          {onRebuild && (
            <div className="install-actions">
              <button className="btn" onClick={onRebuild} disabled={building}>
                {building ? 'Rebuilding…' : '↻ Rebuild'}
              </button>
              {building && buildProgress && (
                <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {buildProgress.stage} · {Math.round(buildProgress.progress * 100)}%
                </span>
              )}
            </div>
          )}        </div>
        <PackVerdict stickers={stickers} />
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
            <p className="handoff-note">
              iPhone or keeping a copy? <a href={packDownloadUrl(manifest.code)} download>⬇ Download the pack (.zip)</a> — the
              stickers are standard animated WebP.
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
