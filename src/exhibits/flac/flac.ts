/**
 * A FLAC-shaped lossless audio coder, small enough to read.
 *
 * Per block of samples, try every way of predicting each sample from the ones
 * before it, keep only the prediction error (the residual), and write the
 * residual with partitioned Rice codes. The pieces are FLAC's:
 *
 *  - CONSTANT and VERBATIM subframes for silence and for noise.
 *  - FIXED predictors of order 0–4: the polynomial extrapolations
 *      0: 0      1: x₋₁      2: 2x₋₁ − x₋₂      3: 3x₋₁ − 3x₋₂ + x₋₃
 *      4: 4x₋₁ − 6x₋₂ + 4x₋₃ − x₋₄
 *    i.e. the residual is the order-th finite difference of the signal.
 *  - LPC of order 1–12: autocorrelation of a Tukey-windowed block, Levinson–
 *    Durbin for the coefficients, then quantisation to `precision`-bit integers
 *    with a right shift, exactly as libFLAC does — so the decoder reproduces
 *    the prediction bit for bit with integer arithmetic.
 *  - Rice coding of the zigzag-folded residual, split into 2^po partitions,
 *    each with its own parameter k. The cost is convex in k, so the encoder
 *    starts from log₂(mean) and walks downhill to the exact optimum.
 *
 * The container is this site's own (FLAC's frame headers, CRCs, stereo
 * decorrelation and escape codes are left out) and is documented on
 * `encodeStream`. Every bit count the page shows is the length of this real
 * stream, and verify decodes it back bit-exactly.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { seeded } from '../../lib/samples'

export const RATE = 16000
export const MAX_RICE = 14
export const MAX_LPC = 12

// ------------------------------------------------------------------- signals

export type SignalId = 'chord' | 'pluck' | 'voice' | 'drums' | 'saw' | 'noise'

export const SIGNALS: { id: SignalId; label: string; note: string }[] = [
  { id: 'chord', label: 'Chord', note: 'three sines — as predictable as audio gets' },
  { id: 'pluck', label: 'Plucked string', note: 'Karplus–Strong: noise that turns into a tone' },
  { id: 'voice', label: 'Voice-ish', note: 'a buzz through vowel formants' },
  { id: 'drums', label: 'Drums', note: 'kick, snare and hats: transients' },
  { id: 'saw', label: 'Sawtooth', note: 'smooth ramps, then a cliff every period' },
  { id: 'noise', label: 'White noise', note: 'nothing to predict' },
]

const clip16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)))

export function synth(id: SignalId, seconds = 1.5): Int32Array {
  const n = Math.round(RATE * seconds)
  const out = new Int32Array(n)
  const rnd = seeded(id.length * 7919 + 17)
  const TAU = 2 * Math.PI
  if (id === 'chord') {
    const f = [220, 277.18, 329.63]
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const env = Math.min(1, t / 0.02) * Math.exp(-t * 0.9)
      let v = 0
      for (const fr of f) v += Math.sin(TAU * fr * t) + 0.3 * Math.sin(TAU * 2 * fr * t) + 0.1 * Math.sin(TAU * 3 * fr * t)
      out[i] = clip16(v * 6500 * env)
    }
  } else if (id === 'pluck') {
    const notes = [196, 246.94, 293.66, 392]
    const per = Math.floor(n / notes.length)
    for (let k = 0; k < notes.length; k++) {
      const L = Math.round(RATE / notes[k])
      const buf = new Float64Array(L)
      for (let j = 0; j < L; j++) buf[j] = rnd() * 2 - 1
      let p = 0
      for (let i = 0; i < per; i++) {
        const next = (p + 1) % L
        const v = buf[p]
        buf[p] = 0.996 * 0.5 * (buf[p] + buf[next])
        p = next
        out[k * per + i] = clip16(v * 14000)
      }
    }
  } else if (id === 'voice') {
    // Glottal pulses through three two-pole resonators, gliding a → i → u.
    const vowels = [
      [730, 1090, 2440],
      [270, 2290, 3010],
      [300, 870, 2240],
    ]
    const ys = [0, 0, 0].map(() => [0, 0])
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const f0 = 120 + 18 * Math.sin(TAU * 0.7 * t) + 6 * Math.sin(TAU * 5.5 * t)
      phase += f0 / RATE
      if (phase >= 1) phase -= 1
      // Rosenberg-like pulse: open for 40% of the period.
      const src = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) ** 2 - 0.25 : -0.25
      const pos = (t / seconds) * (vowels.length - 1)
      const a = Math.min(vowels.length - 2, Math.floor(pos))
      const w = pos - a
      let x = src
      let acc = 0
      for (let r = 0; r < 3; r++) {
        const fr = vowels[a][r] * (1 - w) + vowels[a + 1][r] * w
        const bw = 80 + 40 * r
        const rad = Math.exp((-Math.PI * bw) / RATE)
        const c1 = 2 * rad * Math.cos((TAU * fr) / RATE)
        const c2 = -rad * rad
        const y = x * (1 - rad) + c1 * ys[r][0] + c2 * ys[r][1]
        ys[r][1] = ys[r][0]
        ys[r][0] = y
        acc += y / (r + 1)
        x = src
      }
      const env = Math.min(1, t / 0.05) * Math.min(1, (seconds - t) / 0.08)
      out[i] = clip16(acc * 9000 * env)
    }
  } else if (id === 'drums') {
    const beat = 0.375
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const b = Math.floor(t / beat)
      const tb = t - b * beat
      let v = 0
      if (b % 2 === 0) {
        // kick: a falling sine
        const f = 45 + 80 * Math.exp(-tb * 30)
        v += Math.sin(TAU * f * tb) * Math.exp(-tb * 9) * 0.9
      } else {
        // snare: tone + noise
        v += (Math.sin(TAU * 185 * tb) * 0.4 + (rnd() * 2 - 1) * 0.6) * Math.exp(-tb * 22)
      }
      const th = t % (beat / 2)
      const noise = rnd() * 2 - 1
      lp = 0.6 * lp + 0.4 * noise
      v += (noise - lp) * 0.35 * Math.exp(-th * 60)
      out[i] = clip16(v * 15000)
    }
  } else if (id === 'saw') {
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const ph = (t * 110) % 1
      out[i] = clip16((ph * 2 - 1) * 9000 * Math.min(1, t / 0.01))
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = clip16((rnd() * 2 - 1) * 8000)
  }
  return out
}

// ----------------------------------------------------------- the predictors

/** FLAC's fixed polynomial predictors, as coefficients on x₋₁ … x₋ₒ. */
export const FIXED_COEFS: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]]

