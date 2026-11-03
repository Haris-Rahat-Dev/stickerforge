import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseEmojis, DEFAULT_EMOJI, packSignature } from '../src/sticker.ts'

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

test('refuses words and dedupes, so typed input cannot break the manifest', () => {
  assert.deepEqual(normaliseEmojis(['lol', '🔥', '🔥', 'x']), ['🔥'])
  assert.deepEqual(normaliseEmojis(['❤️', '👍🏽', '🇵🇰']), ['❤️', '👍🏽', '🇵🇰'])
  assert.deepEqual(normaliseEmojis(['😂'.repeat(9)]), [DEFAULT_EMOJI])
})

test('pack signature moves with anything the manifest carries', () => {
  const pack = { name: 'P', publisher: 'me', trayJobId: null, jobIds: ['a', 'b'] }
  const emojis: Record<string, string[]> = { a: ['😂'], b: ['🔥'] }
  const sig = packSignature(pack, id => emojis[id])
  assert.equal(packSignature({ ...pack }, id => emojis[id]), sig)
  assert.notEqual(packSignature({ ...pack, jobIds: ['b', 'a'] }, id => emojis[id]), sig)
  assert.notEqual(packSignature({ ...pack, publisher: 'you' }, id => emojis[id]), sig)
  assert.notEqual(packSignature({ ...pack, trayJobId: 'b' }, id => emojis[id]), sig)
  assert.notEqual(packSignature(pack, id => (id === 'a' ? ['💀'] : emojis[id])), sig)
})
