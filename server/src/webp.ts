import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildFilters, computeBitrateKbps } from './convert.js'
import type { ConvertSettings, CropRect } from './types.js'

export type WebpOptions = Omit<ConvertSettings, 'speed'> & {
  inputPath: string
  outPath: string
  speed?: number
}

export interface WebpResult {
  sizeBytes: number
  frames: number
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args)
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)))
    p.on('error', reject)
  })
}

/**
 * Animated WebP for WhatsApp third-party sticker packs (the provider API
 * requires animated WebP, not WebM). Pipeline:
 *   ffmpeg frame extraction → cwebp per-frame → webpmux assembly
 * Quality retries downward until the file fits WhatsApp's 500KB cap.
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
    await run('ffmpeg', [
      '-progress', 'pipe:1', '-nostats',
      '-ss', String(start),
      '-t', String(outDur + 0.2),
      '-i', inputPath,
      '-vf', `${cropF}${filters},setpts=PTS/${speed},fps=${fps}`,
      '-frames:v', '150',
      `${framesDir}/f%04d.png`
    ])

    const frames = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort()
    if (frames.length === 0) throw new Error('no frames extracted')

    const durationMs = Math.max(20, Math.round(1000 / fps))
    const qualities = [72, 55, 40, 28]

    for (const q of qualities) {
      for (const f of frames) {
        await run('cwebp', [
          path.join(framesDir, f),
          '-q', String(q),
          '-quiet',
          '-o', path.join(framesDir, f.replace('.png', '.webp'))
        ])
      }
      const webpFrames = frames.map(f => path.join(framesDir, f.replace('.png', '.webp')))
      const muxArgs: string[] = []
      for (const f of webpFrames) muxArgs.push('-frame', f, `+${durationMs}`)
      muxArgs.push('-loop', '0', '-o', outPath)
      await run('webpmux', muxArgs)

      const { size } = await stat(outPath)
      if (size <= 480 * 1024) {
        return { sizeBytes: size, frames: frames.length }
      }
    }
    throw new Error(`animated webp exceeds 500KB even at minimum quality (${frames.length} frames)`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function fs_mkdtemp(): string {
  return path.join(os.tmpdir(), `sf-webp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}
