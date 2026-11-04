/**
 * A deliberately small video codec, honest about every bit it counts.
 *
 * I-frames are baseline JPEG (the exhibit's own `../jpeg` module, unchanged).
 * P-frames, per macroblock:
 *
 *   1. motion vector, predicted from the neighbours (H.264's median of left,
 *      top and top-right) and sent as the difference, each component with
 *      signed Exp-Golomb se(v) — exactly the H.264 syntax element;
 *   2. the residual (current − motion-compensated prediction) in 8×8 blocks:
 *      one "coded" flag bit each (a one-bit coded_block_pattern), and for coded
 *      blocks the DCT coefficients quantised with a flat matrix (MPEG-2's inter
 *      default, 16, scaled by the same quality knob) and written with the JPEG
 *      Annex K Huffman tables, DC coded from zero.
 *
 * What is left out — slice/frame headers, skip runs, intra macroblocks inside P
 * frames, loop filters, B-frames, rate control — is real codecs' business and
 * the Notes say so. The counts here are the payload of this simplified syntax.
 *
 * The encoder is CLOSED-LOOP by default: it predicts from its own
 * *reconstructed* previous frame — what the decoder will actually have — so
 * the two stay in lock-step. The open-loop option predicts from the original
 * instead, and the decoder drifts. Both run through the same reconstruction
 * function, so the only difference is which reference the encoder looks at.
 */

import { blockSymbols, encodeImage, fdct, idct, quantTable, roundHalfAway, type Sym } from '../jpeg/jpeg'
import { predictBlock, search, type Frame, type Method, type SearchResult } from './motion'
import { H, W } from './frames'

export interface EncodeOptions {
  quality: number
  /** I-frame every `gop` frames (1 = every frame intra, i.e. Motion JPEG). */
  gop: number
  blockSize: 8 | 16
  method: Method
  range: number
  halfPel: boolean
  /** Code a P-frame as I when that is cheaper — catches scene cuts. */
  adaptiveKeyframes: boolean
  loop: 'closed' | 'open'
}

export const DEFAULTS: EncodeOptions = {
  quality: 50,
  gop: 12,
  blockSize: 16,
  method: 'diamond',
  range: 16,
  halfPel: true,
  adaptiveKeyframes: true,
  loop: 'closed',
}

/**
 * Flat inter quantiser. MPEG-2's default non-intra matrix is flat (all 16s), because a residual's
 * energy is not concentrated in the low frequencies the way a picture's is. The base step here is 32,
 * scaled by the same IJG quality formula as the intra table. It is coarser than a picture would get
 * because each P-frame also inherits the detail of the frame before it; with 16, P-frames sit several
 * dB above their own keyframes.
 */
export const INTER_BASE = 32

export function interTable(quality: number): number[] {
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q
  const step = Math.max(1, Math.min(255, Math.floor((INTER_BASE * scale + 50) / 100)))
  return new Array(64).fill(step)
}

// --------------------------------------------------------- Exp-Golomb

/** H.264 se(v) → codeNum: 0 → 0, 1 → 1, −1 → 2, 2 → 3, −2 → 4 … */
export const seMap = (v: number): number => (v > 0 ? 2 * v - 1 : -2 * v)
export const seUnmap = (k: number): number => (k % 2 ? (k + 1) / 2 : -k / 2)

/** ue(v) codeword for codeNum k: ⌊log₂(k+1)⌋ zeros, then k+1 in binary. */
export function ueBits(k: number): string {
  const x = (k + 1).toString(2)
  return '0'.repeat(x.length - 1) + x
}

export const ueLength = (k: number): number => 2 * Math.floor(Math.log2(k + 1)) + 1

// ------------------------------------------------------ MV prediction

export interface MV {
  mx: number
  my: number
}

/**
 * H.264's motion-vector predictor, simplified to one partition size: the
 * component-wise median of left (A), top (B) and top-right (C, or top-left D
 * when C is off the frame). In the top row only A exists, so it is used
 * directly; anything unavailable counts as (0, 0).
 */
export function mvPredictor(mvs: (MV | undefined)[], cols: number, i: number): MV {
  const c = i % cols
  const r = Math.floor(i / cols)
  const A = c > 0 ? mvs[i - 1] : undefined
  if (r === 0) return A ? { ...A } : { mx: 0, my: 0 }
  const B = mvs[i - cols]
  const C = c < cols - 1 ? mvs[i - cols + 1] : c > 0 ? mvs[i - cols - 1] : undefined
  const a = A ?? { mx: 0, my: 0 }
  const b = B ?? { mx: 0, my: 0 }
  const cc = C ?? { mx: 0, my: 0 }
  const med = (x: number, y: number, z: number) => Math.max(Math.min(x, y), Math.min(Math.max(x, y), z))
  return { mx: med(a.mx, b.mx, cc.mx), my: med(a.my, b.my, cc.my) }
}

// ------------------------------------------------------- macroblocks

