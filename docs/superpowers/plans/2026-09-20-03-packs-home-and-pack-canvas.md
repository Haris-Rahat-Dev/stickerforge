# Packs Home and Pack Canvas Implementation Plan (Plan 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plans 1 and 2 are merged and their manual verification steps passed. This plan consumes `packSummary.stickers` (`StickerView[]`) and `GET /api/stickers`, both added by Plan 2.

**Goal:** Replace the single overloaded grid with two screens — a packs home, and a pack canvas whose staging shelf holds transient sources above a sticker sheet that is the pack itself.

**Architecture:** `flow.ts` stops being a linear three-stage wizard and becomes a two-route reducer (`packs` | `pack`). The per-browser `encoded` localStorage map is deleted outright — accounts made it obsolete. Staged sources are files with no sticker; pack members come from the server. The install step becomes a drawer over the canvas instead of a screen that unmounts the workspace.

**Tech Stack:** React 18, Vite 6, TypeScript 5.7, plain CSS (`web/src/styles.css`), HTML5 drag-and-drop.

## Global Constraints

- **Design language is fixed**: die-cut print shop — Anton headlines, IBM Plex Mono labels, moss/cream/forge-green, hard stamp shadows, dashed die-cut edges, registration marks. Reuse the CSS variables and existing classes in `web/src/styles.css`. Do not introduce a generic dark-app look, a component library, or a CSS framework.
- **No new runtime dependencies.** Reordering uses the native HTML5 drag-and-drop API, not `dnd-kit` or `react-beautiful-dnd`.
- **No router dependency.** The route lives in the reducer; there are two screens.
- Pack minimum 3, maximum 30. The shortfall renders as outlined empty slots, never as a disabled button with no explanation.
- Preview must match the encode. Do not change `Editor.tsx`'s preview geometry in this plan.
- Do **not** add a Claude co-author or attribution line to commit messages.
- Do not push; the user pushes.

---

### Task 1: Rewrite the flow reducer

**Files:**
- Modify: `web/src/flow.ts` (full rewrite)
- Create: `web/test/flow.test.ts`
- Modify: `package.json` (extend the `test` script to cover web tests)

**Interfaces:**
- Consumes: `StickerView` from `web/src/types.ts` (Plan 2), `PackSummary` from `web/src/api.ts`.
- Produces:
  - `type Route = 'packs' | 'pack'`
  - `interface FlowState { route: Route; activeCode: string | null; packs: PackSummary[]; staged: FileRecord[]; uploading: UploadProgress[]; encoding: Record<string, number>; errors: Record<string, string>; building: boolean; built: (PackManifest & { code: string }) | null; buildError: string | null; installOpen: boolean }`
  - `reducer`, `initialState`, `activePack(s)`, `stagedCount(s)`
  - Tasks 2–4 consume all of these.

- [ ] **Step 1: Point the test script at both test directories**

```bash
npm pkg set scripts.test="node --test server/test/ web/test/"
```

- [ ] **Step 2: Write the failing test**

