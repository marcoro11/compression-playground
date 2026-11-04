/**
 * The fixed tables of RFC 8878: how literal lengths, match lengths and offsets
 * become a code plus extra bits, and the predefined FSE distributions a block
 * may use instead of shipping its own.
 */

/** Literal length codes 0–35: [baseline, extra bits] (RFC 8878 §3.1.1.3.2.1.1). */
export const LL_BASE: number[] = []
export const LL_BITS: number[] = []
{
  const tail: [number, number][] = [
    [16, 1], [18, 1], [20, 1], [22, 1], [24, 2], [28, 2], [32, 3], [40, 3], [48, 4], [64, 6],
    [128, 7], [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14], [32768, 15], [65536, 16],
  ]
  for (let c = 0; c < 16; c++) {
    LL_BASE.push(c)
    LL_BITS.push(0)
  }
  for (const [b, e] of tail) {
    LL_BASE.push(b)
    LL_BITS.push(e)
  }
}

/** Match length codes 0–52 (matches are at least 3 long). */
export const ML_BASE: number[] = []
export const ML_BITS: number[] = []
{
  const tail: [number, number][] = [
    [35, 1], [37, 1], [39, 1], [41, 1], [43, 2], [47, 2], [51, 3], [59, 3], [67, 4], [83, 4], [99, 5],
    [131, 7], [259, 8], [515, 9], [1027, 10], [2051, 11], [4099, 12], [8195, 13], [16387, 14], [32771, 15], [65539, 16],
  ]
  for (let c = 0; c < 32; c++) {
    ML_BASE.push(c + 3)
    ML_BITS.push(0)
  }
  for (const [b, e] of tail) {
    ML_BASE.push(b)
    ML_BITS.push(e)
  }
}

export const MAX_ML = ML_BASE[52] + (1 << ML_BITS[52]) - 1 // 131074
export const MAX_LL = LL_BASE[35] + (1 << LL_BITS[35]) - 1

function codeFor(v: number, base: number[]): number {
  let lo = 0
  let hi = base.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (base[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

export const llCode = (ll: number) => codeFor(ll, LL_BASE)
export const mlCode = (ml: number) => codeFor(ml, ML_BASE)
/** Offset code = ⌊log₂ Offset_Value⌋; the rest of the value rides as extra bits. */
export const ofCode = (ofValue: number) => 31 - Math.clz32(ofValue)

/** Predefined distributions (RFC 8878 §3.1.1.3.2.2). −1 means "less than 1". */
export const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1]
export const LL_DEFAULT_LOG = 6
export const ML_DEFAULT = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
  -1, -1, -1, -1, -1,
]
export const ML_DEFAULT_LOG = 6
export const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]
export const OF_DEFAULT_LOG = 5

/** Largest accuracy a block may use for each stream, and the largest symbol. */
export const STREAMS = {
  LL: { maxLog: 9, maxSymbol: 35, def: LL_DEFAULT, defLog: LL_DEFAULT_LOG },
  OF: { maxLog: 8, maxSymbol: 31, def: OF_DEFAULT, defLog: OF_DEFAULT_LOG },
  ML: { maxLog: 9, maxSymbol: 52, def: ML_DEFAULT, defLog: ML_DEFAULT_LOG },
} as const
export type StreamName = keyof typeof STREAMS

export const MAGIC = 0xfd2fb528
export const BLOCK_MAX = 128 * 1024

export const MODE_NAMES = ['predefined', 'RLE', 'FSE', 'repeat'] as const
export type TableMode = (typeof MODE_NAMES)[number]
