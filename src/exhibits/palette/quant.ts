/**
 * Colour quantisation and dithering — the maths, with no DOM, so verify can run it.
 *
 * Images are packed RGB: `data[3·i + c]`, c = 0 red, 1 green, 2 blue.
 *
 * The pipeline a GIF or PNG-8 encoder runs:
 *   1. `colorTable`  — the distinct colours and how many pixels use each.
 *   2. a palette     — `uniformPalette`, `medianCut` (Heckbert 1982), then
 *                      optionally `kmeans` (Lloyd iterations seeded from it).
 *   3. a mapping     — every pixel to an index, either straight to the nearest
 *                      colour or through a dither (`ordered`, `diffuse`).
 */

export type RGB = [number, number, number]

export interface Img {
  w: number
  h: number
  /** Packed RGB, 3 bytes per pixel. */
  data: Uint8ClampedArray
}

export interface TableEntry {
  /** Representative colour (the mean of every pixel that fell in this entry). */
  c: RGB
  /** Pixel count. */
  n: number
}

/**
 * Distinct colours with counts. A photograph can have tens of thousands of
 * them; past `maxEntries` the colours are pooled into 5-bit-per-channel bins
 * (32 768 possible), each represented by the mean of its pixels — the same
 * pre-quantisation Heckbert used. An image with few colours stays exact.
 */
export function colorTable(img: Img, maxEntries = 12000): TableEntry[] {
  const exact = new Map<number, number>()
  const n = img.w * img.h
  for (let i = 0; i < n; i++) {
    const k = (img.data[3 * i] << 16) | (img.data[3 * i + 1] << 8) | img.data[3 * i + 2]
    exact.set(k, (exact.get(k) ?? 0) + 1)
  }
  if (exact.size <= maxEntries) {
    return Array.from(exact, ([k, cnt]) => ({ c: [(k >> 16) & 255, (k >> 8) & 255, k & 255] as RGB, n: cnt }))
  }
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (const [k, cnt] of exact) {
    const r = (k >> 16) & 255
    const g = (k >> 8) & 255
    const b = k & 255
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const e = bins.get(key)
    if (e) {
      e.r += r * cnt
      e.g += g * cnt
      e.b += b * cnt
      e.n += cnt
    } else bins.set(key, { r: r * cnt, g: g * cnt, b: b * cnt, n: cnt })
  }
  return Array.from(bins.values(), (e) => ({ c: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB, n: e.n }))
}

export const dist2 = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/** Index of the nearest palette colour (Euclidean in RGB). */
export function nearest(palette: RGB[], r: number, g: number, b: number): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]
    const dr = r - p[0]
    const dg = g - p[1]
    const db = b - p[2]
    const d = dr * dr + dg * dg + db * db
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

// ------------------------------------------------------------------ uniform

/**
 * A fixed palette that ignores the image: split each channel into equal steps.
 * Levels are handed out green first, then red, then blue — the eye's sensitivity
 * order. 256 is pinned to 3-3-2 (8 × 8 × 4) and 216 to the web-safe 6 × 6 × 6.
 */
export function uniformLevels(N: number): [number, number, number] {
  // The two famous ones: web-safe, and 8-bit "3-3-2" truecolour (3 bits red, 3 green, 2 blue).
  if (N === 216) return [6, 6, 6]
  if (N === 256) return [8, 8, 4]
  const lv: [number, number, number] = [1, 1, 1] // r, g, b
  const order = [1, 0, 2]
  let k = 0
  let stuck = 0
  while (stuck < 3) {
    const ch = order[k % 3]
    k++
    const next = lv.slice() as [number, number, number]
    next[ch]++
    if (next[0] * next[1] * next[2] <= N) {
      lv[ch]++
      stuck = 0
    } else stuck++
  }
  return lv
}

