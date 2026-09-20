import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVerifier, publicPath } from '../src/auth.ts'

test('accepts a verified token and returns its uid', async () => {
  const verify = createVerifier(async () => ({ uid: 'uid-abc' }))
  assert.equal(await verify('any-token'), 'uid-abc')
})

test('rejects when verifyIdToken throws', async () => {
  const verify = createVerifier(async () => { throw new Error('bad') })
  await assert.rejects(() => verify('bad-token'))
})

test('rejects a token with no uid', async () => {
  const verify = createVerifier(async () => ({ uid: '' }))
  await assert.rejects(() => verify('no-uid'))
})

test('pack fetch routes stay public for the Android app', () => {
  assert.equal(publicPath('/api/pack/demo'), true)
  assert.equal(publicPath('/api/pack/ABC123/file/sticker_0.webp'), true)
})

test('every other api route is protected', () => {
  assert.equal(publicPath('/api/files'), false)
  assert.equal(publicPath('/api/upload'), false)
  assert.equal(publicPath('/api/packs'), false)
  assert.equal(publicPath('/api/packs/ABC123/build'), false)
  assert.equal(publicPath('/api/job/xyz'), false)
})

test('a path merely containing /api/pack/ is not public', () => {
  assert.equal(publicPath('/api/packs/ABC/stickers'), false)
})
