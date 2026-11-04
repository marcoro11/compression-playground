/**
 * The corpus. Every exhibit offers these as presets, and `npm run verify`
 * round-trips every codec over all of them, so between them they need to hit
 * the awkward cases: empty-ish, one symbol, long runs, real prose, structured
 * text, and data with nothing to find.
 */

import { utf8 } from './text'

export interface Sample {
  id: string
  label: string
  /** Why this one is interesting, in a few words. */
  note: string
  text?: string
  bytes?: () => Uint8Array
}

/** Small seeded PRNG (sfc32) so "random" samples are reproducible. */
export function seeded(seed = 0x9e3779b9) {
  let a = seed >>> 0
  let b = 0x243f6a88
  let c = 0xb7e15162
  let d = 1
  const next = () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  for (let i = 0; i < 12; i++) next()
  return next
}

export function randomBytes(n: number, seed = 1): Uint8Array {
  const r = seeded(seed)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 256)
  return out
}

const PROSE =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, ' +
  'it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, ' +
  'it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us.'

const JSON_SAMPLE = JSON.stringify(
  [
    { id: 1, name: 'huffman', year: 1952, lossless: true, kind: 'entropy' },
    { id: 2, name: 'lz77', year: 1977, lossless: true, kind: 'dictionary' },
    { id: 3, name: 'lz78', year: 1978, lossless: true, kind: 'dictionary' },
    { id: 4, name: 'lzw', year: 1984, lossless: true, kind: 'dictionary' },
    { id: 5, name: 'deflate', year: 1993, lossless: true, kind: 'hybrid' },
    { id: 6, name: 'bzip2', year: 1996, lossless: true, kind: 'transform' },
  ],
  null,
  1,
)

export const SAMPLES: Sample[] = [
  { id: 'tobe', label: 'TOBEORNOT…', note: 'the classic LZW example', text: 'TOBEORNOTTOBEORTOBEORNOT' },
  { id: 'abra', label: 'abracadabra', note: 'short, skewed, repetitive', text: 'abracadabra' },
  { id: 'banana', label: 'banana', note: 'the BWT example', text: 'banana' },
  { id: 'prose', label: 'Dickens', note: 'real English', text: PROSE },
  { id: 'json', label: 'JSON', note: 'structured, repeated keys', text: JSON_SAMPLE },
  { id: 'runs', label: 'Runs', note: 'long runs of one byte', text: 'WWWWWWWWWWWWBWWWWWWWWWWWWBBBWWWWWWWWWWWWWWWWWWWWWWWWBWWWWWWWWWWWWWW' },
  { id: 'skew', label: 'Skewed', note: 'one symbol is 90% of the input', text: 'aaaaaaaaabaaaaaaaaacaaaaaaaaabaaaaaaaaadaaaaaaaaab' },
  { id: 'dna', label: 'DNA', note: 'four symbols, 2 bits each?', text: 'GATTACAGATTACACATTAGGACCATGATTACAGGATCCATGCATTAGATTACAACGT' },
  { id: 'random', label: 'Random', note: 'nothing to find', bytes: () => randomBytes(160, 7) },
]

export function sampleBytes(s: Sample): Uint8Array {
  return s.bytes ? s.bytes() : utf8(s.text ?? '')
}

/** A larger corpus for the bench and for verify: the samples plus some sizes that stress windows. */
export function corpus(): { id: string; data: Uint8Array }[] {
  const out = SAMPLES.map((s) => ({ id: s.id, data: sampleBytes(s) }))
  out.push({ id: 'empty', data: new Uint8Array(0) })
  out.push({ id: 'one', data: utf8('x') })
  out.push({ id: 'zeros-70k', data: new Uint8Array(70000) })
  out.push({ id: 'prose-x40', data: utf8(PROSE.repeat(40)) })
  out.push({ id: 'random-5k', data: randomBytes(5000, 3) })
  const mixed = new Uint8Array(40000)
  const r = seeded(11)
  for (let i = 0; i < mixed.length; i++) mixed[i] = r() < 0.7 ? 97 + Math.floor(r() * 4) : Math.floor(r() * 256)
  out.push({ id: 'mixed-40k', data: mixed })
  return out
}
