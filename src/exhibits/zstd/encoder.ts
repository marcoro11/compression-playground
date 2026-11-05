/**
 * A Zstandard encoder (RFC 8878) that keeps a record of every decision.
 *
 *   frame:     magic, header (single segment, content size), blocks, optional XXH64
 *   block:     raw, RLE, or compressed — whichever is smallest
 *   compressed = literals section + sequences section
 *   literals:  raw, RLE, or Huffman (weights described directly or FSE-coded;
 *              one stream up to 1023 literals, four streams above)
 *   sequences: (literal length, offset, match length) triples; each of the three
 *              code streams gets predefined, RLE or its own FSE table, and the
 *              three are interleaved in one backward bitstream.
 *
 * Match finding is hash chains with lazy matching, and checks the three repeat
 * offsets first — the thing that makes Zstandard's offsets so cheap.
 */

import { limitedLengths } from '../../lib/huffman'
import type { BitSpan } from '../../lib/bits'
import { BitWriter, buildFse, chainStates, closeBackward, encodeMap, highbit, huffFromWeights, normalize, weightsFromLengths, writeNCount, xxh64, type FseTable, type HuffTable } from './core'
import { decodeWeightsFse } from './decoder'
import { BLOCK_MAX, LL_BASE, LL_BITS, MAGIC, MAX_ML, ML_BASE, ML_BITS, STREAMS, llCode, mlCode, ofCode, type StreamName, type TableMode } from './tables'

export type Effort = 'fast' | 'default' | 'max'

export interface EncodeOptions {
  effort?: Effort
  literals?: 'auto' | 'raw' | 'huffman'
  tables?: 'auto' | 'predefined' | 'fse'
  checksum?: boolean
  /** Input bytes per block (≤ 128 KiB). */
  blockSize?: number
}

export interface EncSeq {
  /** Input position where this sequence's literals start. */
  litStart: number
  ll: number
  ml: number
  offset: number
  /** −1 new offset; 0–2 repeat slot; 3 = rep1 − 1 (only with ll = 0). */
  rep: number
  ofValue: number
  llCode: number
  mlCode: number
  ofCode: number
  repsBefore: [number, number, number]
  repsAfter: [number, number, number]
  block: number
}

export interface EncLiterals {
  mode: 'raw' | 'RLE' | 'Huffman'
  count: number
  streams: number
  bytes: number
  headerBytes: number
  huff?: { table: HuffTable; counts: number[]; via: 'direct' | 'FSE'; descBytes: number; fse?: { norm: number[]; log: number } }
  alternatives: { mode: string; bytes: number }[]
}

export interface EncStream {
  mode: TableMode
  table: FseTable
  codes: number[]
  descBytes: number
  /** The decoder's state while it decodes each sequence. */
  states: number[]
  stateBits: number
  extraBits: number
  alternatives: { mode: string; bits: number }[]
}

export interface EncBlock {
  index: number
  type: 'raw' | 'RLE' | 'compressed'
  inStart: number
  inEnd: number
  seqs: EncSeq[]
  literals?: EncLiterals
  streams?: Record<StreamName, EncStream>
  seqBytes?: number
  /** Size the compressed form would have had (even when not chosen). */
  compressedSize: number
  size: number
  bitSpans?: BitSpan[]
  seqStreamBits?: number
}

export interface EncodeResult {
  bytes: Uint8Array
  blocks: EncBlock[]
  seqs: EncSeq[]
  headerBytes: number
}

const EFFORT = {
  fast: { chain: 4, lazy: false, nice: 32 },
  default: { chain: 48, lazy: true, nice: 160 },
  max: { chain: 1024, lazy: true, nice: 4096 },
}

// ------------------------------------------------------------- repeat offsets

/** The decoder's repeat-offset bookkeeping, mirrored (RFC 8878 §3.1.2.5). */
export function applyRep(reps: [number, number, number], rep: number, offset: number): void {
  if (rep < 0 || rep === 3 || rep === 2) {
    reps[2] = reps[1]
    reps[1] = reps[0]
    reps[0] = offset
  } else if (rep === 1) {
    reps[1] = reps[0]
    reps[0] = offset
  }
}

