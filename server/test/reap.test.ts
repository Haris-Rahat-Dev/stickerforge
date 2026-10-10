import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reapOrphans, type ReapInput } from '../src/reap.ts'

const mk = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-reap-'))
  for (const d of ['uploads', 'outputs', 'trays', 'webp-cache', 'packs']) fs.mkdirSync(path.join(root, d))
  return root
}

const put = (root: string, rel: string, ageMs = 5 * 60 * 60 * 1000): string => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x'.repeat(128))
  const t = (Date.now() - ageMs) / 1000
  fs.utimesSync(p, t, t)
  return p
}

const base = (root: string, over: Partial<ReapInput> = {}): ReapInput => ({
  dataDir: root,
  uploads: path.join(root, 'uploads'),
  outputs: path.join(root, 'outputs'),
  trays: path.join(root, 'trays'),
  webpCache: path.join(root, 'webp-cache'),
  packs: path.join(root, 'packs'),
  liveFilePaths: [],
  liveFileIds: [],
  liveJobPaths: [],
  now: Date.now(),
  ...over,
})

test('unreferenced media older than the grace window is reclaimed', () => {
  const root = mk()
  const orphan = put(root, 'uploads/dead.mp4')
  const r = reapOrphans(base(root))
  assert.ok(r.removed.includes('uploads/dead.mp4'))
  assert.equal(fs.existsSync(orphan), false)
  assert.ok(r.bytes > 0)
})

test('anything a file or job row still references survives', () => {
  const root = mk()
  const upload = put(root, 'uploads/live.mp4')
  const output = put(root, 'outputs/live.webm')
  const tray = put(root, 'trays/live.png')
  const cached = put(root, 'webp-cache/live.webp')
  const r = reapOrphans(base(root, {
    liveFilePaths: [upload],
    liveJobPaths: [output, tray, cached],
  }))
  assert.deepEqual(r.removed, [])
  for (const p of [upload, output, tray, cached]) assert.ok(fs.existsSync(p), `${p} must not be deleted`)
})

test('recent files are left alone so an in-flight write is never swept', () => {
  const root = mk()
  const fresh = put(root, 'uploads/new.mp4', 1000)
  const r = reapOrphans(base(root))
  assert.deepEqual(r.removed, [])
  assert.ok(fs.existsSync(fresh))
})

test('a filmstrip is removed only once its source is gone', () => {
  const root = mk()
  const liveStrip = put(root, 'aaa-strip.jpg')
  const deadStrip = put(root, 'bbb-strip.jpg')
  const liveFilm = put(root, 'aaa-film.jpg')
  const deadFilm = put(root, 'bbb-film.jpg')
  const r = reapOrphans(base(root, { liveFileIds: ['aaa'] }))
  assert.ok(r.removed.includes('bbb-strip.jpg'))
  assert.ok(fs.existsSync(liveStrip), 'a strip whose source is still around stays cached')
  assert.ok(r.removed.includes('bbb-film.jpg'), 'the tiled filmstrip is keyed by source id too')
  assert.ok(fs.existsSync(liveFilm))
  assert.ok(!fs.existsSync(deadFilm) && !fs.existsSync(deadStrip))
})

test('a crashed build leaves a .next that the next boot clears, but never a live pack', () => {
  const root = mk()
  const stale = path.join(root, 'packs', 'abc123.next')
  const live = path.join(root, 'packs', 'def456')
  fs.mkdirSync(stale); fs.mkdirSync(live)
  fs.writeFileSync(path.join(live, 'manifest.json'), '{}')
  const r = reapOrphans(base(root))
  assert.equal(fs.existsSync(stale), false, 'orphaned staging dir removed')
  assert.ok(fs.existsSync(path.join(live, 'manifest.json')), 'built pack untouched')
  assert.ok(r.removed.some(x => x.endsWith('.next')))
})

test('an interrupted pack swap is restored from .prev when the live pack is missing', () => {
  const root = mk()
  fs.mkdirSync(path.join(root, 'packs', 'abc123.prev'))
  fs.writeFileSync(path.join(root, 'packs', 'abc123.prev', 'manifest.json'), '{}')
  const r = reapOrphans(base(root))
  assert.ok(fs.existsSync(path.join(root, 'packs', 'abc123', 'manifest.json')), 'the swapped-out pack is restored')
  assert.equal(fs.existsSync(path.join(root, 'packs', 'abc123.prev')), false)
  assert.ok(!r.removed.some(x => x.endsWith('.prev')), 'a restore is not a removal')
})

test('a leftover .prev next to a live pack is removed', () => {
  const root = mk()
  for (const n of ['abc123', 'abc123.prev']) {
    fs.mkdirSync(path.join(root, 'packs', n))
    fs.writeFileSync(path.join(root, 'packs', n, 'manifest.json'), '{}')
  }
  const r = reapOrphans(base(root))
  assert.ok(fs.existsSync(path.join(root, 'packs', 'abc123', 'manifest.json')), 'the live pack is untouched')
  assert.equal(fs.existsSync(path.join(root, 'packs', 'abc123.prev')), false)
  assert.ok(r.removed.some(x => x.endsWith('.prev')))
})

test('reaping an empty or missing tree is a no-op', () => {
  const root = mk()
  fs.rmSync(path.join(root, 'outputs'), { recursive: true })
  const r = reapOrphans(base(root))
  assert.deepEqual(r.removed, [])
})

test('a sweep that would clear a whole directory is refused', () => {  // every-entry case
  const root = mk()
  // This is what a broken "still referenced" set looks like — e.g. forgetting that
  // the WebP cache is keyed by job id. Reclaiming it would be unrecoverable.
  const all = ['a', 'b', 'c', 'd'].map(n => put(root, `webp-cache/${n}.webp`))
  const r = reapOrphans(base(root))
  assert.deepEqual(r.removed, [], 'majority-deletion must be refused')
  for (const p of all) assert.ok(fs.existsSync(p))
})

test('a genuine majority of garbage is still reclaimed when one file is live', () => {
  const root = mk()
  const live = put(root, 'webp-cache/live.webp')
  const dead = ['x', 'y'].map(n => put(root, `webp-cache/${n}.webp`))
  const r = reapOrphans(base(root, { liveJobPaths: [live] }))
  // Only an all-or-nothing sweep is treated as a bug; most of a directory being
  // stale is ordinary cleanup, and blocking it would leak disk forever.
  assert.equal(r.removed.length, 2)
  assert.ok(fs.existsSync(live))
  for (const p of dead) assert.equal(fs.existsSync(p), false)
})
