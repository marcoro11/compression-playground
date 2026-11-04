import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react'
import { fmt } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { useTheme } from '../../lib/theme'
import { Group, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import { deflateCodec } from '../deflate/codec'
import { noise, sphere, zonePlate, SIZE } from '../jpeg/images'
import { dctAtBits, prepare, rdCurves, waveletAt } from './compare'
import { bands, forward2d, inverse2d, losslessBits, traceHaar, trace53, type Kind, type PassState } from './wavelet'
import { Bars, fmtNum, GreyCanvas, Mosaic, Pane, RdChart, usePalette, type Bar } from './views'
import './wavelet.css'

type Preset = 'sphere' | 'text' | 'zone' | 'noise' | 'upload'
type StepMode = 'row' | 'levels'
type RowKind = 'haar' | 'cdf53'
type RowSource = 'image' | 'ramp' | 'edge' | 'flat'

const KIND_NAME: Record<Kind, string> = { haar: 'Haar', cdf53: 'CDF 5/3', cdf97: 'CDF 9/7' }

/** Where the zoom lens starts on each picture: somewhere a transform has to work. */
const LENS: Record<Preset, { x: number; y: number }> = {
  sphere: { x: 64, y: 72 },
  text: { x: 16, y: 40 },
  zone: { x: 176, y: 176 },
  noise: { x: 96, y: 96 },
  upload: { x: 96, y: 96 },
}
const LENS_SIZE = 64

/** Where the 1-D row is read from, per picture: a row that crosses an edge. */
const ROW: Record<Preset, { x: number; y: number }> = {
  sphere: { x: 60, y: 112 },
  text: { x: 20, y: 70 },
  zone: { x: 200, y: 128 },
  noise: { x: 100, y: 100 },
  upload: { x: 120, y: 128 },
}

/** Sharp black text and lines on white — where edges, and ringing, live. */
function textImage(): Uint8ClampedArray {
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.fillStyle = '#000'
  ctx.font = 'bold 56px "IBM Plex Sans", Arial, sans-serif'
  ctx.fillText('wavelet', 14, 80)
  ctx.font = '15px "IBM Plex Mono", monospace'
  ctx.fillText('no blocks, just blur', 16, 118)
  ctx.font = '11px "IBM Plex Mono", monospace'
  ctx.fillText('small print goes soft: 0123456789', 16, 140)
  ctx.lineWidth = 1
  for (let i = 0; i < 9; i++) {
    ctx.beginPath()
    ctx.moveTo(16 + i * 12, 162)
    ctx.lineTo(16 + i * 12 + 40, 240)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(196, 200, 40, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#999'
  ctx.fillRect(196, 160, 44, 80)
  return toLuma(ctx.getImageData(0, 0, SIZE, SIZE).data)
}

function toLuma(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])
  return out
}

async function loadUpload(file: File): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d')!
  const s = Math.max(SIZE / bmp.width, SIZE / bmp.height)
  ctx.drawImage(bmp, (SIZE - bmp.width * s) / 2, (SIZE - bmp.height * s) / 2, bmp.width * s, bmp.height * s)
  return toLuma(ctx.getImageData(0, 0, SIZE, SIZE).data)
}

/** Quantizer step slider position (0–100) ↔ Δ, logarithmic from 1 to 200. */
const stepOf = (t: number) => Math.round(200 ** (t / 100) * 10) / 10
const crop = (data: ArrayLike<number>, x0: number, y0: number, n: number) => {
  const out = new Float64Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = data[(y0 + y) * SIZE + x0 + x]
  return out
}
const errorImage = (orig: ArrayLike<number>, rec: ArrayLike<number>) => {
  const out = new Float64Array(orig.length)
  for (let i = 0; i < orig.length; i++) out[i] = 128 + 8 * (Math.max(0, Math.min(255, Math.round(rec[i]))) - orig[i])
  return out
}

