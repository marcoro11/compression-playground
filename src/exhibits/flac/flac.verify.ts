import { eq, near, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import {
  FIXED_COEFS,
  SIGNALS,
  autocorr,
  bestRice,
  decodeStream,
  encodeStream,
  fixedResidual,
  fold,
  levinson,
  riceCost,
  synth,
  unfold,
  type EncodeOptions,
} from './flac'

/** Solve the normal equations R a = r directly (Gaussian elimination with partial pivoting). */
function solveNormal(r: Float64Array, p: number): number[] {
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p ? r[Math.abs(i - j)] : r[i + 1])))
  for (let c = 0; c < p; c++) {
    let piv = c
    for (let i = c + 1; i < p; i++) if (Math.abs(A[i][c]) > Math.abs(A[piv][c])) piv = i
    ;[A[c], A[piv]] = [A[piv], A[c]]
    for (let i = 0; i < p; i++) {
      if (i === c) continue
      const f = A[i][c] / A[c][c]
      for (let j = c; j <= p; j++) A[i][j] -= f * A[c][j]
    }
  }
  return A.map((row, i) => row[p] / row[i])
}

const AUTO: EncodeOptions = { bps: 16, blockSize: 4096, mode: 'auto', maxLpc: 12, maxPo: 8, precision: 12 }

export const checks: Check[] = [
  {
    name: 'fixed predictor coefficients are the binomial rows with alternating signs',
    run() {
      for (let o = 1; o <= 4; o++) {
        const row = [] as number[]
        let c = 1
        for (let j = 1; j <= o; j++) {
          c = (c * (o - j + 1)) / j
          row.push((j % 2 ? 1 : -1) * c)
        }
        eq(FIXED_COEFS[o], row, `order ${o}`)
      }
    },
  },
  {
    name: 'order d+1 fixed prediction leaves exactly zero residual on any degree-d integer polynomial',
    run() {
      const r = seeded(4)
      for (let d = 0; d <= 3; d++) {
        const coef = Array.from({ length: d + 1 }, () => Math.floor(r() * 7) - 3)
        const x = Int32Array.from({ length: 200 }, (_, t) => coef.reduce((s, c, i) => s + c * t ** i, 0))
        const res = fixedResidual(x, 0, x.length, d + 1)
        ok(res.every((v) => v === 0), `degree ${d}: residual not all zero`)
      }
    },
  },
  {
    name: 'Levinson–Durbin equals a direct solve of the normal equations (orders 1–12, every signal)',
    run() {
      for (const s of SIGNALS) {
        const x = synth(s.id, 0.3)
        const r = autocorr(Array.from(x.subarray(1000, 3048)), 12)
        const { coefs } = levinson(r, 12)
        for (const p of [1, 2, 5, 8, 12]) {
          const direct = solveNormal(r, p)
          for (let j = 0; j < p; j++) near(coefs[p - 1][j], direct[j], 1e-6 * Math.max(1, Math.abs(direct[j])), `${s.id} order ${p} a${j + 1}`)
        }
      }
    },
  },
  {
    name: 'the Rice parameter chosen per partition is the brute-force optimum (2000 random partitions)',
    run() {
      const r = seeded(21)
      for (let t = 0; t < 2000; t++) {
        const n = 1 + Math.floor(r() * 300)
        const scale = 2 ** Math.floor(r() * 16)
        const u = Uint32Array.from({ length: n }, () => fold(Math.round((r() - 0.5) * scale * (r() < 0.1 ? 8 : 1))))
        let bestBits = Infinity
        for (let k = 0; k <= 14; k++) bestBits = Math.min(bestBits, riceCost(u, 0, n, k))
        const got = bestRice(u, 0, n)
        eq(got.bits, bestBits, `trial ${t}`)
        eq(riceCost(u, 0, n, got.k), got.bits, `trial ${t}: reported k`)
      }
    },
  },
  {
    name: 'zigzag fold: 0, −1, 1, −2, 2 → 0, 1, 2, 3, 4 and back',
    run() {
      eq([0, -1, 1, -2, 2].map(fold), [0, 1, 2, 3, 4])
      for (let v = -40000; v <= 40000; v += 7) eq(unfold(fold(v)), v)
    },
  },
  {
    name: 'every synthetic signal round-trips bit-exactly, and the reported bit count is the stream’s',
    run() {
      for (const s of SIGNALS) {
        const x = synth(s.id)
        for (const o of [AUTO, { ...AUTO, mode: 'fixed' as const, order: 2 }, { ...AUTO, mode: 'lpc' as const, order: 8, precision: 9 }, { ...AUTO, blockSize: 1152, maxPo: 3 }]) {
          const enc = encodeStream(x, o)
          const header = 32 + 5 + 16
          eq(enc.bits, header + enc.blocks.reduce((a, b) => a + b.best.bits, 0), `${s.id} ${o.mode}: bit accounting`)
          const dec = decodeStream(enc.bytes)
          eq(dec.samples.length, x.length)
          for (let i = 0; i < x.length; i++) if (dec.samples[i] !== x[i]) throw new Error(`${s.id} ${o.mode}: sample ${i} ${dec.samples[i]} ≠ ${x[i]}`)
        }
      }
    },
  },
  {
    name: 'prediction pays: the chord takes under 6 bits/sample, white noise over 13 (of 16)',
    run() {
      const bps = (id: Parameters<typeof synth>[0]) => encodeStream(synth(id), AUTO).bits / synth(id).length
      ok(bps('chord') < 6, `chord ${bps('chord')}`)
      ok(bps('noise') > 13, `noise ${bps('noise')}`)
    },
  },
]
