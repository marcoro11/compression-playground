/**
 * LZ4, from the two specification documents in the lz4 repository:
 * lz4_Block_format.md and lz4_Frame_format.md. DOM-free.
 *
 * A block is a run of *sequences*. Each one is
 *
 *   token            1 byte: high nibble = literal length, low nibble = match length − 4
 *   [lit-len ext]    only if the high nibble is 15: bytes added on, 255 means "keep going"
 *   literals         that many raw bytes
 *   offset           2 bytes, little-endian, 1 … 65535 back into the output
 *   [match-len ext]  only if the low nibble is 15: same 255-run scheme
 *
 * and the last sequence stops after its literals. Every field is a whole number
 * of bytes, which is the entire point: a decoder never shifts a bit.
 *
 * The encoder rules that make the decoder's fast path safe (block format,
 * "End of block conditions"):
 *   - the last 5 bytes are always literals (LASTLITERALS)
 *   - the last match starts at least 12 bytes before the end (MFLIMIT)
 * so a decoder copying 8 or 16 bytes at a time ("wild copy") can run past the
 * end of a match without ever running past the end of the buffer.
 */

export const MINMATCH = 4
export const LASTLITERALS = 5
export const MFLIMIT = 12
export const MAX_OFFSET = 65535
const HASH_LOG = 12 // LZ4_MEMORY_USAGE 14 → 2^14 bytes of u32 slots = 4096 entries
const SKIP_TRIGGER = 6

export type Mode = 'fast' | 'hc'

export interface EncodeOptions {
  mode?: Mode
  /** LZ4's "acceleration": how fast the search step grows after misses. 1 = default. */
  acceleration?: number
  /** HC only: how many earlier positions with the same hash to compare. */
  depth?: number
}

/** One sequence as the encoder chose it. `matchLen` is 0 on the final, literals-only sequence. */
export interface Sequence {
  litStart: number
  litLen: number
  /** Distance back from the match start; 0 on the last sequence. */
  offset: number
  matchLen: number
  /** Positions the search looked at (fast mode: hash probes) before this match was found. */
  probes: number
  /** How far the match was extended backwards over bytes first queued as literals. */
  backtrack: number
}

/** Where each field of a sequence sits in the block, as [start, end) byte ranges. */
export interface SeqLayout {
  token: number
  litExt: [number, number]
  lits: [number, number]
  /** −1 on the last sequence. */
  off: number
  mlExt: [number, number]
  end: number
}

export interface BlockResult {
  bytes: Uint8Array
  seqs: Sequence[]
  layout: SeqLayout[]
}

const read32 = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0
const hash4 = (d: Uint8Array, i: number) => Math.imul(read32(d, i), 2654435761) >>> (32 - HASH_LOG)

/** How many bytes match from a and b onwards, stopping before `limit` on b's side. */
function extend(d: Uint8Array, a: number, b: number, limit: number): number {
  let k = 0
  while (b + k < limit && d[a + k] === d[b + k]) k++
  return k
}

/**
 * The fast parser: one hash slot per 4-byte value, no chains. A probe either
 * finds something that really matches or it does not, and after every miss the
 * step forward grows (search nb >> 6), so incompressible data is skipped
 * quickly. This is the shape of LZ4_compress_generic.
 */
function parseFast(d: Uint8Array, acceleration: number): Sequence[] {
  const n = d.length
  const seqs: Sequence[] = []
  if (n < MFLIMIT + 1) {
    seqs.push({ litStart: 0, litLen: n, offset: 0, matchLen: 0, probes: 0, backtrack: 0 })
    return seqs
  }
  const table = new Int32Array(1 << HASH_LOG).fill(-1)
  const mflimit = n - MFLIMIT // a match may start at ip ≤ mflimit
  const matchLimit = n - LASTLITERALS // and must end by here
  let anchor = 0
  let ip = 0
  table[hash4(d, 0)] = 0
  ip = 1

  outer: while (true) {
    let step = 1
    let searchNb = Math.max(1, acceleration) << SKIP_TRIGGER
    let forward = ip
    let match = -1
    let probes = 0
    do {
      ip = forward
      forward += step
      step = searchNb++ >> SKIP_TRIGGER
      if (ip > mflimit) break outer
      const h = hash4(d, ip)
      match = table[h]
      table[h] = ip
      probes++
    } while (match < 0 || ip - match > MAX_OFFSET || read32(d, match) !== read32(d, ip))

    // Catch up: the bytes just before may match too.
    let back = 0
    while (ip > anchor && match > 0 && d[ip - 1] === d[match - 1]) {
      ip--
      match--
      back++
    }
    const len = MINMATCH + extend(d, match + MINMATCH, ip + MINMATCH, matchLimit)
    seqs.push({ litStart: anchor, litLen: ip - anchor, offset: ip - match, matchLen: len, probes, backtrack: back })
    ip += len
    anchor = ip
    if (ip > mflimit) break
    // Fill the table at ip − 2 so matches right after this one are findable.
    table[hash4(d, ip - 2)] = ip - 2
  }
  seqs.push({ litStart: anchor, litLen: n - anchor, offset: 0, matchLen: 0, probes: 0, backtrack: 0 })
  return seqs
}

