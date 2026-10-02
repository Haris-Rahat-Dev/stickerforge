import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildFilters } from './convert.js'
import { BAIL_MARGIN, fpsSteps, lowestQuality, MAX_STICKER_SEC, planLadder, qualityCurve, qualityLadder, secondsThatFit, WEBP_TARGET, type SizeSample } from './budget.js'
import { concatPrefix, keptSeconds, type Span } from './spans.js'
import type { ConvertSettings, CropRect, FitMode } from './types.js'

/**
 * The running encode's abort signal, ambient so every ffmpeg/cwebp/img2webp spawned
 * under it is killed on cancel — without threading a signal through each helper.
 * Discarded preset encodes otherwise run to completion and hold an encode slot.
 */
export const encodeSignal = new AsyncLocalStorage<AbortSignal>()

/** No single ffmpeg/libwebp step on a ≤10s sticker legitimately runs this long. */
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000
const spawnOpts = (): { signal?: AbortSignal; timeout: number; killSignal: NodeJS.Signals } => {
  const signal = encodeSignal.getStore()
  return { ...(signal ? { signal } : {}), timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' }
}

export type WebpOptions = Omit<ConvertSettings, 'speed' | 'spans'> & {
  inputPath: string
  outPath: string
  speed?: number
  spans?: Span[]
}

export interface WebpResult {
  sizeBytes: number
  frames: number
  fps: number
  width: number
  height: number
  duration: number
  /**
   * Luma SSIM of the muxed WebP's first frame against the PNG frame that produced
   * it — what the encoder actually kept, on a scale where 1.0 is identical.
   */
  ssim: number | null
}

/** Read back what is actually in the file, rather than trusting what we asked for. */
export async function inspectWebp(outPath: string): Promise<{
  width: number; height: number; frames: number; fps: number; duration: number
}> {
  const info = await capture('webpmux', ['-info', outPath])
  const canvas = /Canvas size:\s*(\d+)\s*x\s*(\d+)/.exec(info)
  const count = /Number of frames:\s*(\d+)/.exec(info)
  const durations = [...info.matchAll(/^\s*\d+:\s+\d+\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)/gm)].map(m => Number(m[1]))
  const totalMs = durations.reduce((s, d) => s + d, 0)
  const duration = totalMs / 1000
  return {
    width: canvas ? Number(canvas[1]) : 0,
    height: canvas ? Number(canvas[2]) : 0,
    frames: count ? Number(count[1]) : 0,
    // Integer millisecond frame durations make the true rate jitter (30 frames over
    // 990ms reads as 30.3fps), and a fractional rate would look like a spec breach.
    fps: duration > 0 ? Math.round(durations.length / duration) : 0,
    duration: Math.round(duration * 1000) / 1000,
  }
}

/**
 * Compare the encoded first frame with the PNG it was built from. Both are 512² PNGs,
 * so timebases match; gray keeps it a luma measure and stops chroma subsampling from
 * dominating the score.
 */
async function frameSsim(referencePng: string, outPath: string, tmp: string): Promise<number | null> {
  const decoded = path.join(tmp, 'decoded.png')
  try {
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', outPath, '-frames:v', '1', decoded])
    } catch {
      // ffmpeg < 7.1 (Ubuntu 22.04's 4.4, i.e. the VM) cannot decode animated WebP, which
      // left every hosted sticker with ssim: null. Frame 1 is a full-canvas keyframe, so
      // libwebp's own tools can pull it out undistorted.
      const first = path.join(tmp, 'frame1.webp')
      await run('webpmux', ['-get', 'frame', '1', outPath, '-o', first])
      await run('dwebp', [first, '-quiet', '-o', decoded])
    }
    // The SSIM summary is logged at info level, so this must not run with -v error.
    const out = await capture('ffmpeg', [
      '-hide_banner', '-nostats', '-i', referencePng, '-i', decoded,
      '-filter_complex', '[0:v]format=gray[a];[1:v]format=gray[b];[a][b]ssim',
      '-frames:v', '1', '-f', 'null', '-',
    ])
    const all = /All:([0-9.]+)/.exec(out)
    return all ? Number(all[1]) : null
  } catch {
    return null
  }
}

