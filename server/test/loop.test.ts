import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findLoop, frameDiff, scoreLoops, seamVerdict, type LoopBounds } from '../src/loop.ts'

const frame = (v: number): Uint8Array => new Uint8Array(256).fill(v)
const one = (b: Partial<LoopBounds>): LoopBounds => ({ sLo: 0, sHi: 0, eLo: 0, eHi: 0, minLen: 0.5, sameCut: true, ...b })

test('frameDiff is the mean absolute difference of two fingerprints', () => {
  assert.equal(frameDiff(frame(10), frame(10)), 0)
  assert.equal(frameDiff(frame(10), frame(30)), 20)
  assert.equal(frameDiff(frame(0), new Uint8Array(3)), 255, 'mismatched sizes never look alike')
})

test('the seam is judged against how much the footage moves anyway', () => {
  // Cost is distance from the frame that would have come next: 0 is perfect.
  assert.equal(seamVerdict(2, 5), 'seamless')
  assert.equal(seamVerdict(5, 5), 'smooth')        // about one frame off
  assert.equal(seamVerdict(10, 5), 'noticeable')
  assert.equal(seamVerdict(20, 5), 'jump')
  assert.equal(seamVerdict(40, 5), 'hard')
  assert.equal(seamVerdict(4, 0), 'jump', 'a static shot makes any change a jump')
})

test('the best end is where the next frame would have been the opening', () => {
  // A 1s ramp 0,10,…,90 that wraps, at 10fps. Ending at 1.0 means frame 1.0 (value 0)
  // is replaced by the opening (0) — a perfect continuation. Ending at 1.4 replaces 40.
  const at = (t: number): Uint8Array => frame(Math.round(t * 10) % 10 * 10)
  const head = [at(0)]
  const tail = Array.from({ length: 13 }, (_, i) => at(0.5 + i * 0.1))   // 0.5 … 1.7
  const r = scoreLoops(head, 0, tail, 0.5, 10, one({ eLo: 0.6, eHi: 1.6 }), { start: 0, end: 1.4 })!
  assert.equal(r.start, 0)
  assert.equal(r.end, 1)
  assert.equal(r.cost, 0)
  assert.equal(r.verdict, 'seamless')
  assert.equal(r.changed, true)
  assert.equal(r.current, 40)
  assert.equal(r.currentVerdict, 'jump')
})

test('moving the start finds a loop the end alone cannot', () => {
  // The opening frame never recurs, but the frame 0.3s in does, just before 2.3.
  const head = [frame(200), frame(200), frame(200), frame(40), frame(40)]
  const tail = [frame(90), frame(90), frame(90), frame(40), frame(90)]   // 2.0 … 2.4
  const r = scoreLoops(head, 0, tail, 2, 10, one({ sLo: 0, sHi: 0.4, eLo: 2.1, eHi: 2.4 }), { start: 0, end: 2.4 })!
  assert.equal(r.start, 0.3)
  assert.equal(r.end, 2.3)
  assert.equal(r.cost, 0)
  assert.ok((r.current ?? 0) > r.cost)
})

test('an already seamless loop is left alone rather than trimmed', () => {
  // Ending at 1.4 replaces a 1 with the opening 0 — seamless; 1.2 is a hair better (0)
  // but shorter, and the eye cannot tell them apart.
  const head = [frame(0)]
  const tail = [frame(30), frame(20), frame(0), frame(10), frame(1)]   // 1.0 … 1.4
  const r = scoreLoops(head, 0, tail, 1, 10, one({ eLo: 1.1, eHi: 1.4 }), { start: 0, end: 1.4 })!
  assert.equal(r.changed, false)
  assert.equal(r.end, 1.4)
  assert.equal(r.verdict, 'seamless')
})

test('trimming that stays a jump is not worth it', () => {
  const head = [frame(0)]
  const tail = [frame(200), frame(180), frame(220), frame(190), frame(210)]
  const r = scoreLoops(head, 0, tail, 1, 10, one({ eLo: 1.1, eHi: 1.4 }), { start: 0, end: 1.4 })!
  assert.equal(r.changed, false)
  assert.equal(r.end, 1.4)
  assert.equal(r.verdict, 'hard')
})

test('equally seamless loops go to the longest, never below the minimum', () => {
  const head = [frame(0)]
  const tail = [frame(50), frame(1), frame(50), frame(50), frame(1)]    // 1.1 and 1.4 both resume 0
  const r = scoreLoops(head, 0, tail, 1, 10, one({ eLo: 1.1, eHi: 1.4 }), null)!
  assert.equal(r.end, 1.4)
  const short = scoreLoops(head, 0, tail, 0, 10, one({ eLo: 0.1, eHi: 0.4, minLen: 0.3 }), null)!
  assert.ok(short.end - short.start >= 0.3)
})

test('with no frame after the end, a loop is never called seamless on trust', () => {
  // End 1.2 would need the frame at 1.2, which the source doesn't have; 1.1 can be checked.
  const head = [frame(0)]
  const tail = [frame(0), frame(0)]     // 1.0, 1.1 — the clip ends here
  const r = scoreLoops(head, 0, tail, 1, 10, one({ eLo: 1.1, eHi: 1.2 }), { start: 0, end: 1.2 })!
  assert.equal(r.currentVerdict, 'smooth')
  assert.equal(r.end, 1.1)
  assert.equal(r.verdict, 'seamless')
})

test('findLoop finds the real repeat in a clip that loops every 2 seconds', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-loop-test-'))
  try {
    const seg = path.join(dir, 'seg.mp4')
    const clip = path.join(dir, 'clip.mp4')
    // 2s of moving testsrc, repeated: a loop from 0 ending at 4.0s is perfect.
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=15:duration=2', '-pix_fmt', 'yuv420p', '-g', '1', seg]).status, 0)
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-stream_loop', '2', '-i', seg, '-c', 'copy', clip]).status, 0)
    const r = await findLoop({
      inputPath: clip, fps: 15, preVf: '',
      bounds: one({ sLo: 0, sHi: 0.5, eLo: 3.0, eHi: 4.5 }),
      asked: { start: 0, end: 4.5 },
    })
    assert.ok(r, 'probe returned a result')
    assert.ok(Math.abs(r.end - r.start - 4) < 0.07, `expected a 4s loop, got ${r.start}→${r.end}`)
    assert.equal(r.verdict, 'seamless')
    assert.ok(r.current != null && r.current > r.cost, 'the asked loop was worse than the found one')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
