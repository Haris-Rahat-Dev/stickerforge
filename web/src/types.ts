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

export type MediaKind = 'video' | 'image'

export interface FileRecord {
  id: string
  kind: MediaKind
  originalName: string
  sizeBytes: number
  meta: VideoMeta
  quality: QualityAssessment
}

export interface ConvertSettings {
  start: number
  end: number
  /** Kept ranges of the clip; `start`/`end` mirror the first/last span for old readers. */
  spans: Span[]
  speed: number
  fps: number
  fit: FitMode
  padColor: string
  crop: CropRect | null
  cropPos: number
  border: boolean
}

export interface ConvertRequest extends ConvertSettings {
  fileId: string
}

/** Live projection from /api/estimate. All fields optional — server may reply busy/unknown/image. */
export interface EstimateResult {
  fits?: boolean
  keptSeconds?: number
  fps?: number
  effectiveFps?: number
  projectedKB?: number
  qNeeded?: number
  quality?: 'crisp' | 'good' | 'soft' | 'very soft'
  maxSeconds?: number
  busy?: boolean
  unknown?: boolean
  image?: boolean
}

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

/**
 * Measured out of the encoded WebP by the server, not the settings we asked for.
 * This is the only evidence the UI may present as "within WhatsApp limits".
 */
export interface StickerSpec {
  width: number
  height: number
  frames: number
  fps: number
  duration: number
  sizeBytes: number
  ssim: number | null
}

export interface Job {
  id: string
  fileId: string
  status: JobStatus
  progress: number
  stage: string
  settings: ConvertSettings
  sizeBytes?: number
  webpBytes?: number
  webpFps?: number
  spec?: StickerSpec
  outMeta?: VideoMeta | null
  trayPath?: string | null
  error?: string
}

export interface BatchJobInfo {
  jobId: string
  fileId: string
}

export interface UploadProgress {
  key: string
  name: string
  progress: number
}

export interface StickerView {
  jobId: string
  fileId: string
  kind: MediaKind
  name: string
  sizeBytes?: number
  editable: boolean
  emojis: string[]
  spec?: StickerSpec
}

