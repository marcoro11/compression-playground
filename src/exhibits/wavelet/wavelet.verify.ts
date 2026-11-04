import { eq, near, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { bandNorms, bands, forward1d, forward2d, inverse1d, inverse2d, mirror, trace53 } from './wavelet'

const randInts = (r: () => number, n: number, lo = -300, hi = 300) => Array.from({ length: n }, () => lo + Math.floor(r() * (hi - lo + 1)))

/**
 * The 5/3 reversible transform written out the long way from T.800 eqs. F-5/F-6,
 * with explicit extended arrays instead of index mirroring — independent of the
 * in-place lifting in wavelet.ts.
 */
function naive53(x: number[]): { s: number[]; d: number[] } {
  const n = x.length
  if (n === 1) return { s: [x[0]], d: [] }
  // Extend x by whole-sample symmetry far enough on both sides.
  const X = (i: number): number => {
    while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i
    return x[i]
  }
  // Y(2k+1) for every k such that 2k+1 is in [−1, n]: needed by the even step.
  const Y = new Map<number, number>()
  for (let i = -1; i <= n; i++) if (((i % 2) + 2) % 2 === 1) Y.set(i, X(i) - Math.floor((X(i - 1) + X(i + 1)) / 2))
  const s: number[] = []
  const d: number[] = []
  for (let i = 0; i < n; i += 2) s.push(X(i) + Math.floor((Y.get(i - 1)! + Y.get(i + 1)! + 2) / 4))
  for (let i = 1; i < n; i += 2) d.push(Y.get(i)!)
  return { s, d }
}

export const checks: Check[] = [
  {
    name: 'symmetric extension mirrors about the end samples (x[−1]=x[1], x[N]=x[N−2])',
    run() {
      eq([-2, -1, 0, 7, 8, 9].map((p) => mirror(p, 8)), [2, 1, 0, 7, 6, 5])
      eq([-1, 1, 2].map((p) => mirror(p, 2)), [1, 1, 0])
    },
  },
  {
    name: '5/3 by hand: [10, 12, 14, 20, 20, 18, 9, 3] → s = [10, 15, 22, 9], d = [0, 3, 4, −6]',
    run() {
      // Worked by hand from F-5/F-6 with x[8] = x[6] = 9:
      // d0 = 12 − ⌊(10+14)/2⌋ = 0     d1 = 20 − ⌊(14+20)/2⌋ = 3
      // d2 = 18 − ⌊(20+9)/2⌋  = 18 − 14 = 4
      // d3 = 3  − ⌊(9+9)/2⌋   = −6
      // s0 = 10 + ⌊(d0+d0+2)/4⌋ = 10 + 0 = 10
      // s1 = 14 + ⌊(0+3+2)/4⌋   = 14 + 1 = 15
      // s2 = 20 + ⌊(3+4+2)/4⌋   = 20 + 2 = 22
      // s3 = 9  + ⌊(4−6+2)/4⌋   = 9 + 0  = 9
      const t = forward1d([10, 12, 14, 20, 20, 18, 9, 3], 'cdf53', true)
      eq(Array.from(t), [10, 15, 22, 9, 0, 3, 4, -6])
    },
  },
  {
    name: '5/3 integer lifting equals the long-hand T.800 formula on 400 random signals (lengths 1–40)',
    run() {
      const r = seeded(21)
      for (let t = 0; t < 400; t++) {
        const n = 1 + Math.floor(r() * 40)
        const x = randInts(r, n)
        const { s, d } = naive53(x)
        eq(Array.from(forward1d(x, 'cdf53', true)), [...s, ...d], `n=${n}`)
      }
    },
  },
  {
    name: '5/3 integer transform is exactly reversible in 1-D (lengths 1–65) and its trace inverts too',
    run() {
      const r = seeded(4)
      for (let n = 1; n <= 65; n++)
        for (let t = 0; t < 6; t++) {
          const x = randInts(r, n, 0, 255)
          const back = inverse1d(forward1d(x, 'cdf53', true), 'cdf53', true)
          eq(Array.from(back), x, `n=${n}`)
          const tr = trace53(x)
          eq(tr[tr.length - 1].y, x, `trace n=${n}`)
        }
    },
  },
  {
    name: '5/3 integer transform is exactly reversible in 2-D, 1–6 levels, odd and even sizes',
    run() {
      const r = seeded(8)
      for (const [w, h] of [
        [64, 64],
        [37, 20],
        [1, 9],
        [9, 1],
        [33, 33],
      ]) {
        const img = randInts(r, w * h, 0, 255)
        for (let L = 1; L <= 6; L++) {
          const { coefs } = forward2d(img, w, h, L, 'cdf53', true)
          for (let i = 0; i < coefs.length; i++) ok(Number.isInteger(coefs[i]), 'non-integer coefficient')
          const back = inverse2d(coefs, w, h, L, 'cdf53', true)
          eq(Array.from(back), img, `${w}×${h} L=${L}`)
        }
      }
    },
  },
  {
    name: 'orthonormal Haar preserves energy (Parseval) to 1e-9, in 1-D and 5-level 2-D',
    run() {
      const r = seeded(2)
      const energy = (a: ArrayLike<number>) => {
        let e = 0
        for (let i = 0; i < a.length; i++) e += a[i] * a[i]
        return e
      }
      for (let t = 0; t < 50; t++) {
        const x = Array.from({ length: 64 }, () => r() * 200 - 100)
        near(energy(forward1d(x, 'haar')), energy(x), 1e-9 * energy(x))
      }
      const img = Array.from({ length: 128 * 128 }, () => r() * 255)
      const { coefs } = forward2d(img, 128, 128, 5, 'haar')
      near(energy(coefs), energy(img), 1e-9 * energy(img))
      // And its band norms are all exactly 1.
      for (const n of bandNorms(64, 64, 3, 'haar')) near(n, 1, 1e-12)
    },
  },
  {
    name: 'float 5/3 and 9/7 invert to 1e-9 (the lossy path loses nothing before quantization)',
    run() {
      const r = seeded(6)
      const img = Array.from({ length: 48 * 40 }, () => r() * 255)
      for (const kind of ['cdf53', 'cdf97'] as const) {
        const { coefs } = forward2d(img, 48, 40, 4, kind)
        const back = inverse2d(coefs, 48, 40, 4, kind)
        for (let i = 0; i < img.length; i++) near(back[i], img[i], 1e-9, kind)
      }
    },
  },
  {
    name: 'a constant image has nothing but zeros outside LL, for every kind',
    run() {
      const img = new Array(64 * 64).fill(173)
      for (const [kind, int] of [
        ['haar', false],
        ['cdf53', true],
        ['cdf53', false],
        ['cdf97', false],
      ] as const) {
        const { coefs } = forward2d(img, 64, 64, 4, kind, int)
        for (const b of bands(64, 64, 4)) {
          if (b.orient === 'LL') continue
          for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) near(coefs[y * 64 + x], 0, 1e-9, `${kind} ${b.orient}${b.level}`)
        }
      }
    },
  },
  {
    name: '5/3 annihilates straight lines: a ramp has zero detail everywhere (Haar does not)',
    run() {
      // A linear ramp x[i] = 7i + 3. The 5/3 predictor is linear interpolation, so
      // every odd sample is predicted exactly; with symmetric extension the end is
      // a reflection, which is still exact for the last odd sample when N is even.
      const x = Array.from({ length: 32 }, (_, i) => 7 * i + 3)
      const t = forward1d(x, 'cdf53', true)
      const d = Array.from(t.slice(16))
      eq(d.slice(0, 15), new Array(15).fill(0), 'interior details')
      // The last detail sits against the mirror: x[32] := x[30], so it predicts a fold, not a line.
      ok(d[15] !== 0, 'the last detail sees the mirrored edge')
      // Haar's half-differences of a ramp are a constant −7/√2 — never zero.
      const hd = Array.from(forward1d(x, 'haar').slice(16))
      for (const v of hd) near(v, -7 / Math.SQRT2, 1e-9)
    },
  },
  {
    name: '9/7 has unit DC gain per pass, and is close to orthogonal: its LL synthesis norm doubles per level',
    run() {
      const t = forward1d(new Array(64).fill(1), 'cdf97')
      for (let i = 0; i < 32; i++) near(t[i], 1, 1e-9, 'low band of a constant')
      for (let i = 32; i < 64; i++) near(t[i], 0, 1e-9, 'high band of a constant')
      for (const kind of ['cdf97'] as const) {
        const ll = [1, 2, 3, 4].map((L) => bandNorms(128, 128, L, kind)[0])
        for (let k = 1; k < 4; k++) near(ll[k] / ll[k - 1], 2, 0.15, `${kind} LL${k + 1}/LL${k}`)
      }
    },
  },
]
