/**
 * The bench's LZMA: a standard .lzma (LZMA_Alone) file — 13-byte header with the
 * known size, then the range-coded stream — exactly what `xz --format=lzma -dc`
 * reads. lc=3 lp=0 pb=2 (the defaults), 1 MiB dictionary, lazy hash-chain parse.
 */
import type { Codec } from '../../lib/codec'
import { decode, encode } from './lzma'

export const lzmaCodec: Codec = {
  id: 'lzma',
  name: 'LZMA',
  family: '.lzma file (xz-compatible), adaptive bit models + range coder, greedy/lazy parse',
  encode: (d) => encode(d).bytes,
  decode,
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [lzmaCodec]
