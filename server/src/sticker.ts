import fs from 'node:fs'
import type { FileRecord, Job, MediaKind } from './types.js'

export interface StickerView {
  jobId: string
  fileId: string
  kind: MediaKind
  name: string
  sizeBytes?: number
  /** True while the original upload is still on disk. Re-cropping needs it. */
  editable: boolean
  emojis: string[]
}

// Editability is derived, never stored. Building a pack deletes its sources, which is
// what locks its stickers; uploads made afterwards stay editable until the next build.
export function isEditable(job: Job, source: FileRecord | undefined): boolean {
  return !!source && fs.existsSync(source.path)
}

export const DEFAULT_EMOJI = '😂'

// WhatsApp accepts 1–3 emojis per sticker and rejects a manifest that breaks that.
// Enforced here rather than only in the picker, because the route accepts arbitrary JSON.
export function normaliseEmojis(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const clean = list
    .filter((e): e is string => typeof e === 'string')
    .map(e => e.trim())
    .filter(e => e.length > 0)
    .slice(0, 3)
  return clean.length > 0 ? clean : [DEFAULT_EMOJI]
}

export function stickerView(job: Job, source: FileRecord | undefined): StickerView {
  return {
    jobId: job.id,
    fileId: job.fileId,
    kind: job.kind,
    name: source?.originalName ?? `sticker-${job.id.slice(0, 8)}`,
    sizeBytes: job.sizeBytes,
    editable: isEditable(job, source),
    emojis: normaliseEmojis(job.emojis),
  }
}

// Membership is deduped by jobId, not fileId. The old fileId dedupe existed to heal
// packs where fine-tuning left a stale job behind; replace-in-place now handles that
// explicitly, and keying on fileId wrongly collapses two legitimate trims of one source.
export const dedupeMembership = (jobIds: string[]): string[] => [...new Set(jobIds)]
