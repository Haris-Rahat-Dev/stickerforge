import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capFps, fpsSteps, lowestQuality, MAX_STICKER_SEC, planLadder, qualityCurve, qualityLadder, secondsThatFit, WEBP_HARD_CAP, WEBP_TARGET } from '../src/budget.ts'

const KB = 1024

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

test('limits match WhatsApp\'s StickerPackValidator', () => {
  assert.equal(MAX_STICKER_SEC, 10)
  assert.equal(WEBP_HARD_CAP, 500 * 1024)
  assert.ok(WEBP_TARGET < WEBP_HARD_CAP && WEBP_TARGET > 490 * 1024)
})

test('quality stays ≥70 while a lower fps remains; only the last fps reaches the floor', () => {
  assert.deepEqual(qualityLadder(false, 30), [90, 80, 70])
  assert.deepEqual(qualityLadder(true, 30), [90, 80, 70, 60, 50, 40, 30])
  assert.deepEqual(qualityLadder(true, lowestQuality(50)), [90, 80, 70, 60, 50])
  assert.deepEqual(qualityLadder(true, lowestQuality(90)), [90, 80, 70])
  assert.equal(lowestQuality(undefined), 30)
})

test('a projected miss shortens the span instead of keeping the optimistic trim', () => {
  assert.equal(secondsThatFit(5.1, 1007 * KB), 2.5)
  assert.equal(secondsThatFit(5.1, 400 * KB), 5.1)
})

test('the quality curve passes through both measurements and extrapolates along them', () => {
  // The real failure: detailed night footage at 2600KB on q90 and 1900KB on q80.
  const at = qualityCurve({ q: 90, bytes: 2_600 * KB }, { q: 80, bytes: 1_900 * KB })
  assert.equal(Math.round(at(90) / KB), 2600)
  assert.equal(Math.round(at(80) / KB), 1900)
  assert.ok(at(50) > WEBP_TARGET, 'still over the cap at q50: the clip can never fit')
})

test('a flat or nonsensical pair falls back to a clamped exponent, not a divide-by-zero', () => {
  const flat = qualityCurve({ q: 90, bytes: 5_000 * KB }, { q: 80, bytes: 5_000 * KB })
  assert.ok(Number.isFinite(flat(30)) && flat(30) < 5_000 * KB)
  const same = qualityCurve({ q: 70, bytes: 100 }, { q: 70, bytes: 100 })
  assert.ok(Number.isFinite(same(30)))
})

// A size model where bytes scale with fps and fall with quality like a real clip.
const model = (perFrameAt70: number, seconds: number) =>
  (fps: number, q: number): number => perFrameAt70 * Math.pow(q / 70, 1.5) * fps * seconds

test('the ladder lands at the top fps when q70 or better fits there', () => {
  const land = planLadder([30, 24], 30, model(2_500, 5))
  assert.equal(land.fits, true)
  assert.equal(land.fps, 30)
  assert.ok(land.q >= 70)
})

test('the ladder gives up a frame rate before it gives up quality below 70', () => {
  // 30fps misses at q70; 24fps fits at q70 — never 30fps at q60.
  const land = planLadder([30, 24], 30, model(3_700, 5))
  assert.equal(land.fits, true)
  assert.equal(land.fps, 24)
  assert.equal(land.q, 70)
})

test('a clip that misses everywhere reports the floor bytes a shorter trim scales from', () => {
  const bytesAt = model(20_000, 5)
  const land = planLadder([30, 24], 50, bytesAt)
  assert.equal(land.fits, false)
  assert.equal(land.fps, 24)
  assert.equal(land.q, 50)
  assert.equal(land.floorBytes, bytesAt(24, 50))
})