export function Wavelet() {
  const pageRef = useRef<HTMLDivElement>(null)
  const theme = useTheme(pageRef)
  const pal = usePalette(theme)

  const [preset, setPreset] = useState<Preset>('sphere')
  const [upload, setUpload] = useState<Uint8ClampedArray | null>(null)
  const [kind, setKind] = useState<Kind>('cdf97')
  const [levels, setLevels] = useState(3)
  const [stepMode, setStepMode] = useState<StepMode>('levels')
  const [rowKind, setRowKind] = useState<RowKind>('cdf53')
  const [rowSource, setRowSource] = useState<RowSource>('image')
  const [lossless, setLossless] = useState(false)
  const [stepT, setStepT] = useState(57)
  const [showError, setShowError] = useState(false)
  const [lens, setLens] = useState(LENS.sphere)

  const img = useMemo(() => {
    if (preset === 'upload' && upload) return upload
    if (preset === 'text') return textImage()
    if (preset === 'zone') return zonePlate()
    if (preset === 'noise') return noise()
    return sphere()
  }, [preset, upload])

  const pickPreset = (p: Preset) => {
    setPreset(p)
    setLens(LENS[p])
  }

  // ------------------------------------------------------------ 1-D row
  const row = useMemo(() => {
    if (rowSource === 'ramp') return Array.from({ length: 16 }, (_, i) => 40 + 9 * i)
    if (rowSource === 'edge') return Array.from({ length: 16 }, (_, i) => (i < 7 ? 52 : 196))
    if (rowSource === 'flat') return new Array(16).fill(140)
    const { x, y } = ROW[preset]
    return Array.from({ length: 16 }, (_, i) => img[y * SIZE + x + i])
  }, [rowSource, img, preset])
  const haarTrace = useMemo(() => traceHaar(row), [row])
  const liftTrace = useMemo(() => trace53(row), [row])

  // ----------------------------------------------------- 2-D level passes
  const passKind: Kind = lossless ? 'cdf53' : kind
  const passes = useMemo(() => {
    const centred = lossless ? Float64Array.from(img) : Float64Array.from(img, (v) => v - 128)
    return forward2d(centred, SIZE, SIZE, levels, passKind, lossless, true).passes
  }, [img, levels, passKind, lossless])

  const count = stepMode === 'row' ? (rowKind === 'haar' ? haarTrace.length : liftTrace.length) : passes.length
  const s = useStepper(count, { speed: stepMode === 'row' ? 2 : 1, resetKey: stepMode + rowKind + rowSource + preset + levels + passKind })

  // ---------------------------------------------------------- compression
  const dKind = useDeferredValue(kind)
  const dLevels = useDeferredValue(levels)
  const dStepT = useDeferredValue(stepT)
  const step = stepOf(dStepT)
  const prepared = useMemo(() => prepare(img, SIZE, SIZE, dKind, dLevels), [img, dKind, dLevels])
  const wav = useMemo(() => waveletAt(prepared, step), [prepared, step])
  const dct = useMemo(() => dctAtBits(prepared, wav.bits), [prepared, wav.bits])
  const rd = useMemo(() => rdCurves(prepared, [1.5, 2.5, 4, 6, 9, 13, 19, 28, 42, 64, 96, 150]), [prepared])

  const lossy = useMemo(() => {
    const { coefs } = forward2d(img, SIZE, SIZE, dLevels, 'cdf53', true)
    const perBand = losslessBits(coefs, SIZE, SIZE, dLevels)
    const back = inverse2d(coefs, SIZE, SIZE, dLevels, 'cdf53', true)
    let maxErr = 0
    for (let i = 0; i < img.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - img[i]))
    return { perBand, bits: perBand.reduce((a, b) => a + b, 0), maxErr, back }
  }, [img, dLevels])
  const deflateBytes = useMemo(() => deflateCodec.encode(new Uint8Array(img.buffer, img.byteOffset, img.byteLength)).length, [img])

  // Quantized coefficient mosaic for the "what was kept" pane.
  const keptState = useMemo(() => {
    const bs = bands(SIZE, SIZE, dLevels)
    const ll = bs[0]
    return {
      data: (() => {
        // Show quantized values relative to each band's step so every band reads on the same scale.
        const d = new Float64Array(SIZE * SIZE)
        bs.forEach((b, k) => {
          const st = step / prepared.norms[k]
          for (let y = b.y; y < b.y + b.h; y++)
            for (let x = b.x; x < b.x + b.w; x++) {
              const i = y * SIZE + x
              d[i] = b.orient === 'LL' ? prepared.coefs[i] : Math.sign(wav.coefs[i]) * Math.floor(Math.abs(wav.coefs[i]) / st)
            }
        })
        return d
      })(),
      low: [ll],
      high: bs.slice(1).map((b) => ({ ...b, label: `${b.orient}${b.level}` })),
    }
  }, [dLevels, step, prepared, wav])

  const npx = SIZE * SIZE
  const bpp = lossless ? lossy.bits / npx : wav.bits / npx
  const lensRect = { x: lens.x, y: lens.y, w: LENS_SIZE, h: LENS_SIZE }
  const pick = (x: number, y: number) =>
    setLens({ x: Math.max(0, Math.min(SIZE - LENS_SIZE, Math.round(x - LENS_SIZE / 2))), y: Math.max(0, Math.min(SIZE - LENS_SIZE, Math.round(y - LENS_SIZE / 2))) })

  const wavShown = lossless ? lossy.back : showError ? errorImage(img, wav.recon) : wav.recon
  const dctShown = showError ? errorImage(img, dct.recon) : dct.recon
  const gain = Number.isFinite(wav.psnr) && Number.isFinite(dct.psnr) ? wav.psnr - dct.psnr : NaN

  // Bits by level, coarse to fine.
  const bitRows = useMemo(() => {
    const bs = bands(SIZE, SIZE, dLevels)
    const per = lossless ? lossy.perBand : wav.bandBits
    const rows: { label: string; value: number; note?: string }[] = [{ label: `LL${dLevels}`, value: per[0], note: `${bs[0].w}×${bs[0].h} coarse picture` }]
    for (let l = dLevels; l >= 1; l--) {
      let v = 0
      let n = 0
      bs.forEach((b, k) => {
        if (b.level === l && b.orient !== 'LL') {
          v += per[k]
          n += b.w * b.h
        }
      })
      rows.push({ label: `level ${l} detail`, value: v, note: `${n.toLocaleString('en-US')} coefficients` })
    }
    return rows
  }, [dLevels, lossless, lossy, wav])

  return (
    <div ref={pageRef}>
      <Page
        slug="wavelet"
        lede={
          <p>
            JPEG cuts the picture into 8×8 tiles and describes each one with cosines. A wavelet transform never cuts anything. It splits the whole
            image into a <b>half-size copy</b> and the <b>details</b> you would need to sharpen it back, then does the same to the copy, and again.
            On a photograph almost all the details are close to zero, and when you throw the small ones away the picture goes soft instead of
            blocky. With integer arithmetic it can also give every pixel back exactly — that is JPEG 2000.
          </p>
        }
      >
        <Bench
          side={
            <>
              <Group title="Image">
                <Segmented
                  value={preset === 'upload' && !upload ? 'sphere' : preset}
                  onChange={(p) => pickPreset(p as Preset)}
                  options={[
                    { value: 'sphere', label: 'Sphere' },
                    { value: 'text', label: 'Text' },
                    { value: 'zone', label: 'Zone plate' },
                    { value: 'noise', label: 'Noise' },
                  ]}
                />
                <label className={'btn btn-ghost wv-upload' + (preset === 'upload' ? ' on' : '')}>
                  {preset === 'upload' ? 'Your image (choose another…)' : 'Upload your own…'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      try {
                        setUpload(await loadUpload(f))
                        pickPreset('upload')
                      } catch {
                        /* not an image the browser can decode */
                      }
                    }}
                  />
                </label>
                <p className="small muted">Greyscale, 256 × 256. Click any image below to move the zoom lens.</p>
              </Group>
              <Group title="Step through">
                <Segmented
                  value={stepMode}
                  onChange={setStepMode}
                  options={[
                    { value: 'row', label: 'One row, by hand' },
                    { value: 'levels', label: 'Whole image' },
                  ]}
                />
                {stepMode === 'row' && (
                  <>
                    <Segmented
                      label="Transform"
                      value={rowKind}
                      onChange={setRowKind}
                      options={[
                        { value: 'haar', label: 'Haar' },
                        { value: 'cdf53', label: '5/3 lifting' },
                      ]}
                      help="Haar: averages and differences of pairs — the simplest wavelet there is. 5/3: JPEG 2000's reversible transform, built from two integer lifting steps."
                    />
                    <Segmented
                      label="Row"
                      value={rowSource}
                      onChange={setRowSource}
                      options={[
                        { value: 'image', label: 'From image' },
                        { value: 'ramp', label: 'Ramp' },
                        { value: 'edge', label: 'Edge' },
                        { value: 'flat', label: 'Flat' },
                      ]}
                    />
                  </>
                )}
                {stepMode === 'levels' && <p className="small muted">Each step is one pass: all the rows of the current low-pass region, then all its columns.</p>}
              </Group>
              <Group title="Transform">
                <Segmented
                  value={lossless ? 'cdf53' : kind}
                  onChange={(k) => {
                    setKind(k)
                    if (k !== 'cdf53') setLossless(false)
                  }}
                  options={[
                    { value: 'haar', label: 'Haar' },
                    { value: 'cdf53', label: 'CDF 5/3' },
                    { value: 'cdf97', label: 'CDF 9/7' },
                  ]}
                  help="Haar (1909): averages of pairs, blocky. CDF 5/3: JPEG 2000's lossless transform, predicts each odd sample by a straight line. CDF 9/7: JPEG 2000's lossy transform, smoother and better at compressing photographs."
                />
                <Slider label="levels" value={levels} min={1} max={5} onChange={setLevels} help="How many times the low-pass quarter is split again. Five levels leave an 8×8 thumbnail and put everything else into detail bands." />
              </Group>
              <Group title="Compress">
                <Segmented
                  value={lossless ? 'lossless' : 'lossy'}
                  onChange={(v) => setLossless(v === 'lossless')}
                  options={[
                    { value: 'lossy', label: 'Lossy' },
                    { value: 'lossless', label: 'Lossless (5/3 integer)' },
                  ]}
                />
                <Slider
                  label="quantizer step Δ"
                  value={stepT}
                  min={0}
                  max={100}
                  step={1}
                  disabled={lossless}
                  onChange={setStepT}
                  display={fmt(stepOf(stepT), stepOf(stepT) < 10 ? 1 : 0)}
                  help="Every coefficient is divided by Δ (scaled per band by how much that band's basis functions weigh) and rounded toward zero. Bigger Δ: more zeros, fewer bits, more error. This is the only lossy step."
                />
                <Toggle label="Show error ×8" value={showError} onChange={setShowError} help="Mid-grey means exact. Lighter or darker is the reconstruction's error, amplified eight times." />
              </Group>
              <Group title="Result">
                <Stats>
                  <Stat label="bits / pixel" value={fmt(bpp, 2)} tone="accent" help="Estimated: the order-0 entropy of each band's quantized values, each band its own context. JPEG 2000's EBCOT coder does better than this, so it is a fair upper bound." />
                  <Stat label="PSNR" value={lossless ? '∞' : fmt(wav.psnr, 1)} sub={lossless ? `max error ${lossy.maxErr}` : 'dB'} help="Peak signal-to-noise ratio: 10·log₁₀(255² / mean squared error). Above ~40 dB is hard to tell apart by eye." />
                  <Stat label="ratio" value={`${fmt(8 / Math.max(bpp, 1e-9), 1)}:1`} sub="vs 8 bits/pixel" />
                  {lossless ? (
                    <Stat label="DEFLATE, raw" value={fmt((deflateBytes * 8) / npx, 2)} sub="bits/pixel, real" help="This site's DEFLATE run directly on the 65 536 pixel bytes — what you would get by zipping the raw image." />
                  ) : (
                    <Stat
                      label="vs DCT, same bits"
                      value={Number.isFinite(gain) ? `${gain >= 0 ? '+' : '−'}${fmt(Math.abs(gain), 1)}` : '—'}
                      sub="dB"
                      tone={gain >= 0 ? 'good' : 'bad'}
                      help="PSNR of the wavelet minus PSNR of an 8×8 DCT given the same estimated number of bits (same quantizer, same estimate)."
                    />
                  )}
                </Stats>
              </Group>
            </>
          }
        >
          {stepMode === 'row' ? (
            rowKind === 'haar' ? (
              <HaarStage steps={haarTrace} index={s.index} />
            ) : (
              <LiftStage steps={liftTrace} index={s.index} original={row} />
            )
          ) : (
            <LevelsStage passes={passes} index={s.index} pal={pal} kind={passKind} lossless={lossless} />
          )}
          <Transport s={s} label={(i) => (stepMode === 'levels' ? `pass ${i} / ${count - 1}` : `step ${i} / ${count - 1}`)} />

          <Panel title={lossless ? 'Lossless: every pixel back' : `Compress the whole image — ${KIND_NAME[dKind]}, ${dLevels} level${dLevels > 1 ? 's' : ''}`} aside={lossless ? '5/3 integer lifting' : `Δ = ${fmt(step, step < 10 ? 1 : 0)}`}>
            <div className={'wv-panes' + (lossless ? ' three' : '')}>
              <Pane title="Original" sub="8 bits / pixel" size={SIZE} onPick={pick} mark={lensRect}>
                <GreyCanvas data={img} w={SIZE} h={SIZE} />
              </Pane>
              <Pane
                title={lossless ? 'Rebuilt from integer coefficients' : showError ? 'Wavelet error ×8' : 'Wavelet'}
                sub={lossless ? `max error ${lossy.maxErr} · ${fmt(bpp, 2)} bpp` : `${fmt(wav.psnr, 1)} dB · ${fmt(bpp, 3)} bpp`}
                size={SIZE}
                onPick={pick}
                mark={lensRect}
              >
                <GreyCanvas data={wavShown} w={SIZE} h={SIZE} />
              </Pane>
              {lossless ? (
                <Pane title="Integer coefficients" sub="every one kept, exactly" size={SIZE}>
                  <Mosaic state={passes[passes.length - 1]} w={SIZE} h={SIZE} pal={pal} labels={false} />
                </Pane>
              ) : (
                <Pane title={showError ? '8×8 DCT error ×8' : '8×8 DCT, same bits'} sub={`${fmt(dct.psnr, 1)} dB · ${fmt(dct.bits / npx, 3)} bpp`} size={SIZE} onPick={pick} mark={lensRect}>
                  <GreyCanvas data={dctShown} w={SIZE} h={SIZE} />
                </Pane>
              )}
              {!lossless && (
                <Pane title="Coefficients kept" sub={`${((100 * wav.nonzero) / npx).toFixed(1)}% non-zero`} size={SIZE}>
                  <Mosaic state={keptState} w={SIZE} h={SIZE} pal={pal} labels={false} fixedScale={3} />
                </Pane>
              )}
            </div>
            {!lossless && (
              <>
                <div className="wv-lens-head">
                  <span>Zoom ×4 on the square</span>
                  <span className="muted">click any picture above to move it</span>
                </div>
                <div className="wv-panes three">
                  <Pane title="Original" size={LENS_SIZE}>
                    <GreyCanvas data={crop(img, lens.x, lens.y, LENS_SIZE)} w={LENS_SIZE} h={LENS_SIZE} />
                  </Pane>
                  <Pane title={KIND_NAME[dKind]} sub="blur and soft ringing" size={LENS_SIZE}>
                    <GreyCanvas data={crop(wavShown, lens.x, lens.y, LENS_SIZE)} w={LENS_SIZE} h={LENS_SIZE} />
                  </Pane>
                  <Pane title="8×8 DCT" sub="blocks, ringing inside each" size={LENS_SIZE}>
                    <GreyCanvas data={crop(dctShown, lens.x, lens.y, LENS_SIZE)} w={LENS_SIZE} h={LENS_SIZE} />
                  </Pane>
                </div>
              </>
            )}
          </Panel>

          <Narration tone={lossless ? 'done' : undefined}>
            {lossless ? (
              <>
                The integer 5/3 transform rounds at every lifting step and still gives back every one of the {npx.toLocaleString('en-US')} pixels:
                maximum error <b>{lossy.maxErr}</b>. Coded band by band it needs about <b>{fmt(bpp, 2)}</b> bits per pixel, against{' '}
                {fmt((deflateBytes * 8) / npx, 2)} for DEFLATE on the raw bytes — prediction from neighbours beats searching for repeats on a
                photograph.
              </>
            ) : Number.isFinite(gain) ? (
              <>
                At {fmt(bpp, 3)} bits per pixel ({fmt(8 / bpp, 0)}:1) the wavelet scores <b>{fmt(wav.psnr, 1)} dB</b>; the 8×8 DCT, given the same
                bits, <b>{fmt(dct.psnr, 1)} dB</b>.{' '}
                {gain > 0.5
                  ? 'The wavelet wins: its smooth basis functions overlap, so nothing can disagree at a block boundary.'
                  : gain < -0.5
                    ? 'The DCT wins here — on a pattern made of waves, cosines are simply the right building blocks.'
                    : 'A draw: on this picture the choice of transform barely matters.'}{' '}
                {wav.nonzero < npx * 0.1 && `Only ${((100 * wav.nonzero) / npx).toFixed(1)}% of the wavelet coefficients survived quantization.`}
              </>
            ) : (
              <>Nothing was lost at this step size.</>
            )}
          </Narration>

          {!lossless && (
            <Panel title="Rate against distortion" aside="same quantizer, same size estimate — only the transform differs">
              <RdChart wavelet={rd.wavelet} dct={rd.dct} current={{ bpp: wav.bits / npx, wav: wav.psnr, dct: dct.psnr }} waveletLabel={`${KIND_NAME[dKind]}, ${dLevels} levels`} />
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                Higher is better.{' '}
                {gain > 0.5
                  ? 'The gap is widest at low rates, where the DCT’s blocks show; at high rates both transforms just describe the image and the curves converge.'
                  : gain < -0.5
                    ? 'Here the dashed DCT line is on top: this picture is made of waves, and waves are exactly what cosines describe.'
                    : 'The curves nearly overlap: on this picture the choice of transform barely matters.'}
              </p>
            </Panel>
          )}

          <Panel title="Where the bits go" aside={lossless ? 'exact integer coefficients' : `quantized at Δ = ${fmt(step, step < 10 ? 1 : 0)}`}>
            <SizeBars rows={bitRows} />
            <p className="small muted" style={{ margin: '10px 0 0' }}>
              {(() => {
                const total = bitRows.reduce((a, r) => a + r.value, 0) || 1
                const llShare = (100 * bitRows[0].value) / total
                const fine = (100 * bitRows[bitRows.length - 1].value) / total
                const llCoefs = (100 * (SIZE >> dLevels) ** 2) / npx
                return lossless
                  ? `Lossless has to keep everything, sensor grain included: the finest details are three quarters of the coefficients and ${fine.toFixed(0)}% of the bits. Noise cannot be predicted, so it cannot be squeezed.`
                  : `LL${dLevels} is ${llCoefs < 1 ? llCoefs.toFixed(1) : llCoefs.toFixed(0)}% of the coefficients and ${llShare.toFixed(0)}% of the bits — it is the only band that is not mostly zero. The finest details are three quarters of the coefficients and ${fine.toFixed(0)}% of the bits.`
              })()}
            </p>
          </Panel>
        </Bench>

        <Notes>
          <h2>One step of the transform</h2>
          <p>
            A wavelet transform is a pair of filters applied to every row and then every column: a <b>low-pass</b> one that keeps a smoothed,
            half-length version of the signal, and a <b>high-pass</b> one that keeps what the smoothing lost. Each output is half the length of
            the input, so nothing grows. Apply it to the rows and columns of an image and you get four quarter-size bands: LL (a thumbnail), HL
            (vertical edges), LH (horizontal edges) and HH (diagonals). Then do it again to LL. This recursive layout is Stéphane Mallat’s
            multiresolution analysis (1989), and the picture above is that layout.
          </p>
          <h2>Haar, 1909</h2>
          <p>
            Alfréd Haar’s function — +1 then −1 — is the oldest wavelet. On a pair of pixels it is just the average and the difference. It is
            orthogonal and dead simple, but its basis functions are little steps, so throwing coefficients away leaves a blocky picture, the same
            sin as JPEG with smaller blocks.
          </p>
          <h2>Lifting: how JPEG 2000 does it in integers</h2>
          <Code>{`predict:  d[n] = x[2n+1] − ⌊(x[2n] + x[2n+2]) / 2⌋        odd samples become prediction errors
update:   s[n] = x[2n]   + ⌊(d[n−1] + d[n] + 2) / 4⌋     even samples keep the local average
inverse:  run the same two lines backwards with the signs flipped`}</Code>
          <p>
            Wim Sweldens’ <b>lifting scheme</b> (1996) factors any wavelet into steps like these, each of which changes one half of the samples by
            a function of the <i>other</i> half. Undoing a step means subtracting exactly what was added — and that stays true even when the
            added amount is rounded to an integer, because the decoder computes the same rounding from the same untouched samples. That is the
            whole trick behind JPEG 2000’s reversible LeGall–Tabatabai / CDF <b>5/3</b> transform (ITU T.800 Annex F). The predictor is a straight
            line through two neighbours, so a ramp produces zero detail; the edges use mirror extension, x[−1] = x[1], so a finite row needs no
            padding.
          </p>
          <h2>CDF 9/7 and smoothness</h2>
          <p>
            Ingrid Daubechies’ 1988 construction of compactly supported wavelets, and the Cohen–Daubechies–Feauveau biorthogonal family that
            followed in 1992, gave filters with smooth basis functions. The <b>9/7</b> member (four lifting steps and a scale) is JPEG 2000’s
            irreversible transform: its basis functions look like soft bumps, so quantization error looks like gentle blur rather than tiles. It is
            not quite orthogonal, which is why the quantizer here scales each band’s step by the norm of that band’s basis functions — JPEG 2000
            does the same.
          </p>
          <h2>Coding the bands: EBCOT</h2>
          <p>
            JPEG 2000 does not entropy-code coefficients one at a time. EBCOT (David Taubman, 2000) cuts each band into code-blocks and codes them
            <b> bit-plane by bit-plane</b>, most significant first, with a context-adaptive binary arithmetic coder (the MQ-coder). Because the
            stream is ordered by importance, truncating it anywhere gives a lower-quality image — one file serves every bit rate and resolution.
            This page estimates sizes with plain per-band order-0 entropy instead, and says so; EBCOT would do better, for both transforms.
          </p>
          <h2>Where it won, and where it did not</h2>
          <ul>
            <li>
              <b>Digital cinema.</b> Every DCI cinema package is JPEG 2000 at up to 250 Mbit/s, each frame intra-coded so editing and
              distribution are simple.
            </li>
            <li>
              <b>Medical and archival imaging.</b> DICOM supports it, partly because the same file holds a lossless original and any lossy preview.
              PDF can embed it (JPXDecode).
            </li>
            <li>
              <b>Fingerprints.</b> The FBI’s WSQ standard (1993) is a wavelet codec; so are the Dirac/VC-2 broadcast codecs and the ECW and MrSID
              formats for huge aerial maps.
            </li>
            <li>
              <b>The web, never.</b> JPEG 2000 was slower to decode, its tooling was patchy, patent worries lingered, and only Safari ever shipped
              it. Good-enough JPEG was everywhere already. The modern successors — WebP, AVIF, JPEG XL — went back to block transforms with
              prediction and in-loop deblocking filters.
            </li>
          </ul>
          <div className="aside">
            On the zone plate the DCT beats the wavelet: a chirp is literally made of cosines, and an 8×8 cosine basis matches it better than
            localized bumps do. Transforms are bets about what images look like, and photographs — smooth regions separated by edges — are the bet
            wavelets were built for.
          </div>
        </Notes>
      </Page>
    </div>
  )
}

