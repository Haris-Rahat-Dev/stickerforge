# Source / Sticker / Pack Model Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 1 (Firebase auth) is merged and its manual verification step passed.

**Goal:** Split the current two-noun model into three — Source (transient upload), Sticker (durable encode), Pack (ordered collection) — so that building a pack deletes its source videos without destroying the stickers made from them.

**Architecture:** A sticker's lifetime stops being tied to its source's lifetime. `job` records and their WebM/tray outputs survive source deletion; a sticker is "editable" exactly when its source file still exists, which is derived at read time rather than stored. Because a job can belong to several packs, deleting a pack or a sticker consults a reference count over `pack_stickers` before removing any output file.

**Tech Stack:** Node 22.6+, Express 4, built-in `node:sqlite`, `node:test`, bash + curl + python3 for e2e.

## Global Constraints

- **`owner` stays an opaque `string`.** No Firebase-specific types anywhere in the model.
- **Sources are deleted only after a build fully succeeds** — manifest written and verified on disk. A build that throws must delete nothing.
- **`GET /api/pack/:code` and `/api/pack/:code/file/:name` stay unauthenticated.** Do not widen or narrow `publicPath()` in `server/src/auth.ts`.
- **No new SQLite columns for `state` or `builtAt`.** Both are already derivable — `built` from the existence of `data/packs/<code>/manifest.json` (see `packSummary` in `server/src/index.ts`), and `builtAt` from that file's mtime. Adding columns for them is duplicated state.
- Pack minimum 3, maximum 30 stickers. Do not change these.
- Do **not** add a Claude co-author or attribution line to commit messages (user preference in CLAUDE.md).
- Do not push; the user pushes.

## Three findings from the codebase that shape this plan

Read these before starting. Each is a latent data-loss bug that source deletion would trigger.

1. **`dbRemoveFile(id)` in `server/src/db.ts:48` also runs `DELETE FROM jobs WHERE file_id = ?`.** Deleting a source would delete its sticker from the database.
2. **`app.delete('/api/file/:id')` in `server/src/index.ts:163` evicts jobs from the in-memory map by `fileId`.** Same bug, in memory.
3. **The boot filter in `server/src/index.ts` reads `if (files.has(job.fileId) && fs.existsSync(job.outputPath))`.** After a build deletes sources, *every sticker in every built pack would vanish on the next server restart.* This is the most dangerous of the three, because it is silent and delayed.

---

### Task 1: Decouple sticker lifetime from source lifetime

**Files:**
- Modify: `server/src/db.ts:48-51` (`removeFile`)
- Modify: `server/src/index.ts` (boot filter, `app.delete('/api/file/:id')`)
- Create: `server/test/model.test.ts`

**Interfaces:**
- Consumes: nothing from earlier plans beyond the auth middleware.
- Produces:
  - `removeFile(id: string): void` — deletes **only** the file row. Jobs are untouched.
  - `removeJob(id: string): void` — deletes one job row.
  - `orphanJobs(): void` no longer exists and must not be added.
  - Tasks 2 and 3 consume both.

- [ ] **Step 1: Write the failing test**

Create `server/test/model.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, saveFile, saveJob, loadFiles, loadJobs, removeFile, removeJob } from '../src/db.ts'
import type { FileRecord, Job } from '../src/types.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-model-'))
initDb(dir)

const file = (id: string): FileRecord => ({
  id, owner: 'u1', kind: 'video', originalName: `${id}.mp4`, path: `/tmp/${id}.mp4`,
  sizeBytes: 1, meta: { width: 512, height: 512, fps: 30, duration: 2, bitrate: 1,
    codec: 'h264', pixFmt: 'yuv420p', hasAudio: false, sizeBytes: 1 },
  quality: { level: 'good', notes: [] },
})

const job = (id: string, fileId: string): Job => ({
  id, owner: 'u1', kind: 'video', fileId, status: 'done', progress: 1, stage: 'done',
  outputPath: `/tmp/${id}.webm`, settings: { start: 0, end: 2, speed: 1, fps: 30,
    fit: 'cover', padColor: '#000000', crop: null, cropPos: 0.5, border: false },
  startedAt: 0,
})

test('removing a source keeps its sticker', () => {
  saveFile(file('f1'))
  saveJob(job('j1', 'f1'))
  removeFile('f1')
  assert.equal(loadFiles().some(f => f.id === 'f1'), false, 'file row should be gone')
  assert.equal(loadJobs().some(j => j.id === 'j1'), true, 'sticker must survive')
})

test('removing a sticker removes only that sticker', () => {
  saveFile(file('f2'))
  saveJob(job('j2', 'f2'))
  saveJob(job('j3', 'f2'))
  removeJob('j2')
  assert.equal(loadJobs().some(j => j.id === 'j2'), false)
  assert.equal(loadJobs().some(j => j.id === 'j3'), true)
  assert.equal(loadFiles().some(f => f.id === 'f2'), true, 'source is not touched')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `removeJob` is not exported, and `removing a source keeps its sticker` fails its second assertion.

- [ ] **Step 3: Split `removeFile` in `server/src/db.ts`**

Replace the existing `removeFile` (lines 48–51) with:

```ts
// A source and the stickers made from it now have independent lifetimes: building a
// pack deletes the source while the sticker lives on. Deleting the file row must
// therefore NOT cascade into jobs.
export function removeFile(id: string): void {
  db!.prepare('DELETE FROM files WHERE id = ?').run(id)
}

