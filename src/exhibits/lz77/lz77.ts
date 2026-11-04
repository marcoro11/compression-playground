/**
 * LZ77 and LZSS parsing, with enough of a trace to replay every decision.
 *
 * Two token formats:
 *
 *  - `triple` — Ziv & Lempel (1977) as published: every token is
 *    ⟨offset, length, next⟩. A match of length 0 (offset 0) is how a brand-new
 *    byte gets in. The `next` byte is always sent, so a match may be at most
 *    (bytes remaining − 1) long.
 *  - `lzss` — Storer & Szymanski (1982), as popularised by Haruhiko Okumura's
 *    LZSS.C: a 1-bit flag, then either one literal byte or ⟨offset, length⟩,
 *    and a match is only used when it is at least `minMatch` long — shorter
 *    ones cost more than the literals they replace.
 *
 * The parse is greedy: at every position take the longest match in the
 * window, preferring the *closest* one on ties (smaller offsets are cheaper in
 * formats that code them with variable length, like DEFLATE). Matches may run
 * past the current position — offset < length — which is how a run gets coded.
 */

export type Format = 'triple' | 'lzss'

export interface Params {
  /** Search window size W: offsets run 1…W. */
  window: number
  /** Longest match (the lookahead buffer). */
  maxMatch: number
  /** LZSS only: shortest match worth sending. */
  minMatch: number
  format: Format
}

export type Token =
  | { kind: 'lit'; pos: number; byte: number }
  | { kind: 'match'; pos: number; offset: number; length: number }
  | { kind: 'triple'; pos: number; offset: number; length: number; next: number }

export interface Candidate {
  offset: number
  length: number
}

export interface ParseStep {
  token: Token
  /** Where the token starts in the input. */
  pos: number
  /** How many input bytes it covers. */
  covers: number
  /** Every window position that matches at least one byte, best first. */
  candidates: Candidate[]
  /** Total number of window positions examined. */
  examined: number
}

/** Bytes of input a token accounts for. */
export const covers = (t: Token): number => (t.kind === 'lit' ? 1 : t.kind === 'match' ? t.length : t.length + 1)

/** Length of the match between data[j…] and data[i…], capped at `cap`. May overlap (j + len > i). */
export function matchLength(data: ArrayLike<number>, j: number, i: number, cap: number): number {
  let k = 0
  while (k < cap && data[j + k] === data[i + k]) k++
  return k
}

/** Greedy parse, examining every window position (the picture, not the fast path). */
export function parse(data: ArrayLike<number>, p: Params): ParseStep[] {
  const n = data.length
  const steps: ParseStep[] = []
  let i = 0
  while (i < n) {
    // Triples must leave a byte for `next`.
    const cap = p.format === 'triple' ? Math.min(p.maxMatch, n - i - 1) : Math.min(p.maxMatch, n - i)
    const candidates: Candidate[] = []
    let examined = 0
    let best: Candidate = { offset: 0, length: 0 }
    const lo = Math.max(0, i - p.window)
    // Closest first, so a strict `>` keeps the nearest of equal-length matches.
    for (let j = i - 1; j >= lo; j--) {
      examined++
      if (data[j] !== data[i]) continue
      const len = matchLength(data, j, i, Math.max(cap, 0))
      const c = { offset: i - j, length: len }
      if (len > 0) candidates.push(c)
      if (len > best.length) best = c
    }
    candidates.sort((a, b) => b.length - a.length || a.offset - b.offset)

    let token: Token
    if (p.format === 'triple') {
      token = best.length > 0 ? { kind: 'triple', pos: i, offset: best.offset, length: best.length, next: data[i + best.length] } : { kind: 'triple', pos: i, offset: 0, length: 0, next: data[i] }
    } else {
      token = best.length >= p.minMatch ? { kind: 'match', pos: i, offset: best.offset, length: best.length } : { kind: 'lit', pos: i, byte: data[i] }
    }
    const c = covers(token)
    steps.push({ token, pos: i, covers: c, candidates, examined })
    i += c
  }
  return steps
}

