import type { JobStatus, StickerSpec } from './types.js'

export interface JobEvent {
  jobId: string
  status: JobStatus
  progress: number
  stage: string
  sizeBytes?: number
  error?: string
  /** Present once the WebP has been measured; absent while it is still encoding. */
  spec?: StickerSpec
}

// In-process fan-out, one set of listeners per job. Encodes are already in-process
// (see queue.ts), so there is nothing to coordinate across workers.
const listeners = new Map<string, Set<(e: JobEvent) => void>>()

export function subscribe(jobId: string, fn: (e: JobEvent) => void): () => void {
  let set = listeners.get(jobId)
  if (!set) {
    set = new Set()
    listeners.set(jobId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(jobId)
  }
}

export function publish(e: JobEvent): void {
  const set = listeners.get(e.jobId)
  if (!set) return
  // One bad listener must not starve the rest, and must never take down an encode.
  for (const fn of [...set]) {
    try {
      fn(e)
    } catch (err) {
      console.error('jobfeed listener failed:', err)
    }
  }
}

export const listenerCount = (jobId: string): number => listeners.get(jobId)?.size ?? 0