async function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, spawnOpts())
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => code === 0 ? resolve(out + err) : reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`)))
    p.on('error', reject)
  })
}

interface HeldFrame {
  path: string
  durationMs: number
}

/** Measure the artefact we actually produced, from the frame that went into it. */
async function verify(outPath: string, referencePng: string | null, tmp: string): Promise<WebpResult> {
  const { size } = await stat(outPath)
  const seen = await inspectWebp(outPath)
  const ssim = referencePng ? await frameSsim(referencePng, outPath, tmp) : null
  return {
    sizeBytes: size, frames: seen.frames, fps: seen.fps,
    width: seen.width, height: seen.height, duration: seen.duration, ssim,
  }
}

export class WebpBudgetError extends Error {
  readonly maxSeconds: number
  readonly sizeBytes: number
  /**
   * `sizeBytes`/`atQ` say what gave it away — a real mux or a projection, possibly well
   * above the floor. The trim hint is scaled from `floorBytes`, the size at the cheapest
   * rung the ladder could still reach: scaling from a q90 mux told users to cut a clip
   * that fits at q30 down to a third of its length.
   */
  constructor(sizeBytes: number, durationSec: number, fps: number, atQ: number, floorBytes = sizeBytes) {
    const maxSeconds = secondsThatFit(durationSec, floorBytes)
    super(`Won't fit at ${Math.round(fps)}fps (${Math.round(sizeBytes / 1024)}KB at q${atQ}). Trim to ~${maxSeconds}s to keep motion.`)
    this.name = 'WebpBudgetError'
    this.maxSeconds = maxSeconds
    this.sizeBytes = sizeBytes
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, spawnOpts())
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)))
    p.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${bin} not found — install libwebp (brew install webp)`))
        return
      }
      reject(err)
    })
  })
}

const SIG_SIDE = 16
/**
 * Two consecutive frames are a "hold" when the whole 16×16 gray strip barely moved.
 * Measured on real material at this scale: a re-encoded photographic still peaks at
 * 0–1, whereas a ticking counter peaks at 6, a mandelbrot zoom at 4–6 and handheld
 * phone footage at 28–55. So the cut is tight and deliberately conservative — a false
 * hold throws away motion, while missing one only forgoes a saving.
 */
const HOLD_MEAN_MAX = 0.5
const HOLD_PEAK_MAX = 2

/**
 * Where frame `i` starts, in whole ms. Durations are differences of these edges, so the
 * rounding never accumulates: 24fps alternates 42/41ms and 6s stays 6000ms, where a flat
 * 42ms per frame ran 0.8% slow and drifted off the editor's playhead.
 */
const frameEdge = (i: number, fps: number): number => Math.round(i * 1000 / fps)

/** Merge consecutive near-identical frames into one longer frame. Motion fps stays; stills don't burn the 500KB budget. */
export function collapseHolds(sigs: Uint8Array[], fps: number): { index: number; durationMs: number }[] {
  const starts: number[] = []
  for (let i = 0; i < sigs.length; i++) {
    if (!starts.length || !isHold(sigs[starts[starts.length - 1]], sigs[i])) starts.push(i)
  }
  return starts.map((index, k) => ({
    index,
    durationMs: frameEdge(starts[k + 1] ?? sigs.length, fps) - frameEdge(index, fps),
  }))
}

export function isHold(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let sum = 0
  let peak = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    if (d > peak) peak = d
    if (sum / a.length > HOLD_MEAN_MAX || peak > HOLD_PEAK_MAX) return false
  }
  return true
}

function splitSigs(buf: Buffer): Uint8Array[] {
  const stride = SIG_SIDE * SIG_SIDE
  const sigs: Uint8Array[] = []
  for (let off = 0; off + stride <= buf.length; off += stride) sigs.push(buf.subarray(off, off + stride))
  return sigs
}

/**
 * Frames that survive a video re-encode are never byte-identical even when the
 * scene is frozen — compressor noise changes every pixel — so frames are compared as
 * 16×16 gray fingerprints instead of hashes.
 */
async function frameSignatures(framesDir: string, count: number, tmp: string): Promise<Uint8Array[]> {
  if (count === 0) return []
  const raw = path.join(tmp, 'sig.gray')
  await run('ffmpeg', [
    '-i', path.join(framesDir, 'f%04d.png'),
    '-vf', `scale=${SIG_SIDE}:${SIG_SIDE}:flags=area,format=gray`, '-f', 'rawvideo', '-y', raw,
  ])
  return splitSigs(await readFile(raw))
}

interface Framing {
  speed: number
  crop: CropRect | null
  fit: FitMode
  padColor: string
  cropPos: number
  border: boolean
}

/**
 * The sticker's own picture at `fps`. Speed and frame decimation come first so crop and
 * the lanczos scale only touch frames that ship — at 8× or from a 60fps phone clip the
 * old order scaled up to ten frames for every one it kept.
 */
function stickerChain(f: Framing, fps: number): string {
  const cropF = f.crop ? `crop=${f.crop.w}:${f.crop.h}:${f.crop.x}:${f.crop.y},` : ''
  return `setpts=PTS/${f.speed},fps=${fps},${cropF}${buildFilters(f.fit, f.padColor, f.cropPos, f.border)}`
}

/**
 * Input and filter arguments for the kept spans. One span seeks with -ss/-t. Several
 * seek to just before the first and trim relative to that point, so a cut at 50s no
 * longer decodes the first 50s of the source on every probe and encode.
 */
function sourceArgs(inputPath: string, spans: Span[], chain: string): string[] {
  if (spans.length < 2) {
    const s = spans[0]
    return ['-ss', String(s.start), '-t', String(Math.max(0.1, s.end - s.start)), '-i', inputPath, '-vf', chain]
  }
  const offset = Math.max(0, spans[0].start - 1)
  const until = spans[spans.length - 1].end - offset + 0.5
  // A concat references [0:v] once per span, which a simple -vf graph rejects.
  return [
    '-ss', String(offset), '-t', String(until), '-i', inputPath,
    '-filter_complex', `${concatPrefix(spans, offset)}${chain}[out]`, '-map', '[out]',
  ]
}

/**
 * How many frames the encoder will actually mux over the kept spans: the real sticker
 * chain at 16×16, same hold rule. A failure returns 0 so the caller encodes anyway.
 */
async function probeHoldCount(inputPath: string, spans: Span[], f: Framing, fps: number, tmp: string): Promise<number> {
  const raw = path.join(tmp, `probe-${Math.round(fps * 100)}.gray`)
  const chain = `${stickerChain(f, fps)},scale=${SIG_SIDE}:${SIG_SIDE}:flags=area,format=gray`
  try {
    await run('ffmpeg', [...sourceArgs(inputPath, spans, chain), '-f', 'rawvideo', '-y', raw])
  } catch {
    return 0
  }
  const sigs = splitSigs(await readFile(raw).catch(() => Buffer.alloc(0)))
  return sigs.length ? collapseHolds(sigs, fps).length : 0
}

async function holdItems(framesDir: string, frames: string[], fps: number, tmp: string): Promise<HeldFrame[]> {
  const sigs = await frameSignatures(framesDir, frames.length, tmp)
  // If the signatures don't line up one-for-one, extract no holds rather than
  // mis-pairing a frame with the wrong fingerprint.
  const runs = sigs.length === frames.length
    ? collapseHolds(sigs, fps)
    : frames.map((_, i) => ({ index: i, durationMs: frameEdge(i + 1, fps) - frameEdge(i, fps) }))
  return runs.map(h => ({ path: frames[h.index], durationMs: Math.max(8, h.durationMs) }))
}

/** Sticker seconds a size sample covers: enough deltas to average, cheap enough to run live. */
const SAMPLE_SEC = 1.5

/**
 * Bytes per muxed frame for this footage at each quality: a contiguous run of real
 * frames (true deltas, not every-Nth frames that cost nearly a keyframe each), from ~40%
 * into the first span where motion has usually got going, holds collapsed like the
 * real encode. Null when the sample cannot be built.
 */
async function sampleFrameCost(
  inputPath: string, spans: Span[], f: Framing, fps: number, qs: number[], tmp: string,
): Promise<SizeSample[] | null> {
  const first = spans[0]
  const firstLen = first.end - first.start
  const srcSec = Math.min(firstLen, SAMPLE_SEC * f.speed)
  const from = first.start + Math.max(0, (firstLen - srcSec) * 0.4)
  const dir = path.join(tmp, `sample-${Math.round(fps * 100)}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    await run('ffmpeg', [
      '-ss', String(from), '-t', String(Math.max(0.1, srcSec)), '-i', inputPath,
      '-vf', stickerChain(f, fps), path.join(dir, 'f%04d.png'),
    ])
    const frames = (await readdir(dir)).filter(n => n.endsWith('.png')).sort().map(n => path.join(dir, n))
    if (frames.length === 0) return null
    const held = await holdItems(dir, frames, fps, tmp)
    const out: SizeSample[] = []
    for (const q of qs) {
      const file = path.join(dir, `s-q${q}.webp`)
      await muxImg2Webp(held, file, q)
      out.push({ q, bytes: (await stat(file)).size / held.length })
    }
    return out
  } catch {
    return null
  }
}

