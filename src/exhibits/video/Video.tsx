import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fmt } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import { H, W, makeSequence, type SequenceId } from './frames'
import { codePFrame, DEFAULTS, encodeSequence, interTable, predictBlockFor, type EncodeOptions, type FrameResult, type Macroblock } from './encoder'
import { fmtHalf, search, type Frame, type Method, type SearchResult } from './motion'
import { BlockCanvas, CoefGrid, FrameCanvas, SearchWindow, fmtBits, fmtMV, vectorOverlay } from './views'
import './video.css'

type Mode = 'mb' | 'frames'

const SEQ_LABEL: Record<SequenceId, string> = { scene: 'Scene + cut', pan: 'Pure pan', zoom: 'Zoom' }
const METHOD_LABEL: Record<Method, string> = { full: 'Full', tss: 'Three-step', diamond: 'Diamond' }
const METHOD_LONG: Record<Method, string> = { full: 'full search', tss: 'three-step search', diamond: 'diamond search' }

/** A macroblock worth looking at first, per sequence and block size. */
function defaultMB(seq: SequenceId, bs: 8 | 16): number {
  const cols = W / bs
  const at = (x: number, y: number) => Math.floor(y / bs) * cols + Math.floor(x / bs)
  if (seq === 'scene') return at(136, 100) // the checkered box
  if (seq === 'pan') return at(88, 72)
  return at(40, 24) // near a corner: zoom moves it most
}

const frameOf = (data: ArrayLike<number>): Frame => ({ data, w: W, h: H })

