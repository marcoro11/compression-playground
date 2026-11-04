/**
 * LZ4 checks. There is no LZ4 package in this repo, so the oracle is the
 * reference C library itself, captured as fixtures: the frames and blocks
 * below were produced by liblz4 1.9.4 (LZ4F_compressFrame, LZ4_compress_default,
 * LZ4_compress_HC) and the XXH32 values are the content checksums liblz4 wrote
 * into frames. During development every block and frame this encoder produces
 * for the corpus was also decoded by liblz4's LZ4_decompress_safe.
 *
 * The rest is the specification worked by hand, and a second decoder written
 * here from lz4_Block_format.md without looking at lz4.ts.
 */
import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus, randomBytes, seeded } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import {
  LASTLITERALS,
  MAX_OFFSET,
  MFLIMIT,
  compressBlock,
  compressFrame,
  decompressBlock,
  decompressBlockFast,
  decompressFrame,
  endRulesHold,
  flgByte,
  headerChecksum,
  serialize,
  xxh32,
  type Sequence,
} from './lz4'

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g) ?? [], (h) => parseInt(h, 16))
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'))

/** Independent decoder, straight from the block format document. */
function naiveDecode(src: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  for (;;) {
    const token = src[i++]
    let lit = token >> 4
    if (lit === 15) for (let b = 255; b === 255; ) lit += b = src[i++]
    for (let k = 0; k < lit; k++) out.push(src[i++])
    if (i >= src.length) break
    const off = src[i] + 256 * src[i + 1]
    i += 2
    let len = (token & 15) + 4
    if ((token & 15) === 15) for (let b = 255; b === 255; ) len += b = src[i++]
    const from = out.length - off
    if (from < 0) throw new Error('naive: offset out of range')
    for (let k = 0; k < len; k++) out.push(out[from + k])
  }
  return Uint8Array.from(out)
}

const seq = (litStart: number, litLen: number, offset = 0, matchLen = 0): Sequence => ({ litStart, litLen, offset, matchLen, probes: 0, backtrack: 0 })
const repeat = (b: number, n: number) => new Uint8Array(n).fill(b)
const cat = (...a: ArrayLike<number>[]) => Uint8Array.from(a.flatMap((x) => Array.from(x)))

// liblz4 1.9.4 output for this sentence (170 bytes).
const SENTENCE =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity.'
const LIBLZ4_DEFAULT =
  'f60c497420776173207468652062657374206f662074696d65732c20691a003f776f721b000530616765340069776973646f6d3500031a00aa666f6f6c6973686e657354005065706f63683b006962656c6965663b00051c00c0696e63726564756c6974792e'
const LIBLZ4_HC9 =
  'f60c497420776173207468652062657374206f662074696d65732c20691a003f776f721b00053061676519006f776973646f6d1a0001aa666f6f6c6973686e657339005065706f636821006f62656c6965661c0003c0696e63726564756c6974792e'

// liblz4 frame: linked 64 KiB blocks, block checksums, content size, content checksum.
const LINKED_FRAME = 'BCJNGFxAKGICAAAAAACcwwEAAP8+cm93IDAwOiBsejQgbGlua3MgYmxvY2tzIHNvIGEgbWF0Y2ggbWF5IHJlYWNoIGJhY2sgYWNyb3NzIHRoZSBib3VuZGFyeQpyb3cgMDFHADMfMo4AMx8zRwAzHzRHADMfNUcAMx82RwAzHzdHADMfOEcAMx85RwAyHzHGAjMfMcYCMx8xxgIzHzHGAjMfMcYCMx8xxgIzHzHGAjQP8QEzHzDxATMfMPEBMx8w8QEzHzDxATMfMPEBMx8w8QE0D7cE/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////zVQeQpyb3dicRDrCgEAAA/j+f/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////oUG93IDEwhLhmfCgBAAD/ODogbHo0IGxpbmtzIGJsb2NrcyBzbyBhIG1hdGNoIG1heSByZWFjaCBiYWNrIGFjcm9zcyB0aGUgYm91bmRhcnkKcm93IDExRwAzHzKOADMfM0cAMx80RwAzHzVHADMfNkcAMi8wMEcAMw/xATMfMPEBMx8w8QEzHzDxATMfMPEBMx8w8QE0HzfxATMfOEcAMx85RwAyHzHGAjMfMcYCMx8xxgIzHzHGAjMfMcYCMx8xxgIzHzHGAjQP8QEzHzDxATMPtwT/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////N1BkYXJ5CkXWMAsAAAAAtJ1vcg=='
const linkedInput = () => {
  let s = ''
  for (let i = 0; i < 2200; i++) s += `row ${String(i % 17).padStart(2, '0')}: lz4 links blocks so a match may reach back across the boundary\n`
  return utf8(s)
}

