import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { bytesEq, eq, ok, type Check } from '../../lib/check'
import { corpus } from '../../lib/samples'
import { utf8 } from '../../lib/text'
import { buildFse, readNCount, writeNCount, xxh64, BitWriter, normalize } from './core'
import { decode } from './decoder'
import { applyRep, encode, offsetValue, repSlot, type EncodeOptions } from './encoder'
import { LL_DEFAULT, LL_DEFAULT_LOG, ML_DEFAULT, ML_DEFAULT_LOG, OF_DEFAULT, OF_DEFAULT_LOG } from './tables'

const data = corpus()

function nodeAccepts(opts: EncodeOptions) {
  for (const { id, data: input } of data) {
    const ours = encode(input, opts).bytes
    let back: Uint8Array
    try {
      back = new Uint8Array(zstdDecompressSync(ours))
    } catch (e) {
      throw new Error(`${id}: Node's zstd rejected our frame — ${(e as Error).message}`)
    }
    bytesEq(back, input, id)
  }
}

export const checks: Check[] = [
  {
    name: 'XXH64 matches the published vectors ("" → EF46DB3751D8E999, "abc" → 44BC2CF5AD770999)',
    run() {
      eq(xxh64(new Uint8Array(0)).toString(16), 'ef46db3751d8e999')
      eq(xxh64(utf8('abc')).toString(16), '44bc2cf5ad770999')
    },
  },
  {
    name: 'predefined distributions sum to 2^accuracy and build the RFC appendix A tables',
    run() {
      const sum = (a: number[]) => a.reduce((t, x) => t + Math.abs(x), 0)
      eq(sum(LL_DEFAULT), 64, 'LL')
      eq(sum(ML_DEFAULT), 64, 'ML')
      eq(sum(OF_DEFAULT), 32, 'OF')
      // RFC 8878 Appendix A: state → (symbol, nbBits, base).
      const ll = buildFse(LL_DEFAULT, LL_DEFAULT_LOG).cells
      eq([ll[0].symbol, ll[0].nbBits, ll[0].baseline], [0, 4, 0], 'LL state 0')
      eq([ll[1].symbol, ll[1].nbBits, ll[1].baseline], [0, 4, 16], 'LL state 1')
      eq([ll[2].symbol, ll[2].nbBits, ll[2].baseline], [1, 5, 32], 'LL state 2')
      eq([ll[63].symbol, ll[63].nbBits, ll[63].baseline], [32, 6, 0], 'LL state 63')
      const ml = buildFse(ML_DEFAULT, ML_DEFAULT_LOG).cells
      eq([ml[0].symbol, ml[0].nbBits, ml[0].baseline], [0, 6, 0], 'ML state 0')
      eq([ml[1].symbol, ml[1].nbBits, ml[1].baseline], [1, 4, 0], 'ML state 1')
      eq([ml[63].symbol, ml[63].nbBits, ml[63].baseline], [46, 6, 0], 'ML state 63')
      const of = buildFse(OF_DEFAULT, OF_DEFAULT_LOG).cells
      eq([of[0].symbol, of[0].nbBits, of[0].baseline], [0, 5, 0], 'OF state 0')
      eq([of[1].symbol, of[1].nbBits, of[1].baseline], [6, 4, 0], 'OF state 1')
      eq([of[31].symbol, of[31].nbBits, of[31].baseline], [24, 5, 0], 'OF state 31')
    },
  },
  {
    name: 'FSE count descriptions survive write → read for 500 random distributions',
    run() {
      let seed = 7
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
      for (let t = 0; t < 500; t++) {
        const log = 5 + Math.floor(rnd() * 5)
        const n = 2 + Math.floor(rnd() * 40)
        const counts = Array.from({ length: n }, () => (rnd() < 0.3 ? 0 : Math.floor(rnd() ** 3 * 1000) + 1))
        if (counts.filter((c) => c > 0).length < 2 || counts.filter((c) => c > 0).length > 1 << log) continue
        const norm = normalize(counts, log)
        const w = new BitWriter('lsb')
        writeNCount(w, norm, log)
        w.align()
        const back = readNCount(w.finish(), 0, 255, 9)
        let last = norm.length - 1
        while (norm[last] === 0) last--
        eq(back.log, log)
        eq(back.norm.slice(0, last + 1), norm.slice(0, last + 1), `trial ${t}`)
      }
    },
  },
  {
    name: 'repeat offsets follow RFC 8878 §3.1.2.5 on a handworked sequence list',
    run() {
      // Start [1, 4, 8].
      const reps: [number, number, number] = [1, 4, 8]
      // ll > 0, offset 4 = rep2 → slot 1, swaps to the front.
      eq(repSlot(4, 3, reps), 1)
      eq(offsetValue(1, 3, 4), 2)
      applyRep(reps, 1, 4)
      eq(reps, [4, 1, 8])
      // A new offset 100 pushes everything down.
      eq(offsetValue(-1, 2, 100), 103)
      applyRep(reps, -1, 100)
      eq(reps, [100, 4, 1])
      // ll = 0 shifts the codes: Offset_Value 1 means rep2, 3 means rep1 − 1.
      eq(repSlot(4, 0, reps), 1)
      eq(offsetValue(1, 0, 4), 1)
      eq(repSlot(99, 0, reps), 3)
      eq(offsetValue(3, 0, 99), 3)
      applyRep(reps, 3, 99)
      eq(reps, [99, 100, 4])
      // ll = 0 cannot say rep1 itself.
      eq(repSlot(99, 0, reps), -1)
    },
  },
  {
    name: 'Node’s zstd decodes our frames: every corpus input, default settings, with and without checksum',
    run() {
      nodeAccepts({})
      nodeAccepts({ checksum: true })
    },
  },
  {
    name: 'Node’s zstd decodes our frames in every literal mode and table mode',
    run() {
      for (const literals of ['raw', 'huffman'] as const) nodeAccepts({ literals, effort: 'fast' })
      for (const tables of ['predefined', 'fse'] as const) nodeAccepts({ tables, effort: 'max' })
      nodeAccepts({ blockSize: 1000 })
    },
  },
  {
    name: 'our decoder reads Node’s zstd at levels 1, 3, 9 and 19, with and without checksum',
    run() {
      for (const level of [1, 3, 9, 19])
        for (const ck of [0, 1])
          for (const { id, data: input } of data) {
            const z = zstdCompressSync(input, { params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_checksumFlag]: ck } })
            bytesEq(decode(new Uint8Array(z)).out, input, `level ${level} ${id}`)
          }
    },
  },
  {
    name: 'our decoder reads multi-block frames from Node’s zstd (256 KiB input) and a skippable frame',
    run() {
      const big = new Uint8Array(300_000)
      for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 9)) & 255
      bytesEq(decode(new Uint8Array(zstdCompressSync(big))).out, big, 'multi-block')
      const r = decode(new Uint8Array(zstdCompressSync(big)))
      ok(r.blocks.length > 1, 'expected more than one block')
      const skip = Uint8Array.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9, ...zstdCompressSync(utf8('hi'))])
      bytesEq(decode(skip).out, utf8('hi'), 'skippable')
    },
  },
  {
    name: 'a frame with a flipped checksum bit is rejected',
    run() {
      const f = encode(utf8('checksums catch this'), { checksum: true }).bytes.slice()
      f[f.length - 1] ^= 1
      let threw = false
      try {
        decode(f)
      } catch {
        threw = true
      }
      ok(threw, 'corrupt checksum accepted')
    },
  },
  {
    name: 'on the repeated prose, our frame is within 10% of Node’s zstd level 3',
    run() {
      const input = data.find((d) => d.id === 'prose-x40')!.data
      const ours = encode(input).bytes.length
      const theirs = zstdCompressSync(input).length
      ok(ours <= theirs * 1.1, `ours ${ours} vs zstd ${theirs}`)
    },
  },
]