export function uniformPalette(N: number): RGB[] {
  const [lr, lg, lb] = uniformLevels(N)
  const step = (l: number, i: number) => (l === 1 ? 128 : Math.round((255 * i) / (l - 1)))
  const out: RGB[] = []
  for (let r = 0; r < lr; r++) for (let g = 0; g < lg; g++) for (let b = 0; b < lb; b++) out.push([step(lr, r), step(lg, g), step(lb, b)])
  return out
}

// --------------------------------------------------------------- median cut

export interface Box {
  /** Indices into the colour table. */
  items: number[]
  min: RGB
  max: RGB
  /** Pixels in the box. */
  n: number
  /** Pixel-weighted mean colour: the palette entry this box becomes. */
  mean: RGB
}

export interface CutStep {
  /** Which box (index into the box list before the split) was cut. */
  box: number
  axis: 0 | 1 | 2
  /** The cut: values ≤ `at` go low, the rest go high (in the sorted order). */
  at: number
  /** Pixel counts of the two halves. */
  lowN: number
  highN: number
  /** The box list after this split (low half replaces the box, high half is appended). */
  boxes: Box[]
}

export interface CutResult {
  palette: RGB[]
  boxes: Box[]
  /** Box list before any split, then after each one. */
  initial: Box[]
  steps: CutStep[]
}

function makeBox(table: TableEntry[], items: number[]): Box {
  const min: RGB = [255, 255, 255]
  const max: RGB = [0, 0, 0]
  let n = 0
  let r = 0
  let g = 0
  let b = 0
  for (const i of items) {
    const e = table[i]
    for (let c = 0; c < 3; c++) {
      if (e.c[c] < min[c]) min[c] = e.c[c]
      if (e.c[c] > max[c]) max[c] = e.c[c]
    }
    n += e.n
    r += e.c[0] * e.n
    g += e.c[1] * e.n
    b += e.c[2] * e.n
  }
  return { items, min, max, n, mean: n ? [r / n, g / n, b / n] : [0, 0, 0] }
}

export const longestAxis = (b: Box): 0 | 1 | 2 => {
  const d = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
  return (d[1] >= d[0] && d[1] >= d[2] ? 1 : d[0] >= d[2] ? 0 : 2) as 0 | 1 | 2
}

export const boxRange = (b: Box) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])

/**
 * Where to cut a box's colours (already sorted along the axis): the first
 * position where the running pixel count reaches half the box, kept inside
 * [1, m−1] so both halves are non-empty. Exported so verify can check it.
 */
export function medianSplitIndex(counts: number[]): number {
  const total = counts.reduce((a, x) => a + x, 0)
  let cum = 0
  let k = 0
  while (k < counts.length && cum + counts[k] < total / 2) cum += counts[k++]
  // counts[k] is the entry that crosses the half. It goes low (k+1 items low).
  return Math.max(1, Math.min(counts.length - 1, k + 1))
}

/**
 * Heckbert's median cut: start with one box around every colour; repeatedly
 * take the box with the widest spread, sort its colours along that box's
 * longest side, and cut at the median pixel. Stop at N boxes or when no box
 * has two distinct colours left. Each box's mean is a palette entry.
 */
export function medianCut(table: TableEntry[], N: number): CutResult {
  const first = makeBox(
    table,
    table.map((_, i) => i),
  )
  let boxes: Box[] = table.length ? [first] : []
  const initial = boxes.slice()
  const steps: CutStep[] = []
  while (boxes.length < N) {
    let pick = -1
    let bestScore = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].items.length < 2) continue
      const score = boxRange(boxes[i])
      if (score > bestScore || (score === bestScore && boxes[i].n > boxes[pick].n)) {
        bestScore = score
        pick = i
      }
    }
    if (pick < 0 || bestScore <= 0) break
    const box = boxes[pick]
    const axis = longestAxis(box)
    const sorted = box.items.slice().sort((a, b) => table[a].c[axis] - table[b].c[axis] || a - b)
    const k = medianSplitIndex(sorted.map((i) => table[i].n))
    const low = makeBox(table, sorted.slice(0, k))
    const high = makeBox(table, sorted.slice(k))
    boxes = boxes.slice()
    boxes[pick] = low
    boxes.push(high)
    steps.push({ box: pick, axis, at: table[sorted[k - 1]].c[axis], lowN: low.n, highN: high.n, boxes })
  }
  return { palette: boxes.map((b) => b.mean.map((v) => Math.round(v)) as RGB), boxes, initial, steps }
}

