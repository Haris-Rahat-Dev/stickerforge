import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { probeVideo, probeMedia, assessQuality, detectCrop } from './probe.js'
import { extractTray, buildFilters } from './convert.js'
import { convertToAnimatedWebp, encodeSignal, estimateSticker, imageToAnimatedWebp, WebpBudgetError, type WebpResult } from './webp.js'
import { capFps, maxSrcSpanForSpeed } from './budget.js'
import { keptSeconds, normalizeSpans, type Span } from './spans.js'
import { createLimiter } from './queue.js'
import { reapOrphans } from './reap.js'
import { planSeams, seamFps } from './seams.js'
import { initDb, loadFiles, loadJobs, saveFile, saveJob, removeFile as dbRemoveFile,
  createPack, getPack, listPacks, renamePack, deletePack, setPackStickers, bumpPackVersion,
  countPacksWithJob, removeJobFromAllPacks, removeJob as dbRemoveJob } from './db.js'
import { stickerView, normaliseEmojis, dedupeMembership } from './sticker.js'
import { publish, subscribe, type JobEvent } from './jobfeed.js'
import { createAuthMiddleware } from './auth.js'
import type { Pack, StickerSpec } from './types.js'
import type { ConvertSettings, CropRect, FileRecord, FitMode, Job } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
const UPLOADS = path.join(DATA, 'uploads')
const OUTPUTS = path.join(DATA, 'outputs')
const TRAYS = path.join(DATA, 'trays')
const WEB_CACHE = path.join(DATA, 'webp-cache')
const PACKS = path.join(DATA, 'packs')
const WEB_DIST = path.join(ROOT, 'web', 'dist')

for (const dir of [DATA, UPLOADS, OUTPUTS, TRAYS, WEB_CACHE, PACKS]) fs.mkdirSync(dir, { recursive: true })

const webpCachePath = (jobId: string): string => path.join(WEB_CACHE, `${jobId}.webp`)

// The encode reports what it measured; this is the shape the app stores and shows.
const specOf = (r: WebpResult): StickerSpec => ({
  width: r.width, height: r.height, frames: r.frames, fps: r.fps,
  duration: r.duration, sizeBytes: r.sizeBytes, ssim: r.ssim,
})

// One place that decides what a progress event looks like, so the stream, the SSE
// handshake and the terminal event can never disagree.
const publishJob = (job: Job): void => publish({
  jobId: job.id,
  status: job.status,
  progress: job.progress,
  stage: job.stage,
  sizeBytes: job.webpBytes ?? job.sizeBytes,
  spec: job.spec,
  error: job.error,
  fitSeconds: job.fitSeconds,
})

// A stray rejected promise (e.g. an ffmpeg failure in an async route) is logged and
// the server keeps going: it cannot have left shared state half-written.
process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
// A synchronous throw nobody caught leaves the process in an unknown state. Files, done
// jobs and packs are persisted, so exiting for the supervisor (systemd Restart=, Docker
// --restart) to bring back is safer than serving on.
process.on('uncaughtException', err => {
  console.error('uncaughtException — exiting:', err)
  process.exit(1)
})

const app = express()
app.use(express.json())

// Auth: firebase-admin when FIREBASE_SERVICE_ACCOUNT is set; otherwise anonymous
// sf_uid cookie so dogfood works without Firebase. Phone pack GETs stay public.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { userId: string } }
}

app.use('/api', createAuthMiddleware())

// One line per API call. There is no other way to read what the hosted box did, and
// encodes are long enough that timing them matters.
app.use('/api', (req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - started
    if (req.path.endsWith('/stream') || res.statusCode < 400 && ms < 250) return
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} ${ms}ms`)
  })
  next()
})

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.mp4'}`)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }
})
// ponytail: a flat per-user cap on uncommitted uploads keeps one account from filling the
// VM's disk. Built packs delete their sources, so normal use never meets it; make it
// per-plan if accounts ever pay.
const STAGED_QUOTA_BYTES = 3 * 1024 * 1024 * 1024

const files = new Map<string, FileRecord>()

// Bytes of uploads in flight per user, so parallel uploads can't each pass the quota
// on their own, and an obviously over-quota upload is refused before it is written.
const uploading = new Map<string, number>()
const stagedBytes = (uid: string): number =>
  [...files.values()].filter(f => f.owner === uid).reduce((s, f) => s + f.sizeBytes, 0)

const reserveUpload: express.RequestHandler = (req, res, next) => {
  const declared = Number(req.headers['content-length']) || 0
  const inFlight = uploading.get(req.userId) ?? 0
  if (stagedBytes(req.userId) + inFlight + declared > STAGED_QUOTA_BYTES) {
    // Discard the body, then reply: answering mid-upload resets the socket and the
    // browser shows "is the server running?" instead of this. Nothing touches disk.
    req.resume()
    req.on('end', () => res.status(413).json({ error: 'Too many uploads waiting — build a pack or discard some first' }))
    return
  }
  uploading.set(req.userId, inFlight + declared)
  res.on('close', () => {
    const left = (uploading.get(req.userId) ?? 0) - declared
    if (left > 0) uploading.set(req.userId, left)
    else uploading.delete(req.userId)
  })
  next()
}

