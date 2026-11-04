/**
 * Prediction by Partial Matching (Cleary & Witten, 1984).
 *
 * Keep a table of counts for every context — the last k bytes — for every k up
 * to a maximum order. To code the next byte, ask the longest context first. If
 * it has seen this byte before, code it with that context's counts. If not,
 * code an ESCAPE ("not one of these") and ask the next shorter context. At the
 * bottom sits order −1: every byte equally likely, so nothing is ever
 * impossible.
 *
 * The escape is itself a symbol and needs a probability. That choice is the
 * "method":
 *
 *   A   escape count 1, symbol counts c              (PPMA)
 *   B   escape count q, symbol counts c − 1          (a byte must be seen twice)
 *   C   escape count q, symbol counts c              (PPMC — Moffat 1990)
 *   D   escape count q, symbol counts 2c − 1         (PPMD — Howard 1993)
 *
 * where q is the number of distinct bytes the context has seen (only those still
 * in play, when exclusion is on).
 *
 * Exclusion: once a context has escaped, the decoder knows the byte is none of
 * the ones that context offered, so a shorter context need not spend
 * probability on them. They are removed from its totals.
 *
 * Update exclusion: after a byte is coded, only the contexts from the one that
 * predicted it upwards get their count bumped. The shorter ones are left alone,
 * so order-0 counts end up recording how often a byte is *novel* — which is
 * what order 0 is actually asked about. Full update bumps every order.
 *
 * Everything here is integer-valued and deterministic, so an encoder and a
 * decoder running the same model see exactly the same counts.
 */

export type EscapeMethod = 'A' | 'B' | 'C' | 'D'

export interface PpmOptions {
  /** Maximum context order (0 … 5). */
  order: number
  escape: EscapeMethod
  exclusion: boolean
  updateExclusion: boolean
  /** Halve a context's counts once their sum exceeds this. Keeps totals small for the coder. */
  limit?: number
}

export const DEFAULT_LIMIT = 1 << 13

interface Ctx {
  syms: number[]
  cnt: number[]
  /** Σ cnt */
  n: number
}

/** One symbol as a context shows it, whether or not it is in play. */
export interface Item {
  sym: number
  count: number
  /** Weight in this level's distribution (0 = excluded or not offered). */
  weight: number
  excluded: boolean
}

export type LevelStatus = 'unseen' | 'empty' | 'escape' | 'hit'

/** What happened at one context level while coding one byte. */
export interface Level {
  /** −1 is the uniform fallback. */
  order: number
  /** The context bytes (oldest first); empty for orders 0 and −1. */
  context: number[]
  status: LevelStatus
  items: Item[]
  escWeight: number
  total: number
  /** Probability of the outcome coded here (the byte, or the escape). 1 when nothing was coded. */
  prob: number
  /** Numerator / denominator of `prob`, exactly. */
  num: number
  den: number
  /** Bytes newly excluded when this level escaped. */
  excludedHere: number[]
}

export interface SymbolTrace {
  pos: number
  sym: number
  /** Highest order available at this position: min(order, pos). */
  top: number
  levels: Level[]
  /** Product of the per-level probabilities. */
  prob: number
  bits: number
  /** Orders whose counts were incremented afterwards. */
  updated: number[]
  /** Order that finally coded the byte (−1 = uniform). */
  foundAt: number
}

/** A level ready for the coder: the offered symbols, their weights, and the escape. */
export interface CodingDist {
  order: number
  syms: number[]
  w: number[]
  esc: number
  total: number
}

export function symbolWeight(count: number, m: EscapeMethod): number {
  switch (m) {
    case 'A':
    case 'C':
      return count
    case 'B':
      return count - 1
    case 'D':
      return 2 * count - 1
  }
}

export function escapeWeight(q: number, m: EscapeMethod): number {
  return m === 'A' ? 1 : q
}

/** Numeric key for (order, last k bytes). Safe up to order 5 (8·256⁵ < 2⁵³). */
function keyOf(hist: ArrayLike<number>, pos: number, k: number): number {
  let key = 0
  for (let j = pos - k; j < pos; j++) key = key * 256 + hist[j]
  return key * 8 + k
}

export class PpmModel {
  readonly hist: number[] = []
  private readonly map = new Map<number, Ctx>()
  /** excl[b] === gen  ⇔  b is excluded while coding the current byte. */
  private readonly excl = new Uint32Array(256)
  private gen = 1
  private readonly limit: number
  /** Coding state for the current byte. */
  private level = 0
  private nExcluded = 0

  constructor(readonly opts: PpmOptions) {
    if (opts.order < 0 || opts.order > 5) throw new Error('ppm: order must be 0…5')
    this.limit = opts.limit ?? DEFAULT_LIMIT
    this.begin()
  }

