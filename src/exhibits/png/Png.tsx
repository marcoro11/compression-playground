import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { entropy } from '../../lib/entropy'
import { hex2, int, fmt } from '../../lib/text'
import { useTheme } from '../../lib/theme'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { FILTER_NAMES, FILTERS, histogram, paethDetail, predict, residualPlane, type FilterType, type Strategy } from './filters'
import { H, W, noise, photo, pixel, ui } from './images'
import { writePng } from './pngfile'
import { FILTER_HL, FilterLegend, FilterStripe, Histogram, Pane, RgbCanvas } from './views'
import './png.css'

type Preset = 'photo' | 'ui' | 'pixel' | 'noise' | 'upload'
type Mode = 'pixel' | 'row'

const BPP = 3
const STRIDE = W * BPP
const CHANNELS = ['red', 'green', 'blue'] as const

const DEFAULT_PIXEL: Record<Preset, { x: number; y: number }> = {
  photo: { x: 70, y: 80 },
  ui: { x: 47, y: 77 },
  pixel: { x: 46, y: 58 },
  noise: { x: 64, y: 64 },
  upload: { x: 64, y: 64 },
}

const STRATEGY_LABEL: Record<string, string> = {
  '0': 'None',
  '1': 'Sub',
  '2': 'Up',
  '3': 'Average',
  '4': 'Paeth',
  adaptive: 'Adaptive',
  trial: 'Trial',
}

const STRATEGY_NOTE: Record<string, string> = {
  '0': 'Every row as it is. DEFLATE sees the raw pixels.',
  '1': 'Every row predicts each byte from the pixel to its left.',
  '2': 'Every row predicts each byte from the pixel above.',
  '3': 'Every row predicts the average of left and above.',
  '4': 'Every row uses Paeth: whichever of left, above or up-left is closest to left + above − up-left.',
  adaptive: 'Per row, the filter whose bytes have the smallest sum of |signed value| — what libpng does by default.',
  trial: 'Per row, compress each of the five candidates after the previous row and keep the smallest. Slower; closer to what optipng does.',
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'photo', label: 'Photo' },
  { value: 'ui', label: 'Screenshot' },
  { value: 'pixel', label: 'Pixel art' },
  { value: 'noise', label: 'Noise' },
]

async function loadUpload(file: File): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const s = Math.max(W / bmp.width, H / bmp.height)
  ctx.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s)
  const d = ctx.getImageData(0, 0, W, H).data
  const out = new Uint8Array(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    out[i * 3] = d[i * 4]
    out[i * 3 + 1] = d[i * 4 + 1]
    out[i * 3 + 2] = d[i * 4 + 2]
  }
  return out
}

/** The browser's own PNG encoder on the same pixels (it will store RGBA: a canvas has alpha). */
async function browserPngSize(rgb: Uint8Array): Promise<number | null> {
  try {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(W, H)
    for (let i = 0; i < W * H; i++) {
      img.data[i * 4] = rgb[i * 3]
      img.data[i * 4 + 1] = rgb[i * 3 + 1]
      img.data[i * 4 + 2] = rgb[i * 3 + 2]
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
    return blob ? blob.size : null
  } catch {
    return null
  }
}

/** Browser's zlib on the same filtered bytes, for comparing DEFLATE implementations. */
async function browserZlibSize(data: Uint8Array): Promise<number | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
    return (await new Response(s).arrayBuffer()).byteLength
  } catch {
    return null
  }
}

const signed = (v: number) => (v < 128 ? v : v - 256)
const sgn = (v: number) => (v > 0 ? '+' + v : v < 0 ? '−' + -v : '0')

