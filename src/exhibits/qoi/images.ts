/**
 * Test images for the QOI exhibit, 128 × 128, RGBA. Four come from the PNG
 * exhibit so the two formats are compared on identical pixels; two are new
 * because they show off ops PNG's images do not:
 *
 *  - gradient: a smooth two-way colour ramp — almost every pixel a small step
 *              from its left neighbour, so DIFF and LUMA carry it;
 *  - sprite:   a soft-edged badge on a transparent background — the only one
 *              with real alpha, so QOI_OP_RGBA appears (and runs of
 *              transparent pixels).
 */

import { seeded } from '../../lib/samples'
import { H, W, noise, photo, pixel, ui } from '../png/images'
import { rgbToRgba, type QoiImage } from './qoi'

export { W, H }

export type Preset = 'photo' | 'ui' | 'pixel' | 'gradient' | 'sprite' | 'noise'

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

export function gradient(): Uint8Array {
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const u = x / (W - 1)
      const v = y / (H - 1)
      out[i] = clamp(40 + 200 * u)
      out[i + 1] = clamp(60 + 120 * v + 40 * u)
      out[i + 2] = clamp(220 - 160 * u * v)
      out[i + 3] = 255
    }
  return out
}

/** A round badge with a soft drop shadow and an antialiased rim, on transparency. */
export function sprite(): Uint8Array {
  const out = new Uint8Array(W * H * 4)
  const r = seeded(5)
  const cx = 62
  const cy = 60
  const R = 40
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const d = Math.hypot(x - cx, y - cy)
      // Shadow: offset, blurred, translucent black.
      const ds = Math.hypot(x - cx - 6, y - cy - 8)
      const shadowA = Math.max(0, Math.min(1, (R + 6 - ds) / 10)) * 0.45
      // Body coverage with a 1.5 px antialiased edge.
      const cover = Math.max(0, Math.min(1, (R - d) / 1.5 + 0.5))
      // Body colour: a radial highlight, plus a star in the middle.
      const t = Math.min(1, d / R)
      let br = 255 - 40 * t
      let bg = 176 - 70 * t
      let bb = 64 + 20 * t
      const ang = Math.atan2(y - cy, x - cx)
      const star = 16 + 8 * Math.cos(5 * ang)
      if (d < star) {
        br = 255
        bg = 248
        bb = 220
      }
      const grain = (r() - 0.5) * 2
      // Composite body over shadow, both premultiplied, then un-premultiply.
      const aBody = cover
      const aShadow = shadowA * (1 - aBody)
      const a = aBody + aShadow
      if (a <= 0.002) continue // fully transparent: leave (0,0,0,0)
      out[i] = clamp(((br + grain) * aBody) / a)
      out[i + 1] = clamp(((bg + grain) * aBody) / a)
      out[i + 2] = clamp(((bb + grain) * aBody) / a)
      out[i + 3] = clamp(a * 255)
    }
  return out
}

export function presetImage(p: Preset): QoiImage {
  const rgba =
    p === 'photo'
      ? rgbToRgba(photo())
      : p === 'ui'
        ? rgbToRgba(ui())
        : p === 'pixel'
          ? rgbToRgba(pixel())
          : p === 'noise'
            ? rgbToRgba(noise())
            : p === 'gradient'
              ? gradient()
              : sprite()
  return { width: W, height: H, channels: p === 'sprite' ? 4 : 3, colorspace: 0, rgba }
}

/** True when any pixel is not fully opaque. */
export function hasAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true
  return false
}
