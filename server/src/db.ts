import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FileRecord, Job, Pack } from './types.js'

// Local persistence so files + finished jobs + packs survive a server restart.
// Records are JSON-serializable, so files/jobs are stored whole (owner lives in the
// JSON). Packs are a small relational model so membership + per-pack identifier/
// version can be queried. Built-in node:sqlite (Node 22.5+) — no dependency.
let db: DatabaseSync | null = null

export function initDb(dataDir: string): void {
  db = new DatabaseSync(path.join(dataDir, 'stickerforge.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs  (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS packs (
      code TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      identifier TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pack_stickers (
      code TEXT NOT NULL, position INTEGER NOT NULL, job_id TEXT NOT NULL,
      PRIMARY KEY (code, position)
    );
  `)
  // Migrate a pre-multi-user packs table (had only code/identifier/version).
  for (const col of [
    "owner TEXT NOT NULL DEFAULT 'legacy'",
    "name TEXT NOT NULL DEFAULT 'StickerForge Pack'"
  ]) {
    try { db.exec(`ALTER TABLE packs ADD COLUMN ${col}`) } catch { /* column already exists */ }
  }
}

// ── files & jobs (owner is inside the JSON) ──────────────────────────────────
export function loadFiles(): FileRecord[] {
  return db!.prepare('SELECT json FROM files').all().map(r => JSON.parse((r as { json: string }).json))
}
export function loadJobs(): Job[] {
  return db!.prepare('SELECT json FROM jobs').all().map(r => JSON.parse((r as { json: string }).json))
}
export function saveFile(rec: FileRecord): void {
  db!.prepare('INSERT OR REPLACE INTO files (id, json) VALUES (?, ?)').run(rec.id, JSON.stringify(rec))
}
export function saveJob(job: Job): void {
  db!.prepare('INSERT OR REPLACE INTO jobs (id, file_id, json) VALUES (?, ?, ?)').run(job.id, job.fileId, JSON.stringify(job))
}
// A source and the stickers made from it now have independent lifetimes: building a
// pack deletes the source while the sticker lives on. Deleting the file row must
// therefore NOT cascade into jobs.
export function removeFile(id: string): void {
  db!.prepare('DELETE FROM files WHERE id = ?').run(id)
}

export function removeJob(id: string): void {
  db!.prepare('DELETE FROM jobs WHERE id = ?').run(id)
}

// ── packs ────────────────────────────────────────────────────────────────────
function readStickers(code: string): string[] {
  return db!.prepare('SELECT job_id FROM pack_stickers WHERE code = ? ORDER BY position').all(code)
    .map(r => (r as { job_id: string }).job_id)
}
function rowToPack(row: { code: string; owner: string; name: string; identifier: string; version: number }): Pack {
  return { ...row, jobIds: readStickers(row.code) }
}
type PackRow = { code: string; owner: string; name: string; identifier: string; version: number }

export function createPack(owner: string, name: string): Pack {
  const code = crypto.randomBytes(6).toString('hex')          // 12-char unguessable capability
  const identifier = `stickerforge-${code}`
  db!.prepare('INSERT INTO packs (code, owner, name, identifier, version) VALUES (?, ?, ?, ?, 0)')
    .run(code, owner, name, identifier)
  return { code, owner, name, identifier, version: 0, jobIds: [] }
}

export function getPack(code: string): Pack | null {
  const row = db!.prepare('SELECT * FROM packs WHERE code = ?').get(code) as PackRow | undefined
  return row ? rowToPack(row) : null
}

export function listPacks(owner: string): Pack[] {
  return (db!.prepare('SELECT * FROM packs WHERE owner = ? ORDER BY code').all(owner) as PackRow[]).map(rowToPack)
}

export function renamePack(code: string, name: string): void {
  db!.prepare('UPDATE packs SET name = ? WHERE code = ?').run(name, code)
}

export function bumpPackVersion(code: string): number {
  db!.prepare('UPDATE packs SET version = version + 1 WHERE code = ?').run(code)
  return (db!.prepare('SELECT version FROM packs WHERE code = ?').get(code) as { version: number }).version
}

export function setPackStickers(code: string, jobIds: string[]): void {
  const del = db!.prepare('DELETE FROM pack_stickers WHERE code = ?')
  const ins = db!.prepare('INSERT INTO pack_stickers (code, position, job_id) VALUES (?, ?, ?)')
  del.run(code)
  jobIds.forEach((jid, i) => ins.run(code, i, jid))
}

export function deletePack(code: string): void {
  db!.prepare('DELETE FROM pack_stickers WHERE code = ?').run(code)
  db!.prepare('DELETE FROM packs WHERE code = ?').run(code)
}

// Cross-pack reuse means a sticker's output files belong to no single pack. Nothing
// may delete them until no pack references the job any more.
export function countPacksWithJob(jobId: string): number {
  const row = db!.prepare('SELECT COUNT(DISTINCT code) AS n FROM pack_stickers WHERE job_id = ?')
    .get(jobId) as { n: number }
  return row.n
}

export function removeJobFromAllPacks(jobId: string): void {
  db!.prepare('DELETE FROM pack_stickers WHERE job_id = ?').run(jobId)
}
