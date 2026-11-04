import { useEffect, useMemo, useRef, useState } from 'react'
import { hex2, int, fmt } from '../../lib/text'
import { useTheme } from '../../lib/theme'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { writePng } from '../png/pngfile'
import { H, W, hasAlpha, presetImage, type Preset } from './images'
import { OPS, OP_SIZE, bitFields, decode, encode, explain, rgbaToRgb, type Decision, type Emit, type Op, type QoiImage } from './qoi'
import { CacheGrid, Frame, OpLegend, OpMapCanvas, OP_HL, OP_LETTER, RgbaCanvas, Swatch } from './views'
import './qoi.css'

type Source = Preset | 'upload'

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'photo', label: 'Photo' },
  { value: 'ui', label: 'Screenshot' },
  { value: 'pixel', label: 'Pixel art' },
  { value: 'gradient', label: 'Gradient' },
  { value: 'sprite', label: 'Sprite α' },
  { value: 'noise', label: 'Noise' },
]

const PRESET_NOTE: Record<Source, string> = {
  photo: 'Soft light and film grain: mostly small steps, so DIFF and LUMA do the work.',
  ui: 'Flat panels and hard edges, like a screenshot: long runs, and a few colours the cache keeps finding again.',
  pixel: 'A 32 × 32 sprite scaled 4×: runs of four, and a tiny palette that lives in the cache.',
  gradient: 'A smooth colour ramp: every pixel a small step from the last.',
  sprite: 'A badge on transparency, with an antialiased rim and a soft shadow: the only image here that needs QOI_OP_RGBA.',
  noise: 'Nothing to predict: almost every pixel costs the full four-byte QOI_OP_RGB, so the file is bigger than raw.',
  upload: 'Your image, cover-cropped to 128 × 128. Transparency is kept.',
}

/** A good first pixel to look at in each preset. */
const DEFAULT_PIXEL: Record<Source, { x: number; y: number }> = {
  photo: { x: 70, y: 80 },
  ui: { x: 47, y: 77 },
  pixel: { x: 46, y: 58 },
  gradient: { x: 40, y: 30 },
  sprite: { x: 24, y: 62 },
  noise: { x: 64, y: 64 },
  upload: { x: 64, y: 64 },
}

async function loadUpload(file: File): Promise<QoiImage> {
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const s = Math.max(W / bmp.width, H / bmp.height)
  ctx.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s)
  const rgba = new Uint8Array(ctx.getImageData(0, 0, W, H).data)
  return { width: W, height: H, channels: hasAlpha(rgba) ? 4 : 3, colorspace: 0, rgba }
}

async function browserPngSize(img: QoiImage): Promise<number | null> {
  try {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    const d = ctx.createImageData(img.width, img.height)
    d.data.set(img.rgba)
    ctx.putImageData(d, 0, 0)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
    return blob ? blob.size : null
  } catch {
    return null
  }
}

