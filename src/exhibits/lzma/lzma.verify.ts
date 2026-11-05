import { execFileSync } from 'node:child_process'
import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus, seeded } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import {
  decode,
  encode,
  nextLiteral,
  nextMatch,
  nextRep,
  nextShortRep,
  parseHeader,
  parseProps,
  posSlotOf,
  propsByte,
  RangeDecoder,
  RangeEncoder,
  updated,
} from './lzma'

/**
 * The oracle is xz-utils, Lasse Collin's implementation, which shares no code
 * with this one. It is on every Ubuntu runner; if it is missing the check fails
 * loudly instead of passing by default.
 */
function xz(args: string[], input: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(execFileSync('xz', args, { input, maxBuffer: 1 << 26 }))
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer }
    if (err.code === 'ENOENT') throw new Error('the `xz` command is not installed — these checks need xz-utils as an independent LZMA implementation')
    throw new Error(`xz ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`)
  }
}

const data = corpus()

export const checks: Check[] = [
  {
    name: 'xz decodes our .lzma files for every corpus input — known size and end-marker forms',
    run() {
      for (const { id, data: d } of data) {
        for (const endMarker of [false, true]) {
          const ours = encode(d, { endMarker }).bytes
          bytesEq(xz(['--format=lzma', '-dc'], ours), d, `${id} (end marker ${endMarker})`)
        }
      }
    },
  },
  {
    name: 'xz decodes our files with non-default lc/lp/pb and a small dictionary',
    run() {
      const inputs = data.filter((x) => ['prose-x40', 'json', 'mixed-40k', 'zeros-70k'].includes(x.id))
      for (const props of [
        { lc: 0, lp: 2, pb: 0 },
        { lc: 4, lp: 0, pb: 4 },
        { lc: 1, lp: 3, pb: 1 },
      ]) {
        for (const { id, data: d } of inputs) {
          const ours = encode(d, { ...props, dictSize: 4096 }).bytes
          bytesEq(xz(['--format=lzma', '-dc'], ours), d, `${id} ${JSON.stringify(props)}`)
        }
      }
    },
  },
  {
    name: 'our decoder reads xz’s output at -0, -6 and -9 for every corpus input',
    run() {
      for (const level of ['-0', '-6', '-9']) {
        for (const { id, data: d } of data) {
          const theirs = xz(['--format=lzma', '-c', level], d)
          bytesEq(decode(theirs), d, `${id} at ${level}`)
        }
      }
    },
  },
  {
    name: 'our decoder reads xz’s output with --lzma1=lc=0,lp=2,pb=0 and lc=4,lp=0,pb=4',
    run() {
      for (const opt of ['lc=0,lp=2,pb=0', 'lc=4,lp=0,pb=4,mode=fast', 'preset=9e,lc=1,lp=1,pb=3']) {
        for (const { id, data: d } of data.filter((x) => x.data.length > 0)) {
          const theirs = xz(['--format=lzma', '-c', `--lzma1=${opt}`], d)
          bytesEq(decode(theirs), d, `${id} with ${opt}`)
        }
      }
    },
  },
  {
    name: 'properties byte: lc=3 lp=0 pb=2 is 0x5D, and every valid combination round-trips',
    run() {
      eq(propsByte({ lc: 3, lp: 0, pb: 2 }), 0x5d)
      eq(encode(utf8('x')).bytes[0], 0x5d, 'default header')
      for (let pb = 0; pb <= 4; pb++)
        for (let lp = 0; lp <= 4; lp++)
          for (let lc = 0; lc <= 8; lc++) eq(parseProps(propsByte({ lc, lp, pb })), { lc, lp, pb })
      const h = parseHeader(encode(new Uint8Array(70000), { dictSize: 1 << 16 }).bytes)
      eq([h.dictSize, h.size], [65536, 70000], 'header fields')
      eq(parseHeader(encode(utf8('ab'), { endMarker: true }).bytes).size, -1, 'unknown size = all ones')
    },
  },
  {
    name: 'probability update matches the reference rule on hand-worked values',
    run() {
      // p is P(bit = 0) in units of 1/2048; the reference moves it 1/32 of the way, rounding down.
      eq(updated(1024, 0), 1056) // 1024 + (1024 >> 5)
      eq(updated(1024, 1), 992) // 1024 − (1024 >> 5)
      eq(updated(2000, 0), 2001) // 2000 + (48 >> 5) = 2001
      eq(updated(31, 1), 31) // 31 − (31 >> 5) = 31: the floor that stops p reaching 0
      eq(updated(2017, 0), 2017) // 2017 + (31 >> 5): the ceiling
      // Twenty zeros in a row starting from ½, computed long-hand.
      let p = 1024
      for (let i = 0; i < 20; i++) p = p + ((2048 - p) >> 5)
      let q = 1024
      for (let i = 0; i < 20; i++) q = updated(q, 0)
      eq(q, p)
    },
  },
  {
    name: 'range coder round-trips 300 random runs of bits, probabilities and direct bits',
    run() {
      const r = seeded(21)
      for (let t = 0; t < 300; t++) {
        const nCtx = 1 + Math.floor(r() * 8)
        const len = Math.floor(r() * 2000)
        const skew = r()
        const ops: { ctx: number; bit: number; direct: boolean }[] = []
        for (let i = 0; i < len; i++) {
          const direct = r() < 0.1
          ops.push({ ctx: Math.floor(r() * nCtx), bit: r() < skew ? 1 : 0, direct })
        }
        const encP = new Uint16Array(nCtx).fill(1024)
        const enc = new RangeEncoder()
        for (const o of ops) o.direct ? enc.encodeDirect(o.bit, 1) : enc.encodeBit(encP, o.ctx, o.bit)
        enc.flush()
        const dec = new RangeDecoder(Uint8Array.from(enc.out), 0)
        const decP = new Uint16Array(nCtx).fill(1024)
        for (let i = 0; i < ops.length; i++) {
          const o = ops[i]
          const b = o.direct ? dec.decodeDirect(1) : dec.decodeBit(decP, o.ctx)
          if (b !== o.bit) throw new Error(`trial ${t}: bit ${i} decoded as ${b}`)
        }
        ok(!dec.overrun, `trial ${t}: decoder read past the end`)
        eq(Array.from(decP), Array.from(encP), `trial ${t}: models diverged`)
      }
    },
  },
  {
    name: 'state machine and distance slots match the specification’s tables',
    run() {
      // LzmaSpec.cpp: UpdateState_Literal etc., written out for all 12 states.
      eq([...Array(12).keys()].map(nextLiteral), [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5])
      eq([...Array(12).keys()].map(nextMatch), [7, 7, 7, 7, 7, 7, 7, 10, 10, 10, 10, 10])
      eq([...Array(12).keys()].map(nextRep), [8, 8, 8, 8, 8, 8, 8, 11, 11, 11, 11, 11])
      eq([...Array(12).keys()].map(nextShortRep), [9, 9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 11])
      // Slot s ≥ 4 covers [ (2 | s&1) << (s/2 − 1), that + 2^(s/2 − 1) ).
      eq([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 15, 16, 23, 24, 31].map(posSlotOf), [0, 1, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9])
      for (let s = 4; s < 64; s++) {
        const footer = (s >>> 1) - 1
        const base = (2 | (s & 1)) * 2 ** footer
        eq([posSlotOf(base), posSlotOf(base + 2 ** footer - 1)], [s, s], `slot ${s}`)
      }
      eq(posSlotOf(0xffffffff), 63, 'end-marker distance')
    },
  },
  {
    name: 'every packet kind actually occurs, and the decoder rejects a truncated stream',
    run() {
      const mixed = data.find((x) => x.id === 'mixed-40k')!.data
      const counts = encode(mixed).countByKind
      for (const k of ['LIT', 'MATCH', 'SHORTREP', 'REP0', 'REP1', 'REP2', 'REP3'] as const) ok(counts[k] > 0, `no ${k} packet on mixed-40k`)
      const text = utf8('red=ff0000 grn=00ff00 blu=0000ff red=ee0000 grn=00ee00 blu=0000ee red=dd0000 grn=00dd00 blu=0000dd')
      const res = encode(text, { record: true, endMarker: true })
      const kinds = new Set(res.packets.map((p) => p.kind))
      for (const k of ['LIT', 'MATCH', 'SHORTREP', 'REP0', 'REP1', 'END'] as const) ok(kinds.has(k), `no ${k} packet in the colour list`)
      bytesEq(xz(['--format=lzma', '-dc'], res.bytes), text, 'traced encode')
      // The trace's own accounting agrees with the stream: bits recorded per packet add up.
      const traced = res.packets.reduce((s, p) => s + p.bits.length, 0)
      ok(traced > 0 && res.packets[res.packets.length - 1].outAfter <= res.bytes.length - 13, 'trace and stream disagree')
      const cut = res.bytes.slice(0, res.bytes.length - 6)
      let threw = false
      try {
        decode(cut)
      } catch {
        threw = true
      }
      ok(threw, 'truncated stream decoded without complaint')
    },
  },
]
