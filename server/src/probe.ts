import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { CropRect, QualityAssessment, VideoMeta } from './types.js'

const execFileAsync = promisify(execFile)

export async function probeVideo(filePath: string): Promise<VideoMeta> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ])
  const data = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type: string
      codec_name?: string
      pix_fmt?: string
      width?: number
      height?: number
      r_frame_rate?: string
      duration?: string
      bit_rate?: string
    }>
    format?: { duration?: string; bit_rate?: string; size?: string }
  }

  const video = data.streams?.find(s => s.codec_type === 'video')
  const audio = data.streams?.find(s => s.codec_type === 'audio')
  if (!video || !video.width || !video.height) throw new Error('No video stream found')

  const [num, den] = (video.r_frame_rate || '30/1').split('/').map(Number)
  const fps = den ? num / den : 30

  return {
    width: video.width,
    height: video.height,
    fps: Math.round(fps * 100) / 100,
    duration: parseFloat(data.format?.duration || video.duration || '0'),
    bitrate: parseInt(data.format?.bit_rate || video.bit_rate || '0', 10),
    codec: video.codec_name || 'unknown',
    pixFmt: video.pix_fmt || 'unknown',
    hasAudio: !!audio,
    sizeBytes: parseInt(data.format?.size || '0', 10)
  }
}

export function assessQuality(meta: VideoMeta): QualityAssessment {
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

  if (meta.fps < 20) {
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

  if (meta.duration > 6.05) {
    notes.push({ type: 'info', msg: `${meta.duration.toFixed(1)}s — trim to ≤6s needed` })
  }
  if (meta.fps > 32) {
    notes.push({ type: 'info', msg: `${Math.round(meta.fps)}fps will be capped to 30` })
  }
  if (meta.hasAudio) {
    notes.push({ type: 'info', msg: 'Audio will be stripped automatically' })
  }

  return { level, notes }
}

export function detectCrop(inputPath: string, meta: VideoMeta): Promise<CropRect | null> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-ss', String(Math.min(0.5, meta.duration / 2)),
      '-t', String(Math.min(4, meta.duration)),
      '-i', inputPath,
      '-vf', 'cropdetect=24:2:0',
      '-f', 'null', '/dev/null'
    ])
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('close', () => {
      const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
      if (!matches.length) return resolve(null)
      const [w, h, x, y] = matches[matches.length - 1].slice(1).map(Number)
      if (w < 16 || h < 16) return resolve(null)
      resolve({ w, h, x, y })
    })
    p.on('error', reject)
  })
}
