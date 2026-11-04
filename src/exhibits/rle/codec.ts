import type { Codec } from '../../lib/codec'
import { naiveDecode, naiveEncode, packbitsDecode, packbitsEncode } from './rle'

/** PackBits needs no length prefix: the packets end exactly where the data does. */
export const packbitsCodec: Codec = {
  id: 'packbits',
  name: 'PackBits',
  family: 'byte RLE with literal escapes — Macintosh, TIFF',
  encode: packbitsEncode,
  decode: packbitsDecode,
}

export const naiveRleCodec: Codec = {
  id: 'rle-naive',
  name: 'Naive RLE',
  family: '⟨count, byte⟩ pairs — doubles anything without runs',
  encode: naiveEncode,
  decode: naiveDecode,
}

export const codecs: Codec[] = [packbitsCodec, naiveRleCodec]
