/**
 * QOI — the Quite OK Image format (Dominic Szablewski, 2021; spec at qoiformat.org),
 * encoder and decoder from scratch, no DOM.
 *
 *   header   "qoif"  width u32 BE  height u32 BE  channels (3|4)  colorspace (0 sRGB | 1 linear)
 *   ops      QOI_OP_RGB    11111110 r g b
 *            QOI_OP_RGBA   11111111 r g b a
 *            QOI_OP_INDEX  00xxxxxx                     — slot in the 64-entry colour cache
 *            QOI_OP_DIFF   01 dr dg db                  — each −2…1, stored +2
 *            QOI_OP_LUMA   10 dg | dr−dg db−dg          — dg −32…31 (+32), the others −8…7 (+8)
 *            QOI_OP_RUN    11 rrrrrr                    — run of 1…62, stored −1 (63/64 would collide with RGB/RGBA)
 *   end      seven 0x00 then 0x01
 *
 * Both sides start from previous pixel (0,0,0,255) and an all-zero cache, and
 * all channel differences wrap modulo 256 — so 255 → 0 is a difference of +1.
 *
 * Pixels are always handled as RGBA here (4 bytes each); a 3-channel image is
 * one whose alpha is 255 everywhere, and it simply never needs QOI_OP_RGBA.
 */

export type Op = 'RUN' | 'INDEX' | 'DIFF' | 'LUMA' | 'RGB' | 'RGBA'
export const OPS: Op[] = ['RUN', 'INDEX', 'DIFF', 'LUMA', 'RGB', 'RGBA']
/** Bytes per op (RUN is one byte for up to 62 pixels). */
export const OP_SIZE: Record<Op, number> = { RUN: 1, INDEX: 1, DIFF: 1, LUMA: 2, RGB: 4, RGBA: 5 }

export interface QoiImage {
  width: number
  height: number
  channels: 3 | 4
  colorspace?: 0 | 1
  /** RGBA, row-major, 4 bytes per pixel. */
  rgba: Uint8Array
}

export const MAGIC = [0x71, 0x6f, 0x69, 0x66] // "qoif"
export const END_MARKER = [0, 0, 0, 0, 0, 0, 0, 1]
export const HEADER_SIZE = 14

export const hash = (r: number, g: number, b: number, a: number) => (r * 3 + g * 5 + b * 7 + a * 11) % 64

/** Signed difference a − b wrapped into −128…127, as the reference's `(signed char)` cast does. */
export const wrap = (d: number) => ((((d + 128) % 256) + 256) % 256) - 128

/** One op as emitted: which pixel triggered it, where it starts and its bytes. */
export interface Emit {
  op: Op
  /** Offset of the op's first byte in the file. */
  offset: number
  bytes: number[]
  /** For RUN, how many pixels it covers; 1 otherwise. */
  pixels: number
  /** First pixel the op covers. */
  first: number
}

export interface Encoded {
  bytes: Uint8Array
  emits: Emit[]
  /** Per pixel: index into OPS of the op that coded it. */
  opOf: Uint8Array
  /** Per pixel: index into `emits` of the op that coded it. */
  emitOf: Int32Array
  /** Pixels covered per op type. */
  pixelCount: Record<Op, number>
  /** Bytes spent per op type. */
  byteCount: Record<Op, number>
  /** Number of ops per op type. */
  opCount: Record<Op, number>
}

const zero = (): Record<Op, number> => ({ RUN: 0, INDEX: 0, DIFF: 0, LUMA: 0, RGB: 0, RGBA: 0 })