/** Prediction of sample i from the previous `order` samples with the fixed predictor. */
export function fixedPredict(x: ArrayLike<number>, i: number, order: number): number {
  const c = FIXED_COEFS[order]
  let p = 0
  for (let j = 0; j < order; j++) p += c[j] * x[i - 1 - j]
  return p
}

/** Residual of samples [start+order, end) under a fixed predictor. */
export function fixedResidual(x: ArrayLike<number>, start: number, end: number, order: number): Int32Array {
  const r = new Int32Array(Math.max(0, end - start - order))
  for (let i = start + order; i < end; i++) r[i - start - order] = x[i] - fixedPredict(x, i, order)
  return r
}

/** Tukey window with taper fraction p (libFLAC's default is 0.5). */
export function tukey(n: number, p = 0.5): Float64Array {
  const w = new Float64Array(n).fill(1)
  const np = Math.floor((p / 2) * n)
  for (let i = 0; i < np; i++) {
    const v = 0.5 - 0.5 * Math.cos((Math.PI * i) / np)
    w[i] = v
    w[n - 1 - i] = v
  }
  return w
}

export function autocorr(x: ArrayLike<number>, maxLag: number): Float64Array {
  const r = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag]
    r[lag] = s
  }
  return r
}

/**
 * Levinson–Durbin recursion. Returns, for every order p = 1 … maxOrder, the
 * coefficients a₁…aₚ of the predictor x̂ₙ = Σ aⱼ xₙ₋ⱼ minimising the squared
 * error for autocorrelation r, plus that error.
 */
export function levinson(r: ArrayLike<number>, maxOrder: number): { coefs: Float64Array[]; err: Float64Array } {
  const coefs: Float64Array[] = []
  const err = new Float64Array(maxOrder + 1)
  let a = new Float64Array(0)
  let e = r[0]
  err[0] = e
  for (let p = 1; p <= maxOrder; p++) {
    if (e <= 0) {
      // Silent or degenerate block: no further improvement possible.
      const z = new Float64Array(p)
      z.set(a)
      coefs.push(z)
      a = z
      err[p] = 0
      continue
    }
    let acc = r[p]
    for (let j = 1; j < p; j++) acc -= a[j - 1] * r[p - j]
    const k = acc / e
    const next = new Float64Array(p)
    for (let j = 1; j < p; j++) next[j - 1] = a[j - 1] - k * a[p - j - 1]
    next[p - 1] = k
    e *= 1 - k * k
    err[p] = e
    coefs.push(next)
    a = next
  }
  return { coefs, err }
}

