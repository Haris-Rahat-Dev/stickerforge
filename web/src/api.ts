import type { BatchJobInfo, ConvertRequest, CropRect, FileRecord, Job, StickerSpec, StickerView } from './types.js'
import { authHeader, tokenQuery, freshTokenQuery } from './auth.js'

const BASE = ''

// Every /api call carries the ID token. One wrapper so no call site can forget it.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers ?? {}), ...(await authHeader()) }
  return fetch(url, { ...init, headers })
}

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
    void authHeader().then(h => {
      for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v)
      xhr.send(fd)
    }).catch(reject)
  })
}

export async function listFiles(): Promise<FileRecord[]> {
  const res = await apiFetch(`${BASE}/api/files`)
  if (!res.ok) return []
  return res.json()
}

export async function deleteFile(id: string): Promise<void> {
  await apiFetch(`${BASE}/api/file/${id}`, { method: 'DELETE' })
}

// ponytail: <img>/<video> cannot send Authorization — append ?token= from the
// cached ID token. Ceiling: hour-long tokens; auth.ts refreshes the cache.
export function videoUrl(id: string): string {
  return `${BASE}/api/video/${id}${tokenQuery()}`
}

export async function filmstripUrl(id: string): Promise<string | null> {
  try {
    const res = await apiFetch(`${BASE}/api/filmstrip/${id}`)
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch { return null }
}

export async function fitSpan(id: string): Promise<number | null> {
  const res = await apiFetch(`${BASE}/api/fit-span/${id}`)
  if (!res.ok) return null
  const json = await res.json() as { seconds?: number }
  return typeof json.seconds === 'number' ? json.seconds : null
}

export async function detectCrop(id: string): Promise<CropRect | null> {
  const res = await apiFetch(`${BASE}/api/cropdetect/${id}`)
  if (!res.ok) return null
  return res.json()
}

export async function convert(settings: ConvertRequest): Promise<string> {
  const res = await apiFetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Convert failed')
  return json.jobId as string
}

export async function quickConvert(fileId: string): Promise<string> {
  const res = await apiFetch(`${BASE}/api/batch`, {
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
  const res = await apiFetch(`${BASE}${url}`, {
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
export const buildPack = (
  code: string,
  onProgress?: (e: { progress: number; stage: string }) => void,
): Promise<PackManifest & { code: string }> =>
  apiFetch(`${BASE}/api/packs/${code}/build`, { method: 'POST' }).then(async res => {
    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({}))
      throw new Error((json as { error?: string }).error || 'Pack build failed')
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let result: (PackManifest & { code: string }) | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as {
          progress?: number
          stage?: string
          done?: boolean
          error?: string
          code?: string
          identifier?: string
          name?: string
          stickers?: PackManifest['stickers']
        }
        if (msg.error) throw new Error(msg.error)
        if (typeof msg.progress === 'number' && msg.stage) onProgress?.({ progress: msg.progress, stage: msg.stage })
        if (msg.done) {
          result = {
            code: msg.code || code,
            identifier: msg.identifier || '',
            name: msg.name || '',
            stickers: msg.stickers || [],
          }
        }
      }
    }
    if (!result) throw new Error('Pack build ended without a result')
    return result
  })

/** Public cached pack — used to reopen the install drawer without rebuilding. */
export async function fetchPackManifest(code: string): Promise<PackManifest & { code: string }> {
  const res = await fetch(`${BASE}/api/pack/${code}`)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Pack not found')
  return { ...json, code }
}

export async function getJob(jobId: string): Promise<Job> {
  const res = await apiFetch(`${BASE}/api/job/${jobId}`)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Job not found')
  return json
}

/** Stop a running encode and release its queue slot. */
export async function cancelJob(jobId: string): Promise<void> {
  await apiFetch(`${BASE}/api/job/${jobId}/cancel`, { method: 'POST' })
}

export function outputPreviewUrl(jobId: string): string {
  return `${BASE}/api/output/preview/${jobId}${tokenQuery()}`
}

export function webpPreviewUrl(jobId: string): string {
  return `${BASE}/api/output/webp/${jobId}${tokenQuery()}`
}

export function downloadWebm(jobId: string, name: string): void {
  void freshTokenQuery().then(q => triggerDownload(`${BASE}/api/download/webm/${jobId}${q}`, `${name}.webm`))
}

export function downloadTray(jobId: string, name: string): void {
  void freshTokenQuery().then(q => triggerDownload(`${BASE}/api/download/tray/${jobId}${q}`, `${name}.png`))
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
  /** Measured properties of the finished WebP; absent until the encode is verified. */
  spec?: StickerSpec
}

export async function deleteSticker(jobId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/sticker/${jobId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Could not delete sticker')
}

export async function setStickerEmojis(jobId: string, emojis: string[]): Promise<StickerView> {
  const res = await apiFetch(`${BASE}/api/sticker/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emojis }),
  })
  if (!res.ok) throw new Error('Could not set emojis')
  return res.json()
}

export const listStickers = (): Promise<StickerView[]> =>
  apiFetch(`${BASE}/api/stickers`).then(r => r.json())

export async function watchJob(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent> {
  const q = await freshTokenQuery()
  return new Promise<JobEvent>((resolve, reject) => {
    let settled = false
    const es = new EventSource(`${BASE}/api/job/${jobId}/stream${q}`)

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
      sizeBytes: j.webpBytes ?? j.sizeBytes,
      spec: j.spec,
      error: j.error,
    }
    on(e)
    if (e.status === 'done') return e
    if (e.status !== 'running') throw new Error(e.error || 'Encode failed')
    await new Promise(r => setTimeout(r, 600))
  }
}
