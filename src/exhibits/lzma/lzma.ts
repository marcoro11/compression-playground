/**
 * LZMA, from scratch — the .lzma ("LZMA_Alone") format that `xz --format=lzma`
 * reads and writes.
 *
 *   byte 0      properties: (pb·5 + lp)·9 + lc
 *   bytes 1–4   dictionary size, little-endian
 *   bytes 5–12  uncompressed size, little-endian; all ones = unknown, end marker follows
 *   bytes 13…   the range-coded stream
 *
 * The coder never sees a byte as such. Everything it emits is a *binary decision*
 * — "is this a match?", "is the next bit of the literal a 1?" — and every
 * decision has its own 11-bit probability, chosen by context (the state machine,
 * the position, the previous byte, the bits of the literal so far). Each
 * probability starts at ½ and drifts 1/32 of the way towards whatever happened.
 * The range coder then spends −log₂p bits on a decision that came out the way
 * the probability expected, which can be a small fraction of one bit.
 *
 * The structure follows Igor Pavlov's LzmaSpec.cpp (the reference decoder in the
 * LZMA SDK) closely enough that the names line up: IsMatch, IsRep, IsRepG0…,
 * PosSlot, PosDecoders (here `posSpecial`), Align, the two length coders.
 */

// --------------------------------------------------------------------- constants

export const PROB_BITS = 11
export const PROB_INIT = 1 << (PROB_BITS - 1) // 1024 = ½
export const MOVE_BITS = 5
const TOP = 1 << 24
export const NUM_STATES = 12
const POS_BITS_MAX = 4
const NUM_LEN_TO_POS_STATES = 4
const END_POS_MODEL_INDEX = 14
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1) // 128
const NUM_ALIGN_BITS = 4
export const MATCH_MIN_LEN = 2
export const MATCH_MAX_LEN = 273

// --------------------------------------------------------------------- state machine

/** States 0–6 follow a literal ("literal states"); 7–11 follow a match, rep or short rep. */
export const isLiteralState = (s: number) => s < 7
export const nextLiteral = (s: number) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6)
export const nextMatch = (s: number) => (s < 7 ? 7 : 10)
export const nextRep = (s: number) => (s < 7 ? 8 : 11)
export const nextShortRep = (s: number) => (s < 7 ? 9 : 11)

/** What each state means: the last two packet kinds, newest last. */
export const STATE_NAMES = [
  'LIT LIT LIT',
  'MATCH LIT LIT',
  'REP LIT LIT / SHORTREP LIT LIT',
  'SHORTREP LIT LIT',
  'MATCH LIT',
  'REP LIT',
  'SHORTREP LIT',
  'LIT MATCH',
  'LIT REP',
  'LIT SHORTREP',
  'non-lit MATCH',
  'non-lit REP',
]

// --------------------------------------------------------------------- probabilities

/** Cost in bits of coding `bit` with probability-of-zero p/2048. */
export function price(p: number, bit: number): number {
  const p0 = p / (1 << PROB_BITS)
  return -Math.log2(bit ? 1 - p0 : p0)
}

/** The adaptation rule: move 1/32 of the remaining distance towards what happened. */
export function updated(p: number, bit: number): number {
  return bit ? p - (p >> MOVE_BITS) : p + (((1 << PROB_BITS) - p) >> MOVE_BITS)
}

const probs = (n: number) => new Uint16Array(n).fill(PROB_INIT)

class LenModel {
  choice = probs(2) // [0] = choice, [1] = choice2
  low = probs(16 << 3)
  mid = probs(16 << 3)
  high = probs(256)
}

export interface Props {
  lc: number
  lp: number
  pb: number
}

