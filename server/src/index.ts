import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probeVideo, probeMedia, assessQuality, detectCrop } from './probe.js'
import { convertToSticker, extractTray } from './convert.js'
import { convertToAnimatedWebp, imageToAnimatedWebp, type WebpResult } from './webp.js'
import { capFps, maxSrcSpanForSpeed, motionBudget } from './budget.js'
import { createLimiter } from './queue.js'
import { reapOrphans } from './reap.js'
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
})

// Safety net: a stray rejected promise (e.g. an ffmpeg failure in an async route)
// must never take the whole server down. Log and keep serving. Deliberate tradeoff:
// after an uncaughtException the process may be in an unknown state, and for a
// single-user local tool a degraded server beats a dead one — but in-flight encodes
// are not guaranteed consistent, so a restart is the fix if anything looks wrong.
process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
process.on('uncaughtException', err => console.error('uncaughtException:', err))

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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
})

const files = new Map<string, FileRecord>()
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

// Cap concurrent encodes so N parallel two-pass VP9 jobs don't starve each other.
const encodeQueue = createLimiter(2)

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
      start: 0, end: IMAGE_DUR, speed: 1, fps: IMAGE_FPS, fit,
      padColor: /^#[0-9a-fA-F]{6}$/.test(String(body.padColor)) ? String(body.padColor) : '#000000',
      crop: sanitizeCrop(body.crop as Partial<CropRect> | null, rec.meta),
      cropPos: clampPos(body.cropPos),
      border: !!body.border
    }
  }
  const speed = Math.min(4, Math.max(0.25, Number(body.speed) || 1))
  const start = Math.max(0, Number(body.start) || 0)
  // Slow motion stretches the timeline, so the legal source span grows with speed
  // and shrinks below 1× — otherwise a 0.5× pass would silently emit a 12s sticker.
  const end = Math.min(
    Number(body.end) || Math.min(duration, maxSrcSpanForSpeed(speed)),
    duration || maxSrcSpanForSpeed(speed),
    start + maxSrcSpanForSpeed(speed),
  )
  return {
    start, end, speed,
    fps: capFps(Number(body.fps) || rec.meta.fps),
    fit,
    padColor: /^#[0-9a-fA-F]{6}$/.test(String(body.padColor)) ? String(body.padColor) : '#000000',
    crop: sanitizeCrop(body.crop as Partial<CropRect> | null, rec.meta),
    cropPos: clampPos(body.cropPos),
    border: !!body.border
  }
}

app.post('/api/upload', upload.single('file'), ah(async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return }
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
  const range = req.headers.range
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-')
    const start = parseInt(s, 10)
    const end = e ? parseInt(e, 10) : Math.min(start + 4 * 1024 * 1024, stat.size - 1)
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

app.get('/api/filmstrip/:id', ah(async (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  const out = path.join(DATA, `${req.params.id}-strip.jpg`)
  try {
    if (!fs.existsSync(out)) {
      const n = 12
      const fpsArg = n / Math.max(rec.meta.duration, 0.5)
      await new Promise<void>((resolve, reject) => {
        const p = spawn('ffmpeg', [
          '-i', rec.path,
          '-vf', `fps=${fpsArg.toFixed(4)},scale=96:-1,tile=${n}x1`,
          '-frames:v', '1',
          '-y', out
        ])
        p.on('close', (c: number | null) => c === 0 ? resolve() : reject(new Error(`filmstrip failed (${c})`)))
        p.on('error', reject)
      })
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
    rec.suggestedCrop = await detectCrop(rec.path, rec.meta).catch(() => null)
  }
  res.json(rec.suggestedCrop)
}))

function startJob(rec: FileRecord, settings: ConvertSettings, signal: AbortSignal | null, controller?: AbortController): Job {
  const jobId = crypto.randomUUID()
  // Videos: WebM for Sticker.ly, then img2webp cache for WhatsApp. Images skip VP9
  // (libvpx can hang on a still) and write the motionless animated WebP directly.
  const outputPath = path.join(OUTPUTS, `${jobId}.${rec.kind === 'image' ? 'webp' : 'webm'}`)
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
    startedAt: Date.now()
  }
  jobs.set(jobId, job)
  if (signal) jobAbort.set(jobId, controller ?? new AbortController())

  const { start, end, speed, fps, fit, padColor, crop, cropPos, border } = settings

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
          inputPath: rec.path, outPath: webpCachePath(jobId),
          start, end, speed, fps, fit, padColor, crop, cropPos, border,
        }, (p, stage) => {
          // The WebP pass is the long one and used to report nothing at all.
          job.progress = p * 0.45
          job.stage = stage
          publishJob(job)
        })
        job.webpBytes = webp.sizeBytes
        job.webpFps = webp.fps
        job.spec = specOf(webp)
        job.progress = 0.45
        job.stage = 'encoding'
        publishJob(job)
        const webm = await convertToSticker(
          { inputPath: rec.path, outputPath, start, end, speed, fps, fit, padColor, crop, cropPos, border },
          signal,
          p => {
            job.progress = Math.min(0.99, 0.45 + p * 0.54)
            job.stage = 'encoding'
            publishJob(job)
          }
        )
        return webm
      }

  job.stage = 'queued'
  encodeQueue.run(task).then(async result => {
    const trayPath = path.join(TRAYS, `${jobId}.png`)
    await extractTray(rec.path, trayPath, start, crop, cropPos)
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
    job.outMeta = rec.kind === 'image' && job.spec
      ? {
        width: job.spec.width, height: job.spec.height, fps: job.spec.fps,
        duration: job.spec.duration, bitrate: 0, codec: 'webp',
        pixFmt: 'webp', hasAudio: false, sizeBytes: job.spec.sizeBytes,
      }
      : await probeVideo(outputPath).catch(() => null)
    jobAbort.delete(jobId)
    saveJob(job)   // only finished jobs are persisted — a running encode can't survive a restart
    publishJob(job)
  }).catch((err: unknown) => {
    jobAbort.delete(jobId)
    if (err instanceof Error && err.name === 'AbortError') {
      job.status = 'cancelled'
    } else {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'Conversion failed'
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
  const job = startJob(rec, settings, controller.signal)
  res.json({ jobId: job.id })
})

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

app.get('/api/download/webm/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job || !fs.existsSync(job.outputPath)) { res.status(404).json({ error: 'Not found' }); return }
  const name = (files.get(job.fileId)?.originalName || 'sticker').replace(/\.[^.]+$/, '')
  res.download(job.outputPath, `${name}.webm`)
})

