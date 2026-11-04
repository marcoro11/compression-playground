/**
 * Exhibit metadata, kept apart from the components so a page can link to its
 * neighbours without importing every other exhibit (and without a cycle).
 */

export type TierId = 'floor' | 'entropy' | 'dictionary' | 'predict' | 'formats' | 'lossy'

export interface ExhibitMeta {
  slug: string
  title: string
  /** Short label for the top bar. */
  short: string
  /** "Entropy coder · 1952" — what it is and when. */
  kicker: string
  tagline: string
  tags: string[]
  /** Highlighter colour used for the card and as `--accent` on the page. */
  accent: string
  tier: TierId
}

export const TIERS: { id: TierId; title: string; blurb: string }[] = [
  { id: 'floor', title: 'The floor', blurb: 'How small can it possibly get — and the simplest thing that gets anywhere near.' },
  { id: 'entropy', title: 'Entropy coders', blurb: 'Give common symbols short codes. The whole question is how short.' },
  { id: 'dictionary', title: 'Dictionary coders', blurb: 'Stop coding symbols. Point at something you already said.' },
  { id: 'predict', title: 'Predict, then code the surprise', blurb: 'Guess the next thing from what came before, and only pay for how wrong you were.' },
  { id: 'formats', title: 'Real formats', blurb: 'The pieces bolted together into what actually ships.' },
  { id: 'lossy', title: 'Throwing things away', blurb: 'When the copy only has to look the same.' },
]