/** ⌈log₂ x⌉, with 0 for x ≤ 1. */
export const bitsFor = (x: number): number => (x <= 1 ? 0 : Math.ceil(Math.log2(x)))

/**
 * The fixed-width field layout used for the bit counts on the page:
 *
 *   triple:  offset ⌈log₂(W+1)⌉ | length ⌈log₂(maxMatch+1)⌉ | next 8
 *   lzss:    flag 1 | literal 8                        (flag 0)
 *            flag 1 | offset−1 ⌈log₂W⌉ | length−min ⌈log₂(maxMatch−min+1)⌉   (flag 1)
 */
export function layout(p: Params) {
  if (p.format === 'triple') {
    const off = bitsFor(p.window + 1)
    const len = bitsFor(p.maxMatch + 1)
    return { off, len, lit: 8, flag: 0, matchBits: off + len + 8, litBits: off + len + 8 }
  }
  const off = bitsFor(p.window)
  const len = bitsFor(p.maxMatch - p.minMatch + 1)
  return { off, len, lit: 8, flag: 1, matchBits: 1 + off + len, litBits: 9 }
}

export function tokenBits(t: Token, p: Params): number {
  const l = layout(p)
  return t.kind === 'lit' ? l.litBits : l.matchBits
}

/** Field-by-field bits of a token, for the coloured bitstream. */
export function tokenFields(t: Token, p: Params): { bits: string; label: string; kind: string }[] {
  const l = layout(p)
  const bin = (v: number, w: number) => (w <= 0 ? '' : v.toString(2).padStart(w, '0'))
  if (t.kind === 'triple') {
    return [
      { bits: bin(t.offset, l.off), label: `offset ${t.offset}`, kind: 'off' },
      { bits: bin(t.length, l.len), label: `length ${t.length}`, kind: 'len' },
      { bits: bin(t.next, 8), label: `next byte ${t.next}`, kind: 'lit' },
    ]
  }
  if (t.kind === 'lit') {
    return [
      { bits: '0', label: 'flag: literal', kind: 'flag' },
      { bits: bin(t.byte, 8), label: `literal ${t.byte}`, kind: 'lit' },
    ]
  }
  return [
    { bits: '1', label: 'flag: match', kind: 'flag' },
    { bits: bin(t.offset - 1, l.off), label: `offset ${t.offset} (stored as ${t.offset - 1})`, kind: 'off' },
    { bits: bin(t.length - p.minMatch, l.len), label: `length ${t.length} (stored as ${t.length - p.minMatch})`, kind: 'len' },
  ]
}

/** One byte of decoder output: where it came from. */
export interface DecodeStep {
  /** Index of the token producing this byte. */
  token: number
  /** Output position written. */
  at: number
  byte: number
  /** Output position copied from, or −1 for a literal / next byte. */
  from: number
  /** k-th byte of this token's copy (0-based), and the copy length. */
  k: number
  of: number
}

/** Replays the decoder one output byte at a time. */
export function decodeTrace(tokens: Token[]): { out: number[]; steps: DecodeStep[] } {
  const out: number[] = []
  const steps: DecodeStep[] = []
  tokens.forEach((t, ti) => {
    if (t.kind === 'lit') {
      steps.push({ token: ti, at: out.length, byte: t.byte, from: -1, k: 0, of: 1 })
      out.push(t.byte)
      return
    }
    const start = out.length - t.offset
    for (let k = 0; k < t.length; k++) {
      const b = out[start + k]
      steps.push({ token: ti, at: out.length, byte: b, from: start + k, k, of: t.length })
      out.push(b)
    }
    if (t.kind === 'triple') {
      steps.push({ token: ti, at: out.length, byte: t.next, from: -1, k: t.length, of: t.length })
      out.push(t.next)
    }
  })
  return { out, steps }
}
