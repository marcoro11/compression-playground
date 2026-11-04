/**
 * The machinery under a Zstandard block: backward bitstreams, FSE tables
 * (the table-driven ANS from the ANS exhibit), the weight-described Huffman
 * code for literals, and XXH64 for the optional content checksum.
 */

import { BitReader, BitWriter } from '../../lib/bits'

export const highbit = (v: number) => 31 - Math.clz32(v)

// ------------------------------------------------------------ bitstreams

/**
 * A backward bitstream (RFC 8878 §4.1). The encoder appends fields LSB-first and
 * finishes with a single 1 bit; the decoder starts at that last 1 bit and reads
 * *towards the beginning*, so fields come back last-in, first-out. Reading
 * past the start yields zeros — and is how some decoders know they are done.
 */
export class BackReader {
  /** Bit position relative to `start`; bits below it are still unread. */
  pos: number
  constructor(
    private readonly data: Uint8Array,
    private readonly start: number,
    end: number,
  ) {
    if (end <= start) throw new Error('zstd: empty bitstream')
    const last = data[end - 1]
    if (last === 0) throw new Error('zstd: bitstream does not end with a 1 bit')
    this.pos = (end - 1 - start) * 8 + highbit(last)
  }

  peek(n: number): number {
    let v = 0
    const p = this.pos - n
    for (let i = 0; i < n; i++) {
      const b = p + i
      if (b >= 0 && (this.data[this.start + (b >> 3)] >> (b & 7)) & 1) v += 2 ** i
    }
    return v
  }

  read(n: number): number {
    const v = this.peek(n)
    this.pos -= n
    return v
  }

  get overflowed(): boolean {
    return this.pos < 0
  }
}

/** Finish a backward stream: the sentinel 1 bit, then pad to a byte. */
export function closeBackward(w: BitWriter): Uint8Array {
  w.writeBits(1, 1, 'end mark', 'sentinel')
  w.align('pad', 'pad')
  return w.finish()
}

// ------------------------------------------------------------------- FSE

export interface FseCell {
  symbol: number
  nbBits: number
  /** Base of the next state: next = baseline + read(nbBits). */
  baseline: number
}

export interface FseTable {
  log: number
  /** Normalised counts; −1 = "less than 1" (gets one cell at the top). */
  norm: number[]
  cells: FseCell[]
}

/** Decoding table from normalised counts (FSE_buildDTable). */
export function buildFse(norm: number[], log: number): FseTable {
  const size = 1 << log
  const cells: FseCell[] = Array.from({ length: size }, () => ({ symbol: 0, nbBits: 0, baseline: 0 }))
  let high = size - 1
  const next: number[] = []
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) {
      cells[high--].symbol = s
      next[s] = 1
    } else next[s] = norm[s]
  }
  const step = (size >> 1) + (size >> 3) + 3
  const mask = size - 1
  let p = 0
  for (let s = 0; s < norm.length; s++) {
    for (let i = 0; i < norm[s]; i++) {
      cells[p].symbol = s
      do p = (p + step) & mask
      while (p > high)
    }
  }
  if (p !== 0) throw new Error('zstd: FSE spread did not close (counts do not sum to the table size)')
  for (let u = 0; u < size; u++) {
    const s = cells[u].symbol
    const x = next[s]++
    const nb = log - highbit(x)
    cells[u].nbBits = nb
    cells[u].baseline = (x << nb) - size
  }
  return { log, norm, cells }
}

/** A table that always yields one symbol and reads nothing (RLE mode). */
export function rleTable(symbol: number): FseTable {
  return { log: 0, norm: [], cells: [{ symbol, nbBits: 0, baseline: 0 }] }
}

/** Read a normalised-count description (FSE_readNCount). Returns counts, log and bytes used. */
export function readNCount(data: Uint8Array, offset: number, maxSymbol: number, maxLog: number): { norm: number[]; log: number; bytes: number } {
  const r = new BitReader(data.subarray(offset), 'lsb')
  const log = r.readBits(4) + 5
  if (log > maxLog) throw new Error(`zstd: FSE accuracy ${log} above the limit ${maxLog}`)
  let remaining = (1 << log) + 1
  let threshold = 1 << log
  let nbBits = log + 1
  const norm: number[] = []
  let prev0 = false
  while (remaining > 1 && norm.length <= maxSymbol) {
    if (prev0) {
      let rep = r.readBits(2)
      let zeros = rep
      while (rep === 3) {
        rep = r.readBits(2)
        zeros += rep
      }
      for (let i = 0; i < zeros; i++) norm.push(0)
      if (norm.length > maxSymbol) break
    }
    const max = 2 * threshold - 1 - remaining
    let count: number
    const low = r.readBits(nbBits - 1)
    if (low < max) count = low
    else {
      count = low + r.readBits(1) * threshold
      if (count >= threshold) count -= max
    }
    count -= 1
    remaining -= count < 0 ? -count : count
    norm.push(count)
    prev0 = count === 0
    while (remaining < threshold) {
      nbBits--
      threshold >>= 1
    }
  }
  if (remaining !== 1) throw new Error('zstd: FSE counts do not add up')
  return { norm, log, bytes: Math.ceil(r.bitPosition / 8) }
}