const jobs = new Map<string, Job>()
// Live encodes that can be stopped. A two-pass VP9 run holds a queue slot for ~90s,
// so an abandoned tab has to be able to give it back.
const jobAbort = new Map<string, AbortController>()

// Express 4 does not catch a rejected async handler; without this the request simply
// hangs open until the client gives up.
type AsyncHandler = (req: express.Request, res: express.Response) => Promise<unknown>
const ah = (fn: AsyncHandler): express.RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res)).catch(next) }

// Load persisted files + finished jobs so state survives a server restart.
initDb(DATA)
const missingFiles: string[] = []
for (const rec of loadFiles()) {
  if (fs.existsSync(rec.path)) files.set(rec.id, rec)
  else missingFiles.push(rec.path)
}
// A sticker outlives its source. Gate only on its own output existing — gating on
// files.has(job.fileId) would silently drop every sticker in every built pack on the
// first restart after a build deleted its sources.
const missingJobs: string[] = []
for (const job of loadJobs()) {
  if (fs.existsSync(job.outputPath)) jobs.set(job.id, job)
  else missingJobs.push(job.outputPath)
}
// Drafts the user never took into a pack (tab closed mid-review). A day's grace so a
// restart doesn't yank one someone is looking at right now.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000
// A failed or cancelled job is never persisted and its files are already gone, so the map
// entry is just a leak. An hour's grace so the UI can still read a just-failed job.
const FAILED_TTL_MS = 60 * 60 * 1000
function sweepDrafts(when: string): void {
  let stale = 0
  let forgotten = 0
  for (const job of [...jobs.values()]) {
    if (job.draft && job.status !== 'running' && Date.now() - job.startedAt > DRAFT_TTL_MS && countPacksWithJob(job.id) === 0) {
      discardSticker(job.id)
      stale++
    } else if ((job.status === 'error' || job.status === 'cancelled') && Date.now() - job.startedAt > FAILED_TTL_MS) {
      jobs.delete(job.id)
      forgotten++
    }
  }
  if (stale || forgotten) console.log(`${when}: discarded ${stale} unreviewed draft encode(s), forgot ${forgotten} failed job(s)`)
}
sweepDrafts('boot')
// A long-running server would otherwise only reclaim abandoned drafts on its next restart.
setInterval(() => sweepDrafts('sweep'), 60 * 60 * 1000).unref()
// Scratch dirs of encodes a crash or kill interrupted; nothing reads them after a restart.
for (const name of fs.readdirSync(os.tmpdir())) {
  if (/^sf-(webp|loop)-/.test(name)) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true })
}
if (missingFiles.length || missingJobs.length) {
  // A drop here means lost work, so it must never be silent: an unusable stored path
  // and a deliberately-deleted source look the same from here.
  console.warn(`boot: ${files.size} file(s) + ${jobs.size} sticker(s) loaded, ` +
    `${missingFiles.length} upload(s) + ${missingJobs.length} sticker output(s) had no file on disk`)
  for (const p of [...missingFiles, ...missingJobs].slice(0, 10)) console.warn(`  missing: ${p}`)
}

// Media no record can reach — a crashed build's staging dir, a filmstrip whose source
// is gone, an upload deleted out from under its job. Runs before anything can write.
const reaped = reapOrphans({
  dataDir: DATA, uploads: UPLOADS, outputs: OUTPUTS, trays: TRAYS,
  webpCache: WEB_CACHE, packs: PACKS,
  liveFilePaths: [...files.values()].map(f => f.path),
  liveFileIds: files.keys(),
  liveJobPaths: [...jobs.values()].flatMap(j => [
    j.outputPath, j.trayPath, webpCachePath(j.id),
  ].filter((p): p is string => !!p)),
})
if (reaped.removed.length) {
  console.log(`boot: reclaimed ${(reaped.bytes / 1024 / 1024).toFixed(1)}MB of unreachable media (${reaped.removed.length} file(s))`)
}

// Cap concurrent encodes so parallel jobs don't starve each other (or a 1 GB VM's RAM).
const encodeQueue = createLimiter(2)
// The editor's own ffmpeg work — estimates, seams, filmstrips, cropdetect — shares a
// separate small cap, so a few busy tabs can't stack decodes on top of two encodes.
const probeQueue = createLimiter(2)

// Owner-scoped lookups: a user only ever sees their own files/jobs.
const ownedFile = (req: express.Request, id: string): FileRecord | null => {
  const rec = files.get(id)
  return rec && rec.owner === req.userId ? rec : null
}
const ownedJob = (req: express.Request, id: string): Job | null => {
  const job = jobs.get(id)
  return job && job.owner === req.userId ? job : null
}

