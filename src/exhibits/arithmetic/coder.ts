/**
 * Arithmetic coding, twice.
 *
 *  1. `idealIntervals` — exact rational arithmetic with BigInt. The message is
 *     a sub-interval of [0, 1) whose width is the product of the probabilities
 *     the model gave each symbol. Nothing is rounded, so this is the textbook
 *     picture and the reference the integer coder is measured against.
 *  2. `encode` / `decode` — the integer coder of Witten, Neal & Cleary (CACM,
 *     1987). `low` and `high` are P-bit registers. Whenever both agree on the
 *     top bit, that bit can never change again, so it is shipped and the
 *     registers shift left (E1/E2). When the interval straddles the midpoint
 *     but sits inside the middle half, the next bit is unknown yet — the coder
 *     remembers it owes one "opposite" bit (pending) and expands the middle (E3).
 *
 * Models are separate from the coder: the coder only ever asks "where does
 * symbol s sit in the cumulative counts, out of what total". That separation is
 * the whole point of arithmetic coding — a better model is a better compressor,
 * with no change to the coder.
 */

import { BitReader, BitWriter } from '../../lib/bits'

// ------------------------------------------------------------------ models

/** Cumulative-frequency model over symbols 0 … k−1. */
export interface Model {
  readonly size: number
  total(): number
  /** [cumLow, cumHigh) of symbol s. */
  range(s: number): [number, number]
  /** The symbol whose [cumLow, cumHigh) contains `target`. */
  find(target: number): number
  /** Called after each symbol, by encoder and decoder alike. */
  update(s: number): void
  /** Current counts (copy), for drawing. */
  counts(): number[]
}

/**
 * Frequency-count model. `increment` 0 makes it static; > 0 makes it adaptive.
 * When the total would exceed `limit`, every count is halved (rounding up, so
 * nothing falls to zero) — the classic rescale that also lets the model forget.
 */
export class FreqModel implements Model {
  private c: number[]
  private t: number

  constructor(
    initial: number[],
    private readonly increment = 0,
    private readonly limit = 1 << 16,
  ) {
    this.c = initial.slice()
    this.t = this.c.reduce((a, b) => a + b, 0)
  }

  get size() {
    return this.c.length
  }

  total() {
    return this.t
  }

  range(s: number): [number, number] {
    let lo = 0
    for (let i = 0; i < s; i++) lo += this.c[i]
    return [lo, lo + this.c[s]]
  }

  find(target: number): number {
    let acc = 0
    for (let i = 0; i < this.c.length; i++) {
      acc += this.c[i]
      if (target < acc) return i
    }
    throw new Error('arithmetic: target outside model total')
  }

  update(s: number) {
    if (!this.increment) return
    this.c[s] += this.increment
    this.t += this.increment
    if (this.t > this.limit) {
      this.t = 0
      for (let i = 0; i < this.c.length; i++) {
        if (this.c[i]) this.c[i] = Math.max(1, (this.c[i] + 1) >> 1)
        this.t += this.c[i]
      }
    }
  }

  counts() {
    return this.c.slice()
  }
}

/** Order-1 model: one adaptive table per previous byte. */
export class Order1Model implements Model {
  private readonly tables: FreqModel[] = []
  private prev = 0

  constructor(
    private readonly increment = 24,
    private readonly limit = 1 << 16,
  ) {}

  private cur(): FreqModel {
    let m = this.tables[this.prev]
    if (!m) m = this.tables[this.prev] = new FreqModel(new Array(256).fill(1), this.increment, this.limit)
    return m
  }

  get size() {
    return 256
  }
  total() {
    return this.cur().total()
  }
  range(s: number) {
    return this.cur().range(s)
  }
  find(t: number) {
    return this.cur().find(t)
  }
  update(s: number) {
    this.cur().update(s)
    this.prev = s
  }
  counts() {
    return this.cur().counts()
  }
}

// ----------------------------------------------------------- integer coder

/** ⌊a / b⌋ exactly, for non-negative integers below 2^53. */
function idiv(a: number, b: number): number {
  let q = Math.floor(a / b)
  if (q * b > a) q--
  else if ((q + 1) * b <= a) q++
  return q
}

export type EventKind = 'start' | 'narrow' | 'E1' | 'E2' | 'E3' | 'flush'

