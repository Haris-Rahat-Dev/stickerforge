import type { FileRecord } from './types.js'
import type { PackManifest, PackSummary } from './api.js'

// One reducer is the single source of truth for the whole app.
// Stages: import (no videos) → stage (edit the active pack) → install (built, phone handoff).
export type Stage = 'import' | 'stage' | 'install'

// A file's finished sticker (persisted per-browser). Membership in a pack is the
// server's business; a file is "in the active pack" when its jobId is in that
// pack's jobIds, computed in the UI — not stored here.
export interface Encoded { jobId: string; sizeBytes?: number }

export interface FlowState {
  stage: Stage
  files: FileRecord[]
  encoded: Record<string, Encoded>     // fileId → finished sticker
  encoding: Record<string, number>     // fileId → progress (0..1)
  errors: Record<string, string>       // fileId → message
  packs: PackSummary[]
  activeCode: string | null
  building: boolean
  built: (PackManifest & { code: string }) | null
  buildError: string | null
}

export type Action =
  | { type: 'hydrate'; files: FileRecord[]; packs: PackSummary[]; encoded: Record<string, Encoded>; activeCode: string | null }
  | { type: 'filesAdded'; files: FileRecord[] }
  | { type: 'fileRemoved'; id: string }
  | { type: 'encStart'; id: string }
  | { type: 'encProgress'; id: string; progress: number }
  | { type: 'encDone'; id: string; jobId: string; sizeBytes?: number }
  | { type: 'encError'; id: string; error: string }
  | { type: 'setPacks'; packs: PackSummary[] }
  | { type: 'setActive'; code: string | null }
  | { type: 'buildStart' }
  | { type: 'buildOk'; manifest: PackManifest & { code: string } }
  | { type: 'buildFail'; error: string }
  | { type: 'edit' }

const drop = <T,>(obj: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = obj
  return rest
}
const stageAfter = (files: FileRecord[], current: Stage): Stage =>
  files.length === 0 ? 'import' : current === 'install' ? 'install' : 'stage'

export function reducer(s: FlowState, a: Action): FlowState {
  switch (a.type) {
    case 'hydrate':
      return { ...s, files: a.files, packs: a.packs, encoded: a.encoded, activeCode: a.activeCode, stage: a.files.length ? 'stage' : 'import' }
    case 'filesAdded':
      return { ...s, files: [...s.files, ...a.files], stage: 'stage' }
    case 'fileRemoved': {
      const files = s.files.filter(f => f.id !== a.id)
      return { ...s, files, encoded: drop(s.encoded, a.id), encoding: drop(s.encoding, a.id), errors: drop(s.errors, a.id), stage: stageAfter(files, s.stage) }
    }
    case 'encStart':
      return { ...s, encoding: { ...s.encoding, [a.id]: 0 }, errors: drop(s.errors, a.id) }
    case 'encProgress':
      return a.id in s.encoding ? { ...s, encoding: { ...s.encoding, [a.id]: a.progress } } : s
    case 'encDone':
      return { ...s, encoding: drop(s.encoding, a.id), encoded: { ...s.encoded, [a.id]: { jobId: a.jobId, sizeBytes: a.sizeBytes } } }
    case 'encError':
      return { ...s, encoding: drop(s.encoding, a.id), errors: { ...s.errors, [a.id]: a.error } }
    case 'setPacks': {
      const activeCode = s.activeCode && a.packs.some(p => p.code === s.activeCode) ? s.activeCode : a.packs[0]?.code ?? null
      return { ...s, packs: a.packs, activeCode }
    }
    case 'setActive':
      return { ...s, activeCode: a.code, stage: a.code && s.files.length ? 'stage' : s.stage }
    case 'buildStart': return { ...s, building: true, buildError: null }
    case 'buildOk': return { ...s, building: false, built: a.manifest, buildError: null, stage: 'install' }
    case 'buildFail': return { ...s, building: false, buildError: a.error }
    case 'edit': return { ...s, stage: 'stage' }
    default: return s
  }
}

export const initialState = (encoded: Record<string, Encoded> = {}, activeCode: string | null = null): FlowState => ({
  stage: 'import', files: [], encoded, encoding: {}, errors: {},
  packs: [], activeCode, building: false, built: null, buildError: null,
})

// Derived: the active pack, and which files are members of it.
export const activePack = (s: FlowState): PackSummary | null => s.packs.find(p => p.code === s.activeCode) ?? null
export const inActivePack = (s: FlowState, fileId: string): boolean => {
  const enc = s.encoded[fileId]; const p = activePack(s)
  return !!enc && !!p && p.jobIds.includes(enc.jobId)
}
