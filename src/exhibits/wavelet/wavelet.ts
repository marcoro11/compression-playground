/**
 * Discrete wavelet transforms, DOM-free, for the wavelet exhibit and its checks.
 *
 * Every transform here is written in *lifting* form (Sweldens, 1996): the
 * signal is split into even and odd samples in place, odd samples are replaced
 * by how badly their even neighbours predict them, and even samples are nudged
 * by their new odd neighbours so the low band keeps the running average. Each
 * step only adds a function of the *other* half, so undoing it is subtracting
 * the same thing — which is why the integer 5/3 version is exactly reversible
 * even though it rounds at every step.
 *
 * Kinds:
 *  - 'haar'   orthonormal Haar: s = (a+b)/√2, d = (a−b)/√2.
 *  - 'cdf53'  LeGall / CDF 5/3. With `int` it is JPEG 2000's reversible
 *             transform (ITU T.800 Annex F, eqs. F-5/F-6); without, the same
 *             filter in exact arithmetic (linear, used for the lossy view).
 *  - 'cdf97'  CDF 9/7, JPEG 2000's irreversible transform, float.
 *
 * Edges use whole-sample symmetric extension: x[−1] = x[1], x[N] = x[N−2].
 *
 * Layout after one 1-D pass: [low half | high half], low half first, length
 * ⌈N/2⌉ — the even samples. 2-D is separable (every row, then every column,
 * of the current LL region) and recursive on LL: the Mallat layout.
 */

export type Kind = 'haar' | 'cdf53' | 'cdf97'

/** Whole-sample symmetric extension of an index into [0, n). */
export function mirror(p: number, n: number): number {
  if (n === 1) return 0
  const period = 2 * n - 2
  p = ((p % period) + period) % period
  return p < n ? p : period - p
}

// CDF 9/7 lifting constants (Daubechies & Sweldens 1998; T.800 Table F.4).
const A97 = -1.586134342059924
const B97 = -0.052980118572961
const G97 = 0.882911075530934
const D97 = 0.443506852043971
const K97 = 1.230174104914001

/** One lifting pass over positions of one parity: y[i] += c·(y[i−1] + y[i+1]). */
function liftLinear(y: Float64Array, n: number, parity: 0 | 1, c: number) {
  for (let i = parity; i < n; i += 2) y[i] += c * (y[mirror(i - 1, n)] + y[mirror(i + 1, n)])
}

/**
 * Forward 1-D transform of `x` (length n). Returns [s… | d…].
 * `int` only applies to 'cdf53' (the reversible integer transform).
 */
export function forward1d(x: ArrayLike<number>, kind: Kind, int = false): Float64Array {
  const n = x.length
  const y = Float64Array.from(x as ArrayLike<number>)
  if (n < 2) return y
  if (kind === 'haar') {
    const out = new Float64Array(n)
    const h = Math.ceil(n / 2)
    for (let k = 0; k < Math.floor(n / 2); k++) {
      const a = y[2 * k]
      const b = y[2 * k + 1]
      out[k] = (a + b) / Math.SQRT2
      out[h + k] = (a - b) / Math.SQRT2
    }
    if (n & 1) out[h - 1] = y[n - 1]
    return out
  }
  if (kind === 'cdf53') {
    if (int) {
      for (let i = 1; i < n; i += 2) y[i] -= Math.floor((y[i - 1] + y[mirror(i + 1, n)]) / 2)
      for (let i = 0; i < n; i += 2) y[i] += Math.floor((y[mirror(i - 1, n)] + y[mirror(i + 1, n)] + 2) / 4)
    } else {
      liftLinear(y, n, 1, -0.5)
      liftLinear(y, n, 0, 0.25)
    }
  } else {
    liftLinear(y, n, 1, A97)
    liftLinear(y, n, 0, B97)
    liftLinear(y, n, 1, G97)
    liftLinear(y, n, 0, D97)
    for (let i = 0; i < n; i++) y[i] = i & 1 ? y[i] * (K97 / 2) : y[i] / K97
  }
  return deinterleave(y)
}

