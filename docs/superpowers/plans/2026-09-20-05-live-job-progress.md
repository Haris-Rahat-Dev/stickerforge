# Live Job Progress Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plans 1–4 are merged and their manual verification steps passed.

**Goal:** Replace the 600ms `getJob` polling loop with a live push of encode progress, so the staging shelf updates in real time and stops hammering the API.

## ⚠️ Decision required before starting: this plan does not use Firestore

The spec named Firestore for this. Implementing it surfaced a blocker worth stating plainly, because it changes the answer.

**Encode progress is written by the server, not the browser.** For the server to write to Firestore it needs Google credentials — a service account key on the VM, plus either `firebase-admin` (which Plan 1 deliberately avoided) or a hand-rolled service-account JWT exchange. That is a credential to store and rotate, a large dependency or ~60 lines of token plumbing, and a network round-trip on every progress tick, in exchange for a benefit — cross-device sync — that encode progress does not need. Nobody watches an encode from a second device.

**Server-Sent Events give the same result with none of that.** Express already owns job state in memory. `GET /api/job/:id/stream` is about 25 lines, needs no dependency, no credential, no external service, works offline and over Tailscale, and deletes the same poll loop.

This plan implements SSE. **Appendix A** specifies the Firestore version in full if you'd rather have it — say so and swap Tasks 1–3 for it. Firestore stays the right call for *pack and sticker metadata* if you later want multi-device sync of the library itself; that would be its own plan, and nothing here forecloses it.

---

**Architecture:** The server keeps a per-job set of open SSE responses. `convertToSticker`'s existing progress callback writes to the job record as it already does, and additionally fans the update out to any listener. The client opens one `EventSource` per running encode and closes it on the terminal event.

**Tech Stack:** Express 4, browser `EventSource`, `node:test`.

## Global Constraints

- **No new dependencies.** `EventSource` is a browser built-in; SSE over Express is plain `res.write`.
- **`GET /api/job/:id` must keep working unchanged.** The e2e suite polls it, and it is the fallback when `EventSource` is unavailable.
- The stream endpoint is **owner-scoped** and sits behind the auth middleware like every other `/api` route except the two public pack paths. `EventSource` cannot set an `Authorization` header, so the token goes in the query string — see Task 2 for why that is acceptable here and what it costs.
- Do **not** add a Claude co-author or attribution line to commit messages.
- Do not push; the user pushes.

---

### Task 1: Job event bus

**Files:**
- Create: `server/src/jobfeed.ts`
- Create: `server/test/jobfeed.test.ts`

**Interfaces:**
- Produces:
  - `interface JobEvent { jobId: string; status: JobStatus; progress: number; stage: string; sizeBytes?: number; error?: string }`
  - `subscribe(jobId: string, fn: (e: JobEvent) => void): () => void` — returns an unsubscribe.
  - `publish(e: JobEvent): void`
  - `listenerCount(jobId: string): number` — for the test only.
  - Task 2 consumes `subscribe` and `publish`.

- [ ] **Step 1: Write the failing test**

Create `server/test/jobfeed.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe, publish, listenerCount, type JobEvent } from '../src/jobfeed.ts'

const ev = (over: Partial<JobEvent> = {}): JobEvent =>
  ({ jobId: 'j1', status: 'running', progress: 0.5, stage: 'pass 1', ...over })

test('a subscriber receives events for its job', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  publish(ev())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].progress, 0.5)
  off()
})

test('a subscriber never receives another job’s events', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  publish(ev({ jobId: 'j2' }))
  assert.equal(seen.length, 0)
  off()
})

test('unsubscribing stops delivery and releases the slot', () => {
  const seen: JobEvent[] = []
  const off = subscribe('j1', e => seen.push(e))
  assert.equal(listenerCount('j1'), 1)
  off()
  assert.equal(listenerCount('j1'), 0)
  publish(ev())
  assert.equal(seen.length, 0)
})

test('several subscribers on one job all receive it', () => {
  let a = 0, b = 0
  const offA = subscribe('j1', () => a++)
  const offB = subscribe('j1', () => b++)
  publish(ev())
  assert.equal(a, 1)
  assert.equal(b, 1)
  offA(); offB()
})

test('publishing with no listeners is harmless', () => {
  assert.doesNotThrow(() => publish(ev({ jobId: 'nobody' })))
  assert.equal(listenerCount('nobody'), 0)
})

test('a throwing subscriber does not block the others', () => {
  let reached = 0
  const offA = subscribe('j1', () => { throw new Error('boom') })
  const offB = subscribe('j1', () => { reached++ })
  publish(ev())
  assert.equal(reached, 1, 'the second subscriber must still run')
  offA(); offB()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/jobfeed.ts'`

