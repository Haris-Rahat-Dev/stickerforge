# Sticker Reuse, Search, and Emojis Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plans 1–3 are merged and their manual verification steps passed. This plan consumes `GET /api/stickers`, `StickerView`, `countPacksWithJob`, and `DELETE /api/sticker/:jobId` from Plan 2, and the two-route shell from Plan 3.

**Goal:** Make finished stickers a first-class, browsable, reusable noun — an All-stickers screen with search, the ability to add an existing sticker to another pack, and per-sticker emoji editing that reaches the WhatsApp manifest.

**Architecture:** Stickers are already durable and already reference-counted (Plan 2), and `pack_stickers` is already a join table, so reuse needs no schema change. Emojis move from an auto-assigned sequence into the job record's JSON, which is already persisted whole. The All-stickers screen is a third route on the existing reducer.

**Tech Stack:** React 18, Express 4, built-in `node:sqlite`, `node:test`.

## Global Constraints

- **No schema migration.** Emojis live in the job record's existing JSON blob; `saveJob` already serialises the whole record.
- **WhatsApp requires 1–3 emojis per sticker.** Enforce that range server-side, not only in the picker.
- **No emoji-picker dependency.** A fixed palette of common meme emojis plus a free-text field is enough; adding `emoji-mart` for this would be absurd.
- Search is client-side. Do not add an index, a search service, or a query parameter.
- Pack minimum 3, maximum 30 stickers, unchanged.
- Do **not** add a Claude co-author or attribution line to commit messages.
- Do not push; the user pushes.

## One behaviour change this plan makes deliberately

`assemblePack` and `PUT /api/packs/:code/stickers` both currently collapse membership to **one sticker per `fileId`** (commit 8baf669), to heal packs where fine-tuning left a stale jobId behind. Replace-in-place (Plan 3) now handles that case explicitly, and the dedupe actively prevents a legitimate use of reuse: two different trims of the same source in one pack.

Task 3 removes the `fileId` dedupe and replaces it with a `jobId` dedupe. This is the one place this plan can regress previously-fixed behaviour, so it lands with its own test.

---

### Task 1: Store per-sticker emojis

**Files:**
- Modify: `server/src/types.ts` (add `emojis` to `Job`)
- Modify: `server/src/index.ts` (`emojisFor`, `assemblePack`, new PATCH route)
- Modify: `server/src/sticker.ts`
- Create/Modify: `server/test/emoji.test.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: `stickerView` from Plan 2.
- Produces:
  - `Job.emojis?: string[]`
  - `normaliseEmojis(input: unknown): string[]` in `server/src/sticker.ts` — always returns 1–3 entries.
  - `PATCH /api/sticker/:jobId` body `{ emojis: string[] }` → `StickerView`
  - `setStickerEmojis(jobId: string, emojis: string[]): Promise<StickerView>` in `web/src/api.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/emoji.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseEmojis } from '../src/sticker.ts'

test('keeps a valid 1-3 emoji list', () => {
  assert.deepEqual(normaliseEmojis(['😂']), ['😂'])
  assert.deepEqual(normaliseEmojis(['😂', '🔥', '💀']), ['😂', '🔥', '💀'])
})

test('truncates past three, which WhatsApp rejects', () => {
  assert.deepEqual(normaliseEmojis(['😂', '🔥', '💀', '👀']), ['😂', '🔥', '💀'])
})

test('falls back to a default rather than returning an empty list', () => {
  assert.equal(normaliseEmojis([]).length, 1)
  assert.equal(normaliseEmojis(undefined).length, 1)
  assert.equal(normaliseEmojis('not an array').length, 1)
  assert.equal(normaliseEmojis([null, '']).length, 1)
})