export function encode(img: QoiImage): Encoded {
  const { width, height, channels, rgba } = img
  const n = width * height
  const out: number[] = [...MAGIC, ...u32be(width), ...u32be(height), channels, img.colorspace ?? 0]
  const emits: Emit[] = []
  const opOf = new Uint8Array(n)
  const emitOf = new Int32Array(n)
  const pixelCount = zero()
  const byteCount = zero()
  const opCount = zero()
  const index = new Uint8Array(64 * 4)

  const emit = (op: Op, bytes: number[], first: number, pixels: number) => {
    emits.push({ op, offset: out.length, bytes, pixels, first })
    for (const b of bytes) out.push(b)
    const k = OPS.indexOf(op)
    for (let p = first; p < first + pixels; p++) {
      opOf[p] = k
      emitOf[p] = emits.length - 1
    }
    pixelCount[op] += pixels
    byteCount[op] += bytes.length
    opCount[op]++
  }

  let pr = 0
  let pg = 0
  let pb = 0
  let pa = 255
  let run = 0
  for (let p = 0; p < n; p++) {
    const r = rgba[p * 4]
    const g = rgba[p * 4 + 1]
    const b = rgba[p * 4 + 2]
    const a = rgba[p * 4 + 3]
    if (r === pr && g === pg && b === pb && a === pa) {
      run++
      if (run === 62 || p === n - 1) {
        emit('RUN', [0xc0 | (run - 1)], p - run + 1, run)
        run = 0
      }
      continue
    }
    if (run > 0) {
      emit('RUN', [0xc0 | (run - 1)], p - run, run)
      run = 0
    }
    const h = hash(r, g, b, a)
    if (index[h * 4] === r && index[h * 4 + 1] === g && index[h * 4 + 2] === b && index[h * 4 + 3] === a) {
      emit('INDEX', [h], p, 1)
    } else {
      index[h * 4] = r
      index[h * 4 + 1] = g
      index[h * 4 + 2] = b
      index[h * 4 + 3] = a
      if (a === pa) {
        const vr = wrap(r - pr)
        const vg = wrap(g - pg)
        const vb = wrap(b - pb)
        const vgr = vr - vg
        const vgb = vb - vg
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
          emit('DIFF', [0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)], p, 1)
        } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
          emit('LUMA', [0x80 | (vg + 32), ((vgr + 8) << 4) | (vgb + 8)], p, 1)
        } else {
          emit('RGB', [0xfe, r, g, b], p, 1)
        }
      } else {
        emit('RGBA', [0xff, r, g, b, a], p, 1)
      }
    }
    pr = r
    pg = g
    pb = b
    pa = a
  }
  for (const b of END_MARKER) out.push(b)
  return { bytes: Uint8Array.from(out), emits, opOf, emitOf, pixelCount, byteCount, opCount }
}

export function decode(bytes: Uint8Array): QoiImage {
  if (bytes.length < HEADER_SIZE + END_MARKER.length) throw new Error('qoi: too short')
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('qoi: bad magic')
  const width = readU32be(bytes, 4)
  const height = readU32be(bytes, 8)
  const channels = bytes[12]
  const colorspace = bytes[13]
  if (channels !== 3 && channels !== 4) throw new Error('qoi: bad channel count')
  if (colorspace > 1) throw new Error('qoi: bad colorspace')
  const n = width * height
  const rgba = new Uint8Array(n * 4)
  const index = new Uint8Array(64 * 4)
  let r = 0
  let g = 0
  let b = 0
  let a = 255
  let pos = HEADER_SIZE
  const end = bytes.length - END_MARKER.length
  let run = 0
  for (let p = 0; p < n; p++) {
    if (run > 0) {
      run--
    } else if (pos < end) {
      const b1 = bytes[pos++]
      if (b1 === 0xfe) {
        r = bytes[pos++]
        g = bytes[pos++]
        b = bytes[pos++]
      } else if (b1 === 0xff) {
        r = bytes[pos++]
        g = bytes[pos++]
        b = bytes[pos++]
        a = bytes[pos++]
      } else if ((b1 & 0xc0) === 0x00) {
        r = index[b1 * 4]
        g = index[b1 * 4 + 1]
        b = index[b1 * 4 + 2]
        a = index[b1 * 4 + 3]
      } else if ((b1 & 0xc0) === 0x40) {
        r = (r + ((b1 >> 4) & 3) - 2) & 0xff
        g = (g + ((b1 >> 2) & 3) - 2) & 0xff
        b = (b + (b1 & 3) - 2) & 0xff
      } else if ((b1 & 0xc0) === 0x80) {
        const b2 = bytes[pos++]
        const vg = (b1 & 0x3f) - 32
        r = (r + vg - 8 + ((b2 >> 4) & 0x0f)) & 0xff
        g = (g + vg) & 0xff
        b = (b + vg - 8 + (b2 & 0x0f)) & 0xff
      } else {
        run = b1 & 0x3f
      }
      const h = hash(r, g, b, a)
      index[h * 4] = r
      index[h * 4 + 1] = g
      index[h * 4 + 2] = b
      index[h * 4 + 3] = a
    }
    rgba[p * 4] = r
    rgba[p * 4 + 1] = g
    rgba[p * 4 + 2] = b
    rgba[p * 4 + 3] = a
  }
  return { width, height, channels: channels as 3 | 4, colorspace: colorspace as 0 | 1, rgba }
}