interface TierModel {
  /** Frames the encoder will mux at this fps after hold-merging. */
  held: number
  bytesAt: (q: number) => number
}

/**
 * Projected sticker bytes at one fps: the hold count over the whole kept range times the
 * sampled per-frame cost. Measured at q70 (where a higher fps gives up) and the floor
 * (where the encode fails), so the two decisions that matter are read, not extrapolated.
 */
async function modelTier(inputPath: string, spans: Span[], f: Framing, fps: number, lowestQ: number, tmp: string): Promise<TierModel | null> {
  const held = await probeHoldCount(inputPath, spans, f, fps, tmp)
  if (held <= 0) return null
  const cost = await sampleFrameCost(inputPath, spans, f, fps, lowestQ < 70 ? [70, lowestQ] : [90, 70], tmp)
  if (!cost) return null
  const perFrame = qualityCurve(cost[0], cost[1])
  return { held, bytesAt: q => perFrame(q) * held }
}

/**
 * A still image → motionless animated WebP: frame it to 512×512, then mux two
 * identical frames so it counts as animated (WhatsApp rejects a static sticker in
 * an animated pack).
 */
export async function imageToAnimatedWebp(opts: WebpOptions): Promise<WebpResult> {
  const { inputPath, outPath, fit, padColor, crop, cropPos, border } = opts
  const tmp = fs_mkdtemp()
  await mkdir(tmp, { recursive: true })
  try {
    const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''
    const filters = buildFilters(fit, padColor, cropPos, border)
    const png = path.join(tmp, 'f.png')
    const webp = path.join(tmp, 'f.webp')
    await run('ffmpeg', ['-y', '-i', inputPath, '-vf', `${cropF}${filters}`, '-frames:v', '1', png])
    for (const q of [90, 75, 60, 45]) {
      await run('cwebp', [png, '-q', String(q), '-quiet', '-o', webp])
      await run('webpmux', ['-frame', webp, '+250', '-frame', webp, '+250', '-loop', '0', '-o', outPath])
      const { size } = await stat(outPath)
      if (size <= WEBP_TARGET) return await verify(outPath, png, tmp)
    }
    return await verify(outPath, png, tmp)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export interface EstimateResult {
  fits: boolean
  keptSeconds: number
  fps: number             // the rate the encoder's ladder would land on
  effectiveFps: number    // after hold-merging — the average the sticker will report
  projectedKB: number     // estimated size at the quality it would land on
  qNeeded: number         // the rung it would land on
  quality: 'crisp' | 'good' | 'soft' | 'very soft'
  maxSeconds: number      // longest kept time (source seconds) that would still fit
}

function qualityLabel(q: number): EstimateResult['quality'] {
  if (q >= 75) return 'crisp'
  if (q >= 55) return 'good'
  if (q >= 40) return 'soft'
  return 'very soft'
}

const framingOf = (o: Pick<ConvertSettings, 'crop' | 'fit' | 'padColor' | 'cropPos' | 'border'> & { speed?: number }): Framing => ({
  speed: o.speed && o.speed > 0 ? o.speed : 1,
  crop: o.crop, fit: o.fit, padColor: o.padColor, cropPos: o.cropPos, border: o.border,
})

/**
 * Live projection of what the current framing/trim would produce, without a full
 * encode: the encoder's own fps/quality ladder run on sampled sizes, so the fps and
 * quality shown are the ones the encode lands on. An estimate, not a guarantee — the
 * real encode still fails closed at WEBP_TARGET.
 */
export async function estimateSticker(inputPath: string, opts: ConvertSettings): Promise<EstimateResult> {
  const spans = opts.spans && opts.spans.length ? opts.spans : [{ start: opts.start, end: opts.end }]
  const kept = keptSeconds(spans)
  const framing = framingOf(opts)
  const outDur = kept / framing.speed
  const steps = fpsSteps(opts.fps)
  const lowestQ = lowestQuality(opts.minQ)
  // Bias conservative: the sample is one stretch of the clip, which can be calmer than
  // the rest. Better to say "trim a hair" than green-light a clip that fails on Add.
  const target = WEBP_TARGET * 0.94
  const tmp = fs_mkdtemp()
  await mkdir(tmp, { recursive: true })
  try {
    const tiers = new Map<number, TierModel>()
    for (const [i, fps] of steps.entries()) {
      const model = await modelTier(inputPath, spans, framing, fps, lowestQ, tmp)
      if (!model) throw new Error('size sample failed')
      tiers.set(fps, model)
      // A rate that keeps q70 is where the encoder stops; lower rates are never tried.
      if (i < steps.length - 1 && model.bytesAt(70) <= target) break
    }
    const land = planLadder(steps, lowestQ, (fps, q) => tiers.get(fps)?.bytesAt(q) ?? Infinity, target)
    const held = tiers.get(land.fps)?.held ?? Math.round(outDur * land.fps)
    return {
      fits: land.fits,
      keptSeconds: Math.round(kept * 100) / 100,
      fps: land.fps,
      effectiveFps: Math.min(land.fps, Math.max(1, Math.round(held / Math.max(0.1, outDur)))),
      projectedKB: Math.round(land.bytes / 1024),
      qNeeded: land.q,
      quality: qualityLabel(land.q),
      maxSeconds: land.fits
        ? Math.min(MAX_STICKER_SEC * framing.speed, kept)
        : Math.round(secondsThatFit(outDur, land.floorBytes, target) * framing.speed * 10) / 10,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Animated WebP for WhatsApp third-party sticker packs.
 * ffmpeg frames → img2webp (WebPAnimEncoder: mixed + delta frames).
 * Quality first, then fps down to 24 — never the old 8fps keyframe dump.
 *
 * `progress` reports 0..1 across the whole phase. Muxing is the slow part and used to
 * report nothing, so the UI sat at 0% for minutes and looked hung.
 */
export async function convertToAnimatedWebp(
  opts: WebpOptions,
  progress?: (p: number, stage: string) => void,
): Promise<WebpResult> {
  const { inputPath, outPath, start, end, fps, minQ } = opts
  const spans: Span[] = opts.spans && opts.spans.length ? opts.spans : [{ start, end }]
  const framing = framingOf(opts)
  const outDur = Math.max(0.3, keptSeconds(spans) / framing.speed)
  const tmp = fs_mkdtemp()
  const framesDir = path.join(tmp, 'frames')
  await mkdir(framesDir, { recursive: true })

  try {
    const steps = fpsSteps(fps)
    // Floor for the LAST fps only. A busy photographic clip at 512²/24fps needs q≈30
    // to fit 4s under 500KB; presets ask for 50 and refit shorter instead.
    const lowestQ = lowestQuality(minQ)
    let lastSize = 0
    let lastFps = steps[0]

    for (const [tier, outFps] of steps.entries()) {
      const isLast = tier === steps.length - 1
      const base = tier / steps.length
      const span = 1 / steps.length
      const rungs = qualityLadder(isLast, lowestQ)
      const floorQ = rungs[rungs.length - 1]

      // A sampled projection before extracting every frame: a rate that misses even at
      // its cheapest rung is skipped (or, last, fails with a trim that fits), and the
      // ladder starts near where the clip lands instead of muxing q90 and q80 for nothing.
      progress?.(base, 'Checking size')
      const model = await modelTier(inputPath, spans, framing, outFps, lowestQ, tmp)
      let startAt = 0
      if (model) {
        const floor = model.bytesAt(floorQ)
        if (floor > WEBP_TARGET * BAIL_MARGIN) {
          if (isLast) throw new WebpBudgetError(floor, outDur, outFps, floorQ)
          progress?.(base + span, `${Math.round(outFps)}fps won't fit — trying a lower rate`)
          continue
        }
        // ponytail: one rung of headroom above the projected landing. A projection that is
        // pessimistic by two or more rungs costs that much quality; climb back up if seen.
        const landing = rungs.findIndex(q => model.bytesAt(q) <= WEBP_TARGET)
        startAt = Math.max(0, (landing < 0 ? rungs.length - 1 : landing) - 1)
      }

      await rm(framesDir, { recursive: true, force: true })
      await mkdir(framesDir, { recursive: true })
      progress?.(base, `Extracting ${Math.round(outFps)}fps frames`)
      await runWithProgress('ffmpeg', [
        '-progress', 'pipe:1', '-nostats',
        ...sourceArgs(inputPath, spans, stickerChain(framing, outFps)),
        `${framesDir}/f%04d.png`,
      ], f => progress?.(base + f * span * 0.5, `Extracting ${Math.round(outFps)}fps frames`), outDur)

      const frames = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort()
        .map(f => path.join(framesDir, f))
      if (frames.length === 0) throw new Error('no frames extracted')
      lastFps = outFps
      const held = await holdItems(framesDir, frames, outFps, tmp)
      progress?.(base + span * 0.6, 'Measuring motion')

      const ladder = rungs.slice(startAt)
      const samples: SizeSample[] = []
      let nextFps = false
      for (const [n, q] of ladder.entries()) {
        progress?.(base + span * (0.65 + 0.35 * (n / ladder.length)), `Muxing q${q}`)
        await muxImg2Webp(held, outPath, q)
        const { size } = await stat(outPath)
        lastSize = size
        if (size <= WEBP_TARGET) return await verify(outPath, held[0]?.path ?? null, tmp)
        samples.push({ q, bytes: size })
        // Two full muxes give this clip's own quality curve. If even its floor misses
        // clearly, the remaining muxes are minutes of a 1 GB VM doing nothing useful.
        if (samples.length >= 2) {
          const floor = qualityCurve(samples[samples.length - 2], samples[samples.length - 1])(floorQ)
          if (floor > WEBP_TARGET * BAIL_MARGIN) {
            if (isLast) throw new WebpBudgetError(size, outDur, outFps, q, floor)
            nextFps = true
            break
          }
        }
      }
      if (nextFps) progress?.(base + span, `${Math.round(outFps)}fps won't fit — trying a lower rate`)
    }
    throw new WebpBudgetError(lastSize, outDur, lastFps, lowestQ)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function runWithProgress(
  bin: string,
  args: string[],
  onFraction: (f: number) => void,
  totalSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, spawnOpts())
    let err = ''
    let buf = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.stdout.on('data', d => {
      buf += d.toString()
      const m = /out_time_us=(\d+)/.exec(buf)
      if (m && totalSec > 0) onFraction(Math.min(1, Number(m[1]) / 1e6 / totalSec))
      if (buf.length > 8192) buf = buf.slice(-1024)
    })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)))
    p.on('error', reject)
  })
}

// Keyframe every ≤6 frames. Lossy delta frames reuse the previous frame wherever a pixel
// moved less than a q-dependent threshold (≈10–15 levels at q30–50), so error builds up
// frame on frame as ghosting until the next keyframe. Measured on Cat at 15fps/q30
// (libwebp 1.2.2 and 1.6.0 alike): kmax 15 → worst-frame SSIM 0.941, kmax 6 → 0.953,
// for +2KB. Mostly-static clips pay ~10% more bytes; kmax 3 cost them ~37%.
const IMG2WEBP_HEAD = ['-mixed', '-sharp_yuv', '-loop', '0', '-kmin', '2', '-kmax', '6']
const img2webpSkip = new Set<string>()

export function unknownImg2webpFlag(message: string): string | null {
  return /Unknown option \[(-[\w]+)\]/.exec(message)?.[1] ?? null
}

export async function muxImg2Webp(frames: HeldFrame[], outPath: string, q: number): Promise<void> {
  if (frames.length === 0) throw new Error('no frames to mux')
  // A trim with no motion at all collapses to a single held frame. Feeding img2webp
  // the same picture twice still yields a *static* WebP — it dedupes them — and
  // WhatsApp refuses a static image inside an animated pack. Two webpmux frames of
  // half the duration are the same picture and a real animation chunk.
  if (frames.length === 1) {
    const half = Math.max(8, Math.round(frames[0].durationMs / 2))
    const still = path.join(path.dirname(frames[0].path), `still-q${q}.webp`)
    await run('cwebp', [frames[0].path, '-q', String(q), '-quiet', '-o', still])
    await run('webpmux', ['-frame', still, `+${half}`, '-frame', still, `+${half}`, '-loop', '0', '-o', outPath])
    return
  }
  const list = path.join(path.dirname(frames[0].path), `img2webp-q${q}.args`)
  for (;;) {
    const lines = IMG2WEBP_HEAD.filter(f => !img2webpSkip.has(f))
    for (const f of frames) {
      // -m 6 is libwebp's slowest effort. 4 is cwebp's default; the quality ladder
      // still drops q if the file misses the size cap.
      lines.push('-d', String(f.durationMs), '-lossy', '-q', String(q), '-m', '4', f.path)
    }
    lines.push('-o', outPath)
    await writeFile(list, lines.join('\n'))
    try {
      await run('img2webp', [list])
      return
    } catch (err) {
      const flag = unknownImg2webpFlag(err instanceof Error ? err.message : '')
      if (!flag || img2webpSkip.has(flag)) throw err
      img2webpSkip.add(flag)
    }
  }
}

function fs_mkdtemp(): string {
  return path.join(os.tmpdir(), `sf-webp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}
