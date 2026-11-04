/**
 * The Burrows–Wheeler pipeline, as bzip2 runs it (minus its first RLE pass):
 *
 *   BWT  →  move-to-front  →  zero-run coding (RUNA/RUNB)  →  Huffman
 *
 * Everything here works on plain number arrays so the exhibit can feed it a
 * virtual end-of-text sentinel: pass `alphabet` = 257 and shift bytes up by one,
 * leaving 0 free for a '$' that sorts before every byte.
 */

/**
 * Sort the n cyclic rotations of `s` (values in [0, alphabet)).
 * Prefix doubling with counting sorts — O(n log n), no comparisons — so a
 * 70 000-byte run of zeros, the worst case for a naive rotation sort, is
 * no slower than prose. Returns the rotation start indices in sorted order.
 * Equal rotations (periodic input) come out in an arbitrary but consistent
 * order; they are identical, so the last column does not depend on it.
 */
export function sortRotations(s: ArrayLike<number>, alphabet = 256): Int32Array {
  const n = s.length
  const p = new Int32Array(n)
  if (n === 0) return p
  let c = new Int32Array(n)
  const cnt = new Int32Array(Math.max(alphabet, n))

  for (let i = 0; i < n; i++) cnt[s[i]]++
  for (let i = 1; i < alphabet; i++) cnt[i] += cnt[i - 1]
  for (let i = n - 1; i >= 0; i--) p[--cnt[s[i]]] = i
  c[p[0]] = 0
  let classes = 1
  for (let i = 1; i < n; i++) {
    if (s[p[i]] !== s[p[i - 1]]) classes++
    c[p[i]] = classes - 1
  }

  const pn = new Int32Array(n)
  let cn = new Int32Array(n)
  for (let h = 1; h < n && classes < n; h <<= 1) {
    // Sort by the second half first: rotation i−h's second half is rotation i.
    for (let i = 0; i < n; i++) {
      let j = p[i] - h
      if (j < 0) j += n
      pn[i] = j
    }
    cnt.fill(0, 0, classes)
    for (let i = 0; i < n; i++) cnt[c[pn[i]]]++
    for (let i = 1; i < classes; i++) cnt[i] += cnt[i - 1]
    for (let i = n - 1; i >= 0; i--) p[--cnt[c[pn[i]]]] = pn[i]

    cn[p[0]] = 0
    classes = 1
    for (let i = 1; i < n; i++) {
      const a1 = c[p[i]]
      const b1 = c[p[i - 1]]
      let x = p[i] + h
      if (x >= n) x -= n
      let y = p[i - 1] + h
      if (y >= n) y -= n
      if (a1 !== b1 || c[x] !== c[y]) classes++
      cn[p[i]] = classes - 1
    }
    const t = c
    c = cn
    cn = t
  }
  return p
}

export interface Bwt {
  /** The last column L. */
  last: number[]
  /** Row of the sorted matrix that holds the original text. */
  primary: number
  /** order[row] = start index of the rotation in that row. */
  order: Int32Array
}

export function bwtForward(s: ArrayLike<number>, alphabet = 256): Bwt {
  const n = s.length
  const order = sortRotations(s, alphabet)
  const last = new Array<number>(n)
  let primary = 0
  for (let r = 0; r < n; r++) {
    const start = order[r]
    last[r] = s[(start + n - 1) % n]
    if (start === 0) primary = r
  }
  return { last, primary, order }
}

/**
 * The LF mapping: lf[r] is the row whose rotation starts one character earlier
 * than row r's. "The k-th occurrence of c in L is the k-th occurrence of c in F."
 */
export function lfMapping(last: ArrayLike<number>, alphabet = 256): { lf: Int32Array; rank: Int32Array; C: Int32Array } {
  const n = last.length
  const C = new Int32Array(alphabet + 1)
  for (let i = 0; i < n; i++) C[last[i] + 1]++
  for (let a = 0; a < alphabet; a++) C[a + 1] += C[a]
  const seen = new Int32Array(alphabet)
  const rank = new Int32Array(n)
  const lf = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const ch = last[i]
    rank[i] = seen[ch]++
    lf[i] = C[ch] + rank[i]
  }
  return { lf, rank, C }
}

/** Invert the BWT: walk LF from the primary row, emitting the text back to front. */
export function bwtInverse(last: ArrayLike<number>, primary: number, alphabet = 256): number[] {
  const n = last.length
  const out = new Array<number>(n)
  if (n === 0) return out
  const { lf } = lfMapping(last, alphabet)
  let r = primary
  for (let k = n - 1; k >= 0; k--) {
    out[k] = last[r]
    r = lf[r]
  }
  return out
}

