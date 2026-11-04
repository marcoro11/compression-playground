/**
 * Baseline JPEG (ITU T.81), greyscale, with no DOM in sight so `npm run verify`
 * can run every line of it under Node.
 *
 * The pipeline per 8×8 block:
 *
 *   pixels → −128 → 2-D DCT → ÷ quantization table, round → zigzag
 *          → DC difference + (run, size) symbols → Annex K Huffman codes
 *
 * and back: × table → inverse DCT → +128 → clamp. Rounding after the divide is
 * the only place information is thrown away; everything else is exactly
 * invertible (up to floating point).
 *
 * `encodeImage` also writes a real JFIF file from the same symbols it counts,
 * so the bit total the exhibit shows is the bit total of a file a browser opens.
 */

import { BitWriter } from '../../lib/bits'

export const N = 8

// ------------------------------------------------------------------ zigzag

/**
 * ZIGZAG[k] = natural (row-major) index of the k-th coefficient in zigzag order.
 * Walk the anti-diagonals r + c = s, alternating direction.
 */
export const ZIGZAG: number[] = (() => {
  const out: number[] = []
  for (let s = 0; s < 15; s++) {
    if (s % 2 === 0) for (let r = Math.min(s, 7); r >= Math.max(0, s - 7); r--) out.push(r * 8 + (s - r))
    else for (let r = Math.max(0, s - 7); r <= Math.min(s, 7); r++) out.push(r * 8 + (s - r))
  }
  return out
})()

/** UNZIGZAG[natural index] = zigzag position k. */
export const UNZIGZAG: number[] = (() => {
  const u = new Array<number>(64)
  ZIGZAG.forEach((nat, k) => (u[nat] = k))
  return u
})()

// --------------------------------------------------------------------- DCT

/**
 * The orthonormal 8-point DCT-II matrix, C[u·8 + x] = c(u)·cos((2x+1)uπ/16) with
 * c(0) = √(1/8) and c(u>0) = √(2/8). The 2-D transform is C·f·Cᵀ, and because C is
 * orthonormal its inverse is just the transpose. T.81's ¼·C(u)·C(v) factor is the
 * product of these two per-axis scales.
 */
export const DCT_MATRIX: Float64Array = (() => {
  const m = new Float64Array(64)
  for (let u = 0; u < 8; u++) {
    const c = u === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8)
    for (let x = 0; x < 8; x++) m[u * 8 + x] = c * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  }
  return m
})()

/**
 * Forward 2-D DCT. Input row-major f[y·8 + x]; output F[v·8 + u] with v the
 * vertical and u the horizontal frequency, so F[0] is DC and F[7] the highest
 * purely horizontal frequency. Separable: rows first, then columns.
 */
export function fdct(f: ArrayLike<number>): Float64Array {
  const C = DCT_MATRIX
  const tmp = new Float64Array(64)
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let x = 0; x < 8; x++) s += C[u * 8 + x] * f[y * 8 + x]
      tmp[y * 8 + u] = s
    }
  const out = new Float64Array(64)
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let y = 0; y < 8; y++) s += C[v * 8 + y] * tmp[y * 8 + u]
      out[v * 8 + u] = s
    }
  return out
}

/** Inverse 2-D DCT: F[v·8 + u] → f[y·8 + x]. */
export function idct(F: ArrayLike<number>): Float64Array {
  const C = DCT_MATRIX
  const tmp = new Float64Array(64)
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let v = 0; v < 8; v++) s += C[v * 8 + y] * F[v * 8 + u]
      tmp[y * 8 + u] = s
    }
  const out = new Float64Array(64)
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += C[u * 8 + x] * tmp[y * 8 + u]
      out[y * 8 + x] = s
    }
  return out
}

/** The (v, u) basis image as an 8×8 block, values in [−c, c]. */
export function basis(v: number, u: number): Float64Array {
  const F = new Float64Array(64)
  F[v * 8 + u] = 1
  return idct(F)
}

// ------------------------------------------------------------ quantization

/** ITU T.81 Annex K, Table K.1 — luminance quantization, natural order. */
export const LUMA_QUANT_K1 = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37,
  56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]

/**
 * The IJG (libjpeg) quality → table mapping that nearly every encoder copies:
 * quality 50 is Annex K exactly, below 50 the table scales up as 50/q, above it
 * scales down linearly to all-ones at 100. Clamped to 1…255 for baseline 8-bit tables.
 */
export function quantTable(quality: number): number[] {
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q
  return LUMA_QUANT_K1.map((b) => Math.max(1, Math.min(255, Math.floor((b * scale + 50) / 100))))
}

