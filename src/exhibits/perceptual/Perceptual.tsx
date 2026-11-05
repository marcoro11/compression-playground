import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { fmt, int } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import { encodeStream, parseWav } from '../flac/flac'
import { allocate, codeBand, db, encode, TRANSPARENT_NMR, type Allocator, type CodecResult } from './psy'
import { FS, SIGNALS, synth, type SignalId } from './signals'
import { BandBars, ChartLegend, FrameChart, Scope, Spectrogram } from './views'
import './perceptual.css'

// ------------------------------------------------------------------ audio out

let audioCtx: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null

function play(x: ArrayLike<number>, rate: number, normalise = false) {
  try {
    audioCtx ??= new AudioContext()
    playing?.stop()
    const buf = audioCtx.createBuffer(1, x.length, rate)
    const ch = buf.getChannelData(0)
    let peak = 1
    if (normalise) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
    const scale = normalise ? 0.5 / peak : 1 / 32768
    for (let i = 0; i < x.length; i++) ch[i] = Math.max(-1, Math.min(1, x[i] * scale))
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    src.connect(audioCtx.destination)
    src.start()
    playing = src
  } catch {
    /* no audio here — everything else still works */
  }
}

function stop() {
  try {
    playing?.stop()
  } catch {
    /* already stopped */
  }
  playing = null
}

// ------------------------------------------------------------------ metrics

/** Per-frame share of audible-to-begin-with bands whose noise is over the mask. */
function frameMarks(R: CodecResult): number[] {
  return R.results.map((r, f) => {
    let n = 0
    let over = 0
    r.nmr.forEach((v, i) => {
      if (R.masks[f].level[i] < R.masks[f].ath[i]) return
      n++
      if (v > 0) over++
    })
    return n ? over / n : 0
  })
}

/** Mean over frames of the worst band's NMR (frames with something audible). */
function meanWorst(R: CodecResult): number {
  let s = 0
  let n = 0
  R.results.forEach((r, f) => {
    let m = -Infinity
    r.nmr.forEach((v, i) => {
      if (R.masks[f].level[i] >= R.masks[f].ath[i]) m = Math.max(m, v)
    })
    if (m > -Infinity) {
      s += m
      n++
    }
  })
  return n ? s / n : -Infinity
}

// ------------------------------------------------------------- the steps

type Stage = 'frame' | 'mdct' | 'bands' | 'ath' | 'spread' | 'threshold' | 'alloc' | 'quant' | 'ola'
const STAGE_LABEL: Record<Stage, string> = {
  frame: 'window',
  mdct: 'MDCT',
  bands: 'bands',
  ath: 'quiet threshold',
  spread: 'spreading',
  threshold: 'mask',
  alloc: 'allocate bits',
  quant: 'quantised',
  ola: 'decode',
}
const ORDER: Stage[] = ['frame', 'mdct', 'bands', 'ath', 'spread', 'threshold', 'alloc', 'quant', 'ola']