/** Which repeat slot (if any) can say `dist` for a sequence with `ll` literals. */
export function repSlot(dist: number, ll: number, reps: readonly number[]): number {
  if (ll > 0) {
    for (let k = 0; k < 3; k++) if (reps[k] === dist) return k
    return -1
  }
  if (reps[1] === dist) return 1
  if (reps[2] === dist) return 2
  if (reps[0] - 1 === dist && dist > 0) return 3
  return -1
}

/** Offset_Value for a sequence: 1–3 are repeat codes (shifted by one when ll = 0), else offset + 3. */
export const offsetValue = (rep: number, ll: number, offset: number) => (rep < 0 ? offset + 3 : ll > 0 ? rep + 1 : rep)

// ---------------------------------------------------------------- matching

function parse(data: Uint8Array, bs: number, be: number, reps: [number, number, number], effort: Effort, chain: { head: Int32Array; prev: Int32Array; next: number }, block: number): EncSeq[] {
  const { chain: maxChain, lazy, nice } = EFFORT[effort]
  const n = data.length
  const seqs: EncSeq[] = []
  const HBITS = 16
  const hash = (i: number) => (Math.imul((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], 0x9e3779b1) >>> (32 - HBITS))
  const insertUpTo = (x: number) => {
    while (chain.next < x) {
      const i = chain.next++
      if (i + 2 < n) {
        const h = hash(i)
        chain.prev[i] = chain.head[h]
        chain.head[h] = i
      }
    }
  }
  const matchLen = (i: number, dist: number, max: number) => {
    let l = 0
    const j = i - dist
    while (l < max && data[i + l] === data[j + l]) l++
    return l
  }
  type Cand = { len: number; dist: number; rep: number; score: number }
  const search = (i: number, anchor: number): Cand | null => {
    insertUpTo(i)
    const ll = i - anchor
    const max = Math.min(MAX_ML, be - i)
    if (max < 3) return null
    let best: Cand | null = null
    const consider = (len: number, dist: number) => {
      if (len < 3) return
      const rep = repSlot(dist, ll, reps)
      // Rough bit cost: a repeat code is nearly free; a new offset costs its own bits.
      const score = len * 8 - (rep >= 0 ? 3 : 8 + highbit(dist + 3))
      if (!best || score > best.score) best = { len, dist, rep, score }
    }
    // Repeat offsets first.
    const repDists = ll > 0 ? [reps[0], reps[1], reps[2]] : [reps[1], reps[2], reps[0] - 1]
    for (const dist of repDists) if (dist > 0 && dist <= i) consider(matchLen(i, dist, max), dist)
    if (i + 2 < n) {
      let cand = chain.head[hash(i)]
      let walk = maxChain
      while (cand >= 0 && walk-- > 0) {
        const dist = i - cand
        if (data[cand] === data[i] && data[cand + 1] === data[i + 1]) {
          const len = matchLen(i, dist, max)
          consider(len, dist)
          if (len >= nice) break
        }
        cand = chain.prev[cand]
      }
    }
    return best
  }

  let i = bs
  let anchor = bs
  while (i < be) {
    const m = search(i, anchor)
    if (!m) {
      i++
      continue
    }
    if (lazy && i + 1 < be) {
      const m2 = search(i + 1, anchor)
      if (m2 && m2.score > m.score + 8) {
        i++
        continue
      }
    }
    const ll = i - anchor
    const before: [number, number, number] = [reps[0], reps[1], reps[2]]
    applyRep(reps, m.rep, m.dist)
    const ofv = offsetValue(m.rep, ll, m.dist)
    seqs.push({
      litStart: anchor,
      ll,
      ml: m.len,
      offset: m.dist,
      rep: m.rep,
      ofValue: ofv,
      llCode: llCode(ll),
      mlCode: mlCode(m.len),
      ofCode: ofCode(ofv),
      repsBefore: before,
      repsAfter: [reps[0], reps[1], reps[2]],
      block,
    })
    i += m.len
    anchor = i
  }
  return seqs
}