test('drops blanks but keeps the survivors', () => {
  assert.deepEqual(normaliseEmojis(['😂', '', null, '🔥']), ['😂', '🔥'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `normaliseEmojis` is not exported from `../src/sticker.ts`

- [ ] **Step 3: Implement**

Append to `server/src/sticker.ts`:

```ts
export const DEFAULT_EMOJI = '😂'

// WhatsApp accepts 1–3 emojis per sticker and rejects a manifest that breaks that.
// Enforced here rather than only in the picker, because the route accepts arbitrary JSON.
export function normaliseEmojis(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const clean = list
    .filter((e): e is string => typeof e === 'string')
    .map(e => e.trim())
    .filter(e => e.length > 0)
    .slice(0, 3)
  return clean.length > 0 ? clean : [DEFAULT_EMOJI]
}
```

Change `stickerView`'s signature so emojis come off the job itself:

```ts
export function stickerView(job: Job, source: FileRecord | undefined): StickerView {
  return {
    jobId: job.id,
    fileId: job.fileId,
    kind: job.kind,
    name: source?.originalName ?? `sticker-${job.id.slice(0, 8)}`,
    sizeBytes: job.sizeBytes,
    editable: isEditable(job, source),
    emojis: normaliseEmojis(job.emojis),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Add the field and drop the auto-sequence**

In `server/src/types.ts`, add to `Job`:

```ts
  /** 1–3 emojis for the WhatsApp manifest. Absent means "not chosen yet". */
  emojis?: string[]
```

In `server/src/index.ts`:

- Delete `emojiSeq` and the `emojisFor` helper added by Plan 2.
- Update both `stickerView(...)` call sites (in `packSummary` and `GET /api/stickers`) to the two-argument form.
- In `assemblePack`, replace the sticker push with the stored value:

```ts
    stickers.push({ image_file: name, emojis: normaliseEmojis(job.emojis) })
```

- Delete the now-unused `PACK_EMOJIS` constant.
- Add `normaliseEmojis` to the `./sticker.js` import.

- [ ] **Step 6: Add the PATCH route**

```ts
// Per-sticker emojis. Written into the manifest at build time, so changing them
// requires a rebuild to reach the phone.
app.patch('/api/sticker/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  job.emojis = normaliseEmojis(req.body?.emojis)
  jobs.set(job.id, job)
  saveJob(job)
  res.json(stickerView(job, files.get(job.fileId)))
})
```

- [ ] **Step 7: Add the client call**

Append to `web/src/api.ts`:

```ts
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
```

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

```bash
git add server/src/types.ts server/src/sticker.ts server/src/index.ts server/test/emoji.test.ts web/src/api.ts
git commit -m "Store per-sticker emojis and write them into the pack manifest"
```

---

### Task 2: All-stickers screen with search

**Files:**
- Create: `web/src/components/StickerLibrary.tsx`
- Modify: `web/src/flow.ts` (add the `stickers` route)
- Modify: `web/test/flow.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `listStickers`, `deleteSticker`, `setStickerEmojis` from `web/src/api.ts`.
- Produces:
  - `Route` widens to `'packs' | 'pack' | 'stickers'`
  - `matchesQuery(s: StickerView, q: string, packNames: string[]): boolean` — exported from `StickerLibrary.tsx` for its test.
  - `<StickerLibrary stickers packsByJob onBack onDelete onSetEmojis />`

- [ ] **Step 1: Write the failing test**

Append to `web/test/flow.test.ts`:

```ts
import { matchesQuery } from '../src/components/StickerLibrary.tsx'

const s = { jobId: 'j1', fileId: 'f1', kind: 'video', name: 'Cute_cat_baby.mp4',
  editable: true, emojis: ['😂'] } as never

test('an empty query matches everything', () => {
  assert.equal(matchesQuery(s, '', []), true)
  assert.equal(matchesQuery(s, '   ', []), true)
})

test('search matches the filename, case-insensitively', () => {
  assert.equal(matchesQuery(s, 'cat', []), true)
  assert.equal(matchesQuery(s, 'CAT', []), true)
  assert.equal(matchesQuery(s, 'dog', []), false)
})

test('search matches an emoji', () => {
  assert.equal(matchesQuery(s, '😂', []), true)
  assert.equal(matchesQuery(s, '🔥', []), false)
})

test('search matches the name of a pack the sticker belongs to', () => {
  assert.equal(matchesQuery(s, 'memes', ['Best Memes']), true)
  assert.equal(matchesQuery(s, 'memes', ['Cats']), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/components/StickerLibrary.tsx'`

- [ ] **Step 3: Write the component**

Create `web/src/components/StickerLibrary.tsx`:

```tsx
import { useState } from 'react'
import { outputPreviewUrl } from '../api.js'
import type { StickerView } from '../types.js'

const PALETTE = ['😂', '🔥', '💀', '🤣', '👀', '🎬', '😭', '🫡', '❤️', '👍', '🤔', '🙃']

// Client-side filter over name, emojis, and the names of packs holding this sticker.
// ponytail: a .filter(), not an index — revisit past a few thousand stickers.
export function matchesQuery(s: StickerView, q: string, packNames: string[]): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (s.name.toLowerCase().includes(needle)) return true
  if (s.emojis.some(e => e.includes(needle))) return true
  return packNames.some(n => n.toLowerCase().includes(needle))
}

export default function StickerLibrary({ stickers, packsByJob, onBack, onDelete, onSetEmojis }: {
  stickers: StickerView[]
  packsByJob: Record<string, string[]>   // jobId → names of packs containing it
  onBack: () => void
  onDelete: (s: StickerView) => void
  onSetEmojis: (jobId: string, emojis: string[]) => void
}) {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const shown = stickers.filter(s => matchesQuery(s, q, packsByJob[s.jobId] ?? []))

  return (
    <main className="content">
      <div className="toolbar">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Packs</button>
        <input className="search" placeholder="search stickers, emojis, packs…"
          value={q} onChange={e => setQ(e.target.value)} />
        <span className="switch-label">{shown.length} of {stickers.length}</span>
      </div>

      {shown.length === 0 && (
        <div className="empty-box"><p>no stickers match “{q}”</p></div>
      )}

      <div className="grid">
        {shown.map(s => {
          const packs = packsByJob[s.jobId] ?? []
          return (
            <div key={s.jobId} className="card">
              <div className="thumb square">
                <video className="thumb-cover" src={outputPreviewUrl(s.jobId)}
                  muted loop autoPlay playsInline preload="metadata" />
                <span className="sticker-emoji">{s.emojis.join('')}</span>
                {!s.editable && <span className="status-chip locked" title="Source deleted at build">🔒</span>}
              </div>
              <div className="card-body">
                <div className="card-name" title={s.name}>{s.name}</div>
                <div className="meta-line">
                  {packs.length === 0 ? 'in no pack' : `in ${packs.join(', ')}`}
                </div>
                {editing === s.jobId ? (
                  <div className="emoji-picker">
                    {PALETTE.map(e => (
                      <button key={e} className="emoji-opt"
                        onClick={() => { onSetEmojis(s.jobId, [e]); setEditing(null) }}>{e}</button>
                    ))}
                  </div>
                ) : (
                  <div className="card-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s.jobId)}>Emoji</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => onDelete(s)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Add the route and the styles**

In `web/src/flow.ts`, widen the route type and add the actions:

```ts
export type Route = 'packs' | 'pack' | 'stickers'
```

```ts
  | { type: 'openStickers' }
```

and the case:

```ts
    case 'openStickers':
      return { ...s, route: 'stickers', activeCode: null, staged: [], installOpen: false }
```

Append to `web/src/styles.css`:

```css
.search {
  flex: 1; max-width: 420px; padding: 8px 12px;
  font-family: var(--font-mono); font-size: 12.5px;
  background: transparent; color: inherit;
  border: 2px solid var(--line, #2a3020); border-radius: 0;
}
.emoji-picker { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.emoji-opt {
  font-size: 18px; line-height: 1; padding: 4px 6px; cursor: pointer;
  background: transparent; border: 1px solid var(--line, #2a3020);
}
.emoji-opt:hover { background: rgba(255, 255, 255, 0.08); }
```

- [ ] **Step 6: Wire into `App.tsx`**

Add an `All stickers` button to the packs-home toolbar dispatching `{ type: 'openStickers' }`, load `listStickers()` when that route mounts, and build `packsByJob` from the packs already in state:

```tsx
const packsByJob = useMemo(() => {
  const map: Record<string, string[]> = {}
  for (const p of state.packs) for (const id of p.jobIds) (map[id] ??= []).push(p.name)
  return map
}, [state.packs])
```

Deleting from this screen calls `deleteSticker`, which removes it from every pack — confirm first:

```tsx
const onDeleteSticker = async (s: StickerView): Promise<void> => {
  const packs = packsByJob[s.jobId] ?? []
  const where = packs.length ? `\n\nIt is used in: ${packs.join(', ')}.` : ''
  if (!confirm(`Delete “${s.name}” everywhere?${where}\n\nThis cannot be undone.`)) return
  await deleteSticker(s.jobId)
  await Promise.all([refreshPacks(), refreshStickers()])
}
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

```bash
git add web/src/components/StickerLibrary.tsx web/src/flow.ts web/src/App.tsx web/src/styles.css web/test/flow.test.ts
git commit -m "All-stickers screen with search and emoji editing"
```

---

### Task 3: Cross-pack reuse

**Files:**
- Modify: `server/src/index.ts` (`assemblePack`, `PUT /api/packs/:code/stickers`)
- Modify: `server/test/model.test.ts`
- Create: `web/src/components/StickerPicker.tsx`
- Modify: `web/src/components/PackCanvas.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `listStickers` from Task 1, `mutateMembership` in `App.tsx`.
- Produces:
  - `dedupeMembership(jobIds: string[]): string[]` in `server/src/sticker.ts` — order-preserving dedupe by jobId.
  - `<StickerPicker stickers exclude onPick onClose />`

- [ ] **Step 1: Write the failing test**

Append to `server/test/model.test.ts`:

```ts
import { dedupeMembership } from '../src/sticker.ts'

test('membership dedupes by jobId and preserves order', () => {
  assert.deepEqual(dedupeMembership(['a', 'b', 'a', 'c']), ['a', 'b', 'c'])
})

test('two stickers from one source may both sit in a pack', () => {
  // Distinct jobs, same fileId — two trims of one video. The old fileId dedupe
  // collapsed these, which broke cross-pack reuse and multi-trim packs.
  assert.deepEqual(dedupeMembership(['trimA', 'trimB']), ['trimA', 'trimB'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `dedupeMembership` is not exported from `../src/sticker.ts`

- [ ] **Step 3: Implement and swap both dedupe sites**

Append to `server/src/sticker.ts`:

```ts
// Membership is deduped by jobId, not fileId. The old fileId dedupe existed to heal
// packs where fine-tuning left a stale job behind; replace-in-place now handles that
// explicitly, and keying on fileId wrongly collapses two legitimate trims of one source.
export const dedupeMembership = (jobIds: string[]): string[] => [...new Set(jobIds)]
```

In `server/src/index.ts`, inside `PUT /api/packs/:code/stickers`, replace the `byFile` block with:

```ts
  const jobIds = dedupeMembership(valid)
```

and inside `assemblePack`, replace the `byFile` block with:

```ts
  const jobList = dedupeMembership(finished.map(j => j.id)).map(id => jobs.get(id)!) 
```

Delete both now-unused `byFile` maps and their comments.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Write the picker**

Create `web/src/components/StickerPicker.tsx`:

```tsx
import { useState } from 'react'
import { outputPreviewUrl } from '../api.js'
import { matchesQuery } from './StickerLibrary.jsx'
import type { StickerView } from '../types.js'

export default function StickerPicker({ stickers, exclude, onPick, onClose }: {
  stickers: StickerView[]
  exclude: string[]          // jobIds already in this pack
  onPick: (jobId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const available = stickers.filter(s => !exclude.includes(s.jobId) && matchesQuery(s, q, []))

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <button className="icon-btn drawer-close" onClick={onClose}>✕</button>
        <h2>Add an existing <em>sticker</em></h2>
        <input className="search" placeholder="search…" value={q} onChange={e => setQ(e.target.value)} />
        {available.length === 0 && <p className="meta-line">nothing else to add</p>}
        <div className="grid">
          {available.map(s => (
            <div key={s.jobId} className="card" onClick={() => onPick(s.jobId)}>
              <div className="thumb square">
                <video className="thumb-cover" src={outputPreviewUrl(s.jobId)}
                  muted loop autoPlay playsInline preload="metadata" />
                <span className="sticker-emoji">{s.emojis.join('')}</span>
              </div>
              <div className="card-body"><div className="card-name" title={s.name}>{s.name}</div></div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
```

- [ ] **Step 6: Add the entry point**

In `PackCanvas.tsx`, add next to `＋ Add media`:

```tsx
<button className="btn btn-ghost" onClick={props.onAddExisting}>⧉ Add existing</button>
```

and widen its props with `onAddExisting: () => void`.

In `App.tsx`, open the picker and append on pick:

```tsx
const onPickExisting = async (jobId: string): Promise<void> => {
  const code = state.activeCode; if (!code) return
  setPickerOpen(false)
  await mutateMembership(code, ids => [...ids, jobId])
  await refreshPacks()
}
```

- [ ] **Step 7: Add the e2e assertion**

Append to the pack block in `scripts/e2e.sh`, before the sticker-delete assertions:

```bash
PACK3=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"Reuse"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
REUSE=$(api -X PUT "$BASE/api/packs/$PACK3/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$JB1\",\"$JB2\"]}")
assert_eq "reuse: a sticker can sit in two packs" \
  "$(echo "$REUSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['ready'])")" "2"
api -X PATCH "$BASE/api/sticker/$JB1" -H 'Content-Type: application/json' \
  -d '{"emojis":["🔥","💀"]}' > /dev/null
assert_eq "emoji: stored on the sticker" \
  "$(api "$BASE/api/stickers" | python3 -c "import sys,json;print(next(s['emojis'] for s in json.load(sys.stdin) if s['jobId']=='$JB1'))")" \
  "['🔥', '💀']"
```

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run build && npm run test:e2e`
Expected: PASS, `FAIL=0`

```bash
git add server/src/sticker.ts server/src/index.ts server/test/model.test.ts web/src/components/StickerPicker.tsx web/src/components/PackCanvas.tsx web/src/App.tsx scripts/e2e.sh
git commit -m "Cross-pack sticker reuse; dedupe membership by jobId not fileId"
```

---

### Task 4: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Document reuse and emojis**

Add to the **Model: Source / Sticker / Pack** section:

```markdown
A sticker may belong to several packs. Membership is deduped by **jobId**, not fileId —
the old fileId dedupe collapsed two legitimate trims of one source, and replace-in-place
now covers the stale-job case it was protecting against.

Per-sticker emojis (1–3, WhatsApp's limit) live in the job record's JSON and are written
into the manifest at build time, so changing them needs a rebuild to reach the phone.
`normaliseEmojis()` in `sticker.ts` enforces the range on the way in.

**All stickers** is a third route listing every sticker you own, with client-side search
over name, emojis, and containing pack names. Deleting there removes the sticker from
every pack; removing from a pack canvas only drops the membership and lets the reference
count decide.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "Docs: sticker reuse, membership dedupe, emojis"
```

---

## Manual verification before calling this done

1. Build a pack, so at least three stickers are locked.
2. Open **All stickers**. Confirm every sticker appears with the pack it belongs to.
3. Search a filename fragment, an emoji, and a pack name. All three should filter.
4. Change a sticker's emoji. Rebuild its pack. Confirm the new emoji is in `data/packs/<code>/manifest.json`.
5. Create a second pack and use **Add existing** to put one of the first pack's stickers in it.
6. Delete the first pack. Confirm the shared sticker still previews in the second pack — this is the reference count working.
7. Delete that sticker from All stickers. Confirm it disappears from the second pack too.
