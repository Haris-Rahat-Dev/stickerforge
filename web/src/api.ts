import type { BatchJobInfo, ConvertRequest, CropRect, FileRecord, Job, StickerView } from './types.js'

const BASE = ''

export function uploadFile(file: File, onProgress?: (p: number) => void): Promise<FileRecord> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/api/upload`)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText)
        xhr.status === 200 ? resolve(json) : reject(new Error(json.error || `Upload failed (${xhr.status})`))
      } catch { reject(new Error('Bad server response')) }
    }
    xhr.onerror = () => reject(new Error('Upload failed — is the server running?'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

export async function listFiles(): Promise<FileRecord[]> {
  const res = await fetch(`${BASE}/api/files`)
  if (!res.ok) return []
  return res.json()
}

export async function deleteFile(id: string): Promise<void> {
  await fetch(`${BASE}/api/file/${id}`, { method: 'DELETE' })
}

export function videoUrl(id: string): string {
  return `${BASE}/api/video/${id}`
}

export async function filmstripUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/filmstrip/${id}`)
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch { return null }
}

export async function detectCrop(id: string): Promise<CropRect | null> {
  const res = await fetch(`${BASE}/api/cropdetect/${id}`)
  if (!res.ok) return null
  return res.json()
}

export async function convert(settings: ConvertRequest): Promise<string> {
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Convert failed')
  return json.jobId as string
}

// One-tap "Add to pack": reuses the batch endpoint's proven default logic
// (cropdetect + cover + sensible fps) for a single file. Returns its jobId.
export async function quickConvert(fileId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [fileId] })
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Convert failed')
  const info = json[0] as BatchJobInfo | undefined
  if (!info) throw new Error('Convert failed — no job created')
  return info.jobId
}

export interface PackManifest {
  identifier: string
  name: string
  stickers: Array<{ image_file: string; emojis: string[] }>
}

export interface PackSummary {
  code: string
  name: string
  jobIds: string[]
  ready: number
  built: boolean
  builtAt?: number | null
  stickers: StickerView[]
}

async function packJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `${method} ${url} failed`)
  return json
}

export const listPacks = (): Promise<PackSummary[]> => packJson('/api/packs', 'GET')
export const createPack = (name: string): Promise<PackSummary> => packJson('/api/packs', 'POST', { name })
export const renamePack = (code: string, name: string): Promise<PackSummary> => packJson(`/api/packs/${code}`, 'PATCH', { name })
export const deletePack = (code: string): Promise<void> => packJson(`/api/packs/${code}`, 'DELETE')
export const setPackStickers = (code: string, jobIds: string[]): Promise<PackSummary> => packJson(`/api/packs/${code}/stickers`, 'PUT', { jobIds })
export const buildPack = (code: string): Promise<PackManifest & { code: string }> => packJson(`/api/packs/${code}/build`, 'POST')

export async function getJob(jobId: string): Promise<Job> {
  const res = await fetch(`${BASE}/api/job/${jobId}`)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Job not found')
  return json
}

export function outputPreviewUrl(jobId: string): string {
  return `${BASE}/api/output/preview/${jobId}`
}

export function downloadWebm(jobId: string, name: string): void {
  triggerDownload(`${BASE}/api/download/webm/${jobId}`, `${name}.webm`)
}

export function downloadTray(jobId: string, name: string): void {
  triggerDownload(`${BASE}/api/download/tray/${jobId}`, `${name}.png`)
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export interface JobEvent {
  jobId: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  stage: string
  sizeBytes?: number
  error?: string
}

export async function deleteSticker(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sticker/${jobId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Could not delete sticker')
}

export async function setStickerEmojis(jobId: string, emojis: string[]): Promise<StickerView> {
  const res = await fetch(`${BASE}/api/sticker/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emojis }),
  })
  if (!res.ok) throw new Error('Could not set emojis')
  return res.json()
}

export const listStickers = (): Promise<StickerView[]> =>
  fetch(`${BASE}/api/stickers`).then(r => r.json())

export async function watchJob(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent> {
  return new Promise<JobEvent>((resolve, reject) => {
    let settled = false
    const es = new EventSource(`${BASE}/api/job/${jobId}/stream`)

    es.onmessage = ev => {
      try {
        const e = JSON.parse(ev.data) as JobEvent
        on(e)
        if (e.status === 'running') return
        settled = true
        es.close()
        e.status === 'done' ? resolve(e) : reject(new Error(e.error || 'Encode failed'))
      } catch (err) {
        if (settled) return
        settled = true
        es.close()
        reject(err)
      }
    }

    es.onerror = () => {
      if (settled) return
      settled = true
      es.close()
      pollJobUntilDone(jobId, on).then(resolve, reject)
    }
  })
}

async function pollJobUntilDone(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent> {
  for (;;) {
    const j = await getJob(jobId)
    const e: JobEvent = {
      jobId,
      status: j.status,
      progress: j.progress,
      stage: j.stage,
      sizeBytes: j.sizeBytes,
      error: j.error,
    }
    on(e)
    if (e.status === 'done') return e
    if (e.status !== 'running') throw new Error(e.error || 'Encode failed')
    await new Promise(r => setTimeout(r, 600))
  }
}

