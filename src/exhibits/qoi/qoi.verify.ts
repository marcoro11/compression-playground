import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { decode, encode, hash, type QoiImage } from './qoi'
import { presetImage, type Preset } from './images'

/**
 * A second QOI decoder, written straight from the one-page spec and sharing
 * nothing with qoi.ts: string tags, a DataView for the header, and the cache
 * kept as an array of [r,g,b,a] tuples.
 */
function specDecode(file: Uint8Array): { width: number; height: number; channels: number; colorspace: number; rgba: Uint8Array } {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const magic = String.fromCharCode(file[0], file[1], file[2], file[3])
  if (magic !== 'qoif') throw new Error('not a qoi file')
  const width = dv.getUint32(4, false)
  const height = dv.getUint32(8, false)
  const channels = file[12]
  const colorspace = file[13]
  const seen: [number, number, number, number][] = Array.from({ length: 64 }, () => [0, 0, 0, 0])
  let px: [number, number, number, number] = [0, 0, 0, 255]
  const out = new Uint8Array(width * height * 4)
  let i = 14
  let written = 0
  const put = () => {
    out.set(px, written * 4)
    written++
    seen[(px[0] * 3 + px[1] * 5 + px[2] * 7 + px[3] * 11) % 64] = [...px]
  }
  while (written < width * height) {
    const tag = file[i]
    if (tag === 254) {
      px = [file[i + 1], file[i + 2], file[i + 3], px[3]]
      i += 4
      put()
    } else if (tag === 255) {
      px = [file[i + 1], file[i + 2], file[i + 3], file[i + 4]]
      i += 5
      put()
    } else if (tag >> 6 === 0) {
      px = [...seen[tag]]
      i += 1
      put()
    } else if (tag >> 6 === 1) {
      const dr = ((tag >> 4) & 3) - 2
      const dg = ((tag >> 2) & 3) - 2
      const db = (tag & 3) - 2
      px = [(px[0] + dr + 256) % 256, (px[1] + dg + 256) % 256, (px[2] + db + 256) % 256, px[3]]
      i += 1
      put()
    } else if (tag >> 6 === 2) {
      const dg = (tag & 63) - 32
      const dr = (file[i + 1] >> 4) - 8 + dg
      const db = (file[i + 1] & 15) - 8 + dg
      px = [(px[0] + dr + 512) % 256, (px[1] + dg + 512) % 256, (px[2] + db + 512) % 256, px[3]]
      i += 2
      put()
    } else {
      const n = (tag & 63) + 1
      i += 1
      for (let k = 0; k < n; k++) put()
    }
  }
  const tail = Array.from(file.subarray(i))
  if (JSON.stringify(tail) !== JSON.stringify([0, 0, 0, 0, 0, 0, 0, 1])) throw new Error('missing end marker, got ' + tail.join(','))
  return { width, height, channels, colorspace, rgba: out }
}

const PRESETS: Preset[] = ['photo', 'ui', 'pixel', 'gradient', 'sprite', 'noise']

/** Random images with structure: a random walk with repeats, jumps and alpha changes, so every op appears. */
function randomImage(seed: number, w: number, h: number, alphaRate: number): QoiImage {
  const r = seeded(seed)
  const rgba = new Uint8Array(w * h * 4)
  let c = [128, 128, 128, 255]
  for (let p = 0; p < w * h; p++) {
    const k = r()
    if (k < 0.25) {
      // repeat
    } else if (k < 0.5) c = [c[0] + Math.floor(r() * 4) - 2, c[1] + Math.floor(r() * 4) - 2, c[2] + Math.floor(r() * 4) - 2, c[3]]
    else if (k < 0.7) {
      const dg = Math.floor(r() * 64) - 32
      c = [c[0] + dg + Math.floor(r() * 16) - 8, c[1] + dg, c[2] + dg + Math.floor(r() * 16) - 8, c[3]]
    } else if (k < 0.85) c = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), c[3]]
    else if (k < 0.85 + alphaRate) c = [c[0], c[1], c[2], Math.floor(r() * 256)]
    else if (p > 4) {
      const q = Math.floor(r() * p)
      c = [rgba[q * 4], rgba[q * 4 + 1], rgba[q * 4 + 2], rgba[q * 4 + 3]]
    }
    c = c.map((v) => ((v % 256) + 256) % 256)
    rgba.set(c, p * 4)
  }
  return { width: w, height: h, channels: alphaRate > 0 ? 4 : 3, colorspace: 0, rgba }
}

