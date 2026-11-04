import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { CLEAR, decodeTrace, encodeTrace, type LzwParams } from './lzw'
import { lzwCodes, lzwDecode, lzwEncode } from './codec'

/**
 * The textbook encoder with string keys — no integer packing, no shared code —
 * as the independent reference for the code sequence.
 */
function naiveCodes(s: string): number[] {
  const dict = new Map<string, number>()
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
  let next = 256
  let w = ''
  const out: number[] = []
  for (const c of s) {
    if (dict.has(w + c)) w += c
    else {
      out.push(dict.get(w)!)
      dict.set(w + c, next++)
      w = c
    }
  }
  if (w) out.push(dict.get(w)!)
  return out
}

const FREEZE16: LzwParams = { maxWidth: 16, policy: 'freeze' }

export const checks: Check[] = [
  {
    name: 'TOBEORNOTTOBEORTOBEORNOT → 84 79 66 69 79 82 78 79 84 256 258 260 265 259 261 263',
    run() {
      const expected = [84, 79, 66, 69, 79, 82, 78, 79, 84, 256, 258, 260, 265, 259, 261, 263]
      const s = 'TOBEORNOTTOBEORTOBEORNOT'
      eq(naiveCodes(s), expected, 'naive reference')
      eq(encodeTrace(utf8(s), FREEZE16).codes.map((c) => c.code), expected, 'traced encoder')
      eq(lzwCodes(utf8(s), FREEZE16).map((c) => c.code), expected, 'fast encoder')
    },
  },
  {
    name: 'traced and fast encoders agree with the naive one on every short corpus input',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length > 6000) continue
        const ref = naiveCodes(String.fromCharCode(...data))
        eq(encodeTrace(data, FREEZE16).codes.map((c) => c.code), ref, id)
        eq(lzwCodes(data, FREEZE16).map((c) => c.code), ref, id + ' fast')
      }
    },
  },
  {
    name: 'KwKwK inputs hit the not-yet-defined code and still decode',
    run() {
      for (const s of ['abababababab', 'aaaaaaaaaaaaaaa', 'TOBEORNOTTOBEORTOBEORNOT']) {
        const enc = encodeTrace(utf8(s), FREEZE16)
        const dec = decodeTrace(enc.codes, FREEZE16)
        bytesEq(Uint8Array.from(dec.out), utf8(s), s)
        bytesEq(lzwDecode(lzwEncode(utf8(s))), utf8(s), s + ' codec')
      }
      const kinds = decodeTrace(encodeTrace(utf8('aaaaaaa'), FREEZE16).codes, FREEZE16).steps.map((x) => x.kind)
      eq(kinds, ['first', 'kwkwk', 'kwkwk', 'known'], 'aaaaaaa: 97, 256, 257, 97')
    },
  },
  {
    name: 'every width/policy combination round-trips, and the decoder recomputes the encoder’s widths',
    run() {
      for (const { id, data } of corpus()) {
        if (data.length > 45000) continue
        for (const maxWidth of [9, 10, 12, 16]) {
          for (const policy of ['freeze', 'reset'] as const) {
            const p = { maxWidth, policy }
            const enc = encodeTrace(data, p)
            // decodeTrace throws if a width differs from what the encoder used.
            const dec = decodeTrace(enc.codes, p)
            bytesEq(Uint8Array.from(dec.out), data, `${id} ${maxWidth} ${policy}`)
            eq(lzwCodes(data, p), enc.codes.map((c) => ({ code: c.code, width: c.width })), `${id} fast=trace`)
          }
        }
      }
    },
  },
  {
    name: 'the 12-bit codec actually clears its table on large inputs, and widths stay within 9…12',
    run() {
      for (const id of ['random-5k', 'mixed-40k']) {
        const data = corpus().find((c) => c.id === id)!.data
        const codes = lzwCodes(data)
        const clears = codes.filter((c) => c.code === CLEAR).length
        ok(clears > 0, `${id}: expected at least one CLEAR`)
        ok(codes.every((c) => c.width >= 9 && c.width <= 12), `${id}: width out of range`)
        bytesEq(lzwDecode(lzwEncode(data)), data, id)
      }
    },
  },
]