  get contexts(): number {
    return this.map.size
  }

  private ctx(k: number): Ctx | undefined {
    return this.map.get(keyOf(this.hist, this.hist.length, k))
  }

  private isExcluded(b: number): boolean {
    return this.excl[b] === this.gen
  }

  /** Start coding a new byte: top order, nothing excluded. */
  private begin() {
    this.gen++
    if (this.gen === 0xffffffff) {
      this.excl.fill(0)
      this.gen = 1
    }
    this.nExcluded = 0
    this.level = Math.min(this.opts.order, this.hist.length)
  }

  /** The distribution at order k given the current exclusions, or null if nothing can be coded there. */
  private distAt(k: number): CodingDist | null {
    if (k < 0) {
      const syms: number[] = []
      for (let b = 0; b < 256; b++) if (!this.isExcluded(b)) syms.push(b)
      return { order: -1, syms, w: syms.map(() => 1), esc: 0, total: syms.length }
    }
    const c = this.ctx(k)
    if (!c) return null
    const m = this.opts.escape
    const syms: number[] = []
    const w: number[] = []
    let q = 0
    let t = 0
    for (let i = 0; i < c.syms.length; i++) {
      const s = c.syms[i]
      if (this.isExcluded(s)) continue
      q++
      const wt = symbolWeight(c.cnt[i], m)
      if (wt > 0) {
        syms.push(s)
        w.push(wt)
        t += wt
      }
    }
    if (syms.length === 0) return null
    const esc = escapeWeight(q, m)
    return { order: k, syms, w, esc, total: t + esc }
  }

  /** The level the coder must code next (skipping contexts with nothing to offer). */
  current(): CodingDist {
    for (;;) {
      const d = this.distAt(this.level)
      if (d) return d
      this.level--
    }
  }

  /**
   * Advance after coding index `i` of `current()` (i === syms.length is the
   * escape). Returns the byte when one was completed, else −1.
   */
  advance(i: number): number {
    const d = this.current()
    if (i < d.syms.length) {
      const s = d.syms[i]
      this.commit(s, d.order)
      return s
    }
    if (d.order < 0) throw new Error('ppm: escape from order −1')
    if (this.opts.exclusion) {
      for (const s of d.syms) {
        if (this.excl[s] !== this.gen) {
          this.excl[s] = this.gen
          this.nExcluded++
        }
      }
    }
    this.level = d.order - 1
    return -1
  }

  /** Orders that will be bumped when a byte is found at order `foundAt`. */
  updatedOrders(foundAt: number): number[] {
    const top = Math.min(this.opts.order, this.hist.length)
    const from = this.opts.updateExclusion ? Math.max(0, foundAt) : 0
    const out: number[] = []
    for (let k = top; k >= from; k--) out.push(k)
    return out
  }

  private commit(s: number, foundAt: number) {
    for (const k of this.updatedOrders(foundAt)) {
      const key = keyOf(this.hist, this.hist.length, k)
      let c = this.map.get(key)
      if (!c) {
        c = { syms: [], cnt: [], n: 0 }
        this.map.set(key, c)
      }
      const j = c.syms.indexOf(s)
      if (j < 0) {
        c.syms.push(s)
        c.cnt.push(1)
      } else c.cnt[j]++
      c.n++
      if (c.n > this.limit) {
        c.n = 0
        for (let i = 0; i < c.cnt.length; i++) {
          c.cnt[i] = (c.cnt[i] + 1) >> 1
          c.n += c.cnt[i]
        }
      }
    }
    this.hist.push(s)
    this.begin()
  }

  /** Coding events (indices into successive `current()` distributions) for byte s. Advances the model. */
  eventsFor(s: number): number[] {
    const ev: number[] = []
    for (;;) {
      const d = this.current()
      const i = d.syms.indexOf(s)
      const idx = i < 0 ? d.syms.length : i
      ev.push(idx)
      if (this.advance(idx) >= 0) return ev
    }
  }

