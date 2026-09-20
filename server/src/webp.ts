import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildFilters, computeBitrateKbps } from './convert.js'
import { fpsSteps, WEBP_TARGET } from './budget.js'
import type { ConvertSettings } from './types.js'

export type WebpOptions = Omit<ConvertSettings, 'speed'> & {
  inputPath: string
  outPath: string
  speed?: number
}

export interface WebpResult {
  sizeBytes: number
  frames: number
  fps: number
}

interface HeldFrame {
  path: string
  durationMs: number
}

export class WebpBudgetError extends Error {
  readonly maxSeconds: number
  readonly sizeBytes: number
  constructor(sizeBytes: number, durationSec: number, fps: number) {
    const ratio = WEBP_TARGET / Math.max(1, sizeBytes)
    const maxSeconds = Math.min(6, Math.max(0.5, Math.floor(durationSec * ratio * 10) / 10))
    super(`Won't fit at ${Math.round(fps)}fps (${Math.round(sizeBytes / 1024)}KB). Trim to ~${maxSeconds}s to keep motion.`)
    this.name = 'WebpBudgetError'
    this.maxSeconds = maxSeconds
    this.sizeBytes = sizeBytes
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args)
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

/** Merge consecutive identical frames into one longer frame. Motion fps stays; stills don't burn the 500KB budget. */
export function collapseHolds(hashes: string[], frameMs: number): { index: number; durationMs: number }[] {
  const out: { index: number; durationMs: number }[] = []
  for (let i = 0; i < hashes.length; i++) {
    const last = out[out.length - 1]
    if (last && hashes[i] === hashes[last.index]) last.durationMs += frameMs
    else out.push({ index: i, durationMs: frameMs })
  }
  return out
}

async function holdItems(files: string[], frameMs: number): Promise<HeldFrame[]> {
  const hashes: string[] = []
  for (const f of files) {
    hashes.push(createHash('sha1').update(await readFile(f)).digest('hex'))
  }
  return collapseHolds(hashes, frameMs).map(h => ({
    path: files[h.index],
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
      if (size <= WEBP_TARGET) return { sizeBytes: size, frames: 2, fps: 4 }
    }
    return { sizeBytes: (await stat(outPath)).size, frames: 2, fps: 4 }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Animated WebP for WhatsApp third-party sticker packs.
 * ffmpeg frames → img2webp (WebPAnimEncoder: mixed + delta frames).
 * Quality first, then fps down to 24 — never the old 8fps keyframe dump.
 */
export async function convertToAnimatedWebp(opts: WebpOptions): Promise<WebpResult> {
  const { inputPath, outPath, start, end, speed = 1, fps, fit, padColor, crop, cropPos, border } = opts
  const { outDur } = computeBitrateKbps(start, end, speed)
  const tmp = fs_mkdtemp()
  const framesDir = path.join(tmp, 'frames')
  await mkdir(framesDir, { recursive: true })

  try {
    const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''
    const filters = buildFilters(fit, padColor, cropPos, border)
    const steps = fpsSteps(fps)
    // Keep q ≥ 70 while we still have fps to give. Crushing to 20 at 30fps is the
    // pixelation users saw; 24fps at q70 beats 30fps mush.
    const qualitiesAtFps = [90, 80, 70]
    const lastResort = [60, 50]
    let lastSize = 0
    let lastFps = steps[0]
    let lastHeld: HeldFrame[] = []

    for (const outFps of steps) {
      await rm(framesDir, { recursive: true, force: true })
      await mkdir(framesDir, { recursive: true })
      await run('ffmpeg', [
        '-progress', 'pipe:1', '-nostats',
        '-ss', String(start),
        '-t', String(outDur),
        '-i', inputPath,
        '-vf', `${cropF}${filters},setpts=PTS/${speed},fps=${outFps}`,
        `${framesDir}/f%04d.png`
      ])

      const frames = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort()
        .map(f => path.join(framesDir, f))
      if (frames.length === 0) throw new Error('no frames extracted')
      const durationMs = Math.max(8, Math.round(1000 / outFps))
      lastFps = outFps
      lastHeld = await holdItems(frames, durationMs)

      for (const q of qualitiesAtFps) {
        await muxImg2Webp(lastHeld, outPath, q)
        const { size } = await stat(outPath)
        lastSize = size
        if (size <= WEBP_TARGET) {
          return { sizeBytes: size, frames: lastHeld.length, fps: outFps }
        }
      }
    }
    for (const q of lastResort) {
      await muxImg2Webp(lastHeld, outPath, q)
      const { size } = await stat(outPath)
      lastSize = size
      if (size <= WEBP_TARGET) {
        return { sizeBytes: size, frames: lastHeld.length, fps: lastFps }
      }
    }
    throw new WebpBudgetError(lastSize, outDur, lastFps)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function muxImg2Webp(frames: HeldFrame[], outPath: string, q: number): Promise<void> {
  if (frames.length === 0) throw new Error('no frames to mux')
  const list = path.join(path.dirname(frames[0].path), `img2webp-q${q}.args`)
  const lines = ['-mixed', '-sharp_yuv', '-loop', '0', '-kmin', '3', '-kmax', '15']
  for (const f of frames) {
    lines.push('-d', String(f.durationMs), '-lossy', '-q', String(q), '-m', '6', f.path)
  }
  lines.push('-o', outPath)
  await writeFile(list, lines.join('\n'))
  await run('img2webp', [list])
}

function fs_mkdtemp(): string {
  return path.join(os.tmpdir(), `sf-webp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}