// ---------------------------------------------------------------- literals

function rawLitHeader(type: 0 | 1, n: number): number[] {
  if (n < 32) return [type | (n << 3)]
  if (n < 4096) return [type | (1 << 2) | ((n & 15) << 4), n >> 4]
  return [type | (3 << 2) | ((n & 15) << 4), (n >> 4) & 255, n >> 12]
}

function compLitHeader(streams: number, regen: number, comp: number): number[] {
  const m = Math.max(regen, comp)
  if (streams === 1 || m < 1024) {
    const sf = streams === 1 ? 0 : 1
    const v = 2 + sf * 4 + regen * 16 + comp * 2 ** 14
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255]
  }
  if (m < 16384) {
    const v = 2 + 2 * 4 + regen * 16 + comp * 2 ** 18
    return [v % 256, Math.floor(v / 2 ** 8) % 256, Math.floor(v / 2 ** 16) % 256, Math.floor(v / 2 ** 24) % 256]
  }
  const v = 2 + 3 * 4 + regen * 16 + comp * 2 ** 22
  return [0, 1, 2, 3, 4].map((k) => Math.floor(v / 2 ** (8 * k)) % 256)
}

/** FSE-compress the listed Huffman weights; null if it cannot or does not fit. */
export function encodeWeightsFse(listed: number[]): { bytes: number[]; norm: number[]; log: number } | null {
  const n = listed.length
  if (n < 2) return null
  const counts = new Array<number>(Math.max(...listed) + 1).fill(0)
  for (const w of listed) counts[w]++
  let best: { bytes: number[]; norm: number[]; log: number } | null = null
  for (const log of [5, 6]) {
    if (counts.filter((c) => c > 0).length > 1 << log) continue
    const norm = normalize(counts, log)
    let t: FseTable
    try {
      t = buildFse(norm, log)
    } catch {
      continue
    }
    const map = encodeMap(t)
    const symA = listed.filter((_, k) => k % 2 === 0)
    const symB = listed.filter((_, k) => k % 2 === 1)
    const aEndsEarly = (n - 2) % 2 === 0
    const needBits = (u: number) => t.cells[u].nbBits > 0
    let cA, cB
    try {
      cA = chainStates(t, map, symA, aEndsEarly ? needBits : undefined)
      cB = chainStates(t, map, symB, aEndsEarly ? undefined : needBits)
    } catch {
      continue
    }
    const desc = new BitWriter('lsb')
    writeNCount(desc, norm, log)
    desc.align()
    const w = new BitWriter('lsb')
    for (let k = n - 3; k >= 0; k--) {
      const c = k % 2 === 0 ? cA : cB
      const j = k >> 1
      w.writeBits(c.bits[j], c.nb[j])
    }
    w.writeBits(cB.states[0], log)
    w.writeBits(cA.states[0], log)
    const stream = closeBackward(w)
    const bytes = [...desc.finish(), ...stream]
    if (bytes.length > 127) continue
    // Belt and braces: the decoder must read back exactly these weights.
    const descLen = desc.finish().length
    const check = Uint8Array.from(bytes)
    let ok = false
    try {
      const back = decodeWeightsFse(check, descLen, check.length, t)
      ok = back.length === n && back.every((x, i) => x === listed[i])
    } catch {
      ok = false
    }
    if (ok && (!best || bytes.length < best.bytes.length)) best = { bytes, norm, log }
  }
  return best
}

function huffStream(lits: Uint8Array, h: HuffTable): Uint8Array {
  const w = new BitWriter('lsb')
  for (let i = lits.length - 1; i >= 0; i--) w.writeBits(h.codes[lits[i]], h.lengths[lits[i]])
  return closeBackward(w)
}

