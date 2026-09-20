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

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  fileId: string
  status: JobStatus
  progress: number
  stage: string
  settings: ConvertSettings
  sizeBytes?: number
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
}