function sanitizeCrop(crop: Partial<CropRect> | null | undefined, meta: { width: number; height: number }): CropRect | null {
  if (!crop) return null
  const { w, h, x, y } = crop
  if (![w, h, x, y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null
  const cw = Math.min(Math.round(w!), meta.width)
  const ch = Math.min(Math.round(h!), meta.height)
  if (cw < 16 || ch < 16) return null
  return {
    w: cw,
    h: ch,
    x: Math.min(Math.round(x!), meta.width - cw),
    y: Math.min(Math.round(y!), meta.height - ch)
  }
}

function clampPos(pos: unknown): number {
  const n = Number(pos)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

// Still images loop into a tiny clip (a few identical frames) so they become a
// motionless — but technically animated — WebP that WhatsApp accepts in an
// animated pack.
const IMAGE_DUR = 1
const IMAGE_FPS = 4

function parseSettings(body: Record<string, unknown>, rec: FileRecord): ConvertSettings {
  const duration = rec.meta.duration
  const fit = ['cover', 'contain', 'stretch'].includes(String(body.fit)) ? body.fit as FitMode : 'cover'
  if (rec.kind === 'image') {
    return {
      start: 0, end: IMAGE_DUR, spans: [{ start: 0, end: IMAGE_DUR }], speed: 1, fps: IMAGE_FPS, fit,
      padColor: /^#[0-9a-fA-F]{6}$/.test(String(body.padColor)) ? String(body.padColor) : '#000000',
      crop: sanitizeCrop(body.crop as Partial<CropRect> | null, rec.meta),
      cropPos: clampPos(body.cropPos),
      border: !!body.border
    }
  }
  // Up to 8×: the editor offers it, and at 8× six sticker seconds cover 48s of source.
  const speed = Math.min(8, Math.max(0.25, Number(body.speed) || 1))
  const start = Math.max(0, Number(body.start) || 0)
  // Slow motion stretches the timeline, so the legal source span grows with speed
  // and shrinks below 1× — otherwise a 0.5× pass would silently emit a 12s sticker.
  const end = Math.min(
    Number(body.end) || Math.min(duration, maxSrcSpanForSpeed(speed)),
    duration || maxSrcSpanForSpeed(speed),
    start + maxSrcSpanForSpeed(speed),
  )
  const raw: Span[] = Array.isArray(body.spans)
    ? (body.spans as Partial<Span>[]).map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0 }))
    : [{ start, end }]
  const spans = normalizeSpans(raw, duration || maxSrcSpanForSpeed(speed), maxSrcSpanForSpeed(speed))
  const first = spans[0] ?? { start, end }
  return {
    // start/end mirror the first span so anything still reading those two fields
    // (tray extract, single-span -ss/-t) sees one legal trim.
    start: first.start, end: first.end,
    spans: spans.length ? spans : [{ start: first.start, end: first.end }],
    speed,
    fps: capFps(Number(body.fps) || rec.meta.fps),
    fit,
    padColor: /^#[0-9a-fA-F]{6}$/.test(String(body.padColor)) ? String(body.padColor) : '#000000',
    crop: sanitizeCrop(body.crop as Partial<CropRect> | null, rec.meta),
    cropPos: clampPos(body.cropPos),
    border: !!body.border,
    ...(Number(body.minQ) >= 30 ? { minQ: Math.min(70, Math.round(Number(body.minQ))) } : {}),
  }
}

app.post('/api/upload', reserveUpload, upload.single('file'), ah(async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return }
    const staged = stagedBytes(req.userId)
    if (staged + req.file.size > STAGED_QUOTA_BYTES) {
      fs.rmSync(req.file.path, { force: true })
      res.status(413).json({ error: 'Too many uploads waiting — build a pack or discard some first' })
      return
    }
    const { meta, kind } = await probeMedia(req.file.path)
    const id = req.file.filename
    const record: FileRecord = {
      id,
      owner: req.userId,
      kind,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      path: req.file.path,
      sizeBytes: req.file.size,
      meta,
      quality: assessQuality(meta, kind)
    }
    files.set(id, record)
    saveFile(record)
    // Same shape as GET /api/files: the absolute server path is not the client's business.
    const { path: _path, ...safeRecord } = record
    res.json(safeRecord)
  } catch (err) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true })
    res.status(400).json({ error: err instanceof Error ? err.message : 'Probe failed' })
  }
}))

app.get('/api/files', (req, res) => {
  res.json([...files.values()].filter(f => f.owner === req.userId).map(({ path: _path, ...rest }) => rest))
})

app.delete('/api/file/:id', (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  fs.rmSync(rec.path, { force: true })
  files.delete(req.params.id)
  // Stickers made from this source are deliberately kept — see removeFile in db.ts.
  dbRemoveFile(req.params.id)
  res.json({ ok: true })
})

