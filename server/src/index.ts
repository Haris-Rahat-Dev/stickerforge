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
  createPack, getPack, listPacks, renamePack, deletePack, setPackStickers, bumpPackVersion } from './db.js'
import type { Pack } from './types.js'
import type { ConvertSettings, CropRect, FileRecord, FitMode, Job } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DATA = path.join(ROOT, 'data')
const UPLOADS = path.join(DATA, 'uploads')
const OUTPUTS = path.join(DATA, 'outputs')
const TRAYS = path.join(DATA, 'trays')
const WEB_DIST = path.join(ROOT, 'web', 'dist')

for (const dir of [DATA, UPLOADS, OUTPUTS, TRAYS]) fs.mkdirSync(dir, { recursive: true })

const app = express()
app.use(express.json())

// Anonymous per-browser identity: a random httpOnly cookie, no login. The value is
// an unguessable UUID, so it scopes each user's files/jobs/packs. (Not signed — the
// local threat model is nil; a hosted deployment should use signed sessions.) The
// phone never sends this cookie: it reads packs by their unguessable code instead.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { userId: string } }
}
app.use((req, res, next) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
  )
  let uid = cookies['sf_uid']
  if (!uid || !/^[0-9a-f-]{36}$/.test(uid)) {
    uid = crypto.randomUUID()
    res.cookie('sf_uid', uid, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 365 * 24 * 3600 * 1000 })
  }
  req.userId = uid
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

// Load persisted files + finished jobs so state survives a server restart.
initDb(DATA)
for (const rec of loadFiles()) if (fs.existsSync(rec.path)) files.set(rec.id, rec)
for (const job of loadJobs()) if (files.has(job.fileId) && fs.existsSync(job.outputPath)) jobs.set(job.id, job)

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
  for (const [jid, j] of jobs) if (j.fileId === req.params.id) jobs.delete(jid)
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
        p => { job.progress = Math.min(0.99, Math.max(job.progress, p)); job.stage = 'encoding' }
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
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'AbortError') {
      job.status = 'cancelled'
    } else {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'Conversion failed'
    }
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

const PACK_EMOJIS = ['😂', '🔥', '💀', '🤣', '👀', '🎬', '😭', '🫡']
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
  const jobList = pack.jobIds
    .map(id => jobs.get(id))
    .filter((j): j is Job => !!j && j.status === 'done' && !!j.outMeta)
  if (jobList.length < 3) throw new Error('Need at least 3 finished stickers in the pack')
  if (jobList.length > 30) throw new Error('WhatsApp packs cap at 30 stickers')

  const packDir = path.join(DATA, 'packs', pack.code)
  fs.rmSync(packDir, { force: true, recursive: true })
  fs.mkdirSync(packDir, { recursive: true })

  const stickers: Array<{ image_file: string; emojis: string[] }> = []
  for (const [i, job] of jobList.entries()) {
    const name = `s${i + 1}.webp`
    const outPath = path.join(packDir, name)
    if (job.kind === 'image') {
      // Already a motionless animated WebP — just place it.
      fs.copyFileSync(job.outputPath, outPath)
      console.log(`pack ${pack.code}: ${name} ← image ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`)
    } else {
      const result = await convertToAnimatedWebp({ inputPath: job.outputPath, outPath, ...job.settings, speed: job.settings.speed })
      console.log(`pack ${pack.code}: ${name} ← ${(result.sizeBytes / 1024).toFixed(0)}KB, ${result.frames} frames`)
    }
    stickers.push({ image_file: name, emojis: [PACK_EMOJIS[i % PACK_EMOJIS.length]] })
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
  const ready = p.jobIds.filter(id => jobs.get(id)?.status === 'done').length
  const built = fs.existsSync(path.join(DATA, 'packs', p.code, 'manifest.json'))
  return { code: p.code, name: p.name, jobIds: p.jobIds, ready, built }
}

// ── pack management (owner-scoped) ───────────────────────────────────────────
app.get('/api/packs', (req, res) => {
  res.json(listPacks(req.userId).map(packSummary))
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

app.delete('/api/packs/:code', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  deletePack(pack.code)
  fs.rmSync(path.join(DATA, 'packs', pack.code), { force: true, recursive: true })
  res.json({ ok: true })
})

// Set the ordered membership (one job per sticker). Only the caller's finished jobs.
app.put('/api/packs/:code/stickers', (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  const jobIds = (Array.isArray(req.body.jobIds) ? req.body.jobIds.map(String) : [])
    .filter((id: string) => { const j = jobs.get(id); return j?.owner === req.userId && j.status === 'done' })
  setPackStickers(pack.code, jobIds)
  res.json(packSummary({ ...pack, jobIds }))
})

app.post('/api/packs/:code/build', async (req, res) => {
  const pack = ownedPack(req, req.params.code)
  if (!pack) { res.status(404).json({ error: 'Pack not found' }); return }
  try {
    res.json({ code: pack.code, ...await assemblePack(pack) })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pack assembly failed' })
  }
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
