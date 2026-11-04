/**
 * LZW as a file, in the style of Unix `compress`:
 *
 *   u32 LE   original length n
 *   codes, MSB-first, 9 to 12 bits wide (see lzw.ts for when the width grows),
 *   code 256 = CLEAR (table full: reset to 9 bits), zero-padded to a byte.
 *
 * The decoder stops after n bytes, so no end code is needed.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { readLength, withLength, type Codec } from '../../lib/codec'
import { CLEAR, firstFree, widthFor, type LzwParams } from './lzw'

export const LZW_PARAMS: LzwParams = { maxWidth: 12, policy: 'reset' }

/** Fast encoder: same algorithm as `encodeTrace`, without the trace. */
export function lzwCodes(data: Uint8Array, p: LzwParams = LZW_PARAMS): { code: number; width: number }[] {
  const out: { code: number; width: number }[] = []
  if (data.length === 0) return out
  const limit = 1 << p.maxWidth
  const first = firstFree(p.policy)
  const dict = new Map<number, number>()
  let next = first
  let w = data[0]
  for (let i = 1; i < data.length; i++) {
    const c = data[i]
    const key = w * 256 + c
    const hit = dict.get(key)
    if (hit !== undefined) {
      w = hit
      continue
    }
    const width = widthFor(next - 1, p.maxWidth)
    out.push({ code: w, width })
    if (next < limit) dict.set(key, next++)
    else if (p.policy === 'reset') {
      out.push({ code: CLEAR, width })
      dict.clear()
      next = first
    }
    w = c
  }
  out.push({ code: w, width: widthFor(next - 1, p.maxWidth) })
  return out
}

export function lzwEncode(data: Uint8Array): Uint8Array {
  const bw = new BitWriter('msb')
  for (const { code, width } of lzwCodes(data)) bw.writeBits(code, width)
  return withLength(data.length, bw.finish())
}

export function lzwDecode(input: Uint8Array, p: LzwParams = LZW_PARAMS): Uint8Array {
  const { n, body } = readLength(input)
  const out = new Uint8Array(n)
  if (n === 0) return out
  const r = new BitReader(body, 'msb')
  const limit = 1 << p.maxWidth
  const first = firstFree(p.policy)
  // Entries as (prefix code, last byte, length): strings are rebuilt backwards on output.
  const prefix = new Int32Array(limit)
  const last = new Uint8Array(limit)
  const len = new Int32Array(limit)
  for (let b = 0; b < 256; b++) {
    prefix[b] = -1
    last[b] = b
    len[b] = 1
  }
  let next = first
  let prev = -1
  let o = 0
  const firstByte = (code: number) => {
    while (prefix[code] >= 0) code = prefix[code]
    return last[code]
  }
  const write = (code: number) => {
    const L = len[code]
    let at = o + L - 1
    let c = code
    while (c >= 0) {
      if (at < n) out[at] = last[c]
      at--
      c = prefix[c]
    }
    o += L
  }
  while (o < n) {
    const width = widthFor(prev >= 0 ? next : next - 1, p.maxWidth)
    const code = r.readBits(width)
    if (p.policy === 'reset' && code === CLEAR) {
      next = first
      prev = -1
      continue
    }
    if (code < next && (code < 256 || code >= first)) {
      if (prev >= 0 && next < limit) {
        prefix[next] = prev
        last[next] = firstByte(code)
        len[next] = len[prev] + 1
        next++
      }
      write(code)
    } else if (code === next && prev >= 0) {
      // KwKwK: the entry being defined is prev + first byte of prev.
      prefix[next] = prev
      last[next] = firstByte(prev)
      len[next] = len[prev] + 1
      next++
      write(code)
    } else throw new Error(`lzw: bad code ${code}`)
    prev = code
  }
  return out
}

export const lzwCodec: Codec = {
  id: 'lzw',
  name: 'LZW',
  family: 'Unix compress style, 9–12 bit codes, CLEAR on full',
  encode: lzwEncode,
  decode: (d) => lzwDecode(d),
}

export const codecs: Codec[] = [lzwCodec]
