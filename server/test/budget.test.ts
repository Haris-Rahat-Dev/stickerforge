import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capFps, fpsSteps, maxSecondsForMotion, motionBudget } from '../src/budget.ts'

test('fps ladder keeps 30 then 24, never the old 8fps dump', () => {
  assert.deepEqual(fpsSteps(30), [30, 24])
  assert.deepEqual(fpsSteps(60), [30, 24])
  assert.deepEqual(fpsSteps(24), [24])
  assert.ok(!fpsSteps(30).some(f => f < 24))
})

test('slow sources stay at source fps — no upsample, no further drop', () => {
  assert.deepEqual(fpsSteps(17), [17])
  assert.deepEqual(fpsSteps(10), [10])
  assert.equal(capFps(16.67), 17)
})

test('motion budget prefers ~4s at 30fps over dropping fps', () => {
  const b = motionBudget(10, 30)
  assert.equal(b.ok, false)
  assert.equal(b.tight, true)
  assert.equal(b.fps, 30)
  assert.equal(b.maxSeconds, 4.1)
  assert.equal(motionBudget(4, 30).ok, true)
  assert.equal(motionBudget(4, 30).tight, false)
  assert.equal(motionBudget(5, 30).ok, true)
  assert.equal(motionBudget(5, 30).tight, true)
})

test('6s WhatsApp cap still binds slow gifs', () => {
  assert.equal(maxSecondsForMotion(15), 6)
})
