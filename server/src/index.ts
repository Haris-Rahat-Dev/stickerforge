import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probeVideo, probeMedia, assessQuality, detectCrop } from './probe.js'
import { convertToSticker, computeBitrateKbps, extractTray } from './convert.js'
import { convertToAnimatedWebp, imageToAnimatedWebp } from './webp.js'
import { createLimiter } from './queue.js'
import { initDb, loadFiles, loadJobs, saveFile, saveJob, removeFile as dbRemoveFile,
  createPack, getPack, listPacks, renamePack, deletePack, setPackStickers, bumpPackVersion,
  countPacksWithJob, removeJobFromAllPacks, removeJob as dbRemoveJob } from './db.js'
import { stickerView, normaliseEmojis, dedupeMembership } from './sticker.js'
import { publish, subscribe, type JobEvent } from './jobfeed.js'
import { createAuthMiddleware } from './auth.js'
import type { Pack } from './types.js'
import type { ConvertSettings, CropRect, FileRecord, FitMode, Job } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
const UPLOADS = path.join(DATA, 'uploads')
const OUTPUTS = path.join(DATA, 'outputs')
const TRAYS = path.join(DATA, 'trays')
const WEB_DIST = path.join(ROOT, 'web', 'dist')

for (const dir of [DATA, UPLOADS, OUTPUTS, TRAYS]) fs.mkdirSync(dir, { recursive: true })

// Safety net: a stray rejected promise (e.g. an ffmpeg failure in an async route)
// must never take the whole server down. Log and keep serving.
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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.mp4'}`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
})

const files = new Map<string, FileRecord>()
const jobs = new Map<string, Job>()

// Load persisted files + finished jobs so state survives a server restart.
initDb(DATA)
for (const rec of loadFiles()) if (fs.existsSync(rec.path)) files.set(rec.id, rec)
// A sticker outlives its source. Gate only on its own output existing — gating on
// files.has(job.fileId) would silently drop every sticker in every built pack on the
// first restart after a build deleted its sources.
for (const job of loadJobs()) if (fs.existsSync(job.outputPath)) jobs.set(job.id, job)

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
  return {
    start: Math.max(0, Number(body.start) || 0),
    end: Math.min(Number(body.end) || Math.min(6, duration), duration || 6),
    speed: Math.min(4, Math.max(0.25, Number(body.speed) || 1)),
    fps: Math.min(30, Math.max(8, Math.round(Number(body.fps) || Math.min(30, rec.meta.fps)))),
    fit,
    padColor: /^#[0-9a-fA-F]{6}$/.test(String(body.padColor)) ? String(body.padColor) : '#000000',
    crop: sanitizeCrop(body.crop as Partial<CropRect> | null, rec.meta),
    cropPos: clampPos(body.cropPos),
    border: !!body.border
  }
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
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
    res.json(record)
  } catch (err) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true })
    res.status(400).json({ error: err instanceof Error ? err.message : 'Probe failed' })
  }
})

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

app.get('/api/filmstrip/:id', async (req, res) => {
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
})

