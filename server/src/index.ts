import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probeVideo, assessQuality, detectCrop } from './probe.js'
import { convertToSticker, computeBitrateKbps, extractTray } from './convert.js'
import { convertToAnimatedWebp } from './webp.js'
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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.mp4'}`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
})

const files = new Map<string, FileRecord>()
const jobs = new Map<string, Job>()

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

function parseSettings(body: Record<string, unknown>, rec: FileRecord): ConvertSettings {
  const duration = rec.meta.duration
  const fit = ['cover', 'contain', 'stretch'].includes(String(body.fit)) ? body.fit as FitMode : 'cover'
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
    const meta = await probeVideo(req.file.path)
    const id = req.file.filename
    const record: FileRecord = {
      id,
      originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      path: req.file.path,
      sizeBytes: req.file.size,
      meta,
      quality: assessQuality(meta)
    }
    files.set(id, record)
    res.json(record)
  } catch (err) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true })
    res.status(400).json({ error: err instanceof Error ? err.message : 'Probe failed' })
  }
})

app.get('/api/files', (_req, res) => {
  res.json([...files.values()].map(({ path: _path, ...rest }) => rest))
})

app.delete('/api/file/:id', (req, res) => {
  const rec = files.get(req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  fs.rmSync(rec.path, { force: true })
  files.delete(req.params.id)
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

app.get('/api/video/:id', (req, res) => {
  const rec = files.get(req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  streamFile(req, res, rec.path, rec.id.endsWith('.webm') ? 'video/webm' : 'video/mp4')
})

app.get('/api/filmstrip/:id', async (req, res) => {
  const rec = files.get(req.params.id)
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
  const rec = files.get(req.params.id)
  if (!rec) { res.status(404).json({ error: 'Not found' }); return }
  if (!rec.suggestedCrop) {
    rec.suggestedCrop = await detectCrop(rec.path, rec.meta).catch(() => null)
  }
  res.json(rec.suggestedCrop)
})

function startJob(rec: FileRecord, settings: ConvertSettings, signal: AbortSignal | null): Job {
  const jobId = crypto.randomUUID()
  const outputPath = path.join(OUTPUTS, `${jobId}.webm`)
  const job: Job = {
    id: jobId,
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

  convertToSticker(
    { inputPath: rec.path, outputPath, start, end, speed, fps, fit, padColor, crop, cropPos, border },
    signal,
    p => {
      job.progress = Math.min(0.99, Math.max(job.progress, p))
      job.stage = 'encoding'
    }
  ).then(async ({ sizeBytes }) => {
    const trayPath = path.join(TRAYS, `${jobId}.png`)
    await extractTray(rec.path, trayPath, start, crop, cropPos)
    job.trayPath = fs.existsSync(trayPath) ? trayPath : null
    job.status = 'done'
    job.progress = 1
    job.sizeBytes = sizeBytes
    job.outMeta = await probeVideo(outputPath).catch(() => null)
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
  const rec = files.get(String(req.body.fileId || ''))
  if (!rec) { res.status(404).json({ error: 'File not found' }); return }
  const settings = parseSettings(req.body, rec)
  const controller = new AbortController()
  const job = startJob(rec, settings, controller.signal)
  res.json({ jobId: job.id })
})

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  const { outputPath, ...safe } = job
  res.json(safe)
})

app.get('/api/download/webm/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job || !fs.existsSync(job.outputPath)) { res.status(404).json({ error: 'Not found' }); return }
  const name = (files.get(job.fileId)?.originalName || 'sticker').replace(/\.[^.]+$/, '')
  res.download(job.outputPath, `${name}.webm`)
})

app.get('/api/download/tray/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job?.trayPath || !fs.existsSync(job.trayPath)) { res.status(404).json({ error: 'Not found' }); return }
  const name = (files.get(job.fileId)?.originalName || 'tray').replace(/\.[^.]+$/, '')
  res.download(job.trayPath, `${name}.png`)
})

app.get('/api/output/preview/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job || !fs.existsSync(job.outputPath)) { res.status(404).json({ error: 'Not found' }); return }
  streamFile(req, res, job.outputPath, 'video/webm')
})

app.post('/api/batch', async (req, res) => {
  const ids = Array.isArray(req.body.fileIds) ? req.body.fileIds.map(String) : []
  const results: Array<{ jobId: string; fileId: string }> = []

  for (const id of ids) {
    const rec = files.get(id)
    if (!rec) continue
    const end = Math.min(6, rec.meta.duration)
    const fps = Math.min(30, Math.max(10, Math.round(rec.meta.fps)))

    const detected = await detectCrop(rec.path, rec.meta).catch(() => null)
    const crop = detected && (detected.w < rec.meta.width - 8 || detected.h < rec.meta.height - 8)
      ? sanitizeCrop(detected, rec.meta)
      : null

    const job = startJob(rec, {
      start: 0, end, speed: 1, fps, fit: 'cover', padColor: '#000000', crop, cropPos: 0.5, border: false
    }, null)
    job.stage = 'queued'
    results.push({ jobId: job.id, fileId: id })
  }
  res.json(results)
})

const PACK_EMOJIS = ['😂', '🔥', '💀', '🤣', '👀', '🎬', '😭', '🫡']

// WhatsApp third-party provider pack: animated WebP + manifest, assembled
// from the most recent successful conversions. The Android app consumes this.
app.get('/api/pack/:code', async (req, res) => {
  const code = /^[a-z0-9-]{1,32}$/.test(req.params.code) ? req.params.code : null
  if (!code) { res.status(400).json({ error: 'Invalid pack code' }); return }

  const done = [...jobs.values()].filter(j => j.status === 'done' && j.outMeta).slice(-6)
  if (done.length < 3) {
    res.status(400).json({ error: 'Need at least 3 converted stickers — make some first' })
    return
  }

  const packDir = path.join(DATA, 'packs', code)
  fs.rmSync(packDir, { force: true, recursive: true })
  fs.mkdirSync(packDir, { recursive: true })

  try {
    const stickers: Array<{ image_file: string; emojis: string[] }> = []
    for (const [i, job] of done.entries()) {
      const name = `s${i + 1}.webp`
      const result = await convertToAnimatedWebp({
        inputPath: job.outputPath,
        outPath: path.join(packDir, name),
        ...job.settings,
        speed: job.settings.speed
      })
      console.log(`pack: ${name} ← ${(result.sizeBytes / 1024).toFixed(0)}KB, ${result.frames} frames`)
      stickers.push({ image_file: name, emojis: [PACK_EMOJIS[i % PACK_EMOJIS.length]] })
    }

    if (done[0].trayPath && fs.existsSync(done[0].trayPath)) {
      fs.copyFileSync(done[0].trayPath, path.join(packDir, 'tray.png'))
    } else {
      res.status(500).json({ error: 'Tray icon missing for first sticker' })
      return
    }

    const manifest = {
      identifier: `stickerforge-${code}-${Date.now().toString(36)}`,
      name: 'StickerForge Pack',
      publisher: 'StickerForge',
      tray_image_file: 'tray.png',
      image_data_version: '1',
      animated: true,
      stickers
    }
    fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    res.json(manifest)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pack assembly failed' })
  }
})

app.get('/api/pack/:code/file/:name', (req, res) => {
  const code = /^[a-z0-9-]{1,32}$/.test(req.params.code) ? req.params.code : null
  const name = /^[\w.-]{1,64}$/.test(req.params.name) ? req.params.name : null
  if (!code || !name) { res.status(400).json({ error: 'Invalid path' }); return }
  const filePath = path.join(DATA, 'packs', code, name)
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
