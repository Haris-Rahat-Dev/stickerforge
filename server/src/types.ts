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

export interface ConvertSettings {
  start: number
  end: number
  speed: number
  fps: number
  fit: FitMode
  padColor: string
  crop: CropRect | null
  cropPos: number
  border: boolean
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
}
