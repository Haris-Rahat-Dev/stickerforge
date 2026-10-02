// How visible a join is: the frame a piece resumes on against the frame that would have
// come next. Frames are compared as the same 16×16 gray fingerprints hold detection
// uses, taken *after* the sticker's own crop/fit so only shipped pixels count.

/** Same stillness cut as hold detection (HOLD_MEAN_MAX in webp.ts). */
const HOLD_MEAN = 0.5
const RANK: Record<SeamVerdict, number> = { seamless: 0, smooth: 1, noticeable: 2, jump: 3, hard: 4 }

export type SeamVerdict = 'seamless' | 'smooth' | 'noticeable' | 'jump' | 'hard'

export interface LoopCandidate { t: number; cost: number }

export interface LoopResult {
  /** Best loop (source seconds). Equal to the asked loop when nothing beats it. */
  start: number
  end: number
  /** False when the asked loop is already as smooth as anything within reach. */
  changed: boolean
  /** The jump from the last shown frame back to the first, at the best and asked loops. */
  cost: number
  current: number | null
  /** A normal frame-to-frame change in this footage — what "smooth" is measured against. */
  typical: number
  verdict: SeamVerdict
  currentVerdict: SeamVerdict | null
  /** Seam cost for every candidate end at the best start. */
  curve: LoopCandidate[]
}

/** Mean absolute difference of two fingerprints, 0–255. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * How visible a seam is, relative to how much this footage moves anyway. `cost` is how
 * far the loop's first frame is from the frame that *would* have come next, so 0 is a
 * perfect continuation, one normal step is a skipped or repeated frame, and many steps
 * is a jump. The same number is invisible on shaky footage and a hard cut on a still shot.
 */
export function seamVerdict(cost: number, typical: number): SeamVerdict {
  const base = Math.max(typical, 0.75)   // a near-static clip must not divide by ~0
  const r = cost / base
  if (r <= 0.5) return 'seamless'
  if (r <= 1.25) return 'smooth'       // about one frame off: a tiny hitch
  if (r <= 2.5) return 'noticeable'
  // Split so a big improvement inside "jump" still counts: stargazer's cut 32 → 6 is
  // hard → jump, which the only-change-when-it-improves rule would otherwise discard.
  if (r <= 6) return 'jump'
  return 'hard'
}

