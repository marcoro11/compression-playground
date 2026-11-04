/**
 * A from-scratch RFC 1951 encoder.
 *
 * Pipeline: LZ77 tokens (matcher.ts) → cut into blocks → for each block, work
 * out what it would cost as stored, fixed-Huffman and dynamic-Huffman → write
 * the chosen one. Every field goes through a recording BitWriter so the
 * exhibit can lay out the finished stream and say what every bit is.
 *
 * Bit order, the line everyone reads twice: DEFLATE packs bits into bytes
 * starting at the least significant bit. Plain numbers (BTYPE, HLIT, extra
 * bits, LEN…) are written least-significant bit first. Huffman codes are
 * written *most*-significant bit first, because a decoder reads them one bit
 * at a time from the root of the tree.
 */

import { BitWriter, type BitSpan } from '../../lib/bits'
import { canonicalCodes, limitedLengths } from '../../lib/huffman'
import { glyph } from '../../lib/text'
import { findTokens, type Token, type MatchOptions } from './matcher'
import { CL_EXTRA, CL_ORDER, FIXED_DIST_CODES, FIXED_DIST_LENGTHS, FIXED_LIT_CODES, FIXED_LIT_LENGTHS, distCode, lengthCode } from './tables'

export type BlockType = 'stored' | 'fixed' | 'dynamic'
export type BlockChoice = BlockType | 'auto'

export interface DeflateOptions extends MatchOptions {
  block?: BlockChoice
  /** Record labelled spans for every field (the exhibit wants this; the codec does not). */
  record?: boolean
  /** Tokens per Huffman block. zlib flushes a block every 16 Ki symbols. */
  blockTokens?: number
}

/** One entry of the run-length-coded code-length list (symbols 0…18). */
export interface ClSymbol {
  sym: number
  /** Value of the extra bits (16: repeat−3, 17: zeros−3, 18: zeros−11). */
  extra: number
  /** How many code lengths this symbol stands for. */
  covers: number
  /** The code length it stands for (for 16, the repeated value). */
  value: number
}

export interface DynamicHeader {
  litLens: number[]
  distLens: number[]
  hlit: number
  hdist: number
  hclen: number
  /** Code-length-code lengths, indexed by symbol 0…18. */
  clLens: number[]
  clCodes: number[]
  clSeq: ClSymbol[]
  /** The HLIT+257 + HDIST+1 lengths the RLE describes. */
  lengthSeq: number[]
  /** Bits spent on the header after BFINAL/BTYPE. */
  headerBits: number
}

export interface BlockReport {
  type: BlockType
  final: boolean
  tokenStart: number
  tokenEnd: number
  dataStart: number
  dataEnd: number
  bitStart: number
  bitEnd: number
  /** What each block type would have cost for this block, in bits. */
  cost: Record<BlockType, number>
  header?: DynamicHeader
}

export interface DeflateResult {
  bytes: Uint8Array
  bitLength: number
  spans: BitSpan[]
  tokens: Token[]
  blocks: BlockReport[]
  /** For token k: the span indices [from, to) that encode it (empty when its block is stored). */
  tokenSpans: [number, number][]
}

// ------------------------------------------------------------------ helpers

/** At least two used symbols, so every Huffman code we send is complete. */
function ensureTwo(freqs: number[]): number[] {
  const f = freqs.slice()
  let used = 0
  for (const x of f) if (x) used++
  for (let s = 0; used < 2 && s < f.length; s++) {
    if (!f[s]) {
      f[s] = 1
      used++
    }
  }
  return f
}

function blockFreqs(tokens: Token[], from: number, to: number) {
  const lit = new Array<number>(286).fill(0)
  const dist = new Array<number>(30).fill(0)
  for (let k = from; k < to; k++) {
    const t = tokens[k]
    if (t.kind === 'lit') lit[t.byte]++
    else {
      lit[lengthCode(t.length).code]++
      dist[distCode(t.dist).code]++
    }
  }
  lit[256] = 1
  return { lit, dist }
}

