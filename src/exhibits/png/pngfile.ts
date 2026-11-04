/**
 * Writing a real PNG file (ISO/IEC 15948, RFC 2083) from scratch.
 *
 *   89 50 4E 47 0D 0A 1A 0A          the signature
 *   ┌ length (4, big-endian) ┐
 *   │ type   (4, ASCII)      │        one chunk; the file is just a list of these
 *   │ data   (length bytes)  │
 *   └ CRC-32 of type + data  ┘
 *
 * Three chunks are enough: IHDR (size and pixel format), IDAT (the zlib stream
 * of filtered scanlines) and IEND. The zlib stream comes from this site's own
 * DEFLATE encoder, and the CRC from its CRC-32 — the same polynomial gzip uses.
 */

import { crc32 } from '../deflate/checksum'
import { wrap } from '../deflate/container'
import { deflateRaw } from '../deflate/encoder'
import { filterImage, type Filtered, type Strategy } from './filters'

export const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface ChunkInfo {
  type: string
  /** Byte offset of the chunk's length field in the file. */
  offset: number
  /** Length of the data part. */
  length: number
  crc: number
  note: string
}

export interface PngFile {
  bytes: Uint8Array
  chunks: ChunkInfo[]
  filtered: Filtered
  /** Size of the zlib stream inside IDAT. */
  zlibBytes: number
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

function chunk(type: string, data: Uint8Array): { bytes: Uint8Array; crc: number } {
  const td = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i)
  td.set(data, 4)
  const crc = crc32(td)
  const out = new Uint8Array(8 + data.length + 4)
  out.set(u32(data.length), 0)
  out.set(td, 4)
  out.set(u32(crc), 8 + data.length)
  return { bytes: out, crc }
}

/** zlib stream of the filtered scanlines, using this site's DEFLATE. */
export function zlibOf(data: Uint8Array): Uint8Array {
  return wrap('zlib', deflateRaw(data), data).bytes
}

/**
 * Encode 8-bit RGB (colorType 2, 3 bytes per pixel) or RGBA (colorType 6, 4)
 * pixels, row-major, as a complete PNG file.
 */
export function writePng(pixels: Uint8Array, width: number, height: number, colorType: 2 | 6, strategy: Strategy, filtered?: Filtered): PngFile {
  const bpp = colorType === 6 ? 4 : 3
  const f = filtered ?? filterImage(pixels, width, height, bpp, strategy)
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, colorType, 0, 0, 0])
  const z = zlibOf(f.data)
  const parts = [
    { type: 'IHDR', data: ihdr, note: `${width} × ${height}, 8 bits per channel, colour type ${colorType} (${colorType === 6 ? 'RGBA' : 'RGB'}), deflate, adaptive filtering, not interlaced` },
    { type: 'IDAT', data: z, note: `zlib stream: ${f.data.length.toLocaleString('en-US')} bytes of filtered scanlines → ${z.length.toLocaleString('en-US')}` },
    { type: 'IEND', data: new Uint8Array(0), note: 'end of file — no data, but it still carries a CRC' },
  ]
  const chunks: ChunkInfo[] = []
  const bufs: Uint8Array[] = [SIGNATURE]
  let off = SIGNATURE.length
  for (const p of parts) {
    const c = chunk(p.type, p.data)
    chunks.push({ type: p.type, offset: off, length: p.data.length, crc: c.crc, note: p.note })
    bufs.push(c.bytes)
    off += c.bytes.length
  }
  const bytes = new Uint8Array(off)
  let o = 0
  for (const b of bufs) {
    bytes.set(b, o)
    o += b.length
  }
  return { bytes, chunks, filtered: f, zlibBytes: z.length }
}
