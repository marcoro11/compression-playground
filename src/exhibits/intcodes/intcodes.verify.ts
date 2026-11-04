import { eq, ok, type Check } from '../../lib/check'
import { CODES, codeById, codeLength, encodeBits, expectedLength, makeDist, optimalGolombM, stringSource, unzigzag, zigzag, type IntCode } from './codes'

const enc = (id: Parameters<typeof codeById>[0], n: number, p = 0) => encodeBits(codeById(id), n, p)

/** Default parameters used for the parametrised codes in the generic checks. */
const PARAMS: Record<string, number[]> = { golomb: [1, 3, 5, 10, 64], rice: [0, 1, 3, 7], expgolomb: [0, 1, 4] }
const paramsOf = (c: IntCode) => (c.param ? PARAMS[c.id] : [0])

/** An Elias δ written straight from the definition, independently of codes.ts. */
function deltaRef(n: number): string {
  const b = n.toString(2)
  const L = b.length
  const lb = L.toString(2)
  return '0'.repeat(lb.length - 1) + lb + b.slice(1)
}

export const checks: Check[] = [
  {
    name: 'Elias γ: 1 → 1, 2 → 010, 9 → 0001001 (Elias 1975)',
    run() {
      eq([1, 2, 9].map((n) => enc('gamma', n)), ['1', '010', '0001001'])
    },
  },
  {
    name: 'Elias δ: 1 → 1, 2 → 0100, 10 → 00100010, and matches the definition for 1…5000',
    run() {
      eq([1, 2, 10].map((n) => enc('delta', n)), ['1', '0100', '00100010'])
      for (let n = 1; n <= 5000; n++) eq(enc('delta', n), deltaRef(n), `δ(${n})`)
    },
  },
  {
    name: 'Elias ω: 1 → 0, 2 → 100, 4 → 101000, 10 → 1110100',
    run() {
      eq([1, 2, 4, 10].map((n) => enc('omega', n)), ['0', '100', '101000', '1110100'])
    },
  },
  {
    name: 'Fibonacci: 1 → 11, 2 → 011, 3 → 0011, 4 → 1011, 11 → 001011, and no codeword contains 11 before its end',
    run() {
      eq([1, 2, 3, 4, 11].map((n) => enc('fib', n)), ['11', '011', '0011', '1011', '001011'])
      for (let n = 1; n <= 20000; n++) {
        const c = enc('fib', n)
        ok(c.endsWith('11') && !c.slice(0, -1).includes('11'), `fib(${n}) = ${c}`)
      }
    },
  },
  {
    name: 'Exp-Golomb k = 0 (H.264 ue(v)): 0 → 1, 1 → 010, 2 → 011, 3 → 00100, 7 → 0001000',
    run() {
      eq([0, 1, 2, 3, 7].map((n) => enc('expgolomb', n, 0)), ['1', '010', '011', '00100', '0001000'])
    },
  },
  {
    name: 'Golomb m = 3: 0…5 → 10, 110, 111, 010, 0110, 0111 (truncated-binary remainders)',
    run() {
      eq([0, 1, 2, 3, 4, 5].map((n) => enc('golomb', n, 3)), ['10', '110', '111', '010', '0110', '0111'])
    },
  },
  {
    name: 'Rice k = 2 equals Golomb m = 4 for 0…10000',
    run() {
      for (let n = 0; n <= 10000; n++) eq(enc('rice', n, 2), enc('golomb', n, 4), `n=${n}`)
    },
  },
  {
    name: 'LEB128: 624485 → E5 8E 26 (the Wikipedia example), 0 → 00, 127 → 7F, 128 → 80 01',
    run() {
      const bytes = (n: number) => {
        const bits = enc('leb128', n)
        const out: string[] = []
        for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2).toString(16).toUpperCase().padStart(2, '0'))
        return out.join(' ')
      }
      eq(bytes(624485), 'E5 8E 26')
      eq([0, 127, 128].map(bytes), ['00', '7F', '80 01'])
    },
  },
  {
    name: 'every code round-trips 0…100000 (1… for γ, δ, ω, Fibonacci; unary quotients capped at 2000) as one concatenated stream',
    run() {
      for (const c of CODES) {
        for (const p of paramsOf(c)) {
          // Unary parts grow linearly, so the quotient is capped at 2000 to keep the stream a sane size.
          const hi = c.id === 'unary' ? 2000 : c.id === 'golomb' ? Math.min(100000, 2000 * p) : c.id === 'rice' ? Math.min(100000, 2000 * 2 ** p) : 100000
          let bits = ''
          const parts: string[] = []
          for (let n = c.min; n <= hi; n++) {
            parts.push(encodeBits(c, n, p))
            if (parts.length === 2000) {
              bits += parts.join('')
              parts.length = 0
            }
          }
          bits += parts.join('')
          const src = stringSource(bits)
          for (let n = c.min; n <= hi; n++) {
            const got = c.decode(src, p)
            if (got !== n) throw new Error(`${c.name}(${p}): decoded ${got} for ${n}`)
          }
          eq(src.pos, bits.length, `${c.name} consumed everything`)
        }
      }
    },
  },
  {
    name: 'closed-form code lengths agree with the actual codewords',
    run() {
      for (const c of CODES)
        for (const p of paramsOf(c))
          for (let n = Math.max(c.min, 0); n < 3000; n += 7) eq(codeLength(c, n, p), encodeBits(c, n, p).length, `${c.name}(${p}) n=${n}`)
    },
  },
  {
    name: 'protobuf zigzag: 0, −1, 1, −2, 2 → 0, 1, 2, 3, 4 and back',
    run() {
      eq([0, -1, 1, -2, 2, -64].map(zigzag), [0, 1, 2, 3, 4, 127])
      for (let v = -5000; v <= 5000; v++) eq(unzigzag(zigzag(v)), v)
    },
  },
  {
    name: 'Gallager–van Voorhis m is the brute-force optimal Golomb parameter for geometric sources',
    run() {
      const golomb = codeById('golomb')
      for (const q of [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01]) {
        const d = makeDist('geometric', q)
        let best = 1
        let bestL = Infinity
        for (let m = 1; m <= 300; m++) {
          const L = expectedLength(golomb, d, m)
          if (L < bestL - 1e-9) {
            bestL = L
            best = m
          }
        }
        eq(optimalGolombM(1 - q), best, `q=${q}`)
      }
    },
  },
]
