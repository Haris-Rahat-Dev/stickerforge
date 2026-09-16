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

export interface FileRecord {
  id: string
  owner: string
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

export interface Job {
  id: string
  owner: string
  fileId: string
  status: JobStatus
  progress: number
  stage: string
  outputPath: string
  trayPath?: string | null
  settings: ConvertSettings
  startedAt: number
  sizeBytes?: number
  outMeta?: VideoMeta | null
  error?: string
}