export class Model {
  isMatch = probs(NUM_STATES << POS_BITS_MAX)
  isRep = probs(NUM_STATES)
  isRepG0 = probs(NUM_STATES)
  isRepG1 = probs(NUM_STATES)
  isRepG2 = probs(NUM_STATES)
  isRep0Long = probs(NUM_STATES << POS_BITS_MAX)
  posSlot = probs(NUM_LEN_TO_POS_STATES << 6)
  posSpecial = probs(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
  align = probs(1 << NUM_ALIGN_BITS)
  lenModel = new LenModel()
  repLenModel = new LenModel()
  literal: Uint16Array
  constructor(readonly props: Props) {
    this.literal = probs(0x300 << (props.lc + props.lp))
  }
  litBase(pos: number, prevByte: number): number {
    const { lc, lp } = this.props
    return 0x300 * (((pos & ((1 << lp) - 1)) << lc) + (prevByte >> (8 - lc)))
  }
}

/** Distance slot for a 0-based distance (distance − 1). */
export function posSlotOf(dist0: number): number {
  if (dist0 < 4) return dist0
  const n = 31 - Math.clz32(dist0)
  return 2 * n + ((dist0 >>> (n - 1)) & 1)
}

export function propsByte(p: Props): number {
  return (p.pb * 5 + p.lp) * 9 + p.lc
}

export function parseProps(b: number): Props {
  if (b >= 9 * 5 * 5) throw new Error('lzma: invalid properties byte')
  const lc = b % 9
  const rest = Math.floor(b / 9)
  return { lc, lp: rest % 5, pb: Math.floor(rest / 5) }
}

// --------------------------------------------------------------------- range encoder

export class RangeEncoder {
  /** Up to 33 bits: the 33rd is the carry that has not reached the output yet. */
  low = 0
  range = 0xffffffff
  /** The last byte held back, because a carry could still change it. */
  cache = 0
  /** cache plus the run of 0xFF bytes behind it that a carry would also ripple through. */
  cacheSize = 1
  out: number[] = []

  encodeBit(pr: Uint16Array, i: number, bit: number): void {
    const p = pr[i]
    const bound = (this.range >>> PROB_BITS) * p
    if (bit === 0) {
      this.range = bound
      pr[i] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS)
    } else {
      this.low += bound
      this.range -= bound
      pr[i] = p - (p >> MOVE_BITS)
    }
    while (this.range < TOP) {
      this.range = this.range * 256
      this.shiftLow()
    }
  }

  encodeDirect(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.range = this.range >>> 1
      if (Math.floor(value / 2 ** i) & 1) this.low += this.range
      while (this.range < TOP) {
        this.range = this.range * 256
        this.shiftLow()
      }
    }
  }

  shiftLow(): void {
    const lo32 = this.low % 0x100000000
    const carry = this.low >= 0x100000000 ? 1 : 0
    if (lo32 < 0xff000000 || carry) {
      let temp = this.cache
      do {
        this.out.push((temp + carry) & 0xff)
        temp = 0xff
      } while (--this.cacheSize !== 0)
      this.cache = lo32 >>> 24
    }
    this.cacheSize++
    this.low = (lo32 & 0x00ffffff) * 256
  }

  flush(): void {
    for (let i = 0; i < 5; i++) this.shiftLow()
  }
}

// --------------------------------------------------------------------- range decoder

export class RangeDecoder {
  range = 0xffffffff
  code = 0
  overrun = false
  constructor(
    private readonly data: Uint8Array,
    public pos: number,
  ) {
    if (data[pos] !== 0) throw new Error('lzma: first byte of the range-coded stream must be 0')
    this.pos++
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.next()
    if (this.code === this.range) throw new Error('lzma: corrupt stream start')
  }
  private next(): number {
    if (this.pos >= this.data.length) {
      this.overrun = true
      return 0
    }
    return this.data[this.pos++]
  }
  private normalize(): void {
    if (this.range < TOP) {
      this.range = this.range * 256
      this.code = this.code * 256 + this.next()
    }
  }
  decodeBit(pr: Uint16Array, i: number): number {
    const p = pr[i]
    const bound = (this.range >>> PROB_BITS) * p
    let bit: number
    if (this.code < bound) {
      this.range = bound
      pr[i] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS)
      bit = 0
    } else {
      this.code -= bound
      this.range -= bound
      pr[i] = p - (p >> MOVE_BITS)
      bit = 1
    }
    this.normalize()
    return bit
  }
  decodeDirect(count: number): number {
    let res = 0
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1
      let b = 0
      if (this.code >= this.range) {
        this.code -= this.range
        b = 1
      }
      res = res * 2 + b
      this.normalize()
    }
    return res
  }
  get finishedOK(): boolean {
    return this.code === 0
  }
}

