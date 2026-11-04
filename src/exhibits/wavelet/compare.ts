/**
 * Wavelet vs 8×8 DCT, measured the same way.
 *
 * Both sides use the same dead-zone quantizer and the same size estimate —
 * order-0 entropy of the quantized values, one context per subband (wavelet)
 * or per frequency position (DCT) — so the only thing that differs is the
 * transform. The DCT side borrows the JPEG exhibit's orthonormal 8×8 DCT.
 */

import { fdct, idct } from '../jpeg/jpeg'
import { bandNorms, codeWavelet, dzDequant, dzQuant, entropyBits, forward2d, inverse2d, psnr, type Kind } from './wavelet'

export interface Result {
  recon: Float64Array
  bits: number
  psnr: number
  nonzero: number
}

/** Per-block DCT coefficients of an image whose sides are multiples of 8; layout [block][64]. */
export function dctCoefs(img: ArrayLike<number>, w: number, h: number): Float64Array {
  const bw = w >> 3
  const bh = h >> 3
  const out = new Float64Array(bw * bh * 64)
  const blk = new Float64Array(64)
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      for (let i = 0; i < 64; i++) blk[i] = img[(by * 8 + (i >> 3)) * w + bx * 8 + (i & 7)] - 128
      out.set(fdct(blk), (by * bw + bx) * 64)
    }
  return out
}

/** Bits (estimate) of the DCT coefficients at step Δ: each of the 64 frequencies is its own context. */
export function dctBits(coefs: Float64Array, step: number): { bits: number; nonzero: number } {
  const blocks = coefs.length / 64
  let bits = 0
  let nonzero = 0
  const col: number[] = new Array(blocks)
  for (let k = 0; k < 64; k++) {
    for (let b = 0; b < blocks; b++) {
      const q = dzQuant(coefs[b * 64 + k], step)
      if (q) nonzero++
      col[b] = q
    }
    bits += entropyBits(col)
  }
  return { bits, nonzero }
}

export function dctRecon(coefs: Float64Array, w: number, h: number, step: number): Float64Array {
  const bw = w >> 3
  const out = new Float64Array(w * h)
  const F = new Float64Array(64)
  for (let b = 0; b < coefs.length / 64; b++) {
    for (let k = 0; k < 64; k++) F[k] = dzDequant(dzQuant(coefs[b * 64 + k], step), step)
    const f = idct(F)
    const bx = b % bw
    const by = Math.floor(b / bw)
    for (let i = 0; i < 64; i++) out[(by * 8 + (i >> 3)) * w + bx * 8 + (i & 7)] = f[i] + 128
  }
  return out
}

/** The DCT step whose estimated size is closest to `targetBits` (bisection in log Δ; size falls as Δ grows). */
export function dctStepFor(coefs: Float64Array, targetBits: number): number {
  let lo = Math.log(0.05)
  let hi = Math.log(4096)
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (dctBits(coefs, Math.exp(mid)).bits > targetBits) lo = mid
    else hi = mid
  }
  return Math.exp((lo + hi) / 2)
}

export interface Prepared {
  w: number
  h: number
  img: ArrayLike<number>
  kind: Kind
  levels: number
  coefs: Float64Array
  norms: number[]
  dct: Float64Array
}

export function prepare(img: ArrayLike<number>, w: number, h: number, kind: Kind, levels: number, dct?: Float64Array): Prepared {
  // Lossy path: the linear transform. Centre the pixels so LL is not one huge DC offset.
  const centred = Float64Array.from(img as ArrayLike<number>, (v) => v - 128)
  const { coefs } = forward2d(centred, w, h, levels, kind, false)
  return { w, h, img, kind, levels, coefs, norms: bandNorms(w, h, levels, kind), dct: dct ?? dctCoefs(img, w, h) }
}

export function waveletAt(p: Prepared, step: number): Result & { bandBits: number[]; coefs: Float64Array } {
  const c = codeWavelet(p.coefs, p.w, p.h, p.levels, p.norms, step)
  const rec = inverse2d(c.recon, p.w, p.h, p.levels, p.kind, false)
  for (let i = 0; i < rec.length; i++) rec[i] += 128
  return { recon: rec, bits: c.bits, psnr: psnr(p.img, rec), nonzero: c.nonzero, bandBits: c.bandBits, coefs: c.recon }
}

export function dctAtBits(p: Prepared, bits: number): Result & { step: number } {
  const step = dctStepFor(p.dct, bits)
  const rec = dctRecon(p.dct, p.w, p.h, step)
  const b = dctBits(p.dct, step)
  return { recon: rec, bits: b.bits, psnr: psnr(p.img, rec), nonzero: b.nonzero, step }
}

/** PSNR against bits per pixel for both transforms over a sweep of steps. */
export function rdCurves(p: Prepared, steps: number[]): { wavelet: { bpp: number; psnr: number }[]; dct: { bpp: number; psnr: number }[] } {
  const n = p.w * p.h
  const wavelet = steps.map((s) => {
    const r = waveletAt(p, s)
    return { bpp: r.bits / n, psnr: r.psnr }
  })
  const dct = steps.map((s) => {
    const b = dctBits(p.dct, s)
    return { bpp: b.bits / n, psnr: psnr(p.img, dctRecon(p.dct, p.w, p.h, s)) }
  })
  return { wavelet, dct }
}
