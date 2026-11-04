/**
 * Asymmetric numeral systems (Duda, 2009–2014), three ways:
 *
 *  1. `toyEncode` / `toyDecode` — rANS with BigInt and no renormalisation. The
 *     whole message becomes one integer x, and every symbol s multiplies it by
 *     about M/f(s): log₂ x grows by the symbol's information content. This is
 *     the idea with nothing in the way.
 *  2. `streamEncode` / `streamDecode` — the same rANS with x held in a fixed
 *     interval [L, 2L), L = M·2^h. Before coding a symbol whose step would
 *     overflow the interval, the encoder shifts low bits out onto a stack; the
 *     decoder pulls them back in after decoding. Bit-at-a-time so it can be
 *     watched; the codec does the same with bytes and a 32-bit state.
 *  3. `buildTans` — tANS / FSE: the coding function tabulated for L states, as
 *     in Zstandard. A symbol spread over the L slots decides everything; the
 *     encoder and decoder become table lookups plus a few raw bits.
 *
 * Every encoder here runs over the input BACKWARDS. ANS is a stack: the last
 * symbol pushed is the first one popped, so to decode in reading order the
 * encoder has to push in reverse.
 */

/**
 * Quantise counts to integer frequencies that sum to exactly `total`, keeping
 * every present symbol at ≥ 1 (a zero frequency would make it uncodable).
 * Largest-remainder rounding, then nudges taken from / given to the symbols
 * where a unit matters least. Throws if there are more symbols than slots.
 */
export function normalize(counts: ArrayLike<number>, total: number): number[] {
  const n = counts.length
  const out = new Array<number>(n).fill(0)
  let sum = 0
  let used = 0
  for (let i = 0; i < n; i++) {
    sum += counts[i]
    if (counts[i] > 0) used++
  }
  if (used === 0) return out
  if (used > total) throw new Error(`cannot give ${used} symbols a slot each out of ${total}`)
  const exact = new Array<number>(n).fill(0)
  let s = 0
  for (let i = 0; i < n; i++) {
    if (!counts[i]) continue
    exact[i] = (counts[i] * total) / sum
    out[i] = Math.max(1, Math.floor(exact[i]))
    s += out[i]
  }
  // Give spare units to the largest remainders (the symbols most short-changed).
  while (s < total) {
    let best = -1
    let bestGap = -Infinity
    for (let i = 0; i < n; i++) {
      if (!counts[i]) continue
      const gap = exact[i] - out[i]
      if (gap > bestGap) {
        bestGap = gap
        best = i
      }
    }
    out[best]++
    s++
  }
  // Take excess units (created by the ≥1 floor) from where one unit costs least:
  // the cost of f → f−1 is counts·log₂(f/(f−1)), smallest for big f relative to its count.
  while (s > total) {
    let best = -1
    let bestCost = Infinity
    for (let i = 0; i < n; i++) {
      if (out[i] <= 1) continue
      const cost = counts[i] * Math.log2(out[i] / (out[i] - 1))
      if (cost < bestCost) {
        bestCost = cost
        best = i
      }
    }
    out[best]--
    s--
  }
  return out
}

export interface RansModel {
  /** Sum of frequencies, a power of two. */
  M: number
  k: number
  freq: number[]
  /** cum[s] = Σ freq[t] for t < s. */
  cum: number[]
  /** slot → symbol, length M. */
  lookup: number[]
}

export function ransModel(counts: ArrayLike<number>, k: number): RansModel {
  const M = 2 ** k
  const freq = normalize(counts, M)
  const cum: number[] = []
  let c = 0
  for (const f of freq) {
    cum.push(c)
    c += f
  }
  const lookup = new Array<number>(M)
  for (let s = 0; s < freq.length; s++) for (let j = 0; j < freq[s]; j++) lookup[cum[s] + j] = s
  return { M, k, freq, cum, lookup }
}

