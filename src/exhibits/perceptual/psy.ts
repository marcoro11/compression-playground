/**
 * A small perceptual transform codec, in the shape of MP3/AAC with the
 * engineering stripped out:
 *
 *   samples → sine-windowed MDCT (2N in, N out, 50% overlap)
 *           → scale-factor bands about half a Bark wide
 *           → psychoacoustic model: absolute threshold of hearing (Terhardt),
 *             band energies spread across the Bark scale (Schroeder), lowered
 *             by a tonality-dependent offset (Johnston)
 *           → greedy bit allocation: keep refining the band whose noise is
 *             most audible (worst noise-to-mask ratio) until the frame's
 *             budget is spent
 *           → uniform quantisation, Rice-coded per band (real bit counts)
 *           → dequantise, IMDCT, window, overlap-add.
 *
 * Everything is DOM-free so `perceptual.verify.ts` can pin it.
 */

import { bestRice, fold } from '../flac/flac'

// ------------------------------------------------------------------ FFT/DCT

/** In-place radix-2 complex FFT (length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < half; j++) {
        const a = i + j
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** DCT-IV, X_k = Σ x_n cos(π/N (n+½)(k+½)), via an N/2-point complex FFT. */
export function dct4(x: ArrayLike<number>): Float64Array {
  const N = x.length
  const M = N >> 1
  const re = new Float64Array(M)
  const im = new Float64Array(M)
  for (let n = 0; n < M; n++) {
    const a = x[2 * n]
    const b = x[N - 1 - 2 * n]
    const th = (-Math.PI * (4 * n + 1)) / (4 * N)
    const c = Math.cos(th)
    const s = Math.sin(th)
    re[n] = a * c - b * s
    im[n] = a * s + b * c
  }
  fft(re, im)
  const X = new Float64Array(N)
  for (let k = 0; k < M; k++) {
    const th = (-Math.PI * k) / N
    const c = Math.cos(th)
    const s = Math.sin(th)
    X[2 * k] = re[k] * c - im[k] * s
    X[N - 1 - 2 * k] = -(re[k] * s + im[k] * c)
  }
  return X
}

/** The textbook O(N²) DCT-IV, for checking. */
export function dct4Direct(x: ArrayLike<number>): Float64Array {
  const N = x.length
  const X = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    let s = 0
    for (let n = 0; n < N; n++) s += x[n] * Math.cos((Math.PI / N) * (n + 0.5) * (k + 0.5))
    X[k] = s
  }
  return X
}

// --------------------------------------------------------------------- MDCT

/** Sine window of length 2N: w² + (shifted w)² = 1, the Princen–Bradley condition. */
export function sineWindow(N: number): Float64Array {
  const w = new Float64Array(2 * N)
  for (let n = 0; n < 2 * N; n++) w[n] = Math.sin((Math.PI * (n + 0.5)) / (2 * N))
  return w
}

/**
 * MDCT of 2N (already windowed) samples → N coefficients:
 * X_k = Σ_{n<2N} x_n cos(π/N (n + ½ + N/2)(k + ½)).
 * Computed as a DCT-IV of the folded input (−c_R − d, a − b_R), where a…d are
 * the four quarters of x.
 */
export function mdct(x: ArrayLike<number>): Float64Array {
  const N = x.length >> 1
  const H = N >> 1
  const u = new Float64Array(N)
  for (let n = 0; n < H; n++) {
    // −c_R − d : c = x[N..N+H), d = x[N+H..2N)
    u[n] = -x[N + H - 1 - n] - x[N + H + n]
    // a − b_R : a = x[0..H), b = x[H..N)
    u[H + n] = x[n] - x[N - 1 - n]
  }
  return dct4(u)
}

/**
 * Inverse MDCT: N coefficients → 2N samples (not yet windowed), scaled so that
 * window → MDCT → IMDCT → window → overlap-add gives back the input exactly.
 * The output carries time-domain aliasing; the next frame's copy cancels it.
 */
export function imdct(X: ArrayLike<number>): Float64Array {
  const N = X.length
  const H = N >> 1
  const u = dct4(X)
  const s = 2 / N // DCT-IV is its own inverse up to a factor 2/N
  const y = new Float64Array(2 * N)
  for (let n = 0; n < H; n++) {
    const p = u[n] * s // −c_R − d
    const q = u[H + n] * s // a − b_R
    y[n] = q // a − b_R
    y[N - 1 - n] = -q // b − a_R
    y[N + H - 1 - n] = -p // c + d_R
    y[N + H + n] = -p // d + c_R
  }
  return y
}

