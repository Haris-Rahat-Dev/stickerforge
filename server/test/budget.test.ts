import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capFps, fpsSteps, maxSecondsForMotion, motionBudget, projectedNeverFits, WEBP_TARGET } from '../src/budget.ts'

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

const KB = 1024

test('projection bails on a clip that could never fit', () => {
  // The real failure: 5s of detailed night footage that ended at 747KB on q50.
  // Two muxes at the top of the ladder project 543KB — already over the cap.
  const samples = [{ q: 90, bytes: 2_600 * KB }, { q: 80, bytes: 1_900 * KB }]
  assert.equal(projectedNeverFits(samples, 1, 50, WEBP_TARGET), true)
})

test('projection leaves a recoverable clip alone', () => {
  // 620KB at q90 is over target but projects to 326KB by q50 — keep going.
  const samples = [{ q: 90, bytes: 620 * KB }, { q: 80, bytes: 545 * KB }]
  assert.equal(projectedNeverFits(samples, 1, 50, WEBP_TARGET), false)
})

test('held frames are credited, so a mostly-still long clip survives', () => {
  // Expensive per frame, but 120 of 180 frames collapse into a handful of holds.
  const samples = [{ q: 90, bytes: 4_000 * KB }, { q: 80, bytes: 2_900 * KB }]
  assert.equal(projectedNeverFits(samples, 1, 50, WEBP_TARGET), true, 'every frame muxed: hopeless')
  assert.equal(projectedNeverFits(samples, 1 / 3, 50, WEBP_TARGET), false, 'two thirds held: reachable')
})

test('projection needs two points before it will say anything', () => {
  const one = [{ q: 90, bytes: 9_000 * KB }]
  assert.equal(projectedNeverFits(one, 1, 50, WEBP_TARGET), false)
  assert.equal(projectedNeverFits([], 1, 50, WEBP_TARGET), false)
})

test('a flat curve falls back to the clamped exponent, not a divide-by-zero', () => {
  // Identical sizes give no usable slope; the clamp keeps the reading conservative.
  const flat = [{ q: 90, bytes: 5_000 * KB }, { q: 80, bytes: 5_000 * KB }]
  assert.equal(projectedNeverFits(flat, 1, 50, WEBP_TARGET), true)
})
