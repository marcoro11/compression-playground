/**
 * The contract every lossless exhibit exports so the bench can line them up.
 *
 * `encode` produces the real bitstream the exhibit describes — not an estimate —
 * and `decode` must invert it exactly. `npm run verify` round-trips every
 * registered codec over the sample corpus and fails the build on any mismatch.
 */
export interface Codec {
  id: string
  name: string
  /** One line on what the format is and where it ships. */
  family: string
  encode(data: Uint8Array): Uint8Array
  decode(data: Uint8Array): Uint8Array
}

/** Little-endian u32 length prefix: many toy formats here need to know when to stop. */
export function withLength(n: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length)
  out[0] = n & 0xff
  out[1] = (n >>> 8) & 0xff
  out[2] = (n >>> 16) & 0xff
  out[3] = (n >>> 24) & 0xff
  out.set(body, 4)
  return out
}

export function readLength(data: Uint8Array): { n: number; body: Uint8Array } {
  if (data.length < 4) throw new Error('truncated length prefix')
  const n = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0
  return { n, body: data.subarray(4) }
}