// ---------------------------------------------------------------- explanation

/** Everything the step-through needs to explain one pixel's decision. */
export interface Decision {
  p: number
  px: [number, number, number, number]
  prev: [number, number, number, number]
  /** Same as the previous pixel? */
  same: boolean
  /** Run length including this pixel, if `same`. */
  run: number
  /** Whether this pixel ends the run (62 reached or last pixel or next differs). */
  runEnds: boolean
  slot: number
  /** What the cache held in `slot` before this pixel. */
  cached: [number, number, number, number]
  indexHit: boolean
  alphaSame: boolean
  dr: number
  dg: number
  db: number
  drdg: number
  dbdg: number
  diffOk: boolean
  lumaOk: boolean
  op: Op
  /** Ops whose bytes are emitted while handling this pixel (a pending RUN flushed first, then the pixel's own). */
  emitted: Emit[]
}

/** Replay the encoder up to pixel `p` and explain the decision there. */
export function explain(img: QoiImage, enc: Encoded, p: number): { d: Decision; cache: Uint8Array } {
  const { rgba } = img
  const cache = new Uint8Array(64 * 4)
  let pr = 0
  let pg = 0
  let pb = 0
  let pa = 255
  let run = 0
  // Replay up to (not including) p, maintaining the cache exactly as the encoder does.
  for (let q = 0; q < p; q++) {
    const r = rgba[q * 4]
    const g = rgba[q * 4 + 1]
    const b = rgba[q * 4 + 2]
    const a = rgba[q * 4 + 3]
    if (r === pr && g === pg && b === pb && a === pa) {
      run++
      if (run === 62) run = 0
      continue
    }
    run = 0
    const h = hash(r, g, b, a)
    cache[h * 4] = r
    cache[h * 4 + 1] = g
    cache[h * 4 + 2] = b
    cache[h * 4 + 3] = a
    pr = r
    pg = g
    pb = b
    pa = a
  }
  const px: [number, number, number, number] = [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2], rgba[p * 4 + 3]]
  const prev: [number, number, number, number] = [pr, pg, pb, pa]
  const same = px[0] === pr && px[1] === pg && px[2] === pb && px[3] === pa
  const slot = hash(px[0], px[1], px[2], px[3])
  const cached: [number, number, number, number] = [cache[slot * 4], cache[slot * 4 + 1], cache[slot * 4 + 2], cache[slot * 4 + 3]]
  const indexHit = !same && cached.every((v, i) => v === px[i])
  const dr = wrap(px[0] - pr)
  const dg = wrap(px[1] - pg)
  const db = wrap(px[2] - pb)
  const drdg = dr - dg
  const dbdg = db - dg
  const alphaSame = px[3] === pa
  const diffOk = alphaSame && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1
  const lumaOk = alphaSame && dg >= -32 && dg <= 31 && drdg >= -8 && drdg <= 7 && dbdg >= -8 && dbdg <= 7
  const op = OPS[enc.opOf[p]]
  // Emits whose bytes are written while the encoder is at pixel p.
  const emitted: Emit[] = []
  const own = enc.emits[enc.emitOf[p]]
  if (own.op === 'RUN') {
    if (own.first + own.pixels - 1 === p) emitted.push(own)
  } else {
    const prevEmit = enc.emitOf[p] > 0 ? enc.emits[enc.emitOf[p] - 1] : null
    // A run that ended because this pixel differs is flushed here — unless it already flushed itself at 62.
    if (prevEmit && prevEmit.op === 'RUN' && prevEmit.first + prevEmit.pixels === p && prevEmit.pixels < 62) emitted.push(prevEmit)
    emitted.push(own)
  }
  const runLen = same ? run + 1 : 0
  const runEnds = same && (own.first + own.pixels - 1 === p)
  // Cache after this pixel, for the swatch grid.
  if (!same && !indexHit) {
    cache[slot * 4] = px[0]
    cache[slot * 4 + 1] = px[1]
    cache[slot * 4 + 2] = px[2]
    cache[slot * 4 + 3] = px[3]
  }
  return {
    d: { p, px, prev, same, run: runLen, runEnds, slot, cached, indexHit, alphaSame, dr, dg, db, drdg, dbdg, diffOk, lumaOk, op, emitted },
    cache,
  }
}