/**
 * libFLAC's coefficient quantiser: scale so the largest coefficient uses the
 * available precision, round with error feedback, clamp to precision bits.
 */
export function quantize(c: ArrayLike<number>, precision: number): { q: Int32Array; shift: number } {
  let cmax = 0
  for (let i = 0; i < c.length; i++) cmax = Math.max(cmax, Math.abs(c[i]))
  const q = new Int32Array(c.length)
  if (cmax === 0) return { q, shift: 0 }
  const log2cmax = Math.floor(Math.log2(cmax)) + 1 // frexp exponent
  let shift = precision - 1 - log2cmax
  shift = Math.max(0, Math.min(15, shift))
  const qmax = 2 ** (precision - 1) - 1
  const qmin = -(2 ** (precision - 1))
  let err = 0
  for (let i = 0; i < c.length; i++) {
    err += c[i] * 2 ** shift
    const v = Math.max(qmin, Math.min(qmax, Math.round(err)))
    q[i] = v
    err -= v
  }
  return { q, shift }
}

/** Integer LPC prediction of sample i: ⌊Σ qⱼ xᵢ₋₁₋ⱼ / 2^shift⌋ — the same in encoder and decoder. */
export function lpcPredict(x: ArrayLike<number>, i: number, q: ArrayLike<number>, shift: number): number {
  let s = 0
  for (let j = 0; j < q.length; j++) s += q[j] * x[i - 1 - j]
  return Math.floor(s / 2 ** shift)
}

export function lpcResidual(x: ArrayLike<number>, start: number, end: number, q: ArrayLike<number>, shift: number): Int32Array {
  const order = q.length
  const r = new Int32Array(Math.max(0, end - start - order))
  for (let i = start + order; i < end; i++) r[i - start - order] = x[i] - lpcPredict(x, i, q, shift)
  return r
}

// ------------------------------------------------------------------- Rice

/** Zigzag fold, as FLAC does before Rice coding: 0, −1, 1, −2 … → 0, 1, 2, 3 … */
export const fold = (e: number): number => (e >= 0 ? 2 * e : -2 * e - 1)
export const unfold = (u: number): number => (u % 2 === 0 ? u / 2 : -(u + 1) / 2)

/** Exact bits to Rice-code u[from..to) with parameter k. */
export function riceCost(u: ArrayLike<number>, from: number, to: number, k: number): number {
  let s = (to - from) * (1 + k)
  const d = 2 ** k
  for (let i = from; i < to; i++) s += Math.floor(u[i] / d)
  return s
}

/**
 * Optimal Rice parameter. cost(k+1) − cost(k) = n − Σ⌈⌊u/2ᵏ⌋/2⌉ is
 * non-decreasing in k, so the cost is convex: start at the estimate from the
 * mean and walk downhill until it stops improving.
 */
export function bestRice(u: ArrayLike<number>, from: number, to: number): { k: number; bits: number } {
  const n = to - from
  if (n <= 0) return { k: 0, bits: 0 }
  let sum = 0
  for (let i = from; i < to; i++) sum += u[i]
  const mean = sum / n
  let k = Math.max(0, Math.min(MAX_RICE, mean > 1 ? Math.floor(Math.log2(mean)) : 0))
  let bits = riceCost(u, from, to, k)
  for (;;) {
    if (k > 0) {
      const b = riceCost(u, from, to, k - 1)
      if (b < bits) {
        k--
        bits = b
        continue
      }
    }
    if (k < MAX_RICE) {
      const b = riceCost(u, from, to, k + 1)
      if (b < bits) {
        k++
        bits = b
        continue
      }
    }
    return { k, bits }
  }
}

export interface RicePlan {
  /** Partition order: 2^po partitions. */
  po: number
  ks: number[]
  /** Residual bits per partition, not counting the 4-bit parameter. */
  partBits: number[]
  /** Index into the residual array where each partition starts (and one past the end). */
  bounds: number[]
  /** Total including the 4-bit po field and 4 bits per partition. */
  bits: number
  /** Total for every partition order tried (Infinity where not allowed). */
  byOrder: number[]
}

