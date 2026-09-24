import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concatPrefix, keptSeconds, normalizeSpans, spansFromTrim, splitAt } from '../src/spans.ts'

test('one trim is one span', () => {
  assert.deepEqual(spansFromTrim(1, 3), [{ start: 1, end: 3 }])
  assert.equal(concatPrefix([{ start: 1, end: 3 }]), null)
  assert.equal(keptSeconds([{ start: 0, end: 2 }, { start: 5, end: 6.5 }]), 3.5)
})

test('spans sort, merge overlaps, and stop at 6 seconds', () => {
  const spans = normalizeSpans(
    [{ start: 4, end: 7 }, { start: 0.2, end: 1 }, { start: 0.8, end: 1.4 }],
    20,
  )
  assert.deepEqual(spans[0], { start: 0.2, end: 1.4 })
  assert.ok(keptSeconds(spans) <= 6.01)
})

test('split at a playhead inside a span makes two ranges with a tiny gap', () => {
  const out = splitAt([{ start: 0, end: 4 }], 2, 0.06)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { start: 0, end: 2 })
  assert.equal(out[1].start, 2.06)
  assert.equal(out[1].end, 4)
  // The gap must survive normalize (not re-merge) so the two pieces stay separate.
  assert.equal(normalizeSpans(out, 8).length, 2)
})

test('split does nothing when neither half would clear the minimum', () => {
  assert.deepEqual(splitAt([{ start: 0, end: 0.5 }], 0.25, 0.06), [{ start: 0, end: 0.5 }])
  // A playhead in a gap leaves every span untouched.
  assert.deepEqual(splitAt([{ start: 0, end: 1 }], 3, 0.06), [{ start: 0, end: 1 }])
})

test('two spans become a concat prefix', () => {
  const vf = concatPrefix([{ start: 1, end: 2 }, { start: 5, end: 6.25 }])
  assert.ok(vf?.includes('trim=start=1:end=2'))
  assert.ok(vf?.includes('trim=start=5:end=6.25'))
  assert.ok(vf?.includes('concat=n=2:v=1:a=0,'))
})

test('sped up, the 6s cap applies to the sticker, so 6 × speed of source may be kept', () => {
  // 8s of source at 2× is a 4s sticker — legal; at 1× the same cuts stop at 6s.
  const cuts = [{ start: 0, end: 4 }, { start: 5, end: 9 }]
  assert.equal(keptSeconds(normalizeSpans(cuts, 20, 12)), 8)
  assert.equal(keptSeconds(normalizeSpans(cuts, 20)), 6)
})
