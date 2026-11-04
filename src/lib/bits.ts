/**
 * Bit-level I/O.
 *
 * Every compressor on this site eventually has to write fewer than eight bits
 * at a time, and the formats disagree about which end of a byte comes first:
 *
 *  - `msb` packs from the top bit down. That is how you would write bits by
 *    hand, and what Huffman tables, LZW and the arithmetic coder use here.
 *  - `lsb` packs from the bottom bit up. That is DEFLATE (RFC 1951 §3.1.1):
 *    plain numbers go in least-significant-bit first, and Huffman codes go in
 *    *most*-significant-bit first, so the writer has a separate call for them.
 *
 * The writer can also keep a log of labelled spans — "this run of 7 bits was the
 * length code for 18" — which is what lets an exhibit lay the finished stream
 * out and colour it by meaning instead of showing an opaque hex dump.
 */

export type BitOrder = 'msb' | 'lsb'

export interface BitSpan {
  /** First bit of the span, counted from the start of the stream. */
  start: number
  /** Number of bits. */
  length: number
  /** The bits in the order they were *meant* (MSB-first reading of the value). */
  bits: string
  label: string
  /** Free-form category an exhibit can colour by: 'literal', 'length', 'header'… */
  kind: string
}

export class BitWriter {
  private bytes: number[] = []
  private acc = 0
  private n = 0
  readonly spans: BitSpan[] = []

  constructor(
    readonly order: BitOrder = 'msb',
    private readonly record = false,
  ) {}

  /** Bits written so far. */
  get bitLength(): number {
    return this.bytes.length * 8 + this.n
  }

  private pushBit(b: number) {
    if (this.order === 'msb') this.acc |= (b & 1) << (7 - this.n)
    else this.acc |= (b & 1) << this.n
    this.n++
    if (this.n === 8) {
      this.bytes.push(this.acc)
      this.acc = 0
      this.n = 0
    }
  }

  /**
   * Write the low `count` bits of `value` as a number.
   * In `msb` order the top bit goes first; in `lsb` order the bottom bit does.
   */
  writeBits(value: number, count: number, label = '', kind = ''): void {
    const start = this.bitLength
    if (this.order === 'msb') for (let i = count - 1; i >= 0; i--) this.pushBit((value >>> i) & 1)
    else for (let i = 0; i < count; i++) this.pushBit((value >>> i) & 1)
    if (this.record && count > 0) this.spans.push({ start, length: count, bits: toBin(value, count), label, kind })
  }

  /**
   * Write a prefix code. Codes are always read one bit at a time from the root
   * of the tree, so the first bit on the wire is the code's top bit — in either
   * byte order. (This is the line in RFC 1951 everyone reads twice.)
   */
  writeCode(code: number, length: number, label = '', kind = ''): void {
    const start = this.bitLength
    for (let i = length - 1; i >= 0; i--) this.pushBit((code >>> i) & 1)
    if (this.record && length > 0) this.spans.push({ start, length, bits: toBin(code, length), label, kind })
  }

  /** Pad with zeros to the next byte boundary. */
  align(label = 'pad', kind = 'pad'): void {
    if (this.n === 0) return
    const pad = 8 - this.n
    this.writeBits(0, pad, label, kind)
  }

  finish(): Uint8Array {
    const out = this.bytes.slice()
    if (this.n > 0) out.push(this.acc)
    return Uint8Array.from(out)
  }
}

export class BitReader {
  private pos = 0

  constructor(
    private readonly data: Uint8Array,
    readonly order: BitOrder = 'msb',
  ) {}

  get bitPosition(): number {
    return this.pos
  }

  get bitsLeft(): number {
    return this.data.length * 8 - this.pos
  }

  readBit(): number {
    const byte = this.pos >>> 3
    if (byte >= this.data.length) throw new Error('BitReader: read past end of stream')
    const k = this.pos & 7
    this.pos++
    return this.order === 'msb' ? (this.data[byte] >>> (7 - k)) & 1 : (this.data[byte] >>> k) & 1
  }

  /** Inverse of `BitWriter.writeBits`. */
  readBits(count: number): number {
    let v = 0
    if (this.order === 'msb') for (let i = 0; i < count; i++) v = (v << 1) | this.readBit()
    else for (let i = 0; i < count; i++) v |= this.readBit() << i
    return v >>> 0
  }

  /** Skip to the next byte boundary. */
  align(): void {
    this.pos = (this.pos + 7) & ~7
  }

  /** Read a whole byte from a byte-aligned position. */
  readByte(): number {
    if (this.pos & 7) throw new Error('BitReader: readByte on unaligned position')
    const b = this.data[this.pos >>> 3]
    if (b === undefined) throw new Error('BitReader: read past end of stream')
    this.pos += 8
    return b
  }
}

/** `value` as a zero-padded binary string of exactly `width` digits. */
export function toBin(value: number, width: number): string {
  if (width <= 0) return ''
  let s = ''
  for (let i = width - 1; i >= 0; i--) s += (value >>> i) & 1
  return s
}

/** Bytes as a string of 0/1, eight per byte, top bit first. */
export function bytesToBin(bytes: Uint8Array, sep = ''): string {
  return Array.from(bytes, (b) => toBin(b, 8)).join(sep)
}

/** Reverse the low `width` bits of `v`. */
export function reverseBits(v: number, width: number): number {
  let r = 0
  for (let i = 0; i < width; i++) {
    r = (r << 1) | (v & 1)
    v >>>= 1
  }
  return r
}
