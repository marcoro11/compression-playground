/**
 * Synthetic greyscale video, generated in code so the exhibit needs no assets
 * and the verify suite can build the exact same frames under Node.
 *
 * Three sequences, each chosen to make one point:
 *
 *  - `scene`: a camera panning 1.5 px/frame across a textured wall, a ball, a
 *    textured box and a spinning bar moving over it — then a hard cut to a
 *    different, almost static shot. Fractional pan (half-pel wins), a rotation
 *    (block motion cannot describe it) and a scene cut (prediction collapses).
 *  - `pan`: a pure integer translation, 3 px right and 1 px down per frame.
 *    With the right vectors the prediction is exact away from the edges.
 *  - `zoom`: the camera pushes in 3% per frame. Every block moves a different
 *    way, away from the centre — a motion field block matching only approximates.
 */

import { seeded } from '../../lib/samples'

export const W = 192
export const H = 144

export type SequenceId = 'scene' | 'pan' | 'zoom'

export interface Sequence {
  id: SequenceId
  frames: Uint8ClampedArray[]
  /** Index of the first frame after a hard cut, if any. */
  cut: number | null
  /** One line on what moves. */
  note: string
}

// ------------------------------------------------------------------ texture

const TW = 512
const TH = 384

/** A world-space texture: multi-octave value noise plus bricks and blobs, so blocks have something to lock on to. */
function makeTexture(seed: number, style: 'wall' | 'room'): Float32Array {
  const r = seeded(seed)
  const lattice = (n: number) => {
    const g = new Float32Array((n + 1) * (n + 1))
    for (let i = 0; i < g.length; i++) g[i] = r()
    return g
  }
  const octaves = [
    { n: 6, amp: 0.5, g: lattice(6) },
    { n: 16, amp: 0.28, g: lattice(16) },
    { n: 48, amp: 0.15, g: lattice(48) },
    { n: 128, amp: 0.07, g: lattice(128) },
  ]
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const tex = new Float32Array(TW * TH)
  for (let y = 0; y < TH; y++)
    for (let x = 0; x < TW; x++) {
      let v = 0
      for (const o of octaves) {
        const fx = (x / TW) * o.n
        const fy = (y / TH) * o.n
        const ix = Math.floor(fx)
        const iy = Math.floor(fy)
        const tx = smooth(fx - ix)
        const ty = smooth(fy - iy)
        const s = o.n + 1
        const a = o.g[iy * s + ix]
        const b = o.g[iy * s + ix + 1]
        const c = o.g[(iy + 1) * s + ix]
        const d = o.g[(iy + 1) * s + ix + 1]
        v += o.amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty)
      }
      let p = 40 + 170 * v
      if (style === 'wall') {
        // Bricks: mortar lines every 24 px, rows offset by half a brick.
        const row = Math.floor(y / 24)
        const bx = (x + (row % 2) * 24) % 48
        if (y % 24 < 2 || bx < 2) p = p * 0.45
        else p = p * 0.85 + 30
      } else {
        // A dim room: vertical panels and a soft lamp glow.
        const panel = Math.floor(x / 64) % 2 ? 0.8 : 1
        const glow = Math.exp(-(((x - 300) / 120) ** 2 + ((y - 120) / 90) ** 2))
        p = p * 0.55 * panel + 70 * glow + 15
      }
      tex[y * TW + x] = p
    }
  return tex
}

let wallTex: Float32Array | null = null
let roomTex: Float32Array | null = null
const wall = () => (wallTex ??= makeTexture(17, 'wall'))
const room = () => (roomTex ??= makeTexture(91, 'room'))

/** Bilinear lookup with edge clamping. */
function sample(tex: Float32Array, x: number, y: number): number {
  x = Math.max(0, Math.min(TW - 1.001, x))
  y = Math.max(0, Math.min(TH - 1.001, y))
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const tx = x - ix
  const ty = y - iy
  const i = iy * TW + ix
  const a = tex[i]
  const b = tex[i + 1]
  const c = tex[i + TW]
  const d = tex[i + TW + 1]
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// ------------------------------------------------------------------ objects

/** Shaded ball: brightness falls off from a highlight, so it carries its own texture as it moves. */
function ball(f: Float32Array, cx: number, cy: number, r: number) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const d = Math.hypot(x - cx, y - cy)
      const a = clamp01(r - d + 0.5)
      if (a <= 0) continue
      const hx = (x - (cx - r * 0.35)) / r
      const hy = (y - (cy - r * 0.4)) / r
      const shade = 235 - 150 * Math.min(1, Math.hypot(hx, hy))
      f[y * W + x] = f[y * W + x] * (1 - a) + shade * a
    }
}