/** Direct-formula MDCT, for checking. */
export function mdctDirect(x: ArrayLike<number>): Float64Array {
  const N = x.length >> 1
  const X = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    let s = 0
    for (let n = 0; n < 2 * N; n++) s += x[n] * Math.cos((Math.PI / N) * (n + 0.5 + N / 2) * (k + 0.5))
    X[k] = s
  }
  return X
}

/** Direct-formula IMDCT with the same scaling as `imdct`. */
export function imdctDirect(X: ArrayLike<number>): Float64Array {
  const N = X.length
  const y = new Float64Array(2 * N)
  for (let n = 0; n < 2 * N; n++) {
    let s = 0
    for (let k = 0; k < N; k++) s += X[k] * Math.cos((Math.PI / N) * (n + 0.5 + N / 2) * (k + 0.5))
    y[n] = (2 * s) / N
  }
  return y
}

/** Frame a signal: N zeros in front, zero-padded to whole frames, one MDCT per hop of N. */
export function analyse(x: ArrayLike<number>, N: number): { frames: Float64Array[]; padded: number } {
  const F = Math.ceil(x.length / N) + 1
  const total = (F + 1) * N
  const buf = new Float64Array(total)
  for (let i = 0; i < x.length; i++) buf[N + i] = x[i]
  const w = sineWindow(N)
  const frames: Float64Array[] = []
  const seg = new Float64Array(2 * N)
  for (let f = 0; f < F; f++) {
    for (let n = 0; n < 2 * N; n++) seg[n] = buf[f * N + n] * w[n]
    frames.push(mdct(seg))
  }
  return { frames, padded: total }
}

/** Inverse of `analyse`: IMDCT, window, overlap-add, drop the leading N. */
export function synthesise(frames: Float64Array[], N: number, length: number): Float64Array {
  const w = sineWindow(N)
  const buf = new Float64Array((frames.length + 1) * N)
  frames.forEach((X, f) => {
    const y = imdct(X)
    for (let n = 0; n < 2 * N; n++) buf[f * N + n] += y[n] * w[n]
  })
  return buf.slice(N, N + length)
}

// ------------------------------------------------------------ psychoacoustics

/** Traunmüller's Bark formula (1990), with his low/high corrections. */
export function bark(f: number): number {
  let z = (26.81 * f) / (1960 + f) - 0.53
  if (z < 2) z += 0.15 * (2 - z)
  else if (z > 20.1) z += 0.22 * (z - 20.1)
  return z
}

/** Terhardt's absolute threshold of hearing, dB SPL (1979). */
export function ath(f: number): number {
  const k = Math.max(f, 20) / 1000
  return 3.64 * k ** -0.8 - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4
}

/** Schroeder's spreading function (1979), dB, Δz = maskee − masker in Bark. */
export function spreading(dz: number): number {
  const t = dz + 0.474
  return 15.81 + 7.5 * t - 17.5 * Math.sqrt(1 + t * t)
}

export interface Band {
  lo: number
  /** Exclusive. */
  hi: number
  /** Bark at the band's centre. */
  z: number
  /** Centre frequency, Hz. */
  f: number
}

/** Scale-factor bands about half a Bark wide, at least 4 bins, covering all N bins. */
export function makeBands(N: number, fs: number): Band[] {
  const binHz = fs / 2 / N
  const bands: Band[] = []
  let lo = 0
  while (lo < N) {
    const z0 = bark(lo * binHz)
    let hi = lo + 4
    while (hi < N && bark(hi * binHz) - z0 < 0.5) hi++
    if (N - hi < 4) hi = N
    const fc = ((lo + hi) / 2) * binHz
    bands.push({ lo, hi: Math.min(hi, N), z: bark(fc), f: fc })
    lo = hi
  }
  return bands
}

/**
 * dB SPL of a coefficient power. Convention: a full-scale 16-bit sine is 96 dB
 * SPL, i.e. its MDCT peak (bin + neighbour energy, sine window) maps to 96.
 */
export function makeCalibration(N: number): number {
  // A full-scale sine centred on bin k0 (frequency (k0+½)·fs/2N).
  const k0 = Math.round(N / 8)
  const w = sineWindow(N)
  const x = new Float64Array(2 * N)
  for (let n = 0; n < 2 * N; n++) x[n] = 32767 * Math.cos((Math.PI / N) * (n + 0.5 + N / 2) * (k0 + 0.5)) * w[n]
  const X = mdct(x)
  let e = 0
  for (let k = k0 - 2; k <= k0 + 2; k++) e += X[k] * X[k]
  return 96 - 10 * Math.log10(e)
}

export const db = (p: number) => 10 * Math.log10(Math.max(p, 1e-12))
export const undb = (d: number) => 10 ** (d / 10)

