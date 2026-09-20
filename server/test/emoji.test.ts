import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseEmojis, DEFAULT_EMOJI } from '../src/sticker.ts'

test('keeps a valid 1-3 emoji list', () => {
  assert.deepEqual(normaliseEmojis(['😂']), ['😂'])
  assert.deepEqual(normaliseEmojis(['😂', '🔥', '💀']), ['😂', '🔥', '💀'])
})

test('truncates past three, which WhatsApp rejects', () => {
  assert.deepEqual(normaliseEmojis(['😂', '🔥', '💀', '👀']), ['😂', '🔥', '💀'])
})

test('falls back to a default rather than returning an empty list', () => {
  assert.deepEqual(normaliseEmojis([]), [DEFAULT_EMOJI])
  assert.deepEqual(normaliseEmojis(undefined), [DEFAULT_EMOJI])
  assert.deepEqual(normaliseEmojis('not an array'), [DEFAULT_EMOJI])
  assert.deepEqual(normaliseEmojis([null, '']), [DEFAULT_EMOJI])
})

test('drops blanks but keeps the survivors', () => {
  assert.deepEqual(normaliseEmojis(['😂', '', null, '🔥']), ['😂', '🔥'])
})