/** One state of the coder, after the event named by `kind`. */
export interface CoderState {
  kind: EventKind
  /** Index of the symbol being coded (for 'narrow' and the shifts that follow it). */
  symIndex: number
  low: number
  high: number
  /** Registers before this event (for drawing the zoom). */
  prevLow: number
  prevHigh: number
  pending: number
  /** Bits emitted by this event (may be '' for E3). */
  emitted: string
  /** Total bits emitted so far. */
  outLength: number
  /** For 'narrow': the model's counts before the update, and the chosen slice. */
  counts?: number[]
  cl?: number
  ch?: number
  total?: number
}

export interface EncodeResult {
  /** The bit string (only filled in when tracing). */
  bits: string
  /** Exact number of bits emitted, before padding to a byte. */
  bitLength: number
  bytes: Uint8Array
  states: CoderState[]
}

/**
 * Encode `symbols` (indices into the model) with P-bit registers. P = 16 for the
 * picture, 32 for the codec. The model's total must stay ≤ 2^(P−2) so every
 * symbol keeps a non-empty slice of the smallest possible range.
 */
export function encode(symbols: ArrayLike<number>, model: Model, P = 32, trace = false): EncodeResult {
  const TOP = 2 ** P - 1
  const HALF = 2 ** (P - 1)
  const Q1 = 2 ** (P - 2)
  const Q3 = 3 * Q1
  const w = new BitWriter('msb')
  const states: CoderState[] = []
  let bits = ''
  let low = 0
  let high = TOP
  let pending = 0

  const out = (b: number) => {
    let s = String(b)
    w.writeBits(b, 1)
    for (; pending > 0; pending--) {
      w.writeBits(1 - b, 1)
      s += String(1 - b)
    }
    if (trace) bits += s
    return s
  }

  if (trace) states.push({ kind: 'start', symIndex: -1, low, high, prevLow: low, prevHigh: high, pending, emitted: '', outLength: 0 })

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    const total = model.total()
    if (total > Q1) throw new Error('arithmetic: model total too large for register size')
    const [cl, ch] = model.range(s)
    if (ch <= cl) throw new Error('arithmetic: zero-frequency symbol')
    const range = high - low + 1
    const pl = low
    const ph = high
    const counts = trace ? model.counts() : undefined
    high = low + idiv(range * ch, total) - 1
    low = low + idiv(range * cl, total)
    model.update(s)
    if (trace) states.push({ kind: 'narrow', symIndex: i, low, high, prevLow: pl, prevHigh: ph, pending, emitted: '', outLength: bits.length, counts, cl, ch, total })
    for (;;) {
      const bl = low
      const bh = high
      let kind: EventKind
      let emitted = ''
      if (high < HALF) {
        kind = 'E1'
        emitted = out(0)
      } else if (low >= HALF) {
        kind = 'E2'
        emitted = out(1)
        low -= HALF
        high -= HALF
      } else if (low >= Q1 && high < Q3) {
        kind = 'E3'
        pending++
        low -= Q1
        high -= Q1
      } else break
      low = 2 * low
      high = 2 * high + 1
      if (trace) states.push({ kind, symIndex: i, low, high, prevLow: bl, prevHigh: bh, pending, emitted, outLength: bits.length })
    }
  }

  // Two more bits (plus anything pending) pin a point inside the final interval:
  // low < Q1 ≤ … means "01…" lies inside, otherwise "10…" does. The decoder
  // reads zeros past the end, so nothing else is needed.
  const fl = low
  const fh = high
  pending++
  const emitted = low < Q1 ? out(0) : out(1)
  if (trace) states.push({ kind: 'flush', symIndex: symbols.length, low, high, prevLow: fl, prevHigh: fh, pending: 0, emitted, outLength: bits.length })

  return { bits, bitLength: w.bitLength, bytes: w.finish(), states }
}