/** Best-of-k wall time in ms. */
function time(fn: () => void, k: number): number {
  let best = Infinity
  for (let i = 0; i < k; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

const sgn = (v: number) => (v > 0 ? '+' + v : v < 0 ? '−' + -v : '0')
const rgbaText = (c: ArrayLike<number>, alpha = true) => `(${c[0]}, ${c[1]}, ${c[2]}${alpha ? ', ' + c[3] : ''})`

export function Qoi() {
  const [source, setSource] = useState<Source>('photo')
  const [upload, setUpload] = useState<QoiImage | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const theme = useTheme(pageRef)
  const fileInput = useRef<HTMLInputElement>(null)

  const img = useMemo<QoiImage>(() => (source === 'upload' && upload ? upload : presetImage(source === 'upload' ? 'photo' : source)), [source, upload])
  const n = img.width * img.height
  const enc = useMemo(() => encode(img), [img])
  const roundTrip = useMemo(() => {
    const d = decode(enc.bytes)
    if (d.rgba.length !== img.rgba.length) return false
    for (let i = 0; i < d.rgba.length; i++) if (d.rgba[i] !== img.rgba[i]) return false
    return true
  }, [enc, img])
  const decoded = useMemo(() => decode(enc.bytes).rgba, [enc])

  const png = useMemo(() => {
    const alpha = img.channels === 4
    return writePng(alpha ? img.rgba : rgbaToRgb(img.rgba), img.width, img.height, alpha ? 6 : 2, 'adaptive')
  }, [img])
  const [browserPng, setBrowserPng] = useState<number | null>(null)
  const [timing, setTiming] = useState<{ qoiEnc: number; qoiDec: number; pngEnc: number } | null>(null)
  useEffect(() => {
    let live = true
    setBrowserPng(null)
    setTiming(null)
    browserPngSize(img).then((s) => live && setBrowserPng(s))
    // Time after paint so the page is not blocked while you look at it.
    const id = window.setTimeout(() => {
      if (!live) return
      const alpha = img.channels === 4
      const rgb = alpha ? img.rgba : rgbaToRgb(img.rgba)
      const qoiEnc = time(() => encode(img), 5)
      const qoiDec = time(() => decode(enc.bytes), 5)
      const pngEnc = time(() => writePng(rgb, img.width, img.height, alpha ? 6 : 2, 'adaptive'), 2)
      if (live) setTiming({ qoiEnc, qoiDec, pngEnc })
    }, 250)
    return () => {
      live = false
      window.clearTimeout(id)
    }
  }, [img, enc])

  // Stepper over pixels in scan order.
  const s = useStepper(n, { speed: 4, resetKey: source + (upload ? upload.rgba.length : 0) })
  useEffect(() => {
    const d = DEFAULT_PIXEL[source]
    s.setIndex(d.y * img.width + d.x)
  }, [source, upload])
  const p = s.index
  const sel = { x: p % img.width, y: Math.floor(p / img.width) }
  const { d, cache } = useMemo(() => explain(img, enc, p), [img, enc, p])

  const raw = n * img.channels
  const totalOpBytes = OPS.reduce((t, op) => t + enc.byteCount[op], 0)

  const download = () => {
    const url = URL.createObjectURL(new Blob([enc.bytes as BlobPart], { type: 'image/qoi' }))
    const a = document.createElement('a')
    a.href = url
    a.download = (source === 'upload' ? 'upload' : source) + '.qoi'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div ref={pageRef}>
      <Page
        slug="qoi"
        lede={
          <>
            <p>
              In late 2021 Dominic Szablewski published an image format implemented in about 300 lines of C, and found it within a few per cent
              of PNG’s size at many times the speed. There is no entropy coder, no filter search and nothing that works bit by bit. Each pixel is
              written as one of <b>six byte-aligned operations</b>, tried in order: <i>same as the last pixel</i>, <i>a colour I saw recently</i>,{' '}
              <i>a tiny step</i>, <i>a small step</i>, and finally <i>here is the colour</i>. The whole specification fits on one page, and this
              page implements all of it.
            </p>
          </>
        }
      >
        <Bench
          side={
            <>
              <Group title="Image">
                <Segmented<Source>
                  value={source}
                  onChange={setSource}
                  options={[...PRESETS.map((o) => ({ value: o.value as Source, label: o.label })), ...(upload ? [{ value: 'upload' as Source, label: 'Yours' }] : [])]}
                />
                <Button kind="ghost" onClick={() => fileInput.current?.click()}>
                  Upload your own…
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    try {
                      setUpload(await loadUpload(f))
                      setSource('upload')
                    } catch {
                      /* not an image the browser can read */
                    }
                  }}
                />
                <p className="small muted">{PRESET_NOTE[source]}</p>
              </Group>
              <Group title="Result">
                <Stats>
                  <Stat label="QOI file" value={int(enc.bytes.length)} sub="bytes" tone="accent" />
                  <Stat label="of raw" value={fmt((100 * enc.bytes.length) / raw, 1) + '%'} sub={`raw ${int(raw)} B`} help="Raw = width × height × channels: 3 bytes a pixel, or 4 with alpha." />
                  <Stat label="bits / pixel" value={fmt((8 * enc.bytes.length) / n, 2)} sub={`of ${img.channels * 8}`} />
                  <Stat
                    label="round trip"
                    value={roundTrip ? '✓' : '✗'}
                    tone={roundTrip ? 'good' : 'bad'}
                    sub="decoded = original"
                    help="The .qoi file is decoded again by this page's decoder and compared with the original pixel by pixel."
                  />
                </Stats>
                <Button onClick={download}>Download this .qoi ({int(enc.bytes.length)} B)</Button>
              </Group>
            </>
          }
        >
          <Panel title="Every pixel, and the op that coded it" aside={`${img.width} × ${img.height} · ${img.channels === 4 ? 'RGBA' : 'RGB'} · click to pick a pixel`}>
            <div className="qo-panes">
              <Frame w={img.width} h={img.height} sel={sel} onPick={(x, y) => s.setIndex(y * img.width + x)} checker title="Original" sub={`${int(raw)} bytes raw`}>
                <RgbaCanvas rgba={img.rgba} w={img.width} h={img.height} />
              </Frame>
              <Frame w={img.width} h={img.height} sel={sel} onPick={(x, y) => s.setIndex(y * img.width + x)} title="Op map" sub="each pixel in its op’s colour">
                <OpMapCanvas opOf={enc.opOf} w={img.width} h={img.height} colors={theme.hl} />
              </Frame>
              <Frame
                w={img.width}
                h={img.height}
                sel={sel}
                onPick={(x, y) => s.setIndex(y * img.width + x)}
                checker
                title="Decoded from the .qoi"
                sub={roundTrip ? 'identical, every pixel' : 'MISMATCH'}
              >
                <RgbaCanvas rgba={decoded} w={img.width} h={img.height} />
              </Frame>
            </div>
            <OpLegend pixels={enc.pixelCount} bytes={enc.byteCount} total={n} totalBytes={totalOpBytes} />
          </Panel>

          <Panel title={`Pixel (${sel.x}, ${sel.y}) — six questions, in order`} aside={`pixel ${int(p)} in scan order`}>
            <div className="qo-step">
              <div>
                <Magnifier img={img} opOf={enc.opOf} p={p} onPick={s.setIndex} />
                <div className="qo-mag-caption">Scan order runs left to right, top to bottom. Solid: already coded. Faded: not yet. Dashed: the previous pixel.</div>
              </div>
              <div>
                <div className="qo-pair">
                  <span>
                    previous <Swatch c={d.prev} /> {rgbaText(d.prev, img.channels === 4)}
                  </span>
                  <span>→</span>
                  <span>
                    this <Swatch c={d.px} /> {rgbaText(d.px, img.channels === 4)}
                  </span>
                </div>
                <Cascade d={d} alpha={img.channels === 4} />
                <Emitted d={d} />
              </div>
            </div>
          </Panel>

          <Narration tone={s.atEnd ? 'done' : undefined}>
            <Explain d={d} n={n} />
          </Narration>

          <Transport s={s} label={(i) => `pixel ${int(i)} / ${int(n - 1)}`} />

          <Panel title="The colour cache — 64 slots" aside={`slot ${d.slot} = hash${rgbaText(d.px)}`}>
            <div className="qo-cache-wrap">
              <CacheGrid cache={cache} slot={d.slot} wrote={!d.same && !d.indexHit} />
              <div className="small">
                <p style={{ marginTop: 0 }}>
                  Every colour the encoder writes goes into slot <code>(3r + 5g + 7b + 11a) mod 64</code>, replacing whatever was there. The
                  decoder computes the same slot for every pixel it decodes, so both keep identical caches without ever sending one.
                </p>
                <p>
                  {d.same ? (
                    <>This pixel is part of a run, so the cache is not touched.</>
                  ) : d.indexHit ? (
                    <>
                      Slot <b>{d.slot}</b> (solid outline) already held this colour: a one-byte <code>QOI_OP_INDEX</code>.
                    </>
                  ) : (
                    <>
                      Slot <b>{d.slot}</b> (dashed outline) {isEmpty(d.cached) ? 'was empty' : <>held {rgbaText(d.cached)}</>}; this colour has
                      just replaced it.
                    </>
                  )}
                </p>
                <p className="muted">
                  It is a hash table with no collision handling at all: two colours with the same slot simply evict each other. Unlike a GIF
                  palette it costs nothing to send, and it adapts as the image changes.
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Where the bytes go" aside={`${int(totalOpBytes)} bytes of ops + 14 header + 8 end marker`}>
            <Usage enc={enc} n={n} total={totalOpBytes} />
            <HexWindow bytes={enc.bytes} emits={enc.emits} current={d.emitted} />
          </Panel>

          <Panel title="How big is it" aside="same pixels, four ways">
            <SizeBars
              unit="bytes"
              rows={[
                { label: 'raw', value: raw, tone: 'faint', note: `${img.channels} bytes a pixel` },
                { label: 'QOI', value: enc.bytes.length, note: 'this page' },
                { label: 'PNG (ours)', value: png.bytes.length, tone: 'ink', note: 'adaptive filters + this site’s DEFLATE' },
                ...(browserPng !== null ? [{ label: 'PNG (browser)', value: browserPng, tone: 'ink', note: 'canvas.toBlob — always RGBA' }] : []),
              ]}
            />
            <div className="qo-timing">
              {timing ? (
                <Stats>
                  <Stat label="QOI encode" value={fmt(timing.qoiEnc, 1) + ' ms'} tone="accent" help="Best of five runs of this page's JavaScript encoder." />
                  <Stat label="QOI decode" value={fmt(timing.qoiDec, 1) + ' ms'} />
                  <Stat
                    label="PNG encode"
                    value={fmt(timing.pngEnc, 1) + ' ms'}
                    help="This site's PNG writer: libpng's adaptive filter choice, then the from-scratch DEFLATE with hash chains and lazy matching. Both are plain JavaScript written for clarity, not speed — the ratio is the point, not the numbers."
                  />
                  <Stat label="PNG ÷ QOI" value={fmt(timing.pngEnc / Math.max(0.01, timing.qoiEnc), 0) + '×'} sub="encode time" />
                </Stats>
              ) : (
                <p className="small muted">Timing the two encoders…</p>
              )}
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                Timings are for this site’s own JavaScript implementations, on your machine. In C the reference QOI encoder is reported 20–50× faster
                than libpng; the shape of the gap, not its size, is what carries over.
              </p>
            </div>
          </Panel>
        </Bench>

        <Notes>
          <h2>The whole format</h2>
          <Code>{`header   "qoif"  width:u32 BE  height:u32 BE  channels:u8 (3|4)  colorspace:u8 (0 sRGB, 1 linear)

QOI_OP_RGB    11111110 rrrrrrrr gggggggg bbbbbbbb
QOI_OP_RGBA   11111111 rrrrrrrr gggggggg bbbbbbbb aaaaaaaa
QOI_OP_INDEX  00iiiiii                         i = (3r + 5g + 7b + 11a) mod 64
QOI_OP_DIFF   01 dr dg db                      each −2…1, stored +2
QOI_OP_LUMA   10 dg(6)   dr−dg(4) db−dg(4)     dg −32…31 (+32), the others −8…7 (+8)
QOI_OP_RUN    11 rrrrrr                        1…62 pixels, stored −1

end      00 00 00 00 00 00 00 01
start    previous pixel (0, 0, 0, 255), cache all zeros, differences wrap mod 256`}</Code>
          <p>
            The 2-bit tags are checked after the two 8-bit ones: <code>11111110</code> and <code>11111111</code> would otherwise read as runs of 63
            and 64, which is exactly why a run stops at 62. Differences wrap, so a channel going from 255 to 0 is a step of +1 and still fits in a
            DIFF.
          </p>
          <h2>Design: give up the last 10–20%</h2>
          <p>
            Szablewski’s post, <i>“Lossless Image Compression in O(n) Time”</i> (November 2021), starts from irritation with how complex PNG,
            and especially its libraries, had become. QOI makes three choices that PNG does not:
          </p>
          <ul>
            <li>
              <b>No entropy coder.</b> PNG ends in DEFLATE: LZ77 and Huffman, bit by bit. QOI’s ops are whole bytes chosen so the common cases
              are short. That gives up some ratio and wins enormous speed: no bit buffer, no tables, one branch per pixel.
            </li>
            <li>
              <b>One fixed predictor.</b> PNG lets each row pick one of five filters and leaves the choice to a heuristic. QOI always predicts “same
              as the pixel to the left” and codes the difference, which on a scan line is almost as good.
            </li>
            <li>
              <b>A hash cache instead of a palette.</b> A colour seen recently costs one byte. Nothing is sent to build it, collisions just
              overwrite, and it follows the image as it changes — a dictionary coder’s idea at the scale of single pixels.
            </li>
          </ul>
          <h2>Why LUMA is anchored on green</h2>
          <p>
            In natural images the three channels rise and fall together: a pixel that gets brighter usually gets brighter in red, green and blue.
            So after you know how green changed, red’s and blue’s changes are close to it, and their <i>differences from green</i> fit in 4 bits
            each while green itself gets 6. Green is the anchor because it carries most of the perceived brightness — the same trick as the YCbCr
            conversion in <a href="#/jpeg">JPEG</a> and the “subtract green” transform in WebP lossless. Try the gradient: almost every pixel is
            DIFF or LUMA.
          </p>
          <h2>Against PNG</h2>
          <p>
            <a href="#/png">PNG</a> predicts from up to three neighbours, then hands the residuals to <a href="#/deflate">DEFLATE</a>, which can
            find a repeated row 30 000 bytes back and give a common residual a 2-bit code. QOI sees one pixel back and writes whole bytes. That is
            why PNG pulls ahead on the screenshot and on repetitive pixel art, where long-distance repeats exist, and why QOI stays close on
            photographs, where they do not. On noise both lose; QOI loses by about a third, because nearly every pixel becomes a 4-byte{' '}
            <code>QOI_OP_RGB</code>.
          </p>
          <h2>What it leaves out</h2>
          <ul>
            <li>No metadata: no colour profile beyond the sRGB/linear flag, no gamma, no text, no EXIF.</li>
            <li>No chunks or streaming structure, no interlacing, no animation, no 16-bit channels, no palette mode.</li>
            <li>No checksum: a corrupt file decodes to wrong pixels rather than an error.</li>
            <li>
              The format is frozen: the author declared the 1.0 spec final, so improvements proposed afterwards — a “QOI 2” with better ops, or
              Nigel Tao’s QOIR, which adds LZ4 and tiling — are separate formats rather than versions.
            </li>
          </ul>
          <h2>Where it turns up</h2>
          <p>
            Its appeal is that one person can implement it correctly in a day. It turns up in game engines and asset pipelines, emulators and
            screenshot tools, image libraries that added it as an option (stb-style single headers, ImageMagick, GIMP, FFmpeg have read or write
            support), and in embedded and hobby projects that want a fast lossless format without linking zlib.
          </p>
          <div className="aside">
            A subtlety the step-through hides: the reference decoder files every decoded pixel in the cache, runs included, while the encoder
            skips runs. They can only ever disagree about the starting pixel (0, 0, 0, 255): if an image opens with opaque black, the decoder
            puts it in slot 53 and the encoder does not. That is harmless, because the encoder only emits an index for a colour it stored
            itself, and whatever it stored the decoder stored too.
          </div>
        </Notes>
      </Page>
    </div>
  )
}

