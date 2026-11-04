import { eq, near, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { PRESETS, logo } from './images'
import { KERNELS, bayer, colorTable, dist2, kmeans, longestAxis, mapImage, medianCut, oklab, uniformLevels, type Img, type RGB } from './quant'

/** Bayer by the closed form: bit-reverse of the interleave of (x XOR y) and y — independent of the recursion. */
function bayerClosed(n: number): number[][] {
  const k = Math.log2(n)
  const m: number[][] = []
  for (let y = 0; y < n; y++) {
    const row: number[] = []
    for (let x = 0; x < n; x++) {
      let v = 0
      for (let b = 0; b < k; b++) {
        const digit = 2 * (((x ^ y) >> b) & 1) + ((y >> b) & 1)
        v += digit * 4 ** (k - 1 - b)
      }
      row.push(v)
    }
    m.push(row)
  }
  return m
}

function randomImage(w: number, h: number, seed: number, colours?: RGB[]): Img {
  const r = seeded(seed)
  const data = new Uint8ClampedArray(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const c = colours ? colours[Math.floor(r() * colours.length)] : ([r() * 256, r() * 256, r() * 256].map(Math.floor) as RGB)
    data.set(c, 3 * i)
  }
  return { w, h, data }
}

export const checks: Check[] = [
  {
    name: 'Bayer matrices: 2×2 = [[0,2],[3,1]], 4×4 is the classic table, and 2/4/8 match the bit-interleave closed form',
    run() {
      eq(bayer(2), [
        [0, 2],
        [3, 1],
      ])
      eq(bayer(4), [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5],
      ])
      for (const n of [2, 4, 8]) {
        eq(bayer(n), bayerClosed(n), `n=${n}`)
        const flat = bayer(n).flat().sort((a, b) => a - b)
        eq(flat, Array.from({ length: n * n }, (_, i) => i), `n=${n} is a permutation`)
      }
    },
  },
  {
    name: 'diffusion kernels: Floyd–Steinberg and JJN pass on all the error, Atkinson exactly 6/8',
    run() {
      const frac = (k: keyof typeof KERNELS) => KERNELS[k].taps.reduce((s, t) => s + t[2], 0) / KERNELS[k].divisor
      eq(frac('fs'), 1)
      eq(frac('jjn'), 1)
      eq(frac('atkinson'), 6 / 8)
      // Floyd–Steinberg's published weights, in scan order: right 7, below-left 3, below 5, below-right 1.
      eq(KERNELS.fs.taps.map((t) => t[2]), [7, 3, 5, 1])
    },
  },
  {
    name: 'error diffusion conserves colour: Σ(output − input) + error lost off the edges + error the kernel drops = 0',
    run() {
      const img = randomImage(40, 30, 3)
      const pal: RGB[] = [
        [0, 0, 0],
        [255, 255, 255],
        [255, 0, 0],
        [0, 128, 255],
      ]
      for (const k of ['fs', 'atkinson', 'jjn'] as const) {
        for (const serpentine of [false, true]) {
          const m = mapImage(img, pal, { kind: 'diffuse', kernel: KERNELS[k], serpentine })
          let delta = 0
          for (let i = 0; i < img.data.length; i++) delta += m.out[i] - img.data[i]
          near(delta + m.edgeLost + m.kernelLost, 0, 1e-2 * img.data.length, `${k} serpentine=${serpentine}`)
          if (k === 'atkinson') near(m.kernelLost, (2 / 8) * m.errSum, 1e-3 * Math.abs(m.errSum) + 1, 'Atkinson drops 2/8')
          else near(m.kernelLost, 0, 1e-6, `${k} drops nothing`)
        }
      }
    },
  },
  {
    name: 'an image made only of palette colours comes back unchanged under every dither, with zero error',
    run() {
      const pal: RGB[] = [
        [10, 20, 30],
        [200, 50, 90],
        [250, 250, 240],
      ]
      const img = randomImage(24, 16, 9, pal)
      const dithers = [
        { kind: 'none' as const },
        { kind: 'diffuse' as const, kernel: KERNELS.fs, serpentine: true },
        { kind: 'diffuse' as const, kernel: KERNELS.atkinson, serpentine: false },
      ]
      for (const d of dithers) {
        const m = mapImage(img, pal, d)
        for (let i = 0; i < img.data.length; i++) ok(m.out[i] === img.data[i], `${d.kind}: pixel byte ${i} changed`)
        near(m.errSum, 0, 1e-9, `${d.kind} error`)
      }
    },
  },
  {
    name: 'median cut: ≤ N boxes, every split on the longest side at the pixel median, single-colour boxes never split',
    run() {
      for (const [name, fn] of Object.entries(PRESETS)) {
        const table = colorTable(fn())
        for (const N of [2, 5, 16, 64]) {
          const res = medianCut(table, N)
          ok(res.boxes.length <= N, `${name} N=${N}: ${res.boxes.length} boxes`)
          let prev = res.initial
          for (const st of res.steps) {
            const parent = prev[st.box]
            ok(parent.items.length >= 2, 'split a single-colour box')
            eq(st.axis, longestAxis(parent), `${name}: cut not on the longest side`)
            // Median: the low half holds less than half the pixels before its last colour,
            // and at least half once that colour is included (unless clamped to keep both halves).
            const low = st.boxes[st.box]
            const high = st.boxes[st.boxes.length - 1]
            eq(low.n + high.n, parent.n, 'pixels conserved')
            const lowCounts = low.items.map((i) => table[i].n)
            const lastLow = lowCounts[lowCounts.length - 1]
            const clamped = high.items.length === 1
            ok(clamped || (low.n >= parent.n / 2 && low.n - lastLow < parent.n / 2), `${name}: not a median cut (${low.n} / ${parent.n})`)
            // Every low colour ≤ every high colour on the cut axis.
            const maxLow = Math.max(...low.items.map((i) => table[i].c[st.axis]))
            const minHigh = Math.min(...high.items.map((i) => table[i].c[st.axis]))
            ok(maxLow <= minHigh, 'halves overlap on the cut axis')
            prev = st.boxes
          }
        }
      }
    },
  },
  {
    name: 'k-means: distortion never increases from one iteration to the next',
    run() {
      for (const [name, fn] of Object.entries(PRESETS)) {
        const table = colorTable(fn())
        for (const N of [4, 16, 64]) {
          const steps = kmeans(table, medianCut(table, N).palette, 15)
          for (let i = 1; i < steps.length; i++) ok(steps[i].distortion <= steps[i - 1].distortion + 1e-6, `${name} N=${N} iteration ${i}: ${steps[i - 1].distortion} → ${steps[i].distortion}`)
        }
      }
    },
  },
  {
    name: 'an image with ≤ N distinct colours is reproduced exactly by median cut and by k-means',
    run() {
      const img = logo()
      const table = colorTable(img)
      ok(table.length <= 16, `logo has ${table.length} colours`)
      for (const N of [table.length, 16, 64]) {
        const mc = medianCut(table, N).palette
        const km = kmeans(table, mc, 10)
        const kmPal = km[km.length - 1].moved.map((c) => c.map(Math.round) as RGB)
        for (const pal of [mc, kmPal]) {
          const m = mapImage(img, pal, { kind: 'none' })
          for (let i = 0; i < img.data.length; i++) ok(m.out[i] === img.data[i], `N=${N}: pixel byte ${i} differs`)
        }
      }
    },
  },
  {
    name: 'uniform palettes: 216 is web-safe 6×6×6, 256 is 8×8×4 (3-3-2 bits), never more than N',
    run() {
      eq(uniformLevels(216), [6, 6, 6])
      eq(uniformLevels(256), [8, 8, 4])
      for (let N = 2; N <= 256; N++) {
        const l = uniformLevels(N)
        ok(l[0] * l[1] * l[2] <= N, `N=${N}: ${l}`)
      }
    },
  },
  {
    name: 'OKLab reference values: white is L=1, a=b=0; pure red matches Ottosson’s published (0.6279, 0.2249, 0.1258)',
    run() {
      const w = oklab(255, 255, 255)
      near(w[0], 1, 1e-4)
      near(w[1], 0, 1e-4)
      near(w[2], 0, 1e-4)
      const r = oklab(255, 0, 0)
      near(r[0], 0.6279, 2e-3)
      near(r[1], 0.2249, 2e-3)
      near(r[2], 0.1258, 2e-3)
      ok(dist2([0, 0, 0], [3, 4, 0]) === 25, 'dist2')
    },
  },
]
