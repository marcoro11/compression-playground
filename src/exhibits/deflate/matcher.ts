/**
 * The LZ77 half of DEFLATE: find earlier copies of what comes next.
 *
 * Hash chains, as in zlib: every position is filed under a hash of its next
 * three bytes; `head[h]` is the most recent position with that hash and
 * `prev[p]` the one before it. To find a match you walk the chain backwards,
 * newest first, within the 32 KiB window. The tuning knobs are zlib level 6's:
 *
 *   maxChain 128  — give up after this many candidates
 *   nice     128  — a match this long is good enough, stop looking
 *   maxLazy   16  — only try the lazy step when the match is shorter than this
 *
 * Lazy matching: having found a match at i, peek at i+1. If a longer match
 * starts there, emit byte i as a literal and take the later match instead.
 */

export const WINDOW = 32768
export const MIN_MATCH = 3
export const MAX_MATCH = 258

export type Token = { kind: 'lit'; pos: number; byte: number } | { kind: 'match'; pos: number; length: number; dist: number; lazy?: boolean }

export interface MatchOptions {
  lazy?: boolean
  maxChain?: number
  nice?: number
  maxLazy?: number
}

const HASH_BITS = 15
const HASH_SIZE = 1 << HASH_BITS

export function findTokens(data: Uint8Array, opts: MatchOptions = {}): Token[] {
  const lazy = opts.lazy ?? true
  const maxChain = opts.maxChain ?? 128
  const nice = opts.nice ?? 128
  const maxLazy = opts.maxLazy ?? 16
  const n = data.length
  const head = new Int32Array(HASH_SIZE).fill(-1)
  const prev = new Int32Array(Math.max(1, n)).fill(-1)
  const tokens: Token[] = []

  const hash = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1)
  const insert = (i: number) => {
    if (i + 2 >= n) return
    const h = hash(i)
    prev[i] = head[h]
    head[h] = i
  }
  const find = (i: number): { length: number; dist: number } => {
    let best = 0
    let bestDist = 0
    if (i + MIN_MATCH > n) return { length: 0, dist: 0 }
    const limit = Math.min(MAX_MATCH, n - i)
    let cand = head[hash(i)]
    let chain = maxChain
    while (cand >= 0 && i - cand <= WINDOW && chain-- > 0) {
      // Quick reject: the byte that would extend the best match must agree.
      if (data[cand + best] === data[i + best] && data[cand] === data[i]) {
        let l = 0
        while (l < limit && data[cand + l] === data[i + l]) l++
        if (l > best) {
          best = l
          bestDist = i - cand
          if (l >= nice || l === limit) break
        }
      }
      cand = prev[cand]
    }
    return best >= MIN_MATCH ? { length: best, dist: bestDist } : { length: 0, dist: 0 }
  }

  let i = 0
  // True when the previous literal was emitted only because a longer match
  // started one byte later — the next match is the lazy step's choice.
  let deferred = false
  while (i < n) {
    const m = find(i)
    insert(i)
    if (lazy && m.length >= MIN_MATCH && m.length < maxLazy && i + 1 < n) {
      const m2 = find(i + 1)
      if (m2.length > m.length) {
        tokens.push({ kind: 'lit', pos: i, byte: data[i] })
        i++
        deferred = true
        continue
      }
    }
    if (m.length >= MIN_MATCH) {
      tokens.push({ kind: 'match', pos: i, length: m.length, dist: m.dist, lazy: deferred })
      for (let k = 1; k < m.length; k++) insert(i + k)
      i += m.length
    } else {
      tokens.push({ kind: 'lit', pos: i, byte: data[i] })
      i++
    }
    deferred = false
  }
  return tokens
}
