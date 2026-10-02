import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_STICKER_SEC } from './budget.js'
import type { CropRect, MediaKind, QualityAssessment, VideoMeta } from './types.js'

const execFileAsync = promisify(execFile)

// Still-image codecs → treated as images (become motionless animated WebP). GIF and
// animated WebP go through the video path so their motion survives.
const STILL_CODECS = new Set(['png', 'mjpeg', 'jpeg', 'bmp', 'tiff'])

interface ProbeStream {
  codec_type: string
  codec_name?: string
  pix_fmt?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  bit_rate?: string
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>
}

export async function probeMedia(filePath: string): Promise<{ meta: VideoMeta; kind: MediaKind }> {
  const meta = await probeVideo(filePath)
  const kind: MediaKind = STILL_CODECS.has(meta.codec) ? 'image' : 'video'
  if (kind === 'image') return { meta: { ...meta, fps: 0, duration: 0, hasAudio: false }, kind }
  return { meta, kind }
}

/**
 * The frame size the encoder actually sees. ffprobe's width/height are the *coded*
 * dimensions; ffmpeg auto-applies the display matrix on decode, so for a portrait
 * phone clip (coded 1920×1080, rotation -90) every downstream crop coordinate has to
 * be measured against 1080×1920 or the box lands somewhere else entirely.
 */
export function displaySize(s: ProbeStream): { width: number; height: number } {
  const w = s.width ?? 0
  const h = s.height ?? 0
  const rot = displayRotation(s)
  const quarter = Math.round(((rot % 360) + 360) % 360 / 90) % 4
  return quarter === 1 || quarter === 3 ? { width: h, height: w } : { width: w, height: h }
}

export function displayRotation(s: ProbeStream): number {
  const matrix = s.side_data_list?.find(d => d.side_data_type === 'Display Matrix')
  return typeof matrix?.rotation === 'number' ? matrix.rotation : 0
}

/** avg_frame_rate is the honest average; r_frame_rate is a base timebase guess that
 *  can read absurd (1000/1) on VFR screen recordings and forwarded memes. */
export function frameRate(s: ProbeStream): number {
  for (const raw of [s.avg_frame_rate, s.r_frame_rate]) {
    const [num, den] = (raw || '0/0').split('/').map(Number)
    if (num > 0 && den > 0) {
      const fps = num / den
      if (fps > 0 && fps <= 1000) return Math.round(fps * 100) / 100
    }
  }
  return 0
}

/**
 * Containers an upload may be. Uploads are untrusted, and ffmpeg will happily follow a
 * playlist (HLS, ffconcat) to local files or URLs; only plain media demuxers may open them.
 */
const DEMUXERS = 'mov,matroska,webm,gif,avi,mpegts,flv,asf,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif_pipe,apng'

export async function probeVideo(filePath: string): Promise<VideoMeta> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-protocol_whitelist', 'file',
    '-format_whitelist', DEMUXERS,
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { timeout: 30_000 }).catch(() => { throw new Error('Not a video or image StickerForge can read') })
  const data = JSON.parse(stdout) as {
    streams?: ProbeStream[]
    format?: { duration?: string; bit_rate?: string; size?: string }
  }

  const video = data.streams?.find(s => s.codec_type === 'video')
  const audio = data.streams?.find(s => s.codec_type === 'audio')
  if (!video || !video.width || !video.height) throw new Error('No video stream found')

  const { width, height } = displaySize(video)
  const rotation = displayRotation(video)

  return {
    width,
    height,
    fps: frameRate(video),
    rotation,
    duration: parseFloat(data.format?.duration || video.duration || '0'),
    bitrate: parseInt(data.format?.bit_rate || video.bit_rate || '0', 10),
    codec: video.codec_name || 'unknown',
    pixFmt: video.pix_fmt || 'unknown',
    hasAudio: !!audio,
    sizeBytes: parseInt(data.format?.size || '0', 10)
  }
}

export function assessQuality(meta: VideoMeta, kind: MediaKind = 'video'): QualityAssessment {
  const notes: QualityAssessment['notes'] = []
  let level: QualityAssessment['level'] = 'good'

  const longSide = Math.max(meta.width, meta.height)

  if (longSide < 360) {
    notes.push({ type: 'warn', msg: `Low resolution (${meta.width}×${meta.height}) — output will be soft` })
    level = 'warn'
  } else if (longSide < 480) {
    notes.push({ type: 'info', msg: `Modest resolution (${meta.width}×${meta.height}) — acceptable` })
  } else {
    notes.push({ type: 'good', msg: `Sharp source (${meta.width}×${meta.height})` })
  }

  // Images have no fps/duration/audio — skip those checks.
  if (kind === 'image') {
    notes.push({ type: 'info', msg: 'Still image — becomes a motionless sticker' })
    return { level, notes }
  }

  if (meta.fps > 0 && meta.fps < 20) {
    notes.push({ type: 'warn', msg: `Low framerate (${meta.fps}fps) — sticker will look choppy` })
    level = 'warn'
  }

  const px = meta.width * meta.height * meta.fps
  const bpp = px > 0 ? meta.bitrate / px : 0
  if (bpp > 0 && bpp < 0.02) {
    notes.push({ type: 'warn', msg: 'Heavy compression in source — artifacts likely' })
    level = 'warn'
  } else if (bpp >= 0.02 && meta.bitrate < 400_000) {
    notes.push({ type: 'info', msg: 'Lowish bitrate — mild compression visible' })
    if (level === 'good') level = 'ok'
  }

  if (meta.duration > MAX_STICKER_SEC + 0.05) {
    notes.push({ type: 'info', msg: `${meta.duration.toFixed(1)}s — trim to ≤${MAX_STICKER_SEC}s needed` })
  }
  if (meta.fps > 32) {
    notes.push({ type: 'info', msg: `${Math.round(meta.fps)}fps will be capped to 30` })
  }
  if (meta.hasAudio) {
    notes.push({ type: 'info', msg: 'Audio will be stripped automatically' })
  }

  return { level, notes }
}

/**
 * cropdetect reports per-frame. Taking the last reading meant a clip whose letterbox
 * changes mid-run — or a single black-frame scene change — set a crop for the whole
 * sticker. The most common rect across the sampled window is the safe answer.
 */
export function modalCrop(detections: string[]): CropRect | null {
  const counts = new Map<string, number>()
  for (const d of detections) counts.set(d, (counts.get(d) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n }
  if (!best) return null
  const [w, h, x, y] = best.split(':').map(Number)
  if (![w, h, x, y].every(Number.isFinite) || w < 16 || h < 16) return null
  return { w, h, x, y }
}

export function detectCrop(inputPath: string, meta: VideoMeta): Promise<CropRect | null> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-ss', String(Math.min(0.5, meta.duration / 2)),
      '-t', String(Math.min(4, meta.duration)),
      '-i', inputPath,
      '-vf', 'cropdetect=24:2:0',
      '-f', 'null', '/dev/null'
    ], { timeout: 60_000, killSignal: 'SIGKILL' })
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('close', () => {
      const seen = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map(m => m.slice(1, 5).join(':'))
      resolve(modalCrop(seen))
    })
    p.on('error', reject)
  })
}
