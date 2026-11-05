/**
 * A Zstandard decoder written from RFC 8878, with a trace of every field it
 * reads. It handles everything a frame can contain apart from dictionaries:
 * raw / RLE / compressed blocks; raw, RLE, Huffman and treeless literals in one
 * or four streams; FSE weights; predefined, RLE, FSE and repeat sequence
 * tables; repeat offsets; skippable frames; and the XXH64 content checksum.
 *
 * `npm run verify zstd` feeds it the output of the zstd built into Node.
 */

import { BackReader, buildFse, completeWeights, huffFromWeights, readNCount, rleTable, xxh64, type FseTable, type HuffTable } from './core'
import { LL_BASE, LL_BITS, MAGIC, ML_BASE, ML_BITS, MODE_NAMES, STREAMS, type StreamName, type TableMode } from './tables'

export interface Region {
  start: number
  end: number
  kind: string
  label: string
}

export interface DecSeq {
  ll: number
  ml: number
  offset: number
  ofValue: number
  llCode: number
  mlCode: number
  ofCode: number
  /** −1 for a new offset, else which repeat slot (0 = rep1, 1 = rep2, 2 = rep3, 3 = rep1 − 1). */
  rep: number
  repsBefore: [number, number, number]
  repsAfter: [number, number, number]
  /** Where this sequence's literals start in the output. */
  outPos: number
}

export interface DecLiterals {
  type: 'raw' | 'RLE' | 'Huffman' | 'treeless'
  regenerated: number
  compressed: number
  streams: number
  huff?: HuffTable
  weightsVia?: 'direct' | 'FSE'
}

export interface DecBlock {
  type: 'raw' | 'RLE' | 'compressed'
  last: boolean
  start: number
  end: number
  outStart: number
  outEnd: number
  literals?: DecLiterals
  seqs?: DecSeq[]
  modes?: Record<StreamName, TableMode>
  tables?: Record<StreamName, FseTable>
  seqBits?: number
}

export interface DecFrame {
  single: boolean
  checksumFlag: boolean
  windowSize: number
  contentSize: number | null
  checksum?: { stored: number; computed: number; ok: boolean }
}

export interface DecodeResult {
  out: Uint8Array
  regions: Region[]
  blocks: DecBlock[]
  frames: DecFrame[]
}

const u32 = (d: Uint8Array, p: number) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0

const predefined: Partial<Record<StreamName, FseTable>> = {}
function defaultTable(s: StreamName): FseTable {
  return (predefined[s] ??= buildFse([...STREAMS[s].def], STREAMS[s].defLog))
}

export function decode(data: Uint8Array): DecodeResult {
  const out: number[] = []
  const regions: Region[] = []
  const blocks: DecBlock[] = []
  const frames: DecFrame[] = []
  const reg = (start: number, end: number, kind: string, label: string) => regions.push({ start, end, kind, label })
  let p = 0
  if (data.length === 0) throw new Error('zstd: empty input')
  while (p < data.length) {
    if (p + 4 > data.length) throw new Error('zstd: truncated frame')
    const magic = u32(data, p)
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      const size = u32(data, p + 4)
      reg(p, p + 8, 'magic', 'skippable frame header')
      reg(p + 8, p + 8 + size, 'raw', `skippable frame: ${size} bytes of user data`)
      p += 8 + size
      continue
    }
    if (magic !== MAGIC) throw new Error(`zstd: bad magic number 0x${magic.toString(16)}`)
    reg(p, p + 4, 'magic', 'magic number 0xFD2FB528 (little-endian)')
    p += 4
    p = decodeFrame(data, p, out, reg, blocks, frames)
  }
  return { out: Uint8Array.from(out), regions, blocks, frames }
}