export function Png() {
  const [preset, setPreset] = useState<Preset>('photo')
  const [upload, setUpload] = useState<Uint8Array | null>(null)
  const [strategy, setStrategy] = useState<Strategy>('adaptive')
  const [mode, setMode] = useState<Mode>('pixel')
  const [channel, setChannel] = useState(1)
  const [sel, setSel] = useState(DEFAULT_PIXEL.photo)
  const [gain, setGain] = useState(true)
  const pageRef = useRef<HTMLDivElement>(null)
  const theme = useTheme(pageRef)

  const img = useMemo(() => {
    if (preset === 'upload' && upload) return upload
    if (preset === 'ui') return ui()
    if (preset === 'pixel') return pixel()
    if (preset === 'noise') return noise()
    return photo()
  }, [preset, upload])

  const file = useMemo(() => writePng(img, W, H, 2, strategy), [img, strategy])
  const filtered = file.filtered
  const residual = useMemo(() => residualPlane(filtered, W, H, BPP), [filtered])
  const residualView = useMemo(() => {
    const out = new Uint8Array(residual.length)
    const g = gain ? 4 : 1
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, 128 + g * signed(residual[i])))
    return out
  }, [residual, gain])
  const rawHist = useMemo(() => histogram(img), [img])
  const resHist = useMemo(() => histogram(residual), [residual])
  const counts = useMemo(() => FILTERS.map((t) => filtered.types.filter((x) => x === t).length), [filtered])

  // The real file as the browser sees it.
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: 'image/png' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  // Every strategy's file size, computed one per tick so the page stays responsive.
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [browser, setBrowser] = useState<{ png: number | null; zlib: number | null }>({ png: null, zlib: null })
  useEffect(() => {
    setSizes({})
    let live = true
    const all: Strategy[] = [0, 1, 2, 3, 4, 'adaptive', 'trial']
    let k = 0
    const next = () => {
      if (!live || k >= all.length) return
      const s = all[k++]
      const n = writePng(img, W, H, 2, s).bytes.length
      setSizes((m) => ({ ...m, [String(s)]: n }))
      setTimeout(next, 0)
    }
    const t = setTimeout(next, 30)
    browserPngSize(img).then((png) => live && setBrowser((b) => ({ ...b, png })))
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [img])
  useEffect(() => {
    let live = true
    browserZlibSize(filtered.data).then((zlib) => live && setBrowser((b) => ({ ...b, zlib })))
    return () => {
      live = false
    }
  }, [filtered])

  const choosePreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'upload') setSel(DEFAULT_PIXEL[p])
  }

  const rowType = filtered.types[sel.y]
  const count = mode === 'pixel' ? PIXEL_STEPS : STRIDE + 1
  const s = useStepper(count, { speed: mode === 'pixel' ? 1 : 12, resetKey: mode + ':' + sel.y + ':' + (mode === 'pixel' ? sel.x + ':' + channel : '') + ':' + preset })

  const rawBytes = W * H * 3
  const H0 = entropy(rawHist)
  const H1 = entropy(resHist)

  return (
    <div ref={pageRef}>
      <Page
        slug="png"
        lede={
          <p>
            PNG never compresses pixels. Each byte is replaced by how far it is from a <b>guess</b> made from the bytes to its left, above and
            above-left — bytes the decoder will already have. On anything smooth the guesses are nearly right, the image turns into a field of
            small numbers, and DEFLATE (the same one as on the <a href="#/deflate">DEFLATE page</a>) does the rest. Everything here builds a real
            .png file your browser decodes.
          </p>
        }
      >
        <Bench
          side={
            <>
              <Group title="Image">
                <Segmented value={preset === 'upload' ? ('photo' as Preset) : preset} onChange={choosePreset} options={PRESETS} />
                <label className={'btn btn-ghost pn-upload' + (preset === 'upload' ? ' on' : '')}>
                  {preset === 'upload' ? 'Your image (128 × 128)' : 'Upload your own…'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      try {
                        setUpload(await loadUpload(f))
                        setPreset('upload')
                        setSel(DEFAULT_PIXEL.upload)
                      } catch {
                        /* unreadable image: keep the current one */
                      }
                    }}
                  />
                </label>
                <p className="small muted">Click any pixel in the pictures to pick the byte the step-through explains.</p>
              </Group>
              <Group title="Filter" help="Which prediction each row uses. The choice is written as one byte at the start of every row, so it can change from row to row.">
                <div className="pn-strategies">
                  <Segmented
                    value={String(strategy)}
                    onChange={(v) => setStrategy(v === 'adaptive' || v === 'trial' ? v : (Number(v) as FilterType))}
                    options={['0', '1', '2', '3', '4', 'adaptive', 'trial'].map((v) => ({ value: v, label: STRATEGY_LABEL[v] }))}
                  />
                </div>
                <p className="small">{STRATEGY_NOTE[String(strategy)]}</p>
              </Group>
              <Group title="Step through">
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'pixel', label: 'One byte, five guesses' },
                    { value: 'row', label: 'A whole row' },
                  ]}
                />
                {mode === 'pixel' && (
                  <Segmented
                    label="channel"
                    value={channel}
                    onChange={setChannel}
                    options={[
                      { value: 0, label: 'R' },
                      { value: 1, label: 'G' },
                      { value: 2, label: 'B' },
                    ]}
                    help="Filters work on bytes, not pixels: red is predicted from the red of the neighbours, green from green."
                  />
                )}
              </Group>
              <Group title="Result">
                <Stats>
                  <Stat label="raw pixels" value={int(rawBytes)} sub="bytes, 3 per pixel" />
                  <Stat label="our .png" value={int(file.bytes.length)} tone="accent" sub={`${fmt((100 * file.bytes.length) / rawBytes, 1)}% of raw`} />
                  <Stat label="bits / pixel" value={fmt((file.bytes.length * 8) / (W * H), 2)} help="Whole file size in bits divided by the number of pixels. Raw RGB is 24." />
                  <Stat
                    label="entropy"
                    value={`${fmt(H0, 2)} → ${fmt(H1, 2)}`}
                    sub="bits/byte, before → after"
                    help="Order-0 entropy of the bytes before filtering and after. Filtering does not remove information — it is perfectly reversible — but it piles the values up near zero, which is something a Huffman code can use."
                  />
                </Stats>
              </Group>
            </>
          }
        >
          <Panel title="Pixels and what is left after the guess" aside={`pixel (${sel.x}, ${sel.y}) · row ${sel.y} uses ${FILTER_NAMES[rowType]}`}>
            <div className="pn-panes">
              <Pane title="Original" sub={`${W} × ${H} RGB`} w={W} h={H} sel={sel} onPick={(x, y) => setSel({ x, y })}>
                <RgbCanvas rgb={img} w={W} h={H} />
              </Pane>
              <Pane
                title="Residuals"
                sub={gain ? 'filtered bytes, signed, ×4 around grey' : 'filtered bytes, signed, around grey'}
                w={W}
                h={H}
                sel={sel}
                onPick={(x, y) => setSel({ x, y })}
                side={<FilterStripe types={filtered.types} colors={theme.hl} sel={sel.y} />}
              >
                <RgbCanvas rgb={residualView} w={W} h={H} />
              </Pane>
              <Pane title="Your browser, decoding our .png" sub={`${int(file.bytes.length)} bytes`} w={W} h={H} sel={sel} onPick={(x, y) => setSel({ x, y })}>
                {url && <img src={url} alt="The PNG file written on this page, decoded by the browser" className="pn-pixelated" />}
              </Pane>
            </div>
            <div className="pn-under">
              <FilterLegend counts={counts} />
              <Toggle label="Amplify residuals ×4" value={gain} onChange={setGain} />
            </div>
          </Panel>

          {mode === 'pixel' ? (
            <PixelStage img={img} sel={sel} channel={channel} step={s.index} rowType={rowType} scores={filtered.scores[sel.y]} strategy={strategy} />
          ) : (
            <RowStage img={img} y={sel.y} t={rowType} step={s.index} strategy={strategy} />
          )}
          <Transport
            s={s}
            label={(i) => (mode === 'pixel' ? `${PIXEL_STEP_NAMES[i]} · ${i + 1} / ${PIXEL_STEPS}` : `byte ${i} / ${STRIDE}`)}
          />

          <Panel title="Byte values, before and after" aside="bar height ∝ √count">
            <div className="pn-hists">
              <Histogram hist={rawHist} tone="var(--line-strong)" label={<>raw pixel bytes · H₀ = {fmt(H0, 2)} bits</>} />
              <Histogram hist={resHist} tone="var(--accent)" label={<>after filtering · H₀ = {fmt(H1, 2)} bits</>} />
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              A residual of −1 is stored as 255, −2 as 254: the pile-up at <i>both</i> ends of the right-hand histogram is one cluster of small
              numbers around zero, wrapped mod 256.
            </p>
          </Panel>

          <Panel title="How big is it" aside="whole files, headers and CRCs included">
            <SizeBars
              unit="bytes"
              rows={[
                { label: 'raw RGB', value: rawBytes, tone: 'faint' },
                ...(['0', '1', '2', '3', '4', 'adaptive', 'trial'] as const).map((k) => ({
                  label: (k === String(strategy) ? '▸ ' : '') + (k === '0' ? 'None (no filter)' : STRATEGY_LABEL[k]),
                  value: sizes[k] ?? 0,
                  tone: k === String(strategy) ? '' : 'ink',
                  note: sizes[k] === undefined ? 'computing…' : undefined,
                })),
                ...(browser.png !== null ? [{ label: 'browser .png', value: browser.png, tone: 'faint', note: 'canvas.toBlob — RGBA, its own choices' }] : []),
              ]}
            />
            {browser.zlib !== null && (
              <p className="small muted" style={{ margin: '10px 0 0' }}>
                Same filtered bytes through your browser’s zlib instead of this site’s DEFLATE: {int(browser.zlib)} bytes vs our {int(file.zlibBytes)}{' '}
                — the filters, not the compressor, make most of the difference.
              </p>
            )}
          </Panel>

          <FilePanel file={file} url={url} />
        </Bench>

        <PngNotes />
      </Page>
    </div>
  )
}

