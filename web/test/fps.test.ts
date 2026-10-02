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

test('preset refit takes the encoder\'s figure', () => {
  assert.equal(nextFitLength(6, 4.26), 4.2)
})

test('refit never grows, never goes under 0.5s, and gives up when nothing is shorter', () => {
  assert.equal(nextFitLength(1, 0.2), 0.5)
  assert.equal(nextFitLength(3, 3), null)
  assert.ok((nextFitLength(2, 1.95) ?? 0) < 2)
})
