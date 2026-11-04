import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme, type Theme } from '../../lib/theme'
import { fmt, int } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import { deflateCodec } from '../deflate/codec'
import {
  FIXED_COEFS,
  MAX_LPC,
  RATE,
  SIGNALS,
  analyseBlock,
  encodeStream,
  fold,
  lpcPredict,
  fixedPredict,
  parseWav,
  pcmBytes,
  synth,
  type BlockAnalysis,
  type Candidate,
  type EncodeOptions,
  type SignalId,
} from './flac'
import './flac.css'

type Mode = 'auto' | 'fixed' | 'lpc'
type Source = { id: SignalId | 'wav'; label: string; samples: Int32Array; rate: number }

const KIND_CLASS: Record<string, string> = { constant: 'hl-3', verbatim: 'hl-2', fixed: 'hl-1', lpc: 'hl-4' }

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
    for (let i = 0; i < x.length; i++) ch[i] = x[i] * scale
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    src.connect(audioCtx.destination)
    src.start()
    playing = src
  } catch {
    /* no audio available — the page still works */
  }
}

// --------------------------------------------------------------- the scope

interface Series {
  data: ArrayLike<number>
  /** Sample index of data[0]. */
  offset: number
  color: string
  width?: number
}

function Scope({
  series,
  from,
  to,
  amp,
  height = 120,
  shade,
  grid,
  onPick,
  theme,
  label,
}: {
  series: Series[]
  from: number
  to: number
  amp: number
  height?: number
  shade?: [number, number]
  grid?: number[]
  onPick?: (sample: number) => void
  theme: Theme
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(w * dpr)
    c.height = Math.round(height * dpr)
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = theme.paper
    g.fillRect(0, 0, w, height)
    const span = Math.max(1, to - from)
    const X = (i: number) => ((i - from) / span) * w
    const Y = (v: number) => height / 2 - (v / amp) * (height / 2 - 4)
    if (shade) {
      g.fillStyle = theme.accent
      g.globalAlpha = 0.35
      g.fillRect(X(shade[0]), 0, X(shade[1]) - X(shade[0]), height)
      g.globalAlpha = 1
    }
    g.strokeStyle = theme.line
    g.lineWidth = 1
    for (const gx of grid ?? []) {
      g.beginPath()
      g.moveTo(Math.round(X(gx)) + 0.5, 0)
      g.lineTo(Math.round(X(gx)) + 0.5, height)
      g.stroke()
    }
    g.strokeStyle = theme.lineStrong
    g.beginPath()
    g.moveTo(0, Math.round(height / 2) + 0.5)
    g.lineTo(w, Math.round(height / 2) + 0.5)
    g.stroke()
    for (const s of series) {
      g.strokeStyle = s.color
      g.fillStyle = s.color
      g.lineWidth = s.width ?? 1.2
      const perPx = span / w
      if (perPx > 1.5) {
        // min/max per pixel column
        for (let px = 0; px < w; px++) {
          const a = Math.max(from, Math.floor(from + px * perPx)) - s.offset
          const b = Math.min(to, Math.floor(from + (px + 1) * perPx)) - s.offset
          let lo = Infinity
          let hi = -Infinity
          for (let i = Math.max(0, a); i < Math.min(s.data.length, b); i++) {
            const v = s.data[i]
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
          if (lo === Infinity) continue
          const y1 = Y(hi)
          const y2 = Y(lo)
          g.fillRect(px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)))
        }
      } else {
        g.beginPath()
        let started = false
        for (let i = Math.max(from, s.offset); i < Math.min(to, s.offset + s.data.length); i++) {
          const x = X(i + 0.5)
          const y = Y(s.data[i - s.offset])
          if (!started) g.moveTo(x, y)
          else g.lineTo(x, y)
          started = true
        }
        g.stroke()
      }
    }
  }, [series, from, to, amp, height, shade, grid, theme, w])
  return (
    <canvas
      ref={ref}
      className={'fl-scope' + (onPick ? ' pickable' : '')}
      style={{ height }}
      aria-label={label}
      role="img"
      onClick={
        onPick
          ? (e) => {
              const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
              onPick(Math.floor(from + ((e.clientX - r.left) / r.width) * (to - from)))
            }
          : undefined
      }
    />
  )
}

