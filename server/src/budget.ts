export const WEBP_TARGET = 480 * 1024
export const MIN_MOTION_FPS = 24
export const MAX_STICKER_FPS = 30
export const MAX_STICKER_SEC = 6

// Conservative mixed-lossy 512²: one keyframe + cheap deltas.
// Ceiling: busy 3D can overrun; the encoder still fails closed with a trim hint.
const KEYFRAME_BYTES = 25_000
const DELTA_BYTES = 3_800

export function capFps(sourceFps: number): number {
  const n = Math.round(sourceFps)
  if (!Number.isFinite(n) || n <= 0) return MAX_STICKER_FPS
  return Math.min(MAX_STICKER_FPS, n)
}

/** Quality-first ladder. Never upsample. Never drop below 24 unless source is already slower. */
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
