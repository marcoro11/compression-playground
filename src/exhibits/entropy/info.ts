/**
 * Small pieces of information theory the exhibit uses, kept pure so verify can
 * check them: the counting argument, and Shannon's guessing-game bounds.
 */

/** All binary strings of exactly length n, in counting order. */
export function stringsOfLength(n: number): string[] {
  const out: string[] = []
  for (let v = 0; v < 2 ** n; v++) out.push(n === 0 ? '' : v.toString(2).padStart(n, '0'))
  return out
}

/** All binary strings strictly shorter than n, shortest first (ε, 0, 1, 00, …). */
export function stringsShorterThan(n: number): string[] {
  const out: string[] = []
  for (let k = 0; k < n; k++) out.push(...stringsOfLength(k))
  return out
}

/** How many inputs of n bits can shrink by at least k bits: the outputs of length ≤ n−k. */
export function shrinkable(n: number, k: number): number {
  return k > n ? 0 : 2 ** (n - k + 1) - 1
}

/**
 * Shannon (1951), "Prediction and Entropy of Printed English": a person guesses
 * each next character until right; qᵢ is the fraction of characters that took
 * exactly i guesses. Because a deterministic predictor could reproduce the text
 * from the guess counts alone, the entropy of the guess-count distribution is an
 * upper bound on the text's entropy per character, and Σ i·(qᵢ − qᵢ₊₁)·log₂ i a
 * lower bound (for a predictor that ranks its guesses perfectly).
 */
export function guessBounds(guessCounts: number[], alphabet = 27): { upper: number; lower: number; q: number[] } {
  const q = new Array<number>(alphabet + 2).fill(0)
  const n = guessCounts.length
  if (n === 0) return { upper: 0, lower: 0, q }
  for (const g of guessCounts) q[Math.min(alphabet, Math.max(1, g))] += 1 / n
  let upper = 0
  let lower = 0
  for (let i = 1; i <= alphabet; i++) {
    if (q[i] > 0) upper -= q[i] * Math.log2(q[i])
    lower += i * (q[i] - q[i + 1]) * Math.log2(i)
  }
  return { upper, lower, q }
}
