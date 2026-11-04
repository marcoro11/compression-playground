/**
 * Counting and the Shannon bound.
 *
 * Order-0 entropy is the number every symbol-at-a-time coder (Huffman,
 * arithmetic with a static model) is measured against: no code that assigns
 * each byte a fixed bit pattern, independent of its neighbours, can average
 * fewer bits per symbol than H = −Σ p·log₂p. Dictionary and context coders get
 * under it precisely by *not* coding bytes independently.
 */

/** Byte histogram: counts[b] = occurrences of byte b. Always length 256. */
export function byteCounts(data: ArrayLike<number>): number[] {
  const c = new Array<number>(256).fill(0)
  for (let i = 0; i < data.length; i++) c[data[i]]++
  return c
}

/** Histogram over an arbitrary alphabet size. */
export function counts(data: ArrayLike<number>, alphabet: number): number[] {
  const c = new Array<number>(alphabet).fill(0)
  for (let i = 0; i < data.length; i++) c[data[i]]++
  return c
}

/** Shannon entropy in bits per symbol of a histogram. 0 for an empty one. */
export function entropy(hist: ArrayLike<number>): number {
  let total = 0
  for (let i = 0; i < hist.length; i++) total += hist[i]
  if (total === 0) return 0
  let h = 0
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i]
    if (n > 0) {
      const p = n / total
      h -= p * Math.log2(p)
    }
  }
  return h
}

/** Order-0 entropy of a sequence, bits per symbol. */
export function entropyOf(data: ArrayLike<number>, alphabet = 256): number {
  return entropy(counts(data, alphabet))
}

/**
 * Order-k conditional entropy H(Xₙ | Xₙ₋ₖ…Xₙ₋₁) estimated from the data itself.
 * With k ≥ 1 this drops fast on text — and on short inputs it drops *too* fast,
 * because a context seen once predicts its follower perfectly. That optimism is
 * worth showing rather than hiding.
 */
export function conditionalEntropy(data: ArrayLike<number>, k: number): number {
  if (k === 0) return entropyOf(data)
  const ctx = new Map<string, Map<number, number>>()
  let total = 0
  for (let i = k; i < data.length; i++) {
    let key = ''
    for (let j = i - k; j < i; j++) key += String.fromCharCode(data[j])
    let m = ctx.get(key)
    if (!m) ctx.set(key, (m = new Map()))
    m.set(data[i], (m.get(data[i]) ?? 0) + 1)
    total++
  }
  if (total === 0) return 0
  let h = 0
  for (const m of ctx.values()) {
    let n = 0
    for (const v of m.values()) n += v
    for (const v of m.values()) h -= (v / total) * Math.log2(v / n)
  }
  return h
}