function encodeLiterals(lits: Uint8Array, pref: EncodeOptions['literals']): { bytes: number[]; info: EncLiterals } {
  const n = lits.length
  const opts: { bytes: number[]; info: EncLiterals }[] = []
  const raw = [...rawLitHeader(0, n), ...lits]
  opts.push({ bytes: raw, info: { mode: 'raw', count: n, streams: 1, bytes: raw.length, headerBytes: rawLitHeader(0, n).length, alternatives: [] } })
  if (n > 1 && lits.every((b) => b === lits[0])) {
    const rle = [...rawLitHeader(1, n), lits[0]]
    opts.push({ bytes: rle, info: { mode: 'RLE', count: n, streams: 1, bytes: rle.length, headerBytes: rle.length - 1, alternatives: [] } })
  }
  const counts = new Array<number>(256).fill(0)
  for (const b of lits) counts[b]++
  const distinct = counts.filter((c) => c > 0).length
  if (pref !== 'raw' && distinct >= 2 && n >= 8) {
    const lengths = limitedLengths(counts, 11)
    let last = 255
    while (counts[last] === 0) last--
    const weights = weightsFromLengths(lengths).slice(0, last + 1)
    const table = huffFromWeights(weights)
    const listed = weights.slice(0, last)
    let desc: number[] = []
    let via: 'direct' | 'FSE' = 'direct'
    let fse: { norm: number[]; log: number } | undefined
    if (listed.length <= 128) {
      desc = [127 + listed.length]
      for (let i = 0; i < listed.length; i += 2) desc.push((listed[i] << 4) | (listed[i + 1] ?? 0))
    }
    const f = encodeWeightsFse(listed)
    if (f && (desc.length === 0 || f.bytes.length + 1 < desc.length)) {
      desc = [f.bytes.length, ...f.bytes]
      via = 'FSE'
      fse = { norm: f.norm, log: f.log }
    }
    if (desc.length) {
      const streams = n <= 1023 ? 1 : 4
      let body: number[] = [...desc]
      if (streams === 1) body.push(...huffStream(lits, table))
      else {
        const seg = Math.floor((n + 3) / 4)
        const parts = [0, 1, 2, 3].map((k) => huffStream(lits.subarray(k * seg, k < 3 ? (k + 1) * seg : n), table))
        const jump = [parts[0].length, parts[1].length, parts[2].length]
        if (jump.every((s) => s < 65536)) {
          body.push(...jump.flatMap((s) => [s & 255, s >> 8]))
          for (const p of parts) body.push(...p)
        } else body = []
      }
      if (body.length && (streams === 4 || body.length <= 1023)) {
        const hdr = compLitHeader(streams, n, body.length)
        const bytes = [...hdr, ...body]
        opts.push({
          bytes,
          info: { mode: 'Huffman', count: n, streams, bytes: bytes.length, headerBytes: hdr.length, huff: { table, counts, via, descBytes: desc.length, fse }, alternatives: [] },
        })
      }
    }
  }
  const alternatives = opts.map((o) => ({ mode: o.info.mode, bytes: o.bytes.length }))
  let pick = opts.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a))
  if (pref === 'huffman') pick = opts.find((o) => o.info.mode === 'Huffman') ?? pick
  if (pref === 'raw') pick = opts[0]
  pick.info.alternatives = alternatives
  return pick
}

// --------------------------------------------------------------- sequences

const DEFAULT_TABLES: Partial<Record<StreamName, FseTable>> = {}
const defaultTable = (s: StreamName) => (DEFAULT_TABLES[s] ??= buildFse([...STREAMS[s].def], STREAMS[s].defLog))

interface Option {
  mode: TableMode
  table: FseTable
  desc: number[]
  chain: ReturnType<typeof chainStates>
  bits: number
}

