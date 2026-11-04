import { useMemo, useState, type ChangeEvent } from 'react'
import { useStepper } from '../../lib/useStepper'
import { useTheme } from '../../lib/theme'
import { fmt, int } from '../../lib/text'
import { Group, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import { deflateRaw } from '../deflate/encoder'
import { lzwEncode } from '../lzw/codec'
import { PRESETS, SIZE, type PresetId } from './images'
import {
  KERNELS,
  colorTable,
  deltaE,
  diffuseTrace,
  kmeans,
  mapImage,
  medianCut,
  psnr,
  uniformLevels,
  uniformPalette,
  type Box,
  type Dither,
  type Img,
  type RGB,
} from './quant'
import { DiffuseGrid, DiffuseReadout, fmtE, Pane, RgbCanvas, Scatter, Sparkline, Swatches } from './views'
import './palette.css'

type Source = PresetId | 'upload'
type Algo = 'uniform' | 'median' | 'kmeans'
type DitherId = 'none' | 'bayer' | 'fs' | 'atkinson' | 'jjn'
type StepMode = 'cut' | 'kmeans' | 'diffuse'

const SIZES = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]
const WIN_W = 10
const WIN_H = 6
const AXIS = ['red', 'green', 'blue'] as const

const DEFAULT_WIN: Record<Source, { x: number; y: number }> = {
  sunset: { x: 40, y: 40 },
  meadow: { x: 30, y: 150 },
  logo: { x: 112, y: 60 },
  wheel: { x: 120, y: 60 },
  upload: { x: 90, y: 90 },
}

const css = (c: ArrayLike<number>) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
const rgbText = (c: ArrayLike<number>) => `(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`

async function loadUpload(file: File): Promise<Img> {
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d')!
  const s = Math.max(SIZE / bmp.width, SIZE / bmp.height)
  const w = bmp.width * s
  const h = bmp.height * s
  ctx.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data
  const data = new Uint8ClampedArray(SIZE * SIZE * 3)
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[3 * i] = rgba[4 * i]
    data[3 * i + 1] = rgba[4 * i + 1]
    data[3 * i + 2] = rgba[4 * i + 2]
  }
  return { w: SIZE, h: SIZE, data }
}

function crop(img: Img, x0: number, y0: number, w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = 3 * ((y0 + y) * img.w + x0 + x)
      data.set(img.data.subarray(p, p + 3), 3 * (y * w + x))
    }
  return { w, h, data }
}

/** The index stream as a PNG-8 would store it: one filter byte (0 = none) per row, then the row. */
function pngRows(idx: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array((w + 1) * h)
  for (let y = 0; y < h; y++) out.set(idx.subarray(y * w, (y + 1) * w), y * (w + 1) + 1)
  return out
}

