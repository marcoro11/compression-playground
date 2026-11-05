import { eq, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { encodeImage, quantTable } from '../jpeg/jpeg'
import { codeById, codeLength, encodeBits } from '../intcodes/codes'
import { H, W, makeSequence } from './frames'
import { search, predictBlock, sad, type Frame, type Method } from './motion'
import { DEFAULTS, decodeSequence, decodeVectors, encodeSequence, mvPredictor, psnr, seMap, seUnmap, ueBits, ueLength, type MV } from './encoder'

/** A random-texture frame and a copy of it shifted by (sx, sy): cur(x, y) = ref(x − sx, y − sy). */
function shifted(sx: number, sy: number, seed: number, smooth: boolean): { cur: Frame; ref: Frame } {
  const r = seeded(seed)
  const w = 96
  const h = 96
  const base = new Float64Array(w * h).map(() => r() * 255)
  const ref = new Uint8ClampedArray(w * h)
  if (smooth) {
    // One wide Gaussian hill peaking inside the test block (40…55): the SAD surface is a single bowl —
    // the case fast searches assume. (On the hill's flank it would be a valley along the contour
    // instead — the aperture problem — and no search could pin the motion down.)
    const cx = 44 + r() * 8
    const cy = 44 + r() * 8
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) ref[y * w + x] = Math.round(20 + 220 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 22 ** 2)))
  } else for (let i = 0; i < base.length; i++) ref[i] = Math.round(base[i])
  const cur = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const xx = Math.min(w - 1, Math.max(0, x - sx))
      const yy = Math.min(h - 1, Math.max(0, y - sy))
      cur[y * w + x] = ref[yy * w + xx]
    }
  return { cur: { data: cur, w, h }, ref: { data: ref, w, h } }
}