/** Partition bounds in residual-array coordinates for a block of `len` samples and a predictor of `order`. */
export function partitionBounds(len: number, order: number, po: number): number[] | null {
  const parts = 2 ** po
  if (len % parts !== 0) return null
  const ps = len / parts
  if (ps <= order) return null
  const b = [0]
  for (let j = 1; j <= parts; j++) b.push(j * ps - order)
  return b
}

export function planRice(res: Int32Array, len: number, order: number, maxPo: number): RicePlan {
  const u = Uint32Array.from(res, fold)
  let best: RicePlan | null = null
  const byOrder: number[] = []
  for (let po = 0; po <= maxPo; po++) {
    const bounds = partitionBounds(len, order, po)
    if (!bounds) {
      byOrder.push(Infinity)
      continue
    }
    const ks: number[] = []
    const partBits: number[] = []
    let bits = 4
    for (let j = 0; j + 1 < bounds.length; j++) {
      const r = bestRice(u, bounds[j], bounds[j + 1])
      ks.push(r.k)
      partBits.push(r.bits)
      bits += 4 + r.bits
    }
    byOrder.push(bits)
    if (!best || bits < best.bits) best = { po, ks, partBits, bounds, bits, byOrder }
  }
  if (!best) throw new Error('no valid partition order')
  best.byOrder = byOrder
  return best
}

// ------------------------------------------------------------ subframes

export type Subframe =
  | { kind: 'constant'; value: number }
  | { kind: 'verbatim' }
  | { kind: 'fixed'; order: number }
  | { kind: 'lpc'; order: number; precision: number; shift: number; q: Int32Array }

export interface Candidate {
  sub: Subframe
  /** Exact bits of the subframe in the stream. */
  bits: number
  residual?: Int32Array
  plan?: RicePlan
  label: string
}

export function subLabel(s: Subframe): string {
  return s.kind === 'constant' ? 'constant' : s.kind === 'verbatim' ? 'verbatim' : s.kind === 'fixed' ? `fixed ${s.order}` : `LPC ${s.order}`
}

const KIND_BITS = 2

function predictedCandidate(x: ArrayLike<number>, start: number, end: number, bps: number, sub: Subframe & { order: number }, maxPo: number): Candidate | null {
  const len = end - start
  if (len <= sub.order) return null
  const residual = sub.kind === 'fixed' ? fixedResidual(x, start, end, sub.order) : lpcResidual(x, start, end, (sub as { q: Int32Array }).q, (sub as { shift: number }).shift)
  const plan = planRice(residual, len, sub.order, maxPo)
  let head = KIND_BITS + sub.order * bps
  if (sub.kind === 'fixed') head += 3
  else head += 5 + 4 + 5 + sub.order * (sub as { precision: number }).precision
  return { sub, bits: head + plan.bits, residual, plan, label: subLabel(sub) }
}

export interface AnalyseOptions {
  maxPo: number
  precision: number
  maxLpc: number
  /** Which predictors to consider. */
  mode: 'auto' | 'fixed' | 'lpc'
  /** Forced order for 'fixed' / 'lpc'. */
  order?: number
}

export interface BlockAnalysis {
  start: number
  end: number
  candidates: Candidate[]
  best: Candidate
}

export function lpcSubframe(x: ArrayLike<number>, start: number, end: number, order: number, precision: number, cache?: { coefs: Float64Array[] }): Subframe & { kind: 'lpc' } {
  const coefs = cache ? cache.coefs : lpcCoefs(x, start, end, order)
  const { q, shift } = quantize(coefs[order - 1], precision)
  return { kind: 'lpc', order, precision, shift, q }
}

export function lpcCoefs(x: ArrayLike<number>, start: number, end: number, maxOrder: number): Float64Array[] {
  const len = end - start
  const w = tukey(len)
  const xw = new Float64Array(len)
  for (let i = 0; i < len; i++) xw[i] = x[start + i] * w[i]
  return levinson(autocorr(xw, maxOrder), maxOrder).coefs
}

