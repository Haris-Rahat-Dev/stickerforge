import type { StickerSpec } from './types.js'

/** WhatsApp's StickerPackValidator rejects an animated sticker over 500 × 1024 bytes. */
const HARD_CAP_BYTES = 500 * 1024
/** Mirrors the server's encode target (server/src/budget.ts). */
export const WEBP_TARGET = HARD_CAP_BYTES - 4 * 1024
export const MAX_STICKER_FPS = 30
/** StickerPackValidator: 10s per animated sticker. */
export const MAX_STICKER_SEC = 10

export function capFps(sourceFps: number): number {
  const n = Math.round(sourceFps)
  if (!Number.isFinite(n) || n <= 0) return MAX_STICKER_FPS
  return Math.min(MAX_STICKER_FPS, n)
}

/**
 * Frame rates the editor offers: the source rate (capped) plus 24/20/15 below it.
 * Never above the source — upsampling a GIF only spends bytes on duplicate frames.
 * 15 is a user choice for length or sharpness; the encoder's own ladder still stops at 24.
 */
export function fpsChoices(sourceFps: number): number[] {
  const top = capFps(sourceFps)
  return [top, 24, 20, 15].filter((f, i, all) => f <= top && all.indexOf(f) === i)
}

/**
 * Next preset length after a byte-budget failure at `len`: the encoder's own figure,
 * scaled from the cheapest rung it could still reach. Null when nothing shorter is left.
 */
export function nextFitLength(len: number, fitSeconds: number): number | null {
  if (!(fitSeconds < len - 0.05)) return null
  return Math.max(0.5, Math.floor(Math.min(fitSeconds, len - 0.1) * 10) / 10)
}

const SSIM_GOOD = 0.93
const SSIM_FLOOR = 0.85

export type SpecState = 'ok' | 'warn' | 'bad'

export interface SpecLine {
  label: string
  value: string
  state: SpecState
}

/**
 * Judge the measured file, never the requested settings: a sticker that encoded at
 * 24fps when 30 was asked for is still correct, and one reported at 512² that the
 * file contradicts is not.
 */
export function specLines(s: StickerSpec): SpecLine[] {
  return [
    {
      label: 'frame',
      value: `${s.width}×${s.height}`,
      state: s.width === 512 && s.height === 512 ? 'ok' : 'bad',
    },
    {
      label: 'weight',
      value: `${Math.round(s.sizeBytes / 1024)}KB`,
      state: s.sizeBytes <= WEBP_TARGET ? 'ok' : s.sizeBytes <= HARD_CAP_BYTES ? 'warn' : 'bad',
    },
    {
      label: 'rate',
      value: `${s.fps}fps`,
      // Only the ceiling is a WhatsApp limit. A motionless trim legitimately holds
      // one frame for seconds; MIN_MOTION_FPS is an encoder target, not a spec floor.
      state: s.fps > MAX_STICKER_FPS ? 'bad' : 'ok',
    },
    {
      label: 'length',
      value: `${s.duration.toFixed(1)}s`,
      state: s.duration <= MAX_STICKER_SEC + 0.05 ? 'ok' : 'bad',
    },
    { label: 'frames', value: `${s.frames}`, state: s.frames > 1 ? 'ok' : 'warn' },
    {
      label: 'detail',
      value: s.ssim === null ? 'n/a' : s.ssim.toFixed(2),
      state: s.ssim === null ? 'warn' : s.ssim >= SSIM_GOOD ? 'ok' : s.ssim >= SSIM_FLOOR ? 'warn' : 'bad',
    },
  ]
}

export const worstState = (lines: SpecLine[]): SpecState =>
  lines.some(l => l.state === 'bad') ? 'bad' : lines.some(l => l.state === 'warn') ? 'warn' : 'ok'
