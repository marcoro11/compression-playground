import * as zlib from 'node:zlib'
import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { adler32, crc32 } from './checksum'
import { gunzip, unzlib, wrap } from './container'
import { deflate, deflateRaw, rleLengths, type BlockChoice } from './encoder'
import { findTokens } from './matcher'
import { inflate } from './inflate'
import { distCode, lengthCode } from './tables'

const data = corpus()
const u8 = (b: Buffer | Uint8Array) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

export const checks: Check[] = [
  {
    name: 'CRC-32 of "123456789" is 0xCBF43926, and matches zlib.crc32 on the corpus',
    run() {
      eq(crc32(utf8('123456789')), 0xcbf43926)
      for (const { id, data: d } of data) eq(crc32(d), zlib.crc32(d) >>> 0, id)
    },
  },
  {
    name: 'Adler-32 of "Wikipedia" is 0x11E60398',
    run() {
      eq(adler32(utf8('Wikipedia')), 0x11e60398)
      eq(adler32(new Uint8Array(0)), 1)
    },
  },
  {
    name: 'length and distance buckets match RFC 1951 §3.2.5',
    run() {
      eq([3, 10, 11, 12, 13, 257, 258].map((l) => lengthCode(l).code), [257, 264, 265, 265, 266, 284, 285])
      eq(lengthCode(12).extra, 1)
      eq([1, 4, 5, 6, 7, 24577, 32768].map((d) => distCode(d).code), [0, 3, 4, 4, 5, 29, 29])
      eq(distCode(32768).extra, 8191)
    },
  },
  {
    name: 'a run of one byte becomes one literal and an overlapping copy at distance 1',
    run() {
      const t = findTokens(utf8('aaaaaaaaaa'))
      eq(t.map((x) => (x.kind === 'lit' ? 'L' : `M${x.length}@${x.dist}`)), ['L', 'M9@1'])
    },
  },
  {
    name: 'code-length RLE uses 16/17/18 correctly and covers the list exactly',
    run() {
      const L = [8, 8, 8, 8, 8, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 9]
      const seq = rleLengths(L)
      const expanded: number[] = []
      for (const c of seq) for (let k = 0; k < c.covers; k++) expanded.push(c.value)
      eq(expanded, L)
      // eight 8s: one literal 8, a 16 covering six repeats, one more literal 8; then 14 zeros → a single 18
      eq(seq.map((c) => [c.sym, c.covers]), [[8, 1], [16, 6], [8, 1], [18, 14], [5, 1], [0, 1], [0, 1], [9, 1]])
      eq(rleLengths(new Array(150).fill(0)).map((c) => [c.sym, c.covers]), [
        [18, 138],
        [18, 12],
      ])
    },
  },
  ...(['stored', 'fixed', 'dynamic', 'auto'] as BlockChoice[]).map(
    (block): Check => ({
      name: `zlib.inflateRawSync accepts our ${block} output over the corpus`,
      run() {
        for (const { id, data: d } of data) {
          const raw = deflateRaw(d, { block })
          bytesEq(u8(zlib.inflateRawSync(raw)), d, `${block}/${id}`)
        }
      },
    }),
  ),
  {
    name: 'zlib accepts our output with lazy matching off and with many small blocks',
    run() {
      for (const { id, data: d } of data) {
        bytesEq(u8(zlib.inflateRawSync(deflateRaw(d, { lazy: false }))), d, `greedy/${id}`)
        bytesEq(u8(zlib.inflateRawSync(deflateRaw(d, { blockTokens: 50, block: 'auto' }))), d, `blocks/${id}`)
        bytesEq(u8(zlib.inflateRawSync(deflateRaw(d, { blockTokens: 37, block: 'dynamic' }))), d, `dyn-blocks/${id}`)
      }
    },
  },
  {
    name: 'our inflate decodes zlib at levels 0, 1, 6, 9 and strategies HUFFMAN_ONLY, RLE, FIXED',
    run() {
      const opts: zlib.ZlibOptions[] = [
        { level: 0 },
        { level: 1 },
        { level: 6 },
        { level: 9 },
        { strategy: zlib.constants.Z_HUFFMAN_ONLY },
        { strategy: zlib.constants.Z_RLE },
        { strategy: zlib.constants.Z_FIXED },
        { level: 9, memLevel: 1, windowBits: 9 },
      ]
      for (const o of opts) for (const { id, data: d } of data) bytesEq(inflate(u8(zlib.deflateRawSync(d, o))).out, d, `${JSON.stringify(o)}/${id}`)
    },
  },
  {
    name: 'gzip and zlib envelopes: zlib.gunzipSync / inflateSync accept ours, and ours accept theirs',
    run() {
      for (const { id, data: d } of data) {
        const raw = deflateRaw(d)
        bytesEq(u8(zlib.gunzipSync(wrap('gzip', raw, d).bytes)), d, `gunzipSync/${id}`)
        bytesEq(u8(zlib.inflateSync(wrap('zlib', raw, d).bytes)), d, `inflateSync/${id}`)
        bytesEq(gunzip(u8(zlib.gzipSync(d))), d, `our gunzip/${id}`)
        bytesEq(unzlib(u8(zlib.deflateSync(d))), d, `our unzlib/${id}`)
      }
    },
  },
  {
    name: 'inflate rejects corrupt streams instead of returning garbage',
    run() {
      const d = utf8('hello hello hello hello')
      const g = wrap('gzip', deflateRaw(d), d).bytes
      const bad = g.slice()
      bad[bad.length - 6] ^= 1 // flip a CRC bit
      let threw = false
      try {
        gunzip(bad)
      } catch {
        threw = true
      }
      ok(threw, 'CRC mismatch not detected')
      threw = false
      try {
        inflate(Uint8Array.from([0x07])) // BTYPE 11
      } catch {
        threw = true
      }
      ok(threw, 'reserved block type not rejected')
    },
  },
  {
    name: 'the decoder independently finds the same field boundaries the encoder labelled',
    run() {
      for (const id of ['prose', 'json', 'runs', 'tobe', 'random', 'empty', 'one']) {
        const d = data.find((x) => x.id === id)!.data
        for (const block of ['stored', 'fixed', 'dynamic'] as const) {
          const enc = deflate(d, { block, record: true })
          const dec = inflate(enc.bytes, { trace: true })
          const a = enc.spans.filter((s) => s.kind !== 'pad').map((s) => `${s.start}+${s.length}:${s.kind}`)
          const b = dec.trace.filter((s) => s.kind !== 'pad').map((s) => `${s.start}+${s.length}:${s.kind === 'dist' || s.kind === 'distextra' ? s.kind : s.kind}`)
          eq(b, a, `${block}/${id}`)
        }
      }
    },
  },
  {
    name: 'dynamic output on 13 KB of prose is within 15% of zlib level 6',
    run() {
      const d = data.find((x) => x.id === 'prose-x40')!.data
      const ours = deflateRaw(d).length
      const theirs = zlib.deflateRawSync(d, { level: 6 }).length
      ok(ours <= theirs * 1.15, `ours ${ours} vs zlib ${theirs}`)
      const mixed = data.find((x) => x.id === 'mixed-40k')!.data
      const o2 = deflateRaw(mixed).length
      const t2 = zlib.deflateRawSync(mixed, { level: 6 }).length
      ok(o2 <= t2 * 1.15, `mixed: ours ${o2} vs zlib ${t2}`)
    },
  },
  {
    name: 'empty input encodes as the canonical 2-byte fixed block 03 00',
    run() {
      eq(Array.from(deflateRaw(new Uint8Array(0))), [0x03, 0x00])
    },
  },
]