// ----------------------------------------------------------------- stages

function HaarStage({ steps, index }: { steps: ReturnType<typeof traceHaar>; index: number }) {
  const st = steps[Math.min(index, steps.length - 1)]
  const n = st.y.length
  const max = Math.max(1, ...steps[0].y.map(Math.abs))
  const half = st.span >> 1
  const srcBars: Bar[] = st.src.map((v, i) => ({
    v,
    kind: i < st.span ? 'plain' : 'detail',
    hot: st.pair >= 0 && (i === 2 * st.pair || i === 2 * st.pair + 1) ? 'src' : undefined,
    label: i < st.span ? (st.level <= 1 ? `x${i}` : `s${i}`) : undefined,
  }))
  const outBars: Bar[] = st.y.map((v, i) => {
    if (st.pair < 0) return { v, kind: 'plain', label: `x${i}` }
    if (i >= st.span) return { v, kind: 'detail' }
    if (!st.filled[i]) return { v: NaN, kind: 'ghost' }
    const isLow = i < half
    return { v, kind: isLow ? 'low' : 'detail', hot: i === st.pair || i === half + st.pair ? 'dst' : undefined, label: isLow ? 'avg' : 'diff' }
  })
  const a = st.pair >= 0 ? st.src[2 * st.pair] : 0
  const b = st.pair >= 0 ? st.src[2 * st.pair + 1] : 0
  const done = index === steps.length - 1 && steps.length > 1
  let zeros = 0
  if (done) for (let i = 1; i < n; i++) if (Math.abs(st.y[i]) < 1) zeros++
  return (
    <>
      <Panel title={st.pair < 0 ? 'A row of pixels' : `Haar, level ${st.level}`} aside={st.pair < 0 ? '16 samples' : `pair ${st.pair + 1} of ${half}`}>
        {st.pair >= 0 && <Bars bars={srcBars} max={max} title={`this level’s input (${st.span} samples${st.span < n ? ', then earlier details' : ''})`} split={st.span < n ? st.span : undefined} />}
        <Bars bars={outBars} max={max} title={st.pair < 0 ? 'input' : 'output: averages | half-differences'} split={st.pair >= 0 ? half : undefined} />
        <div className="legend">
          <span>
            <i style={{ background: 'var(--accent)' }} /> average (low band)
          </span>
          <span>
            <i style={{ background: 'var(--hl-4)' }} /> + detail
          </span>
          <span>
            <i style={{ background: 'var(--hl-2)' }} /> − detail
          </span>
        </div>
      </Panel>
      <Narration tone={done ? 'done' : undefined}>
        {st.pair < 0 ? (
          <>Sixteen samples on one scale. Haar looks at them two at a time and keeps the average and the half-difference — nothing more.</>
        ) : done ? (
          <>
            Done. One number is left in the low band — <b>{fmtNum(st.y[0])}</b>, the mean of the whole row — and fifteen details, coarsest first.{' '}
            {zeros} of them are below 1. Nothing was lost: each pair comes back as a = s + d, b = s − d.
          </>
        ) : (
          <>
            Level {st.level}: ({fmtNum(a)}, {fmtNum(b)}) → average <b>{fmtNum((a + b) / 2)}</b> into the low half, half-difference{' '}
            <b>{fmtNum((a - b) / 2)}</b> into the detail half.
            {st.pair === half - 1 && half > 1 && <> The low half is a half-length copy of the row; the next level does the same to it.</>}
          </>
        )}
      </Narration>
    </>
  )
}

