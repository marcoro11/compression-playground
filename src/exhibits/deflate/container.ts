/**
 * The envelopes around a raw DEFLATE stream.
 *
 *   zlib (RFC 1950): 2-byte header (CMF, FLG), the stream, Adler-32 big-endian.
 *   gzip (RFC 1952): 10-byte header (magic 1f 8b, method 8, flags, mtime, xfl,
 *                    OS), the stream, CRC-32 and the input size mod 2³², both
 *                    little-endian.
 *
 * PNG uses the zlib envelope; .gz files and HTTP `Content-Encoding: gzip` use gzip;
 * ZIP stores raw DEFLATE with its own headers.
 */

import { adler32, crc32 } from './checksum'
import { inflate } from './inflate'

export type Container = 'raw' | 'zlib' | 'gzip'

export interface Field {
  /** Byte offset in the wrapped output. */
  start: number
  length: number
  label: string
  kind: 'head' | 'body' | 'tail'
}

export function wrap(container: Container, raw: Uint8Array, data: Uint8Array): { bytes: Uint8Array; fields: Field[]; bodyOffset: number } {
  if (container === 'raw') return { bytes: raw, fields: [{ start: 0, length: raw.length, label: 'DEFLATE stream', kind: 'body' }], bodyOffset: 0 }
  if (container === 'zlib') {
    const a = adler32(data)
    const out = new Uint8Array(2 + raw.length + 4)
    out[0] = 0x78 // CMF: method 8 (deflate), CINFO 7 (32 KiB window)
    out[1] = 0x9c // FLG: level hint 2 (default), FCHECK so (CMF·256 + FLG) % 31 = 0
    out.set(raw, 2)
    const t = 2 + raw.length
    out[t] = a >>> 24
    out[t + 1] = (a >>> 16) & 0xff
    out[t + 2] = (a >>> 8) & 0xff
    out[t + 3] = a & 0xff
    return {
      bytes: out,
      bodyOffset: 2,
      fields: [
        { start: 0, length: 1, label: 'CMF 0x78: method 8 = deflate, window 2^(7+8) = 32 KiB', kind: 'head' },
        { start: 1, length: 1, label: 'FLG 0x9c: default compression hint; 0x789c is divisible by 31 (the header check)', kind: 'head' },
        { start: 2, length: raw.length, label: 'DEFLATE stream', kind: 'body' },
        { start: t, length: 4, label: `Adler-32 of the input = 0x${a.toString(16).padStart(8, '0')} (big-endian)`, kind: 'tail' },
      ],
    }
  }
  const c = crc32(data)
  const n = data.length >>> 0
  const out = new Uint8Array(10 + raw.length + 8)
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0)
  out.set(raw, 10)
  const t = 10 + raw.length
  for (let i = 0; i < 4; i++) out[t + i] = (c >>> (8 * i)) & 0xff
  for (let i = 0; i < 4; i++) out[t + 4 + i] = (n >>> (8 * i)) & 0xff
  return {
    bytes: out,
    bodyOffset: 10,
    fields: [
      { start: 0, length: 2, label: 'magic 1f 8b: “this is gzip”', kind: 'head' },
      { start: 2, length: 1, label: 'CM = 8: deflate', kind: 'head' },
      { start: 3, length: 1, label: 'FLG = 0: no file name, comment or extra field', kind: 'head' },
      { start: 4, length: 4, label: 'MTIME = 0: no timestamp', kind: 'head' },
      { start: 8, length: 1, label: 'XFL = 0', kind: 'head' },
      { start: 9, length: 1, label: 'OS = 255: unknown', kind: 'head' },
      { start: 10, length: raw.length, label: 'DEFLATE stream', kind: 'body' },
      { start: t, length: 4, label: `CRC-32 of the input = 0x${c.toString(16).padStart(8, '0')} (little-endian)`, kind: 'tail' },
      { start: t + 4, length: 4, label: `ISIZE = ${n}: input length mod 2³² (little-endian)`, kind: 'tail' },
    ],
  }
}

export function gunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) throw new Error('gunzip: not a gzip stream')
  const flg = bytes[3]
  let p = 10
  if (flg & 4) p += 2 + (bytes[p] | (bytes[p + 1] << 8)) // FEXTRA
  if (flg & 8) while (bytes[p++] !== 0); // FNAME
  if (flg & 16) while (bytes[p++] !== 0); // FCOMMENT
  if (flg & 2) p += 2 // FHCRC
  const { out, consumed } = inflate(bytes.subarray(p))
  const t = p + consumed
  const crc = (bytes[t] | (bytes[t + 1] << 8) | (bytes[t + 2] << 16) | (bytes[t + 3] << 24)) >>> 0
  const isize = (bytes[t + 4] | (bytes[t + 5] << 8) | (bytes[t + 6] << 16) | (bytes[t + 7] << 24)) >>> 0
  if (crc !== crc32(out)) throw new Error('gunzip: CRC-32 mismatch')
  if (isize !== out.length >>> 0) throw new Error('gunzip: ISIZE mismatch')
  return out
}

export function unzlib(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 6 || (bytes[0] & 15) !== 8 || ((bytes[0] << 8) | bytes[1]) % 31 !== 0) throw new Error('zlib: bad header')
  if (bytes[1] & 0x20) throw new Error('zlib: preset dictionary not supported')
  const { out, consumed } = inflate(bytes.subarray(2))
  const t = 2 + consumed
  const a = ((bytes[t] << 24) | (bytes[t + 1] << 16) | (bytes[t + 2] << 8) | bytes[t + 3]) >>> 0
  if (a !== adler32(out)) throw new Error('zlib: Adler-32 mismatch')
  return out
}