export function Video() {
  const [seqId, setSeqId] = useState<SequenceId>('scene')
  const [grain, setGrain] = useState(false)
  const [opts, setOpts] = useState<EncodeOptions>(DEFAULTS)
  const [mode, setMode] = useState<Mode>('mb')
  const [frameSel, setFrameSel] = useState(7)
  const [mbSel, setMbSel] = useState(() => defaultMB('scene', 16))
  const [playing, setPlaying] = useState(false)

  const set = <K extends keyof EncodeOptions>(k: K, v: EncodeOptions[K]) => setOpts((o) => ({ ...o, [k]: v }))

  const seq = useMemo(() => makeSequence(seqId, grain ? 6 : 0), [seqId, grain])
  const liveKey = useMemo(() => ({ seq, opts }), [seq, opts])
  const encKey = useDeferredValue(liveKey)
  const enc = useMemo(() => encodeSequence(encKey.seq.frames, encKey.opts), [encKey])
  const stale = encKey !== liveKey
  const n = enc.frames.length
  const bs = enc.options.blockSize
  const cols = W / bs

  // ---- step-through
  const clampFrame = (f: number) => Math.max(0, Math.min(n - 1, f))
  const fSel = clampFrame(frameSel)
  const mbIndex = Math.min(mbSel, cols * (H / bs) - 1)

  const mbView = useMemo(() => buildMbView(enc, seq.frames, fSel, mbIndex), [enc, seq, fSel, mbIndex])
  const count = mode === 'frames' ? n : mbView.steps.length
  const s = useStepper(count, {
    speed: mode === 'frames' ? 3 : 2,
    resetKey: mode === 'frames' ? `f:${seqId}:${grain}` : `m:${seqId}:${grain}:${fSel}:${mbIndex}:${JSON.stringify(enc.options)}`,
  })
  const frame = mode === 'frames' ? clampFrame(s.index) : fSel

  // Keep the two notions of "current frame" in step when switching modes.
  useEffect(() => {
    if (mode === 'frames') s.setIndex(fSel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  const pickFrame = (f: number) => {
    const g = clampFrame(f)
    setFrameSel(g)
    if (mode === 'frames') s.setIndex(g)
  }

  // Playback in macroblock mode: walk the frame slider.
  useEffect(() => {
    if (!playing || mode !== 'mb') return
    const id = setInterval(() => setFrameSel((f) => (f + 1) % n), 220)
    return () => clearInterval(id)
  }, [playing, mode, n])

  const f = enc.frames[frame]
  const cur = seq.frames[frame]
  const prevOrig = frame > 0 ? seq.frames[frame - 1] : null
  const plainDiff = useMemo(() => {
    if (!prevOrig) return null
    const d = new Int16Array(W * H)
    for (let i = 0; i < d.length; i++) d[i] = cur[i] - prevOrig[i]
    return d
  }, [cur, prevOrig])
  const residual = useMemo(() => {
    if (f.type !== 'P') return null
    const d = new Int16Array(W * H)
    for (let i = 0; i < d.length; i++) d[i] = cur[i] - f.prediction![i]
    return d
  }, [f, cur])
  const meanAbs = (d: ArrayLike<number> | null) => {
    if (!d) return 0
    let t = 0
    for (let i = 0; i < d.length; i++) t += Math.abs(d[i])
    return t / d.length
  }

  const onPickMB = (x: number, y: number) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(x / bs)))
    const r = Math.min(H / bs - 1, Math.max(0, Math.floor(y / bs)))
    setMbSel(r * cols + c)
    if (mode === 'frames') {
      setFrameSel(frame)
      setMode('mb')
    }
  }

  // ---- totals
  const raw = W * H * 8 * n
  let iCount = 0
  let mvBits = 0
  let resBits = 0
  let intraBits = 0
  let flagBits = 0
  for (const fr of enc.frames) {
    if (fr.type === 'I') iCount++
    mvBits += fr.bits.mv
    resBits += fr.bits.residual
    intraBits += fr.bits.intra
    flagBits += fr.bits.flags
  }
  const meanPsnr = enc.frames.reduce((t, x) => t + Math.min(x.psnr, 60), 0) / n

  return (
    <Page
      slug="video"
      lede={
        <>
          <p>
            Thirty frames a second, and each one is almost exactly the last one, moved a little. A video codec does not send pictures — it sends the
            first one, then for every later frame a grid of <b>arrows</b> saying where each block came from, and the small <b>residual</b> the
            arrows could not explain. Find the arrows, and a video costs a fraction of its frames sent as JPEGs. Get them wrong, or cut to a new
            scene, and you pay for a whole picture again.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Sequence">
              <Segmented value={seqId} onChange={(v) => { setSeqId(v); setMbSel(defaultMB(v, bs)); setFrameSel(v === 'scene' ? 7 : 5) }} options={(['scene', 'pan', 'zoom'] as SequenceId[]).map((v) => ({ value: v, label: SEQ_LABEL[v] }))} />
              <p className="small muted">
                {W}×{H}, {n} frames. {seq.note}.
              </p>
              <Toggle label="Film grain" value={grain} onChange={setGrain} help="Adds fresh random noise to every frame. Noise is new in every frame, so no motion vector can predict it — watch the P-frames get expensive." />
            </Group>
            <Group title="Motion search" help="How the encoder looks for each block in the previous frame. SAD — the sum of absolute pixel differences — scores each candidate position.">
              <Segmented value={opts.method} onChange={(v) => set('method', v)} options={(['diamond', 'tss', 'full'] as Method[]).map((v) => ({ value: v, label: METHOD_LABEL[v] }))} />
              <Segmented label="block size" value={opts.blockSize} onChange={(v) => { set('blockSize', v); setMbSel(defaultMB(seqId, v)) }} options={[{ value: 16, label: '16×16' }, { value: 8, label: '8×8' }]} help="Smaller blocks follow motion more closely but need four times as many vectors. H.264 picks per macroblock, from 16×16 down to 4×4." />
              <Slider label="range ±" value={opts.range} min={2} max={16} unit="px" onChange={(v) => set('range', v)} help="How far from its own position a block may be looked for. Full search tries every position: (2R+1)² of them." />
              <Toggle label="Half-pel vectors" value={opts.halfPel} onChange={(v) => set('halfPel', v)} help="After the whole-pixel search, also try the eight half-pixel positions around the winner, interpolating the reference. MPEG-1 onwards; H.264 goes to quarter-pel." />
            </Group>
            <Group title="Coding">
              <Slider label="quality" value={opts.quality} min={5} max={95} onChange={(v) => set('quality', v)} help="One knob for both frame types: the JPEG quality of I-frames, and the step of the flat quantiser on P-frame residuals." />
              <Slider label="keyframe every" value={opts.gop} min={1} max={32} unit="frames" onChange={(v) => set('gop', v)} help="The GOP length. 1 means every frame is an I-frame — Motion JPEG. Longer GOPs save bits but you can only start playing, or seek, at an I-frame." />
              <Toggle label="Keyframe when cheaper" value={opts.adaptiveKeyframes} onChange={(v) => set('adaptiveKeyframes', v)} help="If a P-frame would cost more than coding the frame from scratch, send an I-frame instead. That is how encoders catch scene cuts." />
              <Segmented
                label="predict from"
                value={opts.loop}
                onChange={(v) => set('loop', v)}
                options={[
                  { value: 'closed', label: 'decoded frames' },
                  { value: 'open', label: 'originals' },
                ]}
                help="An encoder must predict from what the decoder will have — its own reconstructed frames. Predicting from the pristine originals (open loop) looks better to the encoder and lets errors pile up at the decoder: drift."
              />
            </Group>
            <Group title="Step through">
              <Segmented
                value={mode}
                onChange={(v) => {
                  if (v === 'mb') setFrameSel(frame)
                  setMode(v)
                }}
                options={[
                  { value: 'mb', label: 'One macroblock' },
                  { value: 'frames', label: 'Frame by frame' },
                ]}
              />
              <p className="small muted">
                {mode === 'mb'
                  ? 'Click any block in the frame. Each step is one round of the search, then the prediction, residual, transform and bits.'
                  : 'Each step is one frame of the sequence: what type it is, why, and what it cost.'}
              </p>
            </Group>
            <Group title="Result" aside={stale ? 'encoding…' : undefined}>
              <Stats>
                <Stat label="total" value={fmtBits(enc.totalBits)} tone="accent" sub={`${fmt(enc.totalBits / (W * H * n), 3)} bits/pixel`} />
                <Stat label="vs raw" value={`${fmt(raw / enc.totalBits, 0)}:1`} sub="8 bits/pixel" />
                <Stat label="vs all-JPEG" value={`${fmt(enc.allIntraBits / enc.totalBits, 2)}×`} sub="smaller" help="Against coding every frame as an I-frame at the same quality: what motion compensation is worth here." tone={enc.allIntraBits > enc.totalBits ? 'good' : 'bad'} />
                <Stat label="mean PSNR" value={`${fmt(meanPsnr, 1)} dB`} sub={`${iCount} I · ${n - iCount} P`} />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel
          title={`Frame ${frame} — ${f.type === 'I' ? 'I-frame' : 'P-frame'}`}
          aside={
            <span className="vd-frame-ctl">
              <button type="button" className="btn btn-ghost" onClick={() => (mode === 'frames' ? s.toggle() : setPlaying((p) => !p))}>
                {(mode === 'frames' ? s.playing : playing) ? '❚❚ pause' : '▶ play'}
              </button>
              <input type="range" min={0} max={n - 1} value={frame} onChange={(e) => pickFrame(parseInt(e.target.value, 10))} aria-label="Frame" />
            </span>
          }
        >
          <div className="vd-views">
            <figure>
              <FrameCanvas data={cur} overlay={vectorOverlay(f, bs, mode === 'mb' ? mbIndex : null)} onPick={onPickMB} />
              <figcaption>
                <b>Frame {frame}{f.type === 'P' ? ', with its vectors' : ''}</b>
                <span>{f.type === 'P' ? 'arrows (drawn ×3) point to where each block was found in frame ' + (frame - 1) : 'coded on its own, like a JPEG'}</span>
              </figcaption>
            </figure>
            <figure>
              <FrameCanvas data={f.type === 'P' ? f.prediction! : f.recon} dim={f.type !== 'P'} />
              <figcaption>
                <b>{f.type === 'P' ? 'Prediction' : 'No prediction'}</b>
                <span>{f.type === 'P' ? `frame ${frame - 1}'s blocks, moved by the arrows` : 'an I-frame looks at nothing else'}</span>
              </figcaption>
            </figure>
            <figure>
              <FrameCanvas data={residual} signed gain={3} dim={!residual} />
              <figcaption>
                <b>Residual</b>
                <span>{residual ? `frame − prediction, ×3 · mean |e| = ${fmt(meanAbs(residual), 1)}` : '—'}</span>
              </figcaption>
            </figure>
            <figure>
              <FrameCanvas data={plainDiff} signed gain={3} dim={!plainDiff} />
              <figcaption>
                <b>Without motion</b>
                <span>{plainDiff ? `frame − frame ${frame - 1}, ×3 · mean |e| = ${fmt(meanAbs(plainDiff), 1)}` : 'no earlier frame'}</span>
              </figcaption>
            </figure>
          </div>
          <div className="legend" style={{ marginTop: 10 }}>
            <span>
              <i style={{ background: 'rgb(255,150,30)' }} /> brighter than predicted
            </span>
            <span>
              <i style={{ background: 'rgb(30,130,255)' }} /> darker than predicted
            </span>
            <span>
              <i style={{ background: 'rgb(128,128,128)' }} /> predicted exactly
            </span>
          </div>
        </Panel>

        {mode === 'mb' ? <MbStage view={mbView} index={s.index} opts={enc.options} /> : <GopStage enc={enc} frame={frame} onPick={pickFrame} cut={seq.cut} />}

        <Transport s={s} label={(i) => (mode === 'frames' ? `frame ${i} / ${n - 1}` : `${mbView.steps[i]?.short ?? ''} · ${i} / ${count - 1}`)} />
        <Narration tone={mode === 'mb' && mbView.steps[s.index]?.tone ? mbView.steps[s.index].tone : undefined}>
          {mode === 'mb' ? mbView.steps[s.index]?.text : frameNarration(enc, frame, seq.cut)}
        </Narration>

        <Panel title="Bits per frame" aside="click a bar to jump to that frame">
          <BitsChart frames={enc.frames} selected={frame} onPick={pickFrame} cut={seq.cut} />
        </Panel>

        <Panel title="How big is it" aside={`${n} frames of ${W}×${H}`}>
          <SizeBars
            unit="bits"
            rows={[
              { label: 'raw, 8 bits/pixel', value: raw, tone: 'faint' },
              { label: 'every frame JPEG', value: enc.allIntraBits, tone: 'ink', note: 'Motion JPEG, same quality' },
              { label: 'I + P frames', value: enc.totalBits, note: `${fmt((100 * enc.totalBits) / enc.allIntraBits, 0)}% of all-JPEG` },
              { label: '· I-frames', value: intraBits, tone: 'faint' },
              { label: '· P vectors', value: mvBits, tone: 'faint' },
              { label: '· P residual', value: resBits + flagBits, tone: 'faint', note: `incl. ${flagBits.toLocaleString('en-US')} coded-block flags` },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Payload of this page’s simplified syntax: JPEG scans for I-frames; Exp-Golomb vectors, one flag per 8×8 block and Annex K Huffman
            residuals for P-frames. No headers. Real codecs add a few hundred bytes of headers and win back far more with smarter entropy coding.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The idea</h2>
        <Code>{`for each macroblock of frame t:
    v ← the displacement that best matches it in frame t−1   # motion estimation
    p ← frame t−1's pixels at the block's position + v         # motion compensation
    send v (as the difference from its neighbours' vectors)
    send DCT(block − p), quantised                             # the residual, like JPEG
decoder: block = its own frame t−1 at + v, + the decoded residual`}</Code>
        <p>
          A video frame looks like a photograph, but it is mostly a re-arrangement of the previous one. Motion compensation replaces “here are
          27 648 pixels” with “these 108 blocks came from about here, and here is what changed” — and what changed, in a well-predicted frame, is
          mostly zero. Compare the last two panels above: the plain difference between frames is full of edges wherever anything moved; the
          motion-compensated residual has most of them gone.
        </p>

        <h2>Finding the vectors</h2>
        <p>
          <b>Full search</b> tries every displacement within ±R and keeps the lowest SAD: (2R+1)² candidates, 1 089 for R = 16, each touching
          256 pixels. It is guaranteed to find the best match and it is the expensive part of every encoder. Fast searches bet that the error
          surface is a bowl and walk downhill: <b>three-step search</b> (Koga et al., 1981) probes nine points at a coarse step and halves it;{' '}
          <b>diamond search</b> (Zhu &amp; Ma, 2000) walks a large diamond until its centre wins, then refines with a small one. Both evaluate a
          few dozen positions instead of a thousand. On a rough texture the bowl assumption fails and they stop in a local minimum — try them on
          the <i>Pure pan</i> sequence, where three-step with a wide range is visibly worse than diamond. Modern encoders seed the search from
          the neighbours’ vectors (the predictor), which is why they rarely get lost.
        </p>
        <p>
          A single block cannot always pin motion down. On a smooth slope or a straight edge, sliding along the contour changes nothing — the{' '}
          <b>aperture problem</b>. The encoder does not care which of the equally good vectors it picks, as long as the residual is small; that is
          the difference between coding motion and measuring it.
        </p>

        <h2>Half a pixel, and why it pays</h2>
        <p>
          Things do not move in whole pixels. The wall in <i>Scene</i> pans 1.5 px per frame, so no integer vector matches it; interpolating the
          reference halfway between pixels does. MPEG-1 introduced half-pel vectors with bilinear averaging (the rounding used here); H.264 went
          to quarter-pel with a six-tap filter; HEVC and AV1 use longer filters still. The interpolation also blurs slightly, which is part of why
          every other frame of the pan costs more: a sharp frame predicted from a softened one leaves edges behind.
        </p>

        <h2>Sending the vectors</h2>
        <p>
          Neighbouring blocks usually move together, so a vector is sent as the difference from a prediction — here H.264’s rule, the median of
          the left, top and top-right neighbours. On a pan almost every difference is (0, 0), which Exp-Golomb codes in one bit per component
          (see <a href="#/intcodes">Integer Codes</a>). H.264 and later also have <b>skip</b> blocks: “use the predicted vector and no residual” in
          a fraction of a bit.
        </p>

        <h2>Closing the loop</h2>
        <p>
          The decoder never sees the original frames, only its own decoded ones, which carry quantisation error. If the encoder predicted from the
          originals, its residuals would assume a reference the decoder does not have; the error would add up frame after frame — <b>drift</b>.
          Switch <i>predict from</i> to originals and watch the PSNR line slide down the GOP until the next I-frame resets it. Every real encoder
          contains a full decoder for exactly this reason, and the test suite checks that this page’s decoder reproduces the encoder’s
          reconstruction bit for bit.
        </p>

        <h2>I, P, B and the GOP</h2>
        <p>
          I-frames are coded on their own and are the only places a player can start or seek to, so broadcasters put one every half second or so.
          P-frames predict from an earlier frame. <b>B-frames</b> (not built here) predict from both an earlier and a <i>later</i> frame — which
          means sending frames out of order — and are cheapest of all, because uncovered background can be found in the future frame. A{' '}
          <b>scene cut</b> breaks every assumption at once: nothing in the previous frame resembles the new one, a forced P-frame there costs more
          than an I-frame (turn off “keyframe when cheaper” to see the spike), and encoders detect cuts precisely by noticing this.
        </p>

        <h2>From H.261 to AV1</h2>
        <ul>
          <li>
            <b>H.261</b> (1988), for video calls over ISDN: 16×16 macroblocks, integer vectors, 8×8 DCT — the template every later codec kept.
          </li>
          <li>
            <b>MPEG-1</b> (1993, Video CD) added half-pel vectors and B-frames; <b>MPEG-2</b> (1995) brought interlace and became DVD and digital
            broadcast.
          </li>
          <li>
            <b>H.264/AVC</b> (2003): variable block sizes from 16×16 to 4×4, quarter-pel, up to sixteen reference frames, intra prediction from
            neighbouring pixels (see <a href="#/jpeg">JPEG</a> for what it replaced), an in-loop deblocking filter, and CABAC arithmetic coding.
            Roughly half MPEG-2’s bit rate.
          </li>
          <li>
            <b>HEVC</b> (2013) and <b>AV1</b> (2018): coding tree units up to 64×64 or 128×128 split recursively, many more prediction modes,
            better filters — about half again. All of them are still “find the arrows, code what is left”.
          </li>
        </ul>
        <div className="aside">
          Simplifications here: one vector per macroblock, one reference frame, no B-frames, no intra blocks inside P-frames (uncovered background
          has to be coded as residual), no deblocking filter, no rate control — quality is fixed and the bit rate floats.
        </div>
      </Notes>
    </Page>
  )
}

// ---------------------------------------------------------- macroblock view

interface MbStep {
  short: string
  kind: 'intro' | 'search' | 'winner' | 'predict' | 'residual' | 'transform' | 'bits'
  /** For search steps: how many search steps to draw. */
  upto: number
  text: ReactNode
  tone?: 'done' | 'warn'
}

interface MbView {
  ok: boolean
  frame: number
  x0: number
  y0: number
  bs: number
  R: number
  ref: Frame | null
  cur: Frame
  trace: SearchResult | null
  mb: Macroblock | null
  pred: Int16Array | null
  hypothetical: boolean
  steps: MbStep[]
}

function buildMbView(enc: ReturnType<typeof encodeSequence>, frames: Uint8ClampedArray[], frame: number, index: number): MbView {
  const o = enc.options
  const bs = o.blockSize
  const cols = W / bs
  const x0 = (index % cols) * bs
  const y0 = Math.floor(index / cols) * bs
  const cur = frameOf(frames[frame])
  const base = { frame, x0, y0, bs, R: o.range, cur }
  if (frame === 0)
    return {
      ...base,
      ok: false,
      ref: null,
      trace: null,
      mb: null,
      pred: null,
      hypothetical: false,
      steps: [{ short: 'frame 0', kind: 'intro', upto: 0, text: <>Frame 0 has nothing before it to predict from, so it is always an I-frame. Pick a later frame with the slider above.</> }],
    }
  const refData = o.loop === 'closed' ? enc.frames[frame - 1].recon : frames[frame - 1]
  const ref = frameOf(refData)
  const trace = search(cur, ref, x0, y0, bs, { method: o.method, range: o.range, halfPel: o.halfPel, trace: true })
  const f = enc.frames[frame]
  let mb: Macroblock
  let hypothetical = false
  if (f.type === 'P') mb = f.mbs![index]
  else {
    // An I-frame was sent; show what the P-frame would have been.
    hypothetical = true
    mb = codePFrame(frames[frame], refData, enc.frames[frame - 1].recon, o).mbs[index]
  }
  const pred = predictBlockFor(ref, x0, y0, bs, mb.mv)

  const steps: MbStep[] = []
  const where = `(${index % cols}, ${Math.floor(index / cols)})`
  const sadZero = trace.steps.flatMap((st) => st.probes).find((p) => p.mx === 0 && p.my === 0)?.sad
  steps.push({
    short: 'the block',
    kind: 'intro',
    upto: 0,
    text: (
      <>
        Macroblock {where}: {bs}×{bs} pixels at ({x0}, {y0}) of frame {frame}. The encoder looks for it in{' '}
        {o.loop === 'closed' ? `its own decoded copy of frame ${frame - 1}` : `the original frame ${frame - 1}`}, inside ±{o.range} px of the
        dashed square (where it would be if nothing moved), using {METHOD_LONG[o.method]}.
        {hypothetical && <> This frame was actually sent as an I-frame ({f.reason === 'cheaper' ? 'predicting it cost more than starting over' : 'a scheduled keyframe'}); this is what the P-frame would have done.</>}
      </>
    ),
  })
  trace.steps.forEach((st, k) => {
    const sorted = st.probes.slice().sort((a, b) => a.sad - b.sad)
    const top = sorted[0]
    const isHalf = st.label.startsWith('half')
    steps.push({
      short: isHalf ? 'half-pel' : `search ${k + 1}`,
      kind: 'search',
      upto: k + 1,
      text: (
        <>
          {isHalf ? (
            <>
              Half-pel refinement: the eight positions halfway between pixels around the whole-pixel winner{' '}
              {fmtMV(trace.steps[k - 1]?.best.mx ?? 0, trace.steps[k - 1]?.best.my ?? 0)}, each predicted by averaging neighbouring reference pixels.
            </>
          ) : o.method === 'full' ? (
            <>Full search, {st.label}: {st.probes.length} positions.</>
          ) : o.method === 'tss' ? (
            <>Three-step search, {st.label}: the centre and eight points around it.</>
          ) : (
            <>Diamond search, {st.label}.</>
          )}{' '}
          {top && (
            <>
              Lowest SAD this round: <b>{top.sad.toLocaleString('en-US')}</b> at {fmtMV(top.mx, top.my)}.
            </>
          )}{' '}
          Best so far: {fmtMV(st.best.mx, st.best.my)} with SAD {st.best.sad.toLocaleString('en-US')}.
          {o.method === 'diamond' && st.label.startsWith('large') && k + 1 < trace.steps.length && trace.steps[k + 1].label.startsWith('small') && <> The centre won, so the large diamond stops.</>}
        </>
      ),
    })
  })
  steps.push({
    short: 'winner',
    kind: 'winner',
    upto: trace.steps.length,
    tone: 'done',
    text: (
      <>
        Winner: vector <b>{fmtMV(trace.mx, trace.my)}</b> px, SAD {trace.sad.toLocaleString('en-US')}
        {sadZero !== undefined && <> (no motion would have scored {sadZero.toLocaleString('en-US')})</>}, after evaluating{' '}
        <b>{trace.evaluated}</b> positions{o.method !== 'full' && <> — full search would have tried {(2 * o.range + 1) ** 2 + (o.halfPel ? 8 : 0)}</>}.
      </>
    ),
  })
  steps.push({
    short: 'prediction',
    kind: 'predict',
    upto: trace.steps.length,
    text: (
      <>
        The prediction is the reference block the arrow points at
        {(mb.mv.mx & 1 || mb.mv.my & 1) ? <>, interpolated between pixels because the vector is fractional</> : null}. The decoder can build exactly
        this block itself: it has the reference frame, and it will be told the vector.
      </>
    ),
  })
  let resAbs = 0
  for (const sb of mb.subs) for (let i = 0; i < 64; i++) resAbs += Math.abs(sb.residual[i])
  steps.push({
    short: 'residual',
    kind: 'residual',
    upto: trace.steps.length,
    text: (
      <>
        Residual = block − prediction: mean |e| = <b>{fmt(resAbs / (bs * bs), 1)}</b> grey levels, against{' '}
        {fmt(meanAbsBlock(cur, ref, x0, y0, bs), 1)} if the block were compared with the same place in the previous frame. This is all that is
        left to send.
      </>
    ),
  })
  const coded = mb.subs.filter((sb) => sb.coded).length
  steps.push({
    short: 'transform',
    kind: 'transform',
    upto: trace.steps.length,
    text: (
      <>
        Each 8×8 piece of the residual goes through the DCT and is divided by a flat step of {interTable(o.quality)[0]}, then rounded. {coded} of{' '}
        {mb.subs.length} piece{mb.subs.length === 1 ? '' : 's'} keep any non-zero coefficient
        {coded < mb.subs.length ? <>; the rest are sent as a single “not coded” bit</> : null}.
      </>
    ),
  })
  const mvdx = mb.mv.mx - mb.pred.mx
  const mvdy = mb.mv.my - mb.pred.my
  steps.push({
    short: 'bits',
    kind: 'bits',
    upto: trace.steps.length,
    tone: 'done',
    text: (
      <>
        Bits: the vector is sent as the difference from the neighbours’ median {fmtMV(mb.pred.mx, mb.pred.my)} — ({fmtHalf(mvdx)}, {fmtHalf(mvdy)})
        → <code>{mb.mvBits.x}</code> <code>{mb.mvBits.y}</code> — plus the residual: <b>{mb.bits}</b> bits for this macroblock, against{' '}
        {bs * bs * 8} raw.
      </>
    ),
  })
  return { ...base, ok: true, ref, trace, mb, pred, hypothetical, steps }
}

function meanAbsBlock(cur: Frame, ref: Frame, x0: number, y0: number, bs: number): number {
  let t = 0
  for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) t += Math.abs(cur.data[(y0 + y) * W + x0 + x] - ref.data[(y0 + y) * W + x0 + x])
  return t / (bs * bs)
}

function MbStage({ view, index, opts }: { view: MbView; index: number; opts: EncodeOptions }) {
  const st = view.steps[Math.min(index, view.steps.length - 1)]
  if (!view.ok || !view.trace || !view.mb || !view.ref || !view.pred) return null
  const { bs, x0, y0, cur, mb, trace } = view
  const block = new Uint8ClampedArray(bs * bs)
  for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) block[y * bs + x] = cur.data[(y0 + y) * W + x0 + x]
  const residual = new Int16Array(bs * bs)
  for (let i = 0; i < bs * bs; i++) residual[i] = block[i] - view.pred[i]
  const after = st.kind !== 'intro' && st.kind !== 'search'
  const searchStep = st.kind === 'search' ? trace.steps[st.upto - 1] : null
  const cell = Math.max(4, Math.round(160 / bs))

  return (
    <Panel title={`Macroblock (${x0 / bs}, ${y0 / bs}) of frame ${view.frame}${view.hypothetical ? ' — as a P-frame would code it' : ''}`} aside={`${METHOD_LONG[opts.method]}, ±${opts.range} px${opts.halfPel ? ', half-pel' : ''}`}>
      <div className="vd-mb">
        <figure>
          <BlockCanvas data={block} size={bs} px={cell} />
          <figcaption>
            <b>The block</b>
            <span>frame {view.frame}</span>
          </figcaption>
        </figure>
        <figure className="vd-window">
          <SearchWindow refFrame={view.ref} x0={x0} y0={y0} bs={bs} R={opts.range} steps={trace.steps} upto={st.kind === 'intro' ? 0 : st.upto} showBest={st.kind !== 'intro'} />
          <figcaption>
            <b>Search window in frame {view.frame - 1}</b>
            <span>dashed: no motion · dots: positions tried · box: best so far</span>
          </figcaption>
        </figure>
        <figure>
          {after ? <BlockCanvas data={view.pred} size={bs} px={cell} /> : <div className="vd-empty" style={{ aspectRatio: '1' }} />}
          <figcaption>
            <b>Prediction</b>
            <span>{after ? `vector ${fmtMV(mb.mv.mx, mb.mv.my)}` : 'after the search'}</span>
          </figcaption>
        </figure>
        <figure>
          {after && st.kind !== 'predict' && st.kind !== 'winner' ? <BlockCanvas data={residual} size={bs} px={cell} signed gain={3} /> : <div className="vd-empty" style={{ aspectRatio: '1' }} />}
          <figcaption>
            <b>Residual</b>
            <span>block − prediction, ×3</span>
          </figcaption>
        </figure>
      </div>

      {searchStep && (
        <div className="vd-probes">
          <div className="small muted">{searchStep.label} — lowest SAD first</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>vector (px)</th>
                  <th className="num">
                    SAD <Help text="Sum of absolute differences between the block and the reference block at this displacement. Lower is a better match." />
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {searchStep.probes
                  .slice()
                  .sort((a, b) => a.sad - b.sad)
                  .slice(0, 6)
                  .map((p) => (
                    <tr key={p.mx + ':' + p.my} className={p.mx === searchStep.best.mx && p.my === searchStep.best.my ? 'on' : ''}>
                      <td>{fmtMV(p.mx, p.my)}</td>
                      <td className="num">{p.sad.toLocaleString('en-US')}</td>
                      <td className="small muted">{p.mx === searchStep.best.mx && p.my === searchStep.best.my ? 'best so far' : ''}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(st.kind === 'transform' || st.kind === 'bits') && (
        <div className="vd-coefs">
          {mb.subs.map((sb, k) => (
            <CoefGrid key={k} q={sb.q} title={mb.subs.length > 1 ? `piece ${k + 1}` : 'quantised'} />
          ))}
        </div>
      )}

      {st.kind === 'bits' && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>what</th>
                <th>bits on the wire</th>
                <th className="num">count</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>vector Δx = {fmtHalf(mb.mv.mx - mb.pred.mx)} px</td>
                <td>
                  <code>{mb.mvBits.x}</code>
                </td>
                <td className="num">{mb.mvBits.x.length}</td>
              </tr>
              <tr>
                <td>vector Δy = {fmtHalf(mb.mv.my - mb.pred.my)} px</td>
                <td>
                  <code>{mb.mvBits.y}</code>
                </td>
                <td className="num">{mb.mvBits.y.length}</td>
              </tr>
              {mb.subs.map((sb, k) => (
                <tr key={k}>
                  <td>piece {k + 1}: {sb.coded ? `${sb.syms.filter((x) => x.kind === 'AC').length} AC + DC${sb.syms.some((x) => x.kind === 'EOB') ? ' + EOB' : ''}` : 'not coded'}</td>
                  <td className="vd-wire">
                    <code>{sb.coded ? '1 ' + sb.syms.map((x) => x.code + x.extra).join(' ') : '0'}</code>
                  </td>
                  <td className="num">{sb.bits}</td>
                </tr>
              ))}
              <tr className="on">
                <td>
                  <b>macroblock</b>
                </td>
                <td className="small muted">vs {bs * bs * 8} bits raw</td>
                <td className="num">
                  <b>{mb.bits}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------- GOP view

function GopStage({ enc, frame, onPick, cut }: { enc: ReturnType<typeof encodeSequence>; frame: number; onPick: (f: number) => void; cut: number | null }) {
  return (
    <Panel title="The group of pictures" aside="click a frame">
      <div className="vd-gop">
        {enc.frames.map((fr) => (
          <button key={fr.index} type="button" className={'vd-gop-cell ' + fr.type + (fr.index === frame ? ' cur' : '') + (cut === fr.index ? ' cut' : '')} onClick={() => onPick(fr.index)} title={`frame ${fr.index}: ${fr.type}, ${fr.total} bits`}>
            <b>{fr.type}</b>
            <small>{fr.index}</small>
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        {cut !== null && <>The sequence cuts to a new shot at frame {cut} (marked). </>}
        A player can only start decoding at an I-frame; every P-frame needs the one before it.
      </p>
    </Panel>
  )
}

function frameNarration(enc: ReturnType<typeof encodeSequence>, t: number, cut: number | null): ReactNode {
  const f = enc.frames[t]
  const o = enc.options
  if (f.type === 'I') {
    const why =
      f.reason === 'first'
        ? 'the first frame has nothing to predict from'
        : f.reason === 'gop'
          ? `it is a scheduled keyframe (one every ${o.gop} frames)`
          : `predicting it would have cost more than ${f.intraBits.toLocaleString('en-US')} bits — ${cut === t ? 'this is the scene cut, and nothing in the previous shot looks like it' : 'too much changed'}`
    return (
      <>
        Frame {t}: <b>I-frame</b>, because {why}. Coded like a JPEG: <b>{f.total.toLocaleString('en-US')}</b> bits, PSNR {fmt(f.psnr, 1)} dB.
      </>
    )
  }
  const mbs = f.mbs!
  const still = mbs.filter((m) => m.mv.mx === 0 && m.mv.my === 0).length
  const coded = mbs.reduce((s, m) => s + m.subs.filter((x) => x.coded).length, 0)
  const pieces = mbs.reduce((s, m) => s + m.subs.length, 0)
  return (
    <>
      Frame {t}: <b>P-frame</b> predicted from frame {t - 1}. {mbs.length - still} of {mbs.length} macroblocks moved; {coded} of {pieces} residual
      pieces needed coding. <b>{f.total.toLocaleString('en-US')}</b> bits ({f.bits.mv.toLocaleString('en-US')} for vectors) —{' '}
      {fmt((100 * f.total) / f.intraBits, 0)}% of what an I-frame would cost. PSNR {fmt(f.psnr, 1)} dB
      {cut === t && <> — this is the cut, forced to predict from the old shot</>}.
    </>
  )
}

// --------------------------------------------------------------- bits chart

function BitsChart({ frames, selected, onPick, cut }: { frames: FrameResult[]; selected: number; onPick: (f: number) => void; cut: number | null }) {
  const VW = 720
  const VH = 220
  const pad = { l: 46, r: 40, t: 12, b: 26 }
  const iw = VW - pad.l - pad.r
  const ih = VH - pad.t - pad.b
  const maxBits = Math.max(1, ...frames.map((f) => Math.max(f.total, f.intraBits)))
  const bw = iw / frames.length
  const y = (b: number) => pad.t + ih - (b / maxBits) * ih
  const pLo = 25
  const pHi = 55
  const py = (p: number) => pad.t + ih - ((Math.min(pHi, Math.max(pLo, p)) - pLo) / (pHi - pLo)) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxBits)
  return (
    <div className="vd-chart">
      <svg viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Bits per frame">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={VW - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={pad.l - 6} y={y(t) + 3.5} fontSize={10} textAnchor="end" fill="var(--muted)">
              {t >= 1000 ? `${Math.round(t / 1000)}k` : Math.round(t)}
            </text>
          </g>
        ))}
        {[30, 40, 50].map((p) => (
          <text key={p} x={VW - pad.r + 6} y={py(p) + 3.5} fontSize={10} fill="var(--muted)">
            {p} dB
          </text>
        ))}
        {frames.map((f, i) => {
          const x = pad.l + i * bw + bw * 0.12
          const w = bw * 0.76
          const segs =
            f.type === 'I'
              ? [{ v: f.bits.intra, c: 'var(--hl-5)' }]
              : [
                  { v: f.bits.residual + f.bits.flags, c: 'var(--hl-3)' },
                  { v: f.bits.mv, c: 'var(--hl-4)' },
                ]
          let acc = 0
          return (
            <g key={i} onClick={() => onPick(i)} style={{ cursor: 'pointer' }}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill={i === selected ? 'var(--paper-2)' : 'transparent'} />
              {f.type === 'P' && <line x1={x} x2={x + w} y1={y(f.intraBits)} y2={y(f.intraBits)} stroke="var(--line-strong)" strokeDasharray="2 2" />}
              {segs.map((s, k) => {
                const y0 = y(acc + s.v)
                const hgt = y(acc) - y0
                acc += s.v
                return <rect key={k} x={x} y={y0} width={w} height={Math.max(0.5, hgt)} fill={s.c} stroke="var(--ink)" strokeWidth={i === selected ? 1.5 : 0.5} />
              })}
              {(i % 4 === 0 || i === selected) && (
                <text x={pad.l + i * bw + bw / 2} y={VH - 10} fontSize={10} textAnchor="middle" fill={i === selected ? 'var(--ink)' : 'var(--muted)'} fontWeight={i === selected ? 700 : 400}>
                  {i}
                </text>
              )}
              {cut === i && (
                <text x={pad.l + i * bw + bw / 2} y={pad.t + 10} fontSize={9.5} textAnchor="middle" fill="var(--ink)">
                  cut
                </text>
              )}
            </g>
          )
        })}
        <polyline
          points={frames.map((f, i) => `${pad.l + i * bw + bw / 2},${py(f.psnr)}`).join(' ')}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.6}
          pointerEvents="none"
        />
        {frames.map((f, i) => (
          <circle key={i} cx={pad.l + i * bw + bw / 2} cy={py(f.psnr)} r={2.2} fill="var(--card)" stroke="var(--ink)" pointerEvents="none" />
        ))}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--hl-5)' }} /> I-frame
        </span>
        <span>
          <i style={{ background: 'var(--hl-4)' }} /> vectors
        </span>
        <span>
          <i style={{ background: 'var(--hl-3)' }} /> residual
        </span>
        <span>
          <i style={{ borderStyle: 'dashed', background: 'transparent' }} /> what an I-frame would cost
        </span>
        <span>— PSNR (right axis)</span>
      </div>
    </div>
  )
}