  /**
   * Everything that happens when byte s is coded, level by level, for the
   * picture — including contexts that were skipped because they had never been
   * seen or had nothing left to offer. Advances the model.
   */
  explain(s: number): SymbolTrace {
    const pos = this.hist.length
    const top = Math.min(this.opts.order, pos)
    const levels: Level[] = []
    let prob = 1
    let foundAt = -1
    const m = this.opts.escape
    for (let k = top; k >= -1; k--) {
      const context = k > 0 ? this.hist.slice(pos - k) : []
      if (k >= 0) {
        const c = this.ctx(k)
        if (!c) {
          levels.push({ order: k, context, status: 'unseen', items: [], escWeight: 0, total: 0, prob: 1, num: 1, den: 1, excludedHere: [] })
          continue
        }
        const items: Item[] = c.syms.map((sym, i) => {
          const excluded = this.isExcluded(sym)
          return { sym, count: c.cnt[i], excluded, weight: excluded ? 0 : Math.max(0, symbolWeight(c.cnt[i], m)) }
        })
        const d = this.distAt(k)
        if (!d) {
          levels.push({ order: k, context, status: 'empty', items, escWeight: 0, total: 0, prob: 1, num: 1, den: 1, excludedHere: [] })
          continue
        }
        // Keep the model's internal level in step with the walk.
        this.level = k
        const i = d.syms.indexOf(s)
        if (i >= 0) {
          const p = d.w[i] / d.total
          prob *= p
          levels.push({
            order: k,
            context,
            status: 'hit',
            items,
            escWeight: d.esc,
            total: d.total,
            prob: p,
            num: d.w[i],
            den: d.total,
            excludedHere: [],
          })
          foundAt = k
          break
        }
        const p = d.esc / d.total
        prob *= p
        const before = new Set<number>()
        for (let b = 0; b < 256; b++) if (this.isExcluded(b)) before.add(b)
        this.advance(d.syms.length)
        const excludedHere = this.opts.exclusion ? d.syms.filter((x) => !before.has(x)) : []
        levels.push({ order: k, context, status: 'escape', items, escWeight: d.esc, total: d.total, prob: p, num: d.esc, den: d.total, excludedHere })
      } else {
        const d = this.distAt(-1)!
        const p = 1 / d.total
        prob *= p
        levels.push({
          order: -1,
          context: [],
          status: 'hit',
          items: [],
          escWeight: 0,
          total: d.total,
          prob: p,
          num: 1,
          den: d.total,
          excludedHere: [],
        })
        foundAt = -1
      }
    }
    const updated = this.updatedOrders(foundAt)
    this.commit(s, foundAt)
    return { pos, sym: s, top, levels, prob, bits: -Math.log2(prob), updated, foundAt }
  }

  /**
   * The blended distribution over the next byte, before it is seen: every
   * byte's probability is (product of escapes on the way down) × (its share at
   * the first level that offers it). A byte offered by a longer context is
   * always coded there, so any share a shorter context also gives it is
   * unreachable — without exclusion that mass is simply wasted, and the
   * distribution sums to less than 1. Does not advance the model.
   */
  predict(): number[] {
    const p = new Array<number>(256).fill(0)
    const excluded = new Uint8Array(256)
    const offeredAbove = new Uint8Array(256)
    let mass = 1
    const top = Math.min(this.opts.order, this.hist.length)
    const m = this.opts.escape
    for (let k = top; k >= 0; k--) {
      const c = this.ctx(k)
      if (!c) continue
      let q = 0
      let t = 0
      const offered: number[] = []
      const weights: number[] = []
      for (let i = 0; i < c.syms.length; i++) {
        const s = c.syms[i]
        if (excluded[s]) continue
        q++
        const wt = symbolWeight(c.cnt[i], m)
        if (wt > 0) {
          offered.push(s)
          weights.push(wt)
          t += wt
        }
      }
      if (!offered.length) continue
      const T = t + escapeWeight(q, m)
      offered.forEach((s, i) => {
        if (!offeredAbove[s]) p[s] += (mass * weights[i]) / T
      })
      mass *= escapeWeight(q, m) / T
      for (const s of offered) {
        offeredAbove[s] = 1
        if (this.opts.exclusion) excluded[s] = 1
      }
    }
    let left = 0
    for (let b = 0; b < 256; b++) if (!excluded[b]) left++
    for (let b = 0; b < 256; b++) if (!excluded[b] && !offeredAbove[b]) p[b] += mass / left
    return p
  }
}

// ----------------------------------------------------------------- whole runs

export interface Run {
  traces: SymbolTrace[]
  bits: number
  contexts: number
  escapes: number
}

/** Explain every byte of `data` under `opts`. */
export function runModel(data: ArrayLike<number>, opts: PpmOptions): Run {
  const m = new PpmModel(opts)
  const traces: SymbolTrace[] = []
  let bits = 0
  let escapes = 0
  for (let i = 0; i < data.length; i++) {
    const t = m.explain(data[i])
    traces.push(t)
    bits += t.bits
    for (const l of t.levels) if (l.status === 'escape') escapes++
  }
  return { traces, bits, contexts: m.contexts, escapes }
}

/** Σ −log₂ p over the input — the ideal code length the arithmetic coder approaches. */
export function idealBits(data: ArrayLike<number>, opts: PpmOptions): number {
  const m = new PpmModel(opts)
  let bits = 0
  for (let i = 0; i < data.length; i++) bits += m.explain(data[i]).bits
  return bits
}