export const checks: Check[] = [
  {
    name: 'the colour hash: (3r + 5g + 7b + 11a) mod 64 on known colours',
    run() {
      eq(hash(0, 0, 0, 0), 0, 'transparent black')
      eq(hash(0, 0, 0, 255), 53, 'opaque black: 255·11 = 2805 = 43·64 + 53')
      eq(hash(255, 255, 255, 255), 38, 'white: 255·26 = 6630 = 103·64 + 38')
      eq(hash(1, 255, 0, 255), 51, '3 + 1275 + 2805 = 4083 = 63·64 + 51')
    },
  },
  {
    name: 'a hand-built 72×1 image encodes to the byte stream derived by hand (every op, run split at 62)',
    run() {
      // p0,p1  (0,0,0,255)   equal to the initial previous pixel → a run of 2
      // p2     (1,255,0,255) dr +1, dg 0→255 wraps to −1, db 0      → DIFF  0x40|3<<4|1<<2|2 = 0x76 (after RUN 2 = 0xC1)
      // p3     (24,19,15,255) dg +20 (255→19 wraps), dr−dg +3, db−dg −5 → LUMA 0x80|52 = 0xB4, (11<<4)|3 = 0xB3
      // p4     (200,100,50,255) dg +81: out of LUMA range               → RGB  FE C8 64 32
      // p5     (1,255,0,255) again: hash 51 already holds it           → INDEX 0x33
      // p6     (1,255,0,128) alpha changed                              → RGBA FF 01 FF 00 80
      // p7…p71 65 × the same                                            → RUN 62 = 0xFD, then RUN 3 = 0xC2 at the last pixel
      const pixels: number[][] = [
        [0, 0, 0, 255],
        [0, 0, 0, 255],
        [1, 255, 0, 255],
        [24, 19, 15, 255],
        [200, 100, 50, 255],
        [1, 255, 0, 255],
        [1, 255, 0, 128],
      ]
      for (let k = 0; k < 65; k++) pixels.push([1, 255, 0, 128])
      const img: QoiImage = { width: 72, height: 1, channels: 4, colorspace: 0, rgba: Uint8Array.from(pixels.flat()) }
      const expected = Uint8Array.from([
        0x71, 0x6f, 0x69, 0x66, 0, 0, 0, 72, 0, 0, 0, 1, 4, 0,
        0xc1, 0x76, 0xb4, 0xb3, 0xfe, 0xc8, 0x64, 0x32, 0x33, 0xff, 0x01, 0xff, 0x00, 0x80, 0xfd, 0xc2,
        0, 0, 0, 0, 0, 0, 0, 1,
      ])
      const enc = encode(img)
      bytesEq(enc.bytes, expected, 'encoder')
      bytesEq(decode(expected).rgba, img.rgba, 'our decoder on the hand bytes')
      bytesEq(specDecode(expected).rgba, img.rgba, 'spec decoder on the hand bytes')
      eq(enc.opCount, { RUN: 3, INDEX: 1, DIFF: 1, LUMA: 1, RGB: 1, RGBA: 1 }, 'op counts')
    },
  },
  {
    name: 'LUMA bounds: dg −32…31 and dr−dg, db−dg −8…7 are LUMA; one step past either is RGB',
    run() {
      const two = (a: number[], b: number[]): QoiImage => ({ width: 2, height: 1, channels: 3, rgba: Uint8Array.from([...a, 255, ...b, 255]) })
      const opOf = (img: QoiImage) => encode(img).emits[1].op
      const base = [100, 100, 100]
      eq(opOf(two(base, [100 + 31 + 7, 100 + 31, 100 + 31 - 8])), 'LUMA', 'dg +31, dr−dg +7, db−dg −8')
      eq(opOf(two(base, [100 - 32 - 8, 100 - 32, 100 - 32 + 7])), 'LUMA', 'dg −32')
      eq(opOf(two(base, [100 + 32, 100 + 32, 100 + 32])), 'RGB', 'dg +32')
      eq(opOf(two(base, [100 + 8, 100, 100])), 'RGB', 'dr−dg +8')
      eq(opOf(two(base, [100 - 9 + 5, 100 + 5, 100 + 5])), 'RGB', 'dr−dg −9')
      eq(opOf(two(base, [98, 98, 101])), 'DIFF', 'DIFF: all three in −2…1')
      eq(opOf(two(base, [102, 100, 100])), 'LUMA', 'dr +2 is one past DIFF, so LUMA takes it')
    },
  },
  {
    name: 'header layout: magic, big-endian width and height, channels, colorspace; end marker 7 × 0x00, 0x01',
    run() {
      const img: QoiImage = { width: 300, height: 2, channels: 3, colorspace: 1, rgba: new Uint8Array(300 * 2 * 4).fill(255) }
      const b = encode(img).bytes
      eq(Array.from(b.subarray(0, 14)), [0x71, 0x6f, 0x69, 0x66, 0, 0, 1, 44, 0, 0, 0, 2, 3, 1])
      eq(Array.from(b.subarray(b.length - 8)), [0, 0, 0, 0, 0, 0, 0, 1])
      const d = decode(b)
      eq([d.width, d.height, d.channels, d.colorspace], [300, 2, 3, 1])
    },
  },
  {
    name: 'the spec decoder reads our encoding of every test image back exactly',
    run() {
      for (const p of PRESETS) {
        const img = presetImage(p)
        const enc = encode(img)
        const d = specDecode(enc.bytes)
        eq([d.width, d.height, d.channels], [img.width, img.height, img.channels], p)
        bytesEq(d.rgba, img.rgba, p)
        bytesEq(decode(enc.bytes).rgba, img.rgba, p + ' (our decoder)')
      }
    },
  },
  {
    name: 'random structured images (RGB and heavy alpha): both decoders invert the encoder, and encoding is deterministic',
    run() {
      for (let t = 0; t < 120; t++) {
        const alpha = t % 3 === 0 ? 0 : t % 3 === 1 ? 0.1 : 0.15
        const img = randomImage(1000 + t, 1 + (t % 37), 1 + ((t * 7) % 23), alpha)
        const a = encode(img)
        const b = encode(img)
        bytesEq(a.bytes, b.bytes, 'determinism')
        bytesEq(decode(a.bytes).rgba, img.rgba, `ours, image ${t}`)
        bytesEq(specDecode(a.bytes).rgba, img.rgba, `spec, image ${t}`)
      }
    },
  },
  {
    name: 'every op shows up on the random images, and per-pixel op bookkeeping adds up',
    run() {
      const img = randomImage(7, 64, 64, 0.1)
      const e = encode(img)
      for (const op of ['RUN', 'INDEX', 'DIFF', 'LUMA', 'RGB', 'RGBA'] as const) ok(e.opCount[op] > 0, `${op} never used`)
      const totalPixels = Object.values(e.pixelCount).reduce((s, v) => s + v, 0)
      eq(totalPixels, 64 * 64, 'pixels covered')
      const totalBytes = Object.values(e.byteCount).reduce((s, v) => s + v, 0)
      eq(totalBytes + 14 + 8, e.bytes.length, 'bytes accounted')
      for (const em of e.emits) if (em.op === 'RUN') ok(em.pixels >= 1 && em.pixels <= 62, 'run length out of range')
    },
  },
  {
    name: 'QOI beats raw on the smooth images and cannot shrink noise',
    run() {
      const raw = (img: QoiImage) => img.width * img.height * img.channels
      for (const p of ['photo', 'gradient', 'pixel', 'ui'] as Preset[]) {
        const img = presetImage(p)
        ok(encode(img).bytes.length < raw(img) * 0.75, `${p} did not shrink`)
      }
      const n = presetImage('noise')
      ok(encode(n).bytes.length > raw(n), 'noise should grow: almost every pixel is a 4-byte QOI_OP_RGB')
    },
  },
]
