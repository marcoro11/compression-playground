import type { ComponentType } from 'react'
import { META, type ExhibitMeta } from './meta'
import { Entropy } from './entropy/Entropy'
import { Rle } from './rle/Rle'
import { Huffman } from './huffman/Huffman'
import { Arithmetic } from './arithmetic/Arithmetic'
import { Lz77 } from './lz77/Lz77'
import { Lzw } from './lzw/Lzw'
import { Deflate } from './deflate/Deflate'
import { Bwt } from './bwt/Bwt'
import { Jpeg } from './jpeg/Jpeg'
import { BenchView } from './bench/BenchView'
import { Ans } from './ans/Ans'
import { IntCodes } from './intcodes/IntCodes'
import { Ppm } from './ppm/Ppm'
import { Png } from './png/Png'
import { Flac } from './flac/Flac'
import { Wavelet } from './wavelet/Wavelet'
import { Palette } from './palette/Palette'

export { TIERS, META } from './meta'

const COMPONENTS: Record<string, ComponentType> = {
  entropy: Entropy,
  rle: Rle,
  huffman: Huffman,
  arithmetic: Arithmetic,
  lz77: Lz77,
  lzw: Lzw,
  deflate: Deflate,
  bwt: Bwt,
  jpeg: Jpeg,
  bench: BenchView,
  ans: Ans,
  intcodes: IntCodes,
  ppm: Ppm,
  png: Png,
  flac: Flac,
  wavelet: Wavelet,
  palette: Palette,
}

export interface Exhibit extends ExhibitMeta {
  component: ComponentType
}

export const EXHIBITS: Exhibit[] = META.map((m) => ({ ...m, component: COMPONENTS[m.slug] }))
