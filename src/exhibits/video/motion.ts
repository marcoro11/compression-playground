/**
 * Block motion estimation: for one block of the current frame, find the
 * displacement into the reference frame whose pixels match best.
 *
 * Vectors are in HALF-PEL units throughout (mv = 2 → one whole pixel), so the
 * half-pel refinement does not need a second representation. With half-pel off,
 * every vector is simply even.
 *
 * Reference pixels outside the frame are taken from the nearest edge
 * ("unrestricted motion vectors", as H.263 onwards allow) so a block at the
 * border can still point half outside.
 *
 * Cost is SAD — the sum of absolute differences — which is what real encoders
 * use for the integer search because it needs no multiplications.
 */

export type Method = 'full' | 'tss' | 'diamond'

export interface Probe {
  /** Candidate vector, half-pel units. */
  mx: number
  my: number
  sad: number
  /** Which step of the search evaluated it (0-based). */
  step: number
}

export interface SearchStep {
  /** What this step is, in a few words: "row dy = −3", "step size 4", "large diamond around (2, 0)". */
  label: string
  probes: Probe[]
  /** Best vector after this step (half-pel units). */
  best: { mx: number; my: number; sad: number }
}

export interface SearchResult {
  mx: number
  my: number
  sad: number
  /** Distinct candidate positions evaluated (the cost of the search). */
  evaluated: number
  steps: SearchStep[]
}

export interface Frame {
  data: ArrayLike<number>
  w: number
  h: number
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Reference pixel at integer coordinates with edge extension. */
export function px(f: Frame, x: number, y: number): number {
  return f.data[clampi(y, 0, f.h - 1) * f.w + clampi(x, 0, f.w - 1)]
}

/**
 * Pixel of the motion-compensated prediction at block offset (x, y) for vector
 * (mx, my) in half-pel units. Half positions average the two (or four)
 * neighbours with rounding, exactly as MPEG-2 does: (a + b + 1) >> 1 and
 * (a + b + c + d + 2) >> 2.
 */
export function predPixel(ref: Frame, x: number, y: number, mx: number, my: number): number {
  const ix = x + (mx >> 1)
  const iy = y + (my >> 1)
  const hx = mx & 1
  const hy = my & 1
  if (!hx && !hy) return px(ref, ix, iy)
  if (hx && !hy) return (px(ref, ix, iy) + px(ref, ix + 1, iy) + 1) >> 1
  if (!hx && hy) return (px(ref, ix, iy) + px(ref, ix, iy + 1) + 1) >> 1
  return (px(ref, ix, iy) + px(ref, ix + 1, iy) + px(ref, ix, iy + 1) + px(ref, ix + 1, iy + 1) + 2) >> 2
}

/** The whole predicted block, row-major bs×bs. */
export function predictBlock(ref: Frame, x0: number, y0: number, bs: number, mx: number, my: number): Int16Array {
  const out = new Int16Array(bs * bs)
  for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) out[y * bs + x] = predPixel(ref, x0 + x, y0 + y, mx, my)
  return out
}

/**
 * SAD between the current block at (x0, y0) and the prediction for (mx, my).
 * Stops early, returning a value > `limit`, as soon as the running sum exceeds
 * it — a candidate that is already worse than the best cannot win. Stopping only
 * on *strictly* greater keeps ties fully evaluated, so tie-breaking (and so the
 * result) is identical with or without the shortcut.
 */
export function sad(cur: Frame, ref: Frame, x0: number, y0: number, bs: number, mx: number, my: number, limit = Infinity): number {
  let s = 0
  const intPel = !(mx & 1) && !(my & 1)
  const dx = mx >> 1
  const dy = my >> 1
  const rx = x0 + dx
  const ry = y0 + dy
  if (intPel && rx >= 0 && ry >= 0 && rx + bs <= ref.w && ry + bs <= ref.h) {
    // Whole-pixel vector entirely inside the frame: straight indexing, no clamping.
    const c = cur.data
    const r = ref.data
    for (let y = 0; y < bs; y++) {
      let ci = (y0 + y) * cur.w + x0
      let ri = (ry + y) * ref.w + rx
      for (let x = 0; x < bs; x++, ci++, ri++) {
        const d = c[ci] - r[ri]
        s += d < 0 ? -d : d
      }
      if (s > limit) return s
    }
    return s
  }
  for (let y = 0; y < bs; y++) {
    const cy = y0 + y
    for (let x = 0; x < bs; x++) {
      const c = cur.data[cy * cur.w + x0 + x]
      const p = intPel ? px(ref, x0 + x + dx, cy + dy) : predPixel(ref, x0 + x, cy, mx, my)
      s += c > p ? c - p : p - c
    }
    if (s > limit) return s
  }
  return s
}

/** Prefer the lower SAD; on a tie, the shorter vector (cheaper to send); then a fixed order. */
function better(a: { mx: number; my: number; sad: number }, b: { mx: number; my: number; sad: number }): boolean {
  if (a.sad !== b.sad) return a.sad < b.sad
  const la = Math.abs(a.mx) + Math.abs(a.my)
  const lb = Math.abs(b.mx) + Math.abs(b.my)
  if (la !== lb) return la < lb
  return a.my !== b.my ? a.my < b.my : a.mx < b.mx
}

