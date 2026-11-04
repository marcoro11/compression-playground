/**
 * PNG's five scanline filters (PNG spec §9.2, RFC 2083 §6).
 *
 * PNG never hands pixels to DEFLATE. Each scanline is first replaced by the
 * difference between every byte and a *prediction* of it built from bytes the
 * decoder already has:
 *
 *        c  b          c = the byte one pixel up-left
 *        a  x          b = the byte directly above
 *                      a = the byte one pixel to the left
 *
 *   0 None     predict 0
 *   1 Sub      predict a
 *   2 Up       predict b
 *   3 Average  predict ⌊(a + b) / 2⌋
 *   4 Paeth    predict whichever of a, b, c is closest to a + b − c
 *
 * Everything is bytewise and modulo 256, and "one pixel left" means `bpp` bytes
 * left (3 for RGB, 4 for RGBA), so red is predicted from red and so on. Bytes
 * off the left edge or above the first row count as 0. Each filtered row is
 * prefixed by one byte saying which filter it used, so the encoder can choose
 * per row.
 */

import { deflateRaw } from '../deflate/encoder'

export type FilterType = 0 | 1 | 2 | 3 | 4
export const FILTER_NAMES = ['None', 'Sub', 'Up', 'Average', 'Paeth'] as const
export const FILTERS: FilterType[] = [0, 1, 2, 3, 4]

export type Strategy = FilterType | 'adaptive' | 'trial'

/** Alan Paeth's predictor, exactly as the spec writes it (ties: a, then b, then c). */
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** The full Paeth decision, for explaining it. */
export function paethDetail(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  const pick: 'a' | 'b' | 'c' = pa <= pb && pa <= pc ? 'a' : pb <= pc ? 'b' : 'c'
  return { p, pa, pb, pc, pick, value: pick === 'a' ? a : pick === 'b' ? b : c }
}

/** What filter `t` predicts for a byte with neighbours a (left), b (up), c (up-left). */
export function predict(t: FilterType, a: number, b: number, c: number): number {
  switch (t) {
    case 0:
      return 0
    case 1:
      return a
    case 2:
      return b
    case 3:
      return (a + b) >>> 1
    case 4:
      return paeth(a, b, c)
  }
}

/**
 * Filter one scanline. `prev` is the previous *raw* (unfiltered) scanline, or
 * null for the first row. Returns the filtered bytes without the type byte.
 */
export function filterRow(t: FilterType, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out = new Uint8Array(cur.length)): Uint8Array {
  const n = cur.length
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    out[i] = (cur[i] - predict(t, a, b, c)) & 0xff
  }
  return out
}

/** Inverse of `filterRow`: rebuild a raw scanline in place from left to right. */
export function unfilterRow(t: FilterType, filtered: Uint8Array, prev: Uint8Array | null, bpp: number, out = new Uint8Array(filtered.length)): Uint8Array {
  const n = filtered.length
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? out[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    out[i] = (filtered[i] + predict(t, a, b, c)) & 0xff
  }
  return out
}

/**
 * libpng's heuristic: treat each filtered byte as signed (−128…127) and pick
 * the filter whose row has the smallest sum of absolute values. Cheap, and it
 * works because small residuals are what DEFLATE's Huffman stage likes.
 */
export function msad(row: Uint8Array): number {
  let s = 0
  for (let i = 0; i < row.length; i++) s += row[i] < 128 ? row[i] : 256 - row[i]
  return s
}

export interface Filtered {
  /** The IDAT payload before compression: per row, a type byte then the filtered bytes. */
  data: Uint8Array
  /** Filter chosen for each row. */
  types: FilterType[]
  /** Per row, the MSAD score of each of the five filters (for the explanation). */
  scores: number[][]
}

/** Split an image buffer into raw scanlines. */
export function scanlines(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array[] {
  const stride = width * bpp
  const rows: Uint8Array[] = []
  for (let y = 0; y < height; y++) rows.push(pixels.subarray(y * stride, (y + 1) * stride))
  return rows
}

/**
 * Filter a whole image.
 *
 *  - a fixed filter type: every row uses it;
 *  - 'adaptive': per row, minimum sum of absolute differences (libpng);
 *  - 'trial': per row, compress each candidate right after the previous chosen
 *    row and keep the smallest — a cheap, local version of what optipng and
 *    zopflipng do by brute force over the whole file.
 */
export function filterImage(pixels: Uint8Array, width: number, height: number, bpp: number, strategy: Strategy): Filtered {
  const stride = width * bpp
  const rows = scanlines(pixels, width, height, bpp)
  const data = new Uint8Array(height * (stride + 1))
  const types: FilterType[] = []
  const scores: number[][] = []
  const cands = FILTERS.map(() => new Uint8Array(stride))
  let prevChosen: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const prev = y > 0 ? rows[y - 1] : null
    for (const t of FILTERS) filterRow(t, rows[y], prev, bpp, cands[t])
    const sc = FILTERS.map((t) => msad(cands[t]))
    scores.push(sc)
    let t: FilterType
    if (typeof strategy === 'number') t = strategy
    else if (strategy === 'adaptive') {
      t = 0
      for (const k of FILTERS) if (sc[k] < sc[t]) t = k
    } else {
      t = 0
      let best = Infinity
      for (const k of FILTERS) {
        const buf = new Uint8Array((prevChosen?.length ?? 0) + stride + 1)
        if (prevChosen) buf.set(prevChosen)
        buf[prevChosen?.length ?? 0] = k
        buf.set(cands[k], (prevChosen?.length ?? 0) + 1)
        const size = deflateRaw(buf, { lazy: false, maxChain: 16 }).length
        if (size < best) {
          best = size
          t = k
        }
      }
    }
    types.push(t)
    const off = y * (stride + 1)
    data[off] = t
    data.set(cands[t], off + 1)
    prevChosen = data.subarray(off, off + stride + 1)
  }
  return { data, types, scores }
}

/** Inverse of `filterImage`: the decoder side. */
export function unfilterImage(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  let prev: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1)
    const t = data[off]
    if (t > 4) throw new Error(`row ${y}: invalid filter type ${t}`)
    const row = out.subarray(y * stride, (y + 1) * stride)
    unfilterRow(t as FilterType, data.subarray(off + 1, off + 1 + stride), prev, bpp, row)
    prev = row
  }
  return out
}

/** The filtered bytes without the per-row type bytes, laid out like the image (for drawing). */
export function residualPlane(f: Filtered, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) out.set(f.data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  return out
}

/** 256-bin histogram. */
export function histogram(bytes: Uint8Array): number[] {
  const h = new Array<number>(256).fill(0)
  for (let i = 0; i < bytes.length; i++) h[bytes[i]]++
  return h
}
