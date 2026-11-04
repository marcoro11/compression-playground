/**
 * A complete, honest Huffman file format, so the bench can measure it:
 *
 *   u32 LE   original length n
 *   256 × 4 bits   code length per byte value (0 = absent), max 15
 *   …        canonical codes, MSB-first, zero-padded to a byte
 *
 * The 128-byte table is the price of a static code: on a short input it costs
 * more than the coding saves, and the bench shows exactly that.
 */

import { BitReader, BitWriter } from '../../lib/bits'
import { readLength, withLength, type Codec } from '../../lib/codec'
import { byteCounts } from '../../lib/entropy'
import { CanonicalDecoder, canonicalCodes, limitedLengths } from '../../lib/huffman'

export function huffmanEncode(data: Uint8Array): Uint8Array {
  const lengths = limitedLengths(byteCounts(data), 15)
  const codes = canonicalCodes(lengths)
  const w = new BitWriter('msb')
  for (let s = 0; s < 256; s++) w.writeBits(lengths[s], 4)
  for (let i = 0; i < data.length; i++) w.writeCode(codes[data[i]], lengths[data[i]])
  return withLength(data.length, w.finish())
}

export function huffmanDecode(input: Uint8Array): Uint8Array {
  const { n, body } = readLength(input)
  const r = new BitReader(body, 'msb')
  const lengths: number[] = []
  for (let s = 0; s < 256; s++) lengths.push(r.readBits(4))
  const out = new Uint8Array(n)
  if (n === 0) return out
  const dec = new CanonicalDecoder(lengths)
  const bit = () => r.readBit()
  for (let i = 0; i < n; i++) {
    const s = dec.decodeSymbol(bit)
    if (s < 0) throw new Error('huffman: invalid code')
    out[i] = s
  }
  return out
}

export const huffmanCodec: Codec = {
  id: 'huffman',
  name: 'Huffman',
  family: 'static order-0 Huffman, 128-byte length table',
  encode: huffmanEncode,
  decode: huffmanDecode,
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [huffmanCodec]