const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`)
const sdb = (v: number) => (Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' : '—')

interface Source {
  id: SignalId | 'wav'
  label: string
  x: Float64Array
  fs: number
}

export function Perceptual() {
  const [sigId, setSigId] = useState<SignalId>('masking')
  const [wav, setWav] = useState<Source | null>(null)
  const [wavError, setWavError] = useState<string | null>(null)
  const [kbps, setKbps] = useState(48)
  const [mode, setMode] = useState<Allocator>('perceptual')
  const [frameSel, setFrameSel] = useState(4)
  const [specView, setSpecView] = useState<'original' | 'decoded' | 'noise'>('original')

  const src: Source = useMemo(() => {
    if (wav) return wav
    return { id: sigId, label: SIGNALS.find((s) => s.id === sigId)!.label, x: synth(sigId), fs: FS }
  }, [sigId, wav])
  const { x, fs } = src

  const rate = useDeferredValue(kbps)
  const R = useMemo(() => encode(x, fs, rate, mode), [x, fs, rate, mode])
  const other = useMemo(() => encode(x, fs, rate, mode === 'perceptual' ? 'uniform' : 'perceptual'), [x, fs, rate, mode])
  const P = mode === 'perceptual' ? R : other
  const U = mode === 'perceptual' ? other : R
  const marks = useMemo(() => frameMarks(R), [R])

  // Lossless reference (the FLAC exhibit's encoder), off the critical path.
  const [flacBits, setFlacBits] = useState<number | null>(null)
  useEffect(() => {
    setFlacBits(null)
    const t = setTimeout(() => {
      const xi = Int32Array.from(x, (v) => Math.round(v))
      setFlacBits(encodeStream(xi, { bps: 16, blockSize: 4096, mode: 'auto', maxLpc: 8, maxPo: 6, precision: 12 }).bits)
    }, 60)
    return () => clearTimeout(t)
  }, [x])

  const F = R.frames.length
  const f = Math.max(0, Math.min(F - 1, frameSel))
  const N = R.N
  const budget = Math.floor((rate * 1000 * N) / fs)
  const binHz = fs / 2 / N

  // Re-run this frame's allocation with a trace, and replay it so every step has its own noise picture.
  const trace = useMemo(() => allocate(R.frames[f], R.bands, R.masks[f], budget, mode, R.cal, true), [R, f, budget, mode])
  const replay = useMemo(() => {
    const X = R.frames[f]
    const initial = R.bands.map((b) => codeBand(X, b, 0, 0))
    let curN = initial.map((c) => db(c.noise) + R.cal)
    let curB = initial.map((c) => c.bits)
    const noise: number[][] = [curN]
    const bits: number[][] = [curB]
    for (const st of trace.steps) {
      curN = curN.slice()
      curB = curB.slice()
      curN[st.band] = st.nmrAfter + R.masks[f].threshold[st.band]
      curB[st.band] = st.bitsAfter
      noise.push(curN)
      bits.push(curB)
    }
    return { noise, bits }
  }, [R, f, trace])

  const S = trace.steps.length
  // States: 0–5 the analysis stages, 6…6+S allocation (6 = nothing allocated yet), then quantised, then decoded.
  const count = 9 + S
  const stepper = useStepper(count, { speed: 6, resetKey: `${src.id}:${src.label}:${f}:${mode}:${rate}` })
  const i = stepper.index
  const stage: Stage = i <= 5 ? ORDER[i] : i <= 6 + S ? 'alloc' : i === 7 + S ? 'quant' : 'ola'
  const allocT = stage === 'alloc' ? i - 6 : ORDER.indexOf(stage) > 6 ? S : 0
  const stepInfo = stage === 'alloc' && allocT >= 1 ? trace.steps[allocT - 1] : null

  const mask = R.masks[f]
  const X = R.frames[f]
  const noiseNow = ORDER.indexOf(stage) >= 6 ? replay.noise[Math.min(allocT, replay.noise.length - 1)] : undefined
  const bitsNow = replay.bits[Math.min(allocT, replay.bits.length - 1)]
  const nmrNow = noiseNow ? noiseNow.map((v, b) => v - mask.threshold[b]) : mask.level.map(() => 0)
  const audibleNow = mask.level.map((l, b) => l >= mask.ath[b])
  const bitsTotal = (ORDER.indexOf(stage) >= 6 ? bitsNow : replay.bits[0]).reduce((a, b) => a + b, 0) + 16

  // Strongest masker band.
  const masker = useMemo(() => {
    let best = 0
    mask.level.forEach((l, b) => {
      if (l + 10 * Math.log10(R.bands[b].hi - R.bands[b].lo) > mask.level[best] + 10 * Math.log10(R.bands[best].hi - R.bands[best].lo)) best = b
    })
    return best
  }, [mask, R.bands])

  // Time-domain view of this frame.
  const seg = useMemo(() => {
    const a = (f - 1) * N
    const len = 2 * N
    const orig = new Float64Array(len)
    const dec = new Float64Array(len)
    const err = new Float64Array(len)
    for (let k = 0; k < len; k++) {
      const j = a + k
      if (j >= 0 && j < x.length) {
        orig[k] = x[j]
        dec[k] = R.decoded[j]
        err[k] = R.decoded[j] - x[j]
      }
    }
    let ps = 0
    let pe = 0
    for (let k = 0; k < len; k++) {
      ps += orig[k] * orig[k]
      pe += err[k] * err[k]
    }
    return { orig, dec, err, snr: db(ps / Math.max(pe, 1e-9)), start: a }
  }, [f, N, x, R.decoded])

  const specFrames = useMemo(() => {
    if (specView === 'original') return R.frames
    if (specView === 'decoded') return R.results.map((r) => r.Xq)
    return R.frames.map((Xf, k) => {
      const q = R.results[k].Xq
      const d = new Float64Array(Xf.length)
      for (let j = 0; j < Xf.length; j++) d[j] = Xf[j] - q[j]
      return d
    })
  }, [R, specView])

  const pcmBits = x.length * 16
  const zeroBands = trace.coding.filter((c) => c.s === 0).length
  const hiddenBands = mask.level.filter((l, b) => l >= mask.ath[b] && l < mask.threshold[b]).length
  const quietBands = mask.level.filter((l, b) => l < mask.ath[b]).length
  const band = (b: number) => `${hz(R.bands[b].lo * binHz)}–${hz(R.bands[b].hi * binHz)}`
  const peakBin = useMemo(() => {
    let k = 0
    for (let j = 1; j < X.length; j++) if (Math.abs(X[j]) > Math.abs(X[k])) k = j
    return k
  }, [X])

  const loadWav = async (file: File | undefined) => {
    if (!file) return
    try {
      const { samples, rate: r } = parseWav(await file.arrayBuffer(), 6 * 48000)
      const n = Math.min(samples.length, Math.round(6 * r))
      setWav({ id: 'wav', label: file.name, x: Float64Array.from(samples.subarray(0, n)), fs: r })
      setWavError(null)
      setFrameSel(Math.floor(n / 1024 / 3))
    } catch (e) {
      setWavError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickSignal = (id: SignalId) => {
    setWav(null)
    setSigId(id)
    if (id === 'masking') setFrameSel(4)
    else {
      // Start on the loudest frame: the interesting one.
      const xs = synth(id)
      let best = 0
      let bestE = -1
      for (let k = 0; k * 1024 < xs.length; k++) {
        let e = 0
        for (let j = k * 1024; j < Math.min(xs.length, (k + 1) * 1024); j++) e += xs[j] * xs[j]
        if (e > bestE) {
          bestE = e
          best = k + 1
        }
      }
      setFrameSel(id === 'drums' ? 6 : best)
    }
  }

  const layers = {
    spectrum: ORDER.indexOf(stage) >= 1,
    bands: ORDER.indexOf(stage) >= 2,
    ath: ORDER.indexOf(stage) >= 3,
    spread: ORDER.indexOf(stage) >= 4,
    masker: stage === 'spread' ? masker : undefined,
    threshold: ORDER.indexOf(stage) >= 5,
    noise: noiseNow,
    quantised: stage === 'quant' || stage === 'ola' ? trace.Xq : undefined,
    highlight: stepInfo ? stepInfo.band : stage === 'spread' ? masker : undefined,
  }

  const audibleNmr = nmrNow.filter((_, b) => audibleNow[b])
  const worstNow = noiseNow && audibleNmr.length ? Math.max(...audibleNmr) : NaN

  let narration: React.ReactNode
  if (stage === 'frame') {
    narration = (
      <>
        Frame {f}: samples {int(Math.max(0, seg.start))}–{int(seg.start + 2 * N)} ({fmt((2 * N * 1000) / fs, 0)} ms), multiplied by a sine
        window. Each sample sits in two frames, and the window is built so the two copies add back to exactly the original — the
        Princen–Bradley condition.
      </>
    )
  } else if (stage === 'mdct') {
    narration = (
      <>
        The MDCT turns {2 * N} windowed samples into {N} coefficients, {fmt(binHz, 2)} Hz apart — half as many numbers as samples, because the
        overlap supplies the rest. The strongest is at {hz((peakBin + 0.5) * binHz)}: {fmt(db(X[peakBin] ** 2) + R.cal, 0)} dB SPL, taking a
        full-scale sine as 96 dB.
      </>
    )
  } else if (stage === 'bands') {
    narration = (
      <>
        {R.bands.length} scale-factor bands of about half a Bark — {hz((R.bands[0].hi - R.bands[0].lo) * binHz)} wide at the bottom,{' '}
        {hz((R.bands[R.bands.length - 1].hi - R.bands[R.bands.length - 1].lo) * binHz)} at the top — because the ear resolves low frequencies
        far more finely than high ones. The thick steps are each band’s level per coefficient.
      </>
    )
  } else if (stage === 'ath') {
    narration = (
      <>
        The absolute threshold of hearing (Terhardt’s fit to the measurements): in perfect silence, nothing below the dashed line is heard. It
        dips to about −5 dB near 3.3 kHz, where the ear canal resonates, and climbs steeply at both ends. {quietBands} of {R.bands.length}{' '}
        bands are entirely below it in this frame — free to throw away.
      </>
    )
  } else if (stage === 'spread') {
    narration = (
      <>
        A loud sound raises the threshold around it. The violet curve is what the band at {hz(R.bands[masker].f)} alone can hide: its energy
        spread along the Bark scale (Schroeder’s function falls about 25 dB per Bark below the masker and only about 10 above), lowered by an
        offset of {fmt(mask.tonality[masker] * (14.5 + R.bands[masker].z) + (1 - mask.tonality[masker]) * 5.5, 1)} dB — larger for a tone (
        {fmt(mask.tonality[masker] * 100, 0)}% tonal here) than for noise, because noise masks better. The grey steps add up every band’s
        contribution.
      </>
    )
  } else if (stage === 'threshold') {
    narration = (
      <>
        The mask is whichever is higher, spread masking or the threshold in quiet. Noise below the pink line is inaudible, so it is the error
        budget. {hiddenBands > 0 ? `${hiddenBands} band${hiddenBands === 1 ? ' is' : 's are'} above the quiet threshold yet under the mask — audible on their own, inaudible here.` : 'No band in this frame is hidden by masking alone.'}
      </>
    )
  } else if (stage === 'alloc') {
    if (!stepInfo) {
      narration = (
        <>
          Allocation starts with every band switched off: the noise is the signal itself (the coloured bars).{' '}
          {mode === 'perceptual'
            ? 'The encoder will repeatedly refine whichever band has the worst noise-to-mask ratio.'
            : 'The uniform allocator will refine whichever band has the worst noise-to-signal ratio — it never looks at the mask.'}{' '}
          Budget: {int(budget)} bits for this frame ({rate} kbps).
        </>
      )
    } else {
      const st = stepInfo
      narration = (
        <>
          {mode === 'perceptual' ? (
            <>
              Worst noise-to-mask ratio: band {st.band} ({band(st.band)}) at <b>{sdb(st.nmrBefore)}</b>
              {st.nmrBefore > 0 ? ' — audible' : ''}.
            </>
          ) : (
            <>
              Worst noise-to-signal ratio: band {st.band} ({band(st.band)}). Its noise-to-mask ratio, which this allocator ignores, was{' '}
              {sdb(st.nmrBefore)}.
            </>
          )}{' '}
          Halving its step costs {st.bitsAfter - st.bitsBefore} bits and moves its noise to {sdb(st.nmrAfter)} of the mask. Frame:{' '}
          {int(st.total)} / {int(budget)} bits.
        </>
      )
    }
  } else if (stage === 'quant') {
    narration = (
      <>
        {trace.transparent
          ? `Done early: every band is more than ${-TRANSPARENT_NMR} dB under its mask, so the encoder stops and leaves ${int(budget - trace.bits)} bits of the budget unspent.`
          : `Done: nothing affordable is left in the ${int(budget)}-bit budget.`}{' '}
        The blue lines are the quantised coefficients; {zeroBands} of {R.bands.length} bands are sent as nothing but their 4-bit “off” code.
        Worst noise-to-mask ratio: {sdb(worstNow)}.
      </>
    )
  } else {
    narration = (
      <>
        The decoder dequantises, runs the inverse MDCT, windows and overlap-adds with the neighbouring frames. This frame’s signal-to-noise
        ratio is only {fmt(seg.snr, 1)} dB — the red trace, amplified ×8, is the error — yet the noise was placed{' '}
        {!(worstNow > 0) ? 'under the mask in every band' : `under the mask except where the budget ran out (worst ${sdb(worstNow)})`}. SNR is
        the wrong yardstick for ears.
      </>
    )
  }

  const stageIdx = (st: Stage) => (st === 'alloc' ? 6 : st === 'quant' ? 7 + S : st === 'ola' ? 8 + S : ORDER.indexOf(st))

  return (
    <Page
      slug="perceptual"
      lede={
        <p>
          Every lossless coder on this site has to give back every bit. MP3 and AAC only have to give back what you can <b>hear</b> — and a loud
          sound makes the frequencies around it partly deaf for a while. So the encoder cuts sound into frequency bands, works out how much noise
          each band could hide, and rounds each band only as coarsely as it can get away with. The rounding error is large; it is just in places
          your ear is not listening. Below is a small but complete codec of that kind — press play and listen to what it threw away.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Signal">
              <div className="chips">
                {SIGNALS.map((s) => (
                  <button key={s.id} type="button" className={'chip' + (!wav && s.id === sigId ? ' on' : '')} title={s.note} onClick={() => pickSignal(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="small muted">
                {wav
                  ? `${wav.label}: ${fmt(x.length / fs, 1)} s at ${int(fs)} Hz, mixed to mono.`
                  : `${SIGNALS.find((s) => s.id === sigId)!.note} — ${fmt(x.length / fs, 1)} s at 32 kHz.`}
              </p>
              <label className="btn btn-ghost" style={{ textAlign: 'center' }}>
                Load a WAV…
                <input type="file" accept=".wav,audio/wav,audio/x-wav" style={{ display: 'none' }} onChange={(e) => loadWav(e.target.files?.[0])} />
              </label>
              {wavError && (
                <p className="small" style={{ color: 'var(--bad)' }}>
                  {wavError}
                </p>
              )}
              <div className="pa-play">
                <Button onClick={() => play(x, fs)}>▶ original</Button>
                <Button onClick={() => play(R.decoded, fs)} kind="primary">
                  ▶ decoded
                </Button>
                <Button onClick={() => play(Float64Array.from(R.decoded, (v, k) => v - x[k]), fs, true)} title="Decoded minus original, turned up so you can hear it">
                  ▶ noise only
                </Button>
                <Button onClick={stop} kind="ghost">
                  ■
                </Button>
              </div>
              <p className="small muted">“Noise only” is normalised to be audible; at its real level it sits {fmt(R.snr, 0)} dB below the signal.</p>
            </Group>
            <Group title="Encoder">
              <Slider label="bitrate" value={kbps} min={8} max={192} step={8} unit="kbps" onChange={setKbps} help="The budget per frame is this × 1024 / sample rate. Each frame spends at most that; the perceptual allocator stops early once everything is well under the mask." />
              <Segmented
                label="allocator"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'perceptual', label: 'Perceptual' },
                  { value: 'uniform', label: 'Uniform' },
                ]}
                help="Perceptual: refine the band whose noise is most audible (worst noise-to-mask ratio). Uniform: refine the band with the worst signal-to-noise ratio, ignoring the ear — the same SNR everywhere."
              />
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="bitrate" value={fmt(R.bitrate / 1000, 1)} sub="kbps used" tone="accent" />
                <Stat label="vs 16-bit PCM" value={fmt((100 * R.bits) / pcmBits, 1) + '%'} sub={`${fmt(pcmBits / Math.max(1, R.bits), 1)} : 1`} />
                <Stat label="SNR" value={fmt(R.snr, 1)} sub="dB" help="Signal-to-noise ratio over the whole signal. A perceptual coder can have a poor SNR and still sound clean." />
                <Stat
                  label="audible bands"
                  value={fmt(100 * R.audible, 0) + '%'}
                  sub={`mean NMR ${fmt(R.meanNmr, 1)} dB`}
                  tone={R.audible > 0.05 ? 'bad' : 'good'}
                  help="Share of (frame, band) pairs whose quantisation noise is above the masking threshold, among bands audible to begin with. NMR = noise-to-mask ratio: below 0 dB the noise is masked."
                />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel
          title="Spectrogram"
          aside={
            <Segmented
              value={specView}
              onChange={setSpecView}
              options={[
                { value: 'original', label: 'original' },
                { value: 'decoded', label: 'decoded' },
                { value: 'noise', label: 'noise' },
              ]}
            />
          }
        >
          <Spectrogram frames={specFrames} fs={fs} cal={R.cal} frame={f} onPick={setFrameSel} marks={marks} label={`Spectrogram of the ${specView} signal; click to pick a frame`} />
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            Time → right, frequency ↑ on the Bark scale (the ear’s own), colour = dB. Click to pick a frame. The red strip underneath marks frames
            where some band’s noise is above its mask. Frame {f} of {F}.
          </p>
        </Panel>

        <Panel title={`Frame ${f}: what the ear will and will not hear`} aside={`${int(bitsTotal)} / ${int(budget)} bits`}>
          <div className="pa-stages">
            {ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className={'pa-stage' + (s === stage ? ' on' : ORDER.indexOf(s) < ORDER.indexOf(stage) ? ' done' : '')}
                onClick={() => stepper.setIndex(stageIdx(s))}
              >
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
          {stage === 'frame' || stage === 'ola' ? (
            <>
              <Scope
                label="This frame's samples"
                height={130}
                series={
                  stage === 'frame'
                    ? [{ data: Float64Array.from(seg.orig, (v, k) => v * Math.sin((Math.PI * (k + 0.5)) / (2 * N))), cls: 'pa-sig' }]
                    : [
                        { data: seg.orig, cls: 'pa-sig' },
                        { data: seg.err, cls: 'pa-err', scale: 8 },
                      ]
                }
              />
              <ChartLegend
                items={
                  stage === 'frame'
                    ? [{ cls: 'pa-sig', label: `${2 * N} samples × sine window` }]
                    : [
                        { cls: 'pa-sig', label: 'original' },
                        { cls: 'pa-err', label: 'decoded − original, ×8' },
                      ]
                }
              />
            </>
          ) : (
            <>
              <FrameChart X={X} bands={R.bands} mask={mask} fs={fs} cal={R.cal} layers={layers} />
              <ChartLegend
                items={[
                  { cls: 'pa-spectrum', label: 'spectrum' },
                  ...(layers.bands ? [{ cls: 'pa-level', label: 'band level' }] : []),
                  ...(layers.ath ? [{ cls: 'pa-ath', label: 'threshold in quiet' }] : []),
                  ...(layers.masker !== undefined ? [{ cls: 'pa-masker', label: 'one masker, spread' }] : []),
                  ...(layers.spread ? [{ cls: 'pa-spread', label: 'all masking' }] : []),
                  ...(layers.threshold ? [{ cls: 'pa-threshold', label: 'mask' }] : []),
                  ...(layers.noise ? [{ cls: 'pa-noise', label: 'noise, masked' }, { cls: 'pa-noise over', label: 'noise, audible' }] : []),
                  ...(layers.quantised ? [{ cls: 'pa-quant', label: 'quantised' }] : []),
                ]}
              />
            </>
          )}
          <div className="pa-budget" title="Bits spent in this frame">
            <i style={{ width: `${Math.min(100, (100 * bitsTotal) / Math.max(1, budget))}%` }} />
          </div>
        </Panel>

        <Narration tone={stage === 'ola' ? 'done' : stage === 'alloc' && stepInfo && stepInfo.nmrBefore > 0 ? 'warn' : undefined}>{narration}</Narration>
        <Transport
          s={stepper}
          label={(k) => (k <= 5 ? STAGE_LABEL[ORDER[k]] : k <= 6 + S ? `allocation ${k - 6} / ${S}` : k === 7 + S ? 'quantised' : 'decoded')}
        />

        <Panel
          title="Per band"
          aside={ORDER.indexOf(stage) >= 6 ? 'noise-to-mask ratio above, bits below' : stage === 'threshold' ? 'signal-to-mask ratio' : ''}
        >
          {ORDER.indexOf(stage) < 5 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Step on to <i>mask</i> to see how far each band stands above what it can hide, and to <i>allocate bits</i> to watch the noise go
              under.
            </p>
          ) : stage === 'threshold' ? (
            <>
              <BandBars
                topLabel="SMR"
                nmr={mask.level.map((l, b) => l - mask.threshold[b])}
                bits={mask.level.map(() => 0)}
                bands={R.bands}
                active={audibleNow}
              />
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Signal-to-mask ratio: how far each band rises above its own mask. A band below zero is entirely hidden — it can be sent as nothing at
                all. The higher a bar, the more bits that band will need before its noise is inaudible.
              </p>
            </>
          ) : (
            <>
              <BandBars nmr={nmrNow} bits={bitsNow} bands={R.bands} highlight={layers.highlight} active={audibleNow} />
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Red bars: noise above the mask (audible). Green: hidden. Bands below the threshold in quiet to begin with have no bar — nothing there
                is audible however it is coded.
              </p>
            </>
          )}
        </Panel>

        <Panel title="Same bits, two strategies" aside={`${rate} kbps budget`}>
          <div className="table-wrap">
            <table className="data pa-compare">
              <thead>
                <tr>
                  <th>allocator</th>
                  <th className="num">kbps used</th>
                  <th className="num">
                    SNR <Help text="Signal-to-noise ratio — what a meter measures." />
                  </th>
                  <th className="num">
                    worst NMR <Help text="Mean over frames of the worst band's noise-to-mask ratio. Above 0 dB something is audible." />
                  </th>
                  <th className="num">audible bands</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: 'Perceptual', r: P },
                  { name: 'Uniform', r: U },
                ].map(({ name, r }) => {
                  const o = r === P ? U : P
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="num">{fmt(r.bitrate / 1000, 1)}</td>
                      <td className={'num' + (r.snr > o.snr + 0.05 ? ' better' : '')}>{fmt(r.snr, 1)} dB</td>
                      <td className={'num' + (meanWorst(r) < meanWorst(o) - 0.05 ? ' better' : '')}>{sdb(meanWorst(r))}</td>
                      <td className={'num' + (r.audible < o.audible - 0.001 ? ' better' : '')}>{fmt(100 * r.audible, 1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            The uniform allocator spreads noise evenly across the spectrum, so it often wins on SNR — and loses where it counts, leaving noise
            audible in quiet bands next to loud ones. Switch the allocator and press ▶ decoded at a low bitrate to hear the difference.
          </p>
        </Panel>

        <Panel title="How big is it" aside="whole signal">
          <SizeBars
            rows={[
              { label: '16-bit PCM', value: pcmBits, tone: 'faint' },
              ...(flacBits !== null ? [{ label: 'lossless (FLAC-style)', value: flacBits, tone: 'ink', note: 'this site’s FLAC exhibit' }] : []),
              { label: 'perceptual', value: P.bits, note: `${fmt(P.bitrate / 1000, 0)} kbps` },
              { label: 'uniform', value: U.bits, tone: 'faint', note: `${fmt(U.bitrate / 1000, 0)} kbps` },
            ]}
          />
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Real bit counts: per band a 4-bit step index, an 8-bit scale and a 4-bit Rice parameter when it is on, then the quantised values
            Rice-coded. No Huffman tables, bit reservoir or stereo tricks — a real MP3 at the same rate sounds better than this.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The pipeline</h2>
        <Code>{`for each frame of N = 1024 new samples (2048 with overlap):
    X     ← MDCT(window · samples)              # 1024 coefficients
    level ← energy per band (≈ ½ Bark each)
    mask  ← max( threshold in quiet,
                 Σ over bands: energy + spread(Δz) − offset(tonality) )
    while bits < budget:
        b ← band with the worst noise-to-mask ratio
        halve b's quantiser step                 # −6 dB of noise, +~1 bit per coefficient
    send: per band step, scale, Rice-coded round(X / step)