// ------------------------------------------------------------------ the page

export function Flac() {
  // Read the theme from inside the page so canvases pick up this exhibit's --accent.
  const themeRef = useRef<HTMLSpanElement>(null)
  const theme = useTheme(themeRef)
  const [sigId, setSigId] = useState<SignalId>('chord')
  const [wav, setWav] = useState<Source | null>(null)
  const [wavError, setWavError] = useState<string | null>(null)
  const [blockSize, setBlockSize] = useState(4096)
  const [mode, setMode] = useState<Mode>('auto')
  const [fixedOrder, setFixedOrder] = useState(2)
  const [lpcOrder, setLpcOrder] = useState(8)
  const [precision, setPrecision] = useState(12)
  const [maxPo, setMaxPo] = useState(6)
  const [blockIdx, setBlockIdx] = useState(1)
  const [inspect, setInspect] = useState<string | null>(null)

  const synthCache = useMemo(() => new Map<SignalId, Int32Array>(), [])
  const src: Source = useMemo(() => {
    if (wav) return wav
    let x = synthCache.get(sigId)
    if (!x) synthCache.set(sigId, (x = synth(sigId)))
    return { id: sigId, label: SIGNALS.find((s) => s.id === sigId)!.label, samples: x, rate: RATE }
  }, [sigId, wav, synthCache])
  const x = src.samples

  const opts: EncodeOptions = useMemo(
    () => ({ bps: 16, blockSize, mode, order: mode === 'fixed' ? fixedOrder : mode === 'lpc' ? lpcOrder : undefined, maxLpc: MAX_LPC, maxPo, precision }),
    [blockSize, mode, fixedOrder, lpcOrder, maxPo, precision],
  )
  const enc = useMemo(() => {
    const e = encodeStream(x, opts)
    // Keep only the bit counts of the losing candidates; the selected block is re-analysed below.
    for (const b of e.blocks) for (const c of b.candidates) if (c !== b.best) c.residual = c.plan = undefined
    return e
  }, [x, opts])
  const fixedOnly = useMemo(() => encodeStream(x, { ...opts, mode: 'auto', maxLpc: 0 }).bits, [x, opts])

  const [gz, setGz] = useState<number | null>(null)
  useEffect(() => {
    setGz(null)
    const t = setTimeout(() => setGz(deflateCodec.encode(pcmBytes(x)).length * 8), 30)
    return () => clearTimeout(t)
  }, [x])

  const nBlocks = enc.blocks.length
  const bi = Math.min(blockIdx, nBlocks - 1)
  const blk = enc.blocks[Math.max(0, bi)] as BlockAnalysis | undefined
  const detail = useMemo(() => (blk ? analyseBlock(x, blk.start, blk.end, 16, opts) : null), [x, blk, opts])
  const chosen = detail?.best
  const inspected = (detail && inspect && detail.candidates.find((c) => c.label === inspect)) || chosen

  let amp = 1
  for (let i = 0; i < x.length; i++) amp = Math.max(amp, Math.abs(x[i]))
  const bps = x.length ? enc.bits / x.length : 0

  const loadWav = async (f: File | undefined) => {
    if (!f) return
    try {
      const { samples, rate } = parseWav(await f.arrayBuffer(), 10 * 48000)
      setWav({ id: 'wav', label: f.name, samples, rate })
      setWavError(null)
      setBlockIdx(1)
    } catch (e) {
      setWavError(e instanceof Error ? e.message : String(e))
    }
  }

  const residualAll = () => {
    const r = new Int32Array(x.length)
    for (const b of enc.blocks) {
      const c = b.best
      if (!c.residual) continue
      const order = 'order' in c.sub ? c.sub.order : 0
      r.set(c.residual, b.start + order)
    }
    return r
  }

  return (
    <Page
      slug="flac"
      lede={
        <p>
          Sound is a smooth curve sampled thousands of times a second, so each sample is very nearly what the last few said it would be. A lossless
          audio coder fits a predictor through the recent past, subtracts its guess, and keeps only the <b>residual</b> — small numbers it writes
          with Rice codes. gzip, which looks for repeated bytes, finds almost none in real audio; prediction routinely halves it. This is FLAC’s
          design, and every number below comes from a real stream that decodes back bit for bit.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Signal">
              <div className="chips">
                {SIGNALS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={'chip' + (!wav && s.id === sigId ? ' on' : '')}
                    title={s.note}
                    onClick={() => {
                      setWav(null)
                      setSigId(s.id)
                      setInspect(null)
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="small muted">{wav ? `${wav.label}: ${int(x.length)} samples at ${int(wav.rate)} Hz, mixed to mono.` : SIGNALS.find((s) => s.id === sigId)!.note + ` — ${int(x.length)} samples, 16 kHz, 16-bit.`}</p>
              <label className="btn btn-ghost" style={{ textAlign: 'center' }}>
                Load a WAV…
                <input type="file" accept=".wav,audio/wav,audio/x-wav" style={{ display: 'none' }} onChange={(e) => loadWav(e.target.files?.[0])} />
              </label>
              {wavError && <p className="small" style={{ color: 'var(--bad)' }}>{wavError}</p>}
              <div className="btn-row">
                <Button onClick={() => play(x, src.rate)}>▶ original</Button>
                <Button onClick={() => play(residualAll(), src.rate, true)} title="The residual of the whole signal, normalised so you can hear it">
                  ▶ what is left
                </Button>
              </div>
            </Group>
            <Group title="Encoder">
              <Segmented
                label="block size"
                value={blockSize}
                onChange={(v) => {
                  setBlockSize(v)
                  setInspect(null)
                }}
                options={[1024, 2048, 4096, 8192].map((v) => ({ value: v, label: String(v) }))}
                help="Each block gets its own predictor and its own Rice parameters. Small blocks adapt faster but pay their header more often; FLAC defaults to 4096."
              />
              <Segmented
                label="predictor"
                value={mode}
                onChange={(v) => {
                  setMode(v)
                  setInspect(null)
                }}
                options={[
                  { value: 'auto', label: 'best' },
                  { value: 'fixed', label: 'fixed' },
                  { value: 'lpc', label: 'LPC' },
                ]}
                help="‘best’ tries constant, verbatim, every fixed order and every LPC order on every block and keeps the cheapest — what flac -8 does. The others force one predictor everywhere."
              />
              {mode === 'fixed' && <Slider label="fixed order" value={fixedOrder} min={0} max={4} onChange={setFixedOrder} help="Order n extrapolates a degree n−1 polynomial through the last n samples: 1 repeats the last sample, 2 continues the straight line, 3 the parabola." />}
              {mode === 'lpc' && <Slider label="LPC order" value={lpcOrder} min={1} max={MAX_LPC} onChange={setLpcOrder} help="How many past samples the linear predictor weighs. More catches more resonances, but every coefficient has to be sent." />}
              {mode !== 'fixed' && (
                <Slider label="coefficient precision" value={precision} min={5} max={15} unit="bits" onChange={setPrecision} help="LPC coefficients are rounded to integers of this many bits so the decoder can repeat the prediction exactly. Fewer bits: cheaper header, worse prediction." />
              )}
              <Slider label="max partition order" value={maxPo} min={0} max={8} onChange={setMaxPo} help="The residual may be split into up to 2^order partitions, each with its own Rice parameter. Each one costs 4 bits; the encoder picks the order that pays." />
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="bits / sample" value={fmt(bps, 2)} tone="accent" sub="of 16" />
                <Stat label="size" value={fmt((100 * bps) / 16, 1) + '%'} help="Compressed stream ÷ 16-bit PCM." />
                <Stat label="gzip on PCM" value={gz === null ? '…' : fmt((100 * gz) / (x.length * 16), 1) + '%'} help="This site’s DEFLATE on the raw little-endian PCM bytes — a general-purpose compressor looking for repeated byte strings." />
                <Stat label="blocks" value={nBlocks} />
              </Stats>
            </Group>
          </>
        }
      >
        <span ref={themeRef} hidden />
        <Panel title={`${src.label} — the whole signal`} aside="click to pick a block">
          <Scope
            theme={theme}
            series={[{ data: x, offset: 0, color: theme.ink }]}
            from={0}
            to={x.length}
            amp={amp}
            height={110}
            shade={blk ? [blk.start, blk.end] : undefined}
            grid={enc.blocks.map((b) => b.start).slice(1)}
            onPick={(i) => {
              setBlockIdx(Math.floor(i / blockSize))
              setInspect(null)
            }}
            label="waveform of the whole signal"
          />
          <div className="fl-strip" aria-label="predictor chosen per block">
            {enc.blocks.map((b, i) => (
              <button
                key={i}
                type="button"
                className={'fl-strip-cell ' + KIND_CLASS[b.best.sub.kind] + (i === bi ? ' on' : '')}
                style={{ flexGrow: b.end - b.start }}
                title={`block ${i}: ${b.best.label}, ${fmt(b.best.bits / (b.end - b.start), 2)} bits/sample`}
                onClick={() => {
                  setBlockIdx(i)
                  setInspect(null)
                }}
              >
                {nBlocks <= 24 ? b.best.label.replace('fixed ', 'F').replace('LPC ', 'L').replace('verbatim', 'V').replace('constant', 'C') : ''}
              </button>
            ))}
          </div>
          <div className="legend" style={{ marginTop: 8 }}>
            <span>
              <i className="hl-1" />
              fixed (F)
            </span>
            <span>
              <i className="hl-4" />
              LPC (L)
            </span>
            <span>
              <i className="hl-2" />
              verbatim (V)
            </span>
            <span>
              <i className="hl-3" />
              constant (C)
            </span>
          </div>
        </Panel>

        {detail && inspected && blk && <BlockView x={x} blk={detail} chosen={chosen!} inspected={inspected} setInspect={setInspect} theme={theme} rate={src.rate} index={bi} />}

        <Panel title="How big is it" aside="whole signal">
          <SizeBars
            rows={[
              { label: '16-bit PCM', value: x.length * 16, tone: 'faint' },
              { label: 'gzip of the PCM', value: gz ?? 0, tone: 'faint', note: gz === null ? 'computing…' : 'byte strings rarely repeat' },
              { label: 'fixed predictors', value: fixedOnly, note: 'orders 0–4 only' },
              { label: mode === 'auto' ? 'best per block' : `forced ${mode} ${mode === 'fixed' ? fixedOrder : lpcOrder}`, value: enc.bits, tone: 'ink' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            {sigId === 'saw' && !wav
              ? 'The sawtooth is the trap: synthesised, so it repeats exactly every 1600 samples, and LZ77 finds those repeats. Real recordings never repeat to the bit — try the others, or load a WAV.'
              : 'Real FLAC adds frame headers, CRCs and stereo decorrelation; this stream has a 53-bit header and nothing else.'}
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>Why prediction works on sound</h2>
        <p>
          A microphone signal is band-limited: nothing above half the sample rate survives the anti-aliasing filter, and most of the energy sits
          far below that. A band-limited signal changes slowly from one sample to the next, so the last few samples pin down the next one
          closely. The residual — the part no predictor could see coming — has a much smaller spread, and the bits needed to write a number
          grow with the logarithm of its spread. Every 6 dB of prediction gain saves one bit per sample.
        </p>
        <h2>Fixed predictors</h2>
        <p>
          FLAC’s fixed predictors are polynomial extrapolation, which is the same as taking repeated differences:
        </p>
        <Code>{`order 0:  e = x[n]                                      (no prediction)
order 1:  e = x[n] − x[n−1]                            (first difference)
order 2:  e = x[n] − 2x[n−1] + x[n−2]                  (continue the line)
order 3:  e = x[n] − 3x[n−1] + 3x[n−2] − x[n−3]
order 4:  e = x[n] − 4x[n−1] + 6x[n−2] − 4x[n−3] + x[n−4]`}</Code>
        <p>
          No coefficients have to be sent, which makes them perfect for short blocks and for the encoder’s fast modes. Their weakness is that they
          only model smoothness, not resonance.
        </p>
        <h2>Linear prediction and Levinson–Durbin</h2>
        <p>
          LPC chooses the coefficients a₁ … aₚ that minimise the squared residual over the block. Setting the derivative to zero gives the
          normal equations Σⱼ aⱼ R(|i−j|) = R(i), where R is the block’s autocorrelation. The matrix is Toeplitz, so Levinson–Durbin solves it in
          O(p²) instead of O(p³), and produces every lower order on the way — which is why the encoder can try orders 1 to 12 for the price of
          one. The block is first multiplied by a Tukey window so the edges do not fake correlations.
        </p>
        <p>
          The decoder must make the identical prediction, so floating point is out: coefficients are rounded to <i>precision</i>-bit integers
          with a common right shift, the encoder computes the residual with exactly the integer arithmetic the decoder will use, and the
          coefficients travel in the block header. That is the trade the precision slider shows: more bits per coefficient cost header but
          predict better.
        </p>
        <h2>Rice codes, partitioned</h2>
        <p>
          The residual is roughly Laplacian, which a geometric distribution on |e| matches well — and the optimal prefix code for a geometric
          distribution is Golomb’s. FLAC uses <a href="#/intcodes">Rice codes</a> (Golomb with m = 2ᵏ) on the zigzag-folded residual, and lets
          the encoder split the block into 2ⁿ partitions with their own k, because a quiet stretch and a loud one want different parameters.
          Choosing k is easy: the cost is convex in k, so start at log₂(mean) and walk downhill.
        </p>
        <h2>History</h2>
        <p>
          Tony Robinson’s <b>Shorten</b> (1994) set the template: blocks, fixed polynomial predictors, Rice codes. Josh Coalson’s <b>FLAC</b>{' '}
          (2001) added LPC with quantised coefficients, partitioned Rice parameters, mid/side stereo and a streamable frame format, and became the
          standard for lossless music. Monkey’s Audio and OptimFROG push further with adaptive filters and get a few percent more at much slower
          speed; WavPack adds a hybrid lossy mode; Apple Lossless (ALAC) and MPEG-4 ALS are close relatives of the same design.
        </p>
        <div className="aside">
          Not modelled here: stereo. Left and right are strongly correlated, so FLAC tries coding left/right, mid/side, left/side and
          right/side and keeps the cheapest pair — often worth another 10–20%.
        </div>
      </Notes>
    </Page>
  )
}

// --------------------------------------------------------------- one block

function BlockView({
  x,
  blk,
  chosen,
  inspected,
  setInspect,
  theme,
  rate,
  index,
}: {
  x: Int32Array
  blk: BlockAnalysis
  chosen: Candidate
  inspected: Candidate
  setInspect: (s: string | null) => void
  theme: Theme
  rate: number
  index: number
}) {
  const len = blk.end - blk.start
  const order = 'order' in inspected.sub ? inspected.sub.order : 0
  const res = inspected.residual
  const [zoomRes, setZoomRes] = useState(false)

  let peakX = 1
  let ex = 0
  for (let i = blk.start; i < blk.end; i++) {
    peakX = Math.max(peakX, Math.abs(x[i]))
    ex += x[i] * x[i]
  }
  let peakR = 1
  let er = 0
  if (res)
    for (const v of res) {
      peakR = Math.max(peakR, Math.abs(v))
      er += v * v
    }
  const gainDb = res && er > 0 ? 10 * Math.log10(ex / er) : null
  const sorted = blk.candidates.slice().sort((a, b) => a.bits - b.bits)

  return (
    <>
      <Panel title={`Block ${index}: samples ${int(blk.start)}–${int(blk.end - 1)}`} aside={`${inspected.label}${inspected === chosen ? ' (the encoder’s pick)' : ''}`}>
        <div className="fl-pair">
          <div>
            <div className="fl-caption">signal</div>
            <Scope theme={theme} series={[{ data: x, offset: 0, color: theme.ink }]} from={blk.start} to={blk.end} amp={peakX} height={110} label="block signal" />
          </div>
          <div>
            <div className="fl-caption">
              residual {zoomRes ? `(zoomed ×${fmt(peakX / peakR, 0)})` : '(same scale)'}
              <button type="button" className="chip" onClick={() => setZoomRes(!zoomRes)} style={{ marginLeft: 8 }}>
                {zoomRes ? 'same scale' : 'zoom in'}
              </button>
            </div>
            {res ? (
              <Scope theme={theme} series={[{ data: res, offset: blk.start + order, color: theme.good }]} from={blk.start} to={blk.end} amp={zoomRes ? peakR : peakX} height={110} label="block residual" />
            ) : (
              <div className="fl-none">{inspected.sub.kind === 'constant' ? 'Every sample is the same: one value, no residual.' : 'Verbatim: no prediction, every sample stored as-is.'}</div>
            )}
          </div>
        </div>
        <Stats>
          <Stat label="bits / sample" value={fmt(inspected.bits / len, 2)} tone="accent" />
          <Stat label="peak |x|" value={int(peakX)} />
          <Stat label="peak |e|" value={res ? int(peakR) : '—'} />
          <Stat
            label="prediction gain"
            value={gainDb === null ? '—' : fmt(gainDb, 1) + ' dB'}
            tone={gainDb !== null && gainDb < 0 ? 'bad' : undefined}
            sub={gainDb !== null && gainDb < 0 ? 'louder than the signal — yet the quiet partitions still pay' : undefined}
            help="Signal energy ÷ residual energy. Every 6 dB is about one bit per sample saved. Negative means the predictor amplified the signal: differencing noise makes it louder."
          />
        </Stats>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <Button kind="ghost" onClick={() => play(x.subarray(blk.start, blk.end), rate)}>
            ▶ block
          </Button>
          {res && (
            <Button kind="ghost" onClick={() => play(res, rate, true)}>
              ▶ its residual
            </Button>
          )}
        </div>
      </Panel>

      <Panel title="Every predictor, tried on this block" aside="click one to inspect it">
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>subframe</th>
                <th className="num">header</th>
                <th className="num">residual</th>
                <th className="num">bits</th>
                <th className="num">bits/sample</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const head = c.plan ? c.bits - c.plan.bits : c.bits
                return (
                  <tr key={c.label} className={c === inspected ? 'on' : c === chosen ? 'new' : ''} onClick={() => setInspect(c.label)} style={{ cursor: 'pointer' }}>
                    <td>
                      <span className={'fl-kind ' + KIND_CLASS[c.sub.kind]}>{c.label}</span>
                      {c === chosen && <span className="muted small"> ← chosen</span>}
                    </td>
                    <td className="num">{int(head)}</td>
                    <td className="num">{c.plan ? int(c.plan.bits) : '—'}</td>
                    <td className="num">{int(c.bits)}</td>
                    <td className="num">{fmt(c.bits / len, 2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {res && inspected.plan && <Partitions cand={inspected} len={len} />}
      {res && <SampleStepper x={x} blk={blk} cand={inspected} />}
    </>
  )
}

function Partitions({ cand, len }: { cand: Candidate; len: number }) {
  const plan = cand.plan!
  const parts = plan.ks.length
  const maxBps = Math.max(...plan.partBits.map((b, j) => b / Math.max(1, plan.bounds[j + 1] - plan.bounds[j])))
  return (
    <Panel title={`Rice partitions: ${parts} × ${len / parts} samples`} aside={`partition order ${plan.po}`}>
      <div className="fl-parts">
        {plan.ks.map((k, j) => {
          const n = plan.bounds[j + 1] - plan.bounds[j]
          const b = plan.partBits[j] / Math.max(1, n)
          return (
            <div key={j} className="fl-part" title={`partition ${j}: ${n} residuals, k = ${k}, ${fmt(b, 2)} bits each`}>
              <div className="fl-part-bar" style={{ height: `${(100 * b) / maxBps}%` }} />
              <span>{parts <= 32 ? `k${k}` : ''}</span>
            </div>
          )
        })}
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              <th>partition order</th>
              {plan.byOrder.map((_, po) => (
                <th key={po} className="num">
                  {po}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>residual bits</td>
              {plan.byOrder.map((b, po) => (
                <td key={po} className="num" style={{ fontWeight: po === plan.po ? 700 : 400, background: po === plan.po ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : undefined }}>
                  {Number.isFinite(b) ? int(b) : '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Bar height: bits per residual in that partition. Loud stretches want a larger k; each extra partition costs 4 bits for its parameter, and
        the encoder stops splitting when that stops paying. “—” means the block cannot be split that finely.
      </p>
    </Panel>
  )
}

// ----------------------------------------------------- predicting one sample

const STEPS = 48

function SampleStepper({ x, blk, cand }: { x: Int32Array; blk: BlockAnalysis; cand: Candidate }) {
  const sub = cand.sub
  const order = 'order' in sub ? sub.order : 0
  const len = blk.end - blk.start
  const avail = Math.max(0, len - order)
  const [region, setRegion] = useState(0)
  const reg = Math.min(region, Math.max(0, avail - STEPS))
  const count = Math.min(STEPS, avail)
  const s = useStepper(count + 1, { speed: 3, resetKey: cand.label + ':' + blk.start + ':' + reg })
  const j = s.index
  const i = blk.start + order + reg + Math.max(0, j - 1)
  const plan = cand.plan!
  const resIdx = i - blk.start - order
  let part = 0
  while (part + 1 < plan.bounds.length - 1 && resIdx >= plan.bounds[part + 1]) part++
  const k = plan.ks[part]

  const pred = sub.kind === 'lpc' ? lpcPredict(x, i, sub.q, sub.shift) : fixedPredict(x, i, order)
  const e = x[i] - pred
  const u = fold(e)
  const q = Math.floor(u / 2 ** k)
  const low = k ? (u % 2 ** k).toString(2).padStart(k, '0') : ''

  // Mini plot: the 24 samples before i, i itself, the prediction.
  const W = 560
  const H = 150
  const from = Math.max(blk.start, i - 24)
  const pts: number[] = []
  for (let t = from; t <= i; t++) pts.push(x[t])
  const lo = Math.min(...pts, pred)
  const hi = Math.max(...pts, pred)
  const pad = Math.max(1, (hi - lo) * 0.15)
  const X = (t: number) => 16 + ((t - from) / Math.max(1, i - from + 1)) * (W - 40)
  const Y = (v: number) => 10 + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (H - 20)

  let formula = ''
  if (sub.kind === 'fixed') {
    const c = FIXED_COEFS[order]
    formula =
      order === 0
        ? 'x̂ = 0'
        : 'x̂ = ' +
          c.map((cv, t) => `${t === 0 ? (cv < 0 ? '−' : '') : cv < 0 ? ' − ' : ' + '}${Math.abs(cv) === 1 ? '' : Math.abs(cv) + '·'}(${int(x[i - 1 - t])})`).join('') +
          ` = ${int(pred)}`
  } else if (sub.kind === 'lpc') {
    let sum = 0
    for (let t = 0; t < sub.q.length; t++) sum += sub.q[t] * x[i - 1 - t]
    formula = `x̂ = ⌊(${sub.q.length} terms: Σ qⱼ·x[n−j] = ${int(sum)}) / 2^${sub.shift}⌋ = ${int(pred)}`
  }

  return (
    <>
      <Panel title="Predict one sample at a time" aside={`${cand.label}, partition ${part} (k = ${k})`}>
        {avail > STEPS && (
          <Slider label="start at sample" value={reg} min={0} max={avail - STEPS} step={1} onChange={setRegion} display={`${int(blk.start + order + reg)}`} />
        )}
        <div className="scroll-x">
          <svg viewBox={`0 0 ${W} ${H}`} className="fl-mini" role="img" aria-label="recent samples, the prediction and the actual sample">
            <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke="var(--line)" />
            <polyline points={pts.map((v, t) => `${X(from + t)},${Y(v)}`).join(' ')} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} />
            {pts.map((v, t) => {
              const at = from + t
              const used = at < i && at >= i - order
              return <circle key={t} cx={X(at)} cy={Y(v)} r={at === i ? 5 : used ? 4 : 2.6} fill={at === i ? 'var(--ink)' : used ? 'var(--accent)' : 'var(--muted)'} stroke={used ? 'var(--ink)' : 'none'} />
            })}
            {j > 0 && (
              <>
                <circle cx={X(i)} cy={Y(pred)} r={6} fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeDasharray="3 2" />
                <line x1={X(i) + 10} x2={X(i) + 10} y1={Y(pred)} y2={Y(x[i])} stroke="var(--good)" strokeWidth={3} />
                <text x={X(i) + 15} y={(Y(pred) + Y(x[i])) / 2 + 4} fontSize={11} fill="var(--good)">
                  e = {e}
                </text>
              </>
            )}
          </svg>
        </div>
        {j > 0 && (
          <div className="fl-steps mono">
            <div>
              <span className="muted">predict</span> {formula}
            </div>
            <div>
              <span className="muted">actual</span> x[{int(i)}] = {int(x[i])} &nbsp; <span className="muted">residual</span> e = {int(x[i])} − {int(pred)} = <b>{e}</b>
            </div>
            <div>
              <span className="muted">fold</span> u = {e >= 0 ? `2·${e}` : `−2·(${e}) − 1`} = {u} &nbsp; <span className="muted">Rice k = {k}</span> → {u} = {q}·2^{k} + {k ? parseInt(low, 2) : 0}
            </div>
            <div className="fl-cw">
              {q > 40 ? <span className="hl-6">{q} zeros…</span> : q > 0 && <span className="hl-6">{'0'.repeat(q)}</span>}
              <span className="hl-1">1</span>
              {low && <span className="hl-3">{low}</span>}
              <span className="muted"> &nbsp;{q + 1 + k} bits, instead of 16</span>
            </div>
          </div>
        )}
      </Panel>
      <Transport s={s} label={(t) => (t === 0 ? `0 / ${count}` : `sample ${int(blk.start + order + reg + t - 1)}`)} />
      <Narration>
        {j === 0 ? (
          <>
            The decoder already has the {order === 0 ? 'block header' : `${order} warm-up sample${order === 1 ? '' : 's'}, stored verbatim,`} and the
            predictor’s {sub.kind === 'lpc' ? `${order} quantised coefficients` : 'order'}. From here on it gets only residuals. Step through to watch
            each sample be predicted from the ones before it (the highlighted dots).
          </>
        ) : (
          <>
            Predicted <b>{int(pred)}</b>, actual {int(x[i])}: the residual is <b>{e}</b>. Folded to {u} and Rice-coded with k = {k}: {q} zero{q === 1 ? '' : 's'}{' '}
            for {u} ≫ {k} = {q}, a 1 to end the count{k ? `, then the low ${k} bits` : ''} — {q + 1 + k} bits for a sample that was 16.
            {Math.abs(e) > 2 ** 10 && ' A big miss: an edge or a transient the predictor could not see coming.'}
          </>
        )}
      </Narration>
    </>
  )
}
