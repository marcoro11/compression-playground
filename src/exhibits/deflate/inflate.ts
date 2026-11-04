/**
 * A from-scratch RFC 1951 decoder, in the style of Mark Adler's `puff.c`:
 * small, bit-at-a-time, and strict about malformed input.
 *
 * Huffman decoding uses the canonical-code trick: with the count of codes of
 * each length and the symbols listed in canonical order, a code of length L is
 * valid iff it falls in [first(L), first(L) + count(L)), and its symbol is a
 * direct index. No tree is ever built.
 *
 * With `trace` on it records every field it reads — the same spans the
 * encoder labelled, but discovered independently from the bits — along with
 * how many output bytes exist after that field.
 */

import { BitReader } from '../../lib/bits'
import { glyph } from '../../lib/text'
import { CL_ORDER, DIST_BASE, DIST_EXTRA, FIXED_DIST_LENGTHS, FIXED_LIT_LENGTHS, LEN_BASE, LEN_EXTRA } from './tables'

export interface TraceField {
  start: number
  length: number
  label: string
  kind: string
  /** Output length once this field has been acted on. */
  out: number
  /** Index of the block this field belongs to. */
  block: number
}

export interface InflateResult {
  out: Uint8Array
  /** Bytes of input consumed, through the end of the final block's last byte. */
  consumed: number
  blocks: { type: 'stored' | 'fixed' | 'dynamic'; bitStart: number; bitEnd: number; outStart: number; outEnd: number }[]
  trace: TraceField[]
}

class Huff {
  count: number[]
  symbol: number[]
  constructor(lengths: number[], what: string, allowIncomplete: boolean) {
    this.count = new Array(16).fill(0)
    for (const l of lengths) this.count[l]++
    if (this.count[0] === lengths.length) {
      // No codes at all: legal for distances in a block with only literals.
      this.symbol = []
      return
    }
    let left = 1
    for (let len = 1; len <= 15; len++) {
      left <<= 1
      left -= this.count[len]
      if (left < 0) throw new Error(`inflate: over-subscribed ${what} code`)
    }
    // Incomplete codes are only OK in the one-code-of-length-1 case (as zlib).
    let used = 0
    for (let len = 1; len <= 15; len++) used += this.count[len]
    if (left > 0 && !(allowIncomplete && used === 1 && this.count[1] === 1)) throw new Error(`inflate: incomplete ${what} code`)
    const offs = new Array(16).fill(0)
    for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + this.count[len]
    this.symbol = new Array(lengths.length)
    for (let s = 0; s < lengths.length; s++) if (lengths[s]) this.symbol[offs[lengths[s]]++] = s
  }
}

class Out {
  buf = new Uint8Array(1024)
  n = 0
  push(b: number) {
    if (this.n === this.buf.length) this.grow(1)
    this.buf[this.n++] = b
  }
  grow(k: number) {
    let size = this.buf.length
    while (size < this.n + k) size *= 2
    const nb = new Uint8Array(size)
    nb.set(this.buf.subarray(0, this.n))
    this.buf = nb
  }
  copy(dist: number, len: number) {
    if (dist > this.n) throw new Error(`inflate: distance ${dist} reaches before the start of the output`)
    if (this.n + len > this.buf.length) this.grow(len)
    // Byte by byte on purpose: a copy may overlap its own output (dist < len).
    for (let i = 0; i < len; i++) this.buf[this.n + i] = this.buf[this.n - dist + i]
    this.n += len
  }
}