/**
 * The HC parser: hash chains (every position linked to the previous one with
 * the same hash), the longest match among `depth` candidates, greedily. Slower
 * to compress, identical to decode — the format does not change.
 */
function parseHC(d: Uint8Array, depth: number): Sequence[] {
  const n = d.length
  const seqs: Sequence[] = []
  if (n < MFLIMIT + 1) {
    seqs.push({ litStart: 0, litLen: n, offset: 0, matchLen: 0, probes: 0, backtrack: 0 })
    return seqs
  }
  const HL = 15
  const hash = (i: number) => Math.imul(read32(d, i), 2654435761) >>> (32 - HL)
  const head = new Int32Array(1 << HL).fill(-1)
  const prev = new Int32Array(n).fill(-1)
  const mflimit = n - MFLIMIT
  const matchLimit = n - LASTLITERALS
  let inserted = 0
  const insertUpTo = (target: number) => {
    while (inserted < target && inserted <= n - 4) {
      const h = hash(inserted)
      prev[inserted] = head[h]
      head[h] = inserted
      inserted++
    }
  }
  let anchor = 0
  let ip = 0
  while (ip <= mflimit) {
    insertUpTo(ip)
    let best = 0
    let bestPos = -1
    let probes = 0
    let j = head[hash(ip)]
    while (j >= 0 && ip - j <= MAX_OFFSET && probes < depth) {
      probes++
      if (d[j + best] === d[ip + best] && read32(d, j) === read32(d, ip)) {
        const len = MINMATCH + extend(d, j + MINMATCH, ip + MINMATCH, matchLimit)
        if (len > best) {
          best = len
          bestPos = j
        }
      }
      j = prev[j]
    }
    if (best >= MINMATCH) {
      seqs.push({ litStart: anchor, litLen: ip - anchor, offset: ip - bestPos, matchLen: best, probes, backtrack: 0 })
      ip += best
      anchor = ip
    } else ip++
  }
  seqs.push({ litStart: anchor, litLen: n - anchor, offset: 0, matchLen: 0, probes: 0, backtrack: 0 })
  return seqs
}

export function parse(d: Uint8Array, opts: EncodeOptions = {}): Sequence[] {
  return opts.mode === 'hc' ? parseHC(d, opts.depth ?? 64) : parseFast(d, opts.acceleration ?? 1)
}

/** Write a 255-run length extension for `v` (the amount above 15). */
function pushExt(out: number[], v: number) {
  while (v >= 255) {
    out.push(255)
    v -= 255
  }
  out.push(v)
}

/** Serialise sequences into block bytes, recording where every field lands. */
export function serialize(d: Uint8Array, seqs: Sequence[]): { bytes: Uint8Array; layout: SeqLayout[] } {
  const out: number[] = []
  const layout: SeqLayout[] = []
  for (const s of seqs) {
    const ml = s.matchLen ? s.matchLen - MINMATCH : 0
    const token = out.length
    out.push((Math.min(s.litLen, 15) << 4) | Math.min(ml, 15))
    const le0 = out.length
    if (s.litLen >= 15) pushExt(out, s.litLen - 15)
    const le1 = out.length
    for (let i = 0; i < s.litLen; i++) out.push(d[s.litStart + i])
    const l1 = out.length
    let off = -1
    let me0 = out.length
    let me1 = out.length
    if (s.matchLen) {
      off = out.length
      out.push(s.offset & 0xff, s.offset >>> 8)
      me0 = out.length
      if (ml >= 15) pushExt(out, ml - 15)
      me1 = out.length
    }
    layout.push({ token, litExt: [le0, le1], lits: [le1, l1], off, mlExt: [me0, me1], end: out.length })
  }
  return { bytes: Uint8Array.from(out), layout }
}

