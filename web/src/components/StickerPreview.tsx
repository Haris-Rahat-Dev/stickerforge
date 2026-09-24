import { useState } from 'react'
import { webpPreviewUrl } from '../api.js'

// Always the real encoded WebP — the exact bytes the pack ships and WhatsApp renders.
// No <video>/WebM fallback: the WebM is a different (or absent) encode and would
// misrepresent the sticker. Each one is up to ~480KB, so it fades in over the tile's
// shimmer instead of popping in piecemeal.
export default function StickerPreview({ jobId, className, onLoad }: { jobId: string; className?: string; onLoad?: () => void }) {
  const [ready, setReady] = useState(false)
  return (
    <img
      className={`${className ?? ''} fade-img ${ready ? 'is-ready' : ''}`}
      src={webpPreviewUrl(jobId)}
      alt=""
      decoding="async"
      onLoad={() => { setReady(true); onLoad?.() }}
      // A missing file must not shimmer forever.
      onError={() => setReady(true)}
    />
  )
}