export interface SubBlock {
  /** Residual before the transform, row-major 8×8. */
  residual: Float64Array
  coef: Float64Array
  q: Int32Array
  coded: boolean
  syms: Sym[]
  /** 1 flag bit, plus the Huffman symbols when coded. */
  bits: number
}

export interface Macroblock {
  index: number
  x: number
  y: number
  mv: MV
  pred: MV
  mvBits: { x: string; y: string }
  sad: number
  evaluated: number
  subs: SubBlock[]
  /** Motion-vector bits + residual bits. */
  bits: number
}

/** Transform, quantise and cost the residual of one macroblock given its prediction. */
export function codeResidual(cur: Frame, prediction: Int16Array, x0: number, y0: number, bs: number, table: number[]): SubBlock[] {
  const subs: SubBlock[] = []
  for (let sy = 0; sy < bs; sy += 8)
    for (let sx = 0; sx < bs; sx += 8) {
      const residual = new Float64Array(64)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          residual[y * 8 + x] = cur.data[(y0 + sy + y) * cur.w + x0 + sx + x] - prediction[(sy + y) * bs + sx + x]
      const coef = fdct(residual)
      const q = new Int32Array(64)
      let nz = 0
      for (let i = 0; i < 64; i++) {
        q[i] = roundHalfAway(coef[i] / table[i])
        if (q[i]) nz++
      }
      const coded = nz > 0
      const syms = coded ? blockSymbols(q, 0) : []
      subs.push({ residual, coef, q, coded, syms, bits: 1 + syms.reduce((s, x) => s + x.bits, 0) })
    }
  return subs
}

/**
 * Rebuild a macroblock from its prediction and quantised residual: dequantise,
 * inverse DCT, add, round, clamp. The decoder runs exactly this, which is the
 * whole point of closed-loop coding.
 */
export function reconstructMB(out: Uint8ClampedArray, prediction: Int16Array, qs: Int32Array[], x0: number, y0: number, bs: number, table: number[]) {
  let k = 0
  for (let sy = 0; sy < bs; sy += 8)
    for (let sx = 0; sx < bs; sx += 8) {
      const q = qs[k++]
      let any = false
      for (let i = 0; i < 64; i++) if (q[i]) any = true
      const back = any ? idct(Array.from(q, (v, i) => v * table[i])) : null
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const p = prediction[(sy + y) * bs + sx + x]
          const r = back ? back[y * 8 + x] : 0
          out[(y0 + sy + y) * W + x0 + sx + x] = Math.round(p + r)
        }
    }
}

// ------------------------------------------------------------ frames

export interface FrameResult {
  index: number
  type: 'I' | 'P'
  /** Why this frame is what it is. */
  reason: 'first' | 'gop' | 'cheaper' | 'predicted'
  /** I: JPEG quantised blocks (for the decoder). */
  intraQ?: Int32Array[]
  mbs?: Macroblock[]
  /** P: the motion-compensated prediction the encoder used. */
  prediction?: Uint8ClampedArray
  bits: { intra: number; mv: number; residual: number; flags: number }
  total: number
  /** What coding this frame as an I-frame would have cost — the comparison line. */
  intraBits: number
  recon: Uint8ClampedArray
  psnr: number
}

export interface Encoded {
  options: EncodeOptions
  frames: FrameResult[]
  totalBits: number
  allIntraBits: number
}

export function psnr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let se = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    se += d * d
  }
  const mse = se / a.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

const frameOf = (data: ArrayLike<number>): Frame => ({ data, w: W, h: H })

/** Motion-search and code every macroblock of one P-frame against `ref`; return MBs, prediction and reconstruction against `decRef`. */
export function codePFrame(cur: Uint8ClampedArray, searchRef: Uint8ClampedArray, decRef: Uint8ClampedArray, o: EncodeOptions) {
  const bs = o.blockSize
  const cols = W / bs
  const rows = H / bs
  const table = interTable(o.quality)
  const mvs: (MV | undefined)[] = []
  const mbs: Macroblock[] = []
  const prediction = new Uint8ClampedArray(W * H)
  const recon = new Uint8ClampedArray(W * H)
  const curF = frameOf(cur)
  const refF = frameOf(searchRef)
  const decF = frameOf(decRef)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const x0 = c * bs
      const y0 = r * bs
      const s: SearchResult = search(curF, refF, x0, y0, bs, { method: o.method, range: o.range, halfPel: o.halfPel })
      const mv = { mx: s.mx, my: s.my }
      mvs[i] = mv
      const pred = mvPredictor(mvs, cols, i)
      const mvBits = { x: ueBits(seMap(mv.mx - pred.mx)), y: ueBits(seMap(mv.my - pred.my)) }
      // The residual is taken against what the encoder predicted from (its search reference)…
      const encPred = predictBlock(refF, x0, y0, bs, mv.mx, mv.my)
      const subs = codeResidual(curF, encPred, x0, y0, bs, table)
      for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) prediction[(y0 + y) * W + x0 + x] = encPred[y * bs + x]
      // …but reconstruction is what the decoder can do: its own reference, plus the coded residual.
      const decPred = searchRef === decRef ? encPred : predictBlock(decF, x0, y0, bs, mv.mx, mv.my)
      reconstructMB(
        recon,
        decPred,
        subs.map((sb) => sb.q),
        x0,
        y0,
        bs,
        table,
      )
      const resBits = subs.reduce((t, sb) => t + sb.bits, 0)
      mbs.push({ index: i, x: x0, y: y0, mv, pred, mvBits, sad: s.sad, evaluated: s.evaluated, subs, bits: mvBits.x.length + mvBits.y.length + resBits })
    }
  return { mbs, prediction, recon }
}

