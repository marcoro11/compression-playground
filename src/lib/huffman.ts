/**
 * Huffman coding, three ways.
 *
 *  1. `buildTree` — the textbook algorithm, with a full trace of every merge so
 *     the exhibit can replay it: take the two lightest nodes, join them, put the
 *     parent back, repeat.
 *  2. `limitedLengths` — package-merge (Larmore & Hirschberg, 1990). Real
 *     formats cap code length (DEFLATE: 15 bits, its code-length code: 7), and
 *     the plain algorithm can exceed any cap on a skewed enough histogram.
 *     Package-merge finds the *optimal* lengths subject to the cap.
 *  3. `canonicalCodes` — once you have lengths, the codes themselves can be
 *     reconstructed from the lengths alone (RFC 1951 §3.2.2). That is why a
 *     DEFLATE header ships lengths and never a tree.
 *
 * Ties are broken deterministically (by weight, then by creation order, with
 * leaves created in symbol order) so the trace replays identically every time
 * and `npm run verify` can pin it.
 */

export interface HNode {
  id: number
  weight: number
  /** Present on leaves only. */
  symbol?: number
  left?: HNode
  right?: HNode
  /** Depth from the root, filled in after the build. */
  depth: number
}

export interface MergeStep {
  /** Ids of every node in the queue *before* this merge, in queue order. */
  queue: number[]
  a: HNode
  b: HNode
  parent: HNode
}

export interface HuffmanBuild {
  root: HNode | null
  leaves: HNode[]
  /** Every node ever created, indexed by id. */
  nodes: HNode[]
  steps: MergeStep[]
  /** lengths[symbol] = code length in bits (0 = symbol absent). */
  lengths: number[]
}

/** Order used everywhere: lighter first, then older first. */
const byWeight = (x: HNode, y: HNode) => x.weight - y.weight || x.id - y.id

export function buildTree(freqs: ArrayLike<number>): HuffmanBuild {
  const nodes: HNode[] = []
  const leaves: HNode[] = []
  for (let s = 0; s < freqs.length; s++) {
    if (freqs[s] > 0) {
      const n: HNode = { id: nodes.length, weight: freqs[s], symbol: s, depth: 0 }
      nodes.push(n)
      leaves.push(n)
    }
  }
  const lengths = new Array<number>(freqs.length).fill(0)
  const steps: MergeStep[] = []
  if (leaves.length === 0) return { root: null, leaves, nodes, steps, lengths }

  // A linear scan for the two minima is O(n²) but the alphabets here are ≤ 288
  // and it keeps the queue order obvious for the trace.
  const queue = leaves.slice().sort(byWeight)
  while (queue.length > 1) {
    const before = queue.map((n) => n.id)
    const a = queue.shift()!
    const b = queue.shift()!
    const parent: HNode = { id: nodes.length, weight: a.weight + b.weight, left: a, right: b, depth: 0 }
    nodes.push(parent)
    let i = 0
    while (i < queue.length && byWeight(queue[i], parent) < 0) i++
    queue.splice(i, 0, parent)
    steps.push({ queue: before, a, b, parent })
  }
  const root = queue[0]

  const walk = (n: HNode, d: number) => {
    n.depth = d
    if (n.symbol !== undefined) lengths[n.symbol] = Math.max(d, 1) // a lone symbol still needs one bit
    if (n.left) walk(n.left, d + 1)
    if (n.right) walk(n.right, d + 1)
  }
  walk(root, 0)
  return { root, leaves, nodes, steps, lengths }
}

/** The code a symbol gets from the tree itself: 0 = left, 1 = right. */
export function treeCodes(root: HNode | null, alphabet: number): string[] {
  const codes = new Array<string>(alphabet).fill('')
  if (!root) return codes
  if (root.symbol !== undefined) {
    codes[root.symbol] = '0'
    return codes
  }
  const walk = (n: HNode, prefix: string) => {
    if (n.symbol !== undefined) codes[n.symbol] = prefix
    if (n.left) walk(n.left, prefix + '0')
    if (n.right) walk(n.right, prefix + '1')
  }
  walk(root, '')
  return codes
}

