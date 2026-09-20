import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reducer,
  initialState,
  activePack,
  stagedCount,
  matchesQuery,
  type FlowState,
} from '../src/flow.ts'
import type { StickerView } from '../src/types.ts'

const pack = (code: string, ready = 0) => ({
  code,
  name: `Pack ${code}`,
  jobIds: [],
  ready,
  built: false,
  builtAt: null,
  stickers: [],
})

const base = (over: Partial<FlowState> = {}): FlowState => ({ ...initialState(), ...over })

test('starts on the packs route', () => {
  assert.equal(initialState().route, 'packs')
})

test('opening a pack switches route and active code', () => {
  const s = reducer(base({ packs: [pack('abc')] }), { type: 'openPack', code: 'abc' })
  assert.equal(s.route, 'pack')
  assert.equal(s.activeCode, 'abc')
})

test('leaving a pack returns to packs and clears staged sources', () => {
  const s = reducer(
    base({ route: 'pack', activeCode: 'abc', staged: [{ id: 'f1' } as never] }),
    { type: 'closePack' }
  )
  assert.equal(s.route, 'packs')
  assert.equal(s.activeCode, null)
  assert.deepEqual(s.staged, [])
  assert.equal(s.installOpen, false)
  assert.equal(s.built, null)
})

test('opening stickers switches to stickers route and clears canvas state', () => {
  const s = reducer(
    base({ route: 'pack', activeCode: 'abc', staged: [{ id: 'f1' } as never], installOpen: true }),
    { type: 'openStickers' }
  )
  assert.equal(s.route, 'stickers')
  assert.equal(s.activeCode, null)
  assert.deepEqual(s.staged, [])
  assert.equal(s.installOpen, false)
})

test('committing a staged source removes it from the shelf', () => {
  const s = reducer(
    base({
      staged: [{ id: 'f1' }, { id: 'f2' }] as never,
      encoding: { f1: 0.8 },
      errors: { f1: 'err' },
    }),
    { type: 'committed', fileId: 'f1' }
  )
  assert.deepEqual(s.staged.map(f => f.id), ['f2'])
  assert.equal('f1' in s.encoding, false)
  assert.equal('f1' in s.errors, false)
})

test('discarding a staged source removes it from the shelf', () => {
  const s = reducer(
    base({
      staged: [{ id: 'f1' }, { id: 'f2' }] as never,
      encoding: { f1: 0.5 },
      errors: { f1: 'err' },
    }),
    { type: 'discard', fileId: 'f1' }
  )
  assert.deepEqual(s.staged.map(f => f.id), ['f2'])
  assert.equal('f1' in s.encoding, false)
  assert.equal('f1' in s.errors, false)
})

test('staging files appends them to staged', () => {
  const s = reducer(
    base({ staged: [{ id: 'f1' }] as never }),
    { type: 'staged', files: [{ id: 'f2' }] as never }
  )
  assert.deepEqual(s.staged.map(f => f.id), ['f1', 'f2'])
})

test('buildProgress updates stage while building', () => {
  const s0 = reducer(base({}), { type: 'buildStart' })
  assert.equal(s0.building, true)
  assert.equal(s0.buildProgress?.stage, 'Starting…')
  const s1 = reducer(s0, { type: 'buildProgress', progress: 0.5, stage: 'Encoding sticker 2/4' })
  assert.equal(s1.buildProgress?.progress, 0.5)
  assert.equal(s1.buildProgress?.stage, 'Encoding sticker 2/4')
})

test('a failed build keeps the pack open and records the error', () => {
  const s = reducer(base({ route: 'pack', building: true }), { type: 'buildFail', error: 'boom' })
  assert.equal(s.route, 'pack')
  assert.equal(s.building, false)
  assert.equal(s.buildError, 'boom')
  assert.equal(s.installOpen, false)
})

test('a successful build opens the install drawer without leaving the canvas', () => {
  const manifest = { code: 'abc', identifier: 'i', name: 'n', stickers: [] }
  const s = reducer(base({ route: 'pack', building: true }), { type: 'buildOk', manifest })
  assert.equal(s.route, 'pack', 'the canvas must stay mounted')
  assert.equal(s.building, false)
  assert.equal(s.installOpen, true)
  assert.equal(s.buildError, null)
  assert.deepEqual(s.built, manifest)
})

test('closing install closes the drawer', () => {
  const s = reducer(base({ installOpen: true }), { type: 'closeInstall' })
  assert.equal(s.installOpen, false)
})

test('reopening install shows drawer when a manifest exists', () => {
  const manifest = { code: 'abc', identifier: 'i', name: 'n', stickers: [] }
  const s = reducer(base({ built: manifest }), { type: 'openInstall' })
  assert.equal(s.installOpen, true)
  assert.deepEqual(s.built, manifest)
})

test('reopening install does nothing when no manifest exists', () => {
  const s = reducer(base({}), { type: 'openInstall' })
  assert.equal(s.installOpen, false)
  assert.equal(s.built, null)
})

test('showInstall hydrates the manifest and opens the drawer', () => {
  const manifest = { code: 'abc', identifier: 'i', name: 'n', stickers: [] }
  const s = reducer(base({}), { type: 'showInstall', manifest })
  assert.equal(s.installOpen, true)
  assert.deepEqual(s.built, manifest)
})

test('activePack resolves the open pack', () => {
  assert.equal(activePack(base({ packs: [pack('a'), pack('b')], activeCode: 'b' }))?.code, 'b')
  assert.equal(activePack(base({ packs: [], activeCode: 'b' })), null)
})

test('stagedCount sums staged and uploading', () => {
  const s = base({
    staged: [{ id: 'f1' }] as never,
    uploading: [{ key: 'u1', name: 'v.mp4', progress: 0.5 }],
  })
  assert.equal(stagedCount(s), 2)
})

const sampleSticker: StickerView = {
  jobId: 'j1',
  fileId: 'f1',
  kind: 'video',
  name: 'Cute_cat_baby.mp4',
  editable: true,
  emojis: ['😂'],
}

test('matchesQuery: an empty query matches everything', () => {
  assert.equal(matchesQuery(sampleSticker, '', []), true)
  assert.equal(matchesQuery(sampleSticker, '   ', []), true)
})

test('matchesQuery: search matches the filename case-insensitively', () => {
  assert.equal(matchesQuery(sampleSticker, 'cat', []), true)
  assert.equal(matchesQuery(sampleSticker, 'CAT', []), true)
  assert.equal(matchesQuery(sampleSticker, 'dog', []), false)
})

test('matchesQuery: search matches an emoji', () => {
  assert.equal(matchesQuery(sampleSticker, '😂', []), true)
  assert.equal(matchesQuery(sampleSticker, '🔥', []), false)
})

test('matchesQuery: search matches the name of a pack the sticker belongs to', () => {
  assert.equal(matchesQuery(sampleSticker, 'memes', ['Best Memes']), true)
  assert.equal(matchesQuery(sampleSticker, 'memes', ['Cats']), false)
})
