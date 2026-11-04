import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus, randomBytes } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { decodeTrace, parse, type Params, type Token } from './lz77'
import { LZSS_MAX, LZSS_MIN, LZSS_WINDOW, lzssEncode, lzssTokens } from './codec'

const LZSS: Params = { window: 4096, maxMatch: 18, minMatch: 3, format: 'lzss' }
const TRIPLE: Params = { window: 4096, maxMatch: 255, minMatch: 1, format: 'triple' }

/** Short human-readable form of a token list. */
const show = (ts: Token[]) =>
  ts.map((t) => (t.kind === 'lit' ? String.fromCharCode(t.byte) : t.kind === 'match' ? `(${t.offset},${t.length})` : `<${t.offset},${t.length},${String.fromCharCode(t.next)}>`)).join(' ')

/**
 * A decoder written from the format description alone: it reads the stream as a
 * string of '0'/'1' characters and shares no code with codec.ts or lib/bits.ts.
 */
function naiveLzssDecode(file: Uint8Array): number[] {
  const n = file[0] + file[1] * 256 + file[2] * 65536 + file[3] * 16777216
  let bits = ''
  for (let i = 4; i < file.length; i++) bits += file[i].toString(2).padStart(8, '0')
  let p = 0
  const take = (k: number) => {
    const v = parseInt(bits.slice(p, p + k), 2)
    p += k
    return v
  }
  const out: number[] = []
  while (out.length < n) {
    if (take(1) === 0) out.push(take(8))
    else {
      const off = take(12) + 1
      const len = take(4) + 3
      for (let k = 0; k < len; k++) out.push(out[out.length - off])
    }
  }
  return out.slice(0, n)
}

export const checks: Check[] = [
  {
    name: 'LZSS greedy parse of hand-worked strings',
    run() {
      eq(show(parse(utf8('abracadabra'), LZSS).map((s) => s.token)), 'a b r a c a d (7,4)', 'abracadabra')
      eq(show(parse(utf8('aaaaaaaa'), LZSS).map((s) => s.token)), 'a (1,7)', 'aaaaaaaa: a run is one literal and an overlapping copy')
      eq(show(parse(utf8('abcabcabcabc'), LZSS).map((s) => s.token)), 'a b c (3,9)', 'abcabcabcabc')
      // With maxMatch 18 a 40-byte run needs three copies.
      eq(show(parse(utf8('x'.repeat(40)), LZSS).map((s) => s.token)), 'x (1,18) (1,18) (1,3)', '40 x')
    },
  },
  {
    name: 'LZ77 triples of hand-worked strings (the next byte is always sent)',
    run() {
      eq(show(parse(utf8('abracadabra'), TRIPLE).map((s) => s.token)), '<0,0,a> <0,0,b> <0,0,r> <3,1,c> <2,1,d> <7,3,a>', 'abracadabra')
      eq(show(parse(utf8('aaaaaaaa'), TRIPLE).map((s) => s.token)), '<0,0,a> <1,6,a>', 'aaaaaaaa')
      eq(show(parse(utf8('abcabcabcabc'), TRIPLE).map((s) => s.token)), '<0,0,a> <0,0,b> <0,0,c> <3,8,c>', 'abcabcabcabc')
    },
  },
  {
    name: 'the step-through decoder inverts both parses on the corpus samples',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length > 6000) continue
        for (const p of [LZSS, TRIPLE, { ...LZSS, window: 16, maxMatch: 5 }, { ...TRIPLE, window: 8, maxMatch: 4 }]) {
          const { out } = decodeTrace(parse(data, p).map((s) => s.token))
          bytesEq(Uint8Array.from(out), data, `${id} ${p.format} W=${p.window}`)
        }
      }
    },
  },
  {
    name: 'hash-chain parse equals the exhaustive parse when the chain cap does not bind',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length > 3000) continue
        const fast = lzssTokens(data, LZSS_WINDOW, LZSS_MIN, LZSS_MAX, 1 << 30)
        const slow = parse(data, LZSS).map((s) => s.token)
        eq(show(fast), show(slow), id)
      }
    },
  },
  {
    name: 'an independent bit-string decoder reads the codec’s files',
    run() {
      for (const { id, data } of corpus()) {
        const dec = naiveLzssDecode(lzssEncode(data))
        bytesEq(Uint8Array.from(dec), data, id)
      }
    },
  },
  {
    name: 'LZSS shrinks repetitive text and costs at most 1/8 extra on random bytes',
    run() {
      const prose = corpus().find((c) => c.id === 'prose-x40')!.data
      // Ceiling: an 18-byte match costs 17 bits, so no input beats 144/17 ≈ 8.5×.
      const r = prose.length / lzssEncode(prose).length
      ok(r > 7 && r < 144 / 17, `prose ×40 ratio ${r.toFixed(2)}`)
      const rnd = randomBytes(4000, 21)
      const enc = lzssEncode(rnd).length
      ok(enc <= 4 + Math.ceil((rnd.length * 9) / 8), `random grew to ${enc}`)
    },
  },
]