// --------------------------------------------------------------------- tracing

export type BitKind = 'flag' | 'literal' | 'matched' | 'len' | 'slot' | 'dist' | 'direct' | 'align'

export interface CodedBit {
  label: string
  kind: BitKind
  bit: number
  /** Probability of a 0 before coding (11-bit), or null for a direct (p = ½, no model) bit. */
  p: number | null
  pAfter: number | null
  cost: number
  /** Range coder registers right after this bit. */
  low: number
  range: number
  out: number
  /** The held-back byte and how many bytes (it plus 0xFF run) a carry could still change. */
  cache: number
  pending: number
}

export type PacketKind = 'LIT' | 'MATCH' | 'SHORTREP' | 'REP0' | 'REP1' | 'REP2' | 'REP3' | 'END'

export interface Packet {
  kind: PacketKind
  pos: number
  /** Bytes this packet produces (1 for LIT / SHORTREP, 0 for END). */
  len: number
  /** Real distance back (1 = previous byte), 0 for a literal. */
  dist: number
  byte?: number
  /** For literals after a match: the byte at rep0, which the literal coder compares against. */
  matchByte?: number
  stateBefore: number
  stateAfter: number
  repsBefore: number[]
  repsAfter: number[]
  posState: number
  why: string
  bits: CodedBit[]
  outBefore: number
  outAfter: number
}

// --------------------------------------------------------------------- encoder

export interface EncodeOptions extends Props {
  dictSize?: number
  /** Write an end marker and an unknown size (what `xz --format=lzma` does). */
  endMarker?: boolean
  maxChain?: number
  nice?: number
  /** Look one byte ahead before committing to a match. */
  lazy?: boolean
  /** Record a full trace (for the step-through). */
  record?: boolean
}

export interface EncodeResult {
  bytes: Uint8Array
  /** The range-coded body as it was emitted, before the header was prepended. */
  body: Uint8Array
  header: Uint8Array
  packets: Packet[]
  /** Bits spent by packet kind, from the model's own prices. */
  bitsByKind: Record<PacketKind, number>
  countByKind: Record<PacketKind, number>
}

export const DEFAULT_PROPS: Props = { lc: 3, lp: 0, pb: 2 }

