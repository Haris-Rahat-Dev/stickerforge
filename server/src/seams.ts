import { spawn } from 'node:child_process'
import { frameDiff, movingStep, scoreLoops, seamVerdict, type LoopBounds, type LoopResult, type SeamVerdict } from './loop.js'
import { keptSeconds, normalizeSpans, type Span } from './spans.js'
import { MAX_STICKER_SEC } from './budget.js'

// Every join in a sticker is a seam: the cut between piece i and piece i+1, and the loop
// from the last piece back to the first. Each piece end belongs to exactly one seam, so
// they are scored one at a time with the same "does the next piece's first frame look
// like the frame that would have come next?" test as the loop.

const SIDE = 16
/** How far a cut may move either way; loops only ever move inward this far. */
const SEAM_SEARCH_SEC = 1.5
const MIN_PIECE = 0.3
const MIN_LOOP = 0.5

export type SeamKind = 'cut' | 'loop'
export type SeamLabel = SeamVerdict | 'shot'

export interface SeamReport {
  index: number
  kind: SeamKind
  /** Current join: the earlier side stops at `end`, the later side resumes at `start`. */
  end: number
  start: number
  label: SeamLabel
  cost: number | null
  /** What snapping this seam would do (equal to the current join when nothing beats it). */
  best: { end: number; start: number; label: SeamLabel; cost: number; changed: boolean; grew: number }
  applied: boolean
}

export interface SeamWarning {
  piece: number
  kind: 'ends-blank' | 'starts-blank'
  /** Trailing blank from `at` to the piece end, or leading blank up to `at`. */
  at: number
}

export interface SeamPlan {
  seams: SeamReport[]
  /** The cuts after applying every seam (or just `only`). */
  spans: Span[]
  grew: number
  typical: number
  warnings: SeamWarning[]
}

/** Uniform frames — black, white flashes, fade-outs — never make a seam, and warn. */
export function isBlank(f: Uint8Array): boolean {
  let lo = 255, hi = 0
  for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v }
  return hi - lo < 12
}

/**
 * Frame indices where a new shot starts: one *isolated* step far bigger than the motion
 * around it, with both neighbouring steps small. Anything loud for several frames
 * running — a zoom, a whip pan, a leg sweeping past the lens (stargazer 3.6s), a fade
 * to black (caught by isBlank instead) — is motion inside a shot, not a cut.
 */
export function hardCuts(prints: Uint8Array[]): number[] {
  const steps = prints.map((f, i) => (i ? frameDiff(f, prints[i - 1]) : 0))
  const cuts: number[] = []
  for (let i = 1; i < steps.length; i++) {
    const around: number[] = []
    for (let j = Math.max(1, i - 6); j <= Math.min(steps.length - 1, i + 6); j++) {
      if (j !== i && steps[j] > 0.5) around.push(steps[j])   // held frames aren't motion
    }
    const sorted = around.sort((a, b) => a - b)
    const med = sorted.length ? sorted[sorted.length >> 1] : 0
    const neighbours = Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0)
    if (steps[i] >= 15 && steps[i] >= 3 * Math.max(neighbours, 1) && steps[i] >= 4 * Math.max(med, 1)) cuts.push(i)
  }
  return cuts
}

/** A hard cut lies between two source times — the two sides are different shots. */
export function shotBetween(cuts: number[], fps: number, a: number, b: number): boolean {
  const lo = Math.min(a, b), hi = Math.max(a, b)
  return cuts.some(i => i / fps > lo + 1e-6 && i / fps <= hi + 1e-6)
}

/** Blank runs touching a piece's ends, from the whole-clip fingerprints. */
export function blankEdges(prints: Uint8Array[], fps: number, pieces: Span[]): SeamWarning[] {
  const out: SeamWarning[] = []
  const at = (t: number): Uint8Array | undefined => prints[Math.min(prints.length - 1, Math.max(0, Math.floor(t * fps + 1e-6)))]
  pieces.forEach((p, i) => {
    const dt = 1 / fps
    let t = p.end - dt
    if (at(t) && isBlank(at(t)!)) {
      while (t - dt > p.start && isBlank(at(t - dt)!)) t -= dt
      if (t > p.start + MIN_PIECE) out.push({ piece: i, kind: 'ends-blank', at: Math.round(t * 1000) / 1000 })
    }
    let u = p.start
    if (at(u) && isBlank(at(u)!)) {
      while (u + dt < p.end - dt && isBlank(at(u + dt)!)) u += dt
      const until = u + dt
      if (until < p.end - MIN_PIECE) out.push({ piece: i, kind: 'starts-blank', at: Math.round(until * 1000) / 1000 })
    }
  })
  return out
}