/** A box with a checkerboard printed on it, which moves with the box. */
function box(f: Float32Array, x0: number, y0: number, w: number, h: number) {
  for (let y = Math.floor(y0); y <= y0 + h; y++)
    for (let x = Math.floor(x0); x <= x0 + w; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const ax = clamp01(Math.min(x + 0.5 - x0, x0 + w - x + 0.5))
      const ay = clamp01(Math.min(y + 0.5 - y0, y0 + h - y + 0.5))
      const a = ax * ay
      if (a <= 0) continue
      const u = Math.floor((x - x0) / 6)
      const v = Math.floor((y - y0) / 6)
      const c = (u + v) % 2 ? 225 : 30
      f[y * W + x] = f[y * W + x] * (1 - a) + c * a
    }
}

/** A striped bar spinning about its centre: no single translation describes it. */
function bar(f: Float32Array, cx: number, cy: number, len: number, thick: number, angle: number) {
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  const reach = len / 2 + thick
  for (let y = Math.floor(cy - reach); y <= cy + reach; y++)
    for (let x = Math.floor(cx - reach); x <= cx + reach; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const dx = x - cx
      const dy = y - cy
      const u = dx * ca + dy * sa
      const v = -dx * sa + dy * ca
      const a = clamp01(len / 2 - Math.abs(u) + 0.5) * clamp01(thick / 2 - Math.abs(v) + 0.5)
      if (a <= 0) continue
      const stripe = Math.floor((u + len / 2) / 7) % 2 ? 250 : 120
      f[y * W + x] = f[y * W + x] * (1 - a) + stripe * a
    }
}

// ---------------------------------------------------------------- sequences

function finish(f: Float32Array, grain: number, rng: () => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H)
  for (let i = 0; i < out.length; i++) {
    // Sum of three uniforms: a cheap, bounded, roughly Gaussian grain.
    const n = grain ? (rng() + rng() + rng() - 1.5) * grain * 2 : 0
    out[i] = Math.round(f[i] + n)
  }
  return out
}

function background(tex: Float32Array, ox: number, oy: number, scale = 1, cx = W / 2, cy = H / 2): Float32Array {
  const f = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) f[y * W + x] = sample(tex, ox + cx + (x - cx) / scale, oy + cy + (y - cy) / scale)
  return f
}

const CACHE = new Map<string, Sequence>()

export function makeSequence(id: SequenceId, grain = 0): Sequence {
  const key = id + ':' + grain
  const hit = CACHE.get(key)
  if (hit) return hit
  const rng = seeded(1234 + grain)
  const frames: Uint8ClampedArray[] = []
  let cut: number | null = null
  let note = ''

  if (id === 'scene') {
    const n = 32
    cut = 20
    note = 'camera pans 1.5 px/frame; a ball, a box and a spinning bar move over it; hard cut at frame 20'
    for (let t = 0; t < n; t++) {
      if (t < cut) {
        const f = background(wall(), 60 + 1.5 * t, 80)
        box(f, 150 - 3 * t, 86 + 0.5 * t, 34, 26)
        ball(f, 20 + 4 * t, 40 + 1 * t, 15)
        bar(f, 120, 46, 56, 9, 0.16 * t) // fixed in the frame while the wall pans behind it, spinning
        frames.push(finish(f, grain, rng))
      } else {
        const u = t - cut
        const f = background(room(), 220, 140)
        ball(f, 60 + 2 * u, 90 - 1 * u, 18)
        frames.push(finish(f, grain, rng))
      }
    }
  } else if (id === 'pan') {
    note = 'pure translation: the camera moves exactly 3 px right and 1 px down per frame'
    for (let t = 0; t < 24; t++) frames.push(finish(background(wall(), 40 + 3 * t, 60 + 1 * t), grain, rng))
  } else {
    note = 'the camera pushes in 3% per frame: every block moves outward, by a different amount'
    for (let t = 0; t < 24; t++) frames.push(finish(background(wall(), 150, 110, 1.03 ** t), grain, rng))
  }
  const seq = { id, frames, cut, note }
  CACHE.set(key, seq)
  return seq
}