export interface Mask {
  /** Mean coefficient power in each band, dB SPL. */
  level: number[]
  /** Tonality 0 (noise) … 1 (pure tone), from the spectral flatness in the band. */
  tonality: number[]
  /** Spread masking from the band energies, before the ATH, dB SPL per coefficient. */
  spread: number[]
  /** ATH per coefficient, dB SPL (the band's quietest point). */
  ath: number[]
  /** Final allowed noise per coefficient: max(spread, ATH), dB SPL. */
  threshold: number[]
}

/**
 * The psychoacoustic model for one frame. Levels are per coefficient (mean
 * power across the band), so a band's threshold compares directly with the
 * quantisation noise per coefficient.
 */
export function maskFor(X: ArrayLike<number>, bands: Band[], fs: number, cal: number): Mask {
  const N = X.length
  const binHz = fs / 2 / N
  const level: number[] = []
  const tonality: number[] = []
  const energy: number[] = []
  for (const b of bands) {
    let sum = 0
    let logSum = 0
    const n = b.hi - b.lo
    for (let k = b.lo; k < b.hi; k++) {
      const p = X[k] * X[k] + 1e-9
      sum += p
      logSum += Math.log(p)
    }
    const mean = sum / n
    level.push(db(mean) + cal)
    energy.push(sum)
    // Spectral flatness: geometric / arithmetic mean. −60 dB or less = tonal.
    const sfm = db(Math.exp(logSum / n) / mean)
    tonality.push(Math.min(1, Math.max(0, sfm / -60)))
  }
  const spread: number[] = []
  for (let j = 0; j < bands.length; j++) {
    let p = 0
    for (let i = 0; i < bands.length; i++) {
      // Masker i's total energy, spread to j, lowered by Johnston's offset.
      const offset = tonality[i] * (14.5 + bands[i].z) + (1 - tonality[i]) * 5.5
      const e = db(energy[i]) + cal + spreading(bands[j].z - bands[i].z) - offset
      p += undb(e)
    }
    // Spread energy is for the whole band; per coefficient divide by its width.
    spread.push(db(p / (bands[j].hi - bands[j].lo)))
  }
  const athB = bands.map((b) => {
    let m = Infinity
    for (let k = b.lo; k < b.hi; k++) m = Math.min(m, ath((k + 0.5) * binHz))
    return m
  })
  const threshold = spread.map((s, j) => Math.max(s, athB[j]))
  return { level, tonality, spread, ath: athB, threshold }
}

// ----------------------------------------------------- quantise & allocate

/** Bits of side information per band: 4 for the step index, plus (when on) 8 for the scale and 4 for the Rice k. */
export const SIDE_OFF = 4
export const SIDE_ON = 4 + 8 + 4
export const MAX_STEP = 15
/** Frame header: global gain etc. */
export const FRAME_HEADER = 16

export interface BandCoding {
  /** 0 = band off (all zero). Otherwise the step is A·2^−s. */
  s: number
  /** Quantiser step. */
  delta: number
  /** Mean squared error per coefficient. */
  noise: number
  bits: number
  k: number
  q: Int32Array
}

/** Scale A of a band: twice its largest coefficient, rounded up to a 1.5 dB grid (what the 8-bit scale field can say). */
export function bandScale(X: ArrayLike<number>, b: Band): number {
  let m = 0
  for (let k = b.lo; k < b.hi; k++) m = Math.max(m, Math.abs(X[k]))
  if (m === 0) return 0
  const e = Math.ceil(4 * Math.log2(2 * m))
  return 2 ** (e / 4)
}

export function codeBand(X: ArrayLike<number>, b: Band, s: number, A: number): BandCoding {
  const n = b.hi - b.lo
  const q = new Int32Array(n)
  if (s === 0 || A === 0) {
    let e = 0
    for (let k = b.lo; k < b.hi; k++) e += X[k] * X[k]
    return { s: 0, delta: 0, noise: e / n, bits: SIDE_OFF, k: 0, q }
  }
  const delta = A * 2 ** -s
  let e = 0
  const u = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const v = X[b.lo + i]
    const qi = Math.round(v / delta)
    q[i] = qi
    u[i] = fold(qi)
    const d = v - qi * delta
    e += d * d
  }
  const r = bestRice(u, 0, n)
  return { s, delta, noise: e / n, bits: SIDE_ON + r.bits, k: r.k, q }
}

export type Allocator = 'perceptual' | 'uniform'

export interface AllocStep {
  band: number
  /** Priority before refining: NMR (perceptual) or noise-to-signal (uniform), dB. */
  key: number
  nmrBefore: number
  nmrAfter: number
  bitsBefore: number
  bitsAfter: number
  /** Frame total after this step. */
  total: number
}

export interface FrameResult {
  coding: BandCoding[]
  nmr: number[]
  bits: number
  steps: AllocStep[]
  /** Stopped because every band was already this far under its mask. */
  transparent: boolean
  /** Reconstructed coefficients. */
  Xq: Float64Array
}