// ---------------------------------------------------------------- helpers

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function readU32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

/** RGB (3 bytes per pixel) → RGBA with alpha 255. */
export function rgbToRgba(rgb: Uint8Array): Uint8Array {
  const n = rgb.length / 3
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3]
    out[i * 4 + 1] = rgb[i * 3 + 1]
    out[i * 4 + 2] = rgb[i * 3 + 2]
    out[i * 4 + 3] = 255
  }
  return out
}

/** RGBA → RGB, dropping alpha. */
export function rgbaToRgb(rgba: Uint8Array): Uint8Array {
  const n = rgba.length / 4
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4]
    out[i * 3 + 1] = rgba[i * 4 + 1]
    out[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return out
}

/** The bit layout of an op's first byte (and second for LUMA), for display. */
export function bitFields(e: Emit): { bits: string; label: string; kind: 'tag' | 'payload' }[] {
  const b = e.bytes
  const bin = (v: number, w: number) => v.toString(2).padStart(w, '0')
  switch (e.op) {
    case 'RGB':
      return [
        { bits: '11111110', label: 'tag 0xFE', kind: 'tag' },
        { bits: bin(b[1], 8), label: `r ${b[1]}`, kind: 'payload' },
        { bits: bin(b[2], 8), label: `g ${b[2]}`, kind: 'payload' },
        { bits: bin(b[3], 8), label: `b ${b[3]}`, kind: 'payload' },
      ]
    case 'RGBA':
      return [
        { bits: '11111111', label: 'tag 0xFF', kind: 'tag' },
        { bits: bin(b[1], 8), label: `r ${b[1]}`, kind: 'payload' },
        { bits: bin(b[2], 8), label: `g ${b[2]}`, kind: 'payload' },
        { bits: bin(b[3], 8), label: `b ${b[3]}`, kind: 'payload' },
        { bits: bin(b[4], 8), label: `a ${b[4]}`, kind: 'payload' },
      ]
    case 'INDEX':
      return [
        { bits: '00', label: 'tag', kind: 'tag' },
        { bits: bin(b[0] & 63, 6), label: `slot ${b[0] & 63}`, kind: 'payload' },
      ]
    case 'DIFF':
      return [
        { bits: '01', label: 'tag', kind: 'tag' },
        { bits: bin((b[0] >> 4) & 3, 2), label: `dr ${((b[0] >> 4) & 3) - 2}`, kind: 'payload' },
        { bits: bin((b[0] >> 2) & 3, 2), label: `dg ${((b[0] >> 2) & 3) - 2}`, kind: 'payload' },
        { bits: bin(b[0] & 3, 2), label: `db ${(b[0] & 3) - 2}`, kind: 'payload' },
      ]
    case 'LUMA':
      return [
        { bits: '10', label: 'tag', kind: 'tag' },
        { bits: bin(b[0] & 63, 6), label: `dg ${(b[0] & 63) - 32}`, kind: 'payload' },
        { bits: bin((b[1] >> 4) & 15, 4), label: `dr−dg ${((b[1] >> 4) & 15) - 8}`, kind: 'payload' },
        { bits: bin(b[1] & 15, 4), label: `db−dg ${(b[1] & 15) - 8}`, kind: 'payload' },
      ]
    case 'RUN':
      return [
        { bits: '11', label: 'tag', kind: 'tag' },
        { bits: bin(b[0] & 63, 6), label: `run ${(b[0] & 63) + 1}`, kind: 'payload' },
      ]
  }
}
