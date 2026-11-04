/**
 * Procedural test images, 256 × 256 greyscale, no DOM. Each is chosen to show
 * one thing: smooth shading (where JPEG shines), a hard periodic pattern (where
 * it aliases into mush), and noise (where nothing helps). The text image needs
 * font rendering, so it lives with the component.
 */

import { seeded } from '../../lib/samples'

export const SIZE = 256

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** A lit sphere on a soft two-tone ground, with a little film grain. */
export function sphere(): Uint8ClampedArray {
  const img = new Uint8ClampedArray(SIZE * SIZE)
  const r = seeded(42)
  const cx = 138
  const cy = 112
  const R = 70
  const L = [-0.55, -0.6, 0.58] // light direction (towards viewer, up-left)
  const ln = Math.hypot(L[0], L[1], L[2])
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const horizon = 176
      let v: number
      if (y < horizon) v = 205 - (y / horizon) * 55 + 10 * Math.sin(x / 40)
      else v = 120 - ((y - horizon) / (SIZE - horizon)) * 40
      // Soft elliptical shadow on the ground.
      const sx = (x - cx - 30) / 80
      const sy = (y - 196) / 16
      const sd = sx * sx + sy * sy
      if (sd < 1) v *= 0.55 + 0.45 * sd
      const dx = (x - cx) / R
      const dy = (y - cy) / R
      const d2 = dx * dx + dy * dy
      if (d2 <= 1) {
        const nz = Math.sqrt(1 - d2)
        const lam = Math.max(0, (dx * L[0] + dy * L[1] + nz * L[2]) / ln)
        const spec = Math.pow(Math.max(0, lam), 40)
        v = 30 + 170 * lam + 60 * spec
      }
      img[y * SIZE + x] = clamp(v + (r() - 0.5) * 6)
    }
  return img
}

/** A zone plate: cos(k·r²). Frequency rises with radius until it passes the 8×8 block's limit. */
export function zonePlate(): Uint8ClampedArray {
  const img = new Uint8ClampedArray(SIZE * SIZE)
  const k = Math.PI / SIZE
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const dx = x - SIZE / 2
      const dy = y - SIZE / 2
      img[y * SIZE + x] = clamp(128 + 120 * Math.cos(k * (dx * dx + dy * dy) * 0.5))
    }
  return img
}

/** Uniform noise — every coefficient matters and none can be dropped. */
export function noise(): Uint8ClampedArray {
  const img = new Uint8ClampedArray(SIZE * SIZE)
  const r = seeded(7)
  for (let i = 0; i < img.length; i++) img[i] = Math.floor(r() * 256)
  return img
}
