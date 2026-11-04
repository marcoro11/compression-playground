import { eq, near, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import {
  AC_CODES,
  DC_CODES,
  LUMA_QUANT_K1,
  UNZIGZAG,
  ZIGZAG,
  bin,
  blockSymbols,
  category,
  encodeImage,
  fdct,
  idct,
  quantTable,
} from './jpeg'
import { sphere, zonePlate, noise, SIZE } from './images'

/** T.81 A.3.3, typed straight from the formula — a deliberately slow, independent DCT. */
function naiveFdct(f: ArrayLike<number>): number[] {
  const C = (k: number) => (k === 0 ? 1 / Math.SQRT2 : 1)
  const out: number[] = []
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) s += f[y * 8 + x] * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16)
      out.push(0.25 * C(u) * C(v) * s)
    }
  return out
}

/** T.81 Figure A.6: the zigzag index printed at each natural position. */
const FIGURE_A6 = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39,
  45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
]

/**
 * A minimal baseline greyscale JPEG decoder, written against the marker layout
 * and Annex C/F rather than against the encoder: parse DQT/SOF0/DHT/SOS, undo
 * byte stuffing, Huffman-decode with the tables *read from the file*, and
 * dequantize. Returns the quantized coefficients per block.
 */
function decodeQuantized(file: Uint8Array): { w: number; h: number; table: number[]; blocks: Int32Array[] } {
  let p = 2
  ok(file[0] === 0xff && file[1] === 0xd8, 'missing SOI')
  let table: number[] = []
  let w = 0
  let h = 0
  const huff: Record<number, Map<string, number>> = {}
  let scanStart = -1
  while (p < file.length) {
    ok(file[p] === 0xff, `expected marker at ${p}`)
    const m = file[p + 1]
    const len = (file[p + 2] << 8) | file[p + 3]
    const body = file.subarray(p + 4, p + 2 + len)
    if (m === 0xdb) {
      const t = Array.from(body.subarray(1, 65))
      table = new Array(64)
      t.forEach((q, k) => (table[ZIGZAG[k]] = q))
    } else if (m === 0xc0) {
      h = (body[1] << 8) | body[2]
      w = (body[3] << 8) | body[4]
    } else if (m === 0xc4) {
      const cls = body[0]
      const bits = Array.from(body.subarray(1, 17))
      const vals = Array.from(body.subarray(17))
      // Annex C.2: codes consecutive within a length, shifted left as the length grows.
      const map = new Map<string, number>()
      let code = 0
      let k = 0
      for (let l = 1; l <= 16; l++) {
        for (let i = 0; i < bits[l - 1]; i++) map.set((code++).toString(2).padStart(l, '0'), vals[k++])
        code <<= 1
      }
      huff[cls] = map
    } else if (m === 0xda) {
      scanStart = p + 2 + len
      break
    }
    p += 2 + len
  }
  ok(scanStart > 0, 'no SOS')
  // Unstuff until EOI.
  const data: number[] = []
  let i = scanStart
  for (; i < file.length; i++) {
    if (file[i] === 0xff) {
      if (file[i + 1] === 0x00) {
        data.push(0xff)
        i++
        continue
      }
      break
    }
    data.push(file[i])
  }
  ok(file[i] === 0xff && file[i + 1] === 0xd9 && i + 2 === file.length, 'missing EOI at end')
  let bp = 0
  const bit = () => (data[bp >> 3] >> (7 - (bp++ & 7))) & 1
  const read = (n: number) => {
    let v = 0
    for (let j = 0; j < n; j++) v = (v << 1) | bit()
    return v
  }
  const sym = (cls: number) => {
    let s = ''
    for (let l = 0; l < 16; l++) {
      s += bit()
      const v = huff[cls].get(s)
      if (v !== undefined) return v
    }
    throw new Error('bad huffman code')
  }
  const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v)
  const blocks: Int32Array[] = []
  let dc = 0
  for (let b = 0; b < (w / 8) * (h / 8); b++) {
    const q = new Int32Array(64)
    const t = sym(0x00)
    dc += extend(read(t), t)
    q[0] = dc
    for (let k = 1; k < 64; ) {
      const rs = sym(0x10)
      const r = rs >> 4
      const s = rs & 15
      if (s === 0) {
        if (r === 15) {
          k += 16
          continue
        }
        break
      }
      k += r
      q[ZIGZAG[k]] = extend(read(s), s)
      k++
    }
    blocks.push(q)
  }
  return { w, h, table, blocks }
}

