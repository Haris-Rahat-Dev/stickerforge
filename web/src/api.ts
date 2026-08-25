import type { BatchJobInfo, ConvertRequest, CropRect, FileRecord, Job } from './types'

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

export async function batchConvert(fileIds: string[]): Promise<BatchJobInfo[]> {
  const res = await fetch(`${BASE}/api/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds })
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || 'Batch failed')
  return json
}

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
