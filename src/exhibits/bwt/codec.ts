/**
 * A one-block bzip2-shaped format, so the bench can measure the pipeline:
 *
 *   u32 LE    n, original length (0 → nothing follows)
 *   u32 LE    primary index (row of the sorted matrix holding the original)
 *   32 bytes  in-use bitmap: bit b set ⇔ byte b occurs (bzip2 uses a 16×16 one)
 *   then, MSB-first bits:
 *     (m + 2) × 4 bits   code lengths for the alphabet
 *                        RUNA, RUNB, MTF 1 … m−1 (as 2 … m), EOB (m + 1)
 *                        where m = number of bytes in use
 *     …                  canonical Huffman codes for the run-coded MTF stream, then EOB
 *
 * What real bzip2 adds on top: an initial RLE pass (runs of 4–255), 900 kB
 * blocks with CRCs, and up to six Huffman tables switched every 50 symbols.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { readLength, withLength, type Codec } from '../../lib/codec'
import { counts } from '../../lib/entropy'
import { CanonicalDecoder, canonicalCodes, limitedLengths } from '../../lib/huffman'
import { bwtForward, bwtInverse, mtfDecode, mtfEncode, usedSymbols, zeroRunDecode, zeroRunEncode } from './bwt'

export function bwtEncode(data: Uint8Array): Uint8Array {
  const n = data.length
  if (n === 0) return withLength(0, new Uint8Array(0))
  const { last, primary } = bwtForward(data)
  const used = usedSymbols(data)
  const m = used.length
  const syms = zeroRunEncode(mtfEncode(last, used))
  const EOB = m + 1
  syms.push(EOB)
  const lengths = limitedLengths(counts(syms, m + 2), 15)
  const codes = canonicalCodes(lengths)

  const w = new BitWriter('msb')
  w.writeBits(primary & 0xffff, 16)
  w.writeBits(primary >>> 16, 16)
  for (let b = 0; b < 256; b++) w.writeBits(used.includes(b) ? 1 : 0, 1)
  for (let s = 0; s < m + 2; s++) w.writeBits(lengths[s], 4)
  for (const s of syms) w.writeCode(codes[s], lengths[s])
  return withLength(n, w.finish())
}

export function bwtDecode(input: Uint8Array): Uint8Array {
  const { n, body } = readLength(input)
  if (n === 0) return new Uint8Array(0)
  const r = new BitReader(body, 'msb')
  const primary = (r.readBits(16) | (r.readBits(16) << 16)) >>> 0
  const used: number[] = []
  for (let b = 0; b < 256; b++) if (r.readBit()) used.push(b)
  const m = used.length
  const lengths: number[] = []
  for (let s = 0; s < m + 2; s++) lengths.push(r.readBits(4))
  const dec = new CanonicalDecoder(lengths)
  const EOB = m + 1
  const syms: number[] = []
  for (;;) {
    const s = dec.decodeSymbol(() => r.readBit())
    if (s < 0) throw new Error('bwt: invalid code')
    if (s === EOB) break
    syms.push(s)
  }
  const last = mtfDecode(zeroRunDecode(syms), used)
  if (last.length !== n) throw new Error(`bwt: expected ${n} symbols, got ${last.length}`)
  return Uint8Array.from(bwtInverse(last, primary))
}

export const bwtCodec: Codec = {
  id: 'bwt',
  name: 'BWT + MTF + Huffman',
  family: 'bzip2-style: one block, RUNA/RUNB zero runs, one Huffman table',
  encode: bwtEncode,
  decode: bwtDecode,
}

export const codecs: Codec[] = [bwtCodec]
