import { eq, ok, type Check } from '../../lib/check'
import { buildTree, canonicalCodes, codedBits, kraft, limitedLengths, treeCodes } from '../../lib/huffman'
import { byteCounts, entropy } from '../../lib/entropy'
import { seeded } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { toBin } from '../../lib/bits'

/** Exhaustive optimum over all length vectors with Kraft ≤ 1 and every length ≤ L. Tiny alphabets only. */
function bruteForce(freqs: number[], L: number): number {
  let best = Infinity
  const len = new Array(freqs.length).fill(1)
  const rec = (i: number) => {
    if (i === freqs.length) {
      let k = 0
      for (const l of len) k += 2 ** -l
      if (k <= 1 + 1e-12) best = Math.min(best, codedBits(freqs, len))
      return
    }
    for (let l = 1; l <= L; l++) {
      len[i] = l
      rec(i + 1)
    }
  }
  rec(0)
  return best
}

export const checks: Check[] = [
  {
    name: 'canonical codes match the RFC 1951 §3.2.2 worked example',
    run() {
      // ABCDEFGH with lengths (3,3,3,3,3,2,4,4)
      const lengths = [3, 3, 3, 3, 3, 2, 4, 4]
      const codes = canonicalCodes(lengths).map((c, i) => toBin(c, lengths[i]))
      eq(codes, ['010', '011', '100', '101', '110', '00', '1110', '1111'])
    },
  },
  {
    name: 'abracadabra costs 23 bits (a5 b2 r2 c1 d1) and is a complete prefix code',
    run() {
      const h = byteCounts(utf8('abracadabra'))
      const b = buildTree(h)
      eq(codedBits(h, b.lengths), 23)
      eq(kraft(b.lengths), 1)
      // Sum of internal weights = coded bits.
      eq(b.steps.reduce((s, st) => s + st.parent.weight, 0), 23)
      const codes = treeCodes(b.root, 256).filter(Boolean)
      for (const a of codes) for (const c of codes) if (a !== c) ok(!c.startsWith(a), `${a} is a prefix of ${c}`)
    },
  },
  {
    name: 'Huffman is within 1 bit/symbol of entropy on 300 random histograms',
    run() {
      const r = seeded(5)
      for (let t = 0; t < 300; t++) {
        const n = 2 + Math.floor(r() * 40)
        const f = Array.from({ length: n }, () => 1 + Math.floor(r() ** 3 * 500))
        const b = buildTree(f)
        const total = f.reduce((a, x) => a + x, 0)
        const avg = codedBits(f, b.lengths) / total
        const H = entropy(f)
        ok(avg >= H - 1e-9 && avg < H + 1, `avg ${avg} vs H ${H}`)
      }
    },
  },
  {
    name: 'package-merge equals plain Huffman when the cap does not bind',
    run() {
      const r = seeded(9)
      for (let t = 0; t < 200; t++) {
        const n = 2 + Math.floor(r() * 60)
        const f = Array.from({ length: n }, () => Math.floor(r() ** 2 * 1000))
        const plain = buildTree(f)
        if (plain.leaves.length === 0) continue
        eq(codedBits(f, limitedLengths(f, 30)), codedBits(f, plain.lengths), `trial ${t}`)
      }
    },
  },
  {
    name: 'package-merge is optimal under a binding cap (exhaustive search, 300 cases)',
    run() {
      const r = seeded(13)
      for (let t = 0; t < 300; t++) {
        const n = 2 + Math.floor(r() * 5)
        const L = Math.max(Math.ceil(Math.log2(n)), 2 + Math.floor(r() * 3))
        const f = Array.from({ length: n }, () => 1 + Math.floor(r() ** 4 * 200))
        const pm = limitedLengths(f, L)
        ok(Math.max(...pm) <= L, 'cap exceeded')
        ok(kraft(pm) <= 1 + 1e-12, 'Kraft violated')
        eq(codedBits(f, pm), bruteForce(f, L), `f=${f} L=${L}`)
      }
    },
  },
  {
    name: 'a Fibonacci histogram makes plain Huffman deep; the cap holds it to 15',
    run() {
      const fib = [1, 1]
      while (fib.length < 25) fib.push(fib[fib.length - 1] + fib[fib.length - 2])
      const plain = buildTree(fib)
      eq(Math.max(...plain.lengths), 24)
      const capped = limitedLengths(fib, 15)
      eq(Math.max(...capped), 15)
      eq(kraft(capped), 1)
    },
  },
]