/** The obvious definition, for checking: build every rotation and sort them as strings. */
export function naiveBwt(s: ArrayLike<number>): { last: number[]; primary: number } {
  const n = s.length
  const rots: number[][] = []
  for (let i = 0; i < n; i++) {
    const r: number[] = []
    for (let k = 0; k < n; k++) r.push(s[(i + k) % n])
    rots.push(r)
  }
  const idx = rots.map((_, i) => i)
  idx.sort((a, b) => {
    for (let k = 0; k < n; k++) if (rots[a][k] !== rots[b][k]) return rots[a][k] - rots[b][k]
    return 0
  })
  return { last: idx.map((i) => rots[i][n - 1]), primary: idx.findIndex((i) => rots[i].every((v, k) => v === s[k])) }
}

// ------------------------------------------------------------- move-to-front

/** Move-to-front over a starting list. Returns the index emitted for each symbol. */
export function mtfEncode(data: ArrayLike<number>, initial: number[]): number[] {
  const list = initial.slice()
  const out = new Array<number>(data.length)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    const j = list.indexOf(v)
    if (j < 0) throw new Error('mtf: symbol not in list')
    out[i] = j
    if (j > 0) {
      list.splice(j, 1)
      list.unshift(v)
    }
  }
  return out
}

export function mtfDecode(idx: ArrayLike<number>, initial: number[]): number[] {
  const list = initial.slice()
  const out = new Array<number>(idx.length)
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i]
    const v = list[j]
    if (v === undefined) throw new Error('mtf: index out of range')
    out[i] = v
    if (j > 0) {
      list.splice(j, 1)
      list.unshift(v)
    }
  }
  return out
}

/** The bytes that occur, in increasing order — bzip2's starting MTF list (its "inUse" map). */
export function usedSymbols(data: ArrayLike<number>): number[] {
  const seen = new Uint8Array(256)
  for (let i = 0; i < data.length; i++) seen[data[i]] = 1
  const out: number[] = []
  for (let b = 0; b < 256; b++) if (seen[b]) out.push(b)
  return out
}

// ------------------------------------------------------------ zero-run coding

/**
 * bzip2's run coding of MTF zeros. A run of n zeros becomes n written in
 * *bijective* base 2, least significant digit first, with digits RUNA = 1 and
 * RUNB = 2 (so n = Σ dᵢ·2ⁱ, dᵢ ∈ {1, 2}). Every n ≥ 1 has exactly one spelling
 * and there is no digit for zero, so no separator is needed. Non-zero MTF
 * values v move up to v + 1 to make room for the two run symbols.
 */
export const RUNA = 0
export const RUNB = 1

export function runDigits(n: number): number[] {
  const out: number[] = []
  while (n > 0) {
    if (n & 1) {
      out.push(RUNA)
      n = (n - 1) / 2
    } else {
      out.push(RUNB)
      n = (n - 2) / 2
    }
  }
  return out
}

export interface RunToken {
  /** Symbols emitted for this token. */
  symbols: number[]
  /** Number of zeros (for a run) or 0 for a single non-zero value. */
  run: number
  /** The MTF value, for a non-run token. */
  value: number
  /** Index of the first MTF output this token covers. */
  at: number
}

export function zeroRunTokens(mtf: ArrayLike<number>): RunToken[] {
  const toks: RunToken[] = []
  let i = 0
  while (i < mtf.length) {
    if (mtf[i] === 0) {
      let j = i
      while (j < mtf.length && mtf[j] === 0) j++
      toks.push({ symbols: runDigits(j - i), run: j - i, value: 0, at: i })
      i = j
    } else {
      toks.push({ symbols: [mtf[i] + 1], run: 0, value: mtf[i], at: i })
      i++
    }
  }
  return toks
}

export function zeroRunEncode(mtf: ArrayLike<number>): number[] {
  const out: number[] = []
  for (const t of zeroRunTokens(mtf)) out.push(...t.symbols)
  return out
}

export function zeroRunDecode(syms: ArrayLike<number>): number[] {
  const out: number[] = []
  let run = 0
  let weight = 1
  const flush = () => {
    for (let k = 0; k < run; k++) out.push(0)
    run = 0
    weight = 1
  }
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i]
    if (s === RUNA || s === RUNB) {
      run += (s === RUNA ? 1 : 2) * weight
      weight *= 2
    } else {
      flush()
      out.push(s - 1)
    }
  }
  flush()
  return out
}