// Whole-clip fingerprints with the sticker's own crop/fit, cached: seams are re-scored
// on every edit in Custom, and one pass (~0.1–0.3s even for a 65s clip) serves every
// seam, the hard-cut scan and the blank check — so they all see the same frames.
const printCache = new Map<string, Promise<Uint8Array[]>>()
export function clipPrints(inputPath: string, fps: number, preVf = ''): Promise<Uint8Array[]> {
  const key = `${inputPath}|${fps}|${preVf}`
  let hit = printCache.get(key)
  if (!hit) {
    const chain = [`fps=${fps}`, preVf, `scale=${SIDE}:${SIDE}:flags=area,format=gray`].filter(Boolean).join(',')
    hit = new Promise<Uint8Array[]>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-i', inputPath,
        '-vf', chain, '-f', 'rawvideo', 'pipe:1'], { timeout: 120_000, killSignal: 'SIGKILL' })
      const chunks: Buffer[] = []
      p.stdout.on('data', d => chunks.push(d))
      p.on('close', c => {
        if (c !== 0) { reject(new Error('fingerprint pass failed')); return }
        const buf = Buffer.concat(chunks)
        const out: Uint8Array[] = []
        for (let off = 0; off + SIDE * SIDE <= buf.length; off += SIDE * SIDE) out.push(buf.subarray(off, off + SIDE * SIDE))
        resolve(out)
      })
      p.on('error', reject)
    })
    hit.catch(() => printCache.delete(key))
    printCache.set(key, hit)
    while (printCache.size > 8) printCache.delete(printCache.keys().next().value!)
  }
  return hit
}

const RANK: Record<SeamVerdict, number> = { seamless: 0, smooth: 1, noticeable: 2, jump: 3, hard: 4 }

/**
 * Source-time sampling rate that lands one sample on each frame the sticker shows.
 * Consecutive sticker frames are speed/fps apart in the source, so the rate is fps/speed:
 * a finer grid rates sub-frame hitches as jumps, a coarser one misses real ones.
 */
export function seamFps(fps: number, speed: number): number {
  const s = speed > 0 ? speed : 1
  return Math.min(60, Math.max(1, fps / s))
}

/** Frames covering [from, to] (source seconds) from the whole-clip pass, and the time of the first. */
function slice(prints: Uint8Array[], fps: number, from: number, to: number): { frames: Uint8Array[]; at: number } {
  const i0 = Math.max(0, Math.round(from * fps))
  const i1 = Math.min(prints.length - 1, Math.round(to * fps))
  return { frames: i1 >= i0 ? prints.slice(i0, i1 + 1) : [], at: i0 / fps }
}

/** Score one seam from the whole-clip pass: same maths as findLoop, no extra decode. */
function scoreSeam(prints: Uint8Array[], fps: number, b: LoopBounds, asked: { start: number; end: number }): LoopResult | null {
  const dt = 1 / fps
  const head = slice(prints, fps, b.sLo, b.sHi)
  // Tail frames are the last *shown* frames (one step before each end), plus one past
  // eHi so even the last candidate has the frame that "would have come next".
  const tail = slice(prints, fps, b.eLo - dt, b.eHi + dt)
  return scoreLoops(head.frames, head.at, tail.frames, tail.at, fps, b, asked)
}

/**
 * Score every seam of `spans` and, for `only` (or all when omitted), move its two ends
 * to the smoothest join in reach. Seams run in order on the updated pieces, so a piece
 * whose start moved at seam i−1 is respected at seam i. Cuts may grow the kept total up
 * to `maxKept` source seconds (the sticker cap × speed); the loop only trims.
 */
