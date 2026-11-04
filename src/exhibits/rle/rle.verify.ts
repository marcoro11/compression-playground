import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { randomBytes } from '../../lib/samples'
import { MH_BLACK, MH_WHITE, faxRuns, fieldsForRun, packbitsDecode, packbitsEncode } from './rle'

const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/), (h) => parseInt(h, 16))

const TN1023_IN = hex('AA AA AA 80 00 2A AA AA AA AA 80 00 2A 22 AA AA AA AA AA AA AA AA AA AA')
const TN1023_OUT = hex('FE AA 02 80 00 2A FD AA 03 80 00 2A 22 F7 AA')

const row = (s: string) => Array.from(s, (c) => c === '#')

export const checks: Check[] = [
  {
    name: 'PackBits packs the Apple TN1023 example exactly',
    run() {
      bytesEq(packbitsEncode(TN1023_IN), TN1023_OUT)
    },
  },
  {
    name: 'PackBits decodes the TN1023 packed bytes back to the original',
    run() {
      bytesEq(packbitsDecode(TN1023_OUT), TN1023_IN)
    },
  },
  {
    name: 'PackBits worst case: n bytes never grow past n + ⌈n/128⌉',
    run() {
      for (const n of [1, 2, 127, 128, 129, 1000, 5000]) {
        const r = randomBytes(n, n)
        const enc = packbitsEncode(r)
        ok(enc.length <= n + Math.ceil(n / 128), `n=${n}: ${enc.length}`)
      }
      // Alternating bytes — no run at all — hits the bound exactly.
      const alt = Uint8Array.from({ length: 300 }, (_, i) => i & 1)
      eq(packbitsEncode(alt).length, 300 + 3)
    },
  },
  {
    name: 'PackBits treats header 0x80 (−128) as a no-op',
    run() {
      bytesEq(packbitsDecode(hex('80 00 41 80 FF 42')), hex('41 42 42'))
    },
  },
  {
    name: 'fax runs: white first, so a row starting black opens with a 0',
    run() {
      eq(faxRuns(row('....##..')), [4, 2, 2])
      eq(faxRuns(row('##......')), [0, 2, 6])
      eq(faxRuns(row('........')), [8])
      eq(faxRuns(row('#.#.')), [0, 1, 1, 1, 1])
      eq(faxRuns(row('')), [0])
    },
  },
  {
    name: 'fixed-width fields: an over-long run splits as max, 0, max, 0, …, rest',
    run() {
      eq(fieldsForRun(7, 7), 1)
      eq(fieldsForRun(8, 7), 3) // 7, 0, 1
      eq(fieldsForRun(14, 7), 3) // 7, 0, 7
      eq(fieldsForRun(15, 7), 5) // 7, 0, 7, 0, 1
      eq(fieldsForRun(0, 7), 1)
    },
  },
  {
    name: 'T.4 Modified Huffman tables are prefix-free, 64 distinct codes each',
    run() {
      for (const [name, t] of [
        ['white', MH_WHITE],
        ['black', MH_BLACK],
      ] as const) {
        eq(t.length, 64, name)
        eq(new Set(t).size, 64, name)
        for (const a of t) for (const b of t) if (a !== b) ok(!b.startsWith(a), `${name}: ${a} prefixes ${b}`)
        let k = 0
        for (const c of t) k += 2 ** -c.length
        ok(k < 1, `${name}: Kraft ${k} must leave room for make-up codes and EOL`)
      }
      // Spot values as printed in T.4: white 2–7 are the 4-bit codes, black 2 and 3 are 2 bits.
      eq([MH_WHITE[2], MH_WHITE[7], MH_BLACK[2], MH_BLACK[3]], ['0111', '1111', '11', '10'])
    },
  },
]
