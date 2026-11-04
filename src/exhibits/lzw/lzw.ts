/**
 * LZW (Welch 1984, after Ziv & Lempel 1978), traced step by step.
 *
 * The dictionary starts with all 256 single bytes. The encoder keeps the
 * longest string `w` it has in the dictionary; for each next byte `c` it either
 * extends `w` (if w+c is known) or sends the code for `w`, adds w+c as a new
 * entry, and restarts from `c`.
 *
 * Code width. Codes are written in as few bits as could possibly be needed:
 * enough for the largest code that might appear next. For the encoder that is
 * `next − 1` (every entry it has made); the decoder is always one entry behind,
 * so it reads with enough bits for its own `next` (the KwKwK case, below) —
 * which comes to the same number. Widths start at 9 and grow as the table
 * passes each power of two, up to `maxWidth`.
 *
 * When the table is full there are two policies, both real:
 *  - `freeze` — stop adding entries and keep coding with what you have.
 *  - `reset`  — send code 256 (CLEAR), forget everything, start again at 9 bits.
 *    This is what Unix compress and GIF do; it reserves 256, so new entries
 *    start at 257 in that mode (GIF also reserves 257 for end-of-information;
 *    here the file stores its length instead).
 *
 * KwKwK. The decoder learns entry k only when it reads the code *after* the one
 * that created it. If the encoder uses entry k immediately — which happens
 * exactly when the input looks like K w K w K for a string K w — the decoder
 * receives a code it does not have yet. It can still work it out: the new entry
 * must be (previous string) + (its own first byte).
 */

export type Policy = 'freeze' | 'reset'

export interface LzwParams {
  maxWidth: number
  policy: Policy
}

export const CLEAR = 256
export const firstFree = (policy: Policy) => (policy === 'reset' ? 257 : 256)
export const bitlen = (x: number) => (x <= 0 ? 0 : 32 - Math.clz32(x))
export const widthFor = (largest: number, maxWidth: number) => Math.min(maxWidth, Math.max(9, bitlen(largest)))

export interface Entry {
  code: number
  /** The entry's bytes. */
  bytes: number[]
}

export interface Emitted {
  code: number
  width: number
  /** Input range this code stands for (len 0 for CLEAR). */
  start: number
  len: number
}

export interface EncStep {
  kind: 'start' | 'extend' | 'emit' | 'flush'
  /** Input index of the byte read this step (−1 for flush). */
  i: number
  /** The string w after this step, as an input range, and its code. */
  wStart: number
  wLen: number
  wCode: number
  /** For extend/emit: the code of w before this step, and the byte c read. */
  prevStart: number
  prevLen: number
  prevCode: number
  /** Code of w+c if found (extend). */
  found: number
  /** Entry added this step, if any. */
  added: Entry | null
  cleared: boolean
  frozen: boolean
  /** Codes emitted so far (prefix length into `codes`). */
  codesLen: number
  /** Table state after this step: entries log[genStart … logLen). */
  genStart: number
  logLen: number
  /** Next free code after this step. */
  next: number
}

export interface EncTrace {
  steps: EncStep[]
  codes: Emitted[]
  log: Entry[]
}

