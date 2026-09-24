import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildFilters } from './convert.js'
import { estimatedBytes, firstMuxNeverFits, fpsSteps, MAX_STICKER_SEC, planSpan, projectAnimatedBytes, projectedNeverFits, secondsThatFit, skipFpsBeforeMux, WEBP_TARGET, type SizeSample } from './budget.js'
import { concatPrefix, keptSeconds, type Span } from './spans.js'
import type { ConvertSettings } from './types.js'

/**
 * The running encode's abort signal, ambient so every ffmpeg/cwebp/img2webp spawned
 * under it is killed on cancel — without threading a signal through each helper.
 * Discarded preset encodes otherwise run to completion and hold an encode slot.
 */
export const encodeSignal = new AsyncLocalStorage<AbortSignal>()
const spawnOpts = (): { signal?: AbortSignal } => {
  const signal = encodeSignal.getStore()
  return signal ? { signal } : {}
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
   * `atQ` is the rung that gave it away, not the last one on the ladder — the point of
   * projecting is to stop before burning the rest, so the message must not imply the
   * encoder tried everything when it deliberately didn't.
   */
  constructor(sizeBytes: number, durationSec: number, fps: number, atQ: number) {
    const ratio = WEBP_TARGET / Math.max(1, sizeBytes)
    const maxSeconds = Math.min(6, Math.max(0.5, Math.floor(durationSec * ratio * 10) / 10))
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

/** Merge consecutive near-identical frames into one longer frame. Motion fps stays; stills don't burn the 500KB budget. */
export function collapseHolds(sigs: Uint8Array[], frameMs: number): { index: number; durationMs: number }[] {
  const out: { index: number; durationMs: number }[] = []
  for (let i = 0; i < sigs.length; i++) {
    const last = out[out.length - 1]
    if (last && isHold(sigs[last.index], sigs[i])) last.durationMs += frameMs
    else out.push({ index: i, durationMs: frameMs })
  }
  return out
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

/**
 * Frames that survive a video re-encode are never byte-identical even when the
 * scene is frozen — compressor noise changes every pixel. Hashing the PNGs (the
 * old approach) therefore collapsed almost nothing on real footage, so a held
 * still cost a full delta frame each time. Shrinking each extracted frame to a 9×8
 * gray strip and comparing 64-bit fingerprints does collapse.
 */
async function frameSignatures(framesDir: string, count: number, tmp: string): Promise<Uint8Array[]> {
  if (count === 0) return []
  const raw = path.join(tmp, 'sig.gray')
  await run('ffmpeg', [
    '-i', path.join(framesDir, 'f%04d.png'),
    '-vf', `scale=${SIG_SIDE}:${SIG_SIDE}:flags=area,format=gray`, '-f', 'rawvideo', '-y', raw,
  ])
  const buf = await readFile(raw)
  const stride = SIG_SIDE * SIG_SIDE
  const sigs: Uint8Array[] = []
  for (let off = 0; off + stride <= buf.length; off += stride) sigs.push(buf.subarray(off, off + stride))
  return sigs
}

/**
 * Cheap stand-in for the real extract: 16×16 gray frames, same hold rule.
 * Used to skip a fps that cannot fit before writing 512px PNGs and muxing them.
 * A failure returns 0 so the caller encodes anyway.
 */
export async function probeHoldCount(
  inputPath: string,
  start: number,
  srcSpan: number,
  fps: number,
  preVf: string,
  tmp: string,
  concat: string | null = null,
): Promise<number> {
  const raw = path.join(tmp, `probe-${Math.round(fps * 100)}.gray`)
  const chain = [preVf, `fps=${fps}`, `scale=${SIG_SIDE}:${SIG_SIDE}:flags=area,format=gray`]
    .filter(Boolean).join(',')
  // Several spans: concat joins them up front. A concat references [0:v] twice, which a
  // simple -vf graph rejects, so it must run as -filter_complex with a mapped output.
  const inputArgs = concat ? ['-i', inputPath] : ['-ss', String(start), '-t', String(srcSpan), '-i', inputPath]
  const filterArgs = concat ? ['-filter_complex', `${concat}${chain}[out]`, '-map', '[out]'] : ['-vf', chain]
  try {
    await run('ffmpeg', [
      ...inputArgs, ...filterArgs, '-f', 'rawvideo', '-y', raw,
    ])
  } catch {
    return 0
  }
  const buf = await readFile(raw).catch(() => Buffer.alloc(0))
  const stride = SIG_SIDE * SIG_SIDE
  const sigs: Uint8Array[] = []
  for (let off = 0; off + stride <= buf.length; off += stride) sigs.push(buf.subarray(off, off + stride))
  if (sigs.length === 0) return 0
  return collapseHolds(sigs, Math.max(8, Math.round(1000 / fps))).length
}

/**
 * Eight real frames, muxed at the cheapest quality, scaled to the held count.
 * Returns null when the sample cannot be built — the caller encodes anyway.
 * This is the check the flat byte model cannot make: detailed footage overruns it.
 */
export async function measureSpanBytes(
  inputPath: string,
  start: number,
  srcSpan: number,
  fps: number,
  preVf: string,
  heldFrames: number,
  tmp: string,
  concat: string | null = null,
): Promise<number | null> {
  if (heldFrames <= 1 || fps <= 0) return null
  const dir = path.join(tmp, `sample-${Math.round(fps * 100)}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const every = Math.max(1, Math.round(Math.max(srcSpan, 0.1) * fps / 8))
  const chain = [preVf, `fps=${fps}`, `select=not(mod(n\\,${every}))`].filter(Boolean).join(',')
  const inputArgs = concat ? ['-i', inputPath] : ['-ss', String(start), '-t', String(srcSpan), '-i', inputPath]
  const filterArgs = concat ? ['-filter_complex', `${concat}${chain}[out]`, '-map', '[out]'] : ['-vf', chain]
  try {
    await run('ffmpeg', [
      ...inputArgs, ...filterArgs, '-frames:v', '8', '-y', path.join(dir, 'f%04d.png'),
    ])
    const names = (await readdir(dir)).filter(f => f.endsWith('.png')).sort()
    if (names.length < 2) return null
    const paths = names.map(f => path.join(dir, f))
    const keyPath = path.join(dir, 'key.webp')
    await run('cwebp', [paths[0], '-q', '50', '-m', '4', '-quiet', '-o', keyPath])
    const keyBytes = (await stat(keyPath)).size
    const samplePath = path.join(dir, 'sample.webp')
    const frameMs = Math.max(8, Math.round(1000 / fps))
    await muxImg2Webp(paths.map(p => ({ path: p, durationMs: frameMs })), samplePath, 50)
    return projectAnimatedBytes(keyBytes, (await stat(samplePath)).size, paths.length, heldFrames)
  } catch {
    return null
  }
}

async function holdItems(framesDir: string, frames: string[], frameMs: number, tmp: string): Promise<HeldFrame[]> {
  const sigs = await frameSignatures(framesDir, frames.length, tmp)
  // If the signatures don't line up one-for-one, extract no holds rather than
  // mis-pairing a frame with the wrong fingerprint.
  if (sigs.length !== frames.length) return frames.map(f => ({ path: f, durationMs: frameMs }))
  return collapseHolds(sigs, frameMs).map(h => ({
    path: frames[h.index],
    durationMs: Math.max(8, h.durationMs),
  }))
}

/**
 * A still image → motionless animated WebP: frame it to 512×512, then mux two
 * identical frames so it counts as animated (WhatsApp rejects a static sticker in
 * an animated pack). Bypasses VP9 entirely — libvpx can spin forever on a looped
 * still — so it's deterministic and fast.
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
  fps: number             // requested (capped) frame rate
  effectiveFps: number    // after hold-merging — the average the sticker will report
  projectedKB: number     // estimated size at the quality it would land on
  qNeeded: number         // 30..90 the encoder would settle at
  quality: 'crisp' | 'good' | 'soft' | 'very soft'
  maxSeconds: number      // longest kept time that would still fit at this framing
}

// bytes(q) ≈ bytes50 · (q/50)², the same quality curve the ladder's projections assume.
const QUALITY_EXP = 2

function qualityLabel(q: number): EstimateResult['quality'] {
  if (q >= 75) return 'crisp'
  if (q >= 55) return 'good'
  if (q >= 40) return 'soft'
  return 'very soft'
}

/**
 * Cheap live projection of what the current framing/trim would produce, without a full
 * encode. One 16×16 hold probe + one 8-frame sample mux (~1–2s), then the ladder's own
 * quality curve says which q it would land on and whether it fits 500KB. An estimate,
 * not a guarantee — the real encode still fails closed at [WEBP_TARGET].
 */
export async function estimateSticker(inputPath: string, opts: ConvertSettings): Promise<EstimateResult> {
  const spans = opts.spans && opts.spans.length ? opts.spans : [{ start: opts.start, end: opts.end }]
  const kept = keptSeconds(spans)
  const fps = opts.fps
  const speed = opts.speed || 1
  // Seconds of sticker, not source: sped up, the same kept span plays shorter.
  const outDur = kept / speed
  const concat = concatPrefix(spans)
  const cropF = opts.crop ? `crop=${opts.crop.w}:${opts.crop.h}:${opts.crop.x}:${opts.crop.y},` : ''
  const filters = buildFilters(opts.fit, opts.padColor, opts.cropPos, opts.border)
  const start = spans[0].start
  const tmp = fs_mkdtemp()
  await mkdir(tmp, { recursive: true })
  try {
    // Effective frame count after hold-merging, over the whole kept span (cheap 16×16).
    const held = await probeHoldCount(inputPath, start, kept, fps, `${cropF}setpts=PTS/${speed}`, tmp, concat)
    const effFrames = held > 1 ? held : Math.max(2, Math.round(outDur * fps))

    // Real per-frame cost from a CONTIGUOUS sample (distinct delta frames at the true
    // frame rate), not the every-Nth subsample measureSpanBytes uses. Sampled from ~40%
    // into the first span — the opening is often calmer than the sustained motion, which
    // would under-project a busy clip.
    const sampleSec = Math.min(kept, 1.5)
    const firstLen = spans[0].end - spans[0].start
    const sampleStart = start + Math.max(0, (Math.min(firstLen, kept) - sampleSec) * 0.4)
    const dir = path.join(tmp, 'sample')
    await mkdir(dir, { recursive: true })
    await run('ffmpeg', [
      '-ss', String(sampleStart), '-t', String(sampleSec), '-i', inputPath,
      '-vf', `${cropF}${filters},setpts=PTS/${speed},fps=${fps}`, `${dir}/f%04d.png`,
    ])
    const names = (await readdir(dir)).filter(f => f.endsWith('.png')).sort()
    const frameMs = Math.max(8, Math.round(1000 / fps))
    const list = names.map(f => ({ path: path.join(dir, f), durationMs: frameMs }))

    let bytesAt: (q: number) => number
    if (list.length >= 2) {
      const size = async (q: number): Promise<number> => {
        const out = path.join(dir, `s-q${q}.webp`)
        await muxImg2Webp(list, out, q)
        return (await stat(out)).size / list.length   // per-frame bytes at this quality
      }
      // Two points give WebP's real (flat) quality curve — the (q/50)² model was wrong.
      const per50 = await size(50)
      const per30 = await size(30)
      const b50 = per50 * effFrames
      const b30 = per30 * effFrames
      const e = b30 > 0 && b50 > 0 && b50 !== b30
        ? Math.min(2, Math.max(0.3, Math.log(b50 / b30) / Math.log(50 / 30)))
        : QUALITY_EXP
      bytesAt = (q: number) => b50 * Math.pow(q / 50, e)
    } else {
      const b50 = estimatedBytes(outDur, fps)
      bytesAt = (q: number) => b50 * Math.pow(q / 50, QUALITY_EXP)
    }

    // Bias conservative: the sample is the clip's opening, which can be calmer than a
    // busy tail, so leave headroom below 500KB. Better to say "trim a hair" than to green-
    // light a clip that then fails closed on Add.
    const targetEst = WEBP_TARGET * 0.94
    const fits = bytesAt(30) <= targetEst
    // The encoder lands on the HIGHEST q that fits (ladder runs 90→30, stops at first fit).
    const qNeeded = solveQ(bytesAt, targetEst)
    const effectiveFps = Math.min(fps, Math.max(1, Math.round(effFrames / Math.max(0.1, outDur))))
    return {
      fits,
      keptSeconds: Math.round(kept * 100) / 100,
      fps,
      effectiveFps,
      projectedKB: Math.round(bytesAt(qNeeded) / 1024),
      qNeeded,
      quality: qualityLabel(qNeeded),
      // Source seconds — what the trim control moves.
      maxSeconds: fits ? Math.min(MAX_STICKER_SEC * speed, kept) : secondsThatFit(kept, bytesAt(30), targetEst),
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Highest q in [30,90] whose projected size is under target; 30 if none fit. */
function solveQ(bytesAt: (q: number) => number, target: number): number {
  for (let q = 90; q >= 30; q--) if (bytesAt(q) <= target) return q
  return 30
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
  const { inputPath, outPath, start, end, speed = 1, fps, fit, padColor, crop, cropPos, border, minQ } = opts
  // Several kept ranges are concatenated up front; one range keeps the -ss/-t path.
  const spans: Span[] = opts.spans && opts.spans.length ? opts.spans : [{ start, end }]
  const concat = concatPrefix(spans)
  const single = planSpan(start, end, speed)
  // With a concat the source span is the joined length; -t is not used.
  const srcSpan = concat ? keptSeconds(spans) : single.srcSpan
  // setpts=PTS/speed runs after the concat too, so the sticker is kept/speed long.
  const outDur = concat ? keptSeconds(spans) / (speed > 0 ? speed : 1) : single.outDur
  const tmp = fs_mkdtemp()
  const framesDir = path.join(tmp, 'frames')
  await mkdir(framesDir, { recursive: true })

  try {
    const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''
    const filters = buildFilters(fit, padColor, cropPos, border)
    const steps = fpsSteps(fps)
    // Floor for the LAST fps only. A busy photographic clip at 512²/24fps needs q≈30
    // to fit 4s under 500KB — flooring at 50 rejected clips that q30 encodes fine. The
    // projections use this floor too, so they only fail closed when even q30 can't fit.
    const lowestQ = Math.min(70, Math.max(30, minQ ?? 30))
    // Keep q ≥ 70 while we still have fps to give. Crushing to 20 at 30fps is the
    // pixelation users saw; 24fps at q70 beats 30fps mush. Only the last fps drops below.
    const qualitiesAtFps = [90, 80, 70]
    const lastResort = [60, 50, 40, 30].filter(q => q >= lowestQ)
    let lastSize = 0
    let lastFps = steps[0]
    let lastHeld: HeldFrame[] = []
    let tier = 0

    for (const outFps of steps) {
      const isLast = outFps === steps[steps.length - 1]
      const base = tier / steps.length
      const span = 1 / steps.length
      // 16×16 holds are enough to know a higher fps cannot fit. Skip its 512px
      // extract and muxes, and try the next rate. The last rate still encodes:
      // the byte model overestimates flat animation.
      const heldGuess = await probeHoldCount(
        inputPath, start, srcSpan, outFps, `${cropF}setpts=PTS/${speed}`, tmp, concat,
      )
      if (skipFpsBeforeMux(heldGuess, outFps, isLast)) {
        progress?.(base + span, `${Math.round(outFps)}fps won't fit — trying a lower rate`)
        tier++
        continue
      }

      // A few real frames at q50. The 4KB model said 5.1s would fit and this
      // footage came out at 1007KB — find that out before extracting every frame.
      progress?.(base, 'Checking size')
      const projected = await measureSpanBytes(
        inputPath, start, srcSpan, outFps, `${cropF}${filters},setpts=PTS/${speed}`, heldGuess, tmp, concat,
      )
      if (projected != null && projected > WEBP_TARGET) {
        if (isLast) throw new WebpBudgetError(projected, outDur, outFps, lowestQ)
        progress?.(base + span, `${Math.round(outFps)}fps won't fit — trying a lower rate`)
        tier++
        continue
      }

      await rm(framesDir, { recursive: true, force: true })
      await mkdir(framesDir, { recursive: true })
      progress?.(base, `Extracting ${Math.round(outFps)}fps frames`)
      const chain = `${cropF}${filters},setpts=PTS/${speed},fps=${outFps}`
      const extractInput = concat
        ? ['-i', inputPath]
        : ['-ss', String(start), '-t', String(srcSpan), '-i', inputPath]
      const extractFilter = concat
        ? ['-filter_complex', `${concat}${chain}[out]`, '-map', '[out]']
        : ['-vf', chain]
      await runWithProgress('ffmpeg', [
        '-progress', 'pipe:1', '-nostats',
        ...extractInput,
        ...extractFilter,
        `${framesDir}/f%04d.png`
      ], f => progress?.(base + f * span * 0.5, `Extracting ${Math.round(outFps)}fps frames`), srcSpan)

      const frames = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort()
        .map(f => path.join(framesDir, f))
      if (frames.length === 0) throw new Error('no frames extracted')
      const durationMs = Math.max(8, Math.round(1000 / outFps))
      lastFps = outFps
      lastHeld = await holdItems(framesDir, frames, durationMs, tmp)
      progress?.(base + span * 0.6, 'Measuring motion')

      const ladder = isLast ? [...qualitiesAtFps, ...lastResort] : qualitiesAtFps
      // Held frames are free, so the ratio between what we mux and what we extracted
      // is what carries the size projection across to the cheapest rung.
      const frameRatio = lastHeld.length / frames.length
      const samples: SizeSample[] = []
      let nextFps = false
      for (const [n, q] of ladder.entries()) {
        progress?.(base + span * (0.65 + 0.35 * (n / ladder.length)), `Muxing q${q}`)
        await muxImg2Webp(lastHeld, outPath, q)
        const { size } = await stat(outPath)
        lastSize = size
        if (size <= WEBP_TARGET) return await verify(outPath, lastHeld[0]?.path ?? null, tmp)
        samples.push({ q, bytes: size })
        if (samples.length === 1 && firstMuxNeverFits(size, q, lowestQ, WEBP_TARGET)) {
          if (isLast) throw new WebpBudgetError(size, outDur, outFps, q)
          nextFps = true
          break
        }
        // Eight full muxes of a clip that could never fit is minutes of a 1 GB VM
        // doing nothing useful. Two points give the quality curve; if its lowest rung
        // still misses, stop this fps. A lower rate may still fit; only the last
        // rate fails the encode.
        if (projectedNeverFits(samples, frameRatio, lowestQ, WEBP_TARGET)) {
          if (isLast) throw new WebpBudgetError(size, outDur, outFps, q)
          nextFps = true
          break
        }
      }
      if (nextFps) progress?.(base + span, `${Math.round(outFps)}fps won't fit — trying a lower rate`)
      tier++
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