export const checks: Check[] = [
  {
    name: 'full search finds a known integer displacement exactly (SAD = 0) in random texture, 60 cases',
    run() {
      const r = seeded(4)
      for (let t = 0; t < 60; t++) {
        const sx = Math.floor(r() * 15) - 7
        const sy = Math.floor(r() * 15) - 7
        const { cur, ref } = shifted(sx, sy, 100 + t, false)
        // Block in the interior so the shift never reaches outside the frame.
        const s = search(cur, ref, 40, 40, 16, { method: 'full', range: 8, halfPel: false })
        // cur(x) = ref(x − s) ⇒ the matching reference block is at offset −s.
        eq([s.mx / 2, s.my / 2, s.sad], [-sx, -sy, 0], `shift (${sx}, ${sy})`)
      }
    },
  },
  {
    name: 'on a single smooth hill diamond search is exact and three-step lands within a pixel, both at a fraction of full search’s cost',
    run() {
      const r = seeded(8)
      let tssExact = 0
      for (let t = 0; t < 40; t++) {
        const sx = Math.floor(r() * 7) - 3
        const sy = Math.floor(r() * 7) - 3
        const { cur, ref } = shifted(sx, sy, 300 + t, true)
        const d = search(cur, ref, 40, 40, 16, { method: 'diamond', range: 7, halfPel: false })
        eq([d.mx / 2, d.my / 2, d.sad], [-sx, -sy, 0], `diamond, shift (${sx}, ${sy})`)
        const s = search(cur, ref, 40, 40, 16, { method: 'tss', range: 7, halfPel: false })
        ok(Math.abs(s.mx / 2 + sx) <= 1 && Math.abs(s.my / 2 + sy) <= 1, `tss within a pixel, shift (${sx}, ${sy}): got (${s.mx / 2}, ${s.my / 2})`)
        ok(s.sad <= sad(cur, ref, 40, 40, 16, 0, 0), 'tss never worse than no motion')
        if (s.sad === 0) tssExact++
        for (const x of [d, s]) ok(x.evaluated < 15 * 15 / 4, `fast search should evaluate under a quarter of full search's 225 (got ${x.evaluated})`)
      }
      ok(tssExact >= 30, `tss should still be exact most of the time (${tssExact}/40)`)
    },
  },
  {
    name: 'on rough texture the fast searches get trapped in local minima that full search never falls into',
    run() {
      const r = seeded(21)
      const miss = { tss: 0, diamond: 0, full: 0 }
      for (let t = 0; t < 60; t++) {
        const sx = Math.floor(r() * 13) - 6
        const sy = Math.floor(r() * 13) - 6
        const { cur, ref } = shifted(sx, sy, 700 + t, false)
        for (const method of ['tss', 'diamond', 'full'] as Method[]) {
          const s = search(cur, ref, 40, 40, 16, { method, range: 7, halfPel: false })
          if (s.mx !== -2 * sx || s.my !== -2 * sy) miss[method]++
        }
      }
      eq(miss.full, 0, 'full search')
      ok(miss.tss > 0 && miss.diamond > 0, `fast searches should miss some (tss ${miss.tss}, diamond ${miss.diamond} of 60)`)
    },
  },
  {
    name: 'early termination never changes the result: traced and fast searches agree (all methods, half-pel on)',
    run() {
      const seq = makeSequence('scene')
      const cur = { data: seq.frames[6], w: W, h: H }
      const ref = { data: seq.frames[5], w: W, h: H }
      for (const method of ['full', 'tss', 'diamond'] as Method[])
        for (let by = 0; by < H; by += 16)
          for (let bx = 0; bx < W; bx += 16) {
            const a = search(cur, ref, bx, by, 16, { method, range: 8, halfPel: true })
            const b = search(cur, ref, bx, by, 16, { method, range: 8, halfPel: true, trace: true })
            eq([a.mx, a.my, a.sad], [b.mx, b.my, b.sad], `${method} block (${bx}, ${by})`)
            eq(b.sad, sad(cur, ref, bx, by, 16, b.mx, b.my), 'reported SAD is the real SAD')
          }
    },
  },
  {
    name: 'on the pure-translation sequence the true vector (−3, −1) predicts every interior block exactly',
    run() {
      const seq = makeSequence('pan')
      for (let t = 1; t < seq.frames.length; t++) {
        const cur = { data: seq.frames[t], w: W, h: H }
        const ref = { data: seq.frames[t - 1], w: W, h: H }
        // Interior: blocks whose source (3 px right, 1 px down) stays inside the frame.
        for (let by = 0; by + 16 <= H - 16; by += 16)
          for (let bx = 0; bx + 16 <= W - 16; bx += 16) {
            const p = predictBlock(ref, bx, by, 16, 6, 2)
            for (let y = 0; y < 16; y++)
              for (let x = 0; x < 16; x++) {
                const d = cur.data[(by + y) * W + bx + x] - p[y * 16 + x]
                if (d !== 0) throw new Error(`frame ${t}, block (${bx}, ${by}): residual ${d} at (${x}, ${y})`)
              }
            const s = search(cur, ref, bx, by, 16, { method: 'full', range: 4, halfPel: true })
            eq([s.mx, s.my, s.sad], [6, 2, 0], `search agrees, frame ${t} block (${bx}, ${by})`)
          }
      }
    },
  },
  {
    name: 'half-pel: a sequence moving 0.5 px per frame is matched at an odd (half-pel) vector, with lower SAD than any whole pixel',
    run() {
      const seq = makeSequence('scene')
      // The wall pans 1.5 px per frame; the bottom-left of the frame is wall only.
      const cur = { data: seq.frames[8], w: W, h: H }
      const ref = { data: seq.frames[7], w: W, h: H }
      const whole = search(cur, ref, 16, 112, 16, { method: 'full', range: 6, halfPel: false })
      const half = search(cur, ref, 16, 112, 16, { method: 'full', range: 6, halfPel: true })
      eq([half.mx, half.my], [3, 0], 'the wall moved 1.5 px left in reference terms → mv (3, 0) half-pels')
      ok(half.sad < whole.sad, `half-pel SAD ${half.sad} should beat whole-pel ${whole.sad}`)
    },
  },
  {
    name: 'Exp-Golomb: H.264 se(v) mapping, ue(v) codewords and lengths, and agreement with the Integer Codes exhibit',
    run() {
      eq([0, 1, -1, 2, -2, 3, -3].map(seMap), [0, 1, 2, 3, 4, 5, 6])
      for (let v = -500; v <= 500; v++) eq(seUnmap(seMap(v)), v)
      eq([0, 1, 2, 3, 4, 7].map(ueBits), ['1', '010', '011', '00100', '00101', '0001000'])
      const eg = codeById('expgolomb')
      for (let k = 0; k < 5000; k++) {
        eq(ueBits(k).length, ueLength(k), `closed-form length at ${k}`)
        eq(ueBits(k), encodeBits(eg, k, 0), `matches Exp-Golomb k=0 from the Integer Codes exhibit at ${k}`)
        eq(ueLength(k), codeLength(eg, k, 0))
      }
    },
  },
  {
    name: 'motion-vector predictor follows the H.264 median rule (hand-worked 3×2 example)',
    run() {
      // Grid of 3 columns. Row 0: A0, A1, A2. Row 1: block 3 (left edge), 4 (middle), 5 (right edge).
      const m = (mx: number, my: number): MV => ({ mx, my })
      const mvs: MV[] = [m(2, 0), m(6, -2), m(4, 4), m(-2, 2), m(0, 0)]
      eq(mvPredictor(mvs, 3, 0), m(0, 0), 'first block: nothing available')
      eq(mvPredictor(mvs, 3, 1), m(2, 0), 'top row: left only')
      // Left edge: A unavailable counts as (0, 0); B = (2, 0), C = (6, −2) → median(0, 2, 6) = 2, median(0, 0, −2) = 0.
      eq(mvPredictor(mvs, 3, 3), m(2, 0), 'left edge')
      // Middle: A = (−2, 2), B = (6, −2), C = (4, 4) → median(−2, 6, 4) = 4, median(2, −2, 4) = 2.
      eq(mvPredictor(mvs, 3, 4), m(4, 2), 'middle')
      eq(mvPredictor(mvs, 3, 5), m(4, 0), 'right edge: C unavailable → D=(6,−2); A=(0,0), B=(4,4) → median(0,4,6)=4, median(0,4,−2)=0')
    },
  },
  {
    name: 'decoder re-derives every motion vector from the transmitted differences',
    run() {
      const seq = makeSequence('scene')
      const e = encodeSequence(seq.frames.slice(0, 6), { ...DEFAULTS, method: 'diamond' })
      for (const f of e.frames)
        if (f.type === 'P') {
          const got = decodeVectors(f.mbs!, W / 16)
          eq(
            got,
            f.mbs!.map((mb) => mb.mv),
          )
        }
    },
  },
  {
    name: 'closed loop: the decoder reproduces the encoder’s reconstruction bit for bit (3 sequences × 2 settings); open loop drifts',
    run() {
      for (const id of ['scene', 'pan', 'zoom'] as const) {
        const seq = makeSequence(id)
        for (const o of [
          { ...DEFAULTS, blockSize: 16 as const, quality: 50 },
          { ...DEFAULTS, blockSize: 8 as const, quality: 20, halfPel: false, method: 'tss' as Method, gop: 6 },
        ]) {
          const e = encodeSequence(seq.frames.slice(0, 14), o)
          const dec = decodeSequence(e)
          dec.forEach((d, i) => {
            for (let k = 0; k < d.length; k++) if (d[k] !== e.frames[i].recon[k]) throw new Error(`${id} frame ${i}: decoder differs at pixel ${k}`)
          })
        }
      }
      // Open loop: the encoder predicts from originals the decoder never sees.
      const seq = makeSequence('scene')
      const frames = seq.frames.slice(0, 18)
      const closed = encodeSequence(frames, { ...DEFAULTS, gop: 100, adaptiveKeyframes: false })
      const open = encodeSequence(frames, { ...DEFAULTS, gop: 100, adaptiveKeyframes: false, loop: 'open' })
      const pc = decodeSequence(closed).map((d, i) => psnr(frames[i], d))
      const po = decodeSequence(open).map((d, i) => psnr(frames[i], d))
      ok(po[17] < pc[17] - 3, `open-loop decoder should end at least 3 dB worse (closed ${pc[17].toFixed(1)}, open ${po[17].toFixed(1)})`)
      ok(po[17] < po[1] - 1, `and its quality should fall over the GOP (${po[1].toFixed(1)} → ${po[17].toFixed(1)})`)
    },
  },
  {
    name: 'an I-frame costs exactly what the JPEG exhibit’s encoder says, and decodes to its reconstruction',
    run() {
      const seq = makeSequence('scene')
      for (const q of [10, 50, 90]) {
        const e = encodeSequence(seq.frames.slice(0, 1), { ...DEFAULTS, quality: q })
        const j = encodeImage(seq.frames[0], W, H, q)
        eq(e.frames[0].type, 'I')
        eq(e.frames[0].total, j.scanBits, `quality ${q} bits`)
        eq(quantTable(q).length, 64)
        const dec = decodeSequence(e)[0]
        for (let k = 0; k < dec.length; k++) if (dec[k] !== j.recon[k]) throw new Error(`q${q}: pixel ${k} differs from JPEG’s reconstruction`)
      }
    },
  },
  {
    name: 'adaptive keyframes catch the scene cut: frame 20 is coded intra because predicting it would cost more',
    run() {
      const seq = makeSequence('scene')
      const e = encodeSequence(seq.frames, { ...DEFAULTS, gop: 100 })
      eq(e.frames[20].type, 'I')
      eq(e.frames[20].reason, 'cheaper')
      const forced = encodeSequence(seq.frames, { ...DEFAULTS, gop: 100, adaptiveKeyframes: false })
      eq(forced.frames[20].type, 'P')
      ok(forced.frames[20].total > forced.frames[20].intraBits, 'the forced P-frame after the cut costs more than an I-frame would')
      ok(e.totalBits < e.allIntraBits / 1.5, 'and prediction overall saves at least a third against all-intra')
    },
  },
]