/** Round half away from zero, as libjpeg's quantizer does. */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.floor(Math.abs(x) + 0.5)

// ----------------------------------------------------------------- Huffman

/** Annex K, Table K.3 — luminance DC: BITS (codes of each length 1…16) and HUFFVAL. */
export const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
export const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/** Annex K, Table K.5 — luminance AC. */
export const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
export const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
  0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
  0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
  0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa,
]

export interface HuffCode {
  code: number
  len: number
}

/**
 * Annex C.2: codes are handed out in HUFFVAL order — *not* sorted by symbol —
 * consecutively within a length, shifting left when the length grows.
 */
export function huffCodes(bits: number[], vals: number[]): Map<number, HuffCode> {
  const m = new Map<number, HuffCode>()
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) m.set(vals[k++], { code: code++, len })
    code <<= 1
  }
  return m
}

export const DC_CODES = huffCodes(DC_LUMA_BITS, DC_LUMA_VALS)
export const AC_CODES = huffCodes(AC_LUMA_BITS, AC_LUMA_VALS)

/** SSSS: the number of bits needed for |v| (0 for v = 0). */
export function category(v: number): number {
  let a = Math.abs(v)
  let n = 0
  while (a) {
    n++
    a >>>= 1
  }
  return n
}

/** The `size` extra bits that follow a symbol: v itself if positive, v − 1 in `size` bits (one's complement) if negative. */
export function extraBits(v: number, size: number): number {
  return v >= 0 ? v : (v + (1 << size) - 1) & ((1 << size) - 1)
}

export const bin = (v: number, w: number): string => (w <= 0 ? '' : (v >>> 0).toString(2).padStart(w, '0').slice(-w))

export interface Sym {
  kind: 'DC' | 'AC' | 'ZRL' | 'EOB'
  /** Zigzag position the symbol lands on (for EOB: where coding stopped). */
  k: number
  /** Zeros skipped before this coefficient. */
  run: number
  /** Coefficient value (DC: the difference). */
  value: number
  size: number
  /** The Huffman symbol byte: DC = size, AC = run·16 + size. */
  symbol: number
  code: string
  extra: string
  bits: number
}

/**
 * Entropy-code one quantized block (natural order) given the previous block's DC.
 * Returns the symbol list exactly as it is written to the file.
 */
export function blockSymbols(q: ArrayLike<number>, prevDC: number): Sym[] {
  const out: Sym[] = []
  const diff = q[0] - prevDC
  const ds = category(diff)
  const dc = DC_CODES.get(ds)!
  out.push({ kind: 'DC', k: 0, run: 0, value: diff, size: ds, symbol: ds, code: bin(dc.code, dc.len), extra: bin(extraBits(diff, ds), ds), bits: dc.len + ds })

  let last = 0
  for (let k = 63; k >= 1; k--)
    if (q[ZIGZAG[k]] !== 0) {
      last = k
      break
    }
  let run = 0
  for (let k = 1; k <= last; k++) {
    const v = q[ZIGZAG[k]]
    if (v === 0) {
      run++
      continue
    }
    while (run > 15) {
      const z = AC_CODES.get(0xf0)!
      out.push({ kind: 'ZRL', k: k - run + 15, run: 16, value: 0, size: 0, symbol: 0xf0, code: bin(z.code, z.len), extra: '', bits: z.len })
      run -= 16
    }
    const size = category(v)
    const sym = (run << 4) | size
    const c = AC_CODES.get(sym)!
    out.push({ kind: 'AC', k, run, value: v, size, symbol: sym, code: bin(c.code, c.len), extra: bin(extraBits(v, size), size), bits: c.len + size })
    run = 0
  }
  if (last < 63) {
    const e = AC_CODES.get(0x00)!
    out.push({ kind: 'EOB', k: last + 1, run: 63 - last, value: 0, size: 0, symbol: 0, code: bin(e.code, e.len), extra: '', bits: e.len })
  }
  return out
}

// ------------------------------------------------------------ whole image

export interface Block {
  bx: number
  by: number
  /** Original pixels, row-major 0…255. */
  pixels: Float64Array
  /** Level-shifted pixels, −128…127. */
  shifted: Float64Array
  /** DCT coefficients, natural order. */
  coef: Float64Array
  /** Quantized integers, natural order. */
  q: Int32Array
  /** Dequantized coefficients. */
  deq: Float64Array
  /** Reconstructed pixels after IDCT, +128 and clamping. */
  recon: Uint8ClampedArray
  prevDC: number
  syms: Sym[]
  bits: number
}

