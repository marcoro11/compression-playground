import { eq, near, ok, type Check } from '../../lib/check'
import { corpus, seeded } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { BENCH_OPTS, ppmDecode, ppmEncode } from './codec'
import { PpmModel, idealBits, type EscapeMethod, type PpmOptions } from './ppm'

/** A model that has seen `text`. */
function after(text: string | number[], opts: PpmOptions): PpmModel {
  const m = new PpmModel(opts)
  const bytes = typeof text === 'string' ? utf8(text) : text
  for (const b of bytes) m.explain(b)
  return m
}

const C = (s: string) => s.charCodeAt(0)

// Exact rationals for the "sums to one" check.
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b))
type Q = [bigint, bigint]
const mul = (x: Q, y: Q): Q => {
  const n = x[0] * y[0]
  const d = x[1] * y[1]
  const g = gcd(n, d)
  return [n / g, d / g]
}
const add = (x: Q, y: Q): Q => {
  const n = x[0] * y[1] + y[0] * x[1]
  const d = x[1] * y[1]
  const g = gcd(n, d)
  return [n / g, d / g]
}

/** Exact probability of byte x after `hist`, as the product of the per-level fractions the model reports. */
function exactProb(hist: number[], x: number, opts: PpmOptions): Q {
  const m = after(hist, opts)
  const t = m.explain(x)
  let p: Q = [1n, 1n]
  for (const l of t.levels) p = mul(p, [BigInt(l.num), BigInt(l.den)])
  return p
}

const classic = (exclusion: boolean): PpmOptions => ({ order: 2, escape: 'C', exclusion, updateExclusion: false })