/** Run-length code a list of code lengths with symbols 16/17/18 (RFC 1951 §3.2.7). */
export function rleLengths(L: number[]): ClSymbol[] {
  const out: ClSymbol[] = []
  let i = 0
  while (i < L.length) {
    const v = L[i]
    let run = 1
    while (i + run < L.length && L[i + run] === v) run++
    if (v === 0) {
      let left = run
      while (left >= 11) {
        const k = Math.min(left, 138)
        out.push({ sym: 18, extra: k - 11, covers: k, value: 0 })
        left -= k
      }
      if (left >= 3) {
        out.push({ sym: 17, extra: left - 3, covers: left, value: 0 })
        left = 0
      }
      for (; left > 0; left--) out.push({ sym: 0, extra: 0, covers: 1, value: 0 })
    } else {
      out.push({ sym: v, extra: 0, covers: 1, value: v })
      let left = run - 1
      while (left >= 3) {
        const k = Math.min(left, 6)
        out.push({ sym: 16, extra: k - 3, covers: k, value: v })
        left -= k
      }
      for (; left > 0; left--) out.push({ sym: v, extra: 0, covers: 1, value: v })
    }
    i += run
  }
  return out
}

export function buildDynamicHeader(tokens: Token[], from: number, to: number): DynamicHeader {
  const { lit, dist } = blockFreqs(tokens, from, to)
  const litLens = limitedLengths(ensureTwo(lit), 15)
  const distLens = limitedLengths(ensureTwo(dist), 15)
  let nlit = 286
  while (nlit > 257 && litLens[nlit - 1] === 0) nlit--
  let ndist = 30
  while (ndist > 1 && distLens[ndist - 1] === 0) ndist--
  const lengthSeq = litLens.slice(0, nlit).concat(distLens.slice(0, ndist))
  const clSeq = rleLengths(lengthSeq)
  const clFreq = new Array<number>(19).fill(0)
  for (const c of clSeq) clFreq[c.sym]++
  const clLens = limitedLengths(ensureTwo(clFreq), 7)
  const clCodes = canonicalCodes(clLens)
  let ncl = 19
  while (ncl > 4 && clLens[CL_ORDER[ncl - 1]] === 0) ncl--
  let headerBits = 5 + 5 + 4 + ncl * 3
  for (const c of clSeq) headerBits += clLens[c.sym] + (CL_EXTRA[c.sym] ?? 0)
  return {
    litLens: litLens.slice(0, 286),
    distLens: distLens.slice(0, 30),
    hlit: nlit - 257,
    hdist: ndist - 1,
    hclen: ncl - 4,
    clLens,
    clCodes,
    clSeq,
    lengthSeq,
    headerBits,
  }
}

function tokenCost(tokens: Token[], from: number, to: number, litLens: number[], distLens: number[]): number {
  let bits = litLens[256]
  for (let k = from; k < to; k++) {
    const t = tokens[k]
    if (t.kind === 'lit') bits += litLens[t.byte]
    else {
      const lc = lengthCode(t.length)
      const dc = distCode(t.dist)
      bits += litLens[lc.code] + lc.extraBits + distLens[dc.code] + dc.extraBits
    }
  }
  return bits
}

function storedCost(len: number, bitPos: number): number {
  // 3 header bits, pad to a byte, LEN + NLEN, the bytes; one block per 65535.
  let bits = 0
  let pos = bitPos
  let left = len
  do {
    const chunk = Math.min(left, 65535)
    const afterHeader = pos + 3
    const pad = (8 - (afterHeader % 8)) % 8
    const b = 3 + pad + 32 + chunk * 8
    bits += b
    pos += b
    left -= chunk
  } while (left > 0)
  return bits
}

// ------------------------------------------------------------------ writing

