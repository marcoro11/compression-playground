/** Bytes in and out of strings, and how to show a byte to a person. */

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: false })

export const utf8 = (s: string): Uint8Array => enc.encode(s)
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b)

export const hex2 = (b: number): string => b.toString(16).padStart(2, '0')

export function toHex(bytes: ArrayLike<number>, sep = ' '): string {
  return Array.from(bytes as ArrayLike<number>, hex2).join(sep)
}

/**
 * A byte as a single readable glyph. Printable ASCII shows as itself, a few
 * control characters get the conventional visible stand-ins, and everything
 * else falls back to two hex digits.
 */
export function glyph(b: number): string {
  if (b === 0x20) return '␣'
  if (b === 0x0a) return '↵'
  if (b === 0x09) return '⇥'
  if (b === 0x0d) return '␍'
  if (b === 0x00) return '␀'
  if (b > 0x20 && b < 0x7f) return String.fromCharCode(b)
  return hex2(b)
}

/** True when `glyph` would fall back to hex. */
export const isOpaque = (b: number): boolean => !(b >= 0x20 && b < 0x7f) && b !== 0x0a && b !== 0x09 && b !== 0x0d && b !== 0

/** Integer with thin-space thousands separators. */
export function int(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Fixed-point with sensible handling of NaN/∞. */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '−∞' : '—'
  return n.toFixed(digits)
}

/** A ratio as a percentage, e.g. 0.4213 → "42.1%". */
export const pct = (x: number, digits = 1): string => (Number.isFinite(x) ? (x * 100).toFixed(digits) + '%' : '—')

/** Bits as a human size: 13 bits, 412 B, 1.2 KiB. */
export function bitsLabel(bits: number): string {
  if (bits < 64) return `${Math.round(bits)} bits`
  const bytes = bits / 8
  if (bytes < 1024) return `${bytes.toFixed(bytes < 10 ? 1 : 0)} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}