export const checks: Check[] = [
  {
    name: 'zigzag order matches T.81 Figure A.6',
    run() {
      eq(UNZIGZAG, FIGURE_A6)
    },
  },
  {
    name: 'separable DCT equals the T.81 A.3.3 double sum on 200 random blocks',
    run() {
      const r = seeded(3)
      for (let t = 0; t < 200; t++) {
        const f = Array.from({ length: 64 }, () => Math.floor(r() * 256) - 128)
        const a = fdct(f)
        const b = naiveFdct(f)
        for (let i = 0; i < 64; i++) near(a[i], b[i], 1e-9, `coef ${i}`)
      }
    },
  },
  {
    name: 'IDCT(DCT(x)) = x',
    run() {
      const r = seeded(4)
      for (let t = 0; t < 100; t++) {
        const f = Array.from({ length: 64 }, () => r() * 255 - 128)
        const g = idct(fdct(f))
        for (let i = 0; i < 64; i++) near(g[i], f[i], 1e-9)
      }
    },
  },
  {
    name: 'a flat block of value v has DC = 8·(v − 128) and every AC = 0',
    run() {
      for (const v of [0, 37, 128, 200, 255]) {
        const F = fdct(new Array(64).fill(v - 128))
        near(F[0], 8 * (v - 128), 1e-9, `v=${v}`)
        for (let i = 1; i < 64; i++) near(F[i], 0, 1e-9)
      }
    },
  },
  {
    name: 'IJG quality 50 is Annex K Table K.1 exactly; 100 is all ones; 1 saturates at 255',
    run() {
      eq(quantTable(50), LUMA_QUANT_K1)
      eq(quantTable(100), new Array(64).fill(1))
      ok(quantTable(1).every((q) => q === 255), 'quality 1')
      eq(quantTable(75)[0], 8) // 16 × 50% = 8, the familiar "q75" DC step
      eq(quantTable(25)[0], 32)
    },
  },
  {
    name: 'Annex K Huffman codes: EOB = 1010, ZRL = 11111111001, 0x01 = 00, DC categories 0/1/6 = 00/010/1110',
    run() {
      const c = (m: typeof AC_CODES, s: number) => bin(m.get(s)!.code, m.get(s)!.len)
      eq(c(AC_CODES, 0x00), '1010')
      eq(c(AC_CODES, 0xf0), '11111111001')
      eq(c(AC_CODES, 0x01), '00')
      eq(c(AC_CODES, 0x02), '01')
      eq(c(AC_CODES, 0x11), '1100')
      eq(AC_CODES.get(0xfa)!.len, 16)
      eq(c(DC_CODES, 0), '00')
      eq(c(DC_CODES, 1), '010')
      eq(c(DC_CODES, 6), '1110')
      eq(c(DC_CODES, 11), '111111110')
      eq(AC_CODES.size, 162)
    },
  },
  {
    name: 'categories and one’s-complement extra bits (T.81 F.1.2.1)',
    run() {
      eq([0, 1, -1, 2, 3, -3, 4, 255, -1023].map(category), [0, 1, 1, 2, 2, 2, 3, 8, 10])
      const q = new Array(64).fill(0)
      q[0] = -3
      q[8] = 5 // natural index 8 = row 1, col 0 = zigzag position 2
      const syms = blockSymbols(q, 0)
      eq(syms[0].extra, '00') // −3 in 2 bits → 00
      eq(syms[1].kind, 'AC')
      eq(syms[1].run, 1) // zigzag k=1 is 0, k=2 is the 5
      eq(syms[1].extra, '101')
    },
  },
  {
    name: 'a run of 20 zeros is coded as ZRL then (4, size); trailing zeros as one EOB',
    run() {
      const q = new Array(64).fill(0)
      q[ZIGZAG[21]] = 1
      const s = blockSymbols(q, 0)
      eq(
        s.map((x) => x.kind),
        ['DC', 'ZRL', 'AC', 'EOB'],
      )
      eq(s[2].symbol, 0x41)
      const full = blockSymbols(Array.from({ length: 64 }, (_, i) => (i ? 1 : 0)), 0)
      ok(!full.some((x) => x.kind === 'EOB'), 'no EOB when coefficient 63 is non-zero')
    },
  },
  {
    name: 'the written .jpg parses and decodes back to exactly the encoder’s coefficients',
    run() {
      for (const [name, img] of [
        ['sphere', sphere()],
        ['zone plate', zonePlate()],
        ['noise', noise()],
      ] as const) {
        for (const q of [5, 50, 95, 100]) {
          const e = encodeImage(img, SIZE, SIZE, q)
          const d = decodeQuantized(e.file)
          eq([d.w, d.h], [SIZE, SIZE])
          eq(d.table, e.table, `${name} q${q} table`)
          eq(d.blocks.length, e.blocks.length)
          for (let b = 0; b < d.blocks.length; b++) eq(Array.from(d.blocks[b]), Array.from(e.blocks[b].q), `${name} q${q} block ${b}`)
          // The file is the scan plus 330 bytes of markers and tables (+ stuffing).
          ok(e.file.length >= Math.ceil(e.scanBits / 8) + 330, `header size ${e.file.length - Math.ceil(e.scanBits / 8)}`)
        }
      }
    },
  },
  {
    name: 'quality behaves: smooth image beats noise, PSNR rises with quality, q100 is near-lossless',
    run() {
      const s = sphere()
      const n = noise()
      const lo = encodeImage(s, SIZE, SIZE, 10)
      const hi = encodeImage(s, SIZE, SIZE, 90)
      ok(hi.psnr > lo.psnr + 5, `psnr ${lo.psnr} → ${hi.psnr}`)
      ok(hi.scanBits > lo.scanBits, 'more bits at higher quality')
      ok(encodeImage(n, SIZE, SIZE, 50).scanBits > 4 * encodeImage(s, SIZE, SIZE, 50).scanBits, 'noise costs far more')
      ok(encodeImage(s, SIZE, SIZE, 100).psnr > 50, 'q100')
    },
  },
]
