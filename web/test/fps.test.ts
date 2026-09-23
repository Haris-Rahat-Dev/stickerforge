import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fpsChoices, nextFitLength } from '../src/budget.ts'

test('fps choices start at the capped source rate and step down to 15', () => {
  assert.deepEqual(fpsChoices(60), [30, 24, 20, 15])
  assert.deepEqual(fpsChoices(29.97), [30, 24, 20, 15])
  assert.deepEqual(fpsChoices(24), [24, 20, 15])
})

test('fps choices never upsample a slow source', () => {
  assert.deepEqual(fpsChoices(20), [20, 15])
  assert.deepEqual(fpsChoices(12.5), [13])
  assert.deepEqual(fpsChoices(10), [10])
})

test('preset refit bisects towards the pessimistic q50 figure', () => {
  // Cat at 24fps: 6s failed saying ~3.1s; 4.5s is worth trying before settling.
  assert.equal(nextFitLength(6, 3.1, false), 4.5)
})

test('a near miss or the final try takes the safe figure', () => {
  assert.equal(nextFitLength(4.5, 4.3, false), 4.2)
  assert.equal(nextFitLength(6, 3.1, true), 3)
})

test('refit never grows, never goes under 0.5s, and gives up when nothing is shorter', () => {
  assert.equal(nextFitLength(1, 0.2, true), 0.5)
  assert.equal(nextFitLength(3, 3, false), null)
  assert.ok((nextFitLength(2, 1.95, false) ?? 0) < 2)
})
