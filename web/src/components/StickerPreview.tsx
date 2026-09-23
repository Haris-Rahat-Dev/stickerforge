import { webpPreviewUrl } from '../api.js'

// Always the real encoded WebP — the exact bytes the pack ships and WhatsApp renders.
// No <video>/WebM fallback: the WebM is a different (or absent) encode and would
// misrepresent the sticker.
export default function StickerPreview({ jobId, className, onLoad }: { jobId: string; className?: string; onLoad?: () => void }) {
  return <img className={className} src={webpPreviewUrl(jobId)} alt="" onLoad={onLoad} />
}
