/**
 * LZSS as a real file format (the classic Okumura layout, bit-packed):
 *
 *   u32 LE   original length n
 *   then tokens, MSB-first, until n bytes are accounted for:
 *     0 bbbbbbbb                 literal byte
 *     1 oooooooooooo llll        match: offset = o + 1 (1…4096), length = l + 3 (3…18)
 *   zero-padded to a byte.
 *
 * 4 KiB window, 18-byte longest match, 3-byte shortest. A match costs 17 bits,
 * so it only wins from 2 bytes up — the minimum of 3 keeps it clearly ahead.
 *
 * Matching uses hash chains over 3-byte prefixes (what zlib does): every
 * position is linked to the previous one with the same hash, so only plausible
 * candidates are examined, newest (closest) first. The chain walk is capped,
 * which makes the parse slightly worse than exhaustive on pathological inputs
 * and is otherwise invisible.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { readLength, withLength, type Codec } from '../../lib/codec'
import type { Token } from './lz77'

export const LZSS_WINDOW = 4096
export const LZSS_MIN = 3
export const LZSS_MAX = 18
const CHAIN_LIMIT = 256
const HASH_BITS = 15

/** Greedy LZSS parse with hash chains. Same tie-break as `parse`: closest of the longest. */
export function lzssTokens(data: Uint8Array, window = LZSS_WINDOW, minMatch = LZSS_MIN, maxMatch = LZSS_MAX, chainLimit = CHAIN_LIMIT): Token[] {
  const n = data.length
  const tokens: Token[] = []
  const head = new Int32Array(1 << HASH_BITS).fill(-1)
  const prev = new Int32Array(Math.max(1, n)).fill(-1)
  const hash = (i: number) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) * 2654435761) >>> (32 - HASH_BITS)
  const insert = (i: number) => {
    if (i + 2 >= n) return
    const h = hash(i)
    prev[i] = head[h]
    head[h] = i
  }

  let i = 0
  while (i < n) {
    let bestLen = 0
    let bestOff = 0
    if (i + 2 < n) {
      const cap = Math.min(maxMatch, n - i)
      let j = head[hash(i)]
      let steps = 0
      while (j >= 0 && i - j <= window && steps++ < chainLimit) {
        if (data[j] === data[i]) {
          let k = 0
          while (k < cap && data[j + k] === data[i + k]) k++
          if (k > bestLen) {
            bestLen = k
            bestOff = i - j
            if (k === cap) break
          }
        }
        j = prev[j]
      }
    }
    if (bestLen >= minMatch) {
      tokens.push({ kind: 'match', pos: i, offset: bestOff, length: bestLen })
      for (let k = 0; k < bestLen; k++) insert(i + k)
      i += bestLen
    } else {
      tokens.push({ kind: 'lit', pos: i, byte: data[i] })
      insert(i)
      i++
    }
  }
  return tokens
}

export function lzssEncode(data: Uint8Array): Uint8Array {
  const w = new BitWriter('msb')
  for (const t of lzssTokens(data)) {
    if (t.kind === 'lit') {
      w.writeBits(0, 1)
      w.writeBits(t.byte, 8)
    } else if (t.kind === 'match') {
      w.writeBits(1, 1)
      w.writeBits(t.offset - 1, 12)
      w.writeBits(t.length - LZSS_MIN, 4)
    }
  }
  return withLength(data.length, w.finish())
}

export function lzssDecode(input: Uint8Array): Uint8Array {
  const { n, body } = readLength(input)
  const out = new Uint8Array(n)
  const r = new BitReader(body, 'msb')
  let o = 0
  while (o < n) {
    if (r.readBit() === 0) {
      out[o++] = r.readBits(8)
    } else {
      const off = r.readBits(12) + 1
      const len = r.readBits(4) + LZSS_MIN
      if (off > o) throw new Error(`lzss: offset ${off} reaches before the start (at ${o})`)
      // Byte by byte, on purpose: the copy may overlap what it is writing.
      for (let k = 0; k < len && o < n; k++, o++) out[o] = out[o - off]
    }
  }
  return out
}

export const lzssCodec: Codec = {
  id: 'lzss',
  name: 'LZSS',
  family: 'LZ77 with flag bits, 4 KiB window, 3–18 byte matches',
  encode: lzssEncode,
  decode: lzssDecode,
}

export const codecs: Codec[] = [lzssCodec]