/**
 * Optimal code lengths with every length ≤ maxBits (package-merge).
 * Throws if 2^maxBits is smaller than the number of used symbols.
 */
export function limitedLengths(freqs: ArrayLike<number>, maxBits: number): number[] {
  const lengths = new Array<number>(freqs.length).fill(0)
  const used: number[] = []
  for (let s = 0; s < freqs.length; s++) if (freqs[s] > 0) used.push(s)
  if (used.length === 0) return lengths
  if (used.length === 1) {
    lengths[used[0]] = 1
    return lengths
  }
  if (2 ** maxBits < used.length) throw new Error(`cannot fit ${used.length} symbols in ${maxBits}-bit codes`)

  type Item = { w: number; syms: number[] }
  const leaves: Item[] = used.map((s) => ({ w: freqs[s], syms: [s] })).sort((x, y) => x.w - y.w || x.syms[0] - y.syms[0])

  let list = leaves
  for (let level = 1; level < maxBits; level++) {
    const packages: Item[] = []
    for (let i = 0; i + 1 < list.length; i += 2) {
      packages.push({ w: list[i].w + list[i + 1].w, syms: list[i].syms.concat(list[i + 1].syms) })
    }
    // Merge, leaves first on equal weight (stable).
    const merged: Item[] = []
    let i = 0
    let j = 0
    while (i < leaves.length || j < packages.length) {
      if (j >= packages.length || (i < leaves.length && leaves[i].w <= packages[j].w)) merged.push(leaves[i++])
      else merged.push(packages[j++])
    }
    list = merged
  }
  const take = 2 * used.length - 2
  for (let k = 0; k < take; k++) for (const s of list[k].syms) lengths[s]++
  return lengths
}

/**
 * Canonical codes from lengths (RFC 1951 §3.2.2): shorter codes sort first,
 * and within a length, codes are consecutive in symbol order.
 */
export function canonicalCodes(lengths: ArrayLike<number>): number[] {
  let maxLen = 0
  for (let i = 0; i < lengths.length; i++) maxLen = Math.max(maxLen, lengths[i])
  const blCount = new Array<number>(maxLen + 1).fill(0)
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++
  const nextCode = new Array<number>(maxLen + 2).fill(0)
  let code = 0
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1
    nextCode[bits] = code
  }
  const codes = new Array<number>(lengths.length).fill(0)
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s]
    if (len) codes[s] = nextCode[len]++
  }
  return codes
}

/** Kraft sum Σ 2^−len over used symbols: 1 for a complete prefix code, < 1 if it wastes space. */
export function kraft(lengths: ArrayLike<number>): number {
  let k = 0
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) k += 2 ** -lengths[i]
  return k
}

/** Total encoded bits for a histogram under a set of code lengths. */
export function codedBits(freqs: ArrayLike<number>, lengths: ArrayLike<number>): number {
  let t = 0
  for (let i = 0; i < freqs.length; i++) t += freqs[i] * lengths[i]
  return t
}

/**
 * A decoding table for canonical codes: walk bits one at a time, which is slow
 * and exactly what the picture shows. `decodeSymbol` returns −1 on an invalid code.
 */
export class CanonicalDecoder {
  private readonly map = new Map<string, number>()
  readonly maxLen: number

  constructor(lengths: ArrayLike<number>) {
    const codes = canonicalCodes(lengths)
    let m = 0
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s]) {
        this.map.set(lengths[s] + ':' + codes[s], s)
        m = Math.max(m, lengths[s])
      }
    }
    this.maxLen = m
  }

  decodeSymbol(readBit: () => number): number {
    let code = 0
    for (let len = 1; len <= this.maxLen; len++) {
      code = (code << 1) | readBit()
      const s = this.map.get(len + ':' + code)
      if (s !== undefined) return s
    }
    return -1
  }
}