function LiftStage({ steps, index, original }: { steps: ReturnType<typeof trace53>; index: number; original: number[] }) {
  const st = steps[Math.min(index, steps.length - 1)]
  const n = original.length
  const max = Math.max(1, ...original.map(Math.abs))
  const split = st.phase === 'split'
  const after = st.phase === 'undo-update' || st.phase === 'undo-predict'
  // After 'split' the array is [s | d]; before it, interleaved.
  const bars: Bar[] = st.y.map((v, i) => {
    if (split) return { v, kind: i < Math.ceil(n / 2) ? 'low' : 'detail', label: i < Math.ceil(n / 2) ? `s${i}` : `d${i - Math.ceil(n / 2)}` }
    if (st.phase === 'start' || after) return { v, kind: 'plain', label: `x${i}` }
    const P = steps.filter((p) => p.phase === 'predict').length
    const predicted = i & 1 ? st.phase === 'update' || (i - 1) / 2 + 1 <= index : false
    const updated = !(i & 1) && st.phase === 'update' && i / 2 + 1 + P <= index
    const kind: Bar['kind'] = predicted ? 'detail' : updated ? 'low' : 'plain'
    const hot = i === st.at ? 'dst' : st.from.includes(i) ? 'src' : undefined
    return { v, kind, hot, label: i & 1 ? `d${(i - 1) / 2}` : predicted || updated ? `s${i / 2}` : `x${i}` }
  })

  const cells: ReactNode[] = []
  for (let i = 0; i < n; i++) {
    const cls = i === st.at ? 'dst' : st.from.includes(i) ? 'src' : ''
    cells.push(
      <span key={i} className={'wv-cell ' + (i & 1 ? 'odd ' : 'even ') + cls}>
        <small>{i & 1 ? 'odd' : 'even'}</small>
        {fmtNum(st.y[i])}
      </span>,
    )
  }

  let text: ReactNode
  const L = st.from[0]
  const R = st.from[1]
  const prev = index > 0 ? steps[index - 1].y : st.y
  if (st.phase === 'start') text = <>Sixteen integers. The 5/3 transform will rewrite the odd ones as prediction errors, then nudge the even ones, in place.</>
  else if (st.phase === 'predict') {
    const ghost = st.ghost.length ? <> x{st.ghost[0]} is past the end, so it mirrors x{R}.</> : null
    text = (
      <>
        <b>Predict</b> x{st.at} as the midpoint of its neighbours: d{(st.at - 1) / 2} = {fmtNum(st.before)} − ⌊({fmtNum(prev[L])} + {fmtNum(prev[R])}) / 2⌋ ={' '}
        <b>{fmtNum(st.y[st.at])}</b>.{ghost} {st.y[st.at] === 0 ? 'The straight line was exactly right.' : 'Only the miss is kept.'}
      </>
    )
  } else if (st.phase === 'update') {
    const ghost = st.ghost.length ? <> (d{st.ghost[0] < 0 ? '−1' : (st.ghost[0] - 1) / 2} is off the end, so the neighbour on the other side is used twice.)</> : null
    text = (
      <>
        <b>Update</b> x{st.at} with the details either side: s{st.at / 2} = {fmtNum(st.before)} + ⌊({fmtNum(prev[L])} + {fmtNum(prev[R])} + 2) / 4⌋ = {fmtNum(st.before)} +{' '}
        {fmtNum(st.delta)} = <b>{fmtNum(st.y[st.at])}</b>.{ghost} This keeps the low band an average rather than a sub-sample, so it does not alias.
      </>
    )
  } else if (split) {
    const d = st.y.slice(Math.ceil(n / 2))
    const z = d.filter((v) => v === 0).length
    text = (
      <>
        Gather the evens into the <b>low band</b> s (a half-length copy of the row) and the odds into the <b>details</b> d. {z} of {d.length} details
        are exactly 0, and the largest is {fmtNum(Math.max(...d.map(Math.abs)))}. The next level would repeat this on s.
      </>
    )
  } else if (st.phase === 'undo-update')
    text = (
      <>
        <b>Inverse, step 1:</b> subtract ⌊(d + d + 2) / 4⌋ from every even sample. The odd samples have not changed, so this is exactly the amount
        that was added — rounding and all.
      </>
    )
  else {
    const same = st.y.every((v, i) => v === original[i])
    text = (
      <>
        <b>Inverse, step 2:</b> add ⌊(x + x) / 2⌋ back to every odd sample. {same ? `All ${n} integers are back exactly.` : 'Mismatch — this should not happen.'}{' '}
        Rounding at every step and nothing lost: that is lifting.
      </>
    )
  }

  return (
    <>
      <Panel title="5/3 lifting, one row" aside={st.phase === 'start' ? 'interleaved: even | odd' : split ? 'split: s | d' : after ? 'inverse' : st.phase}>
        {!split && <div className="wv-cells scroll-x">{cells}</div>}
        <Bars bars={bars} max={max} split={split ? Math.ceil(n / 2) : undefined} />
        <div className="legend">
          <span>
            <i style={{ background: 'var(--accent)' }} /> low band s
          </span>
          <span>
            <i style={{ background: 'var(--hl-4)' }} /> detail d ≥ 0
          </span>
          <span>
            <i style={{ background: 'var(--hl-2)' }} /> detail d &lt; 0
          </span>
        </div>
      </Panel>
      <Narration tone={st.phase === 'undo-predict' ? 'done' : undefined}>{text}</Narration>
    </>
  )
}