export function inflate(data: Uint8Array, opts: { trace?: boolean } = {}): InflateResult {
  const r = new BitReader(data, 'lsb')
  const out = new Out()
  const trace: TraceField[] = []
  const blocks: InflateResult['blocks'] = []
  const T = opts.trace ?? false
  let blockIndex = 0

  const field = (start: number, label: string | (() => string), kind: string) => {
    if (T) trace.push({ start, length: r.bitPosition - start, label: typeof label === 'string' ? label : label(), kind, out: out.n, block: blockIndex })
  }
  const bits = (n: number, label: (v: number) => string, kind: string) => {
    const s = r.bitPosition
    const v = r.readBits(n)
    if (T) field(s, label(v), kind)
    return v
  }
  const decode = (h: Huff): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= r.readBit()
      const count = h.count[len]
      if (code - count < first) return h.symbol[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('inflate: invalid Huffman code')
  }

  const codes = (lit: Huff, dist: Huff) => {
    for (;;) {
      let s = r.bitPosition
      const sym = decode(lit)
      if (sym < 256) {
        out.push(sym)
        if (T) field(s, `literal ‘${glyph(sym)}’ (byte ${sym})`, 'literal')
      } else if (sym === 256) {
        if (T) field(s, 'end of block (symbol 256)', 'eob')
        return
      } else {
        const li = sym - 257
        if (li >= 29) throw new Error(`inflate: invalid length symbol ${sym}`)
        if (T) field(s, `length code ${sym} (covers ${LEN_BASE[li]}${LEN_EXTRA[li] ? '–' + (LEN_BASE[li] + (1 << LEN_EXTRA[li]) - 1) : ''})`, 'length')
        let len = LEN_BASE[li]
        if (LEN_EXTRA[li]) len += bits(LEN_EXTRA[li], (v) => `${LEN_EXTRA[li]} extra bit${LEN_EXTRA[li] > 1 ? 's' : ''} = ${v}: length ${LEN_BASE[li]} + ${v} = ${LEN_BASE[li] + v}`, 'lenextra')
        s = r.bitPosition
        const ds = decode(dist)
        if (ds >= 30) throw new Error(`inflate: invalid distance symbol ${ds}`)
        let d = DIST_BASE[ds]
        if (DIST_EXTRA[ds]) {
          if (T) field(s, `distance code ${ds} (covers ${DIST_BASE[ds]}–${DIST_BASE[ds] + (1 << DIST_EXTRA[ds]) - 1})`, 'dist')
          d += bits(DIST_EXTRA[ds], (v) => `${DIST_EXTRA[ds]} extra bit${DIST_EXTRA[ds] > 1 ? 's' : ''} = ${v}: distance ${DIST_BASE[ds]} + ${v} = ${DIST_BASE[ds] + v}`, 'distextra')
          out.copy(d, len)
          if (T) trace[trace.length - 1].out = out.n
        } else {
          out.copy(d, len)
          if (T) field(s, `distance code ${ds} = ${d}`, 'dist')
        }
      }
    }
  }

  let final = 0
  do {
    const bitStart = r.bitPosition
    const outStart = out.n
    final = bits(1, (v) => `BFINAL = ${v}${v ? ' — this is the last block' : ' — more blocks follow'}`, 'header')
    const type = bits(2, (v) => `BTYPE = ${v.toString(2).padStart(2, '0')} — ${['stored', 'fixed Huffman', 'dynamic Huffman', 'reserved (error)'][v]}`, 'header')
    if (type === 0) {
      const s = r.bitPosition
      r.align()
      if (T && r.bitPosition > s) field(s, 'padding to a byte boundary', 'pad')
      const len = bits(16, (v) => `LEN = ${v} bytes follow`, 'stored')
      const nlen = bits(16, (v) => `NLEN = ${v} (one’s complement of LEN)`, 'stored')
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block LEN/NLEN mismatch')
      for (let i = 0; i < len; i++) {
        const st = r.bitPosition
        const b = r.readByte()
        out.push(b)
        if (T) field(st, `raw byte ‘${glyph(b)}’ (${b})`, 'raw')
      }
      blocks.push({ type: 'stored', bitStart, bitEnd: r.bitPosition, outStart, outEnd: out.n })
    } else if (type === 1) {
      codes(new Huff(FIXED_LIT_LENGTHS, 'fixed literal/length', false), new Huff(FIXED_DIST_LENGTHS.concat([5, 5]), 'fixed distance', false))
      blocks.push({ type: 'fixed', bitStart, bitEnd: r.bitPosition, outStart, outEnd: out.n })
    } else if (type === 2) {
      const nlen = bits(5, (v) => `HLIT = ${v} → ${v + 257} literal/length code lengths follow`, 'hlit') + 257
      const ndist = bits(5, (v) => `HDIST = ${v} → ${v + 1} distance code lengths follow`, 'hdist') + 1
      const ncode = bits(4, (v) => `HCLEN = ${v} → ${v + 4} code-length-code lengths follow`, 'hclen') + 4
      if (nlen > 286 || ndist > 30) throw new Error('inflate: bad counts')
      const clLens = new Array(19).fill(0)
      for (let i = 0; i < ncode; i++) {
        const sym = CL_ORDER[i]
        clLens[sym] = bits(3, (v) => `code-length code: symbol ${sym} gets a ${v}-bit code${v ? '' : ' (unused)'}`, 'cllen')
      }
      const clHuff = new Huff(clLens, 'code-length', false)
      const lengths: number[] = []
      const where = (i: number) => (i < nlen ? (i < 256 ? `‘${glyph(i)}’` : i === 256 ? 'EOB' : `length code ${i}`) : `distance code ${i - nlen}`)
      while (lengths.length < nlen + ndist) {
        const s = r.bitPosition
        const sym = decode(clHuff)
        if (sym < 16) {
          if (T) field(s, `length ${sym} for ${where(lengths.length)}`, 'clcode')
          lengths.push(sym)
          continue
        }
        let rep = 0
        let val = 0
        if (sym === 16) {
          if (lengths.length === 0) throw new Error('inflate: repeat with no previous length')
          val = lengths[lengths.length - 1]
          if (T) field(s, `16: repeat the previous length (${val})`, 'clcode')
          rep = 3 + bits(2, (v) => `2 extra bits = ${v} → ×${v + 3}`, 'clextra')
        } else if (sym === 17) {
          if (T) field(s, '17: a short run of zeros', 'clcode')
          rep = 3 + bits(3, (v) => `3 extra bits = ${v} → ${v + 3} zeros`, 'clextra')
        } else {
          if (T) field(s, '18: a long run of zeros', 'clcode')
          rep = 11 + bits(7, (v) => `7 extra bits = ${v} → ${v + 11} zeros`, 'clextra')
        }
        if (lengths.length + rep > nlen + ndist) throw new Error('inflate: too many lengths')
        for (let k = 0; k < rep; k++) lengths.push(val)
      }
      const litLens = lengths.slice(0, nlen)
      if (!litLens[256]) throw new Error('inflate: no end-of-block code')
      codes(new Huff(litLens, 'literal/length', true), new Huff(lengths.slice(nlen), 'distance', true))
      blocks.push({ type: 'dynamic', bitStart, bitEnd: r.bitPosition, outStart, outEnd: out.n })
    } else {
      throw new Error('inflate: reserved block type 11')
    }
    blockIndex++
  } while (!final)

  return { out: out.buf.slice(0, out.n), consumed: (r.bitPosition + 7) >>> 3, blocks, trace }
}
