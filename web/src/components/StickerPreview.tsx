import { useState } from 'react'
import { outputPreviewUrl, webpPreviewUrl } from '../api.js'

export default function StickerPreview({ jobId, className }: { jobId: string; className?: string }) {
  const [fallback, setFallback] = useState(false)
  if (fallback) {
    return (
      <video
        className={className}
        src={outputPreviewUrl(jobId)}
        muted loop autoPlay playsInline preload="metadata"
      />
    )
  }
  return (
    <img
      className={className}
      src={webpPreviewUrl(jobId)}
      alt=""
      onError={() => setFallback(true)}
    />
  )
}