function writeTokens(w: BitWriter, data: Uint8Array, tokens: Token[], from: number, to: number, litLens: number[], litCodes: number[], distLens: number[], distCodes: number[], tokenSpans: [number, number][]) {
  for (let k = from; k < to; k++) {
    const t = tokens[k]
    const s0 = w.spans.length
    if (t.kind === 'lit') {
      w.writeCode(litCodes[t.byte], litLens[t.byte], `literal ‘${glyph(t.byte)}’ (byte ${t.byte}) — ${litLens[t.byte]}-bit code`, 'literal')
    } else {
      const lc = lengthCode(t.length)
      const dc = distCode(t.dist)
      w.writeCode(litCodes[lc.code], litLens[lc.code], `length ${t.length} → code ${lc.code} (covers ${lc.base}${lc.extraBits ? '–' + (lc.base + (1 << lc.extraBits) - 1) : ''})`, 'length')
      if (lc.extraBits) w.writeBits(lc.extra, lc.extraBits, `${lc.extraBits} extra bit${lc.extraBits > 1 ? 's' : ''} = ${lc.extra}: length ${lc.base} + ${lc.extra} = ${t.length}`, 'lenextra')
      w.writeCode(distCodes[dc.code], distLens[dc.code], `distance ${t.dist} → code ${dc.code} (covers ${dc.base}${dc.extraBits ? '–' + (dc.base + (1 << dc.extraBits) - 1) : ''})`, 'dist')
      if (dc.extraBits) w.writeBits(dc.extra, dc.extraBits, `${dc.extraBits} extra bit${dc.extraBits > 1 ? 's' : ''} = ${dc.extra}: distance ${dc.base} + ${dc.extra} = ${t.dist}`, 'distextra')
    }
    tokenSpans[k] = [s0, w.spans.length]
  }
  void data
  w.writeCode(litCodes[256], litLens[256], 'end of block (symbol 256)', 'eob')
}

function writeStored(w: BitWriter, data: Uint8Array, start: number, end: number, final: boolean) {
  let pos = start
  do {
    const chunk = Math.min(end - pos, 65535)
    const last = final && pos + chunk >= end
    w.writeBits(last ? 1 : 0, 1, `BFINAL = ${last ? 1 : 0}${last ? ' — this is the last block' : ''}`, 'header')
    w.writeBits(0, 2, 'BTYPE = 00 — stored (no compression)', 'header')
    w.align('padding to a byte boundary', 'pad')
    w.writeBits(chunk, 16, `LEN = ${chunk} bytes follow`, 'stored')
    w.writeBits(~chunk & 0xffff, 16, `NLEN = ${~chunk & 0xffff} (one’s complement of LEN, a sanity check)`, 'stored')
    for (let i = pos; i < pos + chunk; i++) w.writeBits(data[i], 8, `raw byte ‘${glyph(data[i])}’ (${data[i]})`, 'raw')
    pos += chunk
  } while (pos < end)
}

function writeDynamicHeader(w: BitWriter, h: DynamicHeader) {
  w.writeBits(h.hlit, 5, `HLIT = ${h.hlit} → ${h.hlit + 257} literal/length code lengths follow`, 'hlit')
  w.writeBits(h.hdist, 5, `HDIST = ${h.hdist} → ${h.hdist + 1} distance code lengths follow`, 'hdist')
  w.writeBits(h.hclen, 4, `HCLEN = ${h.hclen} → ${h.hclen + 4} code-length-code lengths follow`, 'hclen')
  for (let i = 0; i < h.hclen + 4; i++) {
    const sym = CL_ORDER[i]
    w.writeBits(h.clLens[sym], 3, `code-length code: symbol ${sym} gets a ${h.clLens[sym]}-bit code${h.clLens[sym] ? '' : ' (unused)'}`, 'cllen')
  }
  let idx = 0
  const nlit = h.hlit + 257
  const where = (i: number) => (i < nlit ? (i < 256 ? `‘${glyph(i)}’` : i === 256 ? 'EOB' : `length code ${i}`) : `distance code ${i - nlit}`)
  for (const c of h.clSeq) {
    const label =
      c.sym < 16
        ? `length ${c.sym} for ${where(idx)}`
        : c.sym === 16
          ? `16: repeat the previous length (${c.value}) ×${c.covers} — ${where(idx)} … ${where(idx + c.covers - 1)}`
          : `${c.sym}: ${c.covers} zeros — ${where(idx)} … ${where(idx + c.covers - 1)} unused`
    w.writeCode(h.clCodes[c.sym], h.clLens[c.sym], label, 'clcode')
    if (c.sym >= 16) w.writeBits(c.extra, CL_EXTRA[c.sym], `${CL_EXTRA[c.sym]} extra bits = ${c.extra} → ${c.covers}`, 'clextra')
    idx += c.covers
  }
}