function streamOptions(s: StreamName, codes: number[]): Option[] {
  const out: Option[] = []
  const tryTable = (mode: TableMode, table: FseTable, desc: number[]) => {
    try {
      const chain = chainStates(table, encodeMap(table), codes)
      let bits = desc.length * 8 + table.log
      for (const b of chain.nb) bits += b
      out.push({ mode, table, desc, chain, bits })
    } catch {
      /* a code the table cannot express */
    }
  }
  if (codes.every((c) => c === codes[0])) tryTable('RLE', { log: 0, norm: [], cells: [{ symbol: codes[0], nbBits: 0, baseline: 0 }] }, [codes[0]])
  tryTable('predefined', defaultTable(s), [])
  const counts = new Array<number>(STREAMS[s].maxSymbol + 1).fill(0)
  for (const c of codes) counts[c]++
  const distinct = counts.filter((c) => c > 0).length
  for (let log = 5; log <= STREAMS[s].maxLog; log++) {
    if (distinct > 1 << log || distinct < 2) continue
    const norm = normalize(counts, log)
    const w = new BitWriter('lsb')
    writeNCount(w, norm, log)
    w.align()
    tryTable('FSE', buildFse(norm, log), [...w.finish()])
  }
  return out
}

function encodeSequences(seqs: EncSeq[], pref: EncodeOptions['tables']): { bytes: number[]; streams?: Record<StreamName, EncStream>; spans?: BitSpan[]; bits?: number } {
  const n = seqs.length
  const head = n < 128 ? [n] : n < 0x7f00 ? [(n >> 8) + 128, n & 255] : [255, (n - 0x7f00) & 255, (n - 0x7f00) >> 8]
  if (n === 0) return { bytes: head }
  const codes: Record<StreamName, number[]> = { LL: seqs.map((q) => q.llCode), OF: seqs.map((q) => q.ofCode), ML: seqs.map((q) => q.mlCode) }
  const chosen = {} as Record<StreamName, Option>
  const streams = {} as Record<StreamName, EncStream>
  for (const s of ['LL', 'OF', 'ML'] as StreamName[]) {
    const opts = streamOptions(s, codes[s])
    let pick = opts.reduce((a, b) => (b.bits < a.bits ? b : a))
    if (pref === 'predefined') pick = opts.find((o) => o.mode === 'predefined') ?? pick
    if (pref === 'fse') pick = opts.filter((o) => o.mode === 'FSE').reduce<Option | undefined>((a, b) => (!a || b.bits < a.bits ? b : a), undefined) ?? pick
    chosen[s] = pick
    const extra = seqs.reduce((t, q) => t + (s === 'LL' ? LL_BITS[q.llCode] : s === 'ML' ? ML_BITS[q.mlCode] : q.ofCode), 0)
    streams[s] = {
      mode: pick.mode,
      table: pick.table,
      codes: codes[s],
      descBytes: pick.desc.length,
      states: pick.chain.states,
      stateBits: pick.bits - pick.desc.length * 8,
      extraBits: extra,
      alternatives: opts.map((o) => ({ mode: o.mode === 'FSE' ? `FSE, accuracy ${o.table.log}` : o.mode, bits: o.bits })),
    }
  }
  const modeNum = (m: TableMode) => ['predefined', 'RLE', 'FSE', 'repeat'].indexOf(m)
  const modes = (modeNum(chosen.LL.mode) << 6) | (modeNum(chosen.OF.mode) << 4) | (modeNum(chosen.ML.mode) << 2)

  const w = new BitWriter('lsb', true)
  const L = chosen.LL
  const O = chosen.OF
  const M = chosen.ML
  for (let i = n - 1; i >= 0; i--) {
    const q = seqs[i]
    if (i < n - 1) {
      w.writeBits(O.chain.bits[i], O.chain.nb[i], `seq ${i}: offset state → next`, 'state')
      w.writeBits(M.chain.bits[i], M.chain.nb[i], `seq ${i}: match-length state → next`, 'state')
      w.writeBits(L.chain.bits[i], L.chain.nb[i], `seq ${i}: literal-length state → next`, 'state')
    }
    w.writeBits(q.ll - LL_BASE[q.llCode], LL_BITS[q.llCode], `seq ${i}: literal length ${q.ll} extra bits`, 'llx')
    w.writeBits(q.ml - ML_BASE[q.mlCode], ML_BITS[q.mlCode], `seq ${i}: match length ${q.ml} extra bits`, 'mlx')
    w.writeBits(q.ofValue - 2 ** q.ofCode, q.ofCode, `seq ${i}: offset value ${q.ofValue} extra bits`, 'ofx')
  }
  w.writeBits(M.chain.states[0], M.table.log, 'initial match-length state', 'init')
  w.writeBits(O.chain.states[0], O.table.log, 'initial offset state', 'init')
  w.writeBits(L.chain.states[0], L.table.log, 'initial literal-length state', 'init')
  const bits = w.bitLength
  const stream = closeBackward(w)
  const bytes = [...head, modes, ...L.desc, ...O.desc, ...M.desc, ...stream]
  return { bytes, streams, spans: w.spans, bits }
}

