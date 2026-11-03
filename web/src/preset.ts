import { convert, estimate, watchJob, EncodeError, discardDraft, type JobEvent } from './api.js'
import { capFps, MAX_STICKER_SEC, nextFitLength } from './budget.js'
import type { ConvertRequest, CropRect, FileRecord } from './types.js'

/** Long trades smoothness for seconds: busy footage keeps ~60–90% more at 15fps. */
export const LONG_FPS = 15
/** Budget failures shrink the preset window to what the encoder measured would fit. */
export const FIT_ATTEMPTS = 3

export function squareCrop(w: number, h: number): CropRect {
  const s = Math.min(w, h)
  return { w: s, h: s, x: Math.round((w - s) / 2), y: Math.round((h - s) / 2) }
}

export const needsFraming = (file: FileRecord): boolean =>
  Math.abs(file.meta.width / file.meta.height - 1) > 0.02

/**
 * A preset's request: the whole frame (letterboxed when not square), 1×, one window.
 * Presets trim rather than crush: q30 turned smooth skin into visible blocks, so they
 * ask for q50 as the floor and fit the length instead.
 */
export function presetRequest(file: FileRecord, fps: number, start: number, len: number): ConvertRequest {
  const framed = needsFraming(file)
  return {
    fileId: file.id, start, end: start + len, spans: [{ start, end: start + len }],
    speed: 1, fps, fit: framed ? 'contain' : 'cover', padColor: '#000000',
    crop: framed ? null : squareCrop(file.meta.width, file.meta.height), cropPos: 0.5, border: false,
    minQ: 50,
  }
}

/**
 * Size a preset's window with the sampled estimate before the real encode: a full encode
 * that fails on the byte budget costs minutes on a small VM. No estimate → as is.
 */
export async function fitPresetLength(
  request: (len: number) => ConvertRequest,
  len: number,
  alive: () => boolean = () => true,
): Promise<number> {
  for (let i = 0; i < 3 && alive(); i++) {
    const e = await estimate(request(len)).catch(() => null)
    if (e?.busy) { await new Promise(r => setTimeout(r, 500)); continue }
    if (!e || e.fits !== false || e.maxSeconds == null) return len
    const next = nextFitLength(len, e.maxSeconds)
    if (next == null) return len
    len = next
  }
  return len
}

/**
 * The Short preset with no editor open: fit, encode, and refit on a budget miss, exactly
 * as the editor does. Resolves the finished draft job; it becomes a sticker when it joins
 * a pack.
 */
export async function encodeShort(
  file: FileRecord,
  onProgress: (e: Pick<JobEvent, 'progress' | 'stage'>) => void,
): Promise<string> {
  const fps = capFps(file.meta.fps)
  const duration = Math.max(file.meta.duration, 0.5)
  const request = (len: number): ConvertRequest => presetRequest(file, fps, 0, len)
  let len = file.kind === 'image'
    ? 1
    : await fitPresetLength(request, Math.max(0.5, Math.min(MAX_STICKER_SEC, duration)))
  for (let attempt = 1; ; attempt++) {
    const jobId = await convert(request(len), true)
    try {
      await watchJob(jobId, onProgress)
      return jobId
    } catch (err) {
      void discardDraft(jobId)
      const next = err instanceof EncodeError && err.fitSeconds != null && attempt < FIT_ATTEMPTS
        ? nextFitLength(len, err.fitSeconds)
        : null
      if (next == null) throw err
      len = next
      onProgress({ progress: 0, stage: `too big — trying ${len.toFixed(1)}s` })
    }
  }
}