export function Palette() {
  const theme = useTheme()
  const [source, setSource] = useState<Source>('sunset')
  const [upload, setUpload] = useState<Img | null>(null)
  const [algo, setAlgo] = useState<Algo>('median')
  const [nIdx, setNIdx] = useState(SIZES.indexOf(16))
  const [ditherId, setDitherId] = useState<DitherId>('none')
  const [bayerSize, setBayerSize] = useState(4)
  const [serpentine, setSerpentine] = useState(true)
  const [showError, setShowError] = useState(true)
  const [stepMode, setStepMode] = useState<StepMode>('cut')
  const [hover, setHover] = useState<number | null>(null)
  const [winAt, setWinAt] = useState<{ x: number; y: number } | null>(null)

  const N = SIZES[nIdx]
  const img = useMemo<Img>(() => (source === 'upload' && upload ? upload : PRESETS[source === 'upload' ? 'sunset' : source]()), [source, upload])
  const table = useMemo(() => colorTable(img), [img])
  const cut = useMemo(() => medianCut(table, N), [table, N])
  const needK = algo === 'kmeans' || stepMode === 'kmeans'
  const ksteps = useMemo(() => (needK ? kmeans(table, cut.palette, 12) : []), [needK, table, cut])

  const palette = useMemo<RGB[]>(() => {
    if (algo === 'uniform') return uniformPalette(N)
    if (algo === 'median') return cut.palette
    const last = ksteps[ksteps.length - 1]
    return last ? last.moved.map((c) => c.map((v) => Math.round(v)) as RGB) : cut.palette
  }, [algo, N, cut, ksteps])

  const dither = useMemo<Dither>(() => {
    if (ditherId === 'none') return { kind: 'none' }
    if (ditherId === 'bayer') return { kind: 'ordered', size: bayerSize }
    return { kind: 'diffuse', kernel: KERNELS[ditherId], serpentine }
  }, [ditherId, bayerSize, serpentine])

  const mapped = useMemo(() => mapImage(img, palette, dither), [img, palette, dither])
  const plain = useMemo(() => (dither.kind === 'none' ? mapped : mapImage(img, palette, { kind: 'none' })), [img, palette, dither, mapped])
  const usage = useMemo(() => {
    const u = new Array(palette.length).fill(0)
    for (let i = 0; i < mapped.idx.length; i++) u[mapped.idx[i]]++
    return u
  }, [mapped, palette])
  const errImg = useMemo(() => {
    const e = new Uint8ClampedArray(img.data.length)
    for (let i = 0; i < e.length; i++) e[i] = Math.abs(img.data[i] - mapped.out[i]) * 4
    // Show it dark-on-light: invert so "no error" is white.
    for (let i = 0; i < e.length; i++) e[i] = 255 - e[i]
    return e
  }, [img, mapped])

  const pixels = img.w * img.h
  const quality = useMemo(
    () => ({
      psnr: psnr(img.data, mapped.out),
      de: deltaE(img, mapped.out),
      deBlur: deltaE(img, mapped.out, true),
      dePlainBlur: deltaE(img, plain.out, true),
    }),
    [img, mapped, plain],
  )
  const sizes = useMemo(() => {
    const pal = 3 * palette.length
    const bitsPer = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))))
    return {
      bitsPer,
      raw: pixels * 24,
      packed: pixels * bitsPer + pal * 8,
      lzw: (lzwEncode(mapped.idx).length - 4 + pal) * 8,
      png: (deflateRaw(pngRows(mapped.idx, img.w, img.h), { block: 'auto', lazy: true }).length + pal) * 8,
      pngPlain: dither.kind === 'none' ? 0 : (deflateRaw(pngRows(plain.idx, img.w, img.h), { block: 'auto', lazy: true }).length + pal) * 8,
    }
  }, [mapped, plain, palette, pixels, img, dither])

  // ---- the window for the diffusion close-up
  const win = winAt ?? DEFAULT_WIN[source]
  const winImg = useMemo(() => crop(img, win.x, win.y, WIN_W, WIN_H), [img, win.x, win.y])
  const kernel = dither.kind === 'diffuse' ? dither.kernel : KERNELS.fs
  const serp = dither.kind === 'diffuse' ? dither.serpentine : false
  const trace = useMemo(() => (stepMode === 'diffuse' ? diffuseTrace(winImg, palette, kernel, serp) : []), [stepMode, winImg, palette, kernel, serp])

  const count = stepMode === 'cut' ? cut.steps.length + 1 : stepMode === 'kmeans' ? ksteps.length + 1 : trace.length + 1
  const s = useStepper(count, {
    speed: stepMode === 'diffuse' ? 4 : 2,
    resetKey: [stepMode, source, N, algo, ditherId, win.x, win.y, upload ? 1 : 0].join(':'),
  })

  const pick = (x: number, y: number) => setWinAt({ x: Math.max(0, Math.min(SIZE - WIN_W, x - WIN_W / 2)), y: Math.max(0, Math.min(SIZE - WIN_H, y - WIN_H / 2)) })

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      setUpload(await loadUpload(f))
      setSource('upload')
      setWinAt(null)
    } catch {
      /* unreadable image: keep the current one */
    }
  }

  const uni = uniformLevels(N)
  const sel = { x: win.x, y: win.y, w: WIN_W, h: WIN_H }

  return (
    <Page
      slug="palette"
      lede={
        <>
          <p>
            Early frame buffers stored one byte per pixel and a lookup table of 256 colours; GIF froze that into a file format in 1987. So every
            image had to be squeezed into <b>its own 256 colours</b> — or 16, or 2. Choosing them is a clustering problem in a cube of 16.7 million
            colours. Hiding the ones you could not keep is <b>dithering</b>: let a pixel be wrong on purpose and hand its error to the neighbours,
            so the area is right on average.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Image">
              <Segmented
                value={source === 'upload' ? ('upload' as Source) : source}
                onChange={(v) => {
                  if (v === 'upload' && !upload) return
                  setSource(v)
                  setWinAt(null)
                }}
                options={[
                  { value: 'sunset', label: 'Sunset' },
                  { value: 'meadow', label: 'Meadow' },
                  { value: 'logo', label: 'Logo' },
                  { value: 'wheel', label: 'Wheel' },
                  ...(upload ? [{ value: 'upload' as Source, label: 'Yours' }] : []),
                ]}
              />
              <label className={'btn btn-ghost pl-upload' + (source === 'upload' ? ' on' : '')}>
                Upload your own…
                <input type="file" accept="image/*" onChange={onFile} />
              </label>
              <p className="small muted">
                {int(table.length)} {table.length >= 12000 ? 'colour bins' : 'distinct colours'} in {int(pixels)} pixels.{' '}
                {source === 'logo' && 'Flat colours: a good quantiser gets this exactly right at 8.'}
                {source === 'sunset' && 'Long smooth ramps: banding shows the moment colours run short.'}
                {source === 'wheel' && 'Every hue at every saturation — no small palette can win.'}
                {source === 'meadow' && 'Many hues and film grain: a photograph in miniature.'}
              </p>
            </Group>
            <Group title="Palette" help="How the colours are chosen. Uniform ignores the image; median cut and k-means fit the palette to the colours actually present.">
              <Segmented
                value={algo}
                onChange={setAlgo}
                options={[
                  { value: 'uniform', label: 'Uniform' },
                  { value: 'median', label: 'Median cut' },
                  { value: 'kmeans', label: 'k-means' },
                ]}
              />
              <Slider
                label="colours"
                value={nIdx}
                min={0}
                max={SIZES.length - 1}
                onChange={(v) => setNIdx(Math.round(v))}
                display={
                  <>
                    {N}
                    <em> · {Math.max(1, Math.ceil(Math.log2(N)))} bits/px</em>
                  </>
                }
                help="A palette of N colours means each pixel is stored as an index of ⌈log₂N⌉ bits instead of 24 bits of RGB."
              />
              {algo === 'uniform' && (
                <p className="small muted">
                  {uni[0]} red × {uni[1]} green × {uni[2]} blue levels = {uni[0] * uni[1] * uni[2]} colours
                  {N === 216 ? ' — the old “web-safe” palette.' : N === 256 ? ' — “3-3-2”: 3 bits red, 3 green, 2 blue.' : '.'}
                </p>
              )}
            </Group>
            <Group title="Dither" help="What to do with the error between a pixel and the palette colour it gets.">
              <Segmented
                value={ditherId}
                onChange={setDitherId}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'bayer', label: 'Bayer' },
                  { value: 'fs', label: 'Floyd–S.', title: 'Floyd–Steinberg' },
                  { value: 'atkinson', label: 'Atkinson' },
                  { value: 'jjn', label: 'JJN', title: 'Jarvis–Judice–Ninke' },
                ]}
              />
              {ditherId === 'bayer' && (
                <Segmented
                  label="threshold matrix"
                  value={bayerSize}
                  onChange={setBayerSize}
                  options={[
                    { value: 2, label: '2×2' },
                    { value: 4, label: '4×4' },
                    { value: 8, label: '8×8' },
                  ]}
                  help="Ordered dithering adds a fixed, repeating offset to each pixel before rounding. Bigger matrices give more in-between levels and a finer cross-hatch."
                />
              )}
              {(ditherId === 'fs' || ditherId === 'atkinson' || ditherId === 'jjn') && (
                <Toggle
                  label="Serpentine scan"
                  value={serpentine}
                  onChange={setSerpentine}
                  help="Alternate left-to-right and right-to-left rows. Pushing error the same direction every row lines it up into diagonal 'worms'; reversing breaks them up."
                />
              )}
            </Group>
            <Group title="Step through">
              <Segmented
                value={stepMode}
                onChange={setStepMode}
                options={[
                  { value: 'cut', label: 'Median cut' },
                  { value: 'kmeans', label: 'k-means' },
                  { value: 'diffuse', label: 'Diffusion' },
                ]}
              />
              <p className="small muted">
                {stepMode === 'cut' && `Each step cuts one box of colours in two at its median, until there are ${N}.`}
                {stepMode === 'kmeans' && 'Each step re-assigns every colour to its nearest centre, then moves each centre to the middle of its colours.'}
                {stepMode === 'diffuse' && 'Each step decides one pixel of a 10×6 window and passes its error on. Click either image to move the window.'}
              </p>
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="colours used" value={usage.filter((u) => u > 0).length} sub={`of ${palette.length}`} />
                <Stat label="PSNR" value={Number.isFinite(quality.psnr) ? fmt(quality.psnr, 1) : '∞'} sub="dB" help="Peak signal-to-noise ratio of the RGB values, pixel by pixel. Higher is closer. It punishes dithering, because dithering makes individual pixels more wrong." />
                <Stat
                  label="ΔE per pixel"
                  value={fmt(quality.de, 1)}
                  help="Average colour difference in OKLab, a colour space built so equal distances look equally different (×100, so about 1 is just noticeable)."
                />
                <Stat
                  label="ΔE, squinting"
                  value={fmt(quality.deBlur, 1)}
                  tone="accent"
                  help="The same after averaging 2×2 pixels — roughly what your eye does from a little further away. This is the number dithering improves."
                />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel title="Before and after" aside={`${N} colours · ${ditherId === 'none' ? 'no dither' : ditherId === 'bayer' ? `Bayer ${bayerSize}×${bayerSize}` : kernel.name}`}>
          <div className={'pl-panes' + (showError ? '' : ' two')}>
            <Pane title="Original" sub="24 bits per pixel" size={SIZE} sel={stepMode === 'diffuse' ? sel : undefined} onPick={pick}>
              <RgbCanvas data={img.data} w={img.w} h={img.h} />
            </Pane>
            <Pane title={`${palette.length} colours`} sub={`${sizes.bitsPer} bits per pixel + palette`} size={SIZE} sel={stepMode === 'diffuse' ? sel : undefined} onPick={pick}>
              <RgbCanvas data={mapped.out} w={img.w} h={img.h} idx={mapped.idx} only={hover} />
            </Pane>
            {showError && (
              <Pane title="Error ×4" sub="white = exact" size={SIZE}>
                <RgbCanvas data={errImg} w={img.w} h={img.h} />
              </Pane>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <Toggle label="Show the error" value={showError} onChange={setShowError} />
          </div>
        </Panel>

        <Panel title="The palette" aside="sorted by use · hover to isolate">
          <Swatches palette={palette} usage={usage} hover={hover} onHover={setHover} />
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            {hover !== null
              ? `#${hover}: rgb${rgbText(palette[hover])} — ${int(usage[hover])} pixels (${fmt((100 * usage[hover]) / pixels, 1)}%).`
              : algo === 'uniform'
                ? 'A uniform palette spends entries on colours the image never uses — look for the empty bars.'
                : 'Every entry is the average of a cluster of the image’s own colours, so almost none go unused.'}
          </p>
        </Panel>

        {stepMode === 'cut' && <CutStage cut={cut} table={table} index={s.index} N={N} theme={theme} />}
        {stepMode === 'kmeans' && <KStage ksteps={ksteps} seed={cut.palette} table={table} index={s.index} theme={theme} />}
        {stepMode === 'diffuse' && <DiffuseStage trace={trace} palette={palette} win={winImg} index={s.index} kernelName={kernel.name} serpentine={serp} fromDither={dither.kind === 'diffuse'} />}

        <Transport
          s={s}
          label={(i) => (stepMode === 'cut' ? `split ${i} / ${count - 1}` : stepMode === 'kmeans' ? `iteration ${i} / ${count - 1}` : `pixel ${i} / ${count - 1}`)}
        />

        <Panel title="Where the bits go" aside={`${img.w}×${img.h} pixels`}>
          <SizeBars
            rows={[
              { label: '24-bit RGB', value: sizes.raw, tone: 'faint' },
              { label: `${sizes.bitsPer}-bit indices`, value: sizes.packed, tone: 'faint', note: 'packed, + palette' },
              { label: 'GIF-style LZW', value: sizes.lzw, note: 'indices + palette' },
              { label: 'PNG-8 (DEFLATE)', value: sizes.png, tone: 'ink', note: dither.kind === 'none' ? 'indices + palette' : 'dithered' },
              ...(dither.kind !== 'none' ? [{ label: 'PNG-8, no dither', value: sizes.pngPlain, tone: 'good', note: 'same palette' }] : []),
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            {dither.kind === 'none'
              ? 'Turn on a dither and watch the compressed sizes jump: the scattered pixels are exactly what LZ-style coders cannot find repeats in.'
              : `Dithering made the PNG ${fmt((100 * (sizes.png - sizes.pngPlain)) / Math.max(1, sizes.pngPlain), 0)}% bigger — and the squint-test error went from ${fmt(quality.dePlainBlur, 1)} to ${fmt(quality.deBlur, 1)}. Looks against bytes: every GIF encoder makes this trade.`}
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>Why palettes existed</h2>
        <p>
          A 1980s frame buffer could not afford 24 bits per pixel, so it stored an 8-bit index per pixel and a <b>colour lookup table</b> (CLUT)
          of 256 RGB entries in the video hardware. The picture could use any 256 colours out of 16.7 million — but only 256 at once.
          CompuServe’s GIF (1987) wrote that arrangement straight into a file: a palette of up to 256 entries, then the index stream compressed with{' '}
          <a href="#/lzw">LZW</a>. PNG-8 does the same with <a href="#/deflate">DEFLATE</a>, and it is still the smallest way to ship a logo or a
          screenshot with few colours.
        </p>
        <h2>Choosing the colours</h2>
        <p>
          A <b>uniform</b> palette splits the cube evenly — 6 × 6 × 6 for the web-safe palette, 8 × 8 × 4 for “3-3-2”. It needs no analysis and
          wastes most of its entries on colours the image does not contain.
        </p>
        <p>
          <b>Median cut</b> (Paul Heckbert, 1982) fits the palette to the image:
        </p>
        <Code>{`boxes ← [ the bounding box of every colour in the image ]
while |boxes| < N:
    B    ← the box with the widest spread
    axis ← B's longest side (red, green or blue)
    sort B's colours along axis; cut where half B's pixels are on each side
replace B by the two halves
palette ← the pixel-weighted mean colour of each box`}</Code>
        <p>
          Cutting at the <i>median pixel</i> rather than the middle of the range means each box ends up representing about the same number of
          pixels — so a big blue sky gets many shades of blue and a tiny red flower gets one red. Heckbert also pre-quantised colours to 5 bits per
          channel to make the histogram fit in 1982 memory; this page does the same when an image has more than 12 000 distinct colours.
        </p>
        <p>
          <b>k-means</b> (Lloyd’s algorithm, 1957/1982) then polishes any starting palette: assign every colour to its nearest centre, move every
          centre to the mean of its colours, repeat. Each half-step can only lower the total squared error, so it converges — to a local optimum
          that depends on the start, which is why it is seeded from median cut. The <b>octree</b> quantiser (Gervautz &amp; Purgathofer, 1988)
          builds a tree of colour-cube octants and merges the least-used leaves; <b>NeuQuant</b> (Dekker, 1994) trains a one-dimensional
          self-organising map; <b>pngquant</b>’s libimagequant uses a modified median cut followed by k-means-style refinement in a perceptual space.
        </p>
        <h2>Distance is not what you see</h2>
        <p>
          Everything above measures error as Euclidean distance in RGB, and the eye does not. It is far more sensitive to differences in lightness
          than in hue, more sensitive to green than blue, and RGB values are gamma-encoded besides. Better quantisers measure in a perceptual space:
          CIELAB (1976) or Björn Ottosson’s <b>OKLab</b> (2020), which the ΔE readout on this page uses. In those spaces, equal distances look about
          equally different.
        </p>
        <h2>Dithering</h2>
        <p>
          <b>Ordered dithering</b> (Bryce Bayer, 1973) adds a fixed threshold pattern before rounding. Bayer’s matrices are built by doubling —
          each 2n × 2n matrix is four copies of the n × n one, scaled by 4 and offset by 0, 2, 3, 1 — which spreads the thresholds as evenly as
          possible. It is cheap, parallel and stable from frame to frame, but the cross-hatch is visible.
        </p>
        <p>
          <b>Error diffusion</b> (Robert Floyd &amp; Louis Steinberg, 1976) decides pixels in scan order and pushes each pixel’s error onto
          neighbours not yet decided:
        </p>
        <Code>{`          ·    *   7/16           * = this pixel
        3/16  5/16  1/16          (next row)`}</Code>
        <p>
          The error never vanishes — it is carried until some pixel can absorb it by rounding the other way — so the average colour of every area
          is preserved. <b>Jarvis–Judice–Ninke</b> (1976) spreads it over twelve neighbours for a smoother but slower result. Bill Atkinson’s
          dither for the original Macintosh passes on only <b>6/8</b> of the error and throws the rest away, which keeps highlights and shadows
          crisp at the cost of a little contrast. A <b>serpentine</b> scan alternates direction each row to stop the error lining up into
          diagonal “worms”.
        </p>
        <h2>The trade</h2>
        <p>
          Dithering makes an image look better and compress worse. A flat area under a 16-colour palette is a long run of one index — perfect for
          LZW or DEFLATE — while the same area dithered is a scatter of two or three indices with no repeats to find. GIF artists hand-tuned this
          trade for years; modern PNG-8 tools add tricks such as dithering only where the error is large, or choosing palette order so similar
          colours get similar indices (helping DEFLATE).
        </p>
        <div className="aside">
          Where it lives on: GIF stickers and memes, PNG-8 icons and screenshots, e-ink displays (which really do have two to sixteen levels), and
          every thermal receipt printer — the receipt is a 1-bit dither.
        </div>
      </Notes>
    </Page>
  )
}

// --------------------------------------------------------------- the stages

function StepChips({ colours }: { colours: ArrayLike<number>[] }) {
  return (
    <div className="pl-chips">
      {colours.map((c, i) => (
        <i key={i} style={{ background: css(c) }} title={`rgb${rgbText(c)}`} />
      ))}
    </div>
  )
}

function CutStage({ cut, table, index, N, theme }: { cut: ReturnType<typeof medianCut>; table: ReturnType<typeof colorTable>; index: number; N: number; theme: ReturnType<typeof useTheme> }) {
  const boxes: Box[] = index === 0 ? cut.initial : cut.steps[index - 1].boxes
  const st = index > 0 ? cut.steps[index - 1] : null
  const parent = st ? (index === 1 ? cut.initial : cut.steps[index - 2].boxes)[st.box] : null
  const done = index === cut.steps.length
  const total = boxes.reduce((a, b) => a + b.n, 0)
  return (
    <>
      <Panel title="The colour cube" aside={`${boxes.length} box${boxes.length === 1 ? '' : 'es'} · dots are the image’s colours, circles the palette`}>
        <Scatter
          table={table}
          boxes={boxes}
          hot={st ? [st.box, boxes.length - 1] : [0]}
          cut={st && parent ? { axis: st.axis, at: st.at + 0.5, min: parent.min, max: parent.max } : undefined}
          theme={theme}
        />
        <StepChips colours={boxes.map((b) => b.mean)} />
      </Panel>
      <Narration tone={done && index > 0 ? 'done' : undefined}>
        {!st && boxes.length > 0 && (
          <>
            One box around all {int(table.length)} colours ({int(total)} pixels). Its average, <Swatch c={boxes[0].mean} />, is the best palette of
            one colour. Step forward to cut it.
          </>
        )}
        {st && parent && (
          <>
            The widest box spanned <b>{Math.round(parent.max[st.axis] - parent.min[st.axis])}</b> levels of <b>{AXIS[st.axis]}</b>, its longest side.
            Sorted its {int(parent.items.length)} colours by {AXIS[st.axis]} and cut at {AXIS[st.axis]} = {Math.round(st.at)}, the median pixel:{' '}
            {int(st.lowN)} pixels below, {int(st.highN)} above. Two means, <Swatch c={boxes[st.box].mean} /> and <Swatch c={boxes[boxes.length - 1].mean} />,
            replace <Swatch c={parent.mean} /> — {boxes.length} colours now.
            {done && boxes.length < N && <> No box with two distinct colours is left: the image only has {table.length} colours, so the palette stops short of {N}.</>}
            {done && boxes.length === N && <> That is all {N}.</>}
          </>
        )}
      </Narration>
    </>
  )
}

function Swatch({ c }: { c: ArrayLike<number> }) {
  return <i className="pl-chip" style={{ background: css(c) }} title={`rgb${rgbText(c)}`} />
}

function KStage({
  ksteps,
  seed,
  table,
  index,
  theme,
}: {
  ksteps: ReturnType<typeof kmeans>
  seed: RGB[]
  table: ReturnType<typeof colorTable>
  index: number
  theme: ReturnType<typeof useTheme>
}) {
  const st = index > 0 ? ksteps[index - 1] : null
  const centres = st ? st.centres : seed
  const last = index === ksteps.length
  const values = ksteps.map((k) => k.distortion)
  const first = ksteps[0]?.distortion ?? 0
  return (
    <>
      <Panel title="The colour cube" aside={st ? `MSE ${fmt(st.distortion, 1)} per pixel` : 'seeded from median cut'}>
        <Scatter table={table} centres={centres} moved={st?.moved} theme={theme} />
        <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <StepChips colours={st ? st.moved : seed} />
          <Sparkline values={values} at={index - 1} theme={theme} />
        </div>
      </Panel>
      <Narration tone={last && index > 0 ? 'done' : undefined}>
        {!st && (
          <>
            The {seed.length} median-cut colours are the starting centres. Median cut never looks back at a cut it made; k-means will now let every
            centre drift to wherever it serves its pixels best.
          </>
        )}
        {st && (
          <>
            Iteration {index}: every colour went to its nearest centre
            {index > 1 ? <> — {int(st.changed)} of {int(table.length)} switched</> : null}. Mean squared error <b>{fmt(st.distortion, 1)}</b>
            {index > 1 && <> (from {fmt(ksteps[index - 2].distortion, 1)})</>}. Then each centre moved to the average of its colours — the lines
            show how far.
            {last && (
              <>
                {' '}
                {st.changed === 0 ? 'Nothing switched: converged.' : 'Stopping here.'} Total improvement over median cut:{' '}
                {fmt((100 * (first - st.distortion)) / Math.max(1e-9, first), 1)}%.
              </>
            )}
          </>
        )}
      </Narration>
    </>
  )
}

function DiffuseStage({
  trace,
  palette,
  win,
  index,
  kernelName,
  serpentine,
  fromDither,
}: {
  trace: ReturnType<typeof diffuseTrace>
  palette: RGB[]
  win: Img
  index: number
  kernelName: string
  serpentine: boolean
  fromDither: boolean
}) {
  const st = index > 0 ? trace[index - 1] : null
  const inside = st ? st.pushes.filter((p) => p.inside) : []
  const lostEdge = st ? st.pushes.filter((p) => !p.inside) : []
  const den = st?.pushes[0]?.den ?? 16
  const passed = st ? st.pushes.reduce((a, p) => a + p.num, 0) : 0
  return (
    <>
      <Panel title="Error diffusion, magnified" aside={`${kernelName}${serpentine ? ', serpentine' : ''}`}>
        <div className="pl-diffuse-wrap">
          <DiffuseGrid w={win.w} h={win.h} step={st} palette={palette} original={win.data} />
          {st && <DiffuseReadout step={st} palette={palette} />}
        </div>
        {!fromDither && <p className="small muted" style={{ margin: '8px 0 0' }}>Dither is not set to error diffusion, so this close-up uses Floyd–Steinberg.</p>}
      </Panel>
      <Narration tone={index === trace.length && index > 0 ? 'done' : undefined}>
        {!st && (
          <>
            A {win.w}×{win.h} window cut out of the image, before any pixel is decided. Each cell shows the colour that pixel <i>wants</i>. The scan
            starts top-left{serpentine ? ' and reverses direction every row' : ''}.
          </>
        )}
        {st && (
          <>
            Pixel ({st.x}, {st.y}) wants <Swatch c={st.want.map((v) => Math.max(0, Math.min(255, v)))} /> {rgbText(st.want)} — its own colour plus
            the error already pushed onto it. The nearest palette entry is <Swatch c={palette[st.chosen]} /> #{st.chosen}, off by{' '}
            <code>
{st.err.map(fmtE).join(' ')}
            </code>
            .
            {st.err.every((v) => Math.abs(v) < 0.5) ? (
              <> That colour is in the palette, so there is no error to pass on — the neighbours are left alone.</>
            ) : (
              <>
                {' '}That error goes to {inside.length} undecided neighbour{inside.length === 1 ? '' : 's'}
            {inside.length ? ` (${inside.map((p) => `${p.num}/${p.den}`).join(', ')})` : ''}.
            {passed < den && <> Only {passed}/{den} is passed on at all — the rest is deliberately dropped.</>}
            {lostEdge.length > 0 && <> {lostEdge.length} share{lostEdge.length === 1 ? '' : 's'} fall off the edge of the window and are lost.</>}
              </>
            )}
          </>
        )}
      </Narration>
    </>
  )
}