// ------------------------------------------------------------------ k-means

export interface KStep {
  /** Centres used for this iteration's assignment. */
  centres: RGB[]
  /** Pixel-weighted mean squared error (per pixel, summed over channels) of that assignment. */
  distortion: number
  /** How many table entries changed cluster compared with the previous assignment. */
  changed: number
  /** Centres after moving each one to the mean of its members. */
  moved: RGB[]
  /** Pixels per centre in this assignment. */
  sizes: number[]
}

/**
 * Lloyd's algorithm on the weighted colour table. Each iteration assigns every
 * colour to its nearest centre, measures the error, then moves each centre to
 * the mean of its colours (an empty centre stays where it is). The distortion
 * can only go down: neither half-step can increase it.
 */
export function kmeans(table: TableEntry[], seed: RGB[], maxIter = 12): KStep[] {
  const steps: KStep[] = []
  let centres = seed.map((c) => c.slice() as RGB)
  let prev: Int32Array | null = null
  for (let it = 0; it < maxIter; it++) {
    const assign = new Int32Array(table.length)
    const sum = centres.map(() => [0, 0, 0, 0])
    let err = 0
    let total = 0
    let changed = 0
    for (let i = 0; i < table.length; i++) {
      const e = table[i]
      const j = nearest(centres, e.c[0], e.c[1], e.c[2])
      assign[i] = j
      if (!prev || prev[i] !== j) changed++
      err += dist2(e.c, centres[j]) * e.n
      total += e.n
      const s = sum[j]
      s[0] += e.c[0] * e.n
      s[1] += e.c[1] * e.n
      s[2] += e.c[2] * e.n
      s[3] += e.n
    }
    const moved = centres.map((c, j) => (sum[j][3] ? ([sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] as RGB) : (c.slice() as RGB)))
    steps.push({ centres, distortion: total ? err / total : 0, changed: prev ? changed : table.length, moved, sizes: sum.map((s) => s[3]) })
    const still = prev !== null && changed === 0
    prev = assign
    centres = moved
    if (still) break
  }
  return steps
}

// ---------------------------------------------------------------- dithering

/** Bayer's ordered-dither matrix of size n (a power of two), by the recursive doubling rule. */
export function bayer(n: number): number[][] {
  let m = [[0]]
  while (m.length < n) {
    const s = m.length
    const next: number[][] = Array.from({ length: 2 * s }, () => new Array(2 * s).fill(0))
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const v = 4 * m[y][x]
        next[y][x] = v
        next[y][x + s] = v + 2
        next[y + s][x] = v + 3
        next[y + s][x + s] = v + 1
      }
    m = next
  }
  return m
}

export interface Kernel {
  id: string
  name: string
  /** (dx, dy, weight) — dx is relative to the scan direction. */
  taps: [number, number, number][]
  divisor: number
}