function decodeFrame(
  d: Uint8Array,
  p: number,
  out: number[],
  reg: (s: number, e: number, k: string, l: string) => void,
  blocks: DecBlock[],
  frames: DecFrame[],
): number {
  const frameStart = out.length
  const fhd = d[p]
  const fcsFlag = fhd >> 6
  const single = ((fhd >> 5) & 1) === 1
  const checksumFlag = ((fhd >> 2) & 1) === 1
  const dictFlag = fhd & 3
  if (fhd & 8) throw new Error('zstd: reserved frame header bit set')
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  reg(p, p + 1, 'fhd', `frame header descriptor: content size in ${fcsBytes} byte${fcsBytes === 1 ? '' : 's'}, ${single ? 'single segment' : 'window descriptor follows'}, checksum ${checksumFlag ? 'on' : 'off'}`)
  p++
  let windowSize = 0
  if (!single) {
    const wd = d[p]
    const log = 10 + (wd >> 3)
    const base = 2 ** log
    windowSize = base + (base / 8) * (wd & 7)
    reg(p, p + 1, 'window', `window descriptor: ${windowSize} bytes`)
    p++
  }
  const dictBytes = [0, 1, 2, 4][dictFlag]
  if (dictBytes) {
    reg(p, p + dictBytes, 'dict', 'dictionary ID')
    p += dictBytes
  }
  let contentSize: number | null = null
  if (fcsBytes) {
    let v = 0
    for (let i = 0; i < fcsBytes; i++) v += d[p + i] * 2 ** (8 * i)
    if (fcsBytes === 2) v += 256
    contentSize = v
    reg(p, p + fcsBytes, 'fcs', `frame content size: ${v} bytes${fcsBytes === 2 ? ' (stored as size − 256)' : ''}`)
    p += fcsBytes
    if (single) windowSize = v
  }

  // State that lives across the blocks of one frame.
  const reps: [number, number, number] = [1, 4, 8]
  let prevHuff: HuffTable | null = null
  const prevTables: Partial<Record<StreamName, FseTable>> = {}

  for (;;) {
    if (p + 3 > d.length) throw new Error('zstd: truncated block header')
    const h = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)
    const last = (h & 1) === 1
    const type = (h >> 1) & 3
    const size = h >>> 3
    const names = ['raw', 'RLE', 'compressed', 'reserved'] as const
    reg(p, p + 3, 'blockhdr', `block header: ${last ? 'last ' : ''}${names[type]} block, ${size} bytes${type === 1 ? ' when expanded' : ''}`)
    p += 3
    const outStart = out.length
    const blk: DecBlock = { type: 'raw', last, start: p, end: p, outStart, outEnd: outStart }
    if (type === 0) {
      if (p + size > d.length) throw new Error('zstd: truncated raw block')
      for (let i = 0; i < size; i++) out.push(d[p + i])
      if (size) reg(p, p + size, 'raw', `${size} bytes stored as they are`)
      p += size
    } else if (type === 1) {
      for (let i = 0; i < size; i++) out.push(d[p])
      reg(p, p + 1, 'rle', `one byte, repeated ${size} times`)
      blk.type = 'RLE'
      p += 1
    } else if (type === 2) {
      blk.type = 'compressed'
      const end = p + size
      if (end > d.length) throw new Error('zstd: truncated compressed block')
      const r = decodeCompressedBlock(d, p, end, out, reps, prevHuff, prevTables, reg, blk)
      prevHuff = r.huff
      p = end
    } else throw new Error('zstd: reserved block type')
    blk.end = p
    blk.outEnd = out.length
    blocks.push(blk)
    if (last) break
  }

  const frame: DecFrame = { single, checksumFlag, windowSize, contentSize }
  if (contentSize !== null && out.length - frameStart !== contentSize) throw new Error(`zstd: frame says ${contentSize} bytes, decoded ${out.length - frameStart}`)
  if (checksumFlag) {
    const stored = u32(d, p)
    const computed = Number(xxh64(Uint8Array.from(out.slice(frameStart))) & 0xffffffffn)
    frame.checksum = { stored, computed, ok: stored === computed }
    reg(p, p + 4, 'checksum', `content checksum: low 32 bits of XXH64 = ${stored.toString(16).padStart(8, '0')}${stored === computed ? ' ✓' : ' ✗ mismatch'}`)
    if (stored !== computed) throw new Error('zstd: checksum mismatch')
    p += 4
  }
  frames.push(frame)
  return p
}

