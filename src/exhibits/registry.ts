import { lazy, type ComponentType } from 'react'
import { META, type ExhibitMeta } from './meta'

export { TIERS, META } from './meta'

/**
 * Each exhibit is its own chunk, loaded when you open it — the index page only
 * needs the metadata, and seventeen exhibits' worth of tables and step traces
 * would otherwise all download up front.
 */
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

const COMPONENTS: Record<string, ComponentType> = {
  entropy: named(() => import('./entropy/Entropy'), 'Entropy'),
  rle: named(() => import('./rle/Rle'), 'Rle'),
  huffman: named(() => import('./huffman/Huffman'), 'Huffman'),
  arithmetic: named(() => import('./arithmetic/Arithmetic'), 'Arithmetic'),
  ans: named(() => import('./ans/Ans'), 'Ans'),
  intcodes: named(() => import('./intcodes/IntCodes'), 'IntCodes'),
  lz77: named(() => import('./lz77/Lz77'), 'Lz77'),
  lzw: named(() => import('./lzw/Lzw'), 'Lzw'),
  ppm: named(() => import('./ppm/Ppm'), 'Ppm'),
  png: named(() => import('./png/Png'), 'Png'),
  flac: named(() => import('./flac/Flac'), 'Flac'),
  deflate: named(() => import('./deflate/Deflate'), 'Deflate'),
  bwt: named(() => import('./bwt/Bwt'), 'Bwt'),
  jpeg: named(() => import('./jpeg/Jpeg'), 'Jpeg'),
  wavelet: named(() => import('./wavelet/Wavelet'), 'Wavelet'),
  palette: named(() => import('./palette/Palette'), 'Palette'),
  bench: named(() => import('./bench/BenchView'), 'BenchView'),
}

export interface Exhibit extends ExhibitMeta {
  component: ComponentType
}

export const EXHIBITS: Exhibit[] = META.map((m) => ({ ...m, component: COMPONENTS[m.slug] }))