/** Stop refining once every band's noise is this far under its mask. */
export const TRANSPARENT_NMR = -12

/**
 * Greedy allocation. Each step refines (halves the step of) one band by one
 * notch; the perceptual allocator picks the band with the worst noise-to-mask
 * ratio, the uniform one picks the worst noise-to-signal ratio and never looks
 * at the mask. Both stop when nothing affordable is left in the budget.
 */
export function allocate(X: ArrayLike<number>, bands: Band[], mask: Mask, budget: number, mode: Allocator, cal: number, trace = false): FrameResult {
  const A = bands.map((b) => bandScale(X, b))
  const coding = bands.map((b, i) => codeBand(X, b, 0, A[i]))
  let bits = FRAME_HEADER + coding.reduce((s, c) => s + c.bits, 0)
  const nmrOf = (i: number) => db(coding[i].noise) + cal - mask.threshold[i]
  const nsrOf = (i: number) => db(coding[i].noise) + cal - mask.level[i]
  const steps: AllocStep[] = []
  const blocked = new Uint8Array(bands.length)
  let transparent = false
  for (;;) {
    let best = -1
    let bestKey = -Infinity
    for (let i = 0; i < bands.length; i++) {
      if (blocked[i] || A[i] === 0 || coding[i].s >= MAX_STEP) continue
      const key = mode === 'perceptual' ? nmrOf(i) : nsrOf(i)
      if (key > bestKey) {
        bestKey = key
        best = i
      }
    }
    if (best < 0) break
    if (mode === 'perceptual') {
      let worst = -Infinity
      for (let i = 0; i < bands.length; i++) if (A[i] > 0) worst = Math.max(worst, nmrOf(i))
      if (worst < TRANSPARENT_NMR) {
        transparent = true
        break
      }
    }
    const next = codeBand(X, bands[best], coding[best].s + 1, A[best])
    const delta = next.bits - coding[best].bits
    if (bits + delta > budget) {
      blocked[best] = 1
      continue
    }
    const before = nmrOf(best)
    const bitsBefore = coding[best].bits
    coding[best] = next
    bits += delta
    if (trace) steps.push({ band: best, key: bestKey, nmrBefore: before, nmrAfter: nmrOf(best), bitsBefore, bitsAfter: next.bits, total: bits })
  }
  const Xq = new Float64Array(X.length)
  coding.forEach((c, i) => {
    for (let j = 0; j < c.q.length; j++) Xq[bands[i].lo + j] = c.q[j] * c.delta
  })
  return { coding, nmr: coding.map((_, i) => nmrOf(i)), bits, steps, transparent, Xq }
}

// ------------------------------------------------------------- whole signal

export interface CodecResult {
  N: number
  fs: number
  bands: Band[]
  cal: number
  frames: Float64Array[]
  masks: Mask[]
  results: FrameResult[]
  decoded: Float64Array
  bits: number
  /** Achieved bits per second. */
  bitrate: number
  snr: number
  /** Mean NMR over bands with signal above the ATH, dB. */
  meanNmr: number
  /** Share of (frame, band) pairs whose noise is above the mask. */
  audible: number
}

export function encode(x: ArrayLike<number>, fs: number, kbps: number, mode: Allocator, N = 1024): CodecResult {
  const bands = makeBands(N, fs)
  const cal = makeCalibration(N)
  const { frames } = analyse(x, N)
  const budget = Math.floor((kbps * 1000 * N) / fs)
  const masks = frames.map((X) => maskFor(X, bands, fs, cal))
  const results = frames.map((X, f) => allocate(X, bands, masks[f], budget, mode, cal))
  const decoded = synthesise(
    results.map((r) => r.Xq),
    N,
    x.length,
  )
  let sig = 0
  let err = 0
  for (let i = 0; i < x.length; i++) {
    sig += x[i] * x[i]
    const d = decoded[i] - x[i]
    err += d * d
  }
  let nmrSum = 0
  let nmrN = 0
  let above = 0
  results.forEach((r, f) => {
    r.nmr.forEach((v, i) => {
      if (masks[f].level[i] < masks[f].ath[i]) return // inaudible to begin with
      nmrSum += v
      nmrN++
      if (v > 0) above++
    })
  })
  const bits = results.reduce((s, r) => s + r.bits, 0)
  return {
    N,
    fs,
    bands,
    cal,
    frames,
    masks,
    results,
    decoded,
    bits,
    bitrate: (bits * fs) / Math.max(1, x.length),
    snr: db(sig / Math.max(err, 1e-12)),
    meanNmr: nmrN ? nmrSum / nmrN : -Infinity,
    audible: nmrN ? above / nmrN : 0,
  }
}
