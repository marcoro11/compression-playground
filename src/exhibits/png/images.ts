/**
 * Procedural 128 × 128 RGB test images, no DOM. Each one is chosen so a
 * different filter (or none) wins:
 *
 *  - photo:  smooth gradients and soft shapes with a little grain — prediction
 *            from neighbours is nearly always right, so Paeth/Average shine;
 *  - ui:     flat panels and hard edges, like a screenshot — long runs that
 *            DEFLATE already loves, where Sub or even None can win;
 *  - pixel:  a palette sprite scaled up 4×, blocky and repetitive;
 *  - noise:  nothing to predict; every filter loses.
 */

import { seeded } from '../../lib/samples'

export const W = 128
export const H = 128

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

function blank(): Uint8Array {
  return new Uint8Array(W * H * 3)
}

function set(img: Uint8Array, x: number, y: number, r: number, g: number, b: number) {
  const i = (y * W + x) * 3
  img[i] = clamp(r)
  img[i + 1] = clamp(g)
  img[i + 2] = clamp(b)
}

function rect(img: Uint8Array, x0: number, y0: number, w: number, h: number, c: [number, number, number]) {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) set(img, x, y, c[0], c[1], c[2])
}

/** A sunset over hills and a lake, with soft light and film grain. */
export function photo(): Uint8Array {
  const img = blank()
  const r = seeded(21)
  const sunX = 84
  const sunY = 54
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = y / 70
      // Sky: deep blue at the top through orange to a warm glow at the horizon.
      let R = 40 + 210 * t
      let G = 60 + 120 * t
      let B = 140 - 40 * t
      const d = Math.hypot(x - sunX, y - sunY)
      const glow = Math.exp(-d / 26)
      R += 60 * glow
      G += 50 * glow
      B += 20 * glow
      if (d < 9) {
        R = 255
        G = 236
        B = 190
      }
      // Far hills, then near hills, each shaded across its slope.
      const far = 70 + 7 * Math.sin(x / 13) + 4 * Math.sin(x / 5.3 + 1)
      const near = 84 + 9 * Math.sin(x / 21 + 2) + 3 * Math.sin(x / 7)
      if (y > far) {
        const s = (y - far) / 30
        R = 90 - 30 * s
        G = 70 - 15 * s
        B = 110 - 20 * s
      }
      if (y > near) {
        const s = (y - near) / 40
        R = 40 + 30 * Math.sin(x / 9) * 0.3 - 20 * s
        G = 70 + 20 * (1 - s)
        B = 50 - 10 * s
      }
      // Lake: a darker, rippled reflection of the sky.
      if (y > 104) {
        const ry = 104 - (y - 104) * 1.6
        const rt = Math.max(0, ry) / 70
        const ripple = 8 * Math.sin(y * 1.7 + x / 9)
        R = (40 + 200 * rt) * 0.55 + ripple
        G = (60 + 110 * rt) * 0.6 + ripple
        B = (140 - 30 * rt) * 0.75 + ripple
        if (Math.abs(x - sunX) < 6 - (y - 104) / 6) {
          R += 70
          G += 60
          B += 30
        }
      }
      const g = (r() - 0.5) * 3
      set(img, x, y, R + g, G + g, B + g)
    }
  return img
}

/** A flat-coloured app window: title bar, sidebar, buttons, "text" and a chart. */
export function ui(): Uint8Array {
  const img = blank()
  const r = seeded(5)
  rect(img, 0, 0, W, H, [236, 238, 242])
  rect(img, 0, 0, W, 14, [44, 62, 96])
  for (const [i, c] of [
    [0, [255, 95, 87]],
    [1, [255, 189, 46]],
    [2, [40, 200, 64]],
  ] as const)
    rect(img, 5 + i * 7, 4, 5, 5, c as unknown as [number, number, number])
  rect(img, 0, 14, 32, H - 14, [222, 226, 233])
  for (let k = 0; k < 7; k++) {
    rect(img, 5, 22 + k * 12, 4, 4, k === 1 ? [44, 110, 220] : [140, 148, 160])
    rect(img, 12, 23 + k * 12, 10 + ((k * 7) % 9), 2, k === 1 ? [44, 110, 220] : [90, 98, 110])
  }
  rect(img, 40, 22, 80, 2, [30, 34, 40])
  // Paragraph "text": words as short dark dashes on a 6-pixel baseline grid.
  for (let line = 0; line < 6; line++) {
    let x = 40
    const y = 32 + line * 6
    while (x < 118) {
      const w = 3 + Math.floor(r() * 9)
      if (x + w > 120) break
      rect(img, x, y, w, 2, [70, 76, 88])
      x += w + 2
    }
  }
  // Buttons.
  rect(img, 40, 72, 30, 11, [44, 110, 220])
  rect(img, 46, 76, 18, 2, [255, 255, 255])
  rect(img, 74, 72, 30, 11, [255, 255, 255])
  rect(img, 80, 76, 18, 2, [44, 110, 220])
  // A bar chart.
  rect(img, 40, 90, 80, 32, [255, 255, 255])
  const bars = [12, 20, 9, 25, 17, 28, 14]
  bars.forEach((h, i) => rect(img, 45 + i * 10, 118 - h, 7, h, i === 5 ? [255, 120, 80] : [100, 160, 230]))
  rect(img, 42, 118, 76, 1, [180, 186, 196])
  return img
}

/** An original 32 × 32 sprite — a cottage, a tree and a sun — scaled 4× with a small palette. */
export function pixel(): Uint8Array {
  const S = 32
  const P: Record<string, [number, number, number]> = {
    s: [120, 196, 255], // sky
    g: [92, 184, 92], // grass
    d: [60, 140, 70], // dark grass
    w: [240, 226, 196], // wall
    r: [196, 72, 60], // roof
    o: [120, 72, 40], // door / trunk
    y: [255, 214, 64], // sun
    b: [70, 120, 200], // window
    l: [40, 110, 50], // leaves
    c: [255, 255, 255], // cloud
  }
  const grid: string[][] = Array.from({ length: S }, () => new Array<string>(S).fill('s'))
  const fill = (x0: number, y0: number, w: number, h: number, k: string) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && x < S && y >= 0 && y < S) grid[y][x] = k
  }
  fill(0, 22, S, 10, 'g')
  for (let x = 0; x < S; x += 3) fill(x, 22, 1, 1, 'd')
  fill(24, 3, 5, 5, 'y')
  fill(23, 4, 7, 3, 'y')
  fill(4, 5, 6, 2, 'c')
  fill(3, 6, 9, 2, 'c')
  // Cottage.
  fill(6, 15, 12, 9, 'w')
  for (let k = 0; k < 6; k++) fill(5 + k, 14 - k, 14 - 2 * k, 1, 'r')
  fill(10, 18, 4, 6, 'o')
  fill(7, 17, 2, 2, 'b')
  fill(15, 17, 2, 2, 'b')
  // Tree.
  fill(24, 17, 2, 7, 'o')
  fill(21, 11, 8, 6, 'l')
  fill(22, 9, 6, 2, 'l')
  const img = blank()
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = P[grid[y >> 2][x >> 2]]
      set(img, x, y, c[0], c[1], c[2])
    }
  return img
}

export function noise(): Uint8Array {
  const img = blank()
  const r = seeded(77)
  for (let i = 0; i < img.length; i++) img[i] = Math.floor(r() * 256)
  return img
}