export function compressBlock(d: Uint8Array, opts: EncodeOptions = {}): BlockResult {
  const seqs = parse(d, opts)
  const { bytes, layout } = serialize(d, seqs)
  return { bytes, seqs, layout }
}

/** One thing the decoder did, for the step-through. Ranges are [start, end). */
export interface DecodeOp {
  kind: 'token' | 'litExt' | 'lits' | 'offset' | 'mlExt' | 'copy'
  /** Bytes of the block this op consumed. */
  inp: [number, number]
  /** Bytes of output this op produced (literals, copy). */
  out: [number, number]
  /** Sequence index. */
  seq: number
  litLen?: number
  matchLen?: number
  offset?: number
  token?: number
}

/**
 * Decode one block. `out` may already hold earlier output (linked blocks in a
 * frame, where a match can reach back into the previous block). Throws on any
 * malformed input rather than reading out of bounds.
 */
export function decompressBlock(block: Uint8Array, out: number[] = [], trace?: DecodeOp[]): number[] {
  let p = 0
  let seq = 0
  const need = (k: number) => {
    if (p + k > block.length) throw new Error(`lz4: block truncated at byte ${p}`)
  }
  while (true) {
    need(1)
    const token = block[p]
    const t0 = p++
    let litLen = token >>> 4
    trace?.push({ kind: 'token', inp: [t0, p], out: [out.length, out.length], seq, token })
    if (litLen === 15) {
      const e0 = p
      let b: number
      do {
        need(1)
        b = block[p++]
        litLen += b
      } while (b === 255)
      trace?.push({ kind: 'litExt', inp: [e0, p], out: [out.length, out.length], seq, litLen })
    }
    need(litLen)
    const o0 = out.length
    for (let i = 0; i < litLen; i++) out.push(block[p + i])
    trace?.push({ kind: 'lits', inp: [p, p + litLen], out: [o0, out.length], seq, litLen })
    p += litLen
    if (p === block.length) return out // the last sequence ends after its literals
    need(2)
    const offset = block[p] | (block[p + 1] << 8)
    trace?.push({ kind: 'offset', inp: [p, p + 2], out: [out.length, out.length], seq, offset })
    p += 2
    if (offset === 0 || offset > out.length) throw new Error(`lz4: offset ${offset} reaches before the start of output`)
    let matchLen = (token & 15) + MINMATCH
    if ((token & 15) === 15) {
      const e0 = p
      let b: number
      do {
        need(1)
        b = block[p++]
        matchLen += b
      } while (b === 255)
      trace?.push({ kind: 'mlExt', inp: [e0, p], out: [out.length, out.length], seq, matchLen })
    }
    const c0 = out.length
    // Byte by byte, so an overlapping copy (offset < length) repeats what it just wrote.
    for (let i = 0; i < matchLen; i++) out.push(out[out.length - offset])
    trace?.push({ kind: 'copy', inp: [p, p], out: [c0, out.length], seq, offset, matchLen })
    seq++
  }
}

/**
 * The fast path: decode into a typed array with bulk copies — `set` for
 * literals and `copyWithin` for matches, which is JavaScript's nearest thing to
 * the C decoder's wide 8/16-byte copies. An overlapping match (offset < length)
 * is copied in chunks of `offset` bytes, each one non-overlapping with its
 * source, so a 1-byte offset still fills a run in a few wide steps.
 *
 * `out.buf` grows by doubling when a block turns out bigger than expected.
 * Returns the new end position.
 */
