/** WhatsApp's StickerPackValidator rejects an animated sticker over 500 × 1024 bytes. */
export const WEBP_HARD_CAP = 500 * 1024
/** The encoder measures the real file, so this margin is insurance, not estimate slack. */
export const WEBP_TARGET = WEBP_HARD_CAP - 4 * 1024
export const MIN_MOTION_FPS = 24
export const MAX_STICKER_FPS = 30
/** StickerPackValidator: ANIMATED_STICKER_TOTAL_DURATION_MAX = 10s (6s is Sticker.ly's cap). */
export const MAX_STICKER_SEC = 10
/**
 * A projection only stops work when it misses by this much. Sampled projections carry
 * ~10% error either way; a near miss is cheaper to settle with a real mux than to refuse.
 */
export const BAIL_MARGIN = 1.1

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

/** `minQ` from the request, clamped to what the ladder can honour. */
export function lowestQuality(minQ?: number): number {
  return Math.min(70, Math.max(30, minQ ?? 30))
}

/**
 * The rungs tried at one fps. While a lower fps remains, quality stays ≥70: 24fps at q70
 * beats 30fps mush. Only the last fps goes down to the floor.
 */
export function qualityLadder(isLast: boolean, lowestQ: number): number[] {
  const top = [90, 80, 70]
  return isLast ? [...top, ...[60, 50, 40, 30].filter(q => q >= lowestQ && q < 70)] : top
}

/** Shrink a span in proportion to how far its projected size misses the cap. */
export function secondsThatFit(spanSec: number, projectedBytes: number, target = WEBP_TARGET): number {
  if (projectedBytes <= target || projectedBytes <= 0) return spanSec
  const scaled = spanSec * (target / projectedBytes)
  return Math.min(MAX_STICKER_SEC, Math.max(0.5, Math.floor(scaled * 10) / 10))
}

export interface SizeSample {
  q: number
  bytes: number
}

/**
 * Bytes at any quality from two measured points: b(q) = b₂·(q/q₂)^e. Measured exponents
 * run ~0.5 (flat 30–50) to ~2.7 (steep 80–90), so the clamp only rejects noise.
 */
export function qualityCurve(a: SizeSample, b: SizeSample): (q: number) => number {
  const usable = a.q !== b.q && a.bytes > 0 && b.bytes > 0
  const raw = usable ? Math.log(a.bytes / b.bytes) / Math.log(a.q / b.q) : 1
  const e = Math.min(4, Math.max(0.3, Number.isFinite(raw) ? raw : 1))
  return q => b.bytes * Math.pow(q / b.q, e)
}

/** Where the ladder lands: the first (fps, q) whose bytes fit, else the last fps at the floor. */
export interface LadderLanding {
  fits: boolean
  fps: number
  q: number
  bytes: number
  /** Bytes at the last fps and the floor quality — what any shorter trim is scaled from. */
  floorBytes: number
}

/**
 * The encoder's whole ladder, run on a size model instead of muxes. The estimate shows
 * this landing and the encoder uses it to skip rungs, so the two cannot disagree on
 * which fps and quality a clip ends at.
 */
export function planLadder(
  steps: number[],
  lowestQ: number,
  bytesAt: (fps: number, q: number) => number,
  target = WEBP_TARGET,
): LadderLanding {
  const last = steps[steps.length - 1]
  const floorBytes = bytesAt(last, lowestQ)
  for (const [i, fps] of steps.entries()) {
    for (const q of qualityLadder(i === steps.length - 1, lowestQ)) {
      const bytes = bytesAt(fps, q)
      if (bytes <= target) return { fits: true, fps, q, bytes, floorBytes }
    }
  }
  return { fits: false, fps: last, q: lowestQ, bytes: floorBytes, floorBytes }
}
