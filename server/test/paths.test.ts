import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initDb, saveFile, saveJob, loadFiles, loadJobs } from '../src/db.ts'
import type { FileRecord, Job } from '../src/types.ts'

const rec = (id: string, p: string): FileRecord => ({
  id, owner: 'u1', kind: 'video', originalName: `${id}.mp4`, path: p,
  sizeBytes: 10, meta: { width: 1, height: 1, fps: 30, duration: 1, bitrate: 0, codec: 'h264', pixFmt: 'yuv420p', hasAudio: false, sizeBytes: 10 },
  quality: { level: 'good', notes: [] },
})

const job = (id: string, fileId: string, out: string): Job => ({
  id, owner: 'u1', kind: 'video', fileId, status: 'done', progress: 1, stage: 'done',
  outputPath: out, trayPath: null, startedAt: 0,
  settings: { start: 0, end: 1, speed: 1, fps: 30, fit: 'cover', padColor: '#000', crop: null, cropPos: 0.5, border: false },
})

const rawJson = (dir: string, table: 'files' | 'jobs', id: string): string => {
  const db = new DatabaseSync(path.join(dir, 'stickerforge.db'))
  const row = db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as { json: string }
  db.close()
  return row.json
}

const mkTree = (base: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${base}-`))
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true })
  fs.mkdirSync(path.join(root, 'outputs'), { recursive: true })
  return root
}

const touch = (p: string): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'bytes')
  return p
}

test('paths inside DATA are stored relative to it', () => {
  const dir = mkTree('sf-rel-')
  initDb(dir)
  saveFile(rec('f1', touch(path.join(dir, 'uploads', 'f1.mp4'))))
  saveJob(job('j1', 'f1', touch(path.join(dir, 'outputs', 'j1.webm'))))

  assert.equal(JSON.parse(rawJson(dir, 'files', 'f1')).path, 'uploads/f1.mp4')
  assert.equal(JSON.parse(rawJson(dir, 'jobs', 'j1')).outputPath, 'outputs/j1.webm')
  // Reading back always yields a usable absolute path.
  assert.equal(loadFiles()[0].path, path.join(dir, 'uploads', 'f1.mp4'))
})

test('a restored tree at a different DATA_DIR still resolves its stickers', () => {
  const a = mkTree('sf-src-')
  initDb(a)
  saveFile(rec('f2', touch(path.join(a, 'uploads', 'f2.mp4'))))
  saveJob(job('j2', 'f2', touch(path.join(a, 'outputs', 'j2.webm'))))

  const b = mkTree('sf-dst-')
  fs.copyFileSync(path.join(a, 'uploads', 'f2.mp4'), touch(path.join(b, 'uploads', 'f2.mp4')))
  fs.copyFileSync(path.join(a, 'outputs', 'j2.webm'), touch(path.join(b, 'outputs', 'j2.webm')))
  fs.copyFileSync(path.join(a, 'stickerforge.db'), path.join(b, 'stickerforge.db'))
  initDb(b)

  assert.equal(loadFiles()[0].path, path.join(b, 'uploads', 'f2.mp4'))
  assert.ok(fs.existsSync(loadFiles()[0].path), 'restored upload resolves')
  assert.equal(loadJobs()[0].outputPath, path.join(b, 'outputs', 'j2.webm'))
  assert.ok(fs.existsSync(loadJobs()[0].outputPath), 'restored sticker resolves')
})

test('legacy foreign-absolute paths are re-rooted onto the current DATA', () => {
  const dir = mkTree('sf-legacy-')
  // Rows written when DATA was elsewhere: outside the current DATA, so the write
  // leaves them absolute, pointing at a host that no longer exists.
  touch(path.join(dir, 'uploads', 'f3.mp4'))
  touch(path.join(dir, 'outputs', 'j3.webm'))
  initDb(dir)
  saveFile(rec('f3', '/home/other/stickerforge/data/uploads/f3.mp4'))
  saveJob(job('j3', 'f3', '/home/other/stickerforge/data/outputs/j3.webm'))

  assert.equal(loadFiles()[0].path, path.join(dir, 'uploads', 'f3.mp4'))
  assert.equal(loadJobs()[0].outputPath, path.join(dir, 'outputs', 'j3.webm'))

  // A boot persists the fix, so it happens once rather than on every start.
  initDb(dir)
  assert.equal(JSON.parse(rawJson(dir, 'files', 'f3')).path, 'uploads/f3.mp4')
  assert.equal(JSON.parse(rawJson(dir, 'jobs', 'j3')).outputPath, 'outputs/j3.webm')
  const before = rawJson(dir, 'files', 'f3')
  initDb(dir)
  assert.equal(rawJson(dir, 'files', 'f3'), before, 'normalisation is a fixpoint')
})

test('a path whose file is genuinely gone is left alone, not rewritten', () => {
  const dir = mkTree('sf-gone-')
  initDb(dir)
  saveFile(rec('f4', '/nowhere/data/uploads/f4.mp4'))
  assert.equal(loadFiles()[0].path, '/nowhere/data/uploads/f4.mp4')
  initDb(dir)
  assert.equal(JSON.parse(rawJson(dir, 'files', 'f4')).path, '/nowhere/data/uploads/f4.mp4')
})

test('normalising the database copies it aside first', () => {
  const dir = mkTree('sf-bak-')
  touch(path.join(dir, 'uploads', 'f5.mp4'))
  initDb(dir)
  saveFile(rec('f5', '/home/other/stickerforge/data/uploads/f5.mp4'))
  initDb(dir)
  assert.ok(fs.existsSync(path.join(dir, 'stickerforge.db.pre-path-normalise.bak')))
})