export function decodeInto(block: Uint8Array, out: { buf: Uint8Array }, pos: number): number {
  let p = 0
  const n = block.length
  const room = (k: number) => {
    if (pos + k <= out.buf.length) return
    let cap = Math.max(16, out.buf.length * 2)
    while (cap < pos + k) cap *= 2
    const nb = new Uint8Array(cap)
    nb.set(out.buf.subarray(0, pos))
    out.buf = nb
  }
  for (;;) {
    if (p >= n) throw new Error('lz4: block truncated')
    const token = block[p++]
    let lit = token >>> 4
    if (lit === 15) {
      let b: number
      do {
        if (p >= n) throw new Error('lz4: block truncated')
        b = block[p++]
        lit += b
      } while (b === 255)
    }
    if (p + lit > n) throw new Error('lz4: block truncated')
    room(lit)
    out.buf.set(block.subarray(p, p + lit), pos)
    pos += lit
    p += lit
    if (p === n) return pos
    if (p + 2 > n) throw new Error('lz4: block truncated')
    const offset = block[p] | (block[p + 1] << 8)
    p += 2
    if (offset === 0 || offset > pos) throw new Error(`lz4: offset ${offset} reaches before the start of output`)
    let len = (token & 15) + MINMATCH
    if ((token & 15) === 15) {
      let b: number
      do {
        if (p >= n) throw new Error('lz4: block truncated')
        b = block[p++]
        len += b
      } while (b === 255)
    }
    room(len)
    const buf = out.buf
    if (offset >= len) buf.copyWithin(pos, pos - offset, pos - offset + len)
    else {
      let done = 0
      while (done < len) {
        const chunk = Math.min(offset, len - done)
        buf.copyWithin(pos + done, pos + done - offset, pos + done - offset + chunk)
        done += chunk
      }
    }
    pos += len
  }
}

/** Decode a whole block on the fast path. `sizeHint` presizes the output. */
export function decompressBlockFast(block: Uint8Array, sizeHint = block.length * 4): Uint8Array {
  const out = { buf: new Uint8Array(Math.max(16, sizeHint)) }
  const end = decodeInto(block, out, 0)
  return out.buf.subarray(0, end)
}

/** Check the end-of-block rules on a parse (true when a reference decoder's fast path is safe). */
export function endRulesHold(n: number, seqs: Sequence[]): boolean {
  if (n < MFLIMIT + 1) return seqs.length === 1 && seqs[0].matchLen === 0
  const last = seqs[seqs.length - 1]
  if (last.matchLen !== 0 || last.litStart + last.litLen !== n) return false
  if (last.litLen < LASTLITERALS) return false
  for (const s of seqs) {
    if (!s.matchLen) continue
    const start = s.litStart + s.litLen
    if (start > n - MFLIMIT) return false
    if (start + s.matchLen > n - LASTLITERALS) return false
    if (s.offset < 1 || s.offset > MAX_OFFSET || s.matchLen < MINMATCH) return false
  }
  return true
}

// ------------------------------------------------------------------ XXH32

const P1 = 2654435761
const P2 = 2246822519
const P3 = 3266489917
const P4 = 668265263
const P5 = 374761393
const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0

