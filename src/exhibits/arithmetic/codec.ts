/**
 * Two real arithmetic-coded formats for the bench:
 *
 *   u32 LE   original length n
 *   …        32-bit Witten–Neal–Cleary arithmetic code, MSB-first
 *
 * Order-0: one adaptive table of 256 counts, all starting at 1, +32 per symbol,
 * halved when the total passes 2^16. No table is transmitted — the decoder
 * learns the same statistics from what it has decoded so far.
 *
 * Order-1: the same, but a separate table for every previous byte. On English
 * it learns that 'q' is followed by 'u' and 'h' tends to follow 't'.
 */

import { readLength, withLength, type Codec } from '../../lib/codec'
import { FreqModel, Order1Model, decode, encode, type Model } from './coder'

const order0 = (): Model => new FreqModel(new Array(256).fill(1), 32, 1 << 16)
const order1 = (): Model => new Order1Model(24, 1 << 16)

function make(id: string, name: string, family: string, model: () => Model): Codec {
  return {
    id,
    name,
    family,
    encode(data) {
      return withLength(data.length, encode(data, model(), 32).bytes)
    },
    decode(input) {
      const { n, body } = readLength(input)
      return Uint8Array.from(decode(body, n, model(), 32))
    },
  }
}

export const arithOrder0 = make('arith-o0', 'Arithmetic (order-0)', 'adaptive order-0 arithmetic coder, 32-bit registers', order0)
export const arithOrder1 = make('arith-o1', 'Arithmetic (order-1)', 'adaptive order-1 arithmetic coder: one table per previous byte', order1)

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [arithOrder0, arithOrder1]