/** Inverse of `forward1d`. */
export function inverse1d(c: ArrayLike<number>, kind: Kind, int = false): Float64Array {
  const n = c.length
  if (n < 2) return Float64Array.from(c as ArrayLike<number>)
  if (kind === 'haar') {
    const out = new Float64Array(n)
    const h = Math.ceil(n / 2)
    for (let k = 0; k < Math.floor(n / 2); k++) {
      const s = c[k]
      const d = c[h + k]
      out[2 * k] = (s + d) / Math.SQRT2
      out[2 * k + 1] = (s - d) / Math.SQRT2
    }
    if (n & 1) out[n - 1] = c[h - 1]
    return out
  }
  const y = interleave(c)
  if (kind === 'cdf53') {
    if (int) {
      for (let i = 0; i < n; i += 2) y[i] -= Math.floor((y[mirror(i - 1, n)] + y[mirror(i + 1, n)] + 2) / 4)
      for (let i = 1; i < n; i += 2) y[i] += Math.floor((y[i - 1] + y[mirror(i + 1, n)]) / 2)
    } else {
      liftLinear(y, n, 0, -0.25)
      liftLinear(y, n, 1, 0.5)
    }
  } else {
    for (let i = 0; i < n; i++) y[i] = i & 1 ? y[i] / (K97 / 2) : y[i] * K97
    liftLinear(y, n, 0, -D97)
    liftLinear(y, n, 1, -G97)
    liftLinear(y, n, 0, -B97)
    liftLinear(y, n, 1, -A97)
  }
  return y
}

function deinterleave(y: Float64Array): Float64Array {
  const n = y.length
  const h = Math.ceil(n / 2)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i & 1 ? h + (i >> 1) : i >> 1] = y[i]
  return out
}

function interleave(c: ArrayLike<number>): Float64Array {
  const n = c.length
  const h = Math.ceil(n / 2)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) y[i] = i & 1 ? c[h + (i >> 1)] : c[i >> 1]
  return y
}

// ---------------------------------------------------------------- 1-D traces

/** One step of the 5/3 lifting trace, for the step-through. */
export interface LiftStep {
  phase: 'start' | 'predict' | 'update' | 'split' | 'undo-update' | 'undo-predict'
  /** The interleaved working array after this step (or [s|d] after 'split'). */
  y: number[]
  /** Index written by this step (interleaved), −1 if none / whole pass. */
  at: number
  /** The two neighbour indices it read, already mirrored. */
  from: [number, number]
  /** Indices a mirrored read actually requested (outside 0…n−1), for showing the extension. */
  ghost: number[]
  /** Value before the step at `at`, and the correction added. */
  before: number
  delta: number
}

/** The reversible 5/3 transform of a short signal, one write per step, then the inverse in two passes. */
export function trace53(x: number[]): LiftStep[] {
  const n = x.length
  const y = x.slice()
  const steps: LiftStep[] = [{ phase: 'start', y: y.slice(), at: -1, from: [-1, -1], ghost: [], before: 0, delta: 0 }]
  if (n < 2) return steps
  for (let i = 1; i < n; i += 2) {
    const r = i + 1
    const delta = -Math.floor((y[i - 1] + y[mirror(r, n)]) / 2)
    const before = y[i]
    y[i] += delta
    steps.push({ phase: 'predict', y: y.slice(), at: i, from: [i - 1, mirror(r, n)], ghost: r >= n ? [r] : [], before, delta })
  }
  for (let i = 0; i < n; i += 2) {
    const l = i - 1
    const r = i + 1
    const delta = Math.floor((y[mirror(l, n)] + y[mirror(r, n)] + 2) / 4)
    const before = y[i]
    y[i] += delta
    steps.push({ phase: 'update', y: y.slice(), at: i, from: [mirror(l, n), mirror(r, n)], ghost: [l, r].filter((p) => p < 0 || p >= n), before, delta })
  }
  steps.push({ phase: 'split', y: Array.from(deinterleave(Float64Array.from(y))), at: -1, from: [-1, -1], ghost: [], before: 0, delta: 0 })
  const z = y.slice()
  for (let i = 0; i < n; i += 2) z[i] -= Math.floor((z[mirror(i - 1, n)] + z[mirror(i + 1, n)] + 2) / 4)
  steps.push({ phase: 'undo-update', y: z.slice(), at: -1, from: [-1, -1], ghost: [], before: 0, delta: 0 })
  for (let i = 1; i < n; i += 2) z[i] += Math.floor((z[i - 1] + z[mirror(i + 1, n)]) / 2)
  steps.push({ phase: 'undo-predict', y: z.slice(), at: -1, from: [-1, -1], ghost: [], before: 0, delta: 0 })
  return steps
}

/** Haar by averages and half-differences, one pair per step, recursing on the averages. */
export interface HaarStep {
  /** The level's input: the whole array as it stood when this level began. */
  src: number[]
  /** The array after this step. Inside the level's span, only `filled` positions are meaningful. */
  y: number[]
  filled: boolean[]
  /** Length of the region being transformed at this level (the rest is earlier detail). */
  span: number
  /** Pair index within the level (−1 for the start state). */
  pair: number
  level: number
}

