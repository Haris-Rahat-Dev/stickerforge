import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concatPrefix, keptSeconds, normalizeSpans, spansFromTrim } from '../src/spans.ts'

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

test('two spans become a concat prefix', () => {
  const vf = concatPrefix([{ start: 1, end: 2 }, { start: 5, end: 6.25 }])
  assert.ok(vf?.includes('trim=start=1:end=2'))
  assert.ok(vf?.includes('trim=start=5:end=6.25'))
  assert.ok(vf?.includes('concat=n=2:v=1:a=0,'))
})