export function encode(data: Uint8Array, opts: Partial<EncodeOptions> = {}): EncodeResult {
  const props: Props = { lc: opts.lc ?? 3, lp: opts.lp ?? 0, pb: opts.pb ?? 2 }
  const dictSize = Math.max(4096, opts.dictSize ?? 1 << 20)
  const endMarker = opts.endMarker ?? false
  const maxChain = opts.maxChain ?? 48
  const nice = Math.min(MATCH_MAX_LEN, opts.nice ?? 64)
  const lazy = opts.lazy ?? true
  const record = opts.record ?? false
  const n = data.length
  const m = new Model(props)
  const rc = new RangeEncoder()
  const pbMask = (1 << props.pb) - 1

  const packets: Packet[] = []
  const kinds: PacketKind[] = ['LIT', 'MATCH', 'SHORTREP', 'REP0', 'REP1', 'REP2', 'REP3', 'END']
  const bitsByKind = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<PacketKind, number>
  const countByKind = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<PacketKind, number>
  let curBits: CodedBit[] = []
  let curCost = 0

  const bit = (pr: Uint16Array, i: number, b: number, label: string, kind: BitKind) => {
    const p = pr[i]
    const c = price(p, b)
    curCost += c
    rc.encodeBit(pr, i, b)
    if (record) curBits.push({ label, kind, bit: b, p, pAfter: pr[i], cost: c, low: rc.low, range: rc.range, out: rc.out.length, cache: rc.cache, pending: rc.cacheSize })
  }
  const direct = (value: number, count: number, label: string) => {
    if (!record) {
      rc.encodeDirect(value, count)
      curCost += count
      return
    }
    for (let i = count - 1; i >= 0; i--) {
      const b = Math.floor(value / 2 ** i) & 1
      rc.encodeDirect(b, 1)
      curCost += 1
      curBits.push({ label: `${label} bit ${i}`, kind: 'direct', bit: b, p: null, pAfter: null, cost: 1, low: rc.low, range: rc.range, out: rc.out.length, cache: rc.cache, pending: rc.cacheSize })
    }
  }
  const tree = (pr: Uint16Array, base: number, nbits: number, value: number, label: string, kind: BitKind) => {
    let mm = 1
    for (let i = nbits - 1; i >= 0; i--) {
      const b = (value >>> i) & 1
      bit(pr, base + mm, b, `${label} bit ${i}`, kind)
      mm = (mm << 1) | b
    }
  }
  const reverseTree = (pr: Uint16Array, base: number, nbits: number, value: number, label: string, kind: BitKind) => {
    let mm = 1
    for (let i = 0; i < nbits; i++) {
      const b = (value >>> i) & 1
      bit(pr, base + mm, b, `${label} bit ${i}`, kind)
      mm = (mm << 1) | b
    }
  }
  const encodeLen = (lm: LenModel, len0: number, posState: number, label: string) => {
    if (len0 < 8) {
      bit(lm.choice, 0, 0, `${label}: choice (0 = 2–9)`, 'len')
      tree(lm.low, posState << 3, 3, len0, `${label} low`, 'len')
    } else if (len0 < 16) {
      bit(lm.choice, 0, 1, `${label}: choice (1 = 10+)`, 'len')
      bit(lm.choice, 1, 0, `${label}: choice2 (0 = 10–17)`, 'len')
      tree(lm.mid, posState << 3, 3, len0 - 8, `${label} mid`, 'len')
    } else {
      bit(lm.choice, 0, 1, `${label}: choice (1 = 10+)`, 'len')
      bit(lm.choice, 1, 1, `${label}: choice2 (1 = 18–273)`, 'len')
      tree(lm.high, 0, 8, len0 - 16, `${label} high`, 'len')
    }
  }
  const encodeDist = (dist0: number, len0: number) => {
    const lenState = Math.min(len0, NUM_LEN_TO_POS_STATES - 1)
    const slot = posSlotOf(dist0)
    tree(m.posSlot, lenState << 6, 6, slot, `distance slot ${slot}`, 'slot')
    if (slot >= 4) {
      const footer = (slot >>> 1) - 1
      const base = (2 | (slot & 1)) * 2 ** footer
      const reduced = dist0 - base
      if (slot < END_POS_MODEL_INDEX) {
        reverseTree(m.posSpecial, base - slot, footer, reduced, 'distance low', 'dist')
      } else {
        direct(Math.floor(reduced / 16), footer - NUM_ALIGN_BITS, 'distance direct')
        reverseTree(m.align, 0, NUM_ALIGN_BITS, reduced & 15, 'distance align', 'align')
      }
    }
  }
  /** Price of the literal at pos with the current model (for the shortrep decision). */
  const literalPrice = (pos: number, state: number, rep0: number): number => {
    const base = m.litBase(pos, pos > 0 ? data[pos - 1] : 0)
    const b = data[pos]
    let sym = 1
    let cost = 0
    let i = 7
    if (!isLiteralState(state) && pos - rep0 - 1 >= 0) {
      const mb = data[pos - rep0 - 1]
      for (; i >= 0; i--) {
        const matchBit = (mb >>> i) & 1
        const bb = (b >>> i) & 1
        cost += price(m.literal[base + ((1 + matchBit) << 8) + sym], bb)
        sym = (sym << 1) | bb
        if (matchBit !== bb) {
          i--
          break
        }
      }
    }
    for (; i >= 0; i--) {
      const bb = (b >>> i) & 1
      cost += price(m.literal[base + sym], bb)
      sym = (sym << 1) | bb
    }
    return cost
  }

  // ---- match finding: hash chains over 3-byte prefixes
  const HASH = 1 << 16
  const head = new Int32Array(HASH).fill(-1)
  const prev = new Int32Array(Math.max(1, n)).fill(-1)
  const hash3 = (i: number) => ((data[i] * 506832829) ^ (data[i + 1] << 8) ^ data[i + 2]) & (HASH - 1)
  let inserted = 0
  const insertUpTo = (end: number) => {
    for (; inserted < end; inserted++) {
      if (inserted + 2 >= n) continue
      const h = hash3(inserted)
      prev[inserted] = head[h]
      head[h] = inserted
    }
  }
  const matchLen = (pos: number, dist: number, avail: number) => {
    let l = 0
    const s = pos - dist
    while (l < avail && data[s + l] === data[pos + l]) l++
    return l
  }
  const findMain = (pos: number): { len: number; dist: number } => {
    const avail = Math.min(MATCH_MAX_LEN, n - pos)
    if (avail < 3) return { len: 0, dist: 0 }
    insertUpTo(pos)
    let best = 0
    let bestDist = 0
    let cand = head[hash3(pos)]
    let chain = maxChain
    while (cand >= 0 && pos - cand <= dictSize && chain-- > 0) {
      if (data[cand + best] === data[pos + best]) {
        const l = matchLen(pos, pos - cand, avail)
        if (l > best) {
          best = l
          bestDist = pos - cand
          if (l >= nice) break
        }
      }
      cand = prev[cand]
    }
    return best >= 3 ? { len: best, dist: bestDist } : { len: 0, dist: 0 }
  }

  // ---- the parse
  let state = 0
  let reps = [0, 0, 0, 0] // 0-based distances (distance − 1), as in the spec
  let pos = 0

  const begin = () => {
    curBits = []
    curCost = 0
    return rc.out.length
  }
  const finish = (pk: Omit<Packet, 'bits' | 'outAfter'>, kind: PacketKind) => {
    bitsByKind[kind] += curCost
    countByKind[kind]++
    if (record) packets.push({ ...pk, bits: curBits, outAfter: rc.out.length })
  }

  while (pos < n) {
    const posState = pos & pbMask
    const avail = Math.min(MATCH_MAX_LEN, n - pos)
    const stateBefore = state
    const repsBefore = reps.map((r) => r + 1)

    // Candidates: the four remembered distances, then a fresh search.
    let repIdx = -1
    let repLen = 0
    const repLens: number[] = []
    for (let r = 0; r < 4; r++) {
      const d = reps[r] + 1
      const l = d <= pos ? matchLen(pos, d, avail) : 0
      repLens.push(l)
      if (l > repLen) {
        repLen = l
        repIdx = r
      }
    }
    const main = findMain(pos)

    let choice: 'lit' | 'match' | 'rep' | 'shortrep' = 'lit'
    let why = ''
    if (repLen >= 2 && (repLen >= nice || repLen + 1 >= main.len || (repLen + 2 >= main.len && main.dist >= 512) || (repLen + 3 >= main.len && main.dist >= 32768))) {
      choice = 'rep'
      why =
        main.len > repLen
          ? `rep${repIdx} (distance ${reps[repIdx] + 1}) repeats ${repLen} bytes; a fresh match of ${main.len} at distance ${main.dist} is not worth the extra distance bits.`
          : `rep${repIdx} — distance ${reps[repIdx] + 1}, used recently — repeats ${repLen} bytes${main.len ? ` (a fresh search found no more: ${main.len})` : ''}. Naming one of four remembered distances costs a few bits; a new distance costs many.`
    } else if (main.len >= 3 && !(main.len === 3 && main.dist >= 1 << 14)) {
      let take = true
      if (lazy && main.len < nice && pos + 1 < n) {
        const next = findMain(pos + 1)
        if (next.len > main.len + 1 || (next.len === main.len + 1 && next.dist < main.dist >> 3)) {
          take = false
          why = `A match of ${main.len} starts here, but one byte later there is a match of ${next.len} — so send this byte as a literal and take the longer one (lazy matching).`
        }
      }
      if (take) {
        choice = 'match'
        why = `No remembered distance helps${repLen ? ` (best rep gives ${repLen})` : ''}; the hash chain found ${main.len} bytes at distance ${main.dist}.`
      }
    }
    if (choice === 'lit' && pos > 0 && reps[0] + 1 <= pos && data[pos] === data[pos - reps[0] - 1]) {
      const pLit = price(m.isMatch[(state << POS_BITS_MAX) + posState], 0) + literalPrice(pos, state, reps[0])
      const pShort =
        price(m.isMatch[(state << POS_BITS_MAX) + posState], 1) +
        price(m.isRep[state], 1) +
        price(m.isRepG0[state], 0) +
        price(m.isRep0Long[(state << POS_BITS_MAX) + posState], 0)
      if (pShort < pLit) {
        choice = 'shortrep'
        why = `No useful match, but this byte equals the one at rep0 (distance ${reps[0] + 1}). With today's probabilities a short rep costs ${pShort.toFixed(2)} bits against ${pLit.toFixed(2)} for the literal.`
      } else if (!why) {
        why = `The byte at rep0 matches, but the literal is cheaper right now (${pLit.toFixed(2)} vs ${pShort.toFixed(2)} bits for a short rep).`
      }
    }

    const outBefore = begin()
    if (choice === 'lit') {
      if (!why) why = main.len ? `Only a ${main.len}-byte match far away (distance ${main.dist}) — not worth it.` : 'No earlier copy of what comes next is long enough to pay for itself, and no remembered distance fits: send the byte.'
      bit(m.isMatch, (state << POS_BITS_MAX) + posState, 0, 'isMatch → literal', 'flag')
      const base = m.litBase(pos, pos > 0 ? data[pos - 1] : 0)
      const b = data[pos]
      let sym = 1
      let i = 7
      let matchByte: number | undefined
      if (!isLiteralState(state)) {
        matchByte = data[pos - reps[0] - 1]
        for (; i >= 0; i--) {
          const matchBit = (matchByte >>> i) & 1
          const bb = (b >>> i) & 1
          bit(m.literal, base + ((1 + matchBit) << 8) + sym, bb, `literal bit ${i} (rep0 byte has ${matchBit})`, 'matched')
          sym = (sym << 1) | bb
          if (matchBit !== bb) {
            i--
            break
          }
        }
      }
      for (; i >= 0; i--) {
        const bb = (b >>> i) & 1
        bit(m.literal, base + sym, bb, `literal bit ${i}`, 'literal')
        sym = (sym << 1) | bb
      }
      state = nextLiteral(state)
      finish({ kind: 'LIT', pos, len: 1, dist: 0, byte: b, matchByte, stateBefore, stateAfter: state, repsBefore, repsAfter: reps.map((r) => r + 1), posState, why, outBefore }, 'LIT')
      pos += 1
    } else if (choice === 'shortrep') {
      bit(m.isMatch, (state << POS_BITS_MAX) + posState, 1, 'isMatch → not a literal', 'flag')
      bit(m.isRep, state, 1, 'isRep → a remembered distance', 'flag')
      bit(m.isRepG0, state, 0, 'isRepG0 → rep0', 'flag')
      bit(m.isRep0Long, (state << POS_BITS_MAX) + posState, 0, 'isRep0Long → just one byte', 'flag')
      state = nextShortRep(state)
      finish({ kind: 'SHORTREP', pos, len: 1, dist: reps[0] + 1, byte: data[pos], stateBefore, stateAfter: state, repsBefore, repsAfter: reps.map((r) => r + 1), posState, why, outBefore }, 'SHORTREP')
      pos += 1
    } else if (choice === 'rep') {
      bit(m.isMatch, (state << POS_BITS_MAX) + posState, 1, 'isMatch → not a literal', 'flag')
      bit(m.isRep, state, 1, 'isRep → a remembered distance', 'flag')
      if (repIdx === 0) {
        bit(m.isRepG0, state, 0, 'isRepG0 → rep0', 'flag')
        bit(m.isRep0Long, (state << POS_BITS_MAX) + posState, 1, 'isRep0Long → a run, not one byte', 'flag')
      } else {
        bit(m.isRepG0, state, 1, 'isRepG0 → not rep0', 'flag')
        const d = reps[repIdx]
        if (repIdx === 1) {
          bit(m.isRepG1, state, 0, 'isRepG1 → rep1', 'flag')
        } else {
          bit(m.isRepG1, state, 1, 'isRepG1 → rep2 or rep3', 'flag')
          bit(m.isRepG2, state, repIdx === 3 ? 1 : 0, repIdx === 3 ? 'isRepG2 → rep3' : 'isRepG2 → rep2', 'flag')
          if (repIdx === 3) reps[3] = reps[2]
          reps[2] = reps[1]
        }
        reps[1] = reps[0]
        reps[0] = d
      }
      encodeLen(m.repLenModel, repLen - MATCH_MIN_LEN, posState, 'rep length')
      state = nextRep(state)
      const kind = ('REP' + repIdx) as PacketKind
      finish({ kind, pos, len: repLen, dist: reps[0] + 1, stateBefore, stateAfter: state, repsBefore, repsAfter: reps.map((r) => r + 1), posState, why, outBefore }, kind)
      pos += repLen
    } else {
      bit(m.isMatch, (state << POS_BITS_MAX) + posState, 1, 'isMatch → not a literal', 'flag')
      bit(m.isRep, state, 0, 'isRep → a new distance', 'flag')
      const len0 = main.len - MATCH_MIN_LEN
      encodeLen(m.lenModel, len0, posState, 'length')
      encodeDist(main.dist - 1, len0)
      reps = [main.dist - 1, reps[0], reps[1], reps[2]]
      state = nextMatch(state)
      finish({ kind: 'MATCH', pos, len: main.len, dist: main.dist, stateBefore, stateAfter: state, repsBefore, repsAfter: reps.map((r) => r + 1), posState, why, outBefore }, 'MATCH')
      pos += main.len
    }
  }

  if (endMarker) {
    const posState = pos & pbMask
    const stateBefore = state
    const repsBefore = reps.map((r) => r + 1)
    const outBefore = begin()
    bit(m.isMatch, (state << POS_BITS_MAX) + posState, 1, 'isMatch → not a literal', 'flag')
    bit(m.isRep, state, 0, 'isRep → a new distance', 'flag')
    encodeLen(m.lenModel, 0, posState, 'length')
    encodeDist(0xffffffff, 0)
    state = nextMatch(state)
    finish(
      {
        kind: 'END',
        pos,
        len: 0,
        dist: 0,
        stateBefore,
        stateAfter: state,
        repsBefore,
        repsAfter: repsBefore,
        posState,
        why: 'The end marker: a match whose distance is 2³² — all ones — which no real match can have.',
        outBefore,
      },
      'END',
    )
  }
  rc.flush()

  const header = new Uint8Array(13)
  header[0] = propsByte(props)
  header[1] = dictSize & 0xff
  header[2] = (dictSize >>> 8) & 0xff
  header[3] = (dictSize >>> 16) & 0xff
  header[4] = (dictSize >>> 24) & 0xff
  if (endMarker) header.fill(0xff, 5, 13)
  else {
    let s = n
    for (let i = 5; i < 13; i++) {
      header[i] = s % 256
      s = Math.floor(s / 256)
    }
  }
  const bytes = new Uint8Array(13 + rc.out.length)
  bytes.set(header, 0)
  bytes.set(rc.out, 13)
  return { bytes, body: Uint8Array.from(rc.out), header, packets, bitsByKind, countByKind }
}