const isEmpty = (c: ArrayLike<number>) => c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 0

/** An 11 × 7 window of pixels around the current one, coded pixels tagged with their op. */
function Magnifier({ img, opOf, p, onPick }: { img: QoiImage; opOf: Uint8Array; p: number; onPick: (i: number) => void }) {
  const MW = 11
  const MH = 7
  const x0 = Math.max(0, Math.min(img.width - MW, (p % img.width) - 5))
  const y0 = Math.max(0, Math.min(img.height - MH, Math.floor(p / img.width) - 3))
  const prevIndex = p - 1
  const cells = []
  for (let y = y0; y < y0 + MH; y++)
    for (let x = x0; x < x0 + MW; x++) {
      const q = y * img.width + x
      const c = img.rgba.subarray(q * 4, q * 4 + 4)
      const op = OPS[opOf[q]]
      cells.push(
        <span
          key={q}
          className={'qo-mag-cell qo-checker' + (q === p ? ' cur' : q === prevIndex ? ' prev' : '') + (q > p ? ' future' : '')}
          onClick={() => onPick(q)}
          title={`(${x}, ${y}) rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]}) — ${op}`}
        >
          <i style={{ background: `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(3)})` }} />
          {q <= p && <b className={OP_HL[op]}>{OP_LETTER[op]}</b>}
        </span>,
      )
    }
  return (
    <div className="qo-mag" style={{ gridTemplateColumns: `repeat(${MW}, minmax(0, 1fr))` }}>
      {cells}
    </div>
  )
}