// ------------------------------------------------------------------- frame

export function encode(data: Uint8Array, opts: EncodeOptions = {}): EncodeResult {
  const effort = opts.effort ?? 'default'
  const blockSize = Math.min(BLOCK_MAX, opts.blockSize ?? BLOCK_MAX)
  const n = data.length
  const out: number[] = []
  const put32 = (v: number) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  put32(MAGIC)
  // Single segment: the window is the whole content, so the size is all we send.
  const fcsFlag = n < 256 ? 0 : n < 65536 + 256 ? 1 : 2
  out.push((fcsFlag << 6) | (1 << 5) | (opts.checksum ? 4 : 0))
  if (fcsFlag === 0) out.push(n)
  else if (fcsFlag === 1) out.push((n - 256) & 255, (n - 256) >> 8)
  else put32(n)
  const headerBytes = out.length

  const chain = { head: new Int32Array(1 << 16).fill(-1), prev: new Int32Array(Math.max(1, n)).fill(-1), next: 0 }
  const reps: [number, number, number] = [1, 4, 8]
  const blocks: EncBlock[] = []
  const allSeqs: EncSeq[] = []
  let bs = 0
  do {
    const be = Math.min(n, bs + blockSize)
    const last = be >= n
    const index = blocks.length
    const raw = data.subarray(bs, be)
    const snapshot: [number, number, number] = [reps[0], reps[1], reps[2]]
    const seqs = parse(data, bs, be, reps, effort, chain, index)
    // Literals = every byte not covered by a match.
    const lits: number[] = []
    let p = bs
    for (const q of seqs) {
      for (let k = q.litStart; k < q.litStart + q.ll; k++) lits.push(data[k])
      p = q.litStart + q.ll + q.ml
    }
    for (let k = p; k < be; k++) lits.push(data[k])
    const lit = encodeLiterals(Uint8Array.from(lits), opts.literals)
    const sq = encodeSequences(seqs, opts.tables)
    const body = [...lit.bytes, ...sq.bytes]
    const blk: EncBlock = {
      index,
      type: 'compressed',
      inStart: bs,
      inEnd: be,
      seqs,
      literals: lit.info,
      streams: sq.streams,
      seqBytes: sq.bytes.length,
      compressedSize: body.length + 3,
      size: 0,
      bitSpans: sq.spans,
      seqStreamBits: sq.bits,
    }
    const allSame = raw.length > 1 && raw.every((b) => b === raw[0])
    let type: 0 | 1 | 2
    let content: number[]
    if (allSame) {
      type = 1
      content = [raw[0]]
    } else if (body.length >= raw.length || raw.length === 0) {
      type = 0
      content = [...raw]
    } else {
      type = 2
      content = body
    }
    if (type !== 2) {
      // The decoder never sees these sequences, so its repeat offsets do not move.
      reps[0] = snapshot[0]
      reps[1] = snapshot[1]
      reps[2] = snapshot[2]
      blk.type = type === 0 ? 'raw' : 'RLE'
    } else allSeqs.push(...seqs)
    const size = type === 2 ? content.length : raw.length
    const h = (last ? 1 : 0) | (type << 1) | (size << 3)
    out.push(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, ...content)
    blk.size = content.length + 3
    blocks.push(blk)
    bs = be
  } while (bs < n)

  if (opts.checksum) put32(Number(xxh64(data) & 0xffffffffn))
  return { bytes: Uint8Array.from(out), blocks, seqs: allSeqs, headerBytes }
}
