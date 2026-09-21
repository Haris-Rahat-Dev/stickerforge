import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTrimDrag, hitMode, timeAt } from '../src/components/Timeline.tsx'

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