Create `web/test/flow.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, initialState, activePack, type FlowState } from '../src/flow.ts'

const pack = (code: string, ready = 0) =>
  ({ code, name: `Pack ${code}`, jobIds: [], ready, built: false, builtAt: null, stickers: [] })

const base = (over: Partial<FlowState> = {}): FlowState => ({ ...initialState(), ...over })

test('starts on the packs route', () => {
  assert.equal(initialState().route, 'packs')
})

test('opening a pack switches route and active code', () => {
  const s = reducer(base({ packs: [pack('abc')] }), { type: 'openPack', code: 'abc' })
  assert.equal(s.route, 'pack')
  assert.equal(s.activeCode, 'abc')
})

test('leaving a pack returns to packs and clears staged sources', () => {
  const s = reducer(
    base({ route: 'pack', activeCode: 'abc', staged: [{ id: 'f1' } as never] }),
    { type: 'closePack' })
  assert.equal(s.route, 'packs')
  assert.equal(s.activeCode, null)
  assert.deepEqual(s.staged, [])
})

test('committing a staged source removes it from the shelf', () => {
  const s = reducer(
    base({ staged: [{ id: 'f1' }, { id: 'f2' }] as never }),
    { type: 'committed', fileId: 'f1' })
  assert.deepEqual(s.staged.map(f => f.id), ['f2'])
})

test('a failed build keeps the pack open and records the error', () => {
  const s = reducer(base({ route: 'pack', building: true }), { type: 'buildFail', error: 'boom' })
  assert.equal(s.route, 'pack')
  assert.equal(s.building, false)
  assert.equal(s.buildError, 'boom')
  assert.equal(s.installOpen, false)
})

test('a successful build opens the install drawer without leaving the canvas', () => {
  const manifest = { code: 'abc', identifier: 'i', name: 'n', stickers: [] }
  const s = reducer(base({ route: 'pack', building: true }), { type: 'buildOk', manifest })
  assert.equal(s.route, 'pack', 'the canvas must stay mounted')
  assert.equal(s.installOpen, true)
})

test('activePack resolves the open pack', () => {
  assert.equal(activePack(base({ packs: [pack('a'), pack('b')], activeCode: 'b' }))?.code, 'b')
  assert.equal(activePack(base({ packs: [], activeCode: 'b' })), null)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `openPack` is not a known action, `route` is undefined.

- [ ] **Step 4: Rewrite `web/src/flow.ts`**

Replace the file entirely:

```ts
import type { FileRecord, UploadProgress } from './types.js'
import type { PackManifest, PackSummary } from './api.js'

// Two screens, one reducer. `packs` is the home list; `pack` is the canvas.
// There is deliberately no router dependency — there are two routes.
export type Route = 'packs' | 'pack'

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
    default:
      return s
  }
}

export const initialState = (): FlowState => ({
  route: 'packs', activeCode: null, packs: [], staged: [], uploading: [],
  encoding: {}, errors: {}, building: false, built: null, buildError: null, installOpen: false,
})

export const activePack = (s: FlowState): PackSummary | null =>
  s.packs.find(p => p.code === s.activeCode) ?? null

export const stagedCount = (s: FlowState): number => s.staged.length + s.uploading.length
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 6: Extend `PackSummary` on the client**

In `web/src/api.ts`, replace the `PackSummary` interface:

```ts
import type { StickerView } from './types.js'

export interface PackSummary {
  code: string
  name: string
  jobIds: string[]
  ready: number
  built: boolean
  builtAt: number | null
  stickers: StickerView[]
}
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: PASS

```bash
git add package.json web/src/flow.ts web/src/api.ts web/test/flow.test.ts
git commit -m "Flow: two routes, staging shelf state, install as a drawer"
```

---

### Task 2: Packs home screen

**Files:**
- Create: `web/src/components/PacksHome.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `FlowState`, `activePack` from Task 1; `listPacks`, `createPack`, `renamePack`, `deletePack` from `web/src/api.ts`.
- Produces: `<PacksHome packs onOpen onNew onRename onDelete />` with
  `onOpen: (code: string) => void`, `onNew: () => void`, `onRename: (code: string) => void`, `onDelete: (code: string) => void`.

- [ ] **Step 1: Write the component**

Create `web/src/components/PacksHome.tsx`:

