import type { Codec } from '../../lib/codec'
import { decode } from './decoder'
import { encode } from './encoder'

/**
 * A real .zst frame from this site's encoder: single segment, no checksum
 * (the BigInt XXH64 is the slow part, and the bench times things).
 * Node's own zstd decodes every one of these — `npm run verify zstd`.
 */
export const zstdCodec: Codec = {
  id: 'zstd',
  name: 'Zstandard',
  family: 'RFC 8878 frame from this site’s encoder: LZ77 + repeat offsets, Huffman literals, FSE sequences',
  encode: (d) => encode(d, { effort: 'default' }).bytes,
  decode: (d) => decode(d).out,
}

export const codecs: Codec[] = [zstdCodec]
