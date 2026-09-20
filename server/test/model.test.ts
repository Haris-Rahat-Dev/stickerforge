import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initDb,
  saveFile,
  saveJob,
  loadFiles,
  loadJobs,
  removeFile,
  removeJob,
  createPack,
  setPackStickers,
  countPacksWithJob,
  removeJobFromAllPacks,
} from '../src/db.ts'
import { isEditable, dedupeMembership, stickerView } from '../src/sticker.ts'
import type { FileRecord, Job } from '../src/types.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-model-'))
initDb(dir)

const file = (id: string): FileRecord => ({
  id,
  owner: 'u1',
  kind: 'video',
  originalName: `${id}.mp4`,
  path: `/tmp/${id}.mp4`,
  sizeBytes: 1,
  meta: {
    width: 512,
    height: 512,
    fps: 30,
    duration: 2,
    bitrate: 1,
    codec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: false,
    sizeBytes: 1,
  },
  quality: { level: 'good', notes: [] },
})

const job = (id: string, fileId: string): Job => ({
  id,
  owner: 'u1',
  kind: 'video',
  fileId,
  status: 'done',
  progress: 1,
  stage: 'done',
  outputPath: `/tmp/${id}.webm`,
  settings: {
    start: 0,
    end: 2,
    speed: 1,
    fps: 30,
    fit: 'cover',
    padColor: '#000000',
    crop: null,
    cropPos: 0.5,
    border: false,
  },
  startedAt: 0,
})

test('removing a source keeps its sticker', () => {
  saveFile(file('f1'))
  saveJob(job('j1', 'f1'))
  removeFile('f1')
  assert.equal(loadFiles().some(f => f.id === 'f1'), false, 'file row should be gone')
  assert.equal(loadJobs().some(j => j.id === 'j1'), true, 'sticker must survive')
})

test('removing a sticker removes only that sticker', () => {
  saveFile(file('f2'))
  saveJob(job('j2', 'f2'))
  saveJob(job('j3', 'f2'))
  removeJob('j2')
  assert.equal(loadJobs().some(j => j.id === 'j2'), false)
  assert.equal(loadJobs().some(j => j.id === 'j3'), true)
  assert.equal(loadFiles().some(f => f.id === 'f2'), true, 'source is not touched')
})

test('a sticker is editable while its source file exists', () => {
  const src = path.join(dir, 'src.mp4')
  fs.writeFileSync(src, 'x')
  assert.equal(isEditable({ ...job('j9', 'f9') }, { ...file('f9'), path: src }), true)
})

test('a sticker with no source record is locked', () => {
  assert.equal(isEditable(job('j10', 'f10'), undefined), false)
})

test('a sticker whose source file is gone from disk is locked', () => {
  assert.equal(isEditable(job('j11', 'f11'), { ...file('f11'), path: path.join(dir, 'missing.mp4') }), false)
})

test('a sticker in two packs has a reference count of two', () => {
  const a = createPack('u1', 'A')
  const b = createPack('u1', 'B')
  setPackStickers(a.code, ['shared', 'onlyA'])
  setPackStickers(b.code, ['shared'])
  assert.equal(countPacksWithJob('shared'), 2)
  assert.equal(countPacksWithJob('onlyA'), 1)
  assert.equal(countPacksWithJob('nowhere'), 0)
})

test('removing a sticker everywhere drops it from every pack', () => {
  const a = createPack('u1', 'A2')
  const b = createPack('u1', 'B2')
  setPackStickers(a.code, ['x', 'y'])
  setPackStickers(b.code, ['x'])
  removeJobFromAllPacks('x')
  assert.equal(countPacksWithJob('x'), 0)
  assert.equal(countPacksWithJob('y'), 1)
})

test('membership dedupes by jobId and preserves order', () => {
  assert.deepEqual(dedupeMembership(['a', 'b', 'a', 'c']), ['a', 'b', 'c'])
})

test('two stickers from one source may both sit in a pack', () => {
  // Distinct jobs, same fileId — two trims of one video. The old fileId dedupe
  // collapsed these, which broke cross-pack reuse and multi-trim packs.
  assert.deepEqual(dedupeMembership(['trimA', 'trimB']), ['trimA', 'trimB'])
})

test('stickerView generates full view with normalized emojis and editability', () => {
  const src = path.join(dir, 'stickerView.mp4')
  fs.writeFileSync(src, 'x')
  const f = { ...file('fview'), originalName: 'Custom Name.mp4', path: src }
  const j = { ...job('jview', 'fview'), sizeBytes: 12345, emojis: ['🔥'] }
  const view = stickerView(j, f)
  assert.deepEqual(view, {
    jobId: 'jview',
    fileId: 'fview',
    kind: 'video',
    name: 'Custom Name.mp4',
    sizeBytes: 12345,
    editable: true,
    emojis: ['🔥'],
  })
})