export function traceHaar(x: number[]): HaarStep[] {
  const n = x.length
  const steps: HaarStep[] = [{ src: x.slice(), y: x.slice(), filled: x.map(() => true), span: n, pair: -1, level: 0 }]
  let cur = x.slice()
  let span = n
  let level = 1
  while (span >= 2) {
    const half = span >> 1
    const src = cur.slice()
    const y = cur.slice()
    const filled = cur.map((_, i) => i >= span)
    for (let k = 0; k < half; k++) {
      const a = src[2 * k]
      const b = src[2 * k + 1]
      y[k] = (a + b) / 2
      y[half + k] = (a - b) / 2
      filled[k] = filled[half + k] = true
      steps.push({ src, y: y.slice(), filled: filled.slice(), span, pair: k, level })
    }
    cur = y
    span = half
    level++
  }
  return steps
}

// ------------------------------------------------------------------- 2-D

export type Orient = 'LL' | 'HL' | 'LH' | 'HH'

export interface Band {
  level: number
  orient: Orient
  x: number
  y: number
  w: number
  h: number
}

/** Subband rectangles of a `levels`-level decomposition, coarsest LL first. */
export function bands(w: number, h: number, levels: number): Band[] {
  const out: Band[] = []
  let cw = w
  let ch = h
  const detail: Band[] = []
  for (let l = 1; l <= levels; l++) {
    const lw = Math.ceil(cw / 2)
    const lh = Math.ceil(ch / 2)
    detail.push({ level: l, orient: 'HL', x: lw, y: 0, w: cw - lw, h: lh })
    detail.push({ level: l, orient: 'LH', x: 0, y: lh, w: lw, h: ch - lh })
    detail.push({ level: l, orient: 'HH', x: lw, y: lh, w: cw - lw, h: ch - lh })
    cw = lw
    ch = lh
  }
  out.push({ level: levels, orient: 'LL', x: 0, y: 0, w: cw, h: ch })
  return out.concat(detail.reverse())
}

/** Regions of an in-progress decomposition: what is still "picture" and what is detail. */
export interface PassState {
  data: Float64Array
  /** Rectangles that hold low-pass (picture-like) content. */
  low: { x: number; y: number; w: number; h: number }[]
  /** Rectangles that hold detail coefficients. */
  high: { x: number; y: number; w: number; h: number; label: string }[]
  level: number
  pass: 'start' | 'rows' | 'cols'
}

/**
 * Forward 2-D transform. With `trace`, also returns the state after every
 * pass (rows of level 1, columns of level 1, rows of level 2, …).
 */
export function forward2d(img: ArrayLike<number>, w: number, h: number, levels: number, kind: Kind, int = false, trace = false): { coefs: Float64Array; passes: PassState[] } {
  const a = Float64Array.from(img as ArrayLike<number>)
  const passes: PassState[] = []
  const high: PassState['high'] = []
  if (trace) passes.push({ data: a.slice(), low: [{ x: 0, y: 0, w, h }], high: [], level: 0, pass: 'start' })
  let cw = w
  let ch = h
  const row = new Float64Array(Math.max(w, h))
  for (let l = 1; l <= levels && (cw > 1 || ch > 1); l++) {
    if (cw > 1)
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) row[x] = a[y * w + x]
        const t = forward1d(row.subarray(0, cw), kind, int)
        for (let x = 0; x < cw; x++) a[y * w + x] = t[x]
      }
    const lw = Math.ceil(cw / 2)
    const lh = Math.ceil(ch / 2)
    if (trace)
      passes.push({
        data: a.slice(),
        low: [{ x: 0, y: 0, w: lw, h: ch }],
        high: [...high, { x: lw, y: 0, w: cw - lw, h: ch, label: `H${l}` }],
        level: l,
        pass: 'rows',
      })
    if (ch > 1)
      for (let x = 0; x < cw; x++) {
        for (let y = 0; y < ch; y++) row[y] = a[y * w + x]
        const t = forward1d(row.subarray(0, ch), kind, int)
        for (let y = 0; y < ch; y++) a[y * w + x] = t[y]
      }
    high.push({ x: lw, y: 0, w: cw - lw, h: lh, label: `HL${l}` })
    high.push({ x: 0, y: lh, w: lw, h: ch - lh, label: `LH${l}` })
    high.push({ x: lw, y: lh, w: cw - lw, h: ch - lh, label: `HH${l}` })
    if (trace) passes.push({ data: a.slice(), low: [{ x: 0, y: 0, w: lw, h: lh }], high: high.slice(), level: l, pass: 'cols' })
    cw = lw
    ch = lh
  }
  return { coefs: a, passes }
}

