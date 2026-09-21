import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { planSpan } from './budget.js'
import type { ConvertSettings, CropRect, FitMode } from './types.js'

const MAX_BYTES = 500 * 1024
const SAFE_BYTES = 470 * 1024

export type ConvertOptions = ConvertSettings & {
  inputPath: string
  outputPath: string
}

export interface ConvertResult {
  sizeBytes: number
}

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

export function computeBitrateKbps(startSec: number, endSec: number, speed: number): { kbps: number; outDur: number } {
  const outDur = Math.max(0.3, (endSec - startSec) / speed)
  const kbps = Math.floor((SAFE_BYTES * 8) / outDur / 1000)
  return { kbps: Math.min(2500, Math.max(100, kbps)), outDur }
}

function run(args: string[], signal: AbortSignal | null, onProgress: ((p: number) => void) | null, weightStart: number, weightSpan: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, signal ? { signal } : {})
    let stderrBuf = ''
    proc.stderr.on('data', d => {
      stderrBuf += d
      if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-32_000)
    })
    if (onProgress && weightSpan > 0) {
      let buf = ''
      proc.stdout.on('data', d => {
        buf += d.toString()
        const matches = buf.match(/out_time_us=(\d+)/g)
        if (matches) {
          const last = parseInt(matches[matches.length - 1].split('=')[1], 10)
          onProgress(weightStart + (last / 1e6) * weightSpan)
          buf = ''
        }
      })
    }
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderrBuf.slice(-800)}`))
    })
    proc.on('error', reject)
  })
}

export async function convertToSticker(opts: ConvertOptions, signal: AbortSignal | null, onProgress: (p: number) => void = () => {}): Promise<ConvertResult> {
  const { inputPath, outputPath, start, end, speed, fps, fit, padColor, crop, cropPos, border } = opts
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''
  const filters = cropF + buildFilters(fit, padColor, cropPos, border)
  const { kbps } = computeBitrateKbps(start, end, speed)

  // Two-pass VP9 writes a stats file; without a unique -passlogfile every
  // concurrent batch job shares the default ffmpeg2pass-0.log and a job reading
  // another's log dies with "bit_rate, rate, width or height" (exit 234).
  const passLog = `${outputPath}.passlog`
  const encode = (bitrateKbps: number): string[] => [
    '-progress', 'pipe:1',
    '-nostats',
    '-ss', String(start),
    '-t', String(planSpan(start, end, speed).srcSpan + 0.2),
    '-i', inputPath,
    '-vf', `${filters},setpts=PTS/${speed}`,
    '-r', String(fps),
    '-an',
    '-c:v', 'libvpx-vp9',
    '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${bitrateKbps}k`,
    '-bufsize', `${bitrateKbps * 2}k`,
    '-row-mt', '1',
    '-deadline', 'good',
    '-cpu-used', '2',
    '-passlogfile', passLog,
    '-pix_fmt', 'yuv420p'
  ]

  const attempt = async (bitrateKbps: number, pStart: number, pSpan: number): Promise<{ size: number }> => {
    await run(
      [...encode(bitrateKbps), '-pass', '1', '-f', 'null', '/dev/null'],
      signal, onProgress, pStart, pSpan * 0.35
    )
    await run(
      [...encode(bitrateKbps), '-pass', '2', '-y', outputPath],
      signal, onProgress, pStart + pSpan * 0.35, pSpan * 0.65
    )
    const s = await stat(outputPath)
    return { size: s.size }
  }

  let info = await attempt(kbps, 0, 0.95)
  let retries = 0

  while (info.size > MAX_BYTES && retries < 2) {
    retries++
    const ratio = SAFE_BYTES / info.size
    const lower = Math.max(60, Math.floor(kbps * ratio))
    info = await attempt(lower, 0.95 - 0.3 * retries, 0.3)
  }

  return { sizeBytes: info.size }
}

export function extractTray(inputPath: string, trayPath: string, start: number, crop: CropRect | null, cropPos = 0.5): Promise<void> {
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''
  const pos = Math.min(1, Math.max(0, cropPos ?? 0.5))
  return new Promise((resolve) => {
    // WhatsApp tray must be 96×96 PNG, ≤50KB — not 512.
    const p = spawn('ffmpeg', [
      '-ss', String(Math.max(0, start)),
      '-i', inputPath,
      '-vf', `${cropF}scale=96:96:force_original_aspect_ratio=increase,crop=96:96:(iw-96)*${pos}:(ih-96)*${pos}`,
      '-frames:v', '1', '-y', trayPath
    ])
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}