export const checks: Check[] = [
  {
    // After "abracadabra", with every count updated at every order (no update
    // exclusion), the order-2/1/0 tables are the classic ones (Cleary & Witten
    // 1984; Bell, Cleary & Witten, Text Compression, ch. 6):
    //   order 2: ab→r 2, ac→a 1, ad→a 1, br→a 2, ca→d 1, da→b 1, ra→c 1
    //   order 1: a→{b 2, c 1, d 1}, b→r 2, c→a 1, d→a 1, r→a 2
    //   order 0: a 5, b 2, c 1, d 1, r 2
    // The current order-2 context is "ra", order-1 is "a".
    name: 'abracadabra, order 2, PPMC: the classic context tables',
    run() {
      const m = after('abracadabra', classic(false))
      const t = m.explain(C('z')) // a novel byte walks every level
      const tab = (k: number) =>
        Object.fromEntries(
          t.levels
            .find((l) => l.order === k)!
            .items.map((i) => [String.fromCharCode(i.sym), i.count])
            .sort(),
        )
      eq(tab(2), { c: 1 }, 'order 2, context "ra"')
      eq(tab(1), { b: 2, c: 1, d: 1 }, 'order 1, context "a"')
      eq(tab(0), { a: 5, b: 2, c: 1, d: 1, r: 2 }, 'order 0')
    },
  },
  {
    // PPMC: escape count = number of distinct symbols.
    //   'c' : order 2 "ra" offers c 1, escape 1                           → 1/2
    //   'a' : "ra" escape 1/2 · order 1 "a" (b2 c1 d1, esc 3) escape 3/7
    //         · order 0 (a5 b2 c1 d1 r2, esc 5) a 5/16                   → 15/224
    name: 'abracadabra, order 2, PPMC without exclusion: p(c) = 1/2, p(a) = 15/224',
    run() {
      const pc = exactProb(Array.from(utf8('abracadabra')), C('c'), classic(false))
      eq(pc.map(String), ['1', '2'])
      const pa = exactProb(Array.from(utf8('abracadabra')), C('a'), classic(false))
      eq(pa.map(String), ['15', '224'])
    },
  },
  {
    // With exclusion, each level forgets what the longer contexts offered:
    //   'a' : "ra" escape 1/2 (excl c) · order 1: b2 d1, q=2 → escape 2/5 (excl b d)
    //         · order 0: a5 r2, q=2 → a 5/9                               → 1/9
    //   'z' : 1/2 · 2/5 · order 0 escape 2/9 · order −1 one of 256−5 = 251 → 2/11295
    name: 'abracadabra, order 2, PPMC with exclusion: p(a) = 1/9, p(z) = 2/11295',
    run() {
      const h = Array.from(utf8('abracadabra'))
      eq(exactProb(h, C('a'), classic(true)).map(String), ['1', '9'])
      eq(exactProb(h, C('z'), classic(true)).map(String), ['2', '11295'])
    },
  },
  {
    // Order 0, PPMC, coding "aab" from nothing:
    //   a : order 0 unseen → order −1, 1/256                       8 bits
    //   a : order 0 {a 1}, escape 1 → a 1/2                          1 bit
    //   b : escape 1/3, then order −1 without 'a' → 1/255  log₂3 + log₂255
    name: 'order 0 PPMC on "aab" costs 8 + 1 + log₂3 + log₂255 bits (log₂256 without exclusion)',
    run() {
      const opts: PpmOptions = { order: 0, escape: 'C', exclusion: true, updateExclusion: false }
      near(idealBits(utf8('aab'), opts), 8 + 1 + Math.log2(3) + Math.log2(255), 1e-9)
      near(idealBits(utf8('aab'), { ...opts, exclusion: false }), 8 + 1 + Math.log2(3) + 8, 1e-9)
    },
  },
  {
    // Method D gives p(s) = (2c−1)/2n and p(esc) = q/2n: the order-0 total after
    // abracadabra is 2·11 = 22, and p(a) = 9/22.
    name: 'escape method D: order-0 total is 2n, p(a) = 9/22 after abracadabra',
    run() {
      const opts: PpmOptions = { order: 0, escape: 'D', exclusion: false, updateExclusion: false }
      const t = after('abracadabra', opts).explain(C('a'))
      eq([t.levels[0].num, t.levels[0].den], [9, 22])
    },
  },
  {
    // With exclusion, the code space is used exactly: Σ p = 1. Without it, the
    // escape path still reserves room for bytes a longer context already
    // offered — room no byte can ever use — so Σ p < 1 (unless nothing was
    // offered twice). Both are checked exactly, with rationals.
    name: 'next-byte distributions: Σp = 1 exactly with exclusion, Σp ≤ 1 without (all methods, 160 random histories)',
    run() {
      const r = seeded(21)
      const methods: EscapeMethod[] = ['A', 'B', 'C', 'D']
      let wasted = 0
      for (let t = 0; t < 160; t++) {
        const opts: PpmOptions = {
          order: Math.floor(r() * 4),
          escape: methods[t % 4],
          exclusion: r() < 0.5,
          updateExclusion: r() < 0.5,
        }
        const len = Math.floor(r() * 25)
        const hist = Array.from({ length: len }, () => 97 + Math.floor(r() ** 2 * 5))
        let sum: Q = [0n, 1n]
        const floats = after(hist, opts).predict()
        for (let x = 0; x < 256; x++) {
          const p = exactProb(hist, x, opts)
          sum = add(sum, p)
          // The blended float view the page draws must agree with the exact walk.
          near(floats[x], Number(p[0]) / Number(p[1]), 1e-12, `predict() for byte ${x}`)
        }
        const label = `trial ${t} ${JSON.stringify(opts)} after "${String.fromCharCode(...hist)}"`
        if (opts.exclusion) eq(sum.map(String), ['1', '1'], label)
        else {
          ok(sum[0] <= sum[1], label + ': sums to more than 1')
          if (sum[0] < sum[1]) wasted++
        }
      }
      ok(wasted > 10, `expected some no-exclusion histories to waste code space, got ${wasted}`)
    },
  },
  {
    name: 'the arithmetic-coded size is within a few bytes of Σ −log₂p from the model',
    run() {
      for (const { id, data } of corpus()) {
        const ideal = idealBits(data, BENCH_OPTS)
        const header = data.length < 128 ? 1 : data.length < 16384 ? 2 : 3
        const actual = (ppmEncode(data, BENCH_OPTS).length - header) * 8
        // ≤ 2 bits of termination, ≤ 8 bits of padding, and a sliver of rounding per event.
        ok(actual >= ideal - 1 && actual <= ideal + 10 + data.length * 0.001, `${id}: ${actual} bits vs ideal ${ideal.toFixed(1)}`)
      }
    },
  },
  {
    name: 'every option the page offers round-trips (orders 0–5 × methods A–D × exclusion × update exclusion)',
    run() {
      const inputs = corpus().filter((c) => c.data.length < 1000)
      const methods: EscapeMethod[] = ['A', 'B', 'C', 'D']
      for (let order = 0; order <= 5; order++)
        for (const escape of methods)
          for (const exclusion of [false, true])
            for (const updateExclusion of [false, true]) {
              const opts = { order, escape, exclusion, updateExclusion }
              for (const { id, data } of inputs) {
                const back = ppmDecode(ppmEncode(data, opts), opts)
                ok(back.length === data.length && back.every((v, i) => v === data[i]), `${id} ${JSON.stringify(opts)}`)
              }
            }
    },
  },
  {
    name: 'context helps: order 5 on the repeated prose costs far less than order 0',
    run() {
      const prose = corpus().find((c) => c.id === 'prose-x40')!.data
      const o0 = idealBits(prose, { ...BENCH_OPTS, order: 0 })
      const o5 = idealBits(prose, BENCH_OPTS)
      ok(o5 < o0 / 4, `order 5 ${o5.toFixed(0)} bits vs order 0 ${o0.toFixed(0)}`)
    },
  },
]
