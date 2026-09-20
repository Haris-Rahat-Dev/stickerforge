import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertToAnimatedWebp, collapseHolds } from '../src/webp.ts'

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args)
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} ${code}: ${err.slice(-200)}`)))
    p.on('error', reject)
  })
}

test('collapseHolds merges consecutive identical frames', () => {
  const held = collapseHolds(['a', 'a', 'a', 'b', 'b', 'c'], 33)
  assert.deepEqual(held, [
    { index: 0, durationMs: 99 },
    { index: 3, durationMs: 66 },
    { index: 5, durationMs: 33 },
  ])
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
    assert.equal(r.fps, 30)
    assert.ok(r.frames <= 4, `holds should collapse 60 red frames, got ${r.frames}`)
    assert.ok(r.sizeBytes <= 480 * 1024, `size=${r.sizeBytes}`)
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
