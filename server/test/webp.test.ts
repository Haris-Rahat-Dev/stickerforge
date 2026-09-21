import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertToAnimatedWebp, collapseHolds, unknownImg2webpFlag } from '../src/webp.ts'

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args)
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} ${code}: ${err.slice(-200)}`)))
    p.on('error', reject)
  })
}

test('unknownImg2webpFlag reads apt webp error text', () => {
  assert.equal(unknownImg2webpFlag('img2webp exited 1: Unknown option [-sharp_yuv]'), '-sharp_yuv')
  assert.equal(unknownImg2webpFlag('ok'), null)
})

test('collapseHolds merges consecutive near-identical frames', () => {
  const flat = (v: number) => new Uint8Array(256).fill(v)
  // Real re-encode noise on a frozen scene measured mean ≈0 with a peak of 1–2.
  const noise = (n: number) => {
    const a = flat(120)
    for (let i = 0; i < n; i++) a[i * 7] = 121
    return a
  }
  // Small genuine motion at 16×16 measured as a peak of ~6 on a ticking counter.
  const moved = (v: number) => {
    const a = flat(v)
    for (const i of [40, 41, 56, 57, 72, 73]) a[i] = v + 6
    return a
  }
  const sigs = [noise(3), noise(5), noise(2), moved(120), moved(200), flat(50)]
  const held = collapseHolds(sigs, 33)
  assert.deepEqual(held.map(h => h.durationMs), [99, 33, 33, 33], 'noise collapses, motion does not')
  assert.deepEqual(held.map(h => h.index), [0, 3, 4, 5])
})

test('a still clip collapses to a handful of frames', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-webp-h-'))
  const src = path.join(dir, 'in.mp4')
  const out = path.join(dir, 'out.webp')
  try {
    await run('ffmpeg', [
      '-f', 'lavfi', '-i', 'color=c=red:s=512x512:d=2:r=30',
      '-pix_fmt', 'yuv420p', '-y', src,
    ])
    const r = await convertToAnimatedWebp({
      inputPath: src, outPath: out,
      start: 0, end: 2, speed: 1, fps: 30,
      fit: 'cover', padColor: '#000000', crop: null, cropPos: 0.5, border: false,
    })
    // A motionless trim has no frame rate to speak of; what matters is that the
    // holds collapsed AND the file is still an animation. One held frame used to
    // mux to a static WebP, which WhatsApp refuses inside an animated pack.
    assert.ok(r.frames >= 2, `must stay animated, got ${r.frames} frame(s)`)
    assert.ok(r.frames <= 4, `holds should collapse 60 red frames, got ${r.frames}`)
    assert.ok(r.sizeBytes <= 480 * 1024, `size=${r.sizeBytes}`)
    assert.deepEqual({ w: r.width, h: r.height }, { w: 512, h: 512 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('short 30fps clip stays 30fps and under 500KB', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-webp-e-'))
  const src = path.join(dir, 'in.mp4')
  const out = path.join(dir, 'out.webp')
  try {
    await run('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc=size=512x512:rate=30:duration=1',
      '-pix_fmt', 'yuv420p', '-y', src,
    ])
    const r = await convertToAnimatedWebp({
      inputPath: src, outPath: out,
      start: 0, end: 1, speed: 1, fps: 30,
      fit: 'cover', padColor: '#000000', crop: null, cropPos: 0.5, border: false,
    })
    assert.equal(r.fps, 30)
    assert.ok(r.frames >= 28, `frames=${r.frames}`)
    assert.ok(r.sizeBytes <= 480 * 1024, `size=${r.sizeBytes}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