function decodeCompressedBlock(
  d: Uint8Array,
  start: number,
  end: number,
  out: number[],
  reps: [number, number, number],
  prevHuff: HuffTable | null,
  prevTables: Partial<Record<StreamName, FseTable>>,
  reg: (s: number, e: number, k: string, l: string) => void,
  blk: DecBlock,
): { huff: HuffTable | null } {
  // ---------------------------------------------------------- literals
  let q = start
  const b0 = d[q]
  const litType = b0 & 3
  const sf = (b0 >> 2) & 3
  let lits: number[] = []
  let huff = prevHuff
  if (litType <= 1) {
    let hs: number
    let regen: number
    if (sf === 0 || sf === 2) {
      hs = 1
      regen = b0 >> 3
    } else if (sf === 1) {
      hs = 2
      regen = (b0 >> 4) + (d[q + 1] << 4)
    } else {
      hs = 3
      regen = (b0 >> 4) + (d[q + 1] << 4) + (d[q + 2] << 12)
    }
    reg(q, q + hs, 'lithdr', `literals header: ${litType === 0 ? 'raw' : 'RLE'}, ${regen} literal${regen === 1 ? '' : 's'}`)
    q += hs
    if (litType === 0) {
      lits = Array.from(d.subarray(q, q + regen))
      if (regen) reg(q, q + regen, 'literals', `${regen} raw literal bytes`)
      q += regen
    } else {
      lits = new Array(regen).fill(d[q])
      reg(q, q + 1, 'literals', `the one literal byte, ×${regen}`)
      q += 1
    }
    blk.literals = { type: litType === 0 ? 'raw' : 'RLE', regenerated: regen, compressed: litType === 0 ? regen : 1, streams: 1 }
  } else {
    let hs: number
    let regen: number
    let comp: number
    const streams = sf === 0 ? 1 : 4
    if (sf <= 1) {
      hs = 3
      const v = d[q] | (d[q + 1] << 8) | (d[q + 2] << 16)
      regen = (v >> 4) & 1023
      comp = (v >> 14) & 1023
    } else if (sf === 2) {
      hs = 4
      const v = u32(d, q)
      regen = (v >>> 4) & 0x3fff
      comp = (v >>> 18) & 0x3fff
    } else {
      hs = 5
      const v = u32(d, q) + d[q + 4] * 2 ** 32
      regen = Math.floor(v / 16) & 0x3ffff
      comp = Math.floor(v / 2 ** 22) & 0x3ffff
    }
    const kind = litType === 2 ? 'Huffman' : 'treeless (reuses the previous Huffman table)'
    reg(q, q + hs, 'lithdr', `literals header: ${kind}, ${streams} stream${streams > 1 ? 's' : ''}, ${regen} literals in ${comp} bytes`)
    q += hs
    const litEnd = q + comp
    let weightsVia: 'direct' | 'FSE' | undefined
    if (litType === 2) {
      const r = readHuffDescription(d, q)
      huff = r.table
      weightsVia = r.via
      reg(q, q + r.bytes, 'huffdesc', `Huffman table: ${r.table.weights.filter((w) => w > 0).length} symbols, longest code ${r.table.maxBits} bits, weights ${r.via === 'direct' ? 'as 4-bit numbers' : 'FSE-compressed'}`)
      q += r.bytes
    } else if (!huff) throw new Error('zstd: treeless literals with no previous table')
    const h = huff!
    if (streams === 1) {
      reg(q, litEnd, 'huffstream', `Huffman stream: ${regen} literals, read backwards`)
      lits = decodeHuffStream(d, q, litEnd, regen, h)
    } else {
      const s1 = d[q] | (d[q + 1] << 8)
      const s2 = d[q + 2] | (d[q + 3] << 8)
      const s3 = d[q + 4] | (d[q + 5] << 8)
      reg(q, q + 6, 'jump', `jump table: streams of ${s1}, ${s2}, ${s3} bytes (the fourth gets the rest)`)
      let a = q + 6
      const seg = Math.floor((regen + 3) / 4)
      const sizes = [s1, s2, s3, litEnd - a - s1 - s2 - s3]
      if (sizes[3] < 0) throw new Error('zstd: bad jump table')
      for (let k = 0; k < 4; k++) {
        const n = k < 3 ? seg : regen - 3 * seg
        reg(a, a + sizes[k], 'huffstream', `Huffman stream ${k + 1} of 4: ${n} literals`)
        lits.push(...decodeHuffStream(d, a, a + sizes[k], n, h))
        a += sizes[k]
      }
    }
    q = litEnd
    blk.literals = { type: litType === 2 ? 'Huffman' : 'treeless', regenerated: regen, compressed: comp, streams, huff: h, weightsVia }
  }

  // --------------------------------------------------------- sequences
  const c0 = d[q]
  let nbSeq: number
  let cb: number
  if (c0 === 0) {
    nbSeq = 0
    cb = 1
  } else if (c0 < 128) {
    nbSeq = c0
    cb = 1
  } else if (c0 < 255) {
    nbSeq = ((c0 - 128) << 8) + d[q + 1]
    cb = 2
  } else {
    nbSeq = d[q + 1] + (d[q + 2] << 8) + 0x7f00
    cb = 3
  }
  reg(q, q + cb, 'seqcount', `${nbSeq} sequence${nbSeq === 1 ? '' : 's'}`)
  q += cb
  const seqs: DecSeq[] = []
  if (nbSeq > 0) {
    const modes = d[q]
    if (modes & 3) throw new Error('zstd: reserved bits in the compression modes')
    const m: Record<StreamName, TableMode> = {
      LL: MODE_NAMES[modes >> 6],
      OF: MODE_NAMES[(modes >> 4) & 3],
      ML: MODE_NAMES[(modes >> 2) & 3],
    }
    reg(q, q + 1, 'modes', `table modes: literal lengths ${m.LL}, offsets ${m.OF}, match lengths ${m.ML}`)
    q++
    const tables = {} as Record<StreamName, FseTable>
    for (const s of ['LL', 'OF', 'ML'] as StreamName[]) {
      const mode = m[s]
      if (mode === 'predefined') tables[s] = defaultTable(s)
      else if (mode === 'RLE') {
        tables[s] = rleTable(d[q])
        reg(q, q + 1, 'fsedesc', `${s}: every sequence uses code ${d[q]}`)
        q++
      } else if (mode === 'FSE') {
        const r = readNCount(d, q, STREAMS[s].maxSymbol, STREAMS[s].maxLog)
        tables[s] = buildFse(r.norm, r.log)
        reg(q, q + r.bytes, 'fsedesc', `${s} table: accuracy ${r.log} (${1 << r.log} states), ${r.norm.filter((x) => x !== 0).length} codes`)
        q += r.bytes
      } else {
        const t = prevTables[s]
        if (!t) throw new Error(`zstd: repeat mode for ${s} with no previous table`)
        tables[s] = t
      }
      prevTables[s] = tables[s]
    }
    blk.modes = m
    blk.tables = tables
    reg(q, end, 'seqstream', `sequences bitstream: ${nbSeq} × (literal length, offset, match length), read backwards`)
    const r = new BackReader(d, q, end)
    blk.seqBits = r.pos
    const LL = tables.LL
    const OF = tables.OF
    const ML = tables.ML
    let sLL = r.read(LL.log)
    let sOF = r.read(OF.log)
    let sML = r.read(ML.log)
    for (let i = 0; i < nbSeq; i++) {
      const llc = LL.cells[sLL].symbol
      const ofc = OF.cells[sOF].symbol
      const mlc = ML.cells[sML].symbol
      if (llc > 35 || mlc > 52 || ofc > 31) throw new Error('zstd: code out of range')
      const ofValue = 2 ** ofc + r.read(ofc)
      const ml = ML_BASE[mlc] + r.read(ML_BITS[mlc])
      const ll = LL_BASE[llc] + r.read(LL_BITS[llc])
      const before: [number, number, number] = [reps[0], reps[1], reps[2]]
      let offset: number
      let rep = -1
      if (ofValue > 3) {
        offset = ofValue - 3
        reps[2] = reps[1]
        reps[1] = reps[0]
        reps[0] = offset
      } else {
        rep = ofValue - 1 + (ll === 0 ? 1 : 0)
        if (rep === 0) offset = reps[0]
        else if (rep === 1) {
          offset = reps[1]
          reps[1] = reps[0]
          reps[0] = offset
        } else if (rep === 2) {
          offset = reps[2]
          reps[2] = reps[1]
          reps[1] = reps[0]
          reps[0] = offset
        } else {
          offset = reps[0] - 1
          if (offset === 0) throw new Error('zstd: repeat offset 1 − 1 = 0')
          reps[2] = reps[1]
          reps[1] = reps[0]
          reps[0] = offset
        }
      }
      seqs.push({ ll, ml, offset, ofValue, llCode: llc, mlCode: mlc, ofCode: ofc, rep, repsBefore: before, repsAfter: [reps[0], reps[1], reps[2]], outPos: 0 })
      if (i < nbSeq - 1) {
        const a = LL.cells[sLL]
        sLL = a.baseline + r.read(a.nbBits)
        const b = ML.cells[sML]
        sML = b.baseline + r.read(b.nbBits)
        const c = OF.cells[sOF]
        sOF = c.baseline + r.read(c.nbBits)
      }
    }
    if (r.pos !== 0) throw new Error(`zstd: sequences bitstream has ${r.pos} bits left over`)
  } else if (q !== end) throw new Error('zstd: bytes after an empty sequences section')

  // ---------------------------------------------------------- execute
  let lp = 0
  for (const s of seqs) {
    s.outPos = out.length
    if (lp + s.ll > lits.length) throw new Error('zstd: sequence wants more literals than the block has')
    for (let i = 0; i < s.ll; i++) out.push(lits[lp++])
    const from = out.length - s.offset
    if (from < 0) throw new Error('zstd: offset reaches before the start of the frame')
    for (let i = 0; i < s.ml; i++) out.push(out[from + i])
  }
  while (lp < lits.length) out.push(lits[lp++])
  blk.seqs = seqs
  return { huff }
}