decoder: X' = q · step,  IMDCT,  window,  overlap-add`}</Code>
        <p>
          The step size is the only lossy decision. Everything after it is ordinary lossless coding — MP3 uses Huffman tables there, AAC too,
          and this page uses Rice codes from the <a href="#/intcodes">integer codes</a> exhibit.
        </p>

        <h2>The MDCT</h2>
        <p>
          A block transform without blocking artefacts: each frame overlaps its neighbours by half, takes 2N samples and returns only N
          coefficients. That cannot be invertible on its own — and it is not: the inverse gives back the frame with its halves folded over each
          other (<i>time-domain aliasing</i>). With a window satisfying w[n]² + w[n+N]² = 1, the folded parts of neighbouring frames are equal and
          opposite, and cancel when they are added. Princen, Johnson and Bradley called it TDAC (1987). The test suite checks the round trip to
          1e-9 and checks the fast version (a DCT-IV computed with an N/2-point FFT) against the textbook double sum.
        </p>

        <h2>Masking</h2>
        <p>
          The cochlea is a bank of overlapping filters, roughly one <b>critical band</b> (one Bark) wide — about 100 Hz at the bottom and a few
          kHz at the top. A loud component excites its neighbours’ filters too, so a quieter sound nearby is swamped: <b>simultaneous masking</b>.
          The effect reaches further upwards than downwards (a bass note hides treble hiss better than the reverse), which is what Schroeder’s
          asymmetric spreading function encodes. Noise-like maskers hide more than pure tones (Johnston’s offsets: about 5.5 dB below a noise
          masker, 14.5 + z dB below a tone). There is also <b>temporal masking</b>: a loud click hides what comes up to ~200 ms after it, and
          — strangely — a few milliseconds before it.
        </p>
        <p>
          Try the <i>Masking demo</i>: the 1.1 kHz beeps are 40 dB below the 1 kHz tone and only 0.6 Bark away, so the model marks them
          inaudible and the encoder sends nothing for them. The 6 kHz beeps are just as quiet, but nothing loud is near them — those it keeps.
          Listen to the original: you can hear the high beeps, and not the low ones.
        </p>

        <h2>Pre-echo</h2>
        <p>
          A 2048-sample frame is 64 ms. The quantisation noise spreads over the whole frame, so on a sharp attack — try <i>Drums</i> at a low
          bitrate and look at the noise trace — it appears <i>before</i> the hit, where nothing masks it. Real codecs switch to short blocks around
          transients (MP3: three blocks of 192; AAC: eight of 128), shape the noise in time (AAC’s TNS), or borrow bits from a reservoir so the
          hard frame gets more than its share. This page does none of that, and you can hear it.
        </p>

        <h2>History</h2>
        <ul>
          <li>
            <b>MP3</b> — MPEG-1 Audio Layer III (1993), from Karlheinz Brandenburg and colleagues at Fraunhofer IIS. A polyphase filterbank of 32
            bands followed by an MDCT in each (a hybrid, for compatibility with Layers I/II), Huffman coding, a bit reservoir, and joint stereo.
            Brandenburg tuned it on Suzanne Vega’s <i>Tom’s Diner</i>, an unaccompanied voice that exposed every artefact.
          </li>
          <li>
            <b>AAC</b> (1997) dropped the hybrid for a pure MDCT, added temporal noise shaping and better stereo coding, and is what most streaming
            and every iPhone used. HE-AAC adds <b>spectral band replication</b>: send the lower half of the spectrum and a few parameters to
            regenerate the top from it.
          </li>
          <li>
            <b>Vorbis</b> (2000) was the patent-free answer; <b>Opus</b> (2012, RFC 6716) merges Skype’s SILK speech codec with the CELT MDCT codec
            and is in every browser and WebRTC call.
          </li>
        </ul>

        <h2>Lossy is a one-way door</h2>
        <p>
          What a perceptual coder discards depends on a model of a listener, at a particular volume, on a particular pass. Re-encode a decoded MP3
          and the second model sees different masking, and discards more; EQ or pitch-shift it and noise that was hidden comes out from behind
          its masker. That is why archives and studios keep <a href="#/flac">lossless</a> masters and make the MP3 last.
        </p>
        <div className="aside">
          Simplified on purpose: one window shape and size, a band-level psychoacoustic model (real ones work per spectral line and use
          unpredictability measures to estimate tonality), no Huffman tables, no stereo, no bit reservoir. The structure — transform, mask,
          allocate, quantise, entropy-code — is the real one.
        </div>
      </Notes>
    </Page>
  )
}