```tsx
import type { PackSummary } from '../api.js'

export default function PacksHome({ packs, onOpen, onNew, onRename, onDelete }: {
  packs: PackSummary[]
  onOpen: (code: string) => void
  onNew: () => void
  onRename: (code: string) => void
  onDelete: (code: string) => void
}) {
  if (packs.length === 0) {
    return (
      <main className="empty" onClick={onNew}>
        <div className="empty-box">
          <div className="empty-icon">📦</div>
          <h2>No packs <em>yet</em></h2>
          <p>a pack is 3–30 stickers, ready for WhatsApp</p>
          <div className="empty-steps"><span>＋ Start your first pack</span></div>
        </div>
      </main>
    )
  }

  return (
    <main className="content">
      <div className="toolbar">
        <button className="btn btn-primary" onClick={onNew}>＋ New pack</button>
        <span className="switch-label">{packs.length} pack{packs.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid">
        {packs.map(p => (
          <div key={p.code} className="card pack-card" onClick={() => onOpen(p.code)}>
            <div className="thumb square pack-tray">
              {p.stickers.length > 0
                ? <img className="thumb-cover" src={`/api/pack/${p.code}/file/tray.png`} alt=""
                    onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                : <div className="pack-tray-empty">📦</div>}
              <span className={`status-chip ${p.built ? 'inpack' : 'review'}`}>
                {p.built ? '✓ Built' : 'Draft'}
              </span>
            </div>
            <div className="card-body">
              <div className="card-name" title={p.name}>{p.name}</div>
              <div className="meta-line">
                {p.ready} sticker{p.ready === 1 ? '' : 's'}
                {p.ready < 3 && <> · need {3 - p.ready} more</>}
                {p.builtAt && <> · built {new Date(p.builtAt).toLocaleDateString()}</>}
              </div>
              <div className="card-actions">
                <button className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onRename(p.code) }}>Rename</button>
                <button className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onDelete(p.code) }}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Add the styles**

Append to `web/src/styles.css`:

```css
/* ── packs home ─────────────────────────────────────────────────────────── */
.pack-card { cursor: pointer; }
.pack-tray { display: grid; place-items: center; background: var(--bg-sunken, #10140d); }
.pack-tray-empty { font-size: 48px; opacity: 0.35; }
```

If `--bg-sunken` is not already defined in `:root`, use the darkest existing background variable in the file instead of inventing one. Read the `:root` block before writing this.

- [ ] **Step 3: Render it from `App.tsx`**

In `web/src/App.tsx`, import `PacksHome` and render it when `state.route === 'packs'`. The existing `newPack`, `renameActive`, and `deleteActive` handlers become code-parameterised:

```tsx
const newPack = async (): Promise<void> => {
  const name = prompt('Name this pack', `Pack ${state.packs.length + 1}`)?.trim()
  if (!name) return
  const p = await createPack(name)
  await refreshPacks()
  dispatch({ type: 'openPack', code: p.code })
}

const renamePackByCode = async (code: string): Promise<void> => {
  const p = state.packs.find(x => x.code === code); if (!p) return
  const name = prompt('Rename pack', p.name)?.trim()
  if (!name || name === p.name) return
  await renamePack(code, name); await refreshPacks()
}

const deletePackByCode = async (code: string): Promise<void> => {
  const p = state.packs.find(x => x.code === code); if (!p) return
  if (!confirm(`Delete pack "${p.name}"? Stickers used only by this pack are removed too.`)) return
  await deletePack(code); await refreshPacks()
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run build`
Expected: PASS

```bash
git add web/src/components/PacksHome.tsx web/src/styles.css web/src/App.tsx
git commit -m "Packs home screen"
```

---

### Task 3: Pack canvas — staging shelf and sticker sheet

**Files:**
- Create: `web/src/components/PackCanvas.tsx`
- Create: `web/src/components/StagingShelf.tsx`
- Create: `web/src/components/StickerSheet.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `FlowState` from Task 1, `StickerView` from Plan 2.
- Produces:
  - `<StagingShelf staged uploading encoding errors onEdit onDiscard />`
  - `<StickerSheet stickers onReorder onFineTune onReplace onRemove />` with `onReorder: (jobIds: string[]) => void`
  - `<PackCanvas ... />` composing both plus the header and build bar.

- [ ] **Step 1: Write the staging shelf**

Create `web/src/components/StagingShelf.tsx`:

```tsx
import { useRef } from 'react'
import { videoUrl } from '../api.js'
import type { FileRecord, UploadProgress } from '../types.js'

const QUALITY: Record<string, string> = { good: '✓ Great', ok: '~ Usable', warn: '! Rough' }

export default function StagingShelf({ staged, uploading, encoding, errors, onEdit, onDiscard }: {
  staged: FileRecord[]
  uploading: UploadProgress[]
  encoding: Record<string, number>
  errors: Record<string, string>
  onEdit: (fileId: string) => void
  onDiscard: (fileId: string) => void
}) {
  // The shelf's existence IS the "unfinished work" signal. Empty means everything
  // is filed, so it collapses to nothing rather than showing an empty state.
  if (staged.length === 0 && uploading.length === 0) return null

  return (
    <section className="shelf">
      <div className="shelf-label">
        Staging · {staged.length + uploading.length} not in the pack yet
      </div>
      <div className="shelf-rail">
        {staged.map(f => (
          <ShelfCard key={f.id} file={f}
            progress={f.id in encoding ? encoding[f.id] : null}
            error={errors[f.id] ?? null}
            onEdit={() => onEdit(f.id)} onDiscard={() => onDiscard(f.id)} />
        ))}
        {uploading.map(u => (
          <div key={u.key} className="shelf-card">
            <div className="thumb square skeleton">
              <span className="status-chip encoding">Uploading… {Math.round(u.progress * 100)}%</span>
              <div className="thumb-progress">
                <div className="progress-fill" style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
            </div>
            <div className="shelf-name" title={u.name}>{u.name}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ShelfCard({ file, progress, error, onEdit, onDiscard }: {
  file: FileRecord; progress: number | null; error: string | null
  onEdit: () => void; onDiscard: () => void
}) {
  const vid = useRef<HTMLVideoElement>(null)
  return (
    <div className="shelf-card">
      <div className="thumb square" onClick={onEdit} title="Edit and add to the pack">
        {file.kind === 'image'
          ? <img className="thumb-cover" src={videoUrl(file.id)} alt={file.originalName} />
          : <video ref={vid} className="thumb-cover" src={`${videoUrl(file.id)}#t=0.1`}
              muted loop playsInline preload="metadata"
              onMouseEnter={() => vid.current?.play().catch(() => {})}
              onMouseLeave={() => { const v = vid.current; if (v) { v.pause(); v.currentTime = 0.1 } }} />}
        <span className={`chip chip-${file.quality.level}`}>{QUALITY[file.quality.level]}</span>
        {progress != null && (
          <div className="thumb-progress">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <button className="icon-btn remove" title="Discard this upload"
          onClick={e => { e.stopPropagation(); onDiscard() }}>✕</button>
      </div>
      <div className="shelf-name" title={file.originalName}>{file.originalName}</div>
      {error && <div className="warn-line">✗ {error}</div>}
      <button className="btn btn-primary btn-sm" onClick={onEdit}>Edit &amp; add</button>
    </div>
  )
}
```

- [ ] **Step 2: Write the sticker sheet**

Create `web/src/components/StickerSheet.tsx`:

```tsx
import { useState } from 'react'
import { outputPreviewUrl } from '../api.js'
import type { StickerView } from '../types.js'

const MIN = 3
const MAX = 30

export default function StickerSheet({ stickers, onReorder, onFineTune, onReplace, onRemove }: {
  stickers: StickerView[]
  onReorder: (jobIds: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)

  // Native HTML5 DnD: drop onto a tile inserts the dragged sticker at that index.
  const dropOn = (targetJobId: string): void => {
    if (!dragging || dragging === targetJobId) return
    const ids = stickers.map(s => s.jobId)
    const from = ids.indexOf(dragging)
    const to = ids.indexOf(targetJobId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    onReorder(ids)
    setDragging(null)
  }

  const shortfall = Math.max(0, MIN - stickers.length)

  return (
    <section className="sheet">
      <div className="sheet-label">
        Pack · {stickers.length}/{MAX}
        {shortfall > 0 && <span className="muted"> · {shortfall} more to reach WhatsApp's minimum</span>}
      </div>
      <div className="grid sheet-grid">
        {stickers.map(s => (
          <div
            key={s.jobId}
            className={`card sticker-tile${dragging === s.jobId ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragging(s.jobId)}
            onDragEnd={() => setDragging(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); dropOn(s.jobId) }}
          >
            <div className="thumb square">
              <video className="thumb-cover" src={outputPreviewUrl(s.jobId)}
                muted loop autoPlay playsInline preload="metadata" />
              <span className="sticker-emoji">{s.emojis[0]}</span>
              {!s.editable && <span className="status-chip locked" title="Source deleted at build">🔒</span>}
            </div>
            <div className="card-body">
              <div className="card-name" title={s.name}>{s.name}</div>
              <div className="meta-line">
                {s.sizeBytes ? `${Math.round(s.sizeBytes / 1024)}KB` : '—'}
                {!s.editable && ' · locked'}
              </div>
              <div className="card-actions">
                {s.editable
                  ? <button className="btn btn-ghost btn-sm" onClick={() => onFineTune(s)}>Fine-tune</button>
                  : <button className="btn btn-ghost btn-sm" onClick={() => onReplace(s)}>Replace</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => onRemove(s)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
        {Array.from({ length: shortfall }, (_, i) => (
          <div key={`slot-${i}`} className="card slot-empty">
            <div className="thumb square"><span className="slot-hint">empty slot</span></div>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Add the styles**

Append to `web/src/styles.css`:

```css
/* ── pack canvas ────────────────────────────────────────────────────────── */
.shelf { padding: 16px 28px 0; max-width: 1280px; margin: 0 auto; }
.shelf-label, .sheet-label {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 10px;
}
.shelf-rail { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 14px; }
.shelf-card { flex: 0 0 168px; display: flex; flex-direction: column; gap: 8px; }
.shelf-name {
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sheet { padding: 20px 28px 96px; max-width: 1280px; margin: 0 auto; }
.sticker-tile { cursor: grab; }
.sticker-tile.dragging { opacity: 0.45; }
.sticker-emoji { position: absolute; bottom: 8px; left: 8px; font-size: 20px; }
.status-chip.locked { background: rgba(0, 0, 0, 0.6); }
.slot-empty { border-style: dashed; opacity: 0.5; box-shadow: none; }
.slot-hint {
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); display: grid; place-items: center; height: 100%;
}
```

Read the existing `:root` block first and substitute the real variable names if `--muted` or `--font-mono` differ.

- [ ] **Step 4: Compose the canvas**

Create `web/src/components/PackCanvas.tsx`, wiring the header (back, inline-renameable name, state chip), `StagingShelf`, `StickerSheet`, and a build bar reusing the existing `.pack-bar` classes. Build is disabled when `ready < 3`, `ready > 30`, or an encode is running; the bar states the reason in words rather than only disabling.

```tsx
import StagingShelf from './StagingShelf.jsx'
import StickerSheet from './StickerSheet.jsx'
import type { PackSummary } from '../api.js'
import type { FileRecord, StickerView, UploadProgress } from '../types.js'

export default function PackCanvas(props: {
  pack: PackSummary
  staged: FileRecord[]
  uploading: UploadProgress[]
  encoding: Record<string, number>
  errors: Record<string, string>
  building: boolean
  buildError: string | null
  onBack: () => void
  onRename: () => void
  onAddMedia: () => void
  onEditStaged: (fileId: string) => void
  onDiscardStaged: (fileId: string) => void
  onReorder: (jobIds: string[]) => void
  onFineTune: (s: StickerView) => void
  onReplace: (s: StickerView) => void
  onRemove: (s: StickerView) => void
  onBuild: () => void
}) {
  const { pack, building, buildError } = props
  const encodingNow = Object.keys(props.encoding).length > 0
  const reason =
    pack.ready < 3 ? `need ${3 - pack.ready} more sticker${3 - pack.ready === 1 ? '' : 's'}`
    : pack.ready > 30 ? 'over WhatsApp’s 30-sticker limit'
    : encodingNow ? 'waiting for encodes to finish'
    : null

  return (
    <>
      <div className="toolbar canvas-bar">
        <button className="btn btn-ghost btn-sm" onClick={props.onBack}>← Packs</button>
        <button className="pack-title" onClick={props.onRename} title="Rename">{pack.name}</button>
        <span className={`status-chip ${pack.built ? 'inpack' : 'review'}`}>
          {pack.built ? '✓ Built' : 'Draft'}
        </span>
        <button className="btn btn-ghost" onClick={props.onAddMedia}>＋ Add media</button>
      </div>

      <StagingShelf
        staged={props.staged} uploading={props.uploading}
        encoding={props.encoding} errors={props.errors}
        onEdit={props.onEditStaged} onDiscard={props.onDiscardStaged} />

      <StickerSheet
        stickers={pack.stickers} onReorder={props.onReorder}
        onFineTune={props.onFineTune} onReplace={props.onReplace} onRemove={props.onRemove} />

      <div className="pack-bar">
        <div className="pack-status">
          <b>{pack.ready}</b> in <em>{pack.name}</em>
          {reason && <span className="muted"> · {reason}</span>}
        </div>
        {buildError && <div className="pack-err">✗ {buildError}</div>}
        <button className="btn btn-primary" disabled={!!reason || building} onClick={props.onBuild}>
          {building ? 'Building pack…' : pack.built ? '↻ Rebuild pack' : '⚡ Build pack'}
        </button>
      </div>
    </>
  )
}
```

Add the two supporting styles:

```css
.canvas-bar { padding: 24px 28px 0; max-width: 1280px; margin: 0 auto; }
.pack-title {
  font-family: var(--font-display); font-size: 22px; background: none; border: 0;
  color: inherit; cursor: text; padding: 0;
}
```

- [ ] **Step 5: Warn before building**

Building deletes sources irreversibly. In `App.tsx`'s build handler, confirm first:

```tsx
const doBuild = async (): Promise<void> => {
  const pack = activePack(state); if (!pack) return
  const editable = pack.stickers.filter(s => s.editable).length
  if (editable > 0 && !confirm(
    `Build "${pack.name}"?\n\nThis deletes the original videos for ${editable} sticker` +
    `${editable === 1 ? '' : 's'}. The stickers keep working and the pack can still be ` +
    `rebuilt — but they can no longer be re-cropped or re-trimmed.`
  )) return
  dispatch({ type: 'buildStart' })
  try {
    dispatch({ type: 'buildOk', manifest: await buildPack(pack.code) })
    await refreshPacks()
  } catch (err) {
    dispatch({ type: 'buildFail', error: err instanceof Error ? err.message : 'Pack build failed' })
  }
}
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run build`
Expected: PASS

```bash
git add web/src/components/PackCanvas.tsx web/src/components/StagingShelf.tsx web/src/components/StickerSheet.tsx web/src/styles.css web/src/App.tsx
git commit -m "Pack canvas: staging shelf above the sticker sheet"
```

---

### Task 4: Install drawer, replace-in-place, and App rewiring

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/components/InstallDrawer.tsx`
- Modify: `web/src/components/Editor.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `<InstallDrawer manifest onClose />`
  - `Editor` gains `replaceAt?: number` — when present, the committed job is written into that index of the pack's ordered array instead of appended.

- [ ] **Step 1: Write the install drawer**

Create `web/src/components/InstallDrawer.tsx` by moving the body of the existing `InstallStage` function out of `App.tsx`, changing the outer element from `<main className="content install">` to:

```tsx
<div className="drawer-scrim" onClick={onClose}>
  <aside className="drawer" onClick={e => e.stopPropagation()}>
    <button className="icon-btn drawer-close" onClick={onClose}>✕</button>
    {/* …existing QR column, sticker row, and handoff list, unchanged… */}
  </aside>
</div>
```

Keep the QR generation, the deep link `stickerforge://pack/${manifest.code}`, the pack-code line, and the two handoff steps exactly as they are. Delete `InstallStage` from `App.tsx`.

Add the styles:

```css
.drawer-scrim {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; justify-content: flex-end; z-index: 40;
}
.drawer {
  width: min(560px, 100%); height: 100%; overflow-y: auto; padding: 28px;
  background: var(--bg); border-left: 2px solid var(--line, #2a3020);
}
.drawer-close { position: absolute; top: 18px; right: 18px; opacity: 1; }
```

- [ ] **Step 2: Add replace-in-place to the editor's commit path**

In `web/src/components/Editor.tsx`, widen the props:

```tsx
export default function Editor({ file, replaceAt, onClose, onAddedToPack }: {
  file: FileRecord
  /** When set, the finished job replaces the pack member at this index rather than appending. */
  replaceAt?: number
  onClose: () => void
  onAddedToPack?: (jobId: string, sizeBytes?: number, replaceAt?: number) => void
}) {
```

and pass `replaceAt` through at the single call site where it reports completion:

```tsx
        if (j.status === 'done') { onAddedToPack?.(jobId, j.sizeBytes, replaceAt); clearInterval(timer) }
```

- [ ] **Step 3: Rewire `App.tsx`**

The component now:

- holds `useReducer(reducer, undefined, initialState)` with no localStorage seed — **delete `ENC_KEY`, `ACTIVE_KEY`, `loadEncoded`, `saveEncoded`, `loadActive`, `saveActive`, and both persistence `useEffect`s.** Accounts replaced them.
- on mount, fetches `listPacks()` only. Staged sources start empty each session.
- renders `<PacksHome>` when `route === 'packs'`, `<PackCanvas>` when `route === 'pack'`, `<InstallDrawer>` when `installOpen && built`, and `<Editor>` when an editor target is set.
- keeps `mutateMembership` exactly as it is — it already serialises writes and re-reads membership from the server, which is what makes reorder, replace, and remove safe against each other.

The commit handler, covering both append and replace:

```tsx
const onCommitted = async (jobId: string, _size?: number, replaceAt?: number): Promise<void> => {
  const code = state.activeCode
  if (!code) return
  await mutateMembership(code, ids => {
    const next = ids.filter(id => id !== jobId)
    if (replaceAt != null && replaceAt >= 0 && replaceAt < next.length + 1) next.splice(replaceAt, 1, jobId)
    else next.push(jobId)
    return next
  })
  if (editorTarget) dispatch({ type: 'committed', fileId: editorTarget.file.id })
  setEditorTarget(null)
  await refreshPacks()
}
```

Replace is: remember the index, open the file picker, stage the upload, then open the editor with `replaceAt` set:

```tsx
const [editorTarget, setEditorTarget] = useState<{ file: FileRecord; replaceAt?: number } | null>(null)
const replaceIndexRef = useRef<number | null>(null)

const onReplace = (s: StickerView): void => {
  const pack = activePack(state); if (!pack) return
  replaceIndexRef.current = pack.stickers.findIndex(x => x.jobId === s.jobId)
  inputRef.current?.click()   // the newly staged file opens the editor with replaceAt
}
```

In `addFiles`, after a successful upload, if `replaceIndexRef.current != null`, open the editor on that file with `replaceAt` and clear the ref.

- [ ] **Step 4: Remove from pack vs delete sticker**

`onRemove` takes the sticker out of this pack only; the server's reference count decides whether its files die. Do not call `deleteSticker` here — that belongs to Plan 4's All-stickers screen.

```tsx
const onRemove = async (s: StickerView): Promise<void> => {
  const code = state.activeCode; if (!code) return
  await mutateMembership(code, ids => ids.filter(id => id !== s.jobId))
  await refreshPacks()
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

```bash
git add web/src/App.tsx web/src/components/InstallDrawer.tsx web/src/components/Editor.tsx web/src/styles.css
git commit -m "Install drawer, replace-in-place, and App rewired onto two routes"
```

---

### Task 5: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace the flow description**

Replace the paragraph beginning "Flow (staging tray, no batch mode): import → stage → build → install." with:

```markdown
Flow: **packs home → pack canvas → build → install drawer**. The home screen lists
your packs. Opening one shows the canvas: a **staging shelf** of uploaded-but-uncommitted
sources on top, collapsed to nothing when empty, above the **sticker sheet** that is the
pack itself (drag to reorder, outlined empty slots below three). Editing a staged source
in the editor and committing it moves it down into the sheet. At ≥3, Build assembles the
WebP pack, **deletes the sources**, and opens the install drawer over the canvas.

App state is one reducer with two routes (`web/src/flow.ts`). There is no router
dependency and no localStorage — accounts replaced the per-browser `encoded` map.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "Docs: packs home and pack canvas flow"
```

---

## Manual verification before calling this done

1. Sign in with no packs — confirm the empty state invites creating one.
2. Create a pack, drop four videos. The shelf shows four; the sheet shows zero plus three outlined slots.
3. Commit each one. Watch the shelf drain and the sheet fill. At three, the slots disappear.
4. Drag a sticker to reorder. Reload the page — the order persisted.
5. Build. Read the confirm dialog, accept, and confirm the install drawer opens **over** the canvas, with the sheet still visible behind it.
6. Close the drawer. Every sticker now shows the lock badge and offers Replace instead of Fine-tune.
7. Replace one. Confirm the new sticker lands in the same position, not at the end.
8. Hard-refresh (⌘⇧R) after any CSS change — `npm run dev` caches aggressively.