/** Inverse of `forward2d` (same `levels`, `kind`, `int`). */
export function inverse2d(coefs: ArrayLike<number>, w: number, h: number, levels: number, kind: Kind, int = false): Float64Array {
  const a = Float64Array.from(coefs as ArrayLike<number>)
  const sizes: [number, number][] = []
  let cw = w
  let ch = h
  for (let l = 1; l <= levels && (cw > 1 || ch > 1); l++) {
    sizes.push([cw, ch])
    cw = Math.ceil(cw / 2)
    ch = Math.ceil(ch / 2)
  }
  const row = new Float64Array(Math.max(w, h))
  for (let k = sizes.length - 1; k >= 0; k--) {
    const [sw, sh] = sizes[k]
    if (sh > 1)
      for (let x = 0; x < sw; x++) {
        for (let y = 0; y < sh; y++) row[y] = a[y * w + x]
        const t = inverse1d(row.subarray(0, sh), kind, int)
        for (let y = 0; y < sh; y++) a[y * w + x] = t[y]
      }
    if (sw > 1)
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) row[x] = a[y * w + x]
        const t = inverse1d(row.subarray(0, sw), kind, int)
        for (let x = 0; x < sw; x++) a[y * w + x] = t[x]
      }
  }
  return a
}

/**
 * The L2 norm of each band's synthesis basis function: put a unit coefficient
 * in the middle of the band, invert, measure. For an orthonormal transform
 * every norm is 1; for 5/3 and 9/7 they are not, and a quantizer has to scale
 * its step per band by them (JPEG 2000 does exactly this) or it will spend
 * bits where the eye — and the MSE — cannot see them.
 */
export function bandNorms(w: number, h: number, levels: number, kind: Kind): number[] {
  return bands(w, h, levels).map((b) => {
    const c = new Float64Array(w * h)
    c[(b.y + (b.h >> 1)) * w + b.x + (b.w >> 1)] = 1
    const r = inverse2d(c, w, h, levels, kind, false)
    let e = 0
    for (let i = 0; i < r.length; i++) e += r[i] * r[i]
    return Math.sqrt(e)
  })
}

// ------------------------------------------------------- quantize & cost

/** Dead-zone scalar quantizer (T.800 Annex E): q = sign·⌊|c|/Δ⌋, rebuilt at the middle of its interval. */
export const dzQuant = (c: number, step: number): number => Math.sign(c) * Math.floor(Math.abs(c) / step)
export const dzDequant = (q: number, step: number): number => (q === 0 ? 0 : Math.sign(q) * (Math.abs(q) + 0.5) * step)

/** Order-0 entropy, in bits, of a list of integers (total, not per symbol). */
export function entropyBits(values: Iterable<number>): number {
  const m = new Map<number, number>()
  let n = 0
  for (const v of values) {
    m.set(v, (m.get(v) ?? 0) + 1)
    n++
  }
  let bits = 0
  for (const c of m.values()) bits -= c * Math.log2(c / n)
  return bits
}

export interface Coded {
  /** Rebuilt coefficients. */
  recon: Float64Array
  /** Estimated bits per band, in `bands()` order. */
  bandBits: number[]
  bits: number
  nonzero: number
}

/**
 * Quantize every band with step Δ / norm(band), estimate its size as the
 * order-0 entropy of its quantized values (each band its own context — the
 * least an adaptive coder would manage), and rebuild.
 */
export function codeWavelet(coefs: Float64Array, w: number, h: number, levels: number, norms: number[], step: number): Coded {
  const bs = bands(w, h, levels)
  const recon = new Float64Array(coefs.length)
  const bandBits: number[] = []
  let nonzero = 0
  bs.forEach((b, k) => {
    const s = step / norms[k]
    const qs: number[] = []
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * w + x
        const q = dzQuant(coefs[i], s)
        if (q) nonzero++
        qs.push(q)
        recon[i] = dzDequant(q, s)
      }
    bandBits.push(entropyBits(qs))
  })
  return { recon, bandBits, bits: bandBits.reduce((a, b) => a + b, 0), nonzero }
}

/** Entropy of the exact integer coefficients, per band: the lossless size estimate. */
export function losslessBits(coefs: Float64Array, w: number, h: number, levels: number): number[] {
  return bands(w, h, levels).map((b) => {
    const vs: number[] = []
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) vs.push(coefs[y * w + x])
    return entropyBits(vs)
  })
}

/** PSNR of a reconstruction after the decoder's clamp-and-round, in dB (∞ if exact). */
export function psnr(orig: ArrayLike<number>, rec: ArrayLike<number>): number {
  let se = 0
  for (let i = 0; i < orig.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(rec[i])))
    se += (v - orig[i]) ** 2
  }
  if (se === 0) return Infinity
  return 10 * Math.log10((255 * 255) / (se / orig.length))
}
