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
}

export interface Exhibit extends ExhibitMeta {
  component: ComponentType
}

export const EXHIBITS: Exhibit[] = META.map((m) => ({ ...m, component: COMPONENTS[m.slug] }))
