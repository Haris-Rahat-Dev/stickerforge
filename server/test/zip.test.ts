import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipStore } from '../src/zip.ts'

test('a stored zip round-trips through the system unzip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-zip-'))
  const a = Buffer.from('{"identifier":"x"}')
  const b = Buffer.alloc(70_000, 7)
  fs.writeFileSync(path.join(dir, 'p.zip'), zipStore([{ name: 'manifest.json', data: a }, { name: 's1.webp', data: b }]))
  execFileSync('unzip', ['-q', 'p.zip', '-d', 'out'], { cwd: dir })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'out', 'manifest.json')), a)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'out', 's1.webp')), b)
  fs.rmSync(dir, { recursive: true, force: true })
})