// ------------------------------------------------------------ pixel stage

const PIXEL_STEP_NAMES = ['neighbours', 'None', 'Sub', 'Up', 'Average', 'Paeth', 'which one', 'decode'] as const
const PIXEL_STEPS = PIXEL_STEP_NAMES.length

function neighbours(img: Uint8Array, x: number, y: number, ch: number) {
  const at = (px: number, py: number) => (px < 0 || py < 0 ? 0 : img[(py * W + px) * 3 + ch])
  return { x: at(x, y), a: at(x - 1, y), b: at(x, y - 1), c: at(x - 1, y - 1) }
}

function PixelStage({
  img,
  sel,
  channel,
  step,
  rowType,
  scores,
  strategy,
}: {
  img: Uint8Array
  sel: { x: number; y: number }
  channel: number
  step: number
  rowType: FilterType
  scores: number[]
  strategy: Strategy
}) {
  const n = neighbours(img, sel.x, sel.y, channel)
  const pd = paethDetail(n.a, n.b, n.c)
  const preds = FILTERS.map((t) => predict(t, n.a, n.b, n.c))
  const res = preds.map((p) => (n.x - p) & 0xff)
  const ch = CHANNELS[channel]
  const edge = sel.x === 0 || sel.y === 0
  const formula = ['0', 'a', 'b', '⌊(a + b) / 2⌋', 'Paeth(a, b, c)']
  const best = FILTERS.reduce((m, t) => (Math.abs(signed(res[t])) < Math.abs(signed(res[m])) ? t : m), 0 as FilterType)
  const maxScore = Math.max(1, ...scores)

  let say: ReactNode
  if (step === 0)
    say = (
      <>
        The {ch} byte of pixel ({sel.x}, {sel.y}) is <b>x = {n.x}</b>. When the decoder gets here it already knows the {ch} bytes to the left (
        <b>a = {n.a}</b>), above (<b>b = {n.b}</b>) and above-left (<b>c = {n.c}</b>)
        {edge ? ' — anything off the edge of the image counts as 0' : ''}. Every filter is a guess at x from those three.
      </>
    )
  else if (step >= 1 && step <= 4) {
    const t = (step - 1) as FilterType
    const msgs = [
      <>None guesses 0, so the residual is x itself: {n.x}. This is what DEFLATE would see without filtering.</>,
      <>
        Sub guesses the left neighbour: {n.x} − {n.a} = {sgn(n.x - n.a)}, stored as {res[1]}. Good on anything that changes slowly across a row.
      </>,
      <>
        Up guesses the byte above: {n.x} − {n.b} = {sgn(n.x - n.b)}, stored as {res[2]}. Good on vertical structure — and free on a row that
        repeats the one above.
      </>,
      <>
        Average guesses ⌊({n.a} + {n.b}) / 2⌋ = {preds[3]}: residual {sgn(signed(res[3]))}, stored as {res[3]}. Halfway between Sub and Up, so it
        is rarely terrible.
      </>,
    ]
    say = msgs[t]
  } else if (step === 5)
    say = (
      <>
        Paeth computes p = a + b − c = {n.a} + {n.b} − {n.c} = <b>{pd.p}</b> — what x would be if the image were a flat plane through a, b and c
        — then picks whichever neighbour is closest to it: |p − a| = {pd.pa}, |p − b| = {pd.pb}, |p − c| = {pd.pc}. <b>{pd.pick}</b> wins
        {pd.pick === 'a' && (pd.pa === pd.pb || pd.pa === pd.pc) ? ' (ties go to a, then b)' : pd.pick === 'b' && pd.pb === pd.pc ? ' (ties go to b over c)' : ''}, so
        the guess is {pd.value} and the residual {sgn(signed(res[4]))}.
      </>
    )
  else if (step === 6)
    say = (
      <>
        For this byte alone, <b>{FILTER_NAMES[best]}</b> guessed best. But the choice is made once per <i>row</i>: {typeof strategy === 'number' ? (
          <>
            you fixed every row to {FILTER_NAMES[strategy]}.
          </>
        ) : strategy === 'adaptive' ? (
          <>
            libpng’s heuristic summed |residual| over all {STRIDE} bytes of row {sel.y} for each filter and took the smallest:{' '}
            <b>{FILTER_NAMES[rowType]}</b>.
          </>
        ) : (
          <>
            trial compression kept <b>{FILTER_NAMES[rowType]}</b> for row {sel.y}.
          </>
        )}
      </>
    )
  else
    say = (
      <>
        Decoding runs the same guess in reverse. The decoder reads the row’s type byte ({rowType}, {FILTER_NAMES[rowType]}), rebuilds the
        prediction from a, b and c it has already decoded ({preds[rowType]}), and adds the stored byte: ({res[rowType]} + {preds[rowType]}) mod 256
        = <b>{(res[rowType] + preds[rowType]) & 0xff}</b> = x. Nothing was lost.
      </>
    )

  return (
    <>
      <Panel title={`One byte, five guesses — ${ch} of pixel (${sel.x}, ${sel.y})`}>
        <div className="pn-pixel">
          <Magnifier img={img} sel={sel} channel={channel} />
          <div className="table-wrap pn-guess">
            <table className="data">
              <thead>
                <tr>
                  <th>filter</th>
                  <th>guess</th>
                  <th className="num">=</th>
                  <th className="num">x − guess</th>
                  <th className="num">
                    stored <Help text="The residual modulo 256, as the byte that goes into the zlib stream. Small negative numbers become bytes near 255." />
                  </th>
                  <th style={{ width: '30%' }}>
                    row score <Help text="Sum of |signed residual| over the whole row for each filter — the libpng heuristic. Smaller is better." />
                  </th>
                </tr>
              </thead>
              <tbody>
                {FILTERS.map((t) => {
                  const shown = step > t || step >= 6
                  const on = step === t + 1 || (step >= 6 && t === rowType)
                  return (
                    <tr key={t} className={on ? 'on' : ''} style={{ opacity: shown ? 1 : 0.3 }}>
                      <td>
                        <span className={'pn-chip ' + FILTER_HL[t]}>
                          {t} {FILTER_NAMES[t]}
                        </span>
                      </td>
                      <td>{formula[t]}</td>
                      <td className="num">{shown ? preds[t] : '…'}</td>
                      <td className="num">{shown ? sgn(signed(res[t])) : '…'}</td>
                      <td className="num">{shown ? res[t] : '…'}</td>
                      <td>
                        {step >= 6 ? (
                          <span className="pn-score">
                            <span className={FILTER_HL[t]} style={{ width: `${(100 * scores[t]) / maxScore}%` }} />
                            <em>{int(scores[t])}</em>
                          </span>
                        ) : (
                          <span className="muted">…</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {step >= 5 && (
              <div className="pn-paeth mono small">
                p = {n.a} + {n.b} − {n.c} = {pd.p} · |p−a| = {pd.pa} · |p−b| = {pd.pb} · |p−c| = {pd.pc} → <b>{pd.pick}</b> = {pd.value}
              </div>
            )}
          </div>
        </div>
      </Panel>
      <Narration tone={step === PIXEL_STEPS - 1 ? 'done' : undefined}>{say}</Narration>
    </>
  )
}

/** 5 × 5 pixels around the selection, zoomed, with the channel value written in each and a, b, c, x labelled. */
function Magnifier({ img, sel, channel }: { img: Uint8Array; sel: { x: number; y: number }; channel: number }) {
  const cells: ReactNode[] = []
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = sel.x + dx
      const y = sel.y + dy
      const inside = x >= 0 && y >= 0 && x < W && y < H
      const i = (y * W + x) * 3
      const rgb = inside ? `rgb(${img[i]},${img[i + 1]},${img[i + 2]})` : 'transparent'
      const v = inside ? img[i + channel] : 0
      const role = dx === 0 && dy === 0 ? 'x' : dx === -1 && dy === 0 ? 'a' : dx === 0 && dy === -1 ? 'b' : dx === -1 && dy === -1 ? 'c' : ''
      const future = dy > 0 || (dy === 0 && dx > 0)
      const lum = inside ? 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2] : 255
      cells.push(
        <div key={dx + ':' + dy} className={'pn-mag-cell' + (role ? ' role role-' + role : '') + (future ? ' future' : '') + (inside ? '' : ' outside')} style={{ background: rgb }}>
          <span style={{ color: lum > 140 ? '#1b1a17' : '#fbf7ea' }}>{inside ? v : 0}</span>
          {role && <b>{role}</b>}
        </div>,
      )
    }
  return (
    <figure className="pn-mag">
      <div className="pn-mag-grid">{cells}</div>
      <figcaption>
        {CHANNELS[channel]} values · faded = not decoded yet
      </figcaption>
    </figure>
  )
}

// -------------------------------------------------------------- row stage

function RowStage({ img, y, t, step, strategy }: { img: Uint8Array; y: number; t: FilterType; step: number; strategy: Strategy }) {
  const cur = img.subarray(y * STRIDE, (y + 1) * STRIDE)
  const prev = y > 0 ? img.subarray((y - 1) * STRIDE, y * STRIDE) : null
  // Bytes 0 … step−1 are done; step is the one being worked on.
  const i = Math.min(step, STRIDE) - 1
  const WIN = 9
  const center = Math.max(0, i)
  const from = Math.max(0, Math.min(STRIDE - (2 * WIN + 1), center - WIN))
  const to = Math.min(STRIDE, from + 2 * WIN + 1)
  const idx = Array.from({ length: to - from }, (_, k) => from + k)
  const out = useMemo(() => {
    const o = new Uint8Array(STRIDE)
    for (let k = 0; k < STRIDE; k++) {
      const a = k >= BPP ? cur[k - BPP] : 0
      const b = prev ? prev[k] : 0
      const c = prev && k >= BPP ? prev[k - BPP] : 0
      o[k] = (cur[k] - predict(t, a, b, c)) & 0xff
    }
    return o
  }, [cur, prev, t])
  const role = (k: number, row: 'up' | 'cur') => {
    if (i < 0) return ''
    if (row === 'cur' && k === i) return 'cur hl-1'
    if (row === 'cur' && k === i - BPP) return 'hl-4'
    if (row === 'up' && k === i) return 'hl-4'
    if (row === 'up' && k === i - BPP) return 'hl-4'
    return ''
  }
  const label = (k: number) => `${'RGB'[k % 3]}${Math.floor(k / 3)}`
  const sumAbs = useMemo(() => {
    let s = 0
    for (let k = 0; k < Math.max(0, step); k++) s += Math.abs(signed(out[k]))
    return s
  }, [out, step])

  let say: ReactNode
  if (step === 0)
    say = (
      <>
        Row {y} is {STRIDE} bytes ({W} pixels × R, G, B) and uses <b>{FILTER_NAMES[t]}</b>
        {typeof strategy === 'number' ? ' because you fixed it' : strategy === 'adaptive' ? ', the adaptive pick' : ', the trial pick'}. First the
        encoder writes the type byte <b>{t}</b>; then every byte is replaced by its residual, left to right. Step forward.
      </>
    )
  else {
    const a = i >= BPP ? cur[i - BPP] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= BPP ? prev[i - BPP] : 0
    const p = predict(t, a, b, c)
    say = (
      <>
        Byte {i} is the {CHANNELS[i % 3]} of pixel {Math.floor(i / 3)}: x = <b>{cur[i]}</b>, with a = {a}
        {i < BPP ? ' (off the left edge)' : ''}, b = {b}
        {prev ? '' : ' (no row above)'}, c = {c}. {FILTER_NAMES[t]} guesses <b>{p}</b>, so the stored byte is {cur[i]} − {p} ={' '}
        {sgn(signed(out[i]))} → <b>{out[i]}</b>.{' '}
        {step === STRIDE ? (
          <>
            Row done: the sum of |residual| is {int(sumAbs)}, against {int(cur.reduce((s, v) => s + Math.abs(signed(v)), 0))} for the raw bytes read the same way.
          </>
        ) : null}
      </>
    )
  }
  return (
    <>
      <Panel title={`Row ${y}, byte by byte — ${FILTER_NAMES[t]}`} aside={`bytes ${from}–${to - 1} of ${STRIDE}`}>
        <div className="pn-rows">
          <span className="pn-rowlabel">row above</span>
          <Tape bytes={idx.map((k) => (prev ? prev[k] : 0))} wrap={false} render={(j) => (prev ? prev[idx[j]] : 0)} mark={(j) => role(idx[j], 'up') || (prev ? undefined : 'ghost')} cellTitle={(j) => label(idx[j])} />
          <span className="pn-rowlabel">this row</span>
          <Tape bytes={idx.map((k) => cur[k])} wrap={false} render={(j) => cur[idx[j]]} mark={(j) => role(idx[j], 'cur') || (idx[j] > i ? 'dim' : undefined)} cellTitle={(j) => label(idx[j])} />
          <span className="pn-rowlabel">stored</span>
          <Tape
            bytes={idx.map((k) => out[k])}
            wrap={false}
            render={(j) => (idx[j] <= i ? out[idx[j]] : '')}
            mark={(j) => (idx[j] === i ? 'cur hl-1' : idx[j] < i ? (Math.abs(signed(out[idx[j]])) <= 3 ? 'hl-3' : undefined) : 'ghost')}
            cellTitle={(j) => label(idx[j])}
          />
          <span className="pn-rowlabel" />
          <div className="pn-chlabels">
            {idx.map((k) => (
              <span key={k}>{label(k)}</span>
            ))}
          </div>
        </div>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          <span className="pn-key hl-1" /> x &nbsp; <span className="pn-key hl-4" /> a, b, c (one pixel = 3 bytes back) &nbsp; <span className="pn-key hl-3" /> stored value within ±3 of zero
        </p>
      </Panel>
      <Narration tone={step === STRIDE ? 'done' : undefined}>{say}</Narration>
    </>
  )
}

// -------------------------------------------------------------- the file

function FilePanel({ file, url }: { file: ReturnType<typeof writePng>; url: string | null }) {
  const b = file.bytes
  const ihdr = file.chunks[0]
  const idat = file.chunks[1]
  const iend = file.chunks[2]
  // First 41 bytes: signature, IHDR, IDAT's length + type; then the tail.
  const headEnd = idat.offset + 8 + 2
  const head = b.subarray(0, headEnd)
  const tailBase = idat.offset + 8 + idat.length - 4
  const tail = b.subarray(tailBase)
  const kindAt = (o: number): [string, string] => {
    if (o < 8) return ['hl-6', 'signature: \\x89 P N G \\r \\n \\x1a \\n — catches 7-bit transfers and line-ending conversion']
    for (const c of file.chunks) {
      if (o >= c.offset && o < c.offset + 4) return ['hl-4', `${c.type} length = ${c.length}`]
      if (o >= c.offset + 4 && o < c.offset + 8) return ['hl-1', `chunk type “${c.type}”`]
      if (o >= c.offset + 8 && o < c.offset + 8 + c.length) {
        if (c.type === 'IHDR') {
          const k = o - c.offset - 8
          const names = ['width', 'width', 'width', 'width', 'height', 'height', 'height', 'height', 'bit depth = 8', 'colour type = 2 (RGB)', 'compression = 0 (deflate)', 'filter method = 0 (the five filters)', 'interlace = 0 (none)']
          return ['hl-3', `IHDR ${names[k]}`]
        }
        const k = o - c.offset - 8
        if (c.type === 'IDAT' && k < 2) return ['hl-3', 'zlib header 78 9c: deflate, 32 KiB window']
        if (c.type === 'IDAT' && k >= c.length - 4) return ['hl-3', 'zlib trailer: Adler-32 of the filtered scanlines']
        return ['hl-3', `${c.type} data`]
      }
      if (o >= c.offset + 8 + c.length && o < c.offset + 12 + c.length) return ['hl-2', `${c.type} CRC-32 = ${c.crc.toString(16).padStart(8, '0')}`]
    }
    return ['', '']
  }
  const [hover, setHover] = useState<string | null>(null)
  return (
    <Panel title="The file" aside={`${int(b.length)} bytes · ${file.chunks.length} chunks`}>
      <div className="pn-file">
        <div className="pn-file-bytes">
          <Tape
            bytes={head}
            render={(i) => hex2(head[i])}
            mark={(i) => kindAt(i)[0]}
            cellTitle={(i) => kindAt(i)[1]}
            onHover={(i) => setHover(i === null ? null : kindAt(i)[1])}
          />
          <div className="pn-gap mono small muted">… {int(idat.length - 2 - 4)} bytes of DEFLATE stream …</div>
          <Tape
            bytes={tail}
            render={(i) => hex2(tail[i])}
            mark={(i) => kindAt(tailBase + i)[0]}
            cellTitle={(i) => kindAt(tailBase + i)[1]}
            onHover={(i) => setHover(i === null ? null : kindAt(tailBase + i)[1])}
          />
          <div className="pn-hover small mono">{hover ?? 'Hover a byte to see what it is.'}</div>
          <div className="legend">
            <span>
              <i className="hl-6" /> signature
            </span>
            <span>
              <i className="hl-4" /> length
            </span>
            <span>
              <i className="hl-1" /> type
            </span>
            <span>
              <i className="hl-3" /> data
            </span>
            <span>
              <i className="hl-2" /> CRC
            </span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>chunk</th>
                <th className="num">offset</th>
                <th className="num">length</th>
                <th>CRC-32</th>
                <th>what it says</th>
              </tr>
            </thead>
            <tbody>
              {[ihdr, idat, iend].map((c) => (
                <tr key={c.type}>
                  <td>
                    <b>{c.type}</b>
                  </td>
                  <td className="num">{c.offset}</td>
                  <td className="num">{int(c.length)}</td>
                  <td>{c.crc.toString(16).padStart(8, '0')}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="btn-row">
          <Button
            kind="primary"
            disabled={!url}
            onClick={() => {
              if (!url) return
              const a = document.createElement('a')
              a.href = url
              a.download = 'filtered.png'
              a.click()
            }}
          >
            Download this .png ({int(b.length)} B)
          </Button>
        </div>
      </div>
    </Panel>
  )
}

// ----------------------------------------------------------------- notes

function PngNotes() {
  return (
    <Notes>
      <h2>Why PNG exists</h2>
      <p>
        In late 1994 Unisys announced it would collect royalties on the LZW patent — and with it on GIF, the web’s only lossless image format.
        Within weeks Thomas Boutell, Greg Roelofs and a group on Usenet designed a replacement around the one compressor everyone agreed was
        unencumbered: DEFLATE. The PNG specification became a W3C recommendation and RFC 2083 in 1996, and ISO/IEC 15948 in 2003. It also fixed
        GIF’s other limits — truecolour, a real alpha channel, gamma — but the compression idea is the part this page is about.
      </p>
      <h2>Filtering is prediction</h2>
      <p>
        DEFLATE has no idea what an image is. It finds repeated byte strings and gives common bytes short codes. A photograph has almost no exact
        repeats, and its byte values are spread over the whole range — but each pixel is very close to its neighbours. So PNG transforms the bytes
        first, losslessly:
      </p>
      <Code>{`filtered(x) = (x − predict(a, b, c)) mod 256        c b
raw(x)      = (filtered(x) + predict(a, b, c)) mod 256   a x

0 None     predict = 0
1 Sub      predict = a
2 Up       predict = b
3 Average  predict = ⌊(a + b) / 2⌋
4 Paeth    p = a + b − c; return whichever of a, b, c is nearest p (ties: a, b, c)`}</Code>
      <p>
        These are tiny <b>linear predictors</b>, the same idea as <a href="#/flac">lossless audio</a>, JPEG-LS and every video codec’s intra
        prediction. The residuals are not fewer in number — there are still exactly as many bytes — but they cluster tightly around zero, and that
        is a distribution Huffman coding can exploit. Watch the entropy readout: the transform cannot remove information, only rearrange it into
        a shape the next stage can use.
      </p>
      <h2>Paeth’s predictor</h2>
      <p>
        Alan W. Paeth published it in <i>Graphics Gems II</i> (1991). The value p = a + b − c is the exact answer if the image is locally a flat
        gradient — a plane through the three neighbours. But p can overshoot at an edge, so instead of using p, Paeth returns whichever real
        neighbour is closest to it. On a horizontal edge that is b, on a vertical edge a: it picks the direction the edge runs, which is why it is
        the usual winner on photographs. Ties go to a, then b, then c; a decoder that breaks ties differently decodes garbage, which is why the
        verify suite checks every one of the 16.7 million (a, b, c) against the specification’s pseudocode.
      </p>
      <h2>Choosing a filter per row</h2>
      <p>
        The type byte at the start of each row lets an encoder change filters as often as it likes, and the spec deliberately leaves the choice
        open. libpng’s default is the cheap heuristic here: try all five and keep the row whose bytes, read as signed, have the smallest sum of
        absolute values. It is a proxy — small residuals usually compress well — and it is often beaten. Tools like <b>optipng</b>,{' '}
        <b>pngcrush</b> and <b>zopflipng</b> try combinations by actually compressing, and the trial strategy above is a small, local version of
        that. On the test images the fixed filters and the heuristic swap places, which is the real lesson: there is no best filter, only a best
        filter for this image.
      </p>
      <p>
        One sharp corner: for palette images and images with fewer than 8 bits per pixel the spec recommends filter None on every row. Prediction
        assumes that nearby <i>values</i> are nearby <i>colours</i>, and a palette index of 17 next to 18 says nothing about whether those colours
        look alike.
      </p>
      <h2>What else is in a PNG</h2>
      <ul>
        <li>
          <b>Chunks.</b> A file is the 8-byte signature and a list of chunks, each length, type, data, CRC. The case of each letter in the type is a
          flag: lowercase first letter means a decoder may skip it (<code>tEXt</code>, <code>gAMA</code>…), uppercase means it must understand it.
        </li>
        <li>
          <b>The signature</b> 89 50 4E 47 0D 0A 1A 0A is built to break visibly under every common corruption: the high bit catches 7-bit
          transfers, CR LF and LF catch line-ending conversion, and 1A stops a DOS <code>type</code> command.
        </li>
        <li>
          <b>Adam7 interlacing</b> sends seven passes of a sparse pixel grid so a picture appears blurry first. Each pass is filtered on its own,
          and the neighbours are further apart, so interlaced files are typically 10–20% bigger.
        </li>
        <li>
          <b>APNG</b> adds animation in ancillary chunks that old decoders ignore — the first frame still shows.
        </li>
      </ul>
      <h2>When PNG is the wrong tool</h2>
      <p>
        Lossless means every bit of camera noise has to be kept, and noise does not predict: a photo that is 40 KB as a good JPEG can be 400 KB as
        a PNG. The other way round, a screenshot of text is where <a href="#/jpeg">JPEG</a> rings and smears and PNG — long flat runs, exact
        repeats, residuals of 0 — is tiny. The <i>Screenshot</i> preset shows the second half of that: no filter is best there, because DEFLATE
        was already finding the runs on its own.
      </p>
      <div className="aside">
        A modern contrast: <b>QOI</b> (2021) throws away DEFLATE altogether — it codes each pixel as a run, an index into a 64-entry cache of recent
        colours, or a small difference from the previous pixel, in a few hundred lines of C, and lands within a few per cent of PNG at many times
        the speed. Same idea as filtering — predict from the neighbour, code the surprise — with a cheaper back end.
      </div>
    </Notes>
  )
}