export function analyseBlock(x: ArrayLike<number>, start: number, end: number, bps: number, o: AnalyseOptions): BlockAnalysis {
  const len = end - start
  const cands: Candidate[] = []
  let constant = len > 0
  for (let i = start + 1; i < end && constant; i++) if (x[i] !== x[start]) constant = false
  if (constant && o.mode === 'auto') cands.push({ sub: { kind: 'constant', value: x[start] }, bits: KIND_BITS + bps, label: 'constant' })
  cands.push({ sub: { kind: 'verbatim' }, bits: KIND_BITS + len * bps, label: 'verbatim' })
  if (o.mode !== 'lpc') {
    const orders = o.mode === 'fixed' && o.order !== undefined ? [o.order] : [0, 1, 2, 3, 4]
    for (const ord of orders) {
      const c = predictedCandidate(x, start, end, bps, { kind: 'fixed', order: ord }, o.maxPo)
      if (c) cands.push(c)
    }
  }
  if (o.mode !== 'fixed' && o.maxLpc > 0 && len > o.maxLpc + 1) {
    const coefs = lpcCoefs(x, start, end, o.maxLpc)
    const orders = o.mode === 'lpc' && o.order !== undefined ? [o.order] : Array.from({ length: o.maxLpc }, (_, i) => i + 1)
    for (const ord of orders) {
      const sub = lpcSubframe(x, start, end, ord, o.precision, { coefs })
      const c = predictedCandidate(x, start, end, bps, sub, o.maxPo)
      if (c) cands.push(c)
    }
  }
  // In a forced mode the forced predictor wins whenever it exists; otherwise the cheapest.
  let best = cands[0]
  if (o.mode !== 'auto') {
    const forced = cands.find((c) => c.sub.kind === o.mode)
    best = forced ?? cands.find((c) => c.sub.kind === 'verbatim')!
  } else {
    for (const c of cands) if (c.bits < best.bits) best = c
  }
  return { start, end, candidates: cands, best }
}

// --------------------------------------------------------------- the stream

export interface EncodeOptions extends AnalyseOptions {
  blockSize: number
  bps: number
}

export interface EncodeResult {
  bytes: Uint8Array
  bits: number
  blocks: BlockAnalysis[]
}

/**
 * Stream layout (MSB-first):
 *
 *   32  number of samples        5  bits per sample − 1      16  block size
 *   then per block one subframe:
 *     2  kind: 0 constant, 1 verbatim, 2 fixed, 3 LPC
 *     constant:  bps            the value (two's complement)
 *     verbatim:  len × bps
 *     fixed:     3 order,  order × bps warm-up,  residual
 *     LPC:       5 order−1,  4 precision−1,  5 shift,  order × precision coefficients,
 *                order × bps warm-up,  residual
 *   residual:    4 partition order po, then for each of 2^po partitions:
 *                4 Rice k, and each folded value u as (u >> k) zeros, a 1, then the low k bits
 */
export function encodeStream(x: ArrayLike<number>, o: EncodeOptions): EncodeResult {
  const w = new BitWriter('msb')
  w.writeBits(x.length >>> 16, 16)
  w.writeBits(x.length & 0xffff, 16)
  w.writeBits(o.bps - 1, 5)
  w.writeBits(o.blockSize, 16)
  const blocks: BlockAnalysis[] = []
  const sw = (v: number, bits: number) => w.writeBits(v < 0 ? (v + 2 ** bits) & (2 ** bits - 1) : v & (2 ** bits - 1), bits)
  for (let start = 0; start < x.length; start += o.blockSize) {
    const end = Math.min(x.length, start + o.blockSize)
    const a = analyseBlock(x, start, end, o.bps, o)
    blocks.push(a)
    const c = a.best
    const s = c.sub
    if (s.kind === 'constant') {
      w.writeBits(0, 2)
      sw(s.value, o.bps)
    } else if (s.kind === 'verbatim') {
      w.writeBits(1, 2)
      for (let i = start; i < end; i++) sw(x[i], o.bps)
    } else {
      if (s.kind === 'fixed') {
        w.writeBits(2, 2)
        w.writeBits(s.order, 3)
      } else {
        w.writeBits(3, 2)
        w.writeBits(s.order - 1, 5)
        w.writeBits(s.precision - 1, 4)
        w.writeBits(s.shift, 5)
        for (let j = 0; j < s.order; j++) sw(s.q[j], s.precision)
      }
      for (let i = start; i < start + s.order; i++) sw(x[i], o.bps)
      const plan = c.plan!
      const res = c.residual!
      w.writeBits(plan.po, 4)
      for (let p = 0; p + 1 < plan.bounds.length; p++) {
        const k = plan.ks[p]
        w.writeBits(k, 4)
        for (let i = plan.bounds[p]; i < plan.bounds[p + 1]; i++) {
          const u = fold(res[i])
          const q = Math.floor(u / 2 ** k)
          for (let z = 0; z < q; z++) w.writeBits(0, 1)
          w.writeBits(1, 1)
          if (k) w.writeBits(u % 2 ** k, k)
        }
      }
    }
  }
  const bits = w.bitLength
  return { bytes: w.finish(), bits, blocks }
}