app.get('/api/cropdetect/:id', async (req, res) => {
  const rec = ownedFile(req, req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  if (!rec.suggestedCrop) {
    rec.suggestedCrop = await detectCrop(rec.path, rec.meta).catch(() => null)
  }
  res.json(rec.suggestedCrop)
})

function startJob(rec: FileRecord, settings: ConvertSettings, signal: AbortSignal | null): Job {
  const jobId = crypto.randomUUID()
  // Videos become a WebM (re-encoded to WebP at pack build); images become the
  // motionless animated WebP directly (VP9 can hang on a still).
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

  const { start, end, speed, fps, fit, padColor, crop, cropPos, border } = settings

  const task = rec.kind === 'image'
    ? () => imageToAnimatedWebp({ inputPath: rec.path, outPath: outputPath, start, end, fps, fit, padColor, crop, cropPos, border })
    : () => convertToSticker(
        { inputPath: rec.path, outputPath, start, end, speed, fps, fit, padColor, crop, cropPos, border },
        signal,
        p => {
          job.progress = Math.min(0.99, Math.max(job.progress, p))
          job.stage = 'encoding'
          publish({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
        }
      )

  job.stage = 'queued'
  encodeQueue.run(task).then(async ({ sizeBytes }) => {
    const trayPath = path.join(TRAYS, `${jobId}.png`)
    await extractTray(rec.path, trayPath, start, crop, cropPos)
    job.trayPath = fs.existsSync(trayPath) ? trayPath : null
    job.status = 'done'
    job.progress = 1
    job.sizeBytes = sizeBytes
    // Images don't need probing (they're already the final 512 WebP); videos do.
    job.outMeta = rec.kind === 'image'
      ? { width: 512, height: 512, fps: 2, duration: 0.5, bitrate: 0, codec: 'webp', pixFmt: 'yuva420p', hasAudio: false, sizeBytes }
      : await probeVideo(outputPath).catch(() => null)
    saveJob(job)   // only finished jobs are persisted — a running encode can't survive a restart
    publish({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'AbortError') {
      job.status = 'cancelled'
    } else {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'Conversion failed'
    }
    publish({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
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
  send({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, sizeBytes: job.sizeBytes, error: job.error })
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
  streamFile(req, res, job.outputPath, 'video/webm')
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
      const end = Math.min(6, rec.meta.duration)
      const fps = Math.min(30, Math.max(10, Math.round(rec.meta.fps)))
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
async function assemblePack(pack: Pack): Promise<Record<string, unknown>> {
  const finished = pack.jobIds
    .map(id => jobs.get(id))
    .filter((j): j is Job => !!j && j.status === 'done' && !!j.outMeta)
  const jobList = dedupeMembership(finished.map(j => j.id)).map(id => jobs.get(id)!)
  if (jobList.length < 3) throw new Error('Need at least 3 finished stickers in the pack')
  if (jobList.length > 30) throw new Error('WhatsApp packs cap at 30 stickers')

  const packDir = path.join(DATA, 'packs', pack.code)
  fs.rmSync(packDir, { force: true, recursive: true })
  fs.mkdirSync(packDir, { recursive: true })

  // A done job's WebM is immutable, so its built WebP is deterministic — cache it
  // by jobId (outside packDir, which is wiped each build) so rebuilds only re-encode
  // stickers that are actually new. ponytail: no pruning; orphaned entries are tiny.
  const CACHE = path.join(DATA, 'webp-cache')
  fs.mkdirSync(CACHE, { recursive: true })

  const stickers: Array<{ image_file: string; emojis: string[] }> = []
  for (const [i, job] of jobList.entries()) {
    const name = `s${i + 1}.webp`
    const outPath = path.join(packDir, name)
    if (job.kind === 'image') {
      // Already a motionless animated WebP — just place it.
      fs.copyFileSync(job.outputPath, outPath)
      console.log(`pack ${pack.code}: ${name} ← image ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`)
    } else {
      const cached = path.join(CACHE, `${job.id}.webp`)
      if (fs.existsSync(cached)) {
        fs.copyFileSync(cached, outPath)
        console.log(`pack ${pack.code}: ${name} ← cache ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`)
      } else {
        // The WebM is already the finished 512² frame: crop, scale, trim, speed,
        // border and audio are all baked in. Re-applying job.settings here would
        // double-process them (original-source crop=720x712 on a 512² input =
        // ffmpeg "size too big" crash). Only fps carries over, to step down under
        // WhatsApp's 500KB WebP budget. ponytail: neutralized settings on purpose.
        const result = await convertToAnimatedWebp({
          inputPath: job.outputPath, outPath,
          start: 0, end: job.outMeta!.duration, speed: 1, fps: job.settings.fps,
          fit: 'cover', padColor: '#000000', crop: null, cropPos: 0.5, border: false
        })
        fs.copyFileSync(outPath, cached)
        console.log(`pack ${pack.code}: ${name} ← ${(result.sizeBytes / 1024).toFixed(0)}KB, ${result.frames} frames`)
      }
    }
    stickers.push({ image_file: name, emojis: normaliseEmojis(job.emojis) })
  }

  const tray = jobList.find(j => j.trayPath && fs.existsSync(j.trayPath))
  if (!tray) throw new Error('Tray icon missing — no sticker in the pack has one')
  fs.copyFileSync(tray.trayPath!, path.join(packDir, 'tray.png'))

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
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

// Summarise a pack for the list UI: how many members are finished, whether built.
function packSummary(p: Pack) {
  const manifestFile = path.join(DATA, 'packs', p.code, 'manifest.json')
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
  fs.rmSync(path.join(DATA, 'webp-cache', `${jobId}.webp`), { force: true })
  jobs.delete(jobId)
  dbRemoveJob(jobId)
}

app.delete('/api/packs/:code', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const members = [...pack.jobIds]
  deletePack(pack.code)
  fs.rmSync(path.join(DATA, 'packs', pack.code), { force: true, recursive: true })
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
  setPackStickers(pack.code, jobIds)
  res.json(packSummary({ ...pack, jobIds }))
})

app.post('/api/packs/:code/build', async (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  let manifest: Record<string, unknown>
  try {
    manifest = await assemblePack(pack)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pack assembly failed' })
    return
  }

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

// ── public pack read (the phone; code is the capability, no auth) ─────────────
app.get('/api/pack/:code', (req, res) => {
  if (!CODE_RE.test(req.params.code)) { res.status(400).json({ error: 'Invalid pack code' }); return }
  const manifestFile = path.join(DATA, 'packs', req.params.code, 'manifest.json')
  if (!fs.existsSync(manifestFile)) { res.status(404).json({ error: 'No pack built for this code' }); return }
  res.json(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
})

app.get('/api/pack/:code/file/:name', (req, res) => {
  const name = /^[\w.-]{1,64}$/.test(req.params.name) ? req.params.name : null
  if (!CODE_RE.test(req.params.code) || !name) { res.status(400).json({ error: 'Invalid path' }); return }
  const filePath = path.join(DATA, 'packs', req.params.code, name)
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Not found' }); return }
  res.sendFile(filePath)
})

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
}

const PORT = Number(process.env.PORT) || 3210
const HOST = process.env.HOST || '127.0.0.1'
app.listen(PORT, HOST, () => {
  console.log(`StickerForge running → http://localhost:${PORT}`)
})
