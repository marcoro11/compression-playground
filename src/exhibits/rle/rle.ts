/**
 * Run-length coding, two flavours.
 *
 *  - Pixel rows, fax style: a row of black/white pixels becomes the lengths of
 *    alternating runs, always starting with white (so a row that begins black
 *    starts with a white run of 0). That is ITU-T T.4's one-dimensional scheme.
 *  - Bytes: the naive ⟨count, byte⟩ pairing, and Apple's PackBits (Technical
 *    Note TN1023), which escapes literals so non-repeating data costs at most
 *    one extra byte per 128.
 */

// ------------------------------------------------------------------ pixels

export interface PixelRun {
  row: number
  /** true = black. */
  black: boolean
  /** First column of the run. */
  start: number
  length: number
}

/** Alternating run lengths of a row, white first. Black pixels are `true`. */
export function faxRuns(row: ArrayLike<boolean>): number[] {
  const runs: number[] = []
  let color = false
  let n = 0
  for (let i = 0; i < row.length; i++) {
    if (row[i] === color) n++
    else {
      runs.push(n)
      color = !color
      n = 1
    }
  }
  runs.push(n)
  return runs
}

/** Every run of every row, in scan order, with positions — the step-through trace. */
export function imageRuns(pixels: boolean[][]): PixelRun[] {
  const out: PixelRun[] = []
  pixels.forEach((row, r) => {
    let start = 0
    faxRuns(row).forEach((len, k) => {
      out.push({ row: r, black: k % 2 === 1, start, length: len })
      start += len
    })
  })
  return out
}

/**
 * Number of fixed-width fields a run needs when a field holds at most `max`:
 * a longer run is split as max, 0 (an empty run of the other colour), max, 0, … rest.
 */
export function fieldsForRun(run: number, max: number): number {
  if (run <= max) return 1
  return 2 * Math.floor((run - 1) / max) + 1
}

/**
 * ITU-T T.4 Modified Huffman terminating codes for run lengths 0–63
 * (Tables 2a/2b of the Recommendation). A 32-pixel row never needs the
 * make-up codes for multiples of 64.
 */
export const MH_WHITE: string[] = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
]

export const MH_BLACK: string[] = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
]

/** The Modified Huffman code for one run (lengths 0–63 only). */
export function mhCode(run: PixelRun | { black: boolean; length: number }): string {
  const t = run.black ? MH_BLACK : MH_WHITE
  if (run.length > 63) throw new Error('make-up codes not modelled (run > 63)')
  return t[run.length]
}

// ------------------------------------------------------------------- bytes

export interface Packet {
  kind: 'literal' | 'repeat'
  /** Input range this packet covers. */
  start: number
  length: number
  /** The bytes this packet writes to the output. */
  out: number[]
}

/** The PackBits packets for `data`: runs of 3 or more repeat, everything else is literal (≤128 per packet). */
export function packbitsPackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = []
  let i = 0
  let litStart = -1
  const flushLiteral = (end: number) => {
    while (litStart >= 0 && litStart < end) {
      const n = Math.min(128, end - litStart)
      packets.push({ kind: 'literal', start: litStart, length: n, out: [n - 1, ...data.subarray(litStart, litStart + n)] })
      litStart += n
    }
    litStart = -1
  }
  while (i < data.length) {
    let run = 1
    while (i + run < data.length && data[i + run] === data[i] && run < 128) run++
    if (run >= 3) {
      flushLiteral(i)
      packets.push({ kind: 'repeat', start: i, length: run, out: [(257 - run) & 0xff, data[i]] })
      i += run
    } else {
      if (litStart < 0) litStart = i
      i += run
    }
  }
  flushLiteral(data.length)
  return packets
}

export function packbitsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (const p of packbitsPackets(data)) for (const b of p.out) out.push(b)
  return Uint8Array.from(out)
}

export function packbitsDecode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const h = data[i++]
    const n = h > 127 ? h - 256 : h
    if (n >= 0) {
      if (i + n + 1 > data.length) throw new Error('packbits: truncated literal')
      for (let k = 0; k <= n; k++) out.push(data[i++])
    } else if (n !== -128) {
      if (i >= data.length) throw new Error('packbits: truncated repeat')
      const b = data[i++]
      for (let k = 0; k < 1 - n; k++) out.push(b)
    }
  }
  return Uint8Array.from(out)
}

/** Naive ⟨count, byte⟩ pairs, count 1–255. Every run costs two bytes, even a run of one. */
export function naivePackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = []
  let i = 0
  while (i < data.length) {
    let run = 1
    while (i + run < data.length && data[i + run] === data[i] && run < 255) run++
    packets.push({ kind: run > 1 ? 'repeat' : 'literal', start: i, length: run, out: [run, data[i]] })
    i += run
  }
  return packets
}

export function naiveEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (const p of naivePackets(data)) out.push(...p.out)
  return Uint8Array.from(out)
}

export function naiveDecode(data: Uint8Array): Uint8Array {
  if (data.length % 2) throw new Error('naive rle: odd length')
  const out: number[] = []
  for (let i = 0; i < data.length; i += 2) for (let k = 0; k < data[i]; k++) out.push(data[i + 1])
  return Uint8Array.from(out)
}
