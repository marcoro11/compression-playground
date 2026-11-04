import { eq, ok, type Check } from '../../lib/check'
import { corpus, seeded } from '../../lib/samples'
import { buildTans, modelBits, normalize, ransModel, spreadStep, streamDecode, streamEncode, tansDecode, tansEncode, toyDecode, toyEncode } from './ans'
import { ransEncode, tansEncode as tansCodecEncode } from './codec'

/** Order-0 entropy in bits for a byte array, computed here without the library. */
function entropyBits(data: Uint8Array): number {
  const c = new Array(256).fill(0)
  for (const b of data) c[b]++
  let h = 0
  for (const n of c) if (n) h -= n * Math.log2(n / data.length)
  return h
}

function randomSyms(r: () => number, n: number, alpha: number, skew: number): number[] {
  return Array.from({ length: n }, () => Math.min(alpha - 1, Math.floor(alpha * r() ** skew)))
}

export const checks: Check[] = [
  {
    name: 'hand-worked toy rANS: {a:3, b:1}, M = 4, encode "ab" from x = 4 → 19 → 25, and back',
    run() {
      const m = ransModel([3, 1], 2)
      eq(m.freq, [3, 1])
      eq(m.cum, [0, 3])
      // Backwards: 'b' first: ⌊4/1⌋·4 + 3 + 0 = 19; then 'a': ⌊19/3⌋·4 + 0 + (19 mod 3) = 25.
      const enc = toyEncode([0, 1], m)
      eq(
        enc.steps.map((s) => [Number(s.before), Number(s.after)]),
        [
          [4, 19],
          [19, 25],
        ],
      )
      const dec = toyDecode(enc.x, 2, m)
      eq(dec.syms, [0, 1])
      eq(dec.states.map(Number), [25, 19, 4])
    },
  },
  {
    name: 'toy rANS: log₂ of the final state tracks Σ log₂(M/f) (the information content) on 200 random messages',
    run() {
      const r = seeded(21)
      for (let t = 0; t < 200; t++) {
        const alpha = 2 + Math.floor(r() * 6)
        const n = 1 + Math.floor(r() * 60)
        const syms = randomSyms(r, n, alpha, 1 + r() * 3)
        const counts = new Array(alpha).fill(0)
        for (const s of syms) counts[s]++
        const m = ransModel(counts, 4 + Math.floor(r() * 6))
        const enc = toyEncode(syms, m)
        const grown = log2(enc.x) - log2(enc.x0)
        const ideal = modelBits(syms, m)
        // ⌊x/f⌋·M + c + (x mod f) lies in [x·M/f − M, x·M/f + M): each step can lose
        // or gain at most log₂(1 ± f/x); from x₀ = M that is under a bit or two in total.
        ok(Math.abs(grown - ideal) < 2, `n=${n}: grew ${grown.toFixed(3)} bits, ideal ${ideal.toFixed(3)}`)
        eq(toyDecode(enc.x, n, m).syms, syms, `trial ${t}`)
      }
    },
  },
  {
    name: 'streaming rANS: every decode step exactly undoes its encode step (state and bits), 300 random cases',
    run() {
      const r = seeded(33)
      for (let t = 0; t < 300; t++) {
        const alpha = 1 + Math.floor(r() * 8)
        const n = Math.floor(r() * 80)
        const syms = randomSyms(r, n, alpha, 1 + r() * 4)
        const counts = new Array(alpha).fill(0)
        for (const s of syms) counts[s]++
        if (n === 0) counts[0] = 1
        const k = Math.max(3, Math.ceil(Math.log2(alpha))) + Math.floor(r() * 5)
        const p = { m: ransModel(counts, k), h: Math.floor(r() * 6) }
        const enc = streamEncode(syms, p)
        const dec = streamDecode(enc.final, enc.stack, n, p)
        eq(dec.syms, syms, `trial ${t}`)
        // Decode step j inverts encode step n−1−j: same symbol, mirrored states, same bits reversed.
        for (let j = 0; j < n; j++) {
          const e = enc.steps[n - 1 - j]
          const d = dec.steps[j]
          eq([d.before, d.mid, d.after], [e.after, e.mid, e.before], `trial ${t} step ${j}`)
          eq(d.bits, e.bits.slice().reverse(), `trial ${t} step ${j} bits`)
        }
      }
    },
  },
  {
    name: 'normalize: sums to the target, keeps every present symbol ≥ 1, leaves an exact table alone',
    run() {
      const r = seeded(4)
      for (let t = 0; t < 300; t++) {
        const n = 1 + Math.floor(r() * 256)
        const c = Array.from({ length: n }, () => (r() < 0.3 ? 0 : 1 + Math.floor(r() ** 4 * 10000)))
        const used = c.filter(Boolean).length
        if (!used) continue
        const total = 2 ** Math.max(Math.ceil(Math.log2(used)), 4 + Math.floor(r() * 9))
        const f = normalize(c, total)
        eq(f.reduce((a, b) => a + b, 0), total)
        for (let i = 0; i < n; i++) ok(c[i] ? f[i] >= 1 : f[i] === 0, `symbol ${i}: count ${c[i]} → ${f[i]}`)
      }
      eq(normalize([5, 3, 0, 8], 16), [5, 3, 0, 8])
    },
  },
  {
    name: 'tANS table: spread step visits every slot once; each symbol owns exactly its count; encoder states are a permutation of [L, 2L)',
    run() {
      for (const L of [16, 32, 64, 2048]) {
        const step = spreadStep(L)
        const seen = new Set<number>()
        let pos = 0
        for (let i = 0; i < L; i++) {
          seen.add(pos)
          pos = (pos + step) & (L - 1)
        }
        eq(seen.size, L, `L=${L}`)
      }
      const r = seeded(8)
      for (let t = 0; t < 100; t++) {
        const alpha = 1 + Math.floor(r() * 12)
        const raw = Array.from({ length: alpha }, () => 1 + Math.floor(r() ** 3 * 500))
        const R = Math.max(4, Math.ceil(Math.log2(alpha))) + Math.floor(r() * 4)
        const tb = buildTans(raw, R)
        const owned = new Array(alpha).fill(0)
        for (const s of tb.spread) owned[s]++
        eq(owned, tb.counts)
        const states = tb.enc.flat().sort((a, b) => a - b)
        eq(states, Array.from({ length: tb.L }, (_, i) => tb.L + i))
        for (let u = 0; u < tb.L; u++) {
          ok(tb.base[u] >= 0 && tb.base[u] + 2 ** tb.nbBits[u] <= tb.L, `slot ${u} reaches outside the table`)
        }
      }
    },
  },
  {
    name: 'tANS step-through decodes back, 200 random messages',
    run() {
      const r = seeded(17)
      for (let t = 0; t < 200; t++) {
        const alpha = 1 + Math.floor(r() * 6)
        const n = 1 + Math.floor(r() * 60)
        const syms = randomSyms(r, n, alpha, 1 + r() * 3)
        const counts = new Array(alpha).fill(0)
        for (const s of syms) counts[s]++
        const tb = buildTans(counts, 5)
        const enc = tansEncode(syms, tb)
        const chunks = enc.steps
          .slice()
          .reverse()
          .map((s) => ({ value: s.value, nb: s.nb }))
        eq(tansDecode(enc.final, chunks, n, tb), syms, `trial ${t}`)
      }
    },
  },
  {
    name: 'codec sizes: rANS and tANS land within ~1% + table + a few bytes of the order-0 entropy on every corpus input',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length === 0) continue
        const H = entropyBits(data) / 8
        const used = new Set(data).size
        const table = 32 + 2 * used
        for (const [name, enc] of [
          ['rANS', ransEncode],
          ['tANS', tansCodecEncode],
        ] as const) {
          const size = enc(data).length
          const budget = H * 1.01 + data.length * 0.002 + table + 4 + 4 + 2
          ok(size <= budget, `${name} on ${id}: ${size} bytes, entropy ${H.toFixed(1)}, budget ${budget.toFixed(1)}`)
        }
      }
    },
  },
]

function log2(x: bigint): number {
  const s = x.toString(2)
  const top = s.slice(0, 50)
  return Math.log2(parseInt(top, 2)) + (s.length - top.length)
}