/** Write a normalised-count description (FSE_writeNCount). */
export function writeNCount(w: BitWriter, norm: number[], log: number): void {
  w.writeBits(log - 5, 4, 'accuracy log − 5', 'fsedesc')
  let remaining = (1 << log) + 1
  let threshold = 1 << log
  let nbBits = log + 1
  let last = norm.length - 1
  while (last > 0 && norm[last] === 0) last--
  let prev0 = false
  let s = 0
  while (s <= last && remaining > 1) {
    if (prev0) {
      const start = s
      while (s <= last && norm[s] === 0) s++
      let run = s - start
      while (run >= 3) {
        w.writeBits(3, 2, 'zero run', 'fsedesc')
        run -= 3
      }
      w.writeBits(run, 2, 'zero run', 'fsedesc')
    }
    let count = norm[s++]
    const max = 2 * threshold - 1 - remaining
    remaining -= count < 0 ? -count : count
    count += 1
    if (count >= threshold) count += max
    // count < max fits in nbBits−1 bits; otherwise the full nbBits.
    w.writeBits(count, count < max ? nbBits - 1 : nbBits, 'count', 'fsedesc')
    prev0 = count === 1
    while (remaining < threshold) {
      nbBits--
      threshold >>= 1
    }
  }
  if (remaining !== 1) throw new Error('zstd: counts do not sum to the table size')
}

/**
 * Normalise raw counts to sum to 2^log, every present symbol keeping at least 1.
 * Proportional rounding, then the error is settled on the largest counts.
 */
export function normalize(counts: number[], log: number): number[] {
  const size = 1 << log
  let total = 0
  let present = 0
  for (const c of counts) {
    total += c
    if (c > 0) present++
  }
  if (present > size) throw new Error('zstd: too many symbols for this accuracy')
  const norm = counts.map((c) => (c > 0 ? Math.max(1, Math.round((c * size) / total)) : 0))
  let diff = size - norm.reduce((a, b) => a + b, 0)
  const order = norm.map((_, i) => i).sort((a, b) => counts[b] - counts[a])
  let k = 0
  while (diff !== 0) {
    const s = order[k % order.length]
    if (diff > 0) {
      norm[s]++
      diff--
    } else if (norm[s] > 1) {
      norm[s]--
      diff++
    }
    k++
    if (k > 1e6) throw new Error('zstd: normalisation did not converge')
  }
  return norm
}

/**
 * For encoding: cellFor[s][t] = the cell u with symbol s whose range
 * [baseline, baseline + 2^nbBits) contains next state t. Encoding runs
 * backwards, so it always knows the state it has to land on.
 */
export function encodeMap(t: FseTable): Map<number, Int16Array> {
  const size = 1 << t.log
  const m = new Map<number, Int16Array>()
  t.cells.forEach((c, u) => {
    let a = m.get(c.symbol)
    if (!a) m.set(c.symbol, (a = new Int16Array(size).fill(-1)))
    for (let x = c.baseline; x < c.baseline + (1 << c.nbBits); x++) a[x] = u
  })
  return m
}

/**
 * Pick the state sequence that makes a decoder starting at states[0] emit
 * `symbols` in order. Returns the states and, for each transition i → i+1,
 * the bits the decoder will read.
 */
export function chainStates(t: FseTable, map: Map<number, Int16Array>, symbols: number[], lastPick?: (u: number) => boolean): { states: number[]; bits: number[]; nb: number[] } {
  const n = symbols.length
  const states = new Array<number>(n)
  const bits = new Array<number>(Math.max(0, n - 1))
  const nb = new Array<number>(Math.max(0, n - 1))
  if (n === 0) return { states, bits, nb }
  if (t.log === 0) {
    states.fill(0)
    bits.fill(0)
    nb.fill(0)
    return { states, bits, nb }
  }
  const lastSym = symbols[n - 1]
  let u = -1
  for (let i = 0; i < t.cells.length; i++) {
    if (t.cells[i].symbol === lastSym && (!lastPick || lastPick(i))) {
      u = i
      break
    }
  }
  if (u < 0) throw new Error('zstd: symbol not in table')
  states[n - 1] = u
  for (let i = n - 2; i >= 0; i--) {
    const a = map.get(symbols[i])
    const v = a ? a[states[i + 1]] : -1
    if (v === undefined || v < 0) throw new Error('zstd: symbol not in table')
    states[i] = v
    const c = t.cells[v]
    nb[i] = c.nbBits
    bits[i] = states[i + 1] - c.baseline
  }
  return { states, bits, nb }
}

// --------------------------------------------------------------- Huffman