export interface SearchOptions {
  method: Method
  /** Search range in whole pixels: vectors stay within ±range. */
  range: number
  halfPel: boolean
  /** Record every probe (slower: disables early termination for the probes' SADs). */
  trace?: boolean
}

/**
 * Find the vector for the block at (x0, y0). Integer search by the chosen
 * method, then (optionally) the eight half-pel positions around the winner.
 */
export function search(cur: Frame, ref: Frame, x0: number, y0: number, bs: number, opt: SearchOptions): SearchResult {
  const R = opt.range
  const seen = new Map<number, number>()
  const steps: SearchStep[] = []
  let best = { mx: 0, my: 0, sad: Infinity }
  let evaluated = 0

  /** Evaluate an integer candidate (dx, dy) in whole pixels. */
  const evalInt = (dx: number, dy: number, step: number, probes: Probe[]) => {
    if (Math.abs(dx) > R || Math.abs(dy) > R) return
    const key = (dy + 64) * 256 + dx + 64
    let s = seen.get(key)
    if (s === undefined) {
      s = sad(cur, ref, x0, y0, bs, 2 * dx, 2 * dy, opt.trace ? Infinity : best.sad)
      seen.set(key, s)
      evaluated++
    }
    const cand = { mx: 2 * dx, my: 2 * dy, sad: s }
    if (opt.trace) probes.push({ ...cand, step })
    if (better(cand, best)) best = cand
  }

  const pushStep = (label: string, probes: Probe[]) => steps.push({ label, probes, best: { ...best } })

  if (opt.method === 'full') {
    // Zero first, so it holds the lead on ties; then every row of the window.
    evalInt(0, 0, 0, [])
    for (let dy = -R; dy <= R; dy++) {
      const probes: Probe[] = []
      for (let dx = -R; dx <= R; dx++) evalInt(dx, dy, steps.length, probes)
      pushStep(`row dy = ${dy > 0 ? '+' : ''}${dy}`, probes)
    }
  } else if (opt.method === 'tss') {
    // Three-step search (Koga et al., 1981): 9 points at a step size that halves each round.
    let S = 1
    while (S * 2 <= R) S *= 2
    let cx = 0
    let cy = 0
    {
      const probes: Probe[] = []
      evalInt(0, 0, 0, probes)
      for (const [ox, oy] of NEIGHBOURS) evalInt(cx + ox * S, cy + oy * S, 0, probes)
      pushStep(`step size ${S}`, probes)
      cx = best.mx / 2
      cy = best.my / 2
    }
    for (S = S / 2; S >= 1; S /= 2) {
      const probes: Probe[] = []
      evalInt(cx, cy, steps.length, probes)
      for (const [ox, oy] of NEIGHBOURS) evalInt(cx + ox * S, cy + oy * S, steps.length, probes)
      pushStep(`step size ${S} around (${cx}, ${cy})`, probes)
      cx = best.mx / 2
      cy = best.my / 2
    }
  } else {
    // Diamond search (Zhu & Ma, 2000): walk a large diamond until its centre wins, then one small diamond.
    let cx = 0
    let cy = 0
    for (let iter = 0; iter < 2 * R + 2; iter++) {
      const probes: Probe[] = []
      evalInt(cx, cy, steps.length, probes)
      for (const [ox, oy] of LARGE_DIAMOND) evalInt(cx + ox, cy + oy, steps.length, probes)
      pushStep(`large diamond around (${cx}, ${cy})`, probes)
      const nx = best.mx / 2
      const ny = best.my / 2
      if (nx === cx && ny === cy) break
      cx = nx
      cy = ny
    }
    const probes: Probe[] = []
    evalInt(cx, cy, steps.length, probes)
    for (const [ox, oy] of SMALL_DIAMOND) evalInt(cx + ox, cy + oy, steps.length, probes)
    pushStep(`small diamond around (${cx}, ${cy})`, probes)
  }

  if (opt.halfPel) {
    const probes: Probe[] = []
    const bx = best.mx
    const by = best.my
    const step = steps.length
    for (const [ox, oy] of NEIGHBOURS) {
      const mx = bx + ox
      const my = by + oy
      if (Math.abs(mx) > 2 * R || Math.abs(my) > 2 * R) continue
      const s = sad(cur, ref, x0, y0, bs, mx, my, opt.trace ? Infinity : best.sad)
      evaluated++
      const cand = { mx, my, sad: s }
      if (opt.trace) probes.push({ ...cand, step })
      if (better(cand, best)) best = cand
    }
    pushStep(`half-pel around (${fmtHalf(bx)}, ${fmtHalf(by)})`, probes)
  }

  return { mx: best.mx, my: best.my, sad: best.sad, evaluated, steps }
}

const NEIGHBOURS: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]
const LARGE_DIAMOND: [number, number][] = [
  [0, -2],
  [-1, -1],
  [1, -1],
  [-2, 0],
  [2, 0],
  [-1, 1],
  [1, 1],
  [0, 2],
]
const SMALL_DIAMOND: [number, number][] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
]

/** A half-pel quantity as pixels: 3 → "1.5", −2 → "−1". */
export function fmtHalf(v: number): string {
  const s = v / 2
  const t = Number.isInteger(s) ? String(Math.abs(s)) : Math.abs(s).toFixed(1)
  return (s < 0 ? '−' : '') + t
}
