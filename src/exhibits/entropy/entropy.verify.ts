import { eq, near, ok, type Check } from '../../lib/check'
import { conditionalEntropy, entropy, entropyOf } from '../../lib/entropy'
import { randomBytes } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { guessBounds, shrinkable, stringsOfLength, stringsShorterThan } from './info'

export const checks: Check[] = [
  {
    name: 'uniform over 2^k symbols has entropy exactly k bits',
    run() {
      for (let k = 0; k <= 8; k++) near(entropy(new Array(2 ** k).fill(7)), k, 1e-12, `k=${k}`)
    },
  },
  {
    name: 'H(fair coin) = 1, H([1,1,2]) = 1.5, H(certain) = 0',
    run() {
      near(entropy([1, 1]), 1, 1e-12)
      near(entropy([1, 1, 2]), 1.5, 1e-12)
      near(entropy([0, 5, 0]), 0, 1e-12)
      // Binary entropy at p = 0.1, by hand: −0.1·log₂0.1 − 0.9·log₂0.9
      near(entropy([1, 9]), 0.4689955935892812, 1e-12)
    },
  },
  {
    name: 'a strictly periodic string has ~0 conditional entropy once k ≥ period',
    run() {
      const s = utf8('abcde'.repeat(400))
      near(entropyOf(s), Math.log2(5), 1e-9, 'order 0')
      for (const k of [1, 2, 3]) near(conditionalEntropy(s, k), 0, 1e-12, `k=${k}`)
      const t = utf8('aab'.repeat(300)) // 'a' is followed by 'a' or 'b' — needs k = 2
      ok(conditionalEntropy(t, 1) > 0.5, 'k=1 is still uncertain')
      near(conditionalEntropy(t, 2), 0, 1e-12, 'k=2')
    },
  },
  {
    name: 'random bytes sit near 8 bits/byte at order 0',
    run() {
      const h = entropyOf(randomBytes(200000, 4))
      ok(h > 7.998 && h <= 8, `got ${h}`)
    },
  },
  {
    name: 'pigeonhole: 2ⁿ strings of n bits, only 2ⁿ − 1 shorter ones',
    run() {
      for (let n = 0; n <= 10; n++) {
        eq(stringsOfLength(n).length, 2 ** n, `n=${n}`)
        eq(stringsShorterThan(n).length, 2 ** n - 1, `n=${n}`)
        eq(new Set(stringsShorterThan(n)).size, 2 ** n - 1, `distinct n=${n}`)
      }
      eq(stringsShorterThan(3), ['', '0', '1', '00', '01', '10', '11'])
      // At most 2^(n−k+1) − 1 of the 2ⁿ inputs can shrink by k bits: under 1 in 2^(k−1).
      eq(shrinkable(16, 8), 511)
      ok(shrinkable(16, 8) / 2 ** 16 < 2 ** -7, 'fraction bound')
    },
  },
  {
    name: "Shannon's guessing bounds: perfect guessing → 0, uniform over 27 → log₂27 upper",
    run() {
      const perfect = guessBounds(new Array(50).fill(1))
      near(perfect.upper, 0, 1e-12)
      near(perfect.lower, 0, 1e-12)
      const uniform = guessBounds(Array.from({ length: 27 * 4 }, (_, i) => (i % 27) + 1))
      near(uniform.upper, Math.log2(27), 1e-9)
      ok(uniform.lower <= uniform.upper, 'lower ≤ upper')
      const mixed = guessBounds([1, 1, 1, 2, 1, 3, 1, 1, 5, 2])
      ok(mixed.lower <= mixed.upper + 1e-12, 'lower ≤ upper on a monotone-ish sample')
    },
  },
]
