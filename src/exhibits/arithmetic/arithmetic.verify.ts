import { eq, ok, type Check } from '../../lib/check'
import { corpus, seeded } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { FreqModel, codeWord, decode, encode, idealIntervals, shortestPoint } from './coder'

/** Static model: byte histogram, counted here without the library. */
function histogram(data: Uint8Array): number[] {
  const c = new Array(256).fill(0)
  for (const b of data) c[b]++
  return c
}

/** −Σ log₂ p under a static model, computed directly. */
function staticIdeal(data: Uint8Array): number {
  const c = histogram(data)
  let bits = 0
  for (const b of data) bits -= Math.log2(c[b] / data.length)
  return bits
}

/** The adaptive codec's ideal length, re-implementing its update rule from scratch. */
function adaptiveIdeal(data: Uint8Array): number {
  const c = new Array(256).fill(1)
  let t = 256
  let bits = 0
  for (const b of data) {
    bits -= Math.log2(c[b] / t)
    c[b] += 32
    t += 32
    if (t > 65536) {
      t = 0
      for (let i = 0; i < 256; i++) {
        c[i] = Math.max(1, Math.ceil(c[i] / 2))
        t += c[i]
      }
    }
  }
  return bits
}

export const checks: Check[] = [
  {
    name: "exact interval for 'aab' with p(a)=2/3 is [8/27, 12/27); code word 0101, shortest point 0.011",
    run() {
      const steps = idealIntervals([0, 0, 1], new FreqModel([2, 1]))
      const iv = steps[2].after
      // L/D = 8/27 and W/D = 4/27, compared by cross-multiplication.
      ok(iv.L * 27n === 8n * iv.D, `low = ${iv.L}/${iv.D}`)
      ok(iv.W * 27n === 4n * iv.D, `width = ${iv.W}/${iv.D}`)
      eq(codeWord(iv), '0101')
      eq(shortestPoint(iv), '011')
    },
  },
  {
    name: 'static model: output within 2 bits + termination of −Σlog₂p on every corpus input',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length === 0) continue
        const h = histogram(data)
        const r = encode(data, new FreqModel(h), 32)
        const ideal = staticIdeal(data)
        // 2 bits of termination, plus a whisker for 32-bit truncation.
        ok(r.bitLength <= ideal + 2 + 1e-6 * data.length + 1, `${id}: ${r.bitLength} bits vs ideal ${ideal.toFixed(2)}`)
        ok(r.bitLength >= Math.floor(ideal), `${id}: beat the entropy?! ${r.bitLength} < ${ideal}`)
        eq(decode(r.bytes, data.length, new FreqModel(h), 32), Array.from(data), id)
      }
    },
  },
  {
    name: 'adaptive order-0: output within 3 bits of the ideal adaptive code length',
    run() {
      for (const { id, data } of corpus()) {
        const r = encode(data, new FreqModel(new Array(256).fill(1), 32, 1 << 16), 32)
        const ideal = adaptiveIdeal(data)
        ok(r.bitLength <= ideal + 3 + 1e-6 * data.length, `${id}: ${r.bitLength} vs ${ideal.toFixed(2)}`)
      }
    },
  },
  {
    name: 'skewed input beats Huffman’s 1 bit/symbol floor (p = 0.95 → ≈ 0.29 bits/symbol)',
    run() {
      const r = seeded(21)
      const data = new Uint8Array(5000)
      for (let i = 0; i < data.length; i++) data[i] = r() < 0.95 ? 97 : 98
      const bits = encode(data, new FreqModel(histogram(data)), 32).bitLength
      ok(bits / data.length < 0.35, `${bits / data.length} bits/symbol`)
    },
  },
  {
    name: '16-bit traced coder: trace bits equal the packed stream, and it decodes',
    run() {
      const data = utf8('aaaaaaaaabaaaaaaaaacaaaaaaaaabaaaaaaaaadaaaaaaaaab')
      const alphabet = [...new Set(data)].sort((a, b) => a - b)
      const syms = Array.from(data, (b) => alphabet.indexOf(b))
      const counts = alphabet.map((a) => data.filter((b) => b === a).length)
      const r = encode(syms, new FreqModel(counts), 16, true)
      eq(r.bits.length, r.bitLength)
      const packed = Array.from(r.bytes, (b) => b.toString(2).padStart(8, '0')).join('').slice(0, r.bitLength)
      eq(packed, r.bits)
      eq(decode(r.bytes, syms.length, new FreqModel(counts), 16), syms)
      ok(r.states.some((s) => s.kind === 'E3'), 'expected at least one E3 on this input')
    },
  },
]