// ------------------------------------------------------------------- public

export function deflate(data: Uint8Array, opts: DeflateOptions = {}): DeflateResult {
  const choice = opts.block ?? 'auto'
  const record = opts.record ?? false
  const per = opts.blockTokens ?? 16383
  const tokens = findTokens(data, opts)
  const w = new BitWriter('lsb', record)
  const tokenSpans: [number, number][] = tokens.map(() => [0, 0])
  const blocks: BlockReport[] = []

  // Cut the token stream into blocks; an empty input still needs one (final) block.
  const cuts: [number, number][] = []
  for (let k = 0; k < tokens.length; k += per) cuts.push([k, Math.min(tokens.length, k + per)])
  if (cuts.length === 0) cuts.push([0, 0])

  const dataPos = (k: number) => (k < tokens.length ? tokens[k].pos : data.length)

  cuts.forEach(([from, to], bi) => {
    const final = bi === cuts.length - 1
    const dataStart = dataPos(from)
    const dataEnd = dataPos(to)
    const header = buildDynamicHeader(tokens, from, to)
    const cost: Record<BlockType, number> = {
      stored: storedCost(dataEnd - dataStart, w.bitLength),
      fixed: 3 + tokenCost(tokens, from, to, FIXED_LIT_LENGTHS, FIXED_DIST_LENGTHS),
      dynamic: 3 + header.headerBits + tokenCost(tokens, from, to, header.litLens, header.distLens),
    }
    let type: BlockType = choice === 'auto' ? 'dynamic' : choice
    if (choice === 'auto') {
      if (cost.fixed <= cost[type]) type = 'fixed'
      if (cost.stored < cost[type]) type = 'stored'
    }
    const bitStart = w.bitLength
    if (type === 'stored') {
      writeStored(w, data, dataStart, dataEnd, final)
    } else {
      w.writeBits(final ? 1 : 0, 1, `BFINAL = ${final ? 1 : 0}${final ? ' — this is the last block' : ' — more blocks follow'}`, 'header')
      if (type === 'fixed') {
        w.writeBits(1, 2, 'BTYPE = 01 — fixed Huffman codes (no tables sent)', 'header')
        writeTokens(w, data, tokens, from, to, FIXED_LIT_LENGTHS, FIXED_LIT_CODES, FIXED_DIST_LENGTHS, FIXED_DIST_CODES, tokenSpans)
      } else {
        w.writeBits(2, 2, 'BTYPE = 10 — dynamic Huffman codes (tables follow)', 'header')
        writeDynamicHeader(w, header)
        const lc = canonicalCodes(header.litLens)
        const dc = canonicalCodes(header.distLens)
        writeTokens(w, data, tokens, from, to, header.litLens, lc, header.distLens, dc, tokenSpans)
      }
    }
    blocks.push({ type, final, tokenStart: from, tokenEnd: to, dataStart, dataEnd, bitStart, bitEnd: w.bitLength, cost, header: type === 'dynamic' ? header : undefined })
  })

  const bitLength = w.bitLength
  if (record && bitLength % 8) w.align('padding to the end of the last byte', 'pad')
  return { bytes: w.finish(), bitLength, spans: w.spans, tokens, blocks, tokenSpans }
}

/** Just the bytes. */
export function deflateRaw(data: Uint8Array, opts: Omit<DeflateOptions, 'record'> = {}): Uint8Array {
  return deflate(data, { ...opts, record: false }).bytes
}