export interface HuffTable {
  maxBits: number
  /** weights[s] for every symbol 0…last (0 = absent). */
  weights: number[]
  /** Code length per symbol (0 = absent). */
  lengths: number[]
  /** Code value per symbol, read MSB-first. */
  codes: number[]
  /** Decoding: index by the next maxBits bits. */
  lookup: { symbol: number; nbBits: number }[]
}

/**
 * Build the table from weights. Symbols fill the maxBits-wide table in order
 * of increasing weight, then increasing symbol, each taking 2^(w−1) entries —
 * so the *longest* codes get the smallest values (RFC 8878 §4.2.2).
 */
export function huffFromWeights(weights: number[]): HuffTable {
  let total = 0
  for (const w of weights) if (w > 0) total += 1 << (w - 1)
  // With the implied last weight included the table is exactly full: total = 2^maxBits.
  const maxBits = highbit(total)
  if (total !== 1 << maxBits) throw new Error('zstd: Huffman weights do not form a complete code')
  if (maxBits > 11) throw new Error('zstd: Huffman code longer than 11 bits')
  const lengths = weights.map((w) => (w > 0 ? maxBits + 1 - w : 0))
  const codes = new Array<number>(weights.length).fill(0)
  const lookup: { symbol: number; nbBits: number }[] = new Array(1 << maxBits)
  let pos = 0
  const maxW = Math.max(...weights)
  for (let w = 1; w <= maxW; w++) {
    for (let s = 0; s < weights.length; s++) {
      if (weights[s] !== w) continue
      const span = 1 << (w - 1)
      codes[s] = pos >> (w - 1)
      for (let k = 0; k < span; k++) lookup[pos + k] = { symbol: s, nbBits: lengths[s] }
      pos += span
    }
  }
  if (pos !== 1 << maxBits) throw new Error('zstd: Huffman weights do not form a complete code')
  return { maxBits, weights, lengths, codes, lookup }
}

/** Given the listed weights, the last symbol's weight is whatever completes the code. */
export function completeWeights(listed: number[]): number[] {
  let total = 0
  for (const w of listed) if (w > 0) total += 1 << (w - 1)
  if (total === 0) throw new Error('zstd: empty Huffman description')
  const maxBits = highbit(total) + 1
  const left = (1 << maxBits) - total
  if (left & (left - 1)) throw new Error('zstd: Huffman weights leave a gap that is not a power of two')
  return [...listed, highbit(left) + 1]
}

/** Lengths (complete prefix code, max 11) → weights. */
export function weightsFromLengths(lengths: number[]): number[] {
  const maxBits = Math.max(...lengths)
  return lengths.map((l) => (l > 0 ? maxBits + 1 - l : 0))
}

// ---------------------------------------------------------------- XXH64

const M64 = (1n << 64n) - 1n
const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M64
const round = (acc: bigint, input: bigint) => (rotl((acc + input * P2) & M64, 31n) * P1) & M64
const mergeRound = (acc: bigint, v: bigint) => (((acc ^ round(0n, v)) * P1) + P4) & M64

function read64(d: Uint8Array, i: number): bigint {
  const lo = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0
  const hi = (d[i + 4] | (d[i + 5] << 8) | (d[i + 6] << 16) | (d[i + 7] << 24)) >>> 0
  return (BigInt(hi) << 32n) | BigInt(lo)
}
const read32 = (d: Uint8Array, i: number) => BigInt((d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0)

/** XXH64 (Yann Collet), the checksum a Zstandard frame may carry. */
export function xxh64(d: Uint8Array, seed = 0n): bigint {
  const n = d.length
  let i = 0
  let h: bigint
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & M64
    let v2 = (seed + P2) & M64
    let v3 = seed
    let v4 = (seed - P1) & M64
    while (i + 32 <= n) {
      v1 = round(v1, read64(d, i))
      v2 = round(v2, read64(d, i + 8))
      v3 = round(v3, read64(d, i + 16))
      v4 = round(v4, read64(d, i + 24))
      i += 32
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64
    h = mergeRound(h, v1)
    h = mergeRound(h, v2)
    h = mergeRound(h, v3)
    h = mergeRound(h, v4)
  } else h = (seed + P5) & M64
  h = (h + BigInt(n)) & M64
  while (i + 8 <= n) {
    h ^= round(0n, read64(d, i))
    h = ((rotl(h, 27n) * P1) + P4) & M64
    i += 8
  }
  if (i + 4 <= n) {
    h ^= (read32(d, i) * P1) & M64
    h = ((rotl(h, 23n) * P2) + P3) & M64
    i += 4
  }
  while (i < n) {
    h ^= (BigInt(d[i]) * P5) & M64
    h = (rotl(h, 11n) * P1) & M64
    i++
  }
  h ^= h >> 33n
  h = (h * P2) & M64
  h ^= h >> 29n
  h = (h * P3) & M64
  h ^= h >> 32n
  return h
}

export { BitWriter }