export const KERNELS: Record<'fs' | 'atkinson' | 'jjn', Kernel> = {
  fs: {
    id: 'fs',
    name: 'Floyd–Steinberg',
    divisor: 16,
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  atkinson: {
    id: 'atkinson',
    name: 'Atkinson',
    divisor: 8,
    taps: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
  },
  jjn: {
    id: 'jjn',
    name: 'Jarvis–Judice–Ninke',
    divisor: 48,
    taps: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },
}

export type Dither = { kind: 'none' } | { kind: 'ordered'; size: number } | { kind: 'diffuse'; kernel: Kernel; serpentine: boolean }

export interface Mapped {
  /** Palette index per pixel. */
  idx: Uint8Array
  /** The quantised image, packed RGB. */
  out: Uint8ClampedArray
  /** Error accounting for diffusion (zero otherwise), summed over every pixel and channel. */
  edgeLost: number
  kernelLost: number
  errSum: number
}

/** A memo of nearest-colour lookups for integer colours. */
function lookup(palette: RGB[]) {
  const cache = new Map<number, number>()
  return (r: number, g: number, b: number) => {
    const k = (r << 16) | (g << 8) | b
    let i = cache.get(k)
    if (i === undefined) {
      i = nearest(palette, r, g, b)
      cache.set(k, i)
    }
    return i
  }
}

/** Typical distance between neighbouring palette colours — how far an ordered dither should jitter. */
export function paletteSpread(palette: RGB[]): number {
  if (palette.length < 2) return 0
  let s = 0
  for (let i = 0; i < palette.length; i++) {
    let bd = Infinity
    for (let j = 0; j < palette.length; j++) if (i !== j) bd = Math.min(bd, dist2(palette[i], palette[j]))
    s += Math.sqrt(bd)
  }
  return Math.min(255, s / palette.length)
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

export function mapImage(img: Img, palette: RGB[], dither: Dither): Mapped {
  const { w, h, data } = img
  const n = w * h
  const idx = new Uint8Array(n)
  const out = new Uint8ClampedArray(n * 3)
  const near = lookup(palette)
  let edgeLost = 0
  let kernelLost = 0
  let errSum = 0
  const put = (p: number, i: number) => {
    idx[p] = i
    out[3 * p] = palette[i][0]
    out[3 * p + 1] = palette[i][1]
    out[3 * p + 2] = palette[i][2]
  }
  if (palette.length === 0) return { idx, out, edgeLost, kernelLost, errSum }

  if (dither.kind === 'none') {
    for (let p = 0; p < n; p++) put(p, near(data[3 * p], data[3 * p + 1], data[3 * p + 2]))
  } else if (dither.kind === 'ordered') {
    const m = bayer(dither.size)
    const s = dither.size
    const spread = paletteSpread(palette)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const t = ((m[y % s][x % s] + 0.5) / (s * s) - 0.5) * spread
        put(p, near(clamp255(data[3 * p] + t), clamp255(data[3 * p + 1] + t), clamp255(data[3 * p + 2] + t)))
      }
  } else {
    const k = dither.kernel
    const buf = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) buf[i] = data[i]
    let wsum = 0
    for (const t of k.taps) wsum += t[2]
    const keep = 1 - wsum / k.divisor
    for (let y = 0; y < h; y++) {
      const rev = dither.serpentine && y % 2 === 1
      for (let xi = 0; xi < w; xi++) {
        const x = rev ? w - 1 - xi : xi
        const p = y * w + x
        const r = buf[3 * p]
        const g = buf[3 * p + 1]
        const b = buf[3 * p + 2]
        const i = near(clamp255(r), clamp255(g), clamp255(b))
        put(p, i)
        const e = [r - palette[i][0], g - palette[i][1], b - palette[i][2]]
        errSum += e[0] + e[1] + e[2]
        kernelLost += keep * (e[0] + e[1] + e[2])
        for (const [dx0, dy, wt] of k.taps) {
          const dx = rev ? -dx0 : dx0
          const xx = x + dx
          const yy = y + dy
          const f = wt / k.divisor
          if (xx < 0 || xx >= w || yy >= h) {
            edgeLost += f * (e[0] + e[1] + e[2])
            continue
          }
          const q = 3 * (yy * w + xx)
          buf[q] += e[0] * f
          buf[q + 1] += e[1] * f
          buf[q + 2] += e[2] * f
        }
      }
    }
  }
  return { idx, out, edgeLost, kernelLost, errSum }
}