function LevelsStage({ passes, index, pal, kind, lossless }: { passes: PassState[]; index: number; pal: ReturnType<typeof usePalette>; kind: Kind; lossless: boolean }) {
  const st = passes[Math.min(index, passes.length - 1)]
  const prevLow = index > 0 ? passes[index - 1].low[0] : null
  const hot = st.pass === 'start' ? null : st.pass === 'rows' ? prevLow : { x: 0, y: 0, w: prevLow ? prevLow.w * 2 : SIZE, h: prevLow?.h ?? SIZE }
  // Share of detail coefficients within ±2 (pixel units).
  let small = 0
  let total = 0
  for (const r of st.high)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        total++
        if (Math.abs(st.data[y * SIZE + x]) <= 2) small++
      }
  const low = st.low[0]
  const last = index === passes.length - 1 && passes.length > 1
  let text: ReactNode
  if (st.pass === 'start') text = <>The picture: {SIZE}×{SIZE} pixels, eight bits each. Nothing has been transformed yet.</>
  else if (st.pass === 'rows')
    text = (
      <>
        Level {st.level}, <b>rows</b>: every row of the {prevLow!.w}×{prevLow!.h} region is split by the {KIND_NAME[kind]} filters into {low.w} low-pass
        samples (left: the picture squeezed sideways) and {prevLow!.w - low.w} details (right: what the squeeze lost — bright where vertical edges
        are).
      </>
    )
  else
    text = (
      <>
        Level {st.level}, <b>columns</b>: the same on every column. The top-left {low.w}×{low.h} quarter is now a half-size picture, LL{st.level}; HL{st.level}{' '}
        catches vertical edges, LH{st.level} horizontal ones, HH{st.level} diagonals. {total ? `${((100 * small) / total).toFixed(0)}% of all detail coefficients so far are within ±2.` : ''}
        {last && <> That is the whole transform: {low.w * low.h} numbers carry the shading, and everything else is mostly nothing.</>}
      </>
    )
  return (
    <>
      <Panel title={`Decomposition — ${KIND_NAME[kind]}${lossless ? ', integer' : ''}`} aside={st.pass === 'start' ? 'the input' : `level ${st.level}, ${st.pass}`}>
        <div className="wv-levels">
          <Mosaic state={st} w={SIZE} h={SIZE} pal={pal} hot={hot} />
        </div>
        <div className="legend" style={{ marginTop: 8 }}>
          <span>
            <i style={{ background: 'linear-gradient(90deg, #000, #fff)' }} /> low-pass (stretched to full range)
          </span>
          <span>
            <i style={{ background: 'var(--hl-4)' }} /> + detail
          </span>
          <span>
            <i style={{ background: 'var(--hl-2)' }} /> − detail (each band contrast-stretched)
          </span>
        </div>
      </Panel>
      <Narration tone={last ? 'done' : undefined}>{text}</Narration>
    </>
  )
}