app.get('/api/download/tray/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job?.trayPath || !fs.existsSync(job.trayPath)) { res.status(404).json({ error: 'Not found' }); return }
  const name = (files.get(job.fileId)?.originalName || 'tray').replace(/\.[^.]+$/, '')
  res.download(job.trayPath, `${name}.png`)
})

app.get('/api/output/preview/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job || !fs.existsSync(job.outputPath)) { res.status(404).json({ error: 'Not found' }); return }
  streamFile(req, res, job.outputPath, job.kind === 'image' ? 'image/webp' : 'video/webm')
})

app.get('/api/output/webp/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId)
  if (!job) { res.status(404).json({ error: 'Not found' }); return }
  const file = job.kind === 'image' ? job.outputPath : webpCachePath(job.id)
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'Not found' }); return }
  streamFile(req, res, file, 'image/webp')
})

app.post('/api/batch', async (req, res) => {
  const ids = Array.isArray(req.body.fileIds) ? req.body.fileIds.map(String) : []
  const results: Array<{ jobId: string; fileId: string }> = []

  for (const id of ids) {
    const rec = ownedFile(req, id)
    if (!rec) continue

    let settings: ConvertSettings
    if (rec.kind === 'image') {
      settings = { start: 0, end: IMAGE_DUR, speed: 1, fps: IMAGE_FPS, fit: 'cover', padColor: '#000000', crop: null, cropPos: 0.5, border: false }
    } else {
      const fps = capFps(rec.meta.fps)
      const keep = motionBudget(rec.meta.duration, rec.meta.fps).maxSeconds
      const joke = rec.meta.duration > 4 ? 4 : rec.meta.duration
      const end = Math.min(rec.meta.duration, keep, joke)
      const detected = await detectCrop(rec.path, rec.meta).catch(() => null)
      const crop = detected && (detected.w < rec.meta.width - 8 || detected.h < rec.meta.height - 8)
        ? sanitizeCrop(detected, rec.meta)
        : null
      settings = { start: 0, end, speed: 1, fps, fit: 'cover', padColor: '#000000', crop, cropPos: 0.5, border: false }
    }

    const job = startJob(rec, settings, null)
    job.stage = 'queued'
    results.push({ jobId: job.id, fileId: id })
  }
  res.json(results)
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
        const result = await convertToAnimatedWebp({
          inputPath: src.path, outPath, ...job.settings,
        })
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

  // Everything is on disk and readable — only now replace the live pack.
  fs.rmSync(packDir, { force: true, recursive: true })
  fs.renameSync(stage, packDir)
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
    .filter(j => j.owner === req.userId && j.status === 'done')
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

// A deploy restarts the service mid-encode. Stop accepting, give in-flight encodes a
// window to finish (only completed jobs are persisted, so a killed one leaves an
// orphan output file rather than a job pointing at a half-written one), then exit.
let closing = false
function shutdown(signal: string): void {
  if (closing) return
  closing = true
  console.log(`${signal}: draining ${encodeQueue.active} encode(s), ${encodeQueue.queued} queued`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 15_000).unref()
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig))