export async function planSeams(opts: {
  inputPath: string
  spans: Span[]
  duration: number
  fps: number
  preVf: string
  only?: number | null
  maxKept?: number
}): Promise<SeamPlan> {
  const { inputPath, duration, fps, preVf, only, maxKept = MAX_STICKER_SEC } = opts
  const pieces = opts.spans.map(s => ({ ...s }))
  const n = pieces.length
  const W = SEAM_SEARCH_SEC
  const prints = await clipPrints(inputPath, fps, preVf)
  const cuts = hardCuts(prints)
  // One yardstick for every seam and every press: normal motion across the whole clip.
  // Measuring it over the kept pieces moved it whenever a press moved a cut, so pressing
  // again kept "improving" the same join.
  const typical = movingStep(prints)
  let headroom = Math.max(0, maxKept - keptSeconds(pieces))
  let grew = 0
  const seams: SeamReport[] = []

  for (let i = 0; i < n; i++) {
    const loop = i === n - 1
    const A = pieces[i]
    const B = pieces[(i + 1) % n]
    const asked = { start: B.start, end: A.end }
    const bounds = n === 1
      ? { sLo: A.start, sHi: Math.max(A.start, Math.min(A.start + W, A.end - MIN_LOOP)), eLo: Math.min(A.end, Math.max(A.end - W, A.start + MIN_LOOP)), eHi: A.end, minLen: MIN_LOOP, sameCut: true, prefer: 'longest' as const }
      : loop
        ? { sLo: B.start, sHi: Math.max(B.start, Math.min(B.start + W, B.end - MIN_PIECE)), eLo: Math.min(A.end, Math.max(A.end - W, A.start + MIN_PIECE)), eHi: A.end, minLen: 0, sameCut: false, prefer: 'longest' as const }
        : { sLo: Math.max(0, B.start - W), sHi: Math.max(B.start, Math.min(B.start + W, B.end - MIN_PIECE)), eLo: Math.max(A.start + MIN_PIECE, A.end - W), eHi: Math.min(duration, A.end + W), minLen: 0, sameCut: false, before: true, maxGrow: headroom, prefer: 'closest' as const }
    const r = scoreSeam(prints, fps, { ...bounds, typical }, asked)
    // The loop compares the last piece's end with the first piece's start: a hard cut
    // anywhere in the sticker's span means they come from different shots.
    const shot = loop
      ? shotBetween(cuts, fps, pieces[0].start, pieces[n - 1].end)
      : shotBetween(cuts, fps, A.end, B.start)
    if (!r) {
      seams.push({ index: i, kind: loop ? 'loop' : 'cut', end: A.end, start: B.start, label: shot ? 'shot' : 'jump', cost: null,
        best: { end: A.end, start: B.start, label: shot ? 'shot' : 'jump', cost: 0, changed: false, grew: 0 }, applied: false })
      continue
    }
    // A different shot on each side is an edit, not a glitch: say so rather than flag it,
    // unless nudging found frames that genuinely match anyway.
    const curVerdict = r.currentVerdict ?? seamVerdict(r.cost, r.typical)
    const label = (v: SeamVerdict): SeamLabel => (shot && RANK[v] >= RANK.noticeable ? 'shot' : v)
    const bestGrew = r.changed ? Math.round(((r.end - asked.end) + (asked.start - r.start)) * 1000) / 1000 : 0
    const worth = r.changed && !(shot && RANK[r.verdict] >= RANK.noticeable)
    const apply = worth && (only == null || only === i)
    seams.push({
      index: i, kind: loop ? 'loop' : 'cut', end: A.end, start: B.start,
      label: label(curVerdict), cost: r.current,
      best: { end: r.end, start: r.start, label: label(r.verdict), cost: r.cost, changed: worth, grew: worth ? bestGrew : 0 },
      applied: apply,
    })
    if (apply) {
      A.end = r.end
      B.start = r.start
      if (bestGrew > 0) { headroom -= bestGrew; grew += bestGrew }
    }
  }

  return {
    seams,
    spans: normalizeSpans(pieces, duration, maxKept),
    grew: Math.round(grew * 1000) / 1000,
    typical,
    warnings: blankEdges(prints, fps, pieces),
  }
}