export function decodeStream(bytes: Uint8Array): { samples: Int32Array; bps: number } {
  const r = new BitReader(bytes, 'msb')
  const n = r.readBits(16) * 65536 + r.readBits(16)
  const bps = r.readBits(5) + 1
  const blockSize = r.readBits(16)
  const x = new Int32Array(n)
  const sr = (bits: number) => {
    const v = r.readBits(bits)
    return v >= 2 ** (bits - 1) ? v - 2 ** bits : v
  }
  for (let start = 0; start < n; start += blockSize) {
    const end = Math.min(n, start + blockSize)
    const kind = r.readBits(2)
    if (kind === 0) {
      const v = sr(bps)
      for (let i = start; i < end; i++) x[i] = v
      continue
    }
    if (kind === 1) {
      for (let i = start; i < end; i++) x[i] = sr(bps)
      continue
    }
    let order: number
    let q: Int32Array | null = null
    let shift = 0
    if (kind === 2) order = r.readBits(3)
    else {
      order = r.readBits(5) + 1
      const precision = r.readBits(4) + 1
      shift = r.readBits(5)
      q = new Int32Array(order)
      for (let j = 0; j < order; j++) q[j] = sr(precision)
    }
    for (let i = start; i < start + order; i++) x[i] = sr(bps)
    const po = r.readBits(4)
    const bounds = partitionBounds(end - start, order, po)
    if (!bounds) throw new Error('flac: bad partition order')
    let i = start + order
    for (let p = 0; p + 1 < bounds.length; p++) {
      const k = r.readBits(4)
      for (let c = bounds[p]; c < bounds[p + 1]; c++) {
        let qn = 0
        while (r.readBit() === 0) qn++
        const u = qn * 2 ** k + (k ? r.readBits(k) : 0)
        const e = unfold(u)
        const pred = q ? lpcPredict(x, i, q, shift) : fixedPredict(x, i, order)
        x[i] = pred + e
        i++
      }
    }
  }
  return { samples: x, bps }
}

// ------------------------------------------------------------------ WAV in

/** Parse a PCM WAV (8/16/24-bit, any channel count), mixed to mono 16-bit. */
export function parseWav(buf: ArrayBuffer, maxSamples = 20 * 44100): { samples: Int32Array; rate: number } {
  const v = new DataView(buf)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let pos = 12
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null
  while (pos + 8 <= v.byteLength) {
    const id = tag(pos)
    const size = v.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV: data before fmt')
      if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error('WAV: only uncompressed PCM is supported')
      if (![8, 16, 24].includes(fmt.bits)) throw new Error(`WAV: ${fmt.bits}-bit samples are not supported`)
      const bytes = fmt.bits / 8
      const frame = bytes * fmt.channels
      const frames = Math.min(maxSamples, Math.floor(Math.min(size, v.byteLength - body) / frame))
      const out = new Int32Array(frames)
      for (let f = 0; f < frames; f++) {
        let s = 0
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + f * frame + c * bytes
          if (fmt.bits === 8) s += (v.getUint8(o) - 128) * 256
          else if (fmt.bits === 16) s += v.getInt16(o, true)
          else s += ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) >> 8)
        }
        out[f] = clip16(s / fmt.channels)
      }
      return { samples: out, rate: fmt.rate }
    }
    pos = body + size + (size & 1)
  }
  throw new Error('WAV: no data chunk')
}

/** Little-endian 16-bit PCM bytes, for comparing against a general-purpose compressor. */
export function pcmBytes(x: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(x.length * 2)
  for (let i = 0; i < x.length; i++) {
    const v = x[i] & 0xffff
    out[2 * i] = v & 0xff
    out[2 * i + 1] = v >> 8
  }
  return out
}