/** xxHash32 (Yann Collet), the checksum LZ4 frames use. */
export function xxh32(d: Uint8Array, seed = 0): number {
  const n = d.length
  let i = 0
  let h: number
  if (n >= 16) {
    let v1 = (seed + P1 + P2) >>> 0
    let v2 = (seed + P2) >>> 0
    let v3 = seed >>> 0
    let v4 = (seed - P1) >>> 0
    const round = (v: number, x: number) => mul(rotl((v + mul(x, P2)) >>> 0, 13), P1)
    while (i <= n - 16) {
      v1 = round(v1, read32(d, i))
      v2 = round(v2, read32(d, i + 4))
      v3 = round(v3, read32(d, i + 8))
      v4 = round(v4, read32(d, i + 12))
      i += 16
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0
  } else h = (seed + P5) >>> 0
  h = (h + n) >>> 0
  while (i + 4 <= n) {
    h = mul(rotl((h + mul(read32(d, i), P3)) >>> 0, 17), P4)
    i += 4
  }
  while (i < n) {
    h = mul(rotl((h + mul(d[i], P5)) >>> 0, 11), P1)
    i++
  }
  h ^= h >>> 15
  h = mul(h, P2)
  h ^= h >>> 13
  h = mul(h, P3)
  h ^= h >>> 16
  return h >>> 0
}

// ------------------------------------------------------------------ frames

export const MAGIC = 0x184d2204
export const BLOCK_SIZES: Record<number, number> = { 4: 64 << 10, 5: 256 << 10, 6: 1 << 20, 7: 4 << 20 }

export interface FrameOptions extends EncodeOptions {
  /** 4 = 64 KiB, 5 = 256 KiB, 6 = 1 MiB, 7 = 4 MiB. */
  blockSizeId?: 4 | 5 | 6 | 7
  contentChecksum?: boolean
  blockChecksum?: boolean
  contentSize?: boolean
}

export type FrameFieldKind = 'magic' | 'flg' | 'bd' | 'csize' | 'hc' | 'bsize' | 'block' | 'raw' | 'bcheck' | 'end' | 'ccheck'

export interface FrameField {
  kind: FrameFieldKind
  start: number
  len: number
  label: string
  /** For block fields: which block. */
  block?: number
}

export function flgByte(o: { independent: boolean; blockChecksum: boolean; contentSize: boolean; contentChecksum: boolean; dictId?: boolean }): number {
  return (1 << 6) | (+o.independent << 5) | (+o.blockChecksum << 4) | (+o.contentSize << 3) | (+o.contentChecksum << 2) | +(o.dictId ?? false)
}

export const headerChecksum = (descriptor: Uint8Array) => (xxh32(descriptor, 0) >>> 8) & 0xff

const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

export interface FrameResult {
  bytes: Uint8Array
  fields: FrameField[]
  blocks: { start: number; size: number; compressed: boolean; result?: BlockResult }[]
}

/** An LZ4 frame with independent blocks. Blocks that do not shrink are stored raw (size word high bit set). */
export function compressFrame(d: Uint8Array, o: FrameOptions = {}): FrameResult {
  const id = o.blockSizeId ?? 4
  const max = BLOCK_SIZES[id]
  const contentChecksum = o.contentChecksum ?? true
  const blockChecksum = o.blockChecksum ?? false
  const contentSize = o.contentSize ?? false
  const out: number[] = []
  const fields: FrameField[] = []
  const field = (kind: FrameFieldKind, start: number, label: string, block?: number) => fields.push({ kind, start, len: out.length - start, label, block })

  let s = out.length
  out.push(...u32le(MAGIC))
  field('magic', s, 'magic number 0x184D2204, little-endian')
  const flg = flgByte({ independent: true, blockChecksum, contentSize, contentChecksum })
  s = out.length
  out.push(flg)
  field('flg', s, `FLG 0x${flg.toString(16)}: version 01, independent blocks${blockChecksum ? ', block checksums' : ''}${contentSize ? ', content size' : ''}${contentChecksum ? ', content checksum' : ''}`)
  const bd = id << 4
  s = out.length
  out.push(bd)
  field('bd', s, `BD 0x${bd.toString(16)}: blocks of at most ${max >= 1 << 20 ? (max >> 20) + ' MiB' : (max >> 10) + ' KiB'}`)
  const desc = [flg, bd]
  if (contentSize) {
    s = out.length
    const n = d.length
    const bytes = [...u32le(n), ...u32le(Math.floor(n / 2 ** 32))]
    out.push(...bytes)
    desc.push(...bytes)
    field('csize', s, `content size ${n} bytes, u64 little-endian`)
  }
  s = out.length
  const hc = headerChecksum(Uint8Array.from(desc))
  out.push(hc)
  field('hc', s, `header checksum 0x${hc.toString(16).padStart(2, '0')} = second byte of XXH32(descriptor)`)

  const blocks: FrameResult['blocks'] = []
  for (let b = 0, k = 0; b < d.length; b += max, k++) {
    const chunk = d.subarray(b, Math.min(d.length, b + max))
    const res = compressBlock(chunk, o)
    const compressed = res.bytes.length < chunk.length
    const body = compressed ? res.bytes : chunk
    s = out.length
    out.push(...u32le(body.length | (compressed ? 0 : 0x80000000)))
    field('bsize', s, `block ${k} size word: ${body.length} bytes${compressed ? '' : ', high bit set = stored uncompressed'}`, k)
    s = out.length
    for (let i = 0; i < body.length; i++) out.push(body[i])
    field(compressed ? 'block' : 'raw', s, compressed ? `block ${k}: ${chunk.length} bytes as ${body.length} of LZ4 sequences` : `block ${k}: ${chunk.length} raw bytes (compressing did not help)`, k)
    blocks.push({ start: b, size: chunk.length, compressed, result: compressed ? res : undefined })
    if (blockChecksum) {
      s = out.length
      out.push(...u32le(xxh32(body)))
      field('bcheck', s, `block ${k} checksum, XXH32 of the stored bytes`, k)
    }
  }
  s = out.length
  out.push(0, 0, 0, 0)
  field('end', s, 'end mark: a block size of 0')
  if (contentChecksum) {
    s = out.length
    const c = xxh32(d)
    out.push(...u32le(c))
    field('ccheck', s, `content checksum 0x${c.toString(16).padStart(8, '0')} = XXH32(original)`)
  }
  return { bytes: Uint8Array.from(out), fields, blocks }
}

/**
 * Decode an LZ4 frame: any block size, linked or independent blocks, optional
 * content size, block and content checksums (all verified). Dictionary IDs are
 * rejected — no dictionary is available here.
 */
export function decompressFrame(f: Uint8Array): { out: Uint8Array; fields: FrameField[]; independent: boolean } {
  const fields: FrameField[] = []
  let p = 0
  const need = (k: number) => {
    if (p + k > f.length) throw new Error('lz4 frame: truncated')
  }
  const rd32 = () => {
    need(4)
    const v = read32(f, p)
    p += 4
    return v
  }
  if (rd32() !== MAGIC) throw new Error('lz4 frame: bad magic number')
  fields.push({ kind: 'magic', start: 0, len: 4, label: 'magic' })
  need(2)
  const flg = f[p]
  const bd = f[p + 1]
  if (flg >>> 6 !== 1) throw new Error('lz4 frame: unsupported version')
  if (flg & 2 || bd & 0x8f) throw new Error('lz4 frame: reserved bits set')
  const independent = !!(flg & 0x20)
  const blockChecksum = !!(flg & 0x10)
  const hasSize = !!(flg & 0x08)
  const contentChecksum = !!(flg & 0x04)
  if (flg & 1) throw new Error('lz4 frame: dictionary IDs are not supported')
  const max = BLOCK_SIZES[bd >>> 4]
  if (!max) throw new Error('lz4 frame: bad block size id')
  fields.push({ kind: 'flg', start: p, len: 1, label: 'FLG' }, { kind: 'bd', start: p + 1, len: 1, label: 'BD' })
  const d0 = p
  p += 2
  let declared = -1
  if (hasSize) {
    need(8)
    declared = read32(f, p) + read32(f, p + 4) * 2 ** 32
    fields.push({ kind: 'csize', start: p, len: 8, label: 'content size' })
    p += 8
  }
  need(1)
  if (headerChecksum(f.subarray(d0, p)) !== f[p]) throw new Error('lz4 frame: header checksum mismatch')
  fields.push({ kind: 'hc', start: p, len: 1, label: 'header checksum' })
  p++

  const out = { buf: new Uint8Array(declared > 0 ? declared : Math.max(64, f.length * 3)) }
  let pos = 0
  for (let k = 0; ; k++) {
    const s = p
    const word = rd32()
    fields.push({ kind: word === 0 ? 'end' : 'bsize', start: s, len: 4, label: word === 0 ? 'end mark' : 'block size', block: k })
    if (word === 0) break
    const raw = !!(word & 0x80000000)
    const size = word & 0x7fffffff
    if (size > max) throw new Error('lz4 frame: block larger than the declared maximum')
    need(size)
    const body = f.subarray(p, p + size)
    fields.push({ kind: raw ? 'raw' : 'block', start: p, len: size, label: raw ? 'raw block' : 'compressed block', block: k })
    p += size
    if (blockChecksum) {
      const c = rd32()
      if (c !== xxh32(body)) throw new Error('lz4 frame: block checksum mismatch')
      fields.push({ kind: 'bcheck', start: p - 4, len: 4, label: 'block checksum', block: k })
    }
    const before = pos
    if (raw) {
      if (pos + body.length > out.buf.length) {
        const nb = new Uint8Array(Math.max(out.buf.length * 2, pos + body.length))
        nb.set(out.buf.subarray(0, pos))
        out.buf = nb
      }
      out.buf.set(body, pos)
      pos += body.length
    } else if (independent) {
      // An independent block may not reach into earlier blocks: decode it alone, then append.
      const part = decompressBlockFast(body, max)
      if (pos + part.length > out.buf.length) {
        const nb = new Uint8Array(Math.max(out.buf.length * 2, pos + part.length))
        nb.set(out.buf.subarray(0, pos))
        out.buf = nb
      }
      out.buf.set(part, pos)
      pos += part.length
    } else pos = decodeInto(body, out, pos) // linked: matches may reach into earlier blocks
    if (pos - before > max) throw new Error('lz4 frame: block decodes to more than the declared maximum')
  }
  const result = out.buf.slice(0, pos)
  if (contentChecksum) {
    const c = rd32()
    if (c !== xxh32(result)) throw new Error('lz4 frame: content checksum mismatch')
    fields.push({ kind: 'ccheck', start: p - 4, len: 4, label: 'content checksum' })
  }
  if (declared >= 0 && declared !== result.length) throw new Error('lz4 frame: content size mismatch')
  return { out: result, fields, independent }
}