// --------------------------------------------------------------------- decoder

export interface Header {
  props: Props
  dictSize: number
  /** −1 when unknown (an end marker must follow). */
  size: number
}

export function parseHeader(b: Uint8Array): Header {
  if (b.length < 13) throw new Error('lzma: truncated header')
  const props = parseProps(b[0])
  const dictSize = (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0
  let unknown = true
  for (let i = 5; i < 13; i++) if (b[i] !== 0xff) unknown = false
  let size = -1
  if (!unknown) {
    size = 0
    for (let i = 12; i >= 5; i--) size = size * 256 + b[i]
  }
  return { props, dictSize, size }
}

export function decode(input: Uint8Array): Uint8Array {
  const h = parseHeader(input)
  const { props } = h
  const m = new Model(props)
  const rc = new RangeDecoder(input, 13)
  const pbMask = (1 << props.pb) - 1
  const known = h.size >= 0
  let out = new Uint8Array(known ? h.size : 1024)
  let n = 0
  const push = (b: number) => {
    if (n === out.length) {
      const bigger = new Uint8Array(out.length * 2)
      bigger.set(out)
      out = bigger
    }
    out[n++] = b
  }

  const tree = (pr: Uint16Array, base: number, nbits: number) => {
    let mm = 1
    for (let i = 0; i < nbits; i++) mm = (mm << 1) | rc.decodeBit(pr, base + mm)
    return mm - (1 << nbits)
  }
  const reverseTree = (pr: Uint16Array, base: number, nbits: number) => {
    let mm = 1
    let sym = 0
    for (let i = 0; i < nbits; i++) {
      const b = rc.decodeBit(pr, base + mm)
      mm = (mm << 1) | b
      sym |= b << i
    }
    return sym
  }
  const decodeLen = (lm: LenModel, posState: number) => {
    if (rc.decodeBit(lm.choice, 0) === 0) return tree(lm.low, posState << 3, 3)
    if (rc.decodeBit(lm.choice, 1) === 0) return 8 + tree(lm.mid, posState << 3, 3)
    return 16 + tree(lm.high, 0, 8)
  }
  const decodeDist = (len0: number) => {
    const lenState = Math.min(len0, NUM_LEN_TO_POS_STATES - 1)
    const slot = tree(m.posSlot, lenState << 6, 6)
    if (slot < 4) return slot
    const footer = (slot >>> 1) - 1
    let dist = (2 | (slot & 1)) * 2 ** footer
    if (slot < END_POS_MODEL_INDEX) dist += reverseTree(m.posSpecial, dist - slot, footer)
    else {
      dist += rc.decodeDirect(footer - NUM_ALIGN_BITS) * 16
      dist += reverseTree(m.align, 0, NUM_ALIGN_BITS)
    }
    return dist
  }

  let state = 0
  let rep0 = 0
  let rep1 = 0
  let rep2 = 0
  let rep3 = 0
  for (;;) {
    if (known && n === h.size) {
      // A known-size stream may still carry an end marker; a clean finish needs code = 0.
      if (rc.finishedOK) break
    }
    const posState = n & pbMask
    if (rc.decodeBit(m.isMatch, (state << POS_BITS_MAX) + posState) === 0) {
      if (known && n >= h.size) throw new Error('lzma: data after the declared size')
      const base = m.litBase(n, n > 0 ? out[n - 1] : 0)
      let sym = 1
      if (!isLiteralState(state)) {
        let mb = out[n - rep0 - 1]
        do {
          const matchBit = (mb >>> 7) & 1
          mb <<= 1
          const b = rc.decodeBit(m.literal, base + ((1 + matchBit) << 8) + sym)
          sym = (sym << 1) | b
          if (matchBit !== b) break
        } while (sym < 0x100)
      }
      while (sym < 0x100) sym = (sym << 1) | rc.decodeBit(m.literal, base + sym)
      push(sym & 0xff)
      state = nextLiteral(state)
      continue
    }
    let len: number
    if (rc.decodeBit(m.isRep, state) !== 0) {
      if (n === 0) throw new Error('lzma: rep match at the start of the stream')
      if (rc.decodeBit(m.isRepG0, state) === 0) {
        if (rc.decodeBit(m.isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
          state = nextShortRep(state)
          push(out[n - rep0 - 1])
          continue
        }
      } else {
        let dist: number
        if (rc.decodeBit(m.isRepG1, state) === 0) dist = rep1
        else {
          if (rc.decodeBit(m.isRepG2, state) === 0) dist = rep2
          else {
            dist = rep3
            rep3 = rep2
          }
          rep2 = rep1
        }
        rep1 = rep0
        rep0 = dist
      }
      len = decodeLen(m.repLenModel, posState)
      state = nextRep(state)
    } else {
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      len = decodeLen(m.lenModel, posState)
      state = nextMatch(state)
      rep0 = decodeDist(len)
      if (rep0 === 0xffffffff) {
        if (!rc.finishedOK) throw new Error('lzma: end marker but the range coder did not finish cleanly')
        break
      }
      if (rep0 >= n) throw new Error('lzma: match distance reaches before the start of the data')
    }
    len += MATCH_MIN_LEN
    if (known && n + len > h.size) throw new Error('lzma: match runs past the declared size')
    for (let i = 0; i < len; i++) push(out[n - rep0 - 1])
  }
  if (rc.overrun) throw new Error('lzma: stream is truncated')
  if (known && n !== h.size) throw new Error('lzma: stream ended early')
  return out.slice(0, n)
}
