import { crc32 as zcrc32, inflateSync } from 'node:zlib'
import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { FILTERS, filterImage, filterRow, paeth, unfilterImage, unfilterRow, type FilterType } from './filters'
import { H, W, noise, photo, pixel, ui } from './images'
import { SIGNATURE, writePng } from './pngfile'

/** PaethPredictor, transcribed from the PNG specification §9.4 — independent of filters.ts. */
function specPaeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  else if (pb <= pc) return b
  else return c
}

/** A from-the-spec decoder: parse chunks, check CRCs with Node's zlib, inflate with Node, unfilter. */
function decodePng(file: Uint8Array): { width: number; height: number; colorType: number; pixels: Uint8Array } {
  for (let i = 0; i < 8; i++) if (file[i] !== [137, 80, 78, 71, 13, 10, 26, 10][i]) throw new Error('bad signature')
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Uint8Array[] = []
  let sawEnd = false
  while (pos < file.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(...file.subarray(pos + 4, pos + 8))
    const body = file.subarray(pos + 8, pos + 8 + len)
    const crc = dv.getUint32(pos + 8 + len)
    const expect = zcrc32(file.subarray(pos + 4, pos + 8 + len)) >>> 0
    if (crc !== expect) throw new Error(`${type}: CRC ${crc.toString(16)} ≠ ${expect.toString(16)}`)
    if (type === 'IHDR') {
      const hv = new DataView(body.buffer, body.byteOffset, body.byteLength)
      width = hv.getUint32(0)
      height = hv.getUint32(4)
      if (body[8] !== 8) throw new Error('bit depth')
      colorType = body[9]
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new Error('method/filter/interlace')
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') sawEnd = true
    pos += 12 + len
  }
  if (!sawEnd) throw new Error('no IEND')
  const z = new Uint8Array(idat.reduce((s, b) => s + b.length, 0))
  let o = 0
  for (const b of idat) {
    z.set(b, o)
    o += b.length
  }
  const raw = new Uint8Array(inflateSync(z))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT size')
  // Unfilter with the spec's own formulas, written out again here.
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const t = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= bpp ? out[y * stride + i - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0
      const pr = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? Math.floor((a + b) / 2) : specPaeth(a, b, c)
      out[y * stride + i] = (x + pr) & 0xff
    }
  }
  return { width, height, colorType, pixels: out }
}

export const checks: Check[] = [
  {
    name: 'Paeth predictor matches the spec pseudocode on all 256³ (a, b, c)',
    run() {
      for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (let c = 0; c < 256; c++) if (paeth(a, b, c) !== specPaeth(a, b, c)) throw new Error(`(${a},${b},${c})`)
    },
  },
  {
    name: 'Paeth tie-breaking: a beats b beats c (6,6,2 → a; 2,6,4 → c; every tie in 0…63³)',
    run() {
      eq(paeth(2, 6, 4), 4) // c midway between a and b: p = c, so pc = 0 and c wins
      eq(paeth(6, 6, 2), 6)
      for (let a = 0; a < 64; a++)
        for (let b = 0; b < 64; b++)
          for (let c = 0; c < 64; c++) {
            const p = a + b - c
            const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
            if (pa === pb && pa <= pc) eq(paeth(a, b, c), a, `${a},${b},${c}`)
            else if (pb === pc && pb < pa) eq(paeth(a, b, c), b, `${a},${b},${c}`)
          }
    },
  },
  {
    name: 'every filter followed by its inverse is the identity (bpp 1–4, random rows incl. first row/column)',
    run() {
      const r = seeded(31)
      for (let trial = 0; trial < 400; trial++) {
        const bpp = 1 + (trial % 4)
        const n = bpp * (1 + Math.floor(r() * 12))
        const prev = trial % 5 === 0 ? null : Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
        const cur = Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
        for (const t of FILTERS) bytesEq(unfilterRow(t, filterRow(t, cur, prev, bpp), prev, bpp), cur, `filter ${t} bpp ${bpp}`)
      }
    },
  },
  {
    name: 'whole-image filtering inverts for every strategy on every test image',
    run() {
      for (const img of [photo(), ui(), pixel(), noise()])
        for (const s of [0, 1, 2, 3, 4, 'adaptive'] as const) bytesEq(unfilterImage(filterImage(img, W, H, 3, s).data, W, H, 3), img, String(s))
      const r = seeded(4)
      const rgba = Uint8Array.from({ length: 9 * 7 * 4 }, () => Math.floor(r() * 256))
      bytesEq(unfilterImage(filterImage(rgba, 9, 7, 4, 'trial').data, 9, 7, 4), rgba, 'trial rgba')
    },
  },
  {
    name: 'our PNG files parse with an independent decoder (Node zlib CRC + inflate) and give back the pixels',
    run() {
      for (const [name, img] of [
        ['photo', photo()],
        ['ui', ui()],
        ['pixel', pixel()],
        ['noise', noise()],
      ] as const) {
        for (const s of [0, 4, 'adaptive'] as const) {
          const f = writePng(img, W, H, 2, s)
          for (let i = 0; i < 8; i++) eq(f.bytes[i], SIGNATURE[i])
          const d = decodePng(f.bytes)
          eq([d.width, d.height, d.colorType], [W, H, 2], name)
          bytesEq(d.pixels, img, `${name} ${s}`)
        }
      }
      const r = seeded(8)
      const rgba = Uint8Array.from({ length: 13 * 5 * 4 }, () => Math.floor(r() * 256))
      const d = decodePng(writePng(rgba, 13, 5, 6, 'adaptive').bytes)
      bytesEq(d.pixels, rgba, 'rgba')
    },
  },
  {
    name: 'IHDR / IEND carry the CRCs every PNG decoder expects (IEND is always AE 42 60 82)',
    run() {
      const f = writePng(ui(), W, H, 2, 'adaptive')
      const end = f.bytes.subarray(f.bytes.length - 4)
      eq(Array.from(end), [0xae, 0x42, 0x60, 0x82])
      eq(f.chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'])
      eq(f.chunks[0].length, 13)
    },
  },
  {
    name: 'filtering shrinks the smooth photo by at least a third versus no filtering; noise stays incompressible',
    run() {
      const img = photo()
      const none = writePng(img, W, H, 2, 0).bytes.length
      const best = Math.min(...([1, 2, 3, 4, 'adaptive'] as const).map((s) => writePng(img, W, H, 2, s).bytes.length))
      ok(best < none * 0.67, `best ${best} vs none ${none}`)
      const n = noise()
      ok(writePng(n, W, H, 2, 'adaptive').bytes.length >= n.length, 'noise should not shrink')
    },
  },
  {
    name: 'the filter type byte leads every row, and adaptive picks the minimum-sum-of-absolute-differences filter',
    run() {
      const f = filterImage(photo(), W, H, 3, 'adaptive')
      for (let y = 0; y < H; y++) {
        const t = f.data[y * (W * 3 + 1)] as FilterType
        eq(t, f.types[y])
        const sc = f.scores[y]
        ok(sc[t] === Math.min(...sc), `row ${y}`)
      }
    },
  },
]