function streamFile(req: express.Request, res: express.Response, filePath: string, mime: string): void {
  const stat = fs.statSync(filePath)
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
  if (range) {
    const [, s, e] = range
    // "bytes=-N" is the last N bytes; an open end serves 4MB at a time.
    const start = s === '' ? Math.max(0, stat.size - Number(e)) : Number(s)
    const end = s === '' ? stat.size - 1 : Math.min(e ? Number(e) : start + 4 * 1024 * 1024, stat.size - 1)
    if (!(start <= end && start < stat.size)) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end()
      return
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(filePath).pipe(res)
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif', '.tiff': 'image/tiff'
}
app.get('/api/video/:id', (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  const ext = path.extname(rec.path).toLowerCase()
  const mime = rec.kind === 'image'
    ? (IMAGE_MIME[ext] || 'application/octet-stream')
    : (rec.id.endsWith('.webm') ? 'video/webm' : 'video/mp4')
  streamFile(req, res, rec.path, mime)
})

// Tall enough for a crisp ~64px thumbnail on a 2× screen.
const FILM_H = 128

// Two tabs opening one pack ask for the same strip, and a killed ffmpeg used to leave a
// partial JPEG that was then served forever. Build once per id, into a temp name.
const filmstripsInFlight = new Map<string, Promise<void>>()

app.get('/api/filmstrip/:id', ah(async (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  const out = path.join(DATA, `${req.params.id}-film.jpg`)
  try {
    if (!fs.existsSync(out)) {
      let build = filmstripsInFlight.get(req.params.id)
      if (!build) {
        build = (async () => {
          // A sprite of four frames a second (8–80), each FILM_H tall at the source's own
          // aspect. The timeline tiles it into proportioned thumbnails; it must never be
          // stretched as one image (that squeezed 30+ frames into slivers).
          const duration = Math.max(rec.meta.duration, 0.5)
          const n = Math.min(80, Math.max(8, Math.ceil(duration * 4)))
          const fpsArg = n / duration
          const tmp = `${out}.tmp.jpg`
          try {
            await probeQueue.run(() => new Promise<void>((resolve, reject) => {
              const p = spawn('ffmpeg', [
                '-i', rec.path,
                '-vf', `fps=${fpsArg.toFixed(4)},scale=-2:${FILM_H},tile=${n}x1`,
                '-q:v', '4',
                '-frames:v', '1',
                '-y', tmp
              ], { timeout: 120_000, killSignal: 'SIGKILL' })
              p.on('close', (c: number | null) => c === 0 ? resolve() : reject(new Error(`filmstrip failed (${c})`)))
              p.on('error', reject)
            }))
            // Only a complete strip is published under the name every reader looks for.
            fs.renameSync(tmp, out)
          } catch (err) {
            fs.rmSync(tmp, { force: true })
            throw err
          }
        })().finally(() => filmstripsInFlight.delete(req.params.id))
        filmstripsInFlight.set(req.params.id, build)
      }
      await build
    }
    res.sendFile(out)
  } catch {
    // a source ffmpeg can't read shouldn't take the server down — just skip the strip
    res.status(422).json({ error: 'Could not build filmstrip' })
  }
}))

app.get('/api/cropdetect/:id', ah(async (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  if (!rec.suggestedCrop) {
    rec.suggestedCrop = await probeQueue.run(() => detectCrop(rec.path, rec.meta)).catch(() => null)
  }
  res.json(rec.suggestedCrop)
}))

function startJob(rec: FileRecord, settings: ConvertSettings, signal: AbortSignal | null, controller?: AbortController, draft = false): Job {
  const jobId = crypto.randomUUID()
  // WhatsApp ships the WebP. Images and videos both stop there — a following
  // two-pass VP9 WebM was a second full encode the pack never reads.
  const outputPath = rec.kind === 'image'
    ? path.join(OUTPUTS, `${jobId}.webp`)
    : webpCachePath(jobId)
  const job: Job = {
    id: jobId,
    owner: rec.owner,
    kind: rec.kind,
    fileId: rec.id,
    status: 'running',
    progress: 0,
    stage: 'analyzing',
    outputPath,
    settings,
    startedAt: Date.now(),
    ...(draft ? { draft: true } : {}),
  }
  jobs.set(jobId, job)
  if (signal) jobAbort.set(jobId, controller ?? new AbortController())

  const { start, end, spans, speed, fps, fit, padColor, crop, cropPos, border, minQ } = settings

  const task = rec.kind === 'image'
    ? async () => {
        const webp = await imageToAnimatedWebp({ inputPath: rec.path, outPath: outputPath, start, end, fps, fit, padColor, crop, cropPos, border })
        job.spec = specOf(webp)
        return webp
      }
    : async () => {
        job.stage = 'webp'
        publishJob(job)
        // WhatsApp WebP from the original, not the VP9 WebM — a second lossy
        // generation was the pixelation. Settings apply once here.
        const webp = await convertToAnimatedWebp({
          inputPath: rec.path, outPath: outputPath,
          start, end, spans, speed, fps, fit, padColor, crop, cropPos, border, minQ,
        }, (p, stage) => {
          job.progress = p
          job.stage = stage
          publishJob(job)
        })
        job.webpBytes = webp.sizeBytes
        job.webpFps = webp.fps
        job.spec = specOf(webp)
        return webp
      }

  job.stage = 'queued'
  // Run under the job's signal so a cancel/discard kills its child processes, and a
  // job cancelled while still queued fails at its first spawn instead of encoding.
  const abortable = signal ? () => encodeSignal.run(signal, task) : task
  encodeQueue.run(abortable).then(async result => {
    // Cancel/discard doesn't reach into ffmpeg, so the encode can still finish after
    // the user has walked away from it. Never resurrect it as a done sticker.
    if (job.status === 'cancelled') {
      fs.rmSync(outputPath, { force: true })
      fs.rmSync(webpCachePath(jobId), { force: true })
      return
    }
    const trayPath = path.join(TRAYS, `${jobId}.png`)
    await extractTray(rec.path, trayPath, settings, rec.kind)
    // A cancel/discard can arrive while the tray is extracted, when the job is still
    // 'running' — discardSticker has already dropped it from the map and disk, so
    // finishing here would resurrect a job whose output no longer exists. Read the map
    // fresh: the earlier check narrowed job.status and cannot see a mid-flight change.
    const current = jobs.get(jobId)
    if (!current || current !== job || current.status === 'cancelled') {
      fs.rmSync(trayPath, { force: true })
      fs.rmSync(outputPath, { force: true })
      fs.rmSync(webpCachePath(jobId), { force: true })
      return
    }
    job.trayPath = fs.existsSync(trayPath) ? trayPath : null
    job.status = 'done'
    job.progress = 1
    job.sizeBytes = result.sizeBytes
    // Measure the artefact that ships. The WebP is what WhatsApp receives, so its
    // read-back properties — not the requested ones — are the spec of record.
    if (rec.kind === 'image') {
      job.webpBytes = job.spec?.sizeBytes ?? result.sizeBytes
      job.webpFps = job.spec?.fps ?? 0
    }
    job.outMeta = job.spec
      ? {
        width: job.spec.width, height: job.spec.height, fps: job.spec.fps,
        duration: job.spec.duration, bitrate: 0, codec: 'webp',
        pixFmt: 'webp', hasAudio: false, sizeBytes: job.spec.sizeBytes,
      }
      : await probeVideo(job.outputPath).catch(() => null)
    jobAbort.delete(jobId)
    saveJob(job)   // only finished jobs are persisted — a running encode can't survive a restart
    publishJob(job)
  }).catch((err: unknown) => {
    jobAbort.delete(jobId)
    // A failed ladder leaves its last over-budget mux at outputPath; nothing references it.
    fs.rmSync(outputPath, { force: true })
    if (err instanceof Error && err.name === 'AbortError') {
      job.status = 'cancelled'
    } else {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'Conversion failed'
      if (err instanceof WebpBudgetError) job.fitSeconds = err.maxSeconds
      // Encode failures otherwise vanish into the client SSE with no server record.
      // Log enough to tell a legitimate byte-budget fail-closed from a real crash.
      const kept = keptSeconds(spans)
      console.error(
        `encode failed: job=${jobId} file=${rec.id} kind=${rec.kind} ` +
        `${rec.meta.width}x${rec.meta.height} src=${rec.meta.duration.toFixed(1)}s ` +
        `spans=${spans.length} kept=${kept.toFixed(2)}s fps=${fps} fit=${fit} ` +
        `border=${border} — ${job.error}`,
      )
      if (err instanceof Error && err.name !== 'WebpBudgetError' && err.stack) console.error(err.stack)
    }
    publishJob(job)
  })

  return job
}

app.post('/api/convert', (req, res) => {
  const rec = ownedFile(req, String(req.body.fileId || ''))
  if (!rec) { res.status(404).json({ error: 'File not found' }); return }
  const settings = parseSettings(req.body, rec)
  const controller = new AbortController()
  // The editor encodes for review first; the sticker only becomes real when it joins a pack.
  const job = startJob(rec, settings, controller.signal, controller, req.body.draft === true)
  res.json({ jobId: job.id })
})

// Live projection for the editor: what the current framing/trim would produce, without
// a full encode. One estimate per user at a time — a fetch abort doesn't stop the ffmpeg
// it started, so a busy reply keeps rapid drags from stacking sample encodes on the VM.
const estimating = new Set<string>()
app.post('/api/estimate', ah(async (req, res) => {
  const rec = ownedFile(req, String(req.body.fileId || ''))
  if (!rec) { res.status(404).json({ error: 'File not found' }); return }
  if (rec.kind === 'image') { res.json({ fits: true, image: true }); return }
  if (estimating.has(req.userId)) { res.json({ busy: true }); return }
  estimating.add(req.userId)
  try {
    const settings = parseSettings(req.body, rec)
    const est = await probeQueue.run(() => estimateSticker(rec.path, settings))
    res.json(est)
  } catch {
    res.json({ unknown: true })   // never block the editor on a projection failure
  } finally {
    estimating.delete(req.userId)
  }
}))

// Smooth seams: score every join — each cut between pieces and the loop back to the
// start — and move its ends to the smoothest join in reach (`only` = one seam). Cuts
// may grow the kept total up to 6s; the loop only trims. Also flags pieces that run
// into black. Cheap: one cached 16×16 pass over the clip plus small windows per seam.
const seamProbing = new Set<string>()
app.post('/api/seams', ah(async (req, res) => {
  const rec = ownedFile(req, String(req.body.fileId || ''))
  if (!rec) { res.status(404).json({ error: 'File not found' }); return }
  if (rec.kind === 'image') { res.status(400).json({ error: 'A still image has no seams' }); return }
  if (seamProbing.has(req.userId)) { res.json({ busy: true }); return }
  seamProbing.add(req.userId)
  try {
    const s = parseSettings(req.body, rec)
    const spans = s.spans.length ? s.spans : [{ start: s.start, end: s.end }]
    const only = Number.isInteger(req.body.only) ? Number(req.body.only) : null
    const cropF = s.crop ? `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y},` : ''
    res.json(await probeQueue.run(() => planSeams({
      inputPath: rec.path, spans, duration: rec.meta.duration, fps: seamFps(s.fps, s.speed), only,
      preVf: cropF + buildFilters(s.fit, s.padColor, s.cropPos, s.border),
      maxKept: maxSrcSpanForSpeed(s.speed),
    })))
  } catch {
    res.json({ unknown: true })   // a failed probe must never block editing
  } finally {
    seamProbing.delete(req.userId)
  }
}))

app.get('/api/job/:id', (req, res) => {
  const job = ownedJob(req, req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  const { outputPath, ...safe } = job
  res.json(safe)
})

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

  const off = subscribe(job.id, send)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => { off(); clearInterval(ping) })
  publishJob(job)
})

