/**
 * Procedural colour test images, packed RGB, no DOM. Each shows one thing:
 *
 *  - sunset: long smooth gradients — palette banding is visible instantly.
 *  - meadow: a soft "photo-like" scene with many hues and fine grain.
 *  - logo:   flat colours with hard edges — fewer than 16 distinct colours,
 *            so a good quantiser reproduces it exactly.
 *  - wheel:  every hue at every saturation — the worst case for any palette.
 */

import { seeded } from '../../lib/samples'
import type { Img } from './quant'

export const SIZE = 192

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
const mix = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

function make(fn: (x: number, y: number) => number[]): Img {
  const data = new Uint8ClampedArray(SIZE * SIZE * 3)
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const c = fn(x, y)
      const p = 3 * (y * SIZE + x)
      data[p] = clamp(c[0])
      data[p + 1] = clamp(c[1])
      data[p + 2] = clamp(c[2])
    }
  return { w: SIZE, h: SIZE, data }
}

/** Gradient through several stops, t in [0, 1]. */
function ramp(stops: [number, number[]][], t: number): number[] {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      return mix(c0, c1, (t - t0) / (t1 - t0))
    }
  }
  return stops[stops.length - 1][1]
}

export function sunset(): Img {
  const horizon = 128
  const sky: [number, number[]][] = [
    [0, [24, 22, 74]],
    [0.35, [92, 46, 120]],
    [0.65, [214, 86, 92]],
    [0.88, [252, 160, 76]],
    [1, [255, 214, 120]],
  ]
  const sun = [96, 104]
  return make((x, y) => {
    const ds = Math.hypot(x - sun[0], y - sun[1])
    if (y < horizon) {
      let c = ramp(sky, y / horizon)
      // Glow and disc.
      const glow = Math.exp(-ds / 30) * 0.8
      c = mix(c, [255, 230, 160], glow)
      if (ds < 18) c = mix([255, 244, 200], [255, 210, 120], ds / 18)
      return c
    }
    // Sea: darker, with the sun's reflection broken into ripples.
    const t = (y - horizon) / (SIZE - horizon)
    let c = mix([120, 60, 96], [20, 22, 60], smooth(t))
    const ripple = Math.sin(y * 0.9 + Math.sin(x * 0.15) * 2) > 0.2 ? 1 : 0
    const refl = Math.max(0, 1 - Math.abs(x - sun[0]) / (16 + t * 30)) * ripple * (1 - t * 0.7)
    c = mix(c, [255, 200, 120], refl * 0.85)
    return c
  })
}

export function meadow(): Img {
  const r = seeded(17)
  const grain = new Float32Array(SIZE * SIZE)
  for (let i = 0; i < grain.length; i++) grain[i] = (r() - 0.5) * 10
  const flowers: { x: number; y: number; c: number[]; s: number }[] = []
  for (let i = 0; i < 70; i++) {
    const y = 120 + r() * 70
    flowers.push({ x: r() * SIZE, y, c: r() < 0.5 ? [228, 52, 64] : r() < 0.5 ? [250, 210, 60] : [180, 90, 210], s: 1.2 + (y - 120) / 30 })
  }
  return make((x, y) => {
    // Sky with soft clouds.
    let c = mix([110, 170, 235], [200, 228, 250], y / 90)
    const cloud = Math.max(0, Math.sin(x / 23 + 1) * Math.sin(y / 9 + x / 60) - 0.35) * 2
    if (y < 70) c = mix(c, [250, 250, 252], Math.min(1, cloud))
    // Far hill, near hill.
    const far = 78 + 10 * Math.sin(x / 31) + 5 * Math.sin(x / 11)
    const near = 108 + 14 * Math.sin(x / 47 + 2) + 4 * Math.sin(x / 13)
    if (y > far) c = mix([92, 140, 96], [60, 110, 70], smooth((y - far) / 40))
    if (y > near) {
      const t = (y - near) / (SIZE - near)
      c = mix([118, 176, 64], [46, 104, 34], t)
      c = mix(c, [180, 200, 90], Math.max(0, Math.sin(x / 7 + y / 5)) * 0.15)
    }
    // A tree.
    const tx = 150
    if (Math.abs(x - tx) < 3 && y > 70 && y < 112) c = [92, 60, 40]
    const crown = Math.hypot(x - tx, (y - 66) * 1.2)
    if (crown < 22) c = mix([40, 120, 52], [24, 80, 36], crown / 22 + (x - tx) / 60)
    for (const f of flowers) {
      if (Math.hypot(x - f.x, y - f.y) < f.s) c = f.c
    }
    const g = grain[y * SIZE + x]
    return [c[0] + g, c[1] + g, c[2] + g]
  })
}

/** Hard-edged flat colours, deliberately fewer than 16 of them. */
export function logo(): Img {
  const bg = [246, 241, 228]
  const ink = [33, 31, 46]
  const cols = [
    [235, 87, 87],
    [242, 201, 76],
    [39, 174, 96],
    [47, 128, 237],
    [155, 81, 224],
  ]
  return make((x, y) => {
    let c = bg
    // Five overlapping discs in a ring.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2
      const cx = 96 + Math.cos(a) * 38
      const cy = 88 + Math.sin(a) * 38
      if (Math.hypot(x - cx, y - cy) < 30) c = cols[i]
    }
    if (Math.hypot(x - 96, y - 88) < 16) c = ink
    // A bar of stripes along the bottom.
    if (y > 150 && y < 172 && x > 24 && x < 168) c = Math.floor((x - 24) / 16) % 2 ? cols[3] : ink
    return c
  })
}

/** HSV disc: hue around, saturation outward, on a neutral grey. */
export function wheel(): Img {
  return make((x, y) => {
    const dx = x - SIZE / 2
    const dy = y - SIZE / 2
    const rr = Math.hypot(dx, dy) / (SIZE / 2 - 6)
    if (rr > 1) {
      const v = 60 + (y / SIZE) * 150
      return [v, v, v]
    }
    const h = ((Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1) * 6
    const s = rr
    const v = 1 - 0.25 * Math.max(0, (y - SIZE / 2) / (SIZE / 2))
    const i = Math.floor(h)
    const f = h - i
    const p = v * (1 - s)
    const q = v * (1 - s * f)
    const t = v * (1 - s * (1 - f))
    const rgb = [
      [v, t, p],
      [q, v, p],
      [p, v, t],
      [p, q, v],
      [t, p, v],
      [v, p, q],
    ][i % 6]
    return rgb.map((u) => u * 255)
  })
}

export const PRESETS = { sunset, meadow, logo, wheel }
export type PresetId = keyof typeof PRESETS