/** Bits a symbol sequence costs under the quantised model: Σ log₂(M / f). */
export function modelBits(syms: ArrayLike<number>, m: RansModel): number {
  let b = 0
  for (let i = 0; i < syms.length; i++) b += Math.log2(m.M / m.freq[syms[i]])
  return b
}

// ----------------------------------------------------------------- toy rANS

export interface ToyStep {
  /** Index into the message of the symbol just coded. */
  i: number
  sym: number
  before: bigint
  after: bigint
}

/** C(s, x) = ⌊x / f⌋·M + c + (x mod f), with arbitrary-precision x. */
export function toyPush(x: bigint, s: number, m: RansModel): bigint {
  const f = BigInt(m.freq[s])
  return (x / f) * BigInt(m.M) + BigInt(m.cum[s]) + (x % f)
}

/** D(x) = (s, f·⌊x / M⌋ + (x mod M) − c), where s owns slot x mod M. */
export function toyPop(x: bigint, m: RansModel): { s: number; x: bigint } {
  const M = BigInt(m.M)
  const slot = Number(x % M)
  const s = m.lookup[slot]
  return { s, x: BigInt(m.freq[s]) * (x / M) + BigInt(slot - m.cum[s]) }
}

/** Encode backwards from x₀ = M. Steps are in encoding order (last symbol first). */
export function toyEncode(syms: ArrayLike<number>, m: RansModel): { steps: ToyStep[]; x: bigint; x0: bigint } {
  const x0 = BigInt(m.M)
  let x = x0
  const steps: ToyStep[] = []
  for (let i = syms.length - 1; i >= 0; i--) {
    const after = toyPush(x, syms[i], m)
    steps.push({ i, sym: syms[i], before: x, after })
    x = after
  }
  return { steps, x, x0 }
}

export function toyDecode(x: bigint, n: number, m: RansModel): { syms: number[]; states: bigint[] } {
  const syms: number[] = []
  const states: bigint[] = [x]
  for (let i = 0; i < n; i++) {
    const r = toyPop(x, m)
    syms.push(r.s)
    x = r.x
    states.push(x)
  }
  return { syms, states }
}

// ----------------------------------------------------------- streaming rANS

export interface StreamStep {
  i: number
  sym: number
  /** State on entry. */
  before: number
  /** Bits shifted out (encode) or in (decode), in the order they moved. */
  bits: number[]
  /** State after renormalisation, before (encode) / after (decode) the coding step. */
  mid: number
  /** State on exit. */
  after: number
}

export interface StreamParams {
  m: RansModel
  /** Headroom: L = M · 2^h. More headroom = less rounding loss, wider registers. */
  h: number
}

export const lowerBound = (p: StreamParams) => p.m.M * 2 ** p.h

/**
 * Bit-wise streaming rANS. State x ∈ [L, 2L). To code s the state must first be
 * in [f·2^h, 2f·2^h) so that C(s, x) lands back in [L, 2L): shift bits out
 * until it is.
 */
export function streamEncode(syms: ArrayLike<number>, p: StreamParams): { steps: StreamStep[]; stack: number[]; final: number } {
  const { m } = p
  const L = lowerBound(p)
  let x = L
  const stack: number[] = []
  const steps: StreamStep[] = []
  for (let i = syms.length - 1; i >= 0; i--) {
    const s = syms[i]
    const f = m.freq[s]
    const before = x
    const xmax = 2 * f * 2 ** p.h
    const bits: number[] = []
    while (x >= xmax) {
      bits.push(x & 1)
      stack.push(x & 1)
      x = Math.floor(x / 2)
    }
    const mid = x
    x = Math.floor(x / f) * m.M + m.cum[s] + (x % f)
    steps.push({ i, sym: s, before, bits, mid, after: x })
  }
  return { steps, stack, final: x }
}

/** Width of the flushed final state: x < 2L = 2^(k+h+1). */
export const stateBits = (p: StreamParams) => p.m.k + p.h + 1