// Stop a running encode and hand its queue slot back. A cancelled job keeps no
// artefacts: the partial output is discarded rather than left to be reaped.
app.post('/api/job/:id/cancel', (req, res) => {
  const job = ownedJob(req, req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  if (job.status !== 'running') { res.json({ ok: true, status: job.status }); return }
  jobAbort.get(job.id)?.abort()
  jobAbort.delete(job.id)
  fs.rmSync(job.outputPath, { force: true })
  fs.rmSync(webpCachePath(job.id), { force: true })
  job.status = 'cancelled'
  job.error = 'Cancelled'
  publishJob(job)
  res.json({ ok: true, status: job.status })
})

// Throw away an encode the user reviewed and rejected. Only drafts that no pack holds —
// a real sticker goes through DELETE /api/sticker/:jobId. The source stays: the user
// is still editing it.
app.delete('/api/job/:id', (req, res) => {
  const job = ownedJob(req, req.params.id)
  if (!job) { res.json({ ok: true }); return }
  if (!job.draft || countPacksWithJob(job.id) > 0) {
    res.status(409).json({ error: 'Not a draft — delete the sticker instead' })
    return
  }
  if (job.status === 'running') {
    jobAbort.get(job.id)?.abort()
    jobAbort.delete(job.id)
    job.status = 'cancelled'
    job.error = 'Discarded'
    publishJob(job)
  }
  discardSticker(job.id)
  res.json({ ok: true })
})

app.get('/api/output/preview/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job || !fs.existsSync(job.outputPath)) { res.status(404).json({ error: 'Not found' }); return }
  const mime = job.outputPath.endsWith('.webp') ? 'image/webp' : 'video/webm'
  streamFile(req, res, job.outputPath, mime)
})

