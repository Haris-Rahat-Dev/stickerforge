import type { StickerSpec } from './types.js'

export const WEBP_TARGET = 480 * 1024
export const MIN_MOTION_FPS = 24
export const MAX_STICKER_FPS = 30
export const MAX_STICKER_SEC = 6

const KEYFRAME_BYTES = 25_000
const DELTA_BYTES = 3_800

export function capFps(sourceFps: number): number {
  const n = Math.round(sourceFps)
  if (!Number.isFinite(n) || n <= 0) return MAX_STICKER_FPS
  return Math.min(MAX_STICKER_FPS, n)
}

export function fpsSteps(sourceFps: number): number[] {
  const top = capFps(sourceFps)
  if (top <= MIN_MOTION_FPS) return [top]
  return [top, MIN_MOTION_FPS]
}

export function estimatedBytes(durationSec: number, fps: number): number {
  const frames = Math.max(1, Math.round(Math.max(0, durationSec) * fps))
  return KEYFRAME_BYTES + (frames - 1) * DELTA_BYTES
}

export function maxSecondsForMotion(fps: number): number {
  const f = Math.max(1, fps)
  for (let tenths = MAX_STICKER_SEC * 10; tenths >= 3; tenths--) {
    const s = tenths / 10
    if (estimatedBytes(s, f) <= WEBP_TARGET) return s
  }
  return 0.3
}

export function motionBudget(durationSec: number, sourceFps: number): {
  fps: number
  ok: boolean
  tight: boolean
  maxSeconds: number
} {
  const fps = capFps(sourceFps)
  const maxSeconds = maxSecondsForMotion(fps)
  return {
    fps,
    ok: durationSec <= MAX_STICKER_SEC + 0.01,
    tight: durationSec > maxSeconds + 0.01,
    maxSeconds,
  }
}

/** WhatsApp's hard ceiling; WEBP_TARGET is the margin we aim inside. */
const HARD_CAP_BYTES = 500 * 1024
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
