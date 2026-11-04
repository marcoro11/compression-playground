/**
 * Two real ANS formats for the bench.
 *
 *   u32 LE   original length n              (absent body when n = 0)
 *   32 B     bitmap: which byte values occur
 *   …        for each present byte, in order: normalised frequency − 1, LEB128
 *
 * rANS (ryg_rans layout): M = 2^12, state in [2^23, 2^31), renormalised a
 *   byte at a time. Then the final state, 4 bytes big-endian, then the bytes the
 *   encoder shifted out — in reverse, because the decoder pops them as a stack.
 *
 * tANS (FSE layout): L = 2^11 states, Zstandard's spread. Then MSB-first bits:
 *   the final state (11 bits), then each symbol's raw bits in decoding order.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { readLength, withLength, type Codec } from '../../lib/codec'
import { buildTans, normalize, type Tans } from './ans'

// ------------------------------------------------------------ frequency table

function writeTable(freq: number[], out: number[]) {
  const bitmap = new Array<number>(32).fill(0)
  for (let s = 0; s < 256; s++) if (freq[s]) bitmap[s >> 3] |= 1 << (s & 7)
  out.push(...bitmap)
  for (let s = 0; s < 256; s++) {
    if (!freq[s]) continue
    let v = freq[s] - 1
    do {
      const b = v & 0x7f
      v >>>= 7
      out.push(v ? b | 0x80 : b)
    } while (v)
  }
}

function readTable(body: Uint8Array): { freq: number[]; pos: number } {
  if (body.length < 32) throw new Error('ans: truncated table')
  const freq = new Array<number>(256).fill(0)
  let pos = 32
  for (let s = 0; s < 256; s++) {
    if (!(body[s >> 3] & (1 << (s & 7)))) continue
    let v = 0
    let shift = 0
    for (;;) {
      const b = body[pos++]
      if (b === undefined) throw new Error('ans: truncated table')
      v |= (b & 0x7f) << shift
      shift += 7
      if (!(b & 0x80)) break
    }
    freq[s] = v + 1
  }
  return { freq, pos }
}

function histogram(data: Uint8Array): number[] {
  const c = new Array<number>(256).fill(0)
  for (let i = 0; i < data.length; i++) c[data[i]]++
  return c
}

// ----------------------------------------------------------------------- rANS

const SCALE = 12
const M = 1 << SCALE
const RANS_L = 1 << 23

export function ransEncode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return withLength(0, new Uint8Array(0))
  const freq = normalize(histogram(data), M)
  const cum = new Array<number>(256)
  let c = 0
  for (let s = 0; s < 256; s++) {
    cum[s] = c
    c += freq[s]
  }
  const head: number[] = []
  writeTable(freq, head)

  let x = RANS_L
  const out: number[] = []
  for (let i = data.length - 1; i >= 0; i--) {
    const s = data[i]
    const f = freq[s]
    const xmax = ((RANS_L >>> SCALE) << 8) * f
    while (x >= xmax) {
      out.push(x & 0xff)
      x >>>= 8
    }
    x = Math.floor(x / f) * M + (x % f) + cum[s]
  }
  out.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff)
  out.reverse()
  return withLength(data.length, Uint8Array.from([...head, ...out]))
}

export function ransDecode(input: Uint8Array): Uint8Array {
  const { n, body } = readLength(input)
  const res = new Uint8Array(n)
  if (n === 0) return res
  const { freq, pos: p0 } = readTable(body)
  const cum = new Array<number>(256)
  const lookup = new Uint8Array(M)
  let c = 0
  for (let s = 0; s < 256; s++) {
    cum[s] = c
    lookup.fill(s, c, c + freq[s])
    c += freq[s]
  }
  if (c !== M) throw new Error('ans: frequencies do not sum to M')
  let pos = p0
  const byte = () => {
    const b = body[pos++]
    if (b === undefined) throw new Error('rANS: stream ended early')
    return b
  }
  let x = byte() * 0x1000000 + byte() * 0x10000 + byte() * 0x100 + byte()
  for (let i = 0; i < n; i++) {
    const slot = x & (M - 1)
    const s = lookup[slot]
    res[i] = s
    x = freq[s] * Math.floor(x / M) + slot - cum[s]
    while (x < RANS_L) x = x * 256 + byte()
  }
  return res
}

// ----------------------------------------------------------------------- tANS

const R = 11

export function tansEncode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return withLength(0, new Uint8Array(0))
  const t: Tans = buildTans(histogram(data), R)
  const head: number[] = []
  writeTable(t.counts, head)
  // Encode backwards, remembering each raw-bit chunk; write them in decode order.
  const values = new Uint32Array(data.length)
  const widths = new Uint8Array(data.length)
  let x = t.L
  for (let i = data.length - 1; i >= 0; i--) {
    const s = data[i]
    const c = t.counts[s]
    let nb = 0
    while (x >>> nb >= 2 * c) nb++
    values[i] = x & ((1 << nb) - 1)
    widths[i] = nb
    x = t.enc[s][(x >>> nb) - c]
  }
  const w = new BitWriter('msb')
  w.writeBits(x - t.L, R)
  for (let i = 0; i < data.length; i++) w.writeBits(values[i], widths[i])
  return withLength(data.length, Uint8Array.from([...head, ...w.finish()]))
}

export function tansDecode(input: Uint8Array): Uint8Array {
  const { n, body } = readLength(input)
  const res = new Uint8Array(n)
  if (n === 0) return res
  const { freq, pos } = readTable(body)
  // The stored values are already normalised to 2^R, so normalize() returns them unchanged.
  const t = buildTans(freq, R)
  for (let s = 0; s < 256; s++) if (t.counts[s] !== freq[s]) throw new Error('tANS: table is not normalised')
  const r = new BitReader(body.subarray(pos), 'msb')
  let X = r.readBits(R)
  for (let i = 0; i < n; i++) {
    res[i] = t.spread[X]
    X = t.base[X] + r.readBits(t.nbBits[X])
  }
  return res
}

export const ransCodec: Codec = {
  id: 'rans',
  name: 'rANS',
  family: 'static order-0 range ANS, 12-bit frequencies, 32-bit state, byte renormalisation',
  encode: ransEncode,
  decode: ransDecode,
}

export const tansCodec: Codec = {
  id: 'tans',
  name: 'tANS',
  family: 'static order-0 tabled ANS (FSE layout), 2048 states, Zstandard’s spread',
  encode: tansEncode,
  decode: tansDecode,
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [ransCodec, tansCodec]
