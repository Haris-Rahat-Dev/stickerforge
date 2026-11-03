import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { createAuthMiddleware, createVerifier, publicPath, resolveAuthMode } from '../src/auth.ts'

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
  // Codes are 12 lowercase hex chars and files are s1.webp / tray.png. The allowlist
  // and CODE_RE in index.ts must agree, or a code auth waves through gets a 400.
  assert.equal(publicPath('/api/pack/60e4f0fbc010'), true)
  assert.equal(publicPath('/api/pack/60e4f0fbc010/file/s12.webp'), true)
  assert.equal(publicPath('/api/pack/60e4f0fbc010/file/tray.png'), true)
  assert.equal(publicPath('/api/pack/ABC123/file/sticker_0.webp'), false)
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

test('resolveAuthMode: e2e bypass wins', () => {
  const prev = process.env.FIREBASE_E2E_BYPASS
  process.env.FIREBASE_E2E_BYPASS = '1'
  assert.equal(resolveAuthMode(), 'e2e')
  if (prev === undefined) delete process.env.FIREBASE_E2E_BYPASS
  else process.env.FIREBASE_E2E_BYPASS = prev
})

test('resolveAuthMode: e2e bypass refuses a public bind', () => {
  const prev = { b: process.env.FIREBASE_E2E_BYPASS, h: process.env.HOST }
  process.env.FIREBASE_E2E_BYPASS = '1'
  process.env.HOST = '0.0.0.0'
  assert.throws(() => resolveAuthMode(), /loopback/)
  for (const [k, v] of [['FIREBASE_E2E_BYPASS', prev.b], ['HOST', prev.h]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('resolveAuthMode: cookie when service account unset', () => {
  const prevB = process.env.FIREBASE_E2E_BYPASS
  const prevS = process.env.FIREBASE_SERVICE_ACCOUNT
  delete process.env.FIREBASE_E2E_BYPASS
  delete process.env.FIREBASE_SERVICE_ACCOUNT
  assert.equal(resolveAuthMode(), 'cookie')
  if (prevB !== undefined) process.env.FIREBASE_E2E_BYPASS = prevB
  if (prevS !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = prevS
})

test('a linked phone token reaches the upload route and nothing else', () => {
  const mw = createAuthMiddleware(t => (t === 'good' ? 'owner-1' : null))
  const call = (method: string, p: string, token: string): { status: number; uid?: string } => {
    const req = { method, baseUrl: '/api', path: p, headers: { authorization: `Device ${token}` }, query: {} } as unknown as Request
    let status = 200
    const res = { status(c: number) { status = c; return this }, json() { return this }, cookie() { return this } } as unknown as Response
    mw(req, res, () => {})
    return { status, uid: (req as unknown as { userId?: string }).userId }
  }
  assert.deepEqual(call('POST', '/upload', 'good'), { status: 200, uid: 'owner-1' })
  assert.equal(call('POST', '/upload', 'stolen').status, 401)
  assert.equal(call('GET', '/files', 'good').status, 401)
  assert.equal(call('POST', '/packs/abc/build', 'good').status, 401)
})
