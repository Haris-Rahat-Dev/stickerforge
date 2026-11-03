export interface VideoMeta {
  width: number
  height: number
  fps: number
  duration: number
  bitrate: number
  codec: string
  pixFmt: string
  hasAudio: boolean
  sizeBytes: number
  /** Display-matrix rotation in degrees. Dimensions above are already post-rotation. */
  rotation?: number
}

export type QualityLevel = 'good' | 'ok' | 'warn'
export type NoteType = 'good' | 'info' | 'warn'

export interface QualityNote {
  type: NoteType
  msg: string
}

export interface QualityAssessment {
  level: QualityLevel
  notes: QualityNote[]
}

export interface CropRect {
  w: number
  h: number
  x: number
  y: number
}

export type FitMode = 'cover' | 'contain' | 'stretch'

import type { Span } from './spans.js'

export interface ConvertSettings {
  start: number
  end: number
  /** Kept ranges of the clip; `start`/`end` mirror the first span for old readers. */
  spans: Span[]
  speed: number
  fps: number
  fit: FitMode
  padColor: string
  crop: CropRect | null
  cropPos: number
  border: boolean
  /**
   * Lowest WebP quality the encoder may fall to. Unset = 30. Presets ask for 50: a busy
   * 4s at q30 had frames at SSIM 0.80 (visibly blocky) where trimming would have been clean.
   */
  minQ?: number
  /**
   * Caption burned over the sticker. The browser renders it to a 512×512 transparent PNG
   * — the same pixels its preview shows — stored once under data/captions/<id>.png.
   */
  caption?: Caption
}

export interface Caption {
  text: string
  pos: 'top' | 'bottom'
  /** sha256 of the PNG; the file is data/captions/<id>.png. */
  id: string
}

export type MediaKind = 'video' | 'image'

export interface FileRecord {
  id: string
  owner: string
  kind: MediaKind
  originalName: string
  path: string
  sizeBytes: number
  meta: VideoMeta
  quality: QualityAssessment
  suggestedCrop?: CropRect | null
}

export interface Pack {
  code: string
  owner: string
  name: string
  identifier: string
  version: number
  jobIds: string[]   // ordered membership (one job per sticker)
  /** Shown under the pack name in WhatsApp. */
  publisher: string
  /** The sticker whose frame is the pack's tray icon; null = the first one that has a tray. */
  trayJobId: string | null
  /** packSignature() at the last successful build; null = never built since tracking began. */
  builtSig: string | null
}

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

/**
 * Measured properties of a finished sticker, read back out of the encoded WebP
 * itself. Everything the UI shows as "within WhatsApp limits" comes from here,
 * never from what the encode was asked for.
 */
export interface StickerSpec {
  width: number
  height: number
  frames: number
  fps: number
  duration: number
  sizeBytes: number
  /** Luma SSIM vs the source frame; null when it could not be measured. */
  ssim: number | null
}

export interface Job {
  id: string
  owner: string
  kind: MediaKind
  fileId: string
  status: JobStatus
  progress: number
  stage: string
  outputPath: string
  trayPath?: string | null
  settings: ConvertSettings
  startedAt: number
  sizeBytes?: number
  /** WhatsApp WebP size/fps once the AnimEncoder pass has run. */
  webpBytes?: number
  webpFps?: number
  /** Measured from the encoded WebP — the only figures the UI may present as spec. */
  spec?: StickerSpec
  outMeta?: VideoMeta | null
  error?: string
  /** 1–3 emojis for the WhatsApp manifest. Absent means "not chosen yet". */
  emojis?: string[]
  /**
   * An editor encode still under review. Hidden from the sticker library and
   * discardable until it joins a pack, which clears the flag.
   */
  draft?: boolean
  /** On a byte-budget failure: the kept seconds the encoder measured would fit. */
  fitSeconds?: number
}