export function readHuffDescription(d: Uint8Array, q: number): { table: HuffTable; bytes: number; via: 'direct' | 'FSE' } {
  const hb = d[q]
  let listed: number[]
  let bytes: number
  let via: 'direct' | 'FSE'
  if (hb >= 128) {
    const n = hb - 127
    listed = []
    for (let i = 0; i < n; i++) {
      const byte = d[q + 1 + (i >> 1)]
      listed.push(i & 1 ? byte & 15 : byte >> 4)
    }
    bytes = 1 + Math.ceil(n / 2)
    via = 'direct'
  } else {
    const r = readNCount(d, q + 1, 15, 6)
    const t = buildFse(r.norm, r.log)
    listed = decodeWeightsFse(d, q + 1 + r.bytes, q + 1 + hb, t)
    bytes = 1 + hb
    via = 'FSE'
  }
  return { table: huffFromWeights(completeWeights(listed)), bytes, via }
}

/** Two interleaved FSE states over one backward stream, until a read runs past the start. */
export function decodeWeightsFse(d: Uint8Array, start: number, end: number, t: FseTable): number[] {
  const r = new BackReader(d, start, end)
  let a = r.read(t.log)
  let b = r.read(t.log)
  const w: number[] = []
  for (;;) {
    let c = t.cells[a]
    w.push(c.symbol)
    a = c.baseline + r.read(c.nbBits)
    if (r.overflowed) {
      w.push(t.cells[b].symbol)
      break
    }
    c = t.cells[b]
    w.push(c.symbol)
    b = c.baseline + r.read(c.nbBits)
    if (r.overflowed) {
      w.push(t.cells[a].symbol)
      break
    }
    if (w.length > 255) throw new Error('zstd: too many Huffman weights')
  }
  return w
}

function decodeHuffStream(d: Uint8Array, start: number, end: number, n: number, h: HuffTable): number[] {
  const r = new BackReader(d, start, end)
  const lits = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const e = h.lookup[r.peek(h.maxBits)]
    lits[i] = e.symbol
    r.pos -= e.nbBits
  }
  if (r.pos !== 0) throw new Error(`zstd: Huffman stream has ${r.pos} bits left over`)
  return lits
}
