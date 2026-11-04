/**
 * Codes for integers whose size you do not know in advance.
 *
 * Every code here is a prefix code over the integers, so codewords can be
 * concatenated with no separators. Each one is a bet about how numbers are
 * distributed: unary bets on "almost always tiny", Elias γ/δ/ω bet on
 * "roughly 1/n²", Golomb–Rice bet on a geometric distribution with a known
 * scale, varints bet on "fits in a few bytes".
 *
 * Conventions (they vary between papers, so they are pinned here):
 *  - unary(q) is q zeros followed by a 1 — the form FLAC, H.264 and
 *    Exp-Golomb use. (Golomb's paper writes ones-then-zero; same length.)
 *  - γ, δ, ω and Fibonacci code n ≥ 1; the rest code n ≥ 0.
 *  - LEB128 is the unsigned form, least significant group first, top bit of
 *    each byte set when another byte follows.
 *
 * Encoders return labelled parts so the page can colour the prefix, the
 * payload, the terminator and the continuation flags separately. Decoders read
 * from a `BitSource` that takes a note for every bit, which is what drives the
 * bit-by-bit step-through; verify passes a source that ignores the notes.
 */

export type Role = 'prefix' | 'payload' | 'stop' | 'flag'

export interface Part {
  bits: string
  role: Role
  /** What this run of bits means, e.g. "3 zeros: the payload is 4 bits". */
  label: string
}

export interface BitSource {
  /** Read one bit. `note` explains why, given the bit's value. */
  bit(note: (b: number) => string): number
}

export type CodeId = 'unary' | 'gamma' | 'delta' | 'omega' | 'fib' | 'golomb' | 'rice' | 'expgolomb' | 'leb128'

export interface IntCode {
  id: CodeId
  name: string
  /** Smallest integer the code can represent (0 or 1). */
  min: 0 | 1
  /** Which parameter the code takes, if any. */
  param?: 'm' | 'k'
  encode(n: number, p: number): Part[]
  decode(src: BitSource, p: number): number
  /** One line: who uses it. */
  where: string
}

