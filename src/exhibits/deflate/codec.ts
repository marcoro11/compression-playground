import type { Codec } from '../../lib/codec'
import { gunzip, wrap } from './container'
import { deflateRaw } from './encoder'
import { inflate } from './inflate'

export const deflateCodec: Codec = {
  id: 'deflate',
  name: 'DEFLATE',
  family: 'raw RFC 1951, this site’s encoder (lazy matching, best block type per block)',
  encode: (d) => deflateRaw(d, { block: 'auto', lazy: true }),
  decode: (d) => inflate(d).out,
}

export const gzipCodec: Codec = {
  id: 'gzip',
  name: 'gzip',
  family: 'the same stream in a gzip envelope (+18 bytes: header, CRC-32, size)',
  encode: (d) => wrap('gzip', deflateRaw(d, { block: 'auto', lazy: true }), d).bytes,
  decode: gunzip,
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [deflateCodec, gzipCodec]
