import fs from 'node:fs'
import path from 'node:path'

// Reclaims disk that no record can reach any more. Anything still referenced by a
// file row, a job row or a pack stays exactly where it is — this is garbage collection
// of orphans, not a TTL on user data. Deleting a staged upload the user has not
// committed yet would be destructive, so it is deliberately out of scope here.

const walk = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).map(n => path.join(dir, n))
  } catch {
    return []
  }
}

const STRIP_SUFFIXES = ['-film.jpg.tmp.jpg', '-strip.jpg', '-film.jpg']

export interface ReapInput {
  dataDir: string
  uploads: string
  outputs: string
  trays: string
  webpCache: string
  packs: string
  /** Absolute paths still referenced by a file row. */
  liveFilePaths: Iterable<string>
  /** Ids of file rows that still exist — filmstrips are named "<id>-film.jpg" (legacy "-strip.jpg"). */
  liveFileIds: Iterable<string>
  /** Absolute paths still referenced by a job row: output and tray. */
  liveJobPaths: Iterable<string>
  now?: number
  /** Grace so a file being written right now is never swept. */
  minAgeMs?: number
}

export interface ReapResult {
  bytes: number
  removed: string[]
}

export function reapOrphans(input: ReapInput): ReapResult {
  const now = input.now ?? Date.now()
  const minAge = input.minAgeMs ?? 60 * 60 * 1000
  const live = new Set<string>([...input.liveFilePaths, ...input.liveJobPaths])
  const removed: string[] = []
  let bytes = 0

  const sweep = (dir: string, keep: (p: string) => boolean): void => {
    const doomed: Array<{ path: string; size: number }> = []
    for (const entry of walk(dir)) {
      if (live.has(entry) || !keep(entry)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(entry)
      } catch {
        continue
      }
      if (stat.isDirectory() || now - stat.mtimeMs < minAge) continue
      doomed.push({ path: entry, size: stat.size })
    }
    // Circuit breaker: a directory whose every entry looks like garbage means the
    // caller's "still referenced" set is wrong, not that the disk is clean. That is
    // how the WebP cache got erased once already, and it is unrecoverable.
    const total = walk(dir).length
    if (doomed.length > 0 && doomed.length === total && total >= 2) {
      console.warn(`reap: skipped ${dir} — all ${total} entries look unreferenced, which is a reference bug not garbage`)
      return
    }
    for (const entry of doomed) {
      try {
        fs.rmSync(entry.path)
        bytes += entry.size
        removed.push(path.relative(input.dataDir, entry.path))
      } catch { /* raced away */ }
    }
  }

  for (const dir of [input.uploads, input.outputs, input.trays, input.webpCache]) {
    sweep(dir, () => true)
  }
  // Filmstrips are written straight into DATA next to the database and keyed by the
  // id of the source they were cut from. "-strip.jpg" is the legacy 96px-wide sprite,
  // "-film.jpg" the taller one the timeline tiles today; both die with their source.
  const ids = new Set(input.liveFileIds)
  sweep(input.dataDir, p => {
    // An in-flight filmstrip write is never a finished strip, live id or not.
    if (p.endsWith('-film.jpg.tmp.jpg')) return true
    const suffix = STRIP_SUFFIXES.find(s => p.endsWith(s))
    if (!suffix) return false
    return !ids.has(path.basename(p).slice(0, -suffix.length))
  })

  // A build that crashed leaves <code>.next behind. It is never the live pack — that
  // is the same path without the suffix — so it is always garbage. A crash mid-swap
  // leaves <code>.prev: with the live pack gone it is the pack, and is restored.
  for (const entry of walk(input.packs)) {
    if (entry.endsWith('.prev')) {
      const live = entry.slice(0, -'.prev'.length)
      try {
        if (!fs.existsSync(live)) {
          fs.renameSync(entry, live)
          console.warn(`reap: restored ${path.basename(live)} from an interrupted pack swap`)
        } else {
          fs.rmSync(entry, { recursive: true, force: true })
          removed.push(path.relative(input.dataDir, entry))
        }
      } catch { /* leave it */ }
      continue
    }
    if (!entry.endsWith('.next')) continue
    try {
      fs.rmSync(entry, { recursive: true, force: true })
      removed.push(path.relative(input.dataDir, entry))
    } catch { /* leave it */ }
  }

  return { bytes, removed }
}