/**
 * Error diffusion on a small window, one pixel per step, for the magnified view.
 * Starts with no carried error (the window is cut out of the image).
 */
export interface DiffuseStep {
  x: number
  y: number
  /** Colour the pixel wanted: original + carried error. */
  want: [number, number, number]
  chosen: number
  err: [number, number, number]
  /** Where the error went: neighbour, weight (as a fraction), amount per channel. */
  pushes: { x: number; y: number; num: number; den: number; inside: boolean }[]
  /** The working buffer after this step (wanted colours for pending pixels). */
  buf: Float32Array
  /** Index per pixel, −1 while unvisited. */
  done: Int16Array
}

export function diffuseTrace(win: Img, palette: RGB[], kernel: Kernel, serpentine: boolean): DiffuseStep[] {
  const { w, h, data } = win
  const buf = new Float32Array(w * h * 3)
  for (let i = 0; i < buf.length; i++) buf[i] = data[i]
  const done = new Int16Array(w * h).fill(-1)
  const steps: DiffuseStep[] = []
  for (let y = 0; y < h; y++) {
    const rev = serpentine && y % 2 === 1
    for (let xi = 0; xi < w; xi++) {
      const x = rev ? w - 1 - xi : xi
      const p = y * w + x
      const want: [number, number, number] = [buf[3 * p], buf[3 * p + 1], buf[3 * p + 2]]
      const i = nearest(palette, clamp255(want[0]), clamp255(want[1]), clamp255(want[2]))
      const err: [number, number, number] = [want[0] - palette[i][0], want[1] - palette[i][1], want[2] - palette[i][2]]
      done[p] = i
      const pushes: DiffuseStep['pushes'] = []
      for (const [dx0, dy, wt] of kernel.taps) {
        const dx = rev ? -dx0 : dx0
        const xx = x + dx
        const yy = y + dy
        const inside = xx >= 0 && xx < w && yy < h
        pushes.push({ x: xx, y: yy, num: wt, den: kernel.divisor, inside })
        if (!inside) continue
        const q = 3 * (yy * w + xx)
        for (let c = 0; c < 3; c++) buf[q + c] += (err[c] * wt) / kernel.divisor
      }
      steps.push({ x, y, want, chosen: i, err, pushes, buf: buf.slice(), done: done.slice() })
    }
  }
  return steps
}

// ------------------------------------------------------------------ metrics

export function psnr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  const mse = s / a.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

/** sRGB (0–255) to OKLab (Björn Ottosson, 2020). */
export function oklab(r8: number, g8: number, b8: number): [number, number, number] {
  const lin = (u: number) => {
    const v = u / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const r = lin(r8)
  const g = lin(g8)
  const b = lin(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/**
 * Mean per-pixel ΔE in OKLab, ×100 so that ~1 is "just noticeable" and the
 * numbers read like the familiar CIE ΔE scale. Measured on a 2×2-blurred copy
 * of both images too, because that is closer to what the eye does with a dither.
 */
export function deltaE(a: Img, b: Uint8ClampedArray, blur = false): number {
  const { w, h } = a
  const sample = (d: ArrayLike<number>, x: number, y: number, c: number) => {
    if (!blur) return d[3 * (y * w + x) + c]
    const x1 = Math.min(w - 1, x + 1)
    const y1 = Math.min(h - 1, y + 1)
    return (d[3 * (y * w + x) + c] + d[3 * (y * w + x1) + c] + d[3 * (y1 * w + x) + c] + d[3 * (y1 * w + x1) + c]) / 4
  }
  let s = 0
  let n = 0
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const p = oklab(sample(a.data, x, y, 0), sample(a.data, x, y, 1), sample(a.data, x, y, 2))
      const q = oklab(sample(b, x, y, 0), sample(b, x, y, 1), sample(b, x, y, 2))
      s += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
      n++
    }
  return (100 * s) / n
}

/** Relative luminance-ish key for sorting swatches. */
export const luma = (c: ArrayLike<number>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
