import type { FileRecord, UploadProgress, StickerView } from './types.js'
import type { PackManifest, PackSummary } from './api.js'

// Three routes: 'packs' is home; 'pack' is canvas; 'stickers' is library.
export type Route = 'packs' | 'pack' | 'stickers'

export interface FlowState {
  route: Route
  activeCode: string | null
  packs: PackSummary[]
  /** Sources uploaded but not yet committed as stickers. The staging shelf. */
  staged: FileRecord[]
  uploading: UploadProgress[]
  encoding: Record<string, number>   // fileId → progress (0..1)
  errors: Record<string, string>     // fileId → message
  building: boolean
  built: (PackManifest & { code: string }) | null
  buildError: string | null
  installOpen: boolean
}

export type Action =
  | { type: 'setPacks'; packs: PackSummary[] }
  | { type: 'openPack'; code: string }
  | { type: 'closePack' }
  | { type: 'openStickers' }
  | { type: 'staged'; files: FileRecord[] }
  | { type: 'discard'; fileId: string }
  | { type: 'committed'; fileId: string }
  | { type: 'uploadStart'; upload: UploadProgress }
  | { type: 'uploadProgress'; key: string; progress: number }
  | { type: 'uploadDone'; key: string }
  | { type: 'encStart'; fileId: string }
  | { type: 'encProgress'; fileId: string; progress: number }
  | { type: 'encError'; fileId: string; error: string }
  | { type: 'buildStart' }
  | { type: 'buildOk'; manifest: PackManifest & { code: string } }
  | { type: 'buildFail'; error: string }
  | { type: 'closeInstall' }
  | { type: 'openInstall' }

const drop = <T,>(obj: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = obj
  return rest
}

export function reducer(s: FlowState, a: Action): FlowState {
  switch (a.type) {
    case 'setPacks':
      return { ...s, packs: a.packs }
    case 'openPack':
      return { ...s, route: 'pack', activeCode: a.code, buildError: null }
    case 'closePack':
      // Staged sources belong to the canvas session, not the app. Leaving drops them
      // from view; the files themselves stay on the server until discarded or built.
      return { ...s, route: 'packs', activeCode: null, staged: [], installOpen: false, built: null }
    case 'openStickers':
      return { ...s, route: 'stickers', activeCode: null, staged: [], installOpen: false }
    case 'staged':
      return { ...s, staged: [...s.staged, ...a.files] }
    case 'discard':
    case 'committed':
      return {
        ...s,
        staged: s.staged.filter(f => f.id !== a.fileId),
        encoding: drop(s.encoding, a.fileId),
        errors: drop(s.errors, a.fileId),
      }
    case 'uploadStart':
      return { ...s, uploading: [...s.uploading, a.upload] }
    case 'uploadProgress':
      return { ...s, uploading: s.uploading.map(u => u.key === a.key ? { ...u, progress: a.progress } : u) }
    case 'uploadDone':
      return { ...s, uploading: s.uploading.filter(u => u.key !== a.key) }
    case 'encStart':
      return { ...s, encoding: { ...s.encoding, [a.fileId]: 0 }, errors: drop(s.errors, a.fileId) }
    case 'encProgress':
      return a.fileId in s.encoding ? { ...s, encoding: { ...s.encoding, [a.fileId]: a.progress } } : s
    case 'encError':
      return { ...s, encoding: drop(s.encoding, a.fileId), errors: { ...s.errors, [a.fileId]: a.error } }
    case 'buildStart':
      return { ...s, building: true, buildError: null }
    case 'buildOk':
      // The canvas stays mounted. Install is a drawer over it, not a screen replacing it.
      return { ...s, building: false, built: a.manifest, buildError: null, installOpen: true }
    case 'buildFail':
      return { ...s, building: false, buildError: a.error, installOpen: false }
    case 'closeInstall':
      return { ...s, installOpen: false }
    case 'openInstall':
      // Only meaningful once a manifest exists for this canvas session.
      return s.built ? { ...s, installOpen: true } : s
    default: {
      const _exhaustive: never = a
      void _exhaustive
      return s
    }
  }
}

export const initialState = (): FlowState => ({
  route: 'packs',
  activeCode: null,
  packs: [],
  staged: [],
  uploading: [],
  encoding: {},
  errors: {},
  building: false,
  built: null,
  buildError: null,
  installOpen: false,
})

export const activePack = (s: FlowState): PackSummary | null =>
  s.packs.find(p => p.code === s.activeCode) ?? null

export const stagedCount = (s: FlowState): number => s.staged.length + s.uploading.length

// Client-side filter over name, emojis, and the names of packs holding this sticker.
export function matchesQuery(s: StickerView, q: string, packNames: string[] = []): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (s.name.toLowerCase().includes(needle)) return true
  if (s.emojis && s.emojis.some(e => e.includes(needle))) return true
  return packNames.some(n => n.toLowerCase().includes(needle))
}
