import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { linkPhone } from '../api.js'

/**
 * Pair the Android app with this account, so clips shared from the phone's gallery land
 * in this staging shelf. Opening this makes a new link and retires the previous phone's.
 */
export default function LinkPhone({ onClose }: { onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    linkPhone()
      .then(({ link }) => QRCode.toDataURL(link, { margin: 1, width: 320, color: { dark: '#1c2015', light: '#ece5dd' } }))
      .then(url => { if (live) setQr(url) })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not create a link') })
    return () => { live = false }
  }, [])

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer link-drawer" onClick={e => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose} title="Close">✕</button>
        <h2>📱 Link your phone</h2>
        <div className="install-cols">
          <div className="qr-col">
            {qr ? <img className="qr" src={qr} alt="Scan with your phone camera" /> : <div className="qr placeholder" />}
            {error && <div className="warn-line">✗ {error}</div>}
          </div>
          <div className="handoff-col">
            <ol className="handoff">
              <li><b>Scan the QR</b> with your phone camera and open it in StickerForge.</li>
              <li>In your gallery, <b>Share</b> a clip (or several) → <b>StickerForge</b>.</li>
              <li>They appear in <b>Staging</b> on any pack here. <b>Add all as Short</b> turns them into stickers.</li>
            </ol>
            <p className="handoff-note">The link only lets that phone upload into your account. Linking again unlinks the previous phone.</p>
          </div>
        </div>
      </aside>
    </div>
  )
}
