import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTrimDrag, clock, rulerLabel, hitMode, sourceTimeAt, stripFrameCount, stripTiles, timeAt } from '../src/components/Timeline.tsx'

test('strip shows four frames a second, not a fixed dozen', () => {
  assert.equal(stripFrameCount(8.1), 33)
  assert.equal(stripFrameCount(1), 8)
  assert.equal(stripFrameCount(40), 80)
})

test('timeAt maps click x onto [0, duration]', () => {
  assert.equal(timeAt(50, 0, 100, 10), 5)
  assert.equal(timeAt(-10, 0, 100, 10), 0)
  assert.equal(timeAt(200, 0, 100, 10), 10)
})

test('hitMode prefers handles, then the window, then the nearer edge', () => {
  assert.equal(hitMode(5, 40, 120, 20), 'start')
  assert.equal(hitMode(40, 40, 120, 20), 'start')
  assert.equal(hitMode(80, 40, 120, 20), 'move')
  assert.equal(hitMode(120, 40, 120, 20), 'end')
  assert.equal(hitMode(160, 40, 120, 20), 'end')
})

test('applyTrimDrag keeps the other edge and the grabbed offset', () => {
  assert.deepEqual(applyTrimDrag('start', 2, 1, 5, 10, 0), { start: 2, end: 5 })
  assert.deepEqual(applyTrimDrag('end', 8, 1, 5, 10, 0), { start: 1, end: 8 })
  assert.deepEqual(applyTrimDrag('move', 4, 1, 5, 10, 1), { start: 3, end: 7 })
})

test('applyTrimDrag will not invert or leave the clip', () => {
  assert.deepEqual(applyTrimDrag('start', 9, 1, 5, 10, 0), { start: 4.7, end: 5 })
  assert.deepEqual(applyTrimDrag('move', 0, 1, 5, 10, 1), { start: 0, end: 4 })
  assert.deepEqual(applyTrimDrag('move', 20, 1, 5, 10, 1), { start: 6, end: 10 })
})

test('filmstrip tiles keep their shape and sample the sprite by time', () => {
  // 900px track, 16:9 thumbs at 64px tall ≈ 114px → 8 tiles, the last one clipped.
  const tiles = stripTiles(900, 114, 33)
  assert.equal(tiles.length, 8)
  assert.equal(tiles[7].width, 900 - 7 * 114)
  assert.equal(tiles[0].index, 2)
  assert.ok(tiles.every((t, i) => i === 0 || t.index > tiles[i - 1].index), 'later tiles show later frames')
  assert.ok(tiles.every(t => t.index >= 0 && t.index < 33))
  assert.deepEqual(stripTiles(0, 114, 33), [])
})

test('sourceTimeAt walks the kept cuts back to back', () => {
  const spans = [{ start: 1, end: 3 }, { start: 5, end: 6 }]
  assert.equal(sourceTimeAt(spans, 0), 1)
  assert.equal(sourceTimeAt(spans, 1.5), 2.5)
  assert.equal(sourceTimeAt(spans, 2.5), 5.5)
  assert.equal(sourceTimeAt(spans, 9), 6)
})

test('clock shows minutes only for long sources', () => {
  assert.equal(clock(4.467), '4.47s')
  assert.equal(clock(65.015, true), '1:05.02')
})

test('ruler labels carry only the precision the step needs', () => {
  assert.equal(rulerLabel(2, 2), '2s')
  assert.equal(rulerLabel(1.5, 0.5), '1.5s')
  assert.equal(rulerLabel(90, 10, true), '1:30')
})
