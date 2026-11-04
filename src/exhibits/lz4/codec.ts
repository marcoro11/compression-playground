/**
 * LZ4 as the bench sees it: a standard LZ4 frame (lz4_Frame_format.md) with
 * independent 64 KiB blocks and a content checksum — the same bytes the `lz4`
 * command-line tool would accept. Two encoders, one format: the fast
 * single-probe parser, and HC with hash chains.
 */
import type { Codec } from '../../lib/codec'
import { compressFrame, decompressFrame } from './lz4'

export const lz4Codec: Codec = {
  id: 'lz4',
  name: 'LZ4',
  family: 'LZ4 frame, 64 KiB independent blocks, fast single-probe hash parser',
  encode: (d) => compressFrame(d, { mode: 'fast' }).bytes,
  decode: (d) => decompressFrame(d).out,
}

export const lz4hcCodec: Codec = {
  id: 'lz4hc',
  name: 'LZ4 HC',
  family: 'the same frame format, hash-chain parser (64 candidates per position)',
  encode: (d) => compressFrame(d, { mode: 'hc', depth: 64 }).bytes,
  decode: (d) => decompressFrame(d).out,
}

export const codecs: Codec[] = [lz4Codec, lz4hcCodec]