app.get('/api/output/webp/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  const file = job.kind === 'image' ? job.outputPath : webpCachePath(job.id)
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'Not found' }); return }
  streamFile(req, res, file, 'image/webp')
})

const CODE_RE = /^[a-z0-9-]{1,32}$/

const ownedPack = (req: express.Request, code: string): Pack | null => {
  const p = getPack(code)
  return p && p.owner === req.userId ? p : null
}

// One sticker per membership job. WebP encode is slow (~90s), so we build once and
// cache to disk; the phone's GET only ever serves the cache (its fetch times out at
// 30s). Reuses the pack's stable identifier and bumps its version so re-adding
// updates the same WhatsApp pack instead of duplicating it.
async function assemblePack(
  pack: Pack,
  onProgress?: (e: { progress: number; stage: string }) => void,
): Promise<{ manifest: Record<string, unknown>; included: string[] }> {
  const finished = pack.jobIds
    .map(id => jobs.get(id))
    .filter((j): j is Job => !!j && j.status === 'done' && !!j.outMeta)
  const jobList = dedupeMembership(finished.map(j => j.id)).map(id => jobs.get(id)!)
  const unusable = pack.jobIds.length - finished.length
  if (jobList.length < 3) {
    throw new Error(unusable > 0
      ? `${unusable} of ${pack.jobIds.length} stickers in this pack have no finished encode — rebuild or replace ${unusable === 1 ? 'it' : 'them'}, or add more stickers`
      : `A WhatsApp pack needs at least 3 stickers — this one has ${jobList.length}`)
  }
  if (jobList.length > 30) throw new Error(`WhatsApp packs cap at 30 stickers — this one has ${jobList.length}`)

  const packDir = path.join(PACKS, pack.code)
  // Build into a sibling and swap only once the manifest exists. Wiping packDir up
  // front meant any failure — a budget error, a missing cache entry — destroyed the
  // last good pack, so the phone's GET started 404ing for a pack that used to work.
  const stage = packDir + '.next'
  fs.rmSync(stage, { force: true, recursive: true })
  fs.mkdirSync(stage, { recursive: true })
  const out = (name: string): string => path.join(stage, name)

  // A done job's WebM is immutable, so its built WebP is deterministic — cache it
  // by jobId (outside packDir, which is rebuilt) so rebuilds only re-encode
  // stickers that are actually new. ponytail: no pruning; orphaned entries are tiny.

  const total = jobList.length
  const stickers: Array<{ image_file: string; emojis: string[] }> = []
  for (const [i, job] of jobList.entries()) {
    onProgress?.({ progress: i / total, stage: `Sticker ${i + 1}/${total}` })
    const name = `s${i + 1}.webp`
    const outPath = out(name)
    if (job.kind === 'image') {
      // Already a motionless animated WebP — just place it.
      fs.copyFileSync(job.outputPath, outPath)
      console.log(`pack ${pack.code}: ${name} ← image ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`)
    } else {
      const cached = webpCachePath(job.id)
      if (fs.existsSync(cached)) {
        fs.copyFileSync(cached, outPath)
        console.log(`pack ${pack.code}: ${name} ← cache ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`)
      } else {
        // Never encode the pack WebP from the WebM: that is a second lossy
        // generation, and it was the pixelation. The cache is only a shortcut, so
        // rebuild it from the original with job.settings applied once — exactly as
        // the Add-time encode did.
        const src = files.get(job.fileId)
        if (!src || !fs.existsSync(src.path)) {
          const label = stickerView(job, src).name
          throw new Error(
            `"${label}" has no cached WebP and its source was deleted after the last build, ` +
            `so it cannot be re-encoded without quality loss. Re-add that sticker, then build again.`
          )
        }
        onProgress?.({ progress: i / total, stage: `Encoding sticker ${i + 1}/${total}` })
        // Through the limiter: a build re-encoding several cache misses would otherwise
        // stack extra img2webp runs on top of the two editor encodes.
        const result = await encodeQueue.run(() => convertToAnimatedWebp({
          inputPath: src.path, outPath, ...job.settings,
        }))
        job.spec = specOf(result)
        job.webpBytes = result.sizeBytes
        job.webpFps = result.fps
        saveJob(job)
        fs.copyFileSync(outPath, cached)
        console.log(`pack ${pack.code}: ${name} ← source ${(result.sizeBytes / 1024).toFixed(0)}KB, ${result.frames}f @ ${result.fps}fps`)
      }
    }
    stickers.push({ image_file: name, emojis: normaliseEmojis(job.emojis) })
  }

  onProgress?.({ progress: 0.95, stage: 'Writing tray & manifest' })
  const tray = jobList.find(j => j.trayPath && fs.existsSync(j.trayPath))
  if (!tray) throw new Error('Tray icon missing — no sticker in the pack has one')
  fs.copyFileSync(tray.trayPath!, out('tray.png'))

  const version = bumpPackVersion(pack.code)
  const manifest = {
    identifier: pack.identifier,
    name: pack.name,
    publisher: 'StickerForge',
    tray_image_file: 'tray.png',
    image_data_version: String(version),
    animated: true,
    stickers
  }
  fs.writeFileSync(out('manifest.json'), JSON.stringify(manifest, null, 2))

  // Rename-aside swap: the live pack is only ever moved, never deleted, until the new
  // one is in place. A crash in between leaves <code>.prev, which boot restores.
  const prev = packDir + '.prev'
  fs.rmSync(prev, { force: true, recursive: true })
  if (fs.existsSync(packDir)) fs.renameSync(packDir, prev)
  fs.renameSync(stage, packDir)
  fs.rmSync(prev, { force: true, recursive: true })
  onProgress?.({ progress: 1, stage: 'Done' })
  // `included` is what actually shipped in the manifest — only those stickers'
  // sources may be retired by the caller.
  return { manifest, included: jobList.map(j => j.id) }
}