/** Decode `n` symbols. Reads zeros past the end of the stream. */
export function decode(bytes: Uint8Array, n: number, model: Model, P = 32): number[] {
  const TOP = 2 ** P - 1
  const HALF = 2 ** (P - 1)
  const Q1 = 2 ** (P - 2)
  const Q3 = 3 * Q1
  const r = new BitReader(bytes, 'msb')
  const next = () => (r.bitsLeft > 0 ? r.readBit() : 0)
  let low = 0
  let high = TOP
  let value = 0
  for (let i = 0; i < P; i++) value = value * 2 + next()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const total = model.total()
    const range = high - low + 1
    const target = idiv((value - low + 1) * total - 1, range)
    const s = model.find(target)
    const [cl, ch] = model.range(s)
    high = low + idiv(range * ch, total) - 1
    low = low + idiv(range * cl, total)
    model.update(s)
    out.push(s)
    for (;;) {
      if (high < HALF) {
        // nothing to subtract
      } else if (low >= HALF) {
        low -= HALF
        high -= HALF
        value -= HALF
      } else if (low >= Q1 && high < Q3) {
        low -= Q1
        high -= Q1
        value -= Q1
      } else break
      low = 2 * low
      high = 2 * high + 1
      value = 2 * value + next()
    }
  }
  return out
}

// ------------------------------------------------------- exact intervals

/** [low, low + width) = [L/D, (L+W)/D), all BigInt. */
export interface Interval {
  L: bigint
  W: bigint
  D: bigint
}

export interface IdealStep {
  /** Interval before coding this symbol. */
  before: Interval
  after: Interval
  symbol: number
  /** Counts the model used for this symbol, and their total. */
  counts: number[]
  total: number
  cl: number
  ch: number
}

/**
 * Exact interval narrowing: low' = low + width·cl/T, width' = width·f/T.
 * Kept over a common denominator D = Π T so nothing is ever rounded.
 */
export function idealIntervals(symbols: ArrayLike<number>, model: Model): IdealStep[] {
  const steps: IdealStep[] = []
  let cur: Interval = { L: 0n, W: 1n, D: 1n }
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    const counts = model.counts()
    const total = model.total()
    const [cl, ch] = model.range(s)
    const T = BigInt(total)
    const next: Interval = { L: cur.L * T + cur.W * BigInt(cl), W: cur.W * BigInt(ch - cl), D: cur.D * T }
    steps.push({ before: cur, after: next, symbol: s, counts, total, cl, ch })
    model.update(s)
    cur = next
  }
  return steps
}

/** −log₂(W/D) as a float, safe for huge BigInts. */
export function bitsOf(iv: Interval): number {
  return log2Big(iv.D) - log2Big(iv.W)
}

export function log2Big(x: bigint): number {
  if (x <= 0n) return -Infinity
  const s = x.toString(2)
  if (s.length <= 52) return Math.log2(Number(x))
  // Top 52 bits as a mantissa, the rest as an exponent.
  return Math.log2(parseInt(s.slice(0, 52), 2)) + (s.length - 52)
}

/** First `n` binary digits of the fraction N/D (0 ≤ N/D < 1). */
export function binaryDigits(N: bigint, D: bigint, n: number): string {
  let s = ''
  let r = N
  for (let i = 0; i < n; i++) {
    r *= 2n
    if (r >= D) {
      s += '1'
      r -= D
    } else s += '0'
  }
  return s
}

/**
 * The shortest bit string b such that the whole dyadic interval
 * [0.b, 0.b + 2^−|b|) lies inside [L/D, (L+W)/D). Any continuation of b still
 * lands inside, so the decoder can stop wherever — this is the code word.
 * Its length is at most ⌈−log₂ width⌉ + 1.
 */
export function codeWord(iv: Interval): string {
  if (iv.W >= iv.D && iv.L === 0n) return ''
  for (let k = 1; k < 100000; k++) {
    const K = 1n << BigInt(k)
    // m = ⌈L·2^k / D⌉
    const num = iv.L * K
    let m = num / iv.D
    if (m * iv.D < num) m++
    // need (m+1)/2^k ≤ (L+W)/D
    if ((m + 1n) * iv.D <= (iv.L + iv.W) * K) return m.toString(2).padStart(k, '0')
  }
  throw new Error('codeWord: interval too small')
}

/** The shortest binary fraction 0.b that lies inside the interval (not prefix-free). */
export function shortestPoint(iv: Interval): string {
  if (iv.L === 0n) return ''
  for (let k = 1; k < 100000; k++) {
    const K = 1n << BigInt(k)
    const num = iv.L * K
    let m = num / iv.D
    if (m * iv.D < num) m++
    if (m * iv.D < (iv.L + iv.W) * K) return m.toString(2).padStart(k, '0')
  }
  throw new Error('shortestPoint: interval too small')
}