- [ ] **Step 3: Implement**

Create `server/src/jobfeed.ts`:

```ts
import type { JobStatus } from './types.js'

export interface JobEvent {
  jobId: string
  status: JobStatus
  progress: number
  stage: string
  sizeBytes?: number
  error?: string
}

// In-process fan-out, one set of listeners per job. Encodes are already in-process
// (see queue.ts), so there is nothing to coordinate across workers.
// ponytail: a Map of Sets — swap for a real bus only if the server ever forks.
const listeners = new Map<string, Set<(e: JobEvent) => void>>()

export function subscribe(jobId: string, fn: (e: JobEvent) => void): () => void {
  let set = listeners.get(jobId)
  if (!set) { set = new Set(); listeners.set(jobId, set) }
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
    try { fn(e) } catch (err) { console.error('jobfeed listener failed:', err) }
  }
}

export const listenerCount = (jobId: string): number => listeners.get(jobId)?.size ?? 0
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add server/src/jobfeed.ts server/test/jobfeed.test.ts
git commit -m "Add an in-process job event bus"
```

---

### Task 2: SSE endpoint

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/auth.ts`
- Modify: `server/test/auth.test.ts`

**Interfaces:**
- Consumes: `subscribe`, `publish` from Task 1.
- Produces: `GET /api/job/:id/stream` — an SSE stream of `JobEvent` JSON, closing itself on a terminal status.

- [ ] **Step 1: Publish on every progress update**

Find every place `server/src/index.ts` mutates a job's `progress`, `stage`, or `status` — the convert progress callback, and the done/error branches. After each `saveJob(job)` (or equivalent), add:

```ts
    publish({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
```

Add the import:

```ts
import { publish, subscribe, type JobEvent } from './jobfeed.js'
```

- [ ] **Step 2: Accept the token from the query string for this route only**

`EventSource` cannot send headers, so the token has to travel in the URL. In `server/src/auth.ts`, export the helper:

```ts
// EventSource cannot set headers, so the SSE route accepts ?token=. The trade-off:
// URLs reach server logs and browser history, and this is a short-lived Firebase ID
// token, not a password. Restricted to the one route that needs it, deliberately —
// do not widen this to the rest of the API.
export const tokenFromQuery = (pathname: string): boolean => /^\/api\/job\/[\w-]+\/stream$/.test(pathname)
```

In the auth middleware in `server/src/index.ts`, extend the token lookup:

```ts
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7)
    : tokenFromQuery(req.baseUrl + req.path) ? String(req.query.token ?? '')
    : ''
```

Add a test to `server/test/auth.test.ts`:

```ts
import { tokenFromQuery } from '../src/auth.ts'

test('only the SSE route may carry its token in the query string', () => {
  assert.equal(tokenFromQuery('/api/job/abc123/stream'), true)
  assert.equal(tokenFromQuery('/api/job/abc123'), false)
  assert.equal(tokenFromQuery('/api/files'), false)
  assert.equal(tokenFromQuery('/api/upload'), false)
})
```

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Add the stream route**

Place it directly after the existing `GET /api/job/:id` route:

```ts
// Live encode progress. Replaces the client's 600ms poll. The stream closes itself on
// a terminal status, so a finished encode never leaves a socket open.
app.get('/api/job/:id/stream', (req, res) => {
  const job = ownedJob(req, req.params.id)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (e: JobEvent): void => {
    res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (e.status !== 'running') { off(); clearInterval(ping); res.end() }
  }

  // Emit the current state immediately, so a late subscriber is never stuck at 0%
  // and an already-finished job closes the stream at once.
  const off = subscribe(job.id, send)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => { off(); clearInterval(ping) })
  send({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
})
```

- [ ] **Step 4: Assert it in the e2e suite**

Add after the convert block in `scripts/e2e.sh`. `$J1` is already finished by then, so the stream must emit one event and close immediately — which is also the regression test for the "late subscriber" case.

```bash
echo "── job stream ──"
STREAM=$(curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" "$BASE/api/job/$J1/stream" | head -1)
assert_eq "stream: emits current state and closes" \
  "$(echo "$STREAM" | python3 -c "import sys,json;print(json.loads(sys.stdin.read().replace('data: ',''))['status'])")" "done"
assert_eq "stream: unauthenticated is 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/job/$J1/stream")" "401"
```

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run build && npm run test:e2e`
Expected: PASS, `FAIL=0`

```bash
git add server/src/index.ts server/src/auth.ts server/test/auth.test.ts scripts/e2e.sh
git commit -m "Stream encode progress over SSE"
```

---

### Task 3: Delete the poll loop

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Editor.tsx`

**Interfaces:**
- Consumes: the SSE route from Task 2.
- Produces: `watchJob(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent>` in `web/src/api.ts` — resolves on the terminal event, rejects on error, and falls back to polling if `EventSource` fails to connect.

- [ ] **Step 1: Write the watcher**

Append to `web/src/api.ts`:

```ts
import { authHeader } from './auth.js'

export interface JobEvent {
  jobId: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  stage: string
  sizeBytes?: number
  error?: string
}

/**
 * Watch an encode to completion. Uses SSE, falling back to polling if the stream
 * cannot be opened (a proxy that buffers event-streams, for instance).
 */
export async function watchJob(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent> {
  const { Authorization } = await authHeader()
  const token = (Authorization ?? '').replace('Bearer ', '')
  if (!token) throw new Error('Not signed in')

  return new Promise<JobEvent>((resolve, reject) => {
    let settled = false
    const es = new EventSource(`${BASE}/api/job/${jobId}/stream?token=${encodeURIComponent(token)}`)

    es.onmessage = ev => {
      const e = JSON.parse(ev.data) as JobEvent
      on(e)
      if (e.status === 'running') return
      settled = true
      es.close()
      e.status === 'done' ? resolve(e) : reject(new Error(e.error || 'Encode failed'))
    }

    es.onerror = () => {
      if (settled) return
      settled = true
      es.close()
      // ponytail: one fallback path, not a reconnect state machine.
      pollJobUntilDone(jobId, on).then(resolve, reject)
    }
  })
}

async function pollJobUntilDone(jobId: string, on: (e: JobEvent) => void): Promise<JobEvent> {
  for (;;) {
    const j = await getJob(jobId)
    const e: JobEvent = { jobId, status: j.status, progress: j.progress, stage: j.stage, sizeBytes: j.sizeBytes, error: j.error }
    on(e)
    if (e.status === 'done') return e
    if (e.status !== 'running') throw new Error(e.error || 'Encode failed')
    await new Promise(r => setTimeout(r, 600))
  }
}
```

- [ ] **Step 2: Replace `pollJob` in `App.tsx`**

Delete the `pollJob` function and the `sleep` helper at the top of `web/src/App.tsx`. Replace its call sites with:

```tsx
const runEncode = async (fileId: string, jobId: string): Promise<JobEvent> => {
  dispatch({ type: 'encStart', fileId })
  return watchJob(jobId, e => dispatch({ type: 'encProgress', fileId, progress: e.progress }))
}
```

- [ ] **Step 3: Replace the editor's polling interval**

In `web/src/components/Editor.tsx`, the completion check currently runs inside a `setInterval` calling `getJob`. Replace that block with:

```tsx
      void watchJob(jobId, j => setJob(prev => prev ? { ...prev, progress: j.progress, stage: j.stage } : prev))
        .then(j => onAddedToPack?.(jobId, j.sizeBytes, replaceAt))
        .catch(() => { /* the job record already carries the error for display */ })
```

and delete the `clearInterval`/`setInterval` scaffolding around it.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

Then manually: `npm run dev`, upload a large video, open the Network tab. Confirm **one** `stream` request that stays open, and **no** repeating `job/<id>` requests.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/App.tsx web/src/components/Editor.tsx
git commit -m "Client: watch encodes over SSE, delete the 600ms poll loop"
```

---

### Task 4: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Document the stream and the decision**

Add to the architecture section:

```
  jobfeed.ts         in-process job event bus (SSE fan-out)
```

And a short section:

```markdown
## Live encode progress

`GET /api/job/:id/stream` is a Server-Sent Events stream of `{status, progress, stage}`.
It emits current state immediately, closes itself on a terminal status, and pings every
25s to survive idle proxies. The client's `watchJob()` uses it and falls back to polling
if the stream cannot be opened.

**Firestore was considered and rejected for this.** Progress is written by the server, so
Firestore would need a service-account credential on the VM plus `firebase-admin` or a
hand-rolled JWT exchange — real operational cost for cross-device sync that encode
progress does not need. Firestore remains a reasonable future choice for pack and
sticker metadata, which is a different problem.

`EventSource` cannot set headers, so this one route accepts `?token=`. `tokenFromQuery()`
in `auth.ts` restricts that to exactly this path. Do not widen it.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "Docs: SSE job progress and why not Firestore"
```

---

## Manual verification before calling this done

1. Upload a long video and commit it. The shelf card's progress bar should advance smoothly, not in 600ms steps.
2. Open the same pack in a second tab during an encode. Both tabs should track the same progress.
3. Kill the server mid-encode. The client should surface an error rather than spinning forever.
4. Open DevTools → Network, filter to `job`. During an encode there must be exactly one open `stream` request and no repeated polls.

---

## Appendix A: the Firestore variant

If you would rather have Firestore despite the cost, replace Tasks 1–3 with the following. Everything else in this plan — the e2e assertions, the docs task — still applies with the endpoint names changed.

**Server credential.** Create a service account in the Firebase console with the `Cloud Datastore User` role, download its JSON key, and store it on the VM outside the repo (for example `/etc/stickerforge/sa.json`, mode 600). Add `GOOGLE_APPLICATION_CREDENTIALS` to `.env.example`. **This key must never be committed**; add its path pattern to `.gitignore`.

**Server write path.** Either add `firebase-admin` (large, but it handles token exchange, retries, and batching) or hand-roll it: sign a JWT with the service account's private key using `jose`, exchange it at `https://oauth2.googleapis.com/token` for an access token, cache that for its ~1h lifetime, and `PATCH` documents at `https://firestore.googleapis.com/v1/projects/<id>/databases/(default)/documents/jobs/<jobId>`. The hand-rolled path is roughly 60 lines plus its own tests for token expiry and refresh.

**Write throttling matters.** The convert progress callback fires often. Writing every tick to Firestore would burn the Spark plan's 20K writes/day within a handful of encodes. Throttle to one write per second per job, and always write the terminal event.

**Security rules.** Jobs are readable only by their owner:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jobs/{jobId} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
      allow write: if false;   // only the service account writes, which bypasses rules
    }
  }
}
```

**Client.** `onSnapshot(doc(db, 'jobs', jobId), snap => …)` in place of `watchJob`'s `EventSource`, with the same terminal-status resolution.

**What you gain over SSE:** progress visible on a second device, and offline replay of the last known state. **What you pay:** a rotating credential on the VM, a write budget to manage, a dependency, and a hard dependency on Google reachability for a feature that works fine locally.
