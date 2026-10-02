import { spawn } from 'node:child_process'
import type { ConvertSettings, FitMode, MediaKind } from './types.js'

export function buildFilters(fit: FitMode, padColor = '#000000', cropPos = 0.5, border = false): string {
  const pos = Math.min(1, Math.max(0, cropPos ?? 0.5))
  const S = border ? 460 : 512
  const whitePad = border ? ',pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white' : ''
  switch (fit) {
    case 'contain': {
      const c = (padColor || '#000000').replace('#', '')
      return `scale=${S}:${S}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=0x${c}${whitePad},format=yuv420p`
    }
    case 'stretch':
      return `scale=${S}:${S}:flags=lanczos${whitePad},format=yuv420p`
    case 'cover':
    default:
      return `scale=${S}:${S}:force_original_aspect_ratio=increase:flags=lanczos,crop=${S}:${S}:(iw-${S})*${pos}:(ih-${S})*${pos}${whitePad},format=yuv420p`
  }
}

/**
 * WhatsApp's tray icon: a 96×96 PNG (24–512px, ≤50KB) of the sticker as it ships —
 * same crop, fit and border. ffmpeg's `thumbnail` picks the most representative of the
 * opening frames, so a fade-in or a black first frame doesn't become the pack's icon.
 * A still has no timeline for `fps` to sample, so it is framed as-is.
 */
export function extractTray(inputPath: string, trayPath: string, s: ConvertSettings, kind: MediaKind): Promise<void> {
  const first = s.spans[0] ?? { start: s.start, end: s.end }
  const look = Math.max(0.1, Math.min(3, first.end - first.start))
  const pick = kind === 'video' ? 'fps=10,thumbnail=30,' : ''
  const cropF = s.crop ? `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y},` : ''
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-ss', String(Math.max(0, first.start)), '-t', String(look),
      '-i', inputPath,
      '-vf', `${pick}${cropF}${buildFilters(s.fit, s.padColor, s.cropPos, s.border)},scale=96:96:flags=lanczos`,
      '-frames:v', '1', '-y', trayPath,
    ], { timeout: 60_000, killSignal: 'SIGKILL' })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}
