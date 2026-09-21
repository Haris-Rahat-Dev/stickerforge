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

/**
 * `-t` is applied to the *input*, but `setpts=PTS/speed` compresses the timeline
 * afterwards — so the two numbers are not the same thing. Reading `outDur` seconds
 * of source at 2× played back half the requested clip; reading `srcSpan` gets the
 * whole range and lets the speed filter decide how long that takes.
 */
export function planSpan(startSec: number, endSec: number, speed: number): { srcSpan: number; outDur: number } {
  const srcSpan = Math.max(0.1, endSec - startSec)
  const s = speed > 0 ? speed : 1
  return { srcSpan, outDur: Math.max(0.3, srcSpan / s) }
}

/** Longest source trim that still yields a legal output at this speed. */
export function maxSrcSpanForSpeed(speed: number): number {
  const s = speed > 0 ? speed : 1
  return MAX_STICKER_SEC * s
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

/** Where the trim opens: the whole clip, capped at 6s and at what this fps can fit. */
export function openingTrimEnd(durationSec: number, sourceFps: number): number {
  const duration = Math.max(0, durationSec)
  const keep = maxSecondsForMotion(capFps(sourceFps))
  return Math.min(duration, MAX_STICKER_SEC, keep)
}

/**
 * A higher fps whose held frames already miss the byte budget is not worth muxing.
 * The last fps still muxes: the estimate is pessimistic for flat animation.
 */
export function skipFpsBeforeMux(heldFrames: number, fps: number, isLast: boolean): boolean {
  if (isLast || heldFrames <= 0 || fps <= 0) return false
  return estimatedBytes(heldFrames / fps, fps) > WEBP_TARGET
}

/** Longest opening span: the probed window when its holds fit, otherwise the safe trim. */
export function fitSpanSeconds(durationSec: number, sourceFps: number, heldFrames: number): number {
  const fps = capFps(sourceFps)
  const window = Math.min(Math.max(0, durationSec), MAX_STICKER_SEC)
  if (heldFrames > 0 && fps > 0 && estimatedBytes(heldFrames / fps, fps) <= WEBP_TARGET) return window
  return openingTrimEnd(durationSec, sourceFps)
}

/**
 * One real keyframe plus the per-frame cost of a short mux, scaled to the held
 * frame count. The flat 4KB model is optimistic on detailed footage.
 */
export function projectAnimatedBytes(
  keyBytes: number,
  sampleBytes: number,
  sampleFrames: number,
  heldFrames: number,
): number {
  const held = Math.max(1, heldFrames)
  if (sampleFrames <= 1 || keyBytes <= 0) return Math.max(0, Math.round(Math.max(keyBytes, sampleBytes)))
  const delta = Math.max(0, (sampleBytes - keyBytes) / (sampleFrames - 1))
  return Math.round(keyBytes + (held - 1) * delta)
}

/** Shrink a span in proportion to how far its projected size misses the cap. */
export function secondsThatFit(spanSec: number, projectedBytes: number, target = WEBP_TARGET): number {
  if (projectedBytes <= target || projectedBytes <= 0) return spanSec
  const scaled = spanSec * (target / projectedBytes)
  return Math.min(MAX_STICKER_SEC, Math.max(0.5, Math.floor(scaled * 10) / 10))
}

/**
 * One mux is already so far over the cap that even a squared quality drop to the
 * cheapest rung misses. Stops the ladder before q80 and q70 on detailed footage.
 */
export function firstMuxNeverFits(bytes: number, q: number, lowestQ: number, target: number): boolean {
  if (bytes <= target || q <= 0) return false
  if (q <= lowestQ) return true
  return bytes * (lowestQ / q) ** 2 > target
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

export interface SizeSample {
  q: number
  bytes: number
}

/**
 * Can the cheapest rung of the ladder possibly fit?
 *
 * Muxing is the expensive part of an encode — eight full passes over 124 frames on a
 * 1 GB VM is minutes — and a clip that comes out at 747KB on q50 was never going to
 * reach 480KB. Two measurements at the same frame count give the quality exponent;
 * the frame ratio then carries the projection to the last rung. The margin keeps it
 * conservative: it only bails when even a generous reading of the curve fails.
 */
export function projectedNeverFits(
  samples: SizeSample[],
  frameRatio: number,
  lowestQ: number,
  target: number,
): boolean {
  if (samples.length < 2) return false
  const [a, b] = [samples[samples.length - 2], samples[samples.length - 1]]
  if (a.q <= b.q || a.bytes <= 0 || b.bytes <= 0) return false
  const exponent = Math.log(a.bytes / b.bytes) / Math.log(a.q / b.q)
  // Clamp: below 1 the curve is implausibly flat, above 4 it is noise-driven.
  const e = Math.min(4, Math.max(1, exponent))
  const projected = b.bytes * Math.pow(lowestQ / b.q, e) * Math.max(0, frameRatio)
  return projected > target
}