/** Median frame-to-frame change over frames that actually move. */
export function movingStep(frames: Uint8Array[]): number {
  const steps: number[] = []
  for (let i = 1; i < frames.length; i++) steps.push(frameDiff(frames[i], frames[i - 1]))
  const moving = steps.filter(x => x > HOLD_MEAN)
  return median(moving.length ? moving : steps)
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface LoopBounds {
  /** Start candidates [sLo, sHi]; end candidates [eLo, eHi] (end = after the last shown frame). */
  sLo: number; sHi: number; eLo: number; eHi: number
  /** Shortest loop allowed when start and end belong to the same cut. */
  minLen: number
  sameCut: boolean
  /**
   * A cut between two pieces: the end (of the earlier piece) must stay before the start
   * (of the later one) — pieces play in source order and must not overlap.
   */
  before?: boolean
  /** Most the kept total may grow, in seconds. Loop seams only shrink; cuts may grow. */
  maxGrow?: number
  /**
   * Within the best verdict level: 'longest' keeps the most clip (loops), 'closest'
   * moves the ends least so a cut stays where the user put it.
   */
  prefer?: 'longest' | 'closest'
  /**
   * A normal moving step measured once for the whole sticker. Without it each seam
   * measures its own window, and the same join rated "jump" or "noticeable" depending on
   * where the cut happened to be — so a second click kept improving things.
   */
  typical?: number
}

/**
 * Score every (start, end) pair. `headWin` holds frames from `headAt` at 1/fps steps,
 * `tailWin` frames from `tailAt`. A loop ending at t last shows the frame at t − dt and
 * then shows its start instead of the frame at t — the seam is how far apart those are.
 * Comparing against the *next* frame, not the last shown one, is what tells a loop that
 * carries the motion forward from one that twitches back a frame. At the clip's final
 * frame there is no next frame, so the fallback asks whether the jump is one normal step
 * and never calls the result seamless.
 */
export function scoreLoops(
  headWin: Uint8Array[], headAt: number,
  tailWin: Uint8Array[], tailAt: number,
  fps: number, b: LoopBounds,
  asked: { start: number; end: number } | null,
): LoopResult | null {
  if (!headWin.length || !tailWin.length || fps <= 0) return null
  const dt = 1 / fps
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const starts: Array<{ t: number; f: Uint8Array }> = []
  headWin.forEach((f, i) => {
    const t = r3(headAt + i * dt)
    if (t >= b.sLo - 1e-6 && t <= b.sHi + 1e-6) starts.push({ t, f })
  })
  const ends: Array<{ t: number; last: Uint8Array; next: Uint8Array | null }> = []
  tailWin.forEach((f, i) => {
    const t = r3(tailAt + (i + 1) * dt)
    if (t >= b.eLo - 1e-6 && t <= b.eHi + dt / 2 + 1e-6) ends.push({ t: Math.min(t, r3(b.eHi)), last: f, next: tailWin[i + 1] ?? null })
  })
  if (!starts.length || !ends.length) return null

  const steps: number[] = []
  for (const win of [headWin, tailWin]) for (let i = 1; i < win.length; i++) steps.push(frameDiff(win[i], win[i - 1]))
  // A normal step is measured on frames that actually move. Held frames (≤ the encoder's
  // own hold threshold) would drag the median to ~0 on meme-style clips and make every
  // ordinary seam look like a hard jump — Mummy's original loop was one normal step.
  const moving = steps.filter(x => x > HOLD_MEAN)
  const typical = b.typical ?? median(moving.length ? moving : steps)

  type Pair = { s: number; e: number; cost: number; si: number }
  const pairs: Pair[] = []
  const grow = (e: number, s0: number): number => asked ? (e - asked.end) + (asked.start - s0) : 0
  starts.forEach((st, si) => {
    for (const en of ends) {
      if (b.sameCut && en.t - st.t < b.minLen - 1e-6) continue
      if (b.before && en.t > st.t - 0.1) continue
      if (b.maxGrow != null && grow(en.t, st.t) > b.maxGrow + 1e-6) continue
      // Without a next frame the direction of the jump can't be checked, so the
      // fallback is kept cautious: at best "smooth", never "seamless" on its own.
      const cost = en.next
        ? frameDiff(en.next, st.f)
        : Math.max(0, frameDiff(en.last, st.f) - typical) + 0.6 * Math.max(typical, 0.75)
      pairs.push({ s: st.t, e: en.t, cost, si })
    }
  })
  if (!pairs.length) return null

  // Choose by what the eye can tell apart: the best verdict level on offer, and within
  // it the longest loop (more clip) or the smallest move (a cut stays put). Raw-cost
  // ties trimmed seamless loops shorter for nothing.
  const rank = (c: number): number => RANK[seamVerdict(c, typical)]
  const top = Math.min(...pairs.map(p => rank(p.cost)))
  const moved = (p: Pair): number => asked ? Math.abs(p.e - asked.end) + Math.abs(p.s - asked.start) : 0
  const score = (p: Pair): number => (b.prefer === 'closest' ? -moved(p) : p.e - p.s)
  // A level spans a wide range of costs (a "jump" is 2.5–6 steps), so 'closest' first
  // keeps only joins near the best cost in it — or it would trade 5.9 for 10.6 just to
  // move the cut less.
  const topCosts = pairs.filter(p => rank(p.cost) === top)
  const minTop = Math.min(...topCosts.map(p => p.cost))
  const best = topCosts
    .filter(p => b.prefer !== 'closest' || p.cost <= minTop * 1.25 + 0.1)
    .reduce((x, y) => {
      const sx = score(x), sy = score(y)
      return sy > sx + 1e-6 || (Math.abs(sy - sx) <= 1e-6 && y.cost < x.cost) ? y : x
    })

  let current: number | null = null
  if (asked) {
    const near = pairs.reduce((x, y) =>
      Math.abs(y.s - asked.start) + Math.abs(y.e - asked.end) < Math.abs(x.s - asked.start) + Math.abs(x.e - asked.end) ? y : x)
    // 1.5 frames: an end at the clip's last frame sits just off the probe's grid.
    if (Math.abs(near.s - asked.start) <= 1.5 * dt && Math.abs(near.e - asked.end) <= 1.5 * dt) current = near.cost
  }
  const curve = pairs.filter(p => p.si === best.si).map(p => ({ t: p.e, cost: p.cost }))
  // Trimming only earns its keep when it moves the seam to a visibly better level.
  if (asked && current != null && rank(current) <= top) {
    const v = seamVerdict(current, typical)
    return { start: asked.start, end: asked.end, changed: false, cost: current, current, typical, verdict: v, currentVerdict: v, curve }
  }
  return {
    start: best.s,
    end: best.e,
    changed: true,
    cost: best.cost,
    current,
    typical,
    verdict: seamVerdict(best.cost, typical),
    currentVerdict: current == null ? null : seamVerdict(current, typical),
    curve,
  }
}