// Summarise a pack for the list UI: how many members are finished, whether built.
function packSummary(p: Pack) {
  const manifestFile = path.join(PACKS, p.code, 'manifest.json')
  const built = fs.existsSync(manifestFile)
  const stickers = p.jobIds
    .map(id => jobs.get(id))
    .filter((j): j is Job => !!j && j.status === 'done')
    .map(j => stickerView(j, files.get(j.fileId)))
  return {
    code: p.code, name: p.name, jobIds: p.jobIds,
    ready: stickers.length, built,
    builtAt: built ? fs.statSync(manifestFile).mtimeMs : null,
    stickers,
  }
}

// ── pack management (owner-scoped) ───────────────────────────────────────────
app.get('/api/packs', (req, res) => {
  res.json(listPacks(req.userId).map(packSummary))
})

app.get('/api/stickers', (req, res) => {
  const mine = [...jobs.values()]
    .filter(j => j.owner === req.userId && j.status === 'done' && !j.draft)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(j => stickerView(j, files.get(j.fileId)))
  res.json(mine)
})

app.post('/api/packs', (req, res) => {
  const name = String(req.body.name || 'Untitled Pack').slice(0, 60).trim() || 'Untitled Pack'
  res.json(packSummary(createPack(req.userId, name)))
})

app.patch('/api/packs/:code', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const name = String(req.body.name || '').slice(0, 60).trim()
  if (!name) { res.status(400).json({ error: 'Name required' }); return }
  renamePack(pack.code, name)
  res.json(packSummary({ ...pack, name }))
})

function discardSticker(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  fs.rmSync(job.outputPath, { force: true })
  if (job.trayPath) fs.rmSync(job.trayPath, { force: true })
  fs.rmSync(webpCachePath(jobId), { force: true })
  jobs.delete(jobId)
  dbRemoveJob(jobId)
}

app.delete('/api/packs/:code', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const members = [...pack.jobIds]
  deletePack(pack.code)
  fs.rmSync(path.join(PACKS, pack.code), { force: true, recursive: true })
  for (const jobId of members) if (countPacksWithJob(jobId) === 0) discardSticker(jobId)
  res.json({ ok: true })
})

app.delete('/api/sticker/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  removeJobFromAllPacks(job.id)
  const src = files.get(job.fileId)
  if (src) { fs.rmSync(src.path, { force: true }); files.delete(src.id); dbRemoveFile(src.id) }
  discardSticker(job.id)
  res.json({ ok: true })
})

app.patch('/api/sticker/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  job.emojis = normaliseEmojis(req.body?.emojis)
  jobs.set(job.id, job)
  saveJob(job)
  res.json(stickerView(job, files.get(job.fileId)))
})