export function encodeSequence(frames: Uint8ClampedArray[], o: EncodeOptions): Encoded {
  const out: FrameResult[] = []
  let recPrev: Uint8ClampedArray | null = null
  let total = 0
  let allIntra = 0
  for (let t = 0; t < frames.length; t++) {
    const cur = frames[t]
    const intra = encodeImage(cur, W, H, o.quality)
    allIntra += intra.scanBits
    const forcedI = t === 0 || o.gop <= 1 || t % o.gop === 0
    let chosen: FrameResult | null = null
    if (!forcedI && recPrev) {
      const searchRef = o.loop === 'closed' ? recPrev : frames[t - 1]
      const p = codePFrame(cur, searchRef, recPrev, o)
      let mv = 0
      let residual = 0
      let flags = 0
      for (const mb of p.mbs) {
        mv += mb.mvBits.x.length + mb.mvBits.y.length
        for (const sb of mb.subs) {
          flags += 1
          residual += sb.bits - 1
        }
      }
      const pTotal = mv + residual + flags
      if (!(o.adaptiveKeyframes && pTotal > intra.scanBits)) {
        chosen = {
          index: t,
          type: 'P',
          reason: 'predicted',
          mbs: p.mbs,
          prediction: p.prediction,
          bits: { intra: 0, mv, residual, flags },
          total: pTotal,
          intraBits: intra.scanBits,
          recon: p.recon,
          psnr: psnr(cur, p.recon),
        }
      }
    }
    if (!chosen) {
      chosen = {
        index: t,
        type: 'I',
        reason: t === 0 ? 'first' : forcedI ? 'gop' : 'cheaper',
        intraQ: intra.blocks.map((b) => b.q),
        bits: { intra: intra.scanBits, mv: 0, residual: 0, flags: 0 },
        total: intra.scanBits,
        intraBits: intra.scanBits,
        recon: intra.recon,
        psnr: intra.psnr,
      }
    }
    total += chosen.total
    out.push(chosen)
    recPrev = chosen.recon
  }
  return { options: o, frames: out, totalBits: total, allIntraBits: allIntra }
}

// ------------------------------------------------------------ decoder

/**
 * Rebuild the sequence from what was transmitted: JPEG coefficients for I
 * frames; vectors and quantised residuals for P frames, applied to the
 * decoder's OWN previous output. In closed loop this equals the encoder's
 * reconstruction bit for bit; in open loop it does not, and the error grows.
 */
export function decodeSequence(enc: Encoded): Uint8ClampedArray[] {
  const o = enc.options
  const out: Uint8ClampedArray[] = []
  const intraTable = quantTable(o.quality)
  const table = interTable(o.quality)
  const bs = o.blockSize
  let prev: Uint8ClampedArray | null = null
  for (const f of enc.frames) {
    const rec = new Uint8ClampedArray(W * H)
    if (f.type === 'I') {
      const bw = W / 8
      f.intraQ!.forEach((q, k) => {
        const back = idct(Array.from(q, (v, i) => v * intraTable[i]))
        const bx = k % bw
        const by = Math.floor(k / bw)
        for (let i = 0; i < 64; i++) rec[(by * 8 + (i >> 3)) * W + bx * 8 + (i & 7)] = Math.round(back[i] + 128)
      })
    } else {
      const ref = frameOf(prev!)
      for (const mb of f.mbs!) {
        const pred = predictBlock(ref, mb.x, mb.y, bs, mb.mv.mx, mb.mv.my)
        reconstructMB(
          rec,
          pred,
          mb.subs.map((s) => s.q),
          mb.x,
          mb.y,
          bs,
          table,
        )
      }
    }
    out.push(rec)
    prev = rec
  }
  return out
}

/** Re-derive the vectors from the transmitted differences, as a decoder must. */
export function decodeVectors(mbs: Macroblock[], cols: number): MV[] {
  const mvs: MV[] = []
  for (let i = 0; i < mbs.length; i++) {
    const pred = mvPredictor(mvs, cols, i)
    const dx = seUnmap(parseInt(mbs[i].mvBits.x, 2) - 1)
    const dy = seUnmap(parseInt(mbs[i].mvBits.y, 2) - 1)
    mvs.push({ mx: pred.mx + dx, my: pred.my + dy })
  }
  return mvs
}

/** The predicted block for a vector object. */
export const predictBlockFor = (ref: Frame, x0: number, y0: number, bs: number, mv: MV): Int16Array => predictBlock(ref, x0, y0, bs, mv.mx, mv.my)
