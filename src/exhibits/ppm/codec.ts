/**
 * PPM for the bench: order 5, escape method D, exclusion and update exclusion,
 * driven through the same 32-bit Witten–Neal–Cleary arithmetic coder the
 * arithmetic-coding exhibit uses.
 *
 *   varint   original length n (LEB128: 7 bits per byte, high bit = more)
 *   …        arithmetic code, MSB-first
 *
 * One byte can take several coding events — each escape is one. The decoder
 * keeps pulling events until the model has produced n bytes. No tables are
 * sent: the decoder rebuilds every context's counts from what it has decoded.
 *
 * Why order 5 and method D rather than the textbook PPMC order 3 the page
 * defaults to: on the sample corpus it is the setting that beats DEFLATE on
 * every text input (see the notes on the page). The page lets you try both.
 *
 * The coder only knows "a distribution, a symbol index": the adapter below
 * presents whichever context level the model is currently asking.
 */

import type { Codec } from '../../lib/codec'
import { decode, encode, type Model } from '../arithmetic/coder'
import { PpmModel, type PpmOptions } from './ppm'

class CoderAdapter implements Model {
  constructor(
    readonly ppm: PpmModel,
    /** Decoding only: stop once the model holds this many bytes. */
    private readonly stopAt = Infinity,
  ) {}
  get size() {
    return 257
  }
  total() {
    if (this.ppm.hist.length >= this.stopAt) throw new Done()
    return this.ppm.current().total
  }
  range(i: number): [number, number] {
    const d = this.ppm.current()
    let lo = 0
    for (let j = 0; j < i; j++) lo += d.w[j]
    return [lo, lo + (i < d.w.length ? d.w[i] : d.esc)]
  }
  find(target: number): number {
    const d = this.ppm.current()
    let acc = 0
    for (let j = 0; j < d.w.length; j++) {
      acc += d.w[j]
      if (target < acc) return j
    }
    return d.w.length
  }
  update(i: number) {
    this.ppm.advance(i)
  }
  counts() {
    const d = this.ppm.current()
    return d.w.concat(d.esc)
  }
}

function writeVarint(n: number): number[] {
  const out: number[] = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}

function readVarint(d: Uint8Array): { n: number; at: number } {
  let n = 0
  let mul = 1
  for (let i = 0; i < 6; i++) {
    if (i >= d.length) break
    const b = d[i]
    n += (b & 0x7f) * mul
    mul *= 128
    if (!(b & 0x80)) return { n, at: i + 1 }
  }
  throw new Error('ppm: bad length header')
}

/** Thrown by the adapter when the model has produced every byte, to stop the coder's loop. */
class Done extends Error {}

export function ppmEncode(data: Uint8Array, opts: PpmOptions): Uint8Array {
  const sim = new PpmModel(opts)
  const events: number[] = []
  for (let i = 0; i < data.length; i++) for (const e of sim.eventsFor(data[i])) events.push(e)
  const body = encode(events, new CoderAdapter(new PpmModel(opts)), 32).bytes
  const head = writeVarint(data.length)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

export function ppmDecode(input: Uint8Array, opts: PpmOptions): Uint8Array {
  const { n, at } = readVarint(input)
  const ppm = new PpmModel(opts)
  if (n > 0) {
    const adapter = new CoderAdapter(ppm, n)
    try {
      // The event count is not stored; the adapter stops the loop once n bytes exist.
      decode(input.subarray(at), Number.MAX_SAFE_INTEGER, adapter, 32)
    } catch (e) {
      if (!(e instanceof Done)) throw e
    }
  }
  if (ppm.hist.length !== n) throw new Error(`ppm: decoded ${ppm.hist.length} bytes, header says ${n}`)
  return Uint8Array.from(ppm.hist)
}

export const BENCH_OPTS: PpmOptions = { order: 5, escape: 'D', exclusion: true, updateExclusion: true }

export const ppmCodec: Codec = {
  id: 'ppm',
  name: 'PPM',
  family: 'order-5 PPM, escape method D, exclusion + update exclusion, arithmetic-coded',
  encode: (d) => ppmEncode(d, BENCH_OPTS),
  decode: (d) => ppmDecode(d, BENCH_OPTS),
}

/** Every `codec.ts` exports `codecs`; verify and the bench pick them up from here. */
export const codecs: Codec[] = [ppmCodec]
