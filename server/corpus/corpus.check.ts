import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { convertToAnimatedWebp, imageToAnimatedWebp } from '../src/webp.ts'
import { probeMedia, assessQuality } from '../src/probe.ts'
import type { CropRect } from '../src/types.ts'

const run = promisify(execFile)
const HARD_CAP = 500 * 1024
const SSIM_FLOOR = 0.90

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-corpus-'))

/** Every case is generated from lavfi so the suite is reproducible without fixtures. */
interface Fixture {
  name: string
  build: () => Promise<string>
  /** Trim applied to the source. */
  start: number
  end: number
  fps: number
  crop?: CropRect | null
  border?: boolean
  /** Anything the measured spec must additionally satisfy. */
  expect?: { minFrames?: number; maxFrames?: number }
}

const lavfi = async (name: string, filter: string, extra: string[] = []): Promise<string> => {
  const out = path.join(dir, `${name}.mp4`)
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', filter, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', ...extra, out])
  return out
}

const fixtures: Fixture[] = [
  {
    name: 'frozen-still',
    build: () => lavfi('frozen-still', 'color=c=0x3a5f4a:s=512x512:d=2:r=30'),
    start: 0, end: 2, fps: 30,
    expect: { maxFrames: 4 },
  },
  {
    name: 'busy-motion',
    build: () => lavfi('busy-motion', 'testsrc2=size=512x512:rate=30:duration=2'),
    start: 0, end: 1.5, fps: 30,
    expect: { minFrames: 20 },
  },
  {
    name: 'ticking-counter',
    build: () => lavfi('ticking-counter', 'testsrc=size=512x512:rate=30:duration=2'),
    start: 0, end: 1, fps: 30,
    // A small moving detail must not be mistaken for a hold.
    expect: { minFrames: 20 },
  },
  {
    name: 'portrait-phone',
    build: async () => lavfi('portrait-phone', 'testsrc2=size=480x854:rate=30:duration=2'),
    start: 0, end: 1.2, fps: 30,
    crop: { w: 480, h: 480, x: 0, y: 187 },
  },
  {
    name: 'edge-text-with-border',
    build: () => lavfi('edge-text', 'smptebars=size=512x512:rate=30:duration=1.5'),
    start: 0, end: 1, fps: 30, border: true,
  },
  {
    name: 'tiny-source',
    build: () => lavfi('tiny-source', 'testsrc2=size=160x120:rate=24:duration=1.5'),
    start: 0, end: 1, fps: 24,
  },
  {
    // WhatsApp's 6s ceiling, exercised cheaply: a held scene over the full span is
    // what makes a long cut fit at all. An all-motion 6s clip is the case the budget
    // exists to reject, and budget.test.ts covers that arithmetic.
    name: 'full-six-seconds',
    build: () => lavfi('full-six', 'color=c=0x203040:s=512x512:d=6:r=30'),
    start: 0, end: 6, fps: 30,
    expect: { maxFrames: 4 },
  },
]

const square = (w: number, h: number): CropRect => {
  const s = Math.min(w, h)
  return { w: s, h: s, x: Math.round((w - s) / 2), y: Math.round((h - s) / 2) }
}

for (const f of fixtures) {
  test(`corpus: ${f.name}`, async () => {
    const src = await f.build()
    const out = path.join(dir, `${f.name}.webp`)
    const r = await convertToAnimatedWebp({
      inputPath: src, outPath: out,
      start: f.start, end: f.end, speed: 1, fps: f.fps,
      fit: 'cover', padColor: '#000000', crop: f.crop ?? null, cropPos: 0.5,
      border: f.border ?? false,
    })

    assert.equal(r.width, 512, 'canvas width must be 512')
    assert.equal(r.height, 512, 'canvas height must be 512')
    assert.ok(r.frames >= 2, `${r.frames} frames is a static image, which WhatsApp rejects`)
    assert.ok(r.fps <= 30, `${r.fps}fps exceeds WhatsApp's cap`)
    assert.ok(r.duration <= 6.05, `${r.duration}s exceeds WhatsApp's cap`)
    assert.ok(r.sizeBytes <= HARD_CAP, `${Math.round(r.sizeBytes / 1024)}KB exceeds WhatsApp's cap`)
    assert.ok(r.ssim !== null && r.ssim >= SSIM_FLOOR, `luma SSIM ${r.ssim} is below the ${SSIM_FLOOR} floor`)
    // Frame durations are whole milliseconds, so 180 frames at 30fps mux to 5.94s —
    // allow one frame period rather than pretending the arithmetic is exact.
    const requested = f.end - f.start
    const slop = 1 / f.fps + 0.05
    assert.ok(Math.abs(r.duration - requested) <= slop,
      `output ran ${r.duration}s for a ${requested}s trim at ${f.fps}fps`)
    if (f.expect?.minFrames) assert.ok(r.frames >= f.expect.minFrames, `expected ≥${f.expect.minFrames} frames, got ${r.frames}`)
    if (f.expect?.maxFrames) assert.ok(r.frames <= f.expect.maxFrames, `expected ≤${f.expect.maxFrames} frames, got ${r.frames}`)
  })
}

test('corpus: a still image becomes a motionless animated WebP', async () => {
  const png = path.join(dir, 'still.png')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=640x480', '-frames:v', '1', png])
  const out = path.join(dir, 'still.webp')
  const r = await imageToAnimatedWebp({
    inputPath: png, outPath: out, start: 0, end: 1, fps: 4,
    fit: 'cover', padColor: '#000000', crop: square(640, 480), cropPos: 0.5, border: false,
  })
  assert.deepEqual([r.width, r.height], [512, 512])
  assert.ok(r.frames >= 2, 'a static WebP cannot ship in an animated pack')
  assert.ok(r.sizeBytes <= HARD_CAP)
  assert.ok(r.ssim !== null && r.ssim >= 0.95, `still should survive nearly losslessly, got ${r.ssim}`)
})

test('corpus: a file that is not media is refused at probe time', async () => {
  const junk = path.join(dir, 'junk.mp4')
  fs.writeFileSync(junk, 'this is not a video')
  await assert.rejects(() => probeMedia(junk))
})

test('corpus: quality assessment flags a soft source and stays quiet on a sharp one', async () => {
  const sharp = await probeMedia(await lavfi('assess-sharp', 'testsrc2=size=1080x1920:rate=30:duration=1'))
  assert.equal(sharp.meta.width, 1080)
  assert.equal(assessQuality(sharp.meta, sharp.kind).level, 'good')

  const soft = await probeMedia(await lavfi('assess-soft', 'testsrc2=size=240x180:rate=30:duration=1'))
  const verdict = assessQuality(soft.meta, soft.kind)
  assert.equal(verdict.level, 'warn', 'a 240px source should warn before it is encoded')
  assert.ok(verdict.notes.some(n => n.type === 'warn'))
})

process.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }) })
