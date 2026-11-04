/**
 * The constant tables of RFC 1951 §3.2.5–3.2.7.
 *
 * Lengths 3…258 and distances 1…32768 are far too many values to give each its
 * own Huffman code, so both are bucketed: a code says which bucket, and a few
 * raw "extra bits" after it say where in the bucket. Buckets double in width as
 * values grow, because long matches and far distances are rarer and the exact
 * value matters less to the statistics.
 */

import { canonicalCodes } from '../../lib/huffman'

/** Length codes 257…285: base length and number of extra bits. */
export const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
export const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]

/** Distance codes 0…29. */
export const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
export const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

/**
 * The order the 19 code-length-code lengths are sent in. The symbols most
 * likely to be unused (very long and very short lengths) come last, so the
 * encoder can drop a trailing run of zeros and send fewer than 19 (HCLEN).
 */
export const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** Extra bits after code-length symbols 16, 17, 18. */
export const CL_EXTRA: Record<number, number> = { 16: 2, 17: 3, 18: 7 }

/** Length → index into LEN_BASE (code = 257 + index). Precomputed for 3…258. */
const LEN_INDEX = new Uint8Array(259)
for (let i = 0; i < LEN_BASE.length; i++) {
  const hi = i + 1 < LEN_BASE.length ? LEN_BASE[i + 1] : 259
  for (let l = LEN_BASE[i]; l < hi && l <= 258; l++) LEN_INDEX[l] = i
}
LEN_INDEX[258] = 28 // 258 has its own code (285), even though 227 + 31 would reach it

export function lengthCode(len: number): { code: number; index: number; extra: number; extraBits: number; base: number } {
  const index = LEN_INDEX[len]
  return { code: 257 + index, index, base: LEN_BASE[index], extra: len - LEN_BASE[index], extraBits: LEN_EXTRA[index] }
}

export function distCode(dist: number): { code: number; extra: number; extraBits: number; base: number } {
  let code = DIST_BASE.length - 1
  while (DIST_BASE[code] > dist) code--
  return { code, base: DIST_BASE[code], extra: dist - DIST_BASE[code], extraBits: DIST_EXTRA[code] }
}

/** The fixed Huffman code (BTYPE 01), RFC 1951 §3.2.6. */
export const FIXED_LIT_LENGTHS: number[] = (() => {
  const l: number[] = []
  for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)
  return l
})()
export const FIXED_DIST_LENGTHS: number[] = new Array(30).fill(5)
export const FIXED_LIT_CODES = canonicalCodes(FIXED_LIT_LENGTHS)
export const FIXED_DIST_CODES = canonicalCodes(FIXED_DIST_LENGTHS)

/** "11–12" / "258" — the values a bucket covers. */
export function rangeLabel(base: number, extraBits: number): string {
  if (extraBits === 0) return String(base)
  return `${base}–${base + (1 << extraBits) - 1}`
}