export function streamDecode(final: number, stack: number[], n: number, p: StreamParams): { syms: number[]; steps: StreamStep[] } {
  const { m } = p
  const L = lowerBound(p)
  let x = final
  const st = stack.slice()
  const syms: number[] = []
  const steps: StreamStep[] = []
  for (let i = 0; i < n; i++) {
    const before = x
    const slot = x % m.M
    const s = m.lookup[slot]
    x = m.freq[s] * Math.floor(x / m.M) + slot - m.cum[s]
    const mid = x
    const bits: number[] = []
    while (x < L) {
      const b = st.pop()
      if (b === undefined) throw new Error('rANS: bit stack ran dry')
      bits.push(b)
      x = 2 * x + b
    }
    syms.push(s)
    steps.push({ i, sym: s, before, bits, mid, after: x })
  }
  return { syms, steps }
}

// --------------------------------------------------------------- tANS / FSE

export interface Tans {
  /** Table size, a power of two; states are L … 2L−1 on the encoder side. */
  L: number
  R: number
  /** Normalised counts, Σ = L. */
  counts: number[]
  /** spread[u] = symbol owning slot u. */
  spread: number[]
  /** Decoder: for slot u, the bits to read and the base to add them to (both relative to slots 0…L−1). */
  nbBits: number[]
  base: number[]
  /** Decoder: the "occurrence number" x' ∈ [count, 2·count) slot u stands for. */
  occ: number[]
  /** Encoder: enc[s][x' − count[s]] = L + u. */
  enc: number[][]
}

/** Zstandard's spread step: odd, so it visits every slot of a power-of-two table exactly once. */
export const spreadStep = (L: number) => (L >> 1) + (L >> 3) + 3

export function buildTans(raw: ArrayLike<number>, R: number): Tans {
  const L = 2 ** R
  const counts = normalize(raw, L)
  const spread = new Array<number>(L).fill(-1)
  const step = spreadStep(L)
  let pos = 0
  for (let s = 0; s < counts.length; s++) {
    for (let j = 0; j < counts[s]; j++) {
      spread[pos] = s
      pos = (pos + step) & (L - 1)
    }
  }
  const next = counts.slice()
  const nbBits = new Array<number>(L)
  const base = new Array<number>(L)
  const occ = new Array<number>(L)
  const enc: number[][] = counts.map(() => [])
  for (let u = 0; u < L; u++) {
    const s = spread[u]
    const k = next[s]++
    occ[u] = k
    const nb = R - Math.floor(Math.log2(k))
    nbBits[u] = nb
    base[u] = k * 2 ** nb - L
    enc[s][k - counts[s]] = L + u
  }
  return { L, R, counts, spread, nbBits, base, occ, enc }
}

export interface TansStep {
  i: number
  sym: number
  /** Encoder state on entry, in [L, 2L). */
  before: number
  /** Raw bits shifted out, as a number and a width. */
  value: number
  nb: number
  /** x' = before >> nb, in [count, 2·count). */
  reduced: number
  after: number
}

export function tansEncode(syms: ArrayLike<number>, t: Tans): { steps: TansStep[]; final: number } {
  let x = t.L
  const steps: TansStep[] = []
  for (let i = syms.length - 1; i >= 0; i--) {
    const s = syms[i]
    const c = t.counts[s]
    let nb = 0
    while (Math.floor(x / 2 ** nb) >= 2 * c) nb++
    const value = x % 2 ** nb
    const reduced = Math.floor(x / 2 ** nb)
    const after = t.enc[s][reduced - c]
    steps.push({ i, sym: s, before: x, value, nb, reduced, after })
    x = after
  }
  return { steps, final: x }
}

/** Decoding is the steps in reverse: read state, emit spread[state], add raw bits to the base. */
export function tansDecode(final: number, chunks: { value: number; nb: number }[], n: number, t: Tans): number[] {
  // chunks are in decode order (the reverse of emission).
  let X = final - t.L
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(t.spread[X])
    const nb = t.nbBits[X]
    const ch = chunks[i]
    if (!ch || ch.nb !== nb) throw new Error(`tANS: expected ${nb} bits at step ${i}`)
    X = t.base[X] + ch.value
  }
  return out
}
