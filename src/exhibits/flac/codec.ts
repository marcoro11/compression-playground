/**
 * The audio coder pointed at arbitrary bytes, for the bench: every byte is read
 * as a signed 8-bit sample (b − 128), and each 4096-sample block gets the best of
 * constant, verbatim and FLAC's fixed predictors of order 0–4, with partitioned
 * Rice-coded residuals (partition order ≤ 6). No LPC — the point is how far plain
 * "the next byte is near the last few" gets. Layout: see `encodeStream`.
 */
import type { Codec } from '../../lib/codec'
import { decodeStream, encodeStream } from './flac'

export function flacBytesEncode(data: Uint8Array): Uint8Array {
  const x = Int32Array.from(data, (b) => b - 128)
  return encodeStream(x, { bps: 8, blockSize: 4096, mode: 'auto', maxLpc: 0, maxPo: 6, precision: 12 }).bytes
}

export function flacBytesDecode(data: Uint8Array): Uint8Array {
  const { samples } = decodeStream(data)
  return Uint8Array.from(samples, (s) => s + 128)
}

export const flacCodec: Codec = {
  id: 'flac',
  name: 'FLAC-style',
  family: 'bytes as 8-bit samples: fixed predictor 0–4 per block + partitioned Rice',
  encode: flacBytesEncode,
  decode: flacBytesDecode,
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [flacCodec]