export function encodeTrace(data: ArrayLike<number>, p: LzwParams): EncTrace {
  const n = data.length
  const steps: EncStep[] = []
  const codes: Emitted[] = []
  const log: Entry[] = []
  if (n === 0) return { steps, codes, log }
  const limit = 1 << p.maxWidth
  const first = firstFree(p.policy)
  const dict = new Map<number, number>()
  const entryBytes = new Map<number, number[]>()
  let next = first
  let genStart = 0

  let w = data[0]
  let wStart = 0
  let wLen = 1
  const base = { prevStart: 0, prevLen: 0, prevCode: -1, found: -1, added: null, cleared: false, frozen: false }
  steps.push({ kind: 'start', i: 0, wStart, wLen, wCode: w, ...base, codesLen: 0, genStart, logLen: 0, next })

  for (let i = 1; i < n; i++) {
    const c = data[i]
    const key = w * 256 + c
    const hit = dict.get(key)
    if (hit !== undefined) {
      const prev = { prevStart: wStart, prevLen: wLen, prevCode: w }
      w = hit
      wLen++
      steps.push({ kind: 'extend', i, wStart, wLen, wCode: w, ...prev, found: hit, added: null, cleared: false, frozen: false, codesLen: codes.length, genStart, logLen: log.length, next })
      continue
    }
    const prev = { prevStart: wStart, prevLen: wLen, prevCode: w }
    codes.push({ code: w, width: widthFor(next - 1, p.maxWidth), start: wStart, len: wLen })
    let added: Entry | null = null
    let cleared = false
    let frozen = false
    if (next < limit) {
      const bytes = (w < 256 ? [w] : entryBytes.get(w)!).concat(c)
      dict.set(key, next)
      entryBytes.set(next, bytes)
      added = { code: next, bytes }
      log.push(added)
      next++
    } else if (p.policy === 'reset') {
      codes.push({ code: CLEAR, width: widthFor(next - 1, p.maxWidth), start: i, len: 0 })
      dict.clear()
      entryBytes.clear()
      next = first
      genStart = log.length
      cleared = true
    } else {
      frozen = true
    }
    w = c
    wStart = i
    wLen = 1
    steps.push({ kind: 'emit', i, wStart, wLen, wCode: w, ...prev, found: -1, added, cleared, frozen, codesLen: codes.length, genStart, logLen: log.length, next })
  }
  codes.push({ code: w, width: widthFor(next - 1, p.maxWidth), start: wStart, len: wLen })
  steps.push({
    kind: 'flush',
    i: -1,
    wStart,
    wLen,
    wCode: w,
    prevStart: wStart,
    prevLen: wLen,
    prevCode: w,
    found: -1,
    added: null,
    cleared: false,
    frozen: false,
    codesLen: codes.length,
    genStart,
    logLen: log.length,
    next,
  })
  return { steps, codes, log }
}

export interface DecStep {
  code: number
  width: number
  kind: 'first' | 'known' | 'kwkwk' | 'clear'
  /** Output range written by this code. */
  outStart: number
  outLen: number
  /** Previous code (−1 if none). */
  prev: number
  added: Entry | null
  genStart: number
  logLen: number
  next: number
}

export interface DecTrace {
  steps: DecStep[]
  out: number[]
  log: Entry[]
}

/** Decodes a list of codes, recording every step. Widths are recomputed, not taken from the input, and checked. */
export function decodeTrace(codes: { code: number; width?: number }[], p: LzwParams, n = Infinity): DecTrace {
  const limit = 1 << p.maxWidth
  const first = firstFree(p.policy)
  const table = new Map<number, number[]>()
  const out: number[] = []
  const log: Entry[] = []
  const steps: DecStep[] = []
  let next = first
  let prev = -1
  let genStart = 0
  const str = (code: number) => (code < 256 ? [code] : table.get(code))

  for (const { code, width: given } of codes) {
    if (out.length >= n) break
    const width = widthFor(prev >= 0 ? next : next - 1, p.maxWidth)
    if (given !== undefined && given !== width) throw new Error(`lzw: width mismatch at code ${steps.length}: encoder ${given}, decoder ${width}`)
    if (p.policy === 'reset' && code === CLEAR) {
      table.clear()
      next = first
      genStart = log.length
      steps.push({ code, width, kind: 'clear', outStart: out.length, outLen: 0, prev, added: null, genStart, logLen: log.length, next })
      prev = -1
      continue
    }
    let entry = str(code)
    let kind: DecStep['kind'] = prev < 0 ? 'first' : 'known'
    if (!entry) {
      if (code === next && prev >= 0) {
        const ps = str(prev)!
        entry = ps.concat(ps[0])
        kind = 'kwkwk'
      } else throw new Error(`lzw: bad code ${code} (next free ${next})`)
    }
    const outStart = out.length
    for (const b of entry) out.push(b)
    let added: Entry | null = null
    if (prev >= 0 && next < limit) {
      const bytes = str(prev)!.concat(entry[0])
      table.set(next, bytes)
      added = { code: next, bytes }
      log.push(added)
      next++
    }
    steps.push({ code, width, kind, outStart, outLen: entry.length, prev, added, genStart, logLen: log.length, next })
    prev = code
  }
  return { steps, out: n === Infinity ? out : out.slice(0, n), log }
}
