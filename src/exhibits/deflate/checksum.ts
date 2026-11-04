/**
 * The two checksums wrapped around DEFLATE.
 *
 * gzip (RFC 1952) uses CRC-32 — the reflected polynomial 0xEDB88320, the same
 * one as Ethernet, ZIP and PNG. zlib (RFC 1950) uses Adler-32, which Mark Adler
 * designed to be much cheaper to compute: two running sums mod 65521.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

export function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  // 5552 is the largest n for which the sums cannot overflow 2^32 before the mod.
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552)
    for (; i < end; i++) {
      a += data[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}
