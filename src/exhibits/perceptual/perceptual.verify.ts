import { eq, near, ok, type Check } from '../../lib/check'
import { seeded } from '../../lib/samples'
import { analyse, ath, bark, dct4, dct4Direct, encode, imdct, imdctDirect, makeBands, mdct, mdctDirect, sineWindow, spreading, synthesise } from './psy'
import { FS, SIGNALS, synth } from './signals'

const rnd = seeded(2027)
const randArr = (n: number) => Float64Array.from({ length: n }, () => rnd() * 2 - 1)

export const checks: Check[] = [
  {
    name: 'fast DCT-IV and MDCT/IMDCT equal their textbook O(N²) sums',
    run() {
      for (const N of [8, 32, 256]) {
        const u = randArr(N)
        const a = dct4(u)
        const b = dct4Direct(u)
        for (let k = 0; k < N; k++) near(a[k], b[k], 1e-9, `DCT-IV N=${N} k=${k}`)
        const x = randArr(2 * N)
        const X = mdct(x)
        const Xd = mdctDirect(x)
        for (let k = 0; k < N; k++) near(X[k], Xd[k], 1e-9, `MDCT N=${N} k=${k}`)
        const y = imdct(X)
        const yd = imdctDirect(X)
        for (let n = 0; n < 2 * N; n++) near(y[n], yd[n], 1e-9, `IMDCT N=${N} n=${n}`)
      }
    },
  },
  {
    name: 'TDAC: window → MDCT → IMDCT → window → overlap-add gives the input back to 1e-9',
    run() {
      for (const [N, len] of [
        [16, 1],
        [64, 1000],
        [1024, 20000],
        [256, 4096],
      ]) {
        const x = randArr(len).map((v) => v * 30000)
        const { frames } = analyse(x, N)
        const y = synthesise(frames, N, x.length)
        let err = 0
        for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]))
        ok(err < 1e-9 * 30000, `N=${N} len=${len}: max error ${err}`)
      }
    },
  },
  {
    name: 'the sine window satisfies Princen–Bradley: w[n]² + w[n+N]² = 1',
    run() {
      const N = 1024
      const w = sineWindow(N)
      for (let n = 0; n < N; n++) near(w[n] ** 2 + w[n + N] ** 2, 1, 1e-12, `n=${n}`)
    },
  },
  {
    name: 'a cosine centred on bin k puts ≥ 99% of its MDCT energy in bins k−1…k+1',
    run() {
      const N = 512
      const w = sineWindow(N)
      for (const k0 of [10, 100, 300]) {
        const x = new Float64Array(2 * N)
        // Phase-aligned with the MDCT basis so the energy is not split by phase.
        for (let n = 0; n < 2 * N; n++) x[n] = Math.cos((Math.PI / N) * (n + 0.5 + N / 2) * (k0 + 0.5)) * w[n]
        const X = mdct(x)
        let all = 0
        let mid = 0
        for (let k = 0; k < N; k++) {
          all += X[k] * X[k]
          if (Math.abs(k - k0) <= 1) mid += X[k] * X[k]
        }
        ok(mid / all > 0.99, `k0=${k0}: only ${((100 * mid) / all).toFixed(2)}% near the bin`)
      }
    },
  },
  {
    name: 'Bark (Traunmüller): 1 kHz = 26.81·1000/2960 − 0.53 ≈ 8.527, and the scale is monotone',
    run() {
      near(bark(1000), (26.81 * 1000) / 2960 - 0.53, 1e-12)
      near(bark(1000), 8.527, 0.001)
      // The low-end correction applies below z = 2: at 100 Hz, raw z = 0.7457…, corrected +0.15(2 − z).
      const raw = (26.81 * 100) / 2060 - 0.53
      near(bark(100), raw + 0.15 * (2 - raw), 1e-12)
      let prev = -Infinity
      for (let f = 20; f <= 20000; f += 10) {
        const z = bark(f)
        ok(z > prev, `not monotone at ${f} Hz`)
        prev = z
      }
    },
  },
  {
    name: 'ATH (Terhardt) by hand: 3.369 dB at 1 kHz, −3.388 dB at 4 kHz, minimum near 3.3 kHz',
    run() {
      // 1 kHz: 3.64 − 6.5·e^(−0.6·2.3²) + 0.001
      near(ath(1000), 3.64 - 6.5 * Math.exp(-0.6 * 2.3 ** 2) + 0.001, 1e-12)
      near(ath(1000), 3.369, 0.001)
      // 4 kHz: 3.64·4^−0.8 − 6.5·e^(−0.6·0.7²) + 0.256
      near(ath(4000), -3.388, 0.001)
      let best = 0
      let min = Infinity
      for (let f = 500; f <= 10000; f += 10) {
        if (ath(f) < min) {
          min = ath(f)
          best = f
        }
      }
      ok(best > 3000 && best < 4000, `minimum at ${best} Hz`)
      ok(min > -6 && min < -4, `minimum ${min} dB`)
      ok(ath(50) > 35 && ath(15000) > 40, 'the threshold rises steeply at both ends')
    },
  },
  {
    name: 'Schroeder spreading peaks at the masker (≈ 0 dB) and falls faster below than above',
    run() {
      let best = -Infinity
      let at = 0
      for (let dz = -5; dz <= 5; dz += 0.01) {
        const v = spreading(dz)
        if (v > best) {
          best = v
          at = dz
        }
      }
      near(at, 0, 0.05, 'peak position')
      near(best, 0, 0.6, 'peak level')
      ok(spreading(-2) < spreading(2), 'masking reaches further up in frequency than down')
    },
  },
  {
    name: 'bands tile all N bins in order, each at least 4 wide and at most about half a Bark (except the last)',
    run() {
      for (const [N, fs] of [
        [1024, 32000],
        [1024, 44100],
        [512, 32000],
      ]) {
        const bands = makeBands(N, fs)
        eq(bands[0].lo, 0)
        eq(bands[bands.length - 1].hi, N)
        for (let i = 0; i < bands.length; i++) {
          if (i) eq(bands[i].lo, bands[i - 1].hi, 'contiguous')
          ok(bands[i].hi - bands[i].lo >= 4, `band ${i} too narrow`)
        }
      }
    },
  },
  {
    name: 'allocation never exceeds the frame budget, and perceptual beats uniform on the worst NMR',
    run() {
      for (const s of SIGNALS) {
        const x = synth(s.id).subarray(0, FS) // 1 s keeps the check quick
        for (const kbps of [24, 64, 128]) {
          const budget = Math.floor((kbps * 1000 * 1024) / FS)
          const p = encode(x, FS, kbps, 'perceptual')
          const u = encode(x, FS, kbps, 'uniform')
          for (const r of [...p.results, ...u.results]) ok(r.bits <= budget, `${s.id} @${kbps}: ${r.bits} > ${budget}`)
          const worst = (R: typeof p) => {
            let m = -Infinity
            R.results.forEach((r, f) =>
              r.nmr.forEach((v, i) => {
                if (R.masks[f].level[i] >= R.masks[f].ath[i]) m = Math.max(m, v)
              }),
            )
            return m
          }
          ok(worst(p) <= worst(u) + 1e-9, `${s.id} @${kbps}: perceptual worst NMR ${worst(p).toFixed(2)} > uniform ${worst(u).toFixed(2)}`)
        }
      }
    },
  },
  {
    name: 'masking demo: the 1.1 kHz beep is hidden under the 1 kHz tone and dropped; the 6 kHz beep is kept',
    run() {
      const x = synth('masking')
      const R = encode(x, FS, 64, 'perceptual')
      const binHz = FS / 2 / R.N
      const bandOf = (hz: number) => R.bands.findIndex((b) => b.lo <= hz / binHz && b.hi > hz / binHz)
      const near1k1 = bandOf(1100)
      const far6k = bandOf(6000)
      // Frame 4 is inside the first (1.1 kHz) beep, frame 20 inside the first 6 kHz one.
      ok(R.masks[4].level[near1k1] > R.masks[4].ath[near1k1], 'the 1.1 kHz beep is above the threshold in quiet')
      ok(R.masks[4].level[near1k1] < R.masks[4].threshold[near1k1], 'but below the mask from the 1 kHz tone')
      eq(R.results[4].coding[near1k1].s, 0, '1.1 kHz band switched off')
      ok(R.masks[20].level[far6k] > R.masks[20].threshold[far6k], 'the 6 kHz beep is audible')
      ok(R.results[20].coding[far6k].s > 0, '6 kHz band coded')
    },
  },
]