export interface Encoded {
  width: number
  height: number
  quality: number
  table: number[]
  blocks: Block[]
  recon: Uint8ClampedArray
  /** Entropy-coded bits in the scan, before padding and byte stuffing. */
  scanBits: number
  mse: number
  psnr: number
  /** A complete baseline JFIF file. */
  file: Uint8Array
}

/**
 * Encode a greyscale image. Width and height must be multiples of 8 (the
 * exhibit's images always are; a real encoder pads by edge replication).
 */
export function encodeImage(luma: ArrayLike<number>, width: number, height: number, quality: number): Encoded {
  if (width % 8 || height % 8) throw new Error('dimensions must be multiples of 8')
  const table = quantTable(quality)
  const bw = width / 8
  const bh = height / 8
  const recon = new Uint8ClampedArray(width * height)
  const blocks: Block[] = []
  const w = new BitWriter('msb')
  let prevDC = 0
  let scanBits = 0
  let se = 0

  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const pixels = new Float64Array(64)
      const shifted = new Float64Array(64)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const p = luma[(by * 8 + y) * width + bx * 8 + x]
          pixels[y * 8 + x] = p
          shifted[y * 8 + x] = p - 128
        }
      const coef = fdct(shifted)
      const q = new Int32Array(64)
      const deq = new Float64Array(64)
      for (let i = 0; i < 64; i++) {
        q[i] = roundHalfAway(coef[i] / table[i])
        deq[i] = q[i] * table[i]
      }
      const back = idct(deq)
      const r = new Uint8ClampedArray(64)
      for (let i = 0; i < 64; i++) {
        r[i] = Math.round(back[i] + 128)
        const d = r[i] - pixels[i]
        se += d * d
        recon[(by * 8 + (i >> 3)) * width + bx * 8 + (i & 7)] = r[i]
      }
      const syms = blockSymbols(q, prevDC)
      let bits = 0
      for (const s of syms) {
        bits += s.bits
        if (s.code) w.writeBits(parseInt(s.code, 2), s.code.length)
        if (s.extra) w.writeBits(parseInt(s.extra, 2), s.extra.length)
      }
      scanBits += bits
      blocks.push({ bx, by, pixels, shifted, coef, q, deq, recon: r, prevDC, syms, bits })
      prevDC = q[0]
    }

  // Pad the last byte with 1-bits (T.81 F.1.2.3), then stuff a 0x00 after every 0xFF.
  const pad = (8 - (w.bitLength % 8)) % 8
  if (pad) w.writeBits((1 << pad) - 1, pad)
  const raw = w.finish()
  const scan: number[] = []
  for (const b of raw) {
    scan.push(b)
    if (b === 0xff) scan.push(0x00)
  }

  const mse = se / (width * height)
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
  return { width, height, quality, table, blocks, recon, scanBits, mse, psnr, file: jfif(width, height, table, scan) }
}

/** Assemble the marker segments around an entropy-coded scan. */
function jfif(width: number, height: number, table: number[], scan: number[]): Uint8Array {
  const out: number[] = []
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff)
  const seg = (marker: number, body: number[]) => {
    out.push(0xff, marker)
    u16(body.length + 2)
    for (const b of body) out.push(b)
  }
  out.push(0xff, 0xd8) // SOI
  seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]) // APP0 "JFIF\0" v1.1, aspect 1:1, no thumbnail
  seg(0xdb, [0x00, ...ZIGZAG.map((n) => table[n])]) // DQT: 8-bit, table 0, values in zigzag order
  seg(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0]) // SOF0: 1 component, 1×1 sampling, table 0
  seg(0xc4, [0x00, ...DC_LUMA_BITS, ...DC_LUMA_VALS]) // DHT DC 0
  seg(0xc4, [0x10, ...AC_LUMA_BITS, ...AC_LUMA_VALS]) // DHT AC 0
  seg(0xda, [1, 1, 0x00, 0, 63, 0]) // SOS: component 1 uses DC0/AC0, spectral 0…63, no approximation
  for (const b of scan) out.push(b)
  out.push(0xff, 0xd9) // EOI
  return Uint8Array.from(out)
}

/** File bytes that are not entropy-coded data: markers, tables, padding and 0xFF stuffing. */
export const overheadBytes = (e: Encoded): number => e.file.length - Math.floor(e.scanBits / 8)

/** Reconstruct a block from only its first `k` zigzag coefficients (dequantized or raw). */
export function partialRecon(coefs: ArrayLike<number>, k: number): Float64Array {
  const F = new Float64Array(64)
  for (let i = 0; i < k && i < 64; i++) F[ZIGZAG[i]] = coefs[ZIGZAG[i]]
  const f = idct(F)
  for (let i = 0; i < 64; i++) f[i] += 128
  return f
}