/** The decision cascade, row by row, with the one that fired highlighted. */
function Cascade({ d, alpha }: { d: Decision; alpha: boolean }) {
  type Row = { op: Op | 'RGB/RGBA'; q: string; detail: string; state: 'hit' | 'no' | 'skip' }
  const rows: Row[] = []
  let done = false
  const push = (op: Row['op'], q: string, detail: string, hit: boolean) => {
    rows.push({ op, q, detail, state: done ? 'skip' : hit ? 'hit' : 'no' })
    if (hit) done = true
  }
  push('RUN', 'Same as the previous pixel?', d.same ? `yes — run is now ${d.run}` : 'no', d.same)
  push('INDEX', `Is it in cache slot ${d.slot}?`, d.same ? '' : d.indexHit ? 'yes, exactly this colour' : isEmpty(d.cached) ? 'slot is empty' : `slot holds ${rgbaText(d.cached, alpha)}`, d.indexHit)
  if (alpha) push('RGBA', 'Did alpha change?', d.same || d.indexHit ? '' : d.alphaSame ? 'no' : `yes, ${d.prev[3]} → ${d.px[3]}`, !d.same && !d.indexHit && !d.alphaSame)
  push('DIFF', 'dr, dg, db all within −2…1?', `dr ${sgn(d.dr)}  dg ${sgn(d.dg)}  db ${sgn(d.db)}`, d.op === 'DIFF')
  push('LUMA', 'dg in −32…31, and dr−dg, db−dg in −8…7?', `dg ${sgn(d.dg)}  dr−dg ${sgn(d.drdg)}  db−dg ${sgn(d.dbdg)}`, d.op === 'LUMA')
  push('RGB', 'Otherwise: send the colour', '4 bytes', d.op === 'RGB')
  return (
    <table className="qo-cascade">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.state}>
            <td>{r.state === 'hit' ? '✓' : r.state === 'no' ? '✗' : '·'}</td>
            <td>
              <span className={'opname ' + OP_HL[r.op as Op]}>{r.op}</span>
              {r.q}
              {r.state !== 'skip' && r.detail && <small>{r.detail}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The bytes written while handling this pixel, with their bit fields. */
function Emitted({ d }: { d: Decision }) {
  if (d.emitted.length === 0)
    return (
      <div className="qo-emits">
        <div className="qo-emit muted">Nothing written yet — the run keeps counting.</div>
      </div>
    )
  return (
    <div className="qo-emits">
      {d.emitted.map((e, i) => (
        <EmitRow key={i} e={e} />
      ))}
    </div>
  )
}

function EmitRow({ e }: { e: Emit }) {
  return (
    <div className="qo-emit">
      <span className={'opname ' + OP_HL[e.op]} style={{ padding: '0 5px', borderRadius: 3, fontWeight: 600 }}>
        QOI_OP_{e.op}
      </span>
      <span className="bytes">
        {e.bytes.map((b, k) => (
          <span key={k} className={OP_HL[e.op]}>
            {hex2(b)}
          </span>
        ))}
      </span>
      <span className="qo-fields">
        {bitFields(e).map((f, k) => (
          <span key={k} className={f.kind}>
            {f.bits}
            <small>{f.label}</small>
          </span>
        ))}
      </span>
      <span className="muted">
        at byte {e.offset}
        {e.op === 'RUN' && ` · covers ${e.pixels} pixel${e.pixels === 1 ? '' : 's'}`}
      </span>
    </div>
  )
}

/** What happened at this pixel, in a sentence or two. */
function Explain({ d, n }: { d: Decision; n: number }) {
  const flushed = d.emitted.find((e) => e.op === 'RUN' && !d.same)
  const pre = flushed ? (
    <>
      First the pending run of {flushed.pixels} is written as one byte, <code>{hex2(flushed.bytes[0])}</code>.{' '}
    </>
  ) : null
  const wrapNote =
    Math.abs(d.px[0] - d.prev[0]) > 128 || Math.abs(d.px[1] - d.prev[1]) > 128 || Math.abs(d.px[2] - d.prev[2]) > 128 ? (
      <> (A channel crossed 255 ↔ 0: differences wrap, so that was a small step.)</>
    ) : null
  if (d.same) {
    const own = d.emitted[0]
    if (own && own.pixels === 62)
      return (
        <>
          Same as the previous pixel again — and the run has reached <b>62</b>, the most six bits can say (63 and 64 are taken by the RGB and RGBA
          tags). It is written now as <code>{hex2(own.bytes[0])}</code> and a fresh run starts.
        </>
      )
    if (own && d.p === n - 1)
      return (
        <>
          Same as the previous pixel, and it is the last one: the run of {own.pixels} is written as <code>{hex2(own.bytes[0])}</code>, then the
          end marker.
        </>
      )
    return (
      <>
        Same colour as the previous pixel, so nothing is written: the run counter goes to <b>{d.run}</b>. One byte will cover up to 62 such pixels
        when the run ends.
      </>
    )
  }
  if (d.op === 'INDEX')
    return (
      <>
        {pre}A different colour from the last pixel — but its hash is <b>{d.slot}</b>, and slot {d.slot} already holds exactly this colour. One
        byte: <code>{hex2(d.slot)}</code>, the slot number with tag <code>00</code>.
      </>
    )
  const miss = (
    <>
      Not in the cache (slot {d.slot} {isEmpty(d.cached) ? 'was empty' : <>held {rgbaText(d.cached)}</>}), so it goes in now.{' '}
    </>
  )
  if (d.op === 'DIFF')
    return (
      <>
        {pre}
        {miss}Every channel moved by at most a step — dr {sgn(d.dr)}, dg {sgn(d.dg)}, db {sgn(d.db)} — so two bits each fit them all in one
        byte: <b>DIFF</b>.{wrapNote}
      </>
    )
  if (d.op === 'LUMA')
    return (
      <>
        {pre}
        {miss}Too big for DIFF, but green moved {sgn(d.dg)} and red and blue moved almost with it ({sgn(d.drdg)} and {sgn(d.dbdg)} relative to
        green): <b>LUMA</b>, two bytes.{wrapNote}
      </>
    )
  if (d.op === 'RGBA')
    return (
      <>
        {pre}
        {miss}Alpha changed from {d.prev[3]} to {d.px[3]}, and only one op can say that: <b>RGBA</b>, five bytes — the most expensive pixel QOI
        has.
      </>
    )
  return (
    <>
      {pre}
      {miss}Out of reach of LUMA (dg {sgn(d.dg)}, dr−dg {sgn(d.drdg)}, db−dg {sgn(d.dbdg)}), so the colour goes out whole: <b>RGB</b>, four
      bytes — more than the three it would take raw.
    </>
  )
}

/** Per-op usage: how many pixels each op covered and how many bytes it cost. */
function Usage({ enc, n, total }: { enc: ReturnType<typeof encode>; n: number; total: number }) {
  return (
    <div className="qo-usage">
      <div className="qo-usage-row qo-usage-head">
        <span>op</span>
        <span>
          pixels <Help text="Share of the image's pixels this op coded. A RUN op covers many pixels with one byte." />
        </span>
        <span>bytes</span>
        <span className="nums">ops · bytes/pixel</span>
      </div>
      {OPS.map((op) => (
        <div className="qo-usage-row" key={op}>
          <span className={'opname ' + OP_HL[op]} style={{ padding: '0 5px', borderRadius: 3, fontWeight: 600, justifySelf: 'start' }}>
            {op}
          </span>
          <span className="bar">
            <i className={OP_HL[op]} style={{ width: `${(100 * enc.pixelCount[op]) / n}%` }} />
          </span>
          <span className="bar">
            <i className={OP_HL[op]} style={{ width: `${(100 * enc.byteCount[op]) / Math.max(1, total)}%` }} />
          </span>
          <span className="nums">
            {int(enc.opCount[op])} × {OP_SIZE[op]} B ·{' '}
            {enc.pixelCount[op] ? fmt(enc.byteCount[op] / enc.pixelCount[op], 2) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A window of the file's bytes around the current op, coloured by op. */
function HexWindow({ bytes, emits, current }: { bytes: Uint8Array; emits: Emit[]; current: Emit[] }) {
  const byteOp = useMemo(() => {
    const m = new Int8Array(bytes.length).fill(-1)
    for (const e of emits) for (let k = 0; k < e.bytes.length; k++) m[e.offset + k] = OPS.indexOf(e.op)
    return m
  }, [bytes, emits])
  const curSet = new Set<number>()
  for (const e of current) for (let k = 0; k < e.bytes.length; k++) curSet.add(e.offset + k)
  const anchor = current.length ? current[0].offset : 14
  const LEN = 40
  const start = Math.max(0, Math.min(bytes.length - LEN, anchor - 12))
  const slice = bytes.subarray(start, start + LEN)
  return (
    <div className="qo-hex">
      <p className="small muted" style={{ margin: '14px 0 6px' }}>
        The file around this pixel’s bytes (bytes {start}–{start + slice.length - 1} of {bytes.length}). Grey: header or end marker.
      </p>
      <Tape
        bytes={slice}
        render={(i) => hex2(slice[i])}
        mark={(i) => {
          const at = start + i
          const k = byteOp[at]
          const base = k < 0 ? '' : OP_HL[OPS[k]]
          return (curSet.has(at) ? 'cur ' : curSet.size ? 'dim ' : '') + base
        }}
        cellTitle={(i) => {
          const at = start + i
          const k = byteOp[at]
          return `byte ${at}: 0x${hex2(bytes[at])}${k < 0 ? (at < 14 ? ' — header' : ' — end marker') : ' — ' + OPS[k]}`
        }}
      />
    </div>
  )
}