export const META: ExhibitMeta[] = [
  {
    slug: 'entropy',
    title: 'How Low Can It Go',
    short: 'Entropy',
    kicker: 'Information theory · 1948',
    tagline:
      'Shannon put a number on the floor: below this many bits per symbol, no code can go. Type into it and watch the floor move — then meet the pigeonhole that says some files must get bigger.',
    tags: ['entropy', 'Shannon', 'pigeonhole'],
    accent: '#ffd23f',
    tier: 'floor',
  },
  {
    slug: 'rle',
    title: 'Run-Length Encoding',
    short: 'RLE',
    kicker: 'Fax, BMP, PackBits · 1960s',
    tagline:
      'Draw a picture, and count how many white pixels before the next black one. That is the whole algorithm, and it is still inside every fax machine — along with the input that doubles in size.',
    tags: ['runs', 'PackBits', 'fax'],
    accent: '#ff9ec4',
    tier: 'floor',
  },
  {
    slug: 'huffman',
    title: 'Huffman Coding',
    short: 'Huffman',
    kicker: 'Entropy coder · 1952',
    tagline:
      'Take the two rarest symbols, glue them together, repeat. A term paper that beat its professor, and the tree that is still in every ZIP, JPEG and PNG.',
    tags: ['prefix codes', 'trees', 'canonical'],
    accent: '#9be8c4',
    tier: 'entropy',
  },
  {
    slug: 'arithmetic',
    title: 'Arithmetic Coding',
    short: 'Arithmetic',
    kicker: 'Entropy coder · 1976–87',
    tagline:
      'Huffman must spend a whole bit on every symbol. Arithmetic coding turns the entire message into one number, zooming into an interval, and spends fractions of a bit — right down to the entropy.',
    tags: ['intervals', 'fractional bits', 'models'],
    accent: '#a6d4ff',
    tier: 'entropy',
  },
  {
    slug: 'ans',
    title: 'Asymmetric Numeral Systems',
    short: 'ANS',
    kicker: 'Entropy coder · 2009',
    tagline:
      'Arithmetic coding’s precision with Huffman’s speed: the whole message lives in one growing integer. Push a symbol and the number grows by log₂(1/p) bits; pop it and it shrinks back. The coder inside Zstandard and Apple’s LZFSE.',
    tags: ['rANS', 'tANS', 'Zstandard'],
    accent: '#f2b8ff',
    tier: 'entropy',
  },
  {
    slug: 'intcodes',
    title: 'Integer Codes',
    short: 'Integers',
    kicker: 'Universal codes · 1966–75',
    tagline:
      'How do you write down a number when you do not know how big it will be? Unary, Elias, Golomb–Rice, Exp-Golomb, varints — each one a bet on how numbers are distributed, and the one the bet loses on.',
    tags: ['Elias', 'Golomb–Rice', 'varint'],
    accent: '#cfe57a',
    tier: 'entropy',
  },
  {
    slug: 'lz77',
    title: 'LZ77',
    short: 'LZ77',
    kicker: 'Sliding window · 1977',
    tagline:
      'Instead of coding what comes next, say where you saw it before: go back 12, copy 7. Watch the window slide, the matches land, and a copy that overlaps itself turn into a run.',
    tags: ['sliding window', 'back-references', 'matches'],
    accent: '#ffc38a',
    tier: 'dictionary',
  },
  {
    slug: 'lzw',
    title: 'LZW',
    short: 'LZW',
    kicker: 'GIF, Unix compress · 1984',
    tagline:
      'Build a phrasebook while you read, and send page numbers. The decoder rebuilds the same book without ever seeing it — except for one case, where it has to use a word before it knows it.',
    tags: ['dictionary', 'GIF', 'KwKwK'],
    accent: '#cdb8ff',
    tier: 'dictionary',
  },
  {
    slug: 'ppm',
    title: 'Prediction by Partial Matching',
    short: 'PPM',
    kicker: 'Context modelling · 1984',
    tagline:
      'After “compressio” the next letter is almost certainly “n”. PPM keeps counts for every context it has seen, asks the longest one first, and escapes to shorter ones when surprised — then hands the probability to an arithmetic coder.',
    tags: ['contexts', 'escapes', 'PPMC'],
    accent: '#ffd7a3',
    tier: 'predict',
  },
  {
    slug: 'png',
    title: 'PNG Filters',
    short: 'PNG',
    kicker: 'Prediction + DEFLATE · 1996',
    tagline:
      'PNG never compresses pixels. It compresses how wrong a guess about each pixel was — from its left, upper and upper-left neighbours — and on a smooth image those guesses are nearly always right. Then DEFLATE takes over.',
    tags: ['Paeth', 'residuals', 'zlib'],
    accent: '#94d5ff',
    tier: 'predict',
  },
  {
    slug: 'flac',
    title: 'Lossless Audio',
    short: 'FLAC',
    kicker: 'FLAC · 2001',
    tagline:
      'A waveform is the easiest thing in the world to predict a sample ahead. Fit a line through the last few samples, keep only the error, and write it with Rice codes. gzip gets 10% on audio; this gets 50%.',
    tags: ['LPC', 'Rice codes', 'FLAC'],
    accent: '#9fe6dc',
    tier: 'predict',
  },
  {
    slug: 'deflate',
    title: 'DEFLATE',
    short: 'DEFLATE',
    kicker: 'ZIP, gzip, PNG, HTTP · 1993',
    tagline:
      'LZ77 tokens, Huffman-coded with trees that are themselves Huffman-coded. Build a real gzip stream bit by bit, every field coloured by what it means — and check it against your browser’s own inflater.',
    tags: ['RFC 1951', 'gzip', 'bit-level'],
    accent: '#7fd8e8',
    tier: 'formats',
  },
  {
    slug: 'bwt',
    title: 'Burrows–Wheeler',
    short: 'BWT',
    kicker: 'bzip2 · 1994',
    tagline:
      'Sort every rotation of the text and keep only the last column. It is the same letters, reversible, and suddenly full of runs. Then move-to-front turns the runs into zeros.',
    tags: ['BWT', 'move-to-front', 'bzip2'],
    accent: '#ffe066',
    tier: 'formats',
  },
  {
    slug: 'jpeg',
    title: 'JPEG',
    short: 'JPEG',
    kicker: 'DCT + quantization · 1992',
    tagline:
      'Turn an 8×8 block of pixels into 64 cosine waves, then round the ones your eye will not miss. Pick a block, drag the quality, and watch the ringing and the blocks appear.',
    tags: ['DCT', 'quantization', 'zigzag'],
    accent: '#ff8f6b',
    tier: 'lossy',
  },
  {
    slug: 'wavelet',
    title: 'Wavelets',
    short: 'Wavelets',
    kicker: 'JPEG 2000 · 2000',
    tagline:
      'Split the image into a blurry half-size copy and the details you would need to sharpen it again. Repeat on the copy. The details are mostly zero, nothing is cut into blocks, and the integer version gives back every pixel exactly.',
    tags: ['Haar', 'CDF 5/3', 'lifting'],
    accent: '#bfcbff',
    tier: 'lossy',
  },
  {
    slug: 'palette',
    title: 'Palettes & Dithering',
    short: 'Palettes',
    kicker: 'GIF · 1987',
    tagline:
      'A GIF has at most 256 colours. Which 256? Cut the colour cube at the median until there are enough boxes, then hide the missing shades by scattering the error onto the neighbours — Floyd and Steinberg’s trick from 1976.',
    tags: ['median cut', 'k-means', 'Floyd–Steinberg'],
    accent: '#ffa3a8',
    tier: 'lossy',
  },
  {
    slug: 'bench',
    title: 'The Bench',
    short: 'Bench',
    kicker: 'Everything, side by side',
    tagline:
      'Run every coder on this site against the same input, next to your browser’s own gzip. Which one wins depends entirely on what you feed it — and on random bytes, all of them lose.',
    tags: ['comparison', 'ratios', 'no free lunch'],
    accent: '#b8e986',
    tier: 'formats',
  },
]

export const metaBySlug = (slug: string) => META.find((m) => m.slug === slug)