// Set the ordered membership (one job per sticker). Only the caller's finished jobs.
app.put('/api/packs/:code/stickers', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const valid = (Array.isArray(req.body.jobIds) ? req.body.jobIds.map(String) : [])
    .filter((id: string) => { const j = jobs.get(id); return j?.owner === req.userId && j.status === 'done' })
  const jobIds = dedupeMembership(valid)
  if (jobIds.length > 30) {
    res.status(400).json({ error: `WhatsApp packs cap at 30 stickers — this one has ${jobIds.length}` })
    return
  }
  const dropped = (Array.isArray(req.body.jobIds) ? req.body.jobIds.length : 0) - jobIds.length
  if (dropped > 0) {
    res.status(400).json({ error: `${dropped} of the requested stickers are not finished encodes you own` })
    return
  }
  setPackStickers(pack.code, jobIds)
  // Joining a pack is what turns a reviewed draft into a library sticker.
  for (const id of jobIds) {
    const j = jobs.get(id)
    if (j?.draft) { delete j.draft; saveJob(j) }
  }
  res.json(packSummary({ ...pack, jobIds }))
})

// assemblePack wipes and rewrites packDir, so two builds of one code at the same time
// corrupt each other. The UI's `building` flag only guards a single tab.
const buildsInFlight = new Map<string, Promise<Record<string, unknown>>>()

app.post('/api/packs/:code/build', ah(async (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }

  if (buildsInFlight.has(pack.code)) {
    res.status(409).json({ error: 'This pack is already building — wait for it to finish' })
    return
  }

  // NDJSON stream so the UI can show per-sticker progress. Final line is
  // { done: true, ...manifest } or { error: "..." }.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.flushHeaders?.()
  const emit = (obj: Record<string, unknown>): void => {
    res.write(JSON.stringify(obj) + '\n')
  }

  let built: { manifest: Record<string, unknown>; included: string[] }
  const run = assemblePack(pack, e => emit(e))
  buildsInFlight.set(pack.code, run)
  try {
    built = await run
  } catch (err) {
    // The live pack is untouched by definition; only the staging dir needs removing.
    fs.rmSync(path.join(PACKS, pack.code) + '.next', { force: true, recursive: true })
    emit({ error: err instanceof Error ? err.message : 'Pack assembly failed' })
    res.end()
    return
  } finally {
    buildsInFlight.delete(pack.code)
  }
  const manifest = built.manifest

  const manifestFile = path.join(PACKS, pack.code, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    // A member that failed to encode is not in the pack and keeps its source, so a
    // partial failure cannot silently destroy work that produced nothing.
    for (const jobId of built.included) {
      const job = jobs.get(jobId)
      const src = job && files.get(job.fileId)
      if (!src) continue
      fs.rmSync(src.path, { force: true })
      files.delete(src.id)
      dbRemoveFile(src.id)
    }
  }
  emit({ done: true, code: pack.code, ...manifest })
  res.end()
}))

// ── public pack read (the phone; code is the capability, no auth) ─────────────
app.get('/api/pack/:code', (req, res) => {
  if (!CODE_RE.test(req.params.code)) { res.status(400).json({ error: 'Invalid pack code' }); return }
  const manifestFile = path.join(PACKS, req.params.code, 'manifest.json')
  if (!fs.existsSync(manifestFile)) { res.status(404).json({ error: 'No pack built for this code' }); return }
  res.json(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
})

app.get('/api/pack/:code/file/:name', (req, res) => {
  const name = /^[\w.-]{1,64}$/.test(req.params.name) ? req.params.name : null
  if (!CODE_RE.test(req.params.code) || !name) { res.status(400).json({ error: 'Invalid path' }); return }
  const filePath = path.join(PACKS, req.params.code, name)
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Not found' }); return }
  res.sendFile(filePath)
})

// Last resort for anything `ah` caught: a JSON error instead of a hung socket. A
// streaming reply (NDJSON build) has already sent headers, so it just gets closed.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  const message = err instanceof Error ? err.message : 'Internal error'
  console.error(`${req.method} ${req.originalUrl} failed:`, message)
  if (res.headersSent) { res.end(); return }
  if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: 'File is over 1GB' }); return }
  res.status(500).json({ error: message })
})

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
}

const PORT = Number(process.env.PORT) || 3210
const HOST = process.env.HOST || '127.0.0.1'
const server = app.listen(PORT, HOST, () => {
  console.log(`StickerForge running → http://localhost:${PORT}`)
})

// A deploy restarts the service mid-encode. Stop accepting, let the encode queue drain
// (only completed jobs are persisted, so a killed one leaves an orphan output file rather
// than a job pointing at a half-written one), then exit. Waiting on the encode queue, not
// on server.close's callback: an open SSE stream would always hold that the full 15s,
// and with no connections at all it returned immediately and killed running encodes.
let closing = false
function shutdown(signal: string): void {
  if (closing) return
  closing = true
  console.log(`${signal}: draining ${encodeQueue.active} encode(s), ${encodeQueue.queued} queued`)
  server.close()
  server.closeIdleConnections()
  const drain = setInterval(() => {
    if (encodeQueue.active === 0 && encodeQueue.queued === 0) {
      clearInterval(drain)
      process.exit(0)
    }
  }, 250)
  setTimeout(() => process.exit(0), 15_000).unref()
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig))