export const checks: Check[] = [
  {
    name: 'XXH32 equals the checksums liblz4 wrote: "", "abc", a 39-byte string, 768 bytes',
    run() {
      eq(xxh32(new Uint8Array(0)).toString(16), '2cc5d05')
      eq(xxh32(utf8('abc')).toString(16), '32d153ff')
      eq(xxh32(utf8('Nobody inspects the spammish repetition')).toString(16), 'e2293b2f')
      const r = new Uint8Array(768).map((_, i) => i & 255)
      eq(xxh32(r).toString(16), 'cdb946b1')
    },
  },
  {
    name: 'frame header: FLG bits assembled by hand, header checksums as liblz4 writes them',
    run() {
      // FLG = version(2) | B.Indep | B.Checksum | C.Size | C.Checksum | reserved | DictID
      const byHand = (indep: number, bsum: number, csize: number, csum: number) => (0b01 << 6) | (indep << 5) | (bsum << 4) | (csize << 3) | (csum << 2)
      eq(flgByte({ independent: true, blockChecksum: false, contentSize: false, contentChecksum: true }), byHand(1, 0, 0, 1))
      eq(byHand(1, 0, 0, 1), 0x64)
      eq(byHand(0, 1, 1, 1), 0x5c)
      // (descriptor) → HC, each pair taken from a liblz4 frame header
      eq(headerChecksum(hex('6440')), 0xa7)
      eq(headerChecksum(hex('6040')), 0x82)
      eq(headerChecksum(hex('7440')), 0xbd)
      eq(headerChecksum(hex('6c40 0500000000000000')), 0x2c)
      bytesEq(compressFrame(new Uint8Array(0)).bytes.subarray(0, 7), hex('04224d18 6440 a7'), 'empty frame header')
    },
  },
  {
    name: 'hand-worked blocks decode as the spec says (overlap copy, 255-runs, the 15+255+0 edge)',
    run() {
      // 46: 4 literals, match 6+4 = 10 · "abcd" · offset 4 · then 50: 5 literals "XYZ12"
      // the copy overlaps itself: 10 bytes from 4 back → "abcdab" repeats as it is written
      bytesEq(naiveDecode(hex('46 61626364 0400 50 58595a3132')), utf8('abcdabcdabcdabXYZ12'))
      bytesEq(Uint8Array.from(decompressBlock(hex('46 61626364 0400 50 58595a3132'))), utf8('abcdabcdabcdabXYZ12'))
      // 300 literals: nibble 15, then 285 = 255 + 30 → FF 1E
      const lits = randomBytes(300, 4)
      bytesEq(Uint8Array.from(decompressBlock(cat([0xf0, 0xff, 0x1e], lits))), lits)
      // exactly 270 = 15 + 255 + 0 literals: the run must still end with a 0 byte
      const l270 = randomBytes(270, 5)
      bytesEq(Uint8Array.from(decompressBlock(cat([0xf0, 0xff, 0x00], l270))), l270)
      // 'a', then a match of 4 + 15 + 255 + 10 = 284 at offset 1 → 285 a's, then 5 literals
      const blk = cat([0x1f, 0x61, 0x01, 0x00, 0xff, 0x0a, 0x50], utf8('bcdef'))
      bytesEq(Uint8Array.from(decompressBlock(blk)), cat(repeat(0x61, 285), utf8('bcdef')))
      bytesEq(naiveDecode(blk), cat(repeat(0x61, 285), utf8('bcdef')))
    },
  },
  {
    name: 'serialising hand-chosen sequences gives exactly those hand-written bytes',
    run() {
      const a = utf8('abcdabcdabcdabXYZ12')
      bytesEq(serialize(a, [seq(0, 4, 4, 10), seq(14, 5)]).bytes, hex('46 61626364 0400 50 58595a3132'))
      const l300 = randomBytes(300, 4)
      bytesEq(serialize(l300, [seq(0, 300)]).bytes, cat([0xf0, 0xff, 0x1e], l300))
      const l270 = randomBytes(270, 5)
      bytesEq(serialize(l270, [seq(0, 270)]).bytes, cat([0xf0, 0xff, 0x00], l270))
      const run = cat(repeat(0x61, 285), utf8('bcdef'))
      bytesEq(serialize(run, [seq(0, 1, 1, 284), seq(285, 5)]).bytes, cat([0x1f, 0x61, 0x01, 0x00, 0xff, 0x0a, 0x50], utf8('bcdef')))
    },
  },
  {
    name: "the fast encoder's parse of 40×'a' + 'bcdef', derived by hand",
    run() {
      // ip=1 hashes the same 4 bytes as 0 → offset 1; extends to matchLimit = 45 − 5 = 40 → 39 bytes.
      // token (1 literal, 39 − 4 = 35 → 15 + ext 20) = 1F · 'a' · 01 00 · 14 · then 50 'bcdef'
      const d = cat(repeat(0x61, 40), utf8('bcdef'))
      bytesEq(compressBlock(d).bytes, cat([0x1f, 0x61, 0x01, 0x00, 0x14, 0x50], utf8('bcdef')))
      // under 13 bytes nothing is ever matched: one literals-only sequence
      bytesEq(compressBlock(utf8('aaaaaaaaaaaa')).bytes, cat([0xc0], utf8('aaaaaaaaaaaa')))
      bytesEq(compressBlock(new Uint8Array(0)).bytes, hex('00'))
    },
  },
  {
    name: 'liblz4 1.9.4 blocks (default and HC level 9) decode here and in the naive decoder',
    run() {
      for (const h of [LIBLZ4_DEFAULT, LIBLZ4_HC9]) {
        bytesEq(Uint8Array.from(decompressBlock(hex(h))), utf8(SENTENCE))
        bytesEq(naiveDecode(hex(h)), utf8(SENTENCE))
      }
      // Our encoder on the same sentence lands within a few bytes of liblz4's default.
      const ours = compressBlock(utf8(SENTENCE)).bytes.length
      ok(Math.abs(ours - hex(LIBLZ4_DEFAULT).length) <= 6, `ours ${ours} vs liblz4 ${hex(LIBLZ4_DEFAULT).length}`)
    },
  },
  {
    name: 'a liblz4 frame with linked blocks, block checksums and content size decodes (and needs the link)',
    run() {
      const f = b64(LINKED_FRAME)
      const { out, independent, fields } = decompressFrame(f)
      eq(independent, false)
      bytesEq(out, linkedInput())
      // Decoding the second block on its own must fail: its first match reaches into block 0.
      const blocks = fields.filter((x) => x.kind === 'block')
      ok(blocks.length >= 2, 'expected several blocks')
      let threw = false
      try {
        decompressBlock(f.subarray(blocks[1].start, blocks[1].start + blocks[1].len))
      } catch {
        threw = true
      }
      ok(threw, 'block 1 decoded without block 0 — the fixture does not exercise linking')
      // Corrupt the content checksum → rejected.
      const bad = f.slice()
      bad[bad.length - 1] ^= 1
      let rejected = false
      try {
        decompressFrame(bad)
      } catch {
        rejected = true
      }
      ok(rejected, 'checksum mismatch not detected')
    },
  },
  {
    name: 'every encoded block obeys the end-of-block rules and decodes with the naive decoder',
    run() {
      for (const { id, data } of corpus()) {
        for (const mode of ['fast', 'hc'] as const) {
          for (let b = 0; b < data.length || b === 0; b += 65536) {
            const chunk = data.subarray(b, Math.min(data.length, b + 65536))
            const r = compressBlock(chunk, { mode })
            ok(endRulesHold(chunk.length, r.seqs), `${id}/${mode}: end rules broken`)
            if (chunk.length > MFLIMIT) ok(r.seqs[r.seqs.length - 1].litLen >= LASTLITERALS, `${id}: fewer than 5 final literals`)
            bytesEq(naiveDecode(r.bytes), chunk, `${id}/${mode}`)
            if (!chunk.length) break
          }
        }
      }
    },
  },
  {
    name: 'offsets reach 65 535 and never further; frames round-trip with every option',
    run() {
      // 70 000 random bytes with the first 200 copied to position 65 500 → a match 65 500 back.
      const d = randomBytes(70000, 21)
      d.set(d.subarray(0, 200), 65500)
      const hc = compressBlock(d, { mode: 'hc', depth: 4096 })
      const far = Math.max(...hc.seqs.map((s) => s.offset))
      ok(far >= 65000 && far <= MAX_OFFSET, `longest offset ${far}`)
      bytesEq(Uint8Array.from(decompressBlock(hc.bytes)), d)
      // a copy exactly 65 535 back
      const e = randomBytes(65600, 22)
      e.set(e.subarray(0, 40), 65535)
      const r = compressBlock(e, { mode: 'hc', depth: 4096 })
      ok(r.seqs.some((s) => s.offset === 65535), 'no offset of exactly 65 535')
      bytesEq(naiveDecode(r.bytes), e)
      const rnd = seeded(8)
      for (const { data } of corpus()) {
        const opts = { mode: rnd() < 0.5 ? ('fast' as const) : ('hc' as const), blockSizeId: (4 + Math.floor(rnd() * 4)) as 4 | 5 | 6 | 7, contentChecksum: rnd() < 0.5, blockChecksum: rnd() < 0.5, contentSize: rnd() < 0.5, acceleration: 1 + Math.floor(rnd() * 8) }
        bytesEq(decompressFrame(compressFrame(data, opts).bytes).out, data)
      }
    },
  },
  {
    name: 'the bulk-copy fast decoder agrees with the byte-by-byte one (overlaps of every offset 1–20)',
    run() {
      for (let off = 1; off <= 20; off++) {
        // off literals, then a 100-byte copy from `off` back, then 5 literals
        const lits = randomBytes(off, off)
        const blk = cat([(Math.min(off, 15) << 4) | 15], off >= 15 ? [off - 15] : [], lits, [off, 0, 100 - 4 - 15], [0x50], utf8('vwxyz'))
        bytesEq(decompressBlockFast(blk, 8), Uint8Array.from(decompressBlock(blk)), `offset ${off}`)
        bytesEq(decompressBlockFast(blk), naiveDecode(blk), `offset ${off}`)
      }
      for (const { id, data } of corpus()) {
        const b = compressBlock(data.subarray(0, 65536)).bytes
        bytesEq(decompressBlockFast(b, 1), Uint8Array.from(decompressBlock(b)), id)
      }
    },
  },
]
