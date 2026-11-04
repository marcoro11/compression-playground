import { eq, ok, type Check } from '../../lib/check'
import { entropyOf } from '../../lib/entropy'
import { seeded } from '../../lib/samples'
import { fromUtf8, utf8 } from '../../lib/text'
import { bwtForward, bwtInverse, mtfDecode, mtfEncode, naiveBwt, runDigits, usedSymbols, zeroRunDecode, zeroRunEncode, RUNA, RUNB } from './bwt'

const str = (a: ArrayLike<number>) => fromUtf8(Uint8Array.from(a as ArrayLike<number>))

export const checks: Check[] = [
  {
    name: "BWT('banana$') = 'annb$aa' and inverts",
    run() {
      const t = utf8('banana$')
      const b = bwtForward(t)
      eq(str(b.last), 'annb$aa')
      eq(str(bwtInverse(b.last, b.primary)), 'banana$')
    },
  },
  {
    name: 'the SIX.MIXED.PIXIES example from Burrows–Wheeler’s Wikipedia article',
    run() {
      const b = bwtForward(utf8('SIX.MIXED.PIXIES.SIFT.SIXTY.PIXIE.DUST.BOXES'))
      eq(str(b.last), 'TEXYDST.E.IXIXIXXSSMPPS.B..E.S.EUSFXDIIOIIIT')
    },
  },
  {
    name: 'prefix-doubling BWT equals sort-every-rotation on 500 short strings (incl. periodic)',
    run() {
      const r = seeded(21)
      for (let t = 0; t < 500; t++) {
        let s: number[]
        if (t % 5 === 0) {
          const unit = Array.from({ length: 1 + Math.floor(r() * 3) }, () => 97 + Math.floor(r() * 2))
          s = Array.from({ length: unit.length * (1 + Math.floor(r() * 6)) }, (_, i) => unit[i % unit.length])
        } else {
          s = Array.from({ length: 1 + Math.floor(r() * 24) }, () => 97 + Math.floor(r() * (1 + Math.floor(r() * 4))))
        }
        const fast = bwtForward(s)
        const slow = naiveBwt(s)
        eq(fast.last, slow.last, `L for ${str(s)}`)
        // Equal rotations may sit in either order; the primary row must hold the same rotation.
        eq(bwtInverse(fast.last, fast.primary), s, `inverse for ${str(s)}`)
        eq(bwtInverse(slow.last, slow.primary), s, `naive inverse for ${str(s)}`)
      }
    },
  },
  {
    name: "move-to-front of 'bananaaa' from [a, b, n] is 1 1 2 1 1 1 0 0",
    run() {
      const data = utf8('bananaaa')
      const init = usedSymbols(data)
      eq(init, [97, 98, 110])
      const out = mtfEncode(data, init)
      eq(out, [1, 1, 2, 1, 1, 1, 0, 0])
      eq(mtfDecode(out, init), Array.from(data))
    },
  },
  {
    name: 'RUNA/RUNB is bijective base 2: 1=A 2=B 3=AA 4=BA 5=AB 6=BB 7=AAA, and every n up to 5000 round-trips',
    run() {
      const spell = (n: number) => runDigits(n).map((d) => (d === RUNA ? 'A' : 'B')).join('')
      eq([1, 2, 3, 4, 5, 6, 7].map(spell), ['A', 'B', 'AA', 'BA', 'AB', 'BB', 'AAA'])
      for (let n = 1; n <= 5000; n++) {
        const d = runDigits(n)
        eq(d.reduce((s, x, i) => s + (x === RUNA ? 1 : 2) * 2 ** i, 0), n, `value of spelling of ${n}`)
        ok(d.every((x) => x === RUNA || x === RUNB), 'digit')
      }
      const mtf = [0, 0, 0, 3, 0, 1, 0, 0, 0, 0, 0, 0, 2]
      eq(zeroRunDecode(zeroRunEncode(mtf)), mtf)
      eq(zeroRunEncode([0, 0, 0, 0, 5]), [RUNB, RUNA, 6])
    },
  },
  {
    name: 'BWT + MTF cuts order-0 entropy of repeated prose by more than half',
    run() {
      const prose =
        'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, ' +
        'it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, ' +
        'it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us.'
      const data = utf8(prose.repeat(40))
      const raw = entropyOf(data)
      const { last } = bwtForward(data)
      const after = entropyOf(mtfEncode(last, usedSymbols(data)))
      ok(after < raw / 2, `raw ${raw.toFixed(3)} → after ${after.toFixed(3)} bits/byte`)
    },
  },
  {
    name: 'a 70 000-byte run of zeros transforms in well under a second',
    run() {
      const t = performance.now()
      const z = new Uint8Array(70000)
      const b = bwtForward(z)
      ok(b.last.every((v) => v === 0), 'all zeros')
      eq(bwtInverse(b.last, b.primary).length, 70000)
      ok(performance.now() - t < 1000, `took ${(performance.now() - t).toFixed(0)} ms`)
    },
  },
]
