import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blankEdges, hardCuts, isBlank, planSeams, shotBetween } from '../src/seams.ts'

const frame = (v: number): Uint8Array => new Uint8Array(256).fill(v)
// A textured frame: a gradient offset by `v`, so it is never "blank".
const tex = (v: number): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => (i + v) % 256)

test('blank means uniform, not dark', () => {
  assert.equal(isBlank(frame(0)), true)
  assert.equal(isBlank(frame(250)), true)
  assert.equal(isBlank(tex(0)), false)
})

test('a hard cut is one isolated spike; sustained motion is not', () => {
  // Calm, one spike at 5 (a cut), calm; then a burst 10–13 (a leg sweeping past).
  const vals = [0, 1, 2, 3, 4, 80, 81, 82, 83, 84, 120, 160, 200, 240, 241, 242]
  const prints = vals.map(frame)
  assert.deepEqual(hardCuts(prints), [5])
  assert.equal(shotBetween([5], 10, 0.2, 0.9), true)
  assert.equal(shotBetween([5], 10, 0.6, 0.9), false)
})

test('a piece that runs into black is flagged at the first black frame', () => {
  const prints = [...Array.from({ length: 20 }, (_, i) => tex(i)), frame(0), frame(0), frame(0)]
  const w = blankEdges(prints, 10, [{ start: 0, end: 2.3 }])
  assert.deepEqual(w, [{ piece: 0, kind: 'ends-blank', at: 2 }])
  assert.deepEqual(blankEdges(prints, 10, [{ start: 0, end: 1.5 }]), [])
})

test('planSeams snaps the cut between two pieces to where the footage really continues', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-seams-test-'))
  try {
    const seg = path.join(dir, 'seg.mp4')
    const clip = path.join(dir, 'clip.mp4')
    // 2s of moving testsrc repeated: frame t and frame t+2 are identical.
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=15:duration=2', '-pix_fmt', 'yuv420p', '-g', '1', seg]).status, 0)
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-stream_loop', '2', '-i', seg, '-c', 'copy', clip]).status, 0)
    // Piece A stops at 1.0 (next frame would be 1.0), B resumes at 2.6 (≡ 0.6): a jump.
    // B resuming at 3.0 (≡ 1.0) is a perfect continuation.
    const plan = await planSeams({ inputPath: clip, spans: [{ start: 0, end: 1 }, { start: 2.6, end: 3.6 }], duration: 6, fps: 15, preVf: '' })
    const cut = plan.seams[0]
    assert.equal(cut.kind, 'cut')
    assert.ok(['jump', 'hard', 'noticeable'].includes(cut.label), `the asked cut should look wrong, got ${cut.label}`)
    assert.equal(cut.applied, true)
    assert.ok(['seamless', 'smooth'].includes(cut.best.label), `snapped cut should be smooth, got ${cut.best.label}`)
    // Same content either side: A's end and B's start differ by a whole 2s period.
    const gap = plan.spans[1].start - plan.spans[0].end
    assert.ok(Math.abs(gap - 2) < 0.07, `expected a 2s-period cut, got ${plan.spans[0].end}→${plan.spans[1].start}`)
    assert.equal(plan.seams[1].kind, 'loop')
    assert.equal(plan.warnings.length, 0)
    // One press gets the best: pressing again on the result changes nothing.
    const again = await planSeams({ inputPath: clip, spans: plan.spans, duration: 6, fps: 15, preVf: '' })
    assert.deepEqual(again.spans, plan.spans)
    assert.ok(again.seams.every(sm => !sm.applied))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