export function removeJob(id: string): void {
  db!.prepare('DELETE FROM jobs WHERE id = ?').run(id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Fix the boot filter in `server/src/index.ts`**

Find:

```ts
for (const job of loadJobs()) if (files.has(job.fileId) && fs.existsSync(job.outputPath)) jobs.set(job.id, job)
```

Replace with:

```ts
// A sticker outlives its source. Gate only on its own output existing — gating on
// files.has(job.fileId) would silently drop every sticker in every built pack on the
// first restart after a build deleted its sources.
for (const job of loadJobs()) if (fs.existsSync(job.outputPath)) jobs.set(job.id, job)
```

- [ ] **Step 6: Fix the file-delete route in `server/src/index.ts`**

In `app.delete('/api/file/:id')`, delete this line:

```ts
  for (const [jid, j] of jobs) if (j.fileId === req.params.id) jobs.delete(jid)
```

Deleting a source from the staging shelf must leave any sticker already made from it alone. Add a comment in its place:

```ts
  // Stickers made from this source are deliberately kept — see removeFile in db.ts.
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: PASS

```bash
git add server/src/db.ts server/src/index.ts server/test/model.test.ts
git commit -m "Decouple sticker lifetime from source lifetime"
```

---

### Task 2: Derived editability

**Files:**
- Modify: `server/src/index.ts` (add `stickerView`, use it in `packSummary` and a new list route)
- Modify: `server/test/model.test.ts`
- Modify: `web/src/types.ts` (add `StickerView`)

**Interfaces:**
- Consumes: `removeFile` / `removeJob` from Task 1.
- Produces:
  - `interface StickerView { jobId: string; fileId: string; kind: MediaKind; name: string; sizeBytes?: number; editable: boolean; emojis: string[] }`
  - `stickerView(job: Job): StickerView` in `server/src/index.ts`
  - `GET /api/stickers` → `StickerView[]` for the caller. Plan 4's All-stickers screen consumes this.
  - `packSummary` gains `stickers: StickerView[]`, keeping `jobIds` for backwards compatibility. Plan 3's UI consumes `stickers`.

- [ ] **Step 1: Write the failing test**

The predicate goes in its own module: importing `index.ts` from a test would boot a
server. Append to `server/test/model.test.ts`:

```ts
import { isEditable } from '../src/sticker.ts'

test('a sticker is editable while its source file exists', () => {
  const src = path.join(dir, 'src.mp4')
  fs.writeFileSync(src, 'x')
  assert.equal(isEditable({ ...job('j9', 'f9'), }, { ...file('f9'), path: src }), true)
})

test('a sticker with no source record is locked', () => {
  assert.equal(isEditable(job('j10', 'f10'), undefined), false)
})

test('a sticker whose source file is gone from disk is locked', () => {
  assert.equal(isEditable(job('j11', 'f11'), { ...file('f11'), path: path.join(dir, 'missing.mp4') }), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/sticker.ts'`

- [ ] **Step 3: Create `server/src/sticker.ts`**

```ts
import fs from 'node:fs'
import type { FileRecord, Job, MediaKind } from './types.js'

export interface StickerView {
  jobId: string
  fileId: string
  kind: MediaKind
  name: string
  sizeBytes?: number
  /** True while the original upload is still on disk. Re-cropping needs it. */
  editable: boolean
  emojis: string[]
}

// Editability is derived, never stored. Building a pack deletes its sources, which is
// what locks its stickers; uploads made afterwards stay editable until the next build.
export function isEditable(_job: Job, source: FileRecord | undefined): boolean {
  return !!source && fs.existsSync(source.path)
}

export function stickerView(job: Job, source: FileRecord | undefined, emojis: string[]): StickerView {
  return {
    jobId: job.id,
    fileId: job.fileId,
    kind: job.kind,
    name: source?.originalName ?? `sticker-${job.id.slice(0, 8)}`,
    sizeBytes: job.sizeBytes,
    editable: isEditable(job, source),
    emojis,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Wire it into the pack summary and add the stickers route**

In `server/src/index.ts`, add the import:

```ts
import { stickerView, type StickerView } from './sticker.js'
```

Replace `packSummary` with:

```ts
// Summarise a pack for the list UI. `built` and `builtAt` are derived from the manifest
// on disk — no columns, no duplicated state.
function packSummary(p: Pack) {
  const manifestFile = path.join(DATA, 'packs', p.code, 'manifest.json')
  const built = fs.existsSync(manifestFile)
  const stickers = p.jobIds
    .map(id => jobs.get(id))
    .filter((j): j is Job => !!j && j.status === 'done')
    .map(j => stickerView(j, files.get(j.fileId), emojisFor(j.id)))
  return {
    code: p.code, name: p.name, jobIds: p.jobIds,
    ready: stickers.length, built,
    builtAt: built ? fs.statSync(manifestFile).mtimeMs : null,
    stickers,
  }
}
```

Add a placeholder emoji source directly above it — Plan 4 replaces its body with stored emojis, and the signature does not change:

```ts
// ponytail: auto-assigned for now; Plan 4 stores per-sticker emojis and swaps the body.
const PACK_EMOJIS = ['😂', '🔥', '💀', '🤣', '👀', '🎬', '😭', '🫡']
const emojiSeq = new Map<string, string>()
function emojisFor(jobId: string): string[] {
  let e = emojiSeq.get(jobId)
  if (!e) { e = PACK_EMOJIS[emojiSeq.size % PACK_EMOJIS.length]; emojiSeq.set(jobId, e) }
  return [e]
}
```

Delete the old standalone `const PACK_EMOJIS = [...]` line so it is not declared twice.

Add the list route next to `app.get('/api/packs')`:

```ts
app.get('/api/stickers', (req, res) => {
  const mine = [...jobs.values()]
    .filter(j => j.owner === req.userId && j.status === 'done')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(j => stickerView(j, files.get(j.fileId), emojisFor(j.id)))
  res.json(mine)
})
```

- [ ] **Step 6: Mirror the type on the client**

Append to `web/src/types.ts`:

```ts
export interface StickerView {
  jobId: string
  fileId: string
  kind: MediaKind
  name: string
  sizeBytes?: number
  editable: boolean
  emojis: string[]
}
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: PASS

```bash
git add server/src/sticker.ts server/src/index.ts server/test/model.test.ts web/src/types.ts
git commit -m "Derive sticker editability from source presence; add GET /api/stickers"
```

---

### Task 3: Delete sources after a successful build

**Files:**
- Modify: `server/src/index.ts` (`app.post('/api/packs/:code/build')`)
- Modify: `scripts/e2e.sh`

**Interfaces:**
- Consumes: `removeFile` from Task 1, `packSummary` from Task 2.
- Produces: the build route's response is unchanged (`{ code, ...manifest }`). Its side effect is new.

- [ ] **Step 1: Replace the build route**

In `server/src/index.ts`:

```ts
app.post('/api/packs/:code/build', async (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  let manifest: Record<string, unknown>
  try {
    manifest = await assemblePack(pack)
  } catch (err) {
    // Nothing is deleted on failure: the pack stays a draft and stays editable.
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pack assembly failed' })
    return
  }

  // Only now, with the manifest verified on disk, are the sources expendable. The
  // WebMs, tray PNGs and webp-cache entries all survive — rebuilds and re-downloads
  // never touch the original upload again. Re-cropping does, which is exactly what
  // the resulting `editable: false` forbids.
  const manifestFile = path.join(DATA, 'packs', pack.code, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    for (const jobId of pack.jobIds) {
      const job = jobs.get(jobId)
      const src = job && files.get(job.fileId)
      if (!src) continue
      fs.rmSync(src.path, { force: true })
      files.delete(src.id)
      dbRemoveFile(src.id)
    }
  }
  res.json({ code: pack.code, ...manifest })
})
```

- [ ] **Step 2: Add a pack section to the e2e suite**

`scripts/e2e.sh` currently has no pack coverage at all. Insert this block immediately before the `── delete + 404s ──` section, and note it depends on `$JB1`, `$JB2` from the batch block plus `$J1` from the convert block — three finished jobs, which is the pack minimum.

```bash
echo "── pack build + source deletion ──"
PACK=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"E2E Pack"}')
PACK_CODE=$(echo "$PACK" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
[ -n "$PACK_CODE" ] && ok "pack: created ($PACK_CODE)" || fail "pack: created"

PUT=$(api -X PUT "$BASE/api/packs/$PACK_CODE/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$J1\",\"$JB1\",\"$JB2\"]}")
READY=$(echo "$PUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['ready'])")
assert_eq "pack: 3 ready" "$READY" "3"

EDITABLE_BEFORE=$(api "$BASE/api/stickers" \
  | python3 -c "import sys,json;print(sum(1 for s in json.load(sys.stdin) if s['editable']))")
assert_lt "pack: stickers editable before build" 0 "$EDITABLE_BEFORE"

BUILT=$(api -X POST "$BASE/api/packs/$PACK_CODE/build")
assert_eq "pack: built" \
  "$(echo "$BUILT" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['stickers']))")" "3"

assert_eq "pack: sources deleted after build" \
  "$(api "$BASE/api/video/$FID_B" -o /dev/null -w '%{http_code}')" "404"
assert_eq "pack: stickers locked after build" \
  "$(api "$BASE/api/stickers" | python3 -c "import sys,json;print(any(s['editable'] for s in json.load(sys.stdin)))")" "False"
assert_eq "pack: webm still downloadable after source deletion" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/download/webm/$J1")" "200"

REBUILT=$(api -X POST "$BASE/api/packs/$PACK_CODE/build")
assert_eq "pack: rebuild succeeds with sources gone" \
  "$(echo "$REBUILT" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['stickers']))")" "3"

assert_eq "pack: public GET serves the built pack" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pack/$PACK_CODE")" "200"
```

Note the existing `── delete + 404s ──` block deletes `$FID_A`. Leave it; it now exercises the decoupled path.

- [ ] **Step 3: Run the suite**

Run: `npm run build && npm run test:e2e`
Expected: previous assertions pass, plus 9 new pack assertions. `FAIL=0`.

The assertion that matters most is `pack: rebuild succeeds with sources gone`. If it fails, `assemblePack` is still reaching for a source somewhere and Task 1's boot filter fix is incomplete.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts scripts/e2e.sh
git commit -m "Delete source videos after a pack builds successfully"
```

---

### Task 4: Reference counting

**Files:**
- Modify: `server/src/db.ts` (add `countPacksWithJob`, `removeJobFromAllPacks`)
- Modify: `server/src/index.ts` (pack delete route; new sticker delete route)
- Modify: `server/test/model.test.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: `removeJob` from Task 1.
- Produces:
  - `countPacksWithJob(jobId: string): number`
  - `removeJobFromAllPacks(jobId: string): void`
  - `DELETE /api/sticker/:jobId` → `{ ok: true }`
  - `deleteSticker(jobId: string): Promise<void>` in `web/src/api.ts`. Plan 4 consumes it.

- [ ] **Step 1: Write the failing test**

Append to `server/test/model.test.ts`:

```ts
import { createPack, setPackStickers, countPacksWithJob, removeJobFromAllPacks } from '../src/db.ts'

test('a sticker in two packs has a reference count of two', () => {
  const a = createPack('u1', 'A')
  const b = createPack('u1', 'B')
  setPackStickers(a.code, ['shared', 'onlyA'])
  setPackStickers(b.code, ['shared'])
  assert.equal(countPacksWithJob('shared'), 2)
  assert.equal(countPacksWithJob('onlyA'), 1)
  assert.equal(countPacksWithJob('nowhere'), 0)
})

test('removing a sticker everywhere drops it from every pack', () => {
  const a = createPack('u1', 'A2')
  const b = createPack('u1', 'B2')
  setPackStickers(a.code, ['x', 'y'])
  setPackStickers(b.code, ['x'])
  removeJobFromAllPacks('x')
  assert.equal(countPacksWithJob('x'), 0)
  assert.equal(countPacksWithJob('y'), 1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `countPacksWithJob` is not exported from `../src/db.ts`

- [ ] **Step 3: Implement in `server/src/db.ts`**

Append:

```ts
// Cross-pack reuse means a sticker's output files belong to no single pack. Nothing
// may delete them until no pack references the job any more.
export function countPacksWithJob(jobId: string): number {
  const row = db!.prepare('SELECT COUNT(DISTINCT code) AS n FROM pack_stickers WHERE job_id = ?')
    .get(jobId) as { n: number }
  return row.n
}

export function removeJobFromAllPacks(jobId: string): void {
  db!.prepare('DELETE FROM pack_stickers WHERE job_id = ?').run(jobId)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Make pack deletion refcount-aware**

In `server/src/index.ts`, extend the import from `./db.js` with `countPacksWithJob`, `removeJobFromAllPacks`, and `removeJob as dbRemoveJob`. Then replace the pack delete route:

```ts
app.delete('/api/packs/:code', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const members = [...pack.jobIds]
  deletePack(pack.code)
  fs.rmSync(path.join(DATA, 'packs', pack.code), { force: true, recursive: true })
  // Only outputs no other pack still references may go. A sticker shared with another
  // pack outlives this one.
  for (const jobId of members) if (countPacksWithJob(jobId) === 0) discardSticker(jobId)
  res.json({ ok: true })
})
```

Add the shared helper above the pack routes:

```ts
// Remove a sticker's durable artefacts. Callers must have already confirmed no pack
// references it (countPacksWithJob === 0) — this function does not check.
function discardSticker(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  fs.rmSync(job.outputPath, { force: true })
  if (job.trayPath) fs.rmSync(job.trayPath, { force: true })
  fs.rmSync(path.join(DATA, 'webp-cache', `${jobId}.webp`), { force: true })
  jobs.delete(jobId)
  dbRemoveJob(jobId)
}
```

- [ ] **Step 6: Add the delete-everywhere route**

Next to the other sticker routes:

```ts
// Delete a sticker from every pack and remove its artefacts. This is the only path
// that ignores the reference count, because the user asked for exactly that.
app.delete('/api/sticker/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  removeJobFromAllPacks(job.id)
  const src = files.get(job.fileId)
  if (src) { fs.rmSync(src.path, { force: true }); files.delete(src.id); dbRemoveFile(src.id) }
  discardSticker(job.id)
  res.json({ ok: true })
})
```

- [ ] **Step 7: Add the client call**

Append to `web/src/api.ts`:

```ts
export async function deleteSticker(jobId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/sticker/${jobId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Could not delete sticker')
}
```

- [ ] **Step 8: Add the e2e assertion**

Append to the pack block in `scripts/e2e.sh`:

```bash
PACK2=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"Shared"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
api -X PUT "$BASE/api/packs/$PACK2/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$J1\"]}" > /dev/null
api -X DELETE "$BASE/api/packs/$PACK2" > /dev/null
assert_eq "refcount: shared sticker survives deleting one of its packs" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/download/webm/$J1")" "200"
api -X DELETE "$BASE/api/sticker/$J1" > /dev/null
assert_eq "sticker delete: artefacts gone" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/download/webm/$J1")" "404"
```

- [ ] **Step 9: Verify and commit**

Run: `npm test && npm run build && npm run test:e2e`
Expected: PASS, `FAIL=0`

```bash
git add server/src/db.ts server/src/index.ts server/test/model.test.ts web/src/api.ts scripts/e2e.sh
git commit -m "Reference-count sticker outputs across packs; add DELETE /api/sticker/:jobId"
```

---

### Task 5: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Document the model and the three lifetime rules**

Add after the **Accounts** section added by Plan 1:

```markdown
## Model: Source / Sticker / Pack

- **Source** — the uploaded video or image. Transient. Deleted when a pack containing
  its sticker is built successfully.
- **Sticker** — the encoded artefact (`job` + WebM + tray PNG + webp-cache entry).
  Durable, reusable in any number of packs.
- **Pack** — an ordered `pack_stickers` membership, buildable and shippable.

Three rules the code depends on:

1. **A sticker outlives its source.** `removeFile()` in `db.ts` deletes only the file
   row, and the boot filter in `index.ts` gates jobs on `fs.existsSync(job.outputPath)`
   alone. Gating on `files.has(job.fileId)` would drop every sticker in every built
   pack on the next restart.
2. **Editability is derived, never stored.** `isEditable()` in `sticker.ts` is true iff
   the source file is still on disk. Building a pack is what locks its stickers.
3. **Outputs are reference-counted.** `countPacksWithJob()` must return 0 before any
   sticker artefact is deleted. `DELETE /api/sticker/:jobId` is the deliberate
   exception — it removes the sticker from every pack first.

Sources are deleted **only after** `manifest.json` exists on disk. A failed build
deletes nothing and leaves the pack a draft.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "Docs: Source/Sticker/Pack model and its three lifetime rules"
```

---

## Manual verification before calling this done

1. `npm run dev`, sign in, upload three videos, add all three to a pack.
2. Confirm all three show as editable (Fine-tune available).
3. Build the pack. Confirm `data/uploads/` no longer holds those three sources.
4. Confirm the pack still previews and downloads.
5. **Restart the server.** Confirm the pack still has three stickers. This is the check for finding #3 — it fails only after a restart, so it is easy to miss.
6. Upload a fourth video, add it, confirm it is editable while the other three are locked.