export const bin = (v: number, width: number): string => (width <= 0 ? '' : v.toString(2).padStart(width, '0'))
const bitLen = (v: number): number => (v <= 0 ? 0 : Math.floor(Math.log2(v)) + 1)
/** floor(log2 v) for v ≥ 1, exact for integers up to 2^52. */
export const ilog2 = (v: number): number => {
  let n = 0
  while (v >= 2) {
    v = Math.floor(v / 2)
    n++
  }
  return n
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function unaryPart(q: number, label: string): Part[] {
  const out: Part[] = []
  if (q > 0) out.push({ bits: '0'.repeat(q), role: 'prefix', label })
  out.push({ bits: '1', role: 'stop', label: 'the 1 ends the unary count' })
  return out
}

function readUnary(src: BitSource, what: string): number {
  let q = 0
  while (src.bit((b) => (b ? `a 1: the unary count stops at ${q} — ${what} = ${q}` : `zero ${q + 1} of the unary count`)) === 0) q++
  return q
}

function readBits(src: BitSource, width: number, what: (i: number, soFar: number, b: number) => string): number {
  let v = 0
  for (let i = 0; i < width; i++) {
    const cur = v
    v = v * 2 + src.bit((b) => what(i, cur * 2 + b, b))
  }
  return v
}

// --------------------------------------------------------------------- unary

const unary: IntCode = {
  id: 'unary',
  name: 'Unary',
  min: 0,
  where: 'inside every other code here; Golomb’s quotient',
  encode: (n) => unaryPart(n, plural(n, 'zero') + ' = the number itself'),
  decode: (src) => readUnary(src, 'the number'),
}

// ------------------------------------------------------------------- Elias γ

const gamma: IntCode = {
  id: 'gamma',
  name: 'Elias γ',
  min: 1,
  where: 'Elias 1975; inside δ; posting lists, early H.26x drafts',
  encode(n) {
    const N = ilog2(n)
    const parts: Part[] = []
    if (N > 0) parts.push({ bits: '0'.repeat(N), role: 'prefix', label: `${plural(N, 'zero')}: n has ${N + 1} binary digits` })
    parts.push({ bits: '1', role: 'stop', label: 'the leading 1 of n, doubling as the terminator' })
    if (N > 0) parts.push({ bits: bin(n, N + 1).slice(1), role: 'payload', label: `the other ${N} digits of n` })
    return parts
  },
  decode(src) {
    let N = 0
    while (src.bit((b) => (b ? `a 1 after ${plural(N, 'zero')}: n has ${N + 1} digits, and this 1 is the first` : `zero ${N + 1}: one more digit to come`)) === 0) N++
    const rest = readBits(src, N, (i, v) => `digit ${i + 2} of ${N + 1}: so far 1${bin(v, i + 1)}`)
    return 2 ** N + rest
  },
}

// ------------------------------------------------------------------- Elias δ

const delta: IntCode = {
  id: 'delta',
  name: 'Elias δ',
  min: 1,
  where: 'Elias 1975; better than γ above n ≈ 32',
  encode(n) {
    const N = ilog2(n)
    const L = N + 1
    const z = ilog2(L)
    const parts: Part[] = []
    if (z > 0) parts.push({ bits: '0'.repeat(z), role: 'prefix', label: `${plural(z, 'zero')}: the length field has ${z + 1} digits` })
    parts.push({ bits: '1', role: 'stop', label: `the leading 1 of the length field` })
    if (z > 0) parts.push({ bits: bin(L, z + 1).slice(1), role: 'prefix', label: `rest of the length field: n has ${L} digits (this is γ(${L}))` })
    if (N > 0) parts.push({ bits: bin(n, L).slice(1), role: 'payload', label: `the low ${N} digits of n (its leading 1 is implied)` })
    return parts
  },
  decode(src) {
    // γ-decode L = N + 1 with δ-flavoured notes.
    let z = 0
    while (src.bit((b) => (b ? `a 1: the length field has ${z + 1} digits` : `zero ${z + 1} of the length field’s γ prefix`)) === 0) z++
    const lrest = readBits(src, z, (i, v) => `length digit ${i + 2}: so far 1${bin(v, i + 1)}`)
    const L = 2 ** z + lrest
    const N = L - 1
    const rest = readBits(src, N, (i, v) => `n has ${L} digits; low digit ${i + 1} of ${N}: so far 1${bin(v, i + 1)}`)
    return 2 ** N + rest
  },
}

// ------------------------------------------------------------------- Elias ω

const omega: IntCode = {
  id: 'omega',
  name: 'Elias ω',
  min: 1,
  where: 'Elias 1975; recursive lengths, best of the three for huge n',
  encode(n) {
    const groups: string[] = []
    let v = n
    while (v > 1) {
      const b = bin(v, bitLen(v))
      groups.unshift(b)
      v = b.length - 1
    }
    const parts: Part[] = groups.map((g, i) => ({
      bits: g,
      role: i === groups.length - 1 ? 'payload' : 'prefix',
      label: i === groups.length - 1 ? `n itself, ${g.length} digits` : `${parseInt(g, 2)}: the next group has ${parseInt(g, 2) + 1} digits`,
    }))
    parts.push({ bits: '0', role: 'stop', label: 'a 0 where a group would start: done' })
    return parts
  },
  decode(src) {
    let n = 1
    for (;;) {
      const len = n
      const first = src.bit((b) => (b ? `a 1 starts a group of ${len + 1} digits` : `a 0 where a group would start: the number is ${len}`))
      if (first === 0) return n
      const rest = readBits(src, len, (i, v) => `group digit ${i + 2} of ${len + 1}: so far 1${bin(v, i + 1)}`)
      n = 2 ** len + rest
    }
  },
}

// ---------------------------------------------------------------- Fibonacci

/** Fibonacci numbers 1, 2, 3, 5, 8, … (F₂ onwards). */
const FIB: number[] = (() => {
  const f = [1, 2]
  while (f[f.length - 1] < 2 ** 53) f.push(f[f.length - 1] + f[f.length - 2])
  return f
})()

const fib: IntCode = {
  id: 'fib',
  name: 'Fibonacci',
  min: 1,
  where: 'Apostolico & Fraenkel 1987; robust — a flipped bit only damages one or two numbers',
  encode(n) {
    // Zeckendorf: greedy from the largest Fibonacci number ≤ n; never two adjacent 1s.
    let k = 0
    while (k + 1 < FIB.length && FIB[k + 1] <= n) k++
    const bits = new Array<string>(k + 1).fill('0')
    let r = n
    for (let i = k; i >= 0; i--) {
      if (FIB[i] <= r) {
        bits[i] = '1'
        r -= FIB[i]
      }
    }
    const used = bits.map((b, i) => (b === '1' ? FIB[i] : 0)).filter(Boolean)
    return [
      { bits: bits.join(''), role: 'payload', label: `Zeckendorf digits for 1, 2, 3, 5, 8 … lowest first: ${n} = ${used.join(' + ')}` },
      { bits: '1', role: 'stop', label: 'an extra 1: “11” cannot occur inside a codeword, so it marks the end' },
    ]
  },
  decode(src) {
    let n = 0
    let prev = 0
    for (let i = 0; ; i++) {
      const sum = n
      const p = prev
      const b = src.bit((v) => (v && p ? `a second 1 in a row: that is the end marker — the number is ${sum}` : v ? `1 × ${FIB[i]}: total ${sum + FIB[i]}` : `0 × ${FIB[i]}`))
      if (b && prev) return n
      if (b) n += FIB[i]
      prev = b
    }
  },
}

// ------------------------------------------------------------- Golomb (m)

/** Truncated binary for r in [0, m): the first `cut` values get b−1 bits, the rest b bits. */
function truncBinary(r: number, m: number): string {
  if (m === 1) return ''
  const b = bitLen(m - 1)
  const cut = 2 ** b - m
  return r < cut ? bin(r, b - 1) : bin(r + cut, b)
}

const golomb: IntCode = {
  id: 'golomb',
  name: 'Golomb',
  min: 0,
  param: 'm',
  where: 'Golomb 1966; optimal for geometric distributions; JPEG-LS',
  encode(n, m) {
    const q = Math.floor(n / m)
    const r = n % m
    const parts = unaryPart(q, `quotient ⌊${n}/${m}⌋ = ${q} in unary`)
    const tb = truncBinary(r, m)
    if (tb) parts.push({ bits: tb, role: 'payload', label: `remainder ${r} in truncated binary (m = ${m} needs ${bitLen(m - 1) - 1} or ${bitLen(m - 1)} bits)` })
    return parts
  },
  decode(src, m) {
    const q = readUnary(src, 'quotient')
    if (m === 1) return q
    const b = bitLen(m - 1)
    const cut = 2 ** b - m
    let v = readBits(src, b - 1, (i, s) => `remainder bit ${i + 1}: so far ${bin(s, i + 1)}`)
    if (v >= cut) {
      const head = v
      v = head * 2 + src.bit((x) => `one more remainder bit (the short form only covers 0…${cut - 1}): ${bin(head * 2 + x, b)} − ${cut} = ${head * 2 + x - cut}`) - cut
    }
    return q * m + v
  },
}

// ---------------------------------------------------------------- Rice (k)

const rice: IntCode = {
  id: 'rice',
  name: 'Rice',
  min: 0,
  param: 'k',
  where: 'Rice 1979; Golomb with m = 2ᵏ — FLAC, Shorten, lossless JPEG, LOCO-I',
  encode(n, k) {
    const q = Math.floor(n / 2 ** k)
    const parts = unaryPart(q, `high part ${n} >> ${k} = ${q} in unary`)
    if (k > 0) parts.push({ bits: bin(n % 2 ** k, k), role: 'payload', label: `the low ${k} bits of ${n}, verbatim` })
    return parts
  },
  decode(src, k) {
    const q = readUnary(src, 'high part')
    const low = readBits(src, k, (i, v) => `low bit ${i + 1} of ${k}: so far ${bin(v, i + 1)}`)
    return q * 2 ** k + low
  },
}

// ---------------------------------------------------------- Exp-Golomb (k)

const expgolomb: IntCode = {
  id: 'expgolomb',
  name: 'Exp-Golomb',
  min: 0,
  param: 'k',
  where: 'Teuhola 1978; H.264/HEVC ue(v) is k = 0',
  encode(n, k) {
    const x = n + 2 ** k
    const L = bitLen(x)
    const z = L - k - 1
    const parts: Part[] = []
    if (z > 0) parts.push({ bits: '0'.repeat(z), role: 'prefix', label: `${plural(z, 'zero')}: ${n} + 2^${k} = ${x} has ${L} digits` })
    parts.push({ bits: '1', role: 'stop', label: `the leading 1 of ${x}` })
    if (L > 1) parts.push({ bits: bin(x, L).slice(1), role: 'payload', label: `the other ${L - 1} digits of ${x}; subtract 2^${k} to get ${n}` })
    return parts
  },
  decode(src, k) {
    let z = 0
    while (src.bit((b) => (b ? `the leading 1: ${z + k + 1} digits in all` : `zero ${z + 1}`)) === 0) z++
    const w = z + k
    const rest = readBits(src, w, (i, v) => `digit ${i + 2} of ${w + 1}: so far 1${bin(v, i + 1)}`)
    return 2 ** w + rest - 2 ** k
  },
}

// ------------------------------------------------------------------- LEB128

const leb128: IntCode = {
  id: 'leb128',
  name: 'LEB128 varint',
  min: 0,
  where: 'DWARF, WebAssembly, protobuf, Git packfiles',
  encode(n) {
    const parts: Part[] = []
    let v = n
    let i = 0
    do {
      const group = v % 128
      v = Math.floor(v / 128)
      const more = v > 0
      parts.push({ bits: more ? '1' : '0', role: 'flag', label: more ? `byte ${i + 1}: top bit 1 — another byte follows` : `byte ${i + 1}: top bit 0 — last byte` })
      parts.push({ bits: bin(group, 7), role: 'payload', label: `7-bit group ${i + 1} (bits ${7 * i}…${7 * i + 6} of n) = ${group}` })
      i++
    } while (v > 0)
    return parts
  },
  decode(src) {
    let n = 0
    for (let i = 0; ; i++) {
      const more = src.bit((b) => (b ? `byte ${i + 1}: top bit 1, so another byte follows` : `byte ${i + 1}: top bit 0, the last byte`))
      const scale = 2 ** (7 * i)
      const base = n
      const g = readBits(src, 7, (j, v) => (j === 6 ? `group ${i + 1} = ${v}, worth ${v} × 2^${7 * i}: total ${base + v * scale}` : `group ${i + 1}, bit ${j + 1} of 7`))
      n += g * scale
      if (!more) return n
    }
  },
}

export const CODES: IntCode[] = [unary, gamma, delta, omega, fib, golomb, rice, expgolomb, leb128]
export const codeById = (id: CodeId) => CODES.find((c) => c.id === id)!

export function encodeBits(code: IntCode, n: number, p: number): string {
  return code.encode(n, p).map((x) => x.bits).join('')
}

export function codeLength(code: IntCode, n: number, p: number): number {
  // Closed forms where the parts would be enormous (unary of a million).
  switch (code.id) {
    case 'unary':
      return n + 1
    case 'gamma':
      return 2 * ilog2(n) + 1
    case 'delta': {
      const N = ilog2(n)
      return 2 * ilog2(N + 1) + 1 + N
    }
    case 'rice':
      return Math.floor(n / 2 ** p) + 1 + p
    case 'golomb': {
      const q = Math.floor(n / p)
      return q + 1 + truncBinary(n % p, p).length
    }
    case 'expgolomb': {
      const L = ilog2(n + 2 ** p) + 1
      return 2 * L - p - 1
    }
    case 'leb128':
      return 8 * Math.max(1, Math.ceil((ilog2(Math.max(1, n)) + 1) / 7))
    default:
      return encodeBits(code, n, p).length
  }
}

/** A BitSource over a '0'/'1' string that ignores notes. */
export function stringSource(bits: string): BitSource & { pos: number } {
  const s = {
    pos: 0,
    bit() {
      if (s.pos >= bits.length) throw new Error('read past end of bitstream')
      return bits.charCodeAt(s.pos++) - 48
    },
  }
  return s
}

/** A BitSource that records a note for every bit it hands out. */
export function tracingSource(bits: string): BitSource & { pos: number; notes: string[] } {
  const s = {
    pos: 0,
    notes: [] as string[],
    bit(note: (b: number) => string) {
      if (s.pos >= bits.length) throw new Error('read past end of bitstream')
      const b = bits.charCodeAt(s.pos++) - 48
      s.notes.push(note(b))
      return b
    },
  }
  return s
}

/** Protobuf's signed→unsigned map: 0, −1, 1, −2, 2 … → 0, 1, 2, 3, 4 … */
export const zigzag = (v: number): number => (v >= 0 ? 2 * v : -2 * v - 1)
export const unzigzag = (u: number): number => (u % 2 === 0 ? u / 2 : -(u + 1) / 2)

/**
 * Gallager & van Voorhis (1975): for P(n) = (1−θ)θⁿ the optimal Golomb
 * parameter is the smallest m with θᵐ + θᵐ⁺¹ ≤ 1.
 */
export function optimalGolombM(theta: number): number {
  let m = 1
  while (theta ** m + theta ** (m + 1) > 1 && m < 1e6) m++
  return m
}

// ------------------------------------------------------------- distributions

export type DistId = 'geometric' | 'zipf' | 'uniform'

export interface Dist {
  /** Smallest value with non-zero probability. */
  min: number
  /** Probabilities for values min, min+1, … (truncated where the tail is negligible). */
  p: Float64Array
}

export function makeDist(id: DistId, param: number): Dist {
  if (id === 'geometric') {
    // P(n) = q (1−q)^n, n ≥ 0, with q = param.
    const q = param
    const out: number[] = []
    let pn = q
    let tail = 1
    for (let n = 0; tail > 1e-12 && n < 400000; n++) {
      out.push(pn)
      tail -= pn
      pn *= 1 - q
    }
    return { min: 0, p: Float64Array.from(out) }
  }
  if (id === 'zipf') {
    // P(n) ∝ 1/n^s on 1…N.
    const N = 100000
    const s = param
    const w = new Float64Array(N)
    let z = 0
    for (let n = 1; n <= N; n++) z += w[n - 1] = n ** -s
    for (let i = 0; i < N; i++) w[i] /= z
    return { min: 1, p: w }
  }
  const N = Math.max(1, Math.round(param))
  return { min: 1, p: new Float64Array(N).fill(1 / N) }
}

export function distEntropy(d: Dist): number {
  let h = 0
  for (const x of d.p) if (x > 0) h -= x * Math.log2(x)
  return h
}

/**
 * Expected code length when each value v of the distribution is sent as
 * v − d.min + code.min — every code gets the values shifted to its own origin.
 */
export function expectedLength(code: IntCode, d: Dist, param: number): number {
  let e = 0
  for (let i = 0; i < d.p.length; i++) if (d.p[i] > 1e-15) e += d.p[i] * codeLength(code, i + code.min, param)
  return e
}

/** The best parameter for a parametrised code on a distribution (exhaustive over a sensible range). */
export function bestParam(code: IntCode, d: Dist): number {
  if (!code.param) return 0
  const range = code.param === 'm' ? 4096 : 24
  let best = code.param === 'm' ? 1 : 0
  let bestLen = Infinity
  for (let p = code.param === 'm' ? 1 : 0; p <= range; p++) {
    const L = expectedLength(code, d, p)
    if (L < bestLen - 1e-12) {
      bestLen = L
      best = p
    } else if (p > 2 * best + 8) break // the cost is unimodal in the parameter
  }
  return best
}
