import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStepper } from '../../lib/useStepper'
import { useTheme } from '../../lib/theme'
import { fmt, int } from '../../lib/text'
import { Button, Group, Help, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { BitRow } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { ZIGZAG, encodeImage, idct, overheadBytes, partialRecon, type Block, type Sym } from './jpeg'
import { SIZE, noise, sphere, zonePlate } from './images'
import { BasisAtlas, GreyCanvas, ImagePane, Matrix } from './views'
import './jpeg.css'

type Preset = 'sphere' | 'text' | 'zone' | 'noise' | 'upload'

const DEFAULT_BLOCK: Record<Preset, { bx: number; by: number }> = {
  sphere: { bx: 9, by: 9 },
  text: { bx: 5, by: 6 },
  zone: { bx: 22, by: 12 },
  noise: { bx: 16, by: 16 },
  upload: { bx: 16, by: 16 },
}

/** Sharp black text and lines on white: the worst case for a DCT codec. */
function textImage(): Uint8ClampedArray {
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.fillStyle = '#000'
  ctx.font = 'bold 74px "IBM Plex Sans", Arial, sans-serif'
  ctx.fillText('JPEG', 22, 96)
  ctx.font = '15px "IBM Plex Mono", monospace'
  ctx.fillText('ringing lives at edges', 16, 136)
  ctx.font = '11px "IBM Plex Mono", monospace'
  ctx.fillText('small text smears first: 0123456789', 16, 156)
  ctx.lineWidth = 1
  for (let i = 0; i < 9; i++) {
    ctx.beginPath()
    ctx.moveTo(16 + i * 12, 176)
    ctx.lineTo(16 + i * 12 + 40, 240)
    ctx.stroke()
  }
  ctx.fillRect(150, 178, 56, 56)
  ctx.fillStyle = '#888'
  ctx.fillRect(206, 178, 34, 56)
  return toLuma(ctx.getImageData(0, 0, SIZE, SIZE).data)
}

function toLuma(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])
  return out
}

/** Decode an uploaded file, cover-fit it into 256 × 256 and take its luma (BT.601 weights, as JFIF does). */
async function loadUpload(file: File): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d')!
  const s = Math.max(SIZE / bmp.width, SIZE / bmp.height)
  const w = bmp.width * s
  const h = bmp.height * s
  ctx.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
  return toLuma(ctx.getImageData(0, 0, SIZE, SIZE).data)
}

function busiestBlock(luma: Uint8ClampedArray): { bx: number; by: number } {
  let best = { bx: 16, by: 16 }
  let bestVar = -1
  for (let by = 4; by < 28; by++)
    for (let bx = 4; bx < 28; bx++) {
      let s = 0
      let s2 = 0
      for (let i = 0; i < 64; i++) {
        const v = luma[(by * 8 + (i >> 3)) * SIZE + bx * 8 + (i & 7)]
        s += v
        s2 += v * v
      }
      const vr = s2 / 64 - (s / 64) ** 2
      if (vr > bestVar) {
        bestVar = vr
        best = { bx, by }
      }
    }
  return best
}

const STEPS = ['Pixels', 'Level shift', 'DCT', 'Quant table', 'Quantize', 'Zigzag', 'Entropy code', 'Dequantize', 'Inverse DCT', 'Error'] as const

export function Jpeg() {
  const [preset, setPreset] = useState<Preset>('sphere')
  const [upload, setUpload] = useState<Uint8ClampedArray | null>(null)
  const [quality, setQuality] = useState(50)
  const [sel, setSel] = useState(DEFAULT_BLOCK.sphere)
  const [errorGain, setErrorGain] = useState(true)
  const [hot, setHot] = useState<number | null>(null)
  const [keep, setKeep] = useState(6)
  const pageRef = useRef<HTMLDivElement>(null)
  const theme = useTheme(pageRef)

  const luma = useMemo(() => {
    if (preset === 'upload' && upload) return upload
    if (preset === 'text') return textImage()
    if (preset === 'zone') return zonePlate()
    if (preset === 'noise') return noise()
    return sphere()
  }, [preset, upload])

  const enc = useMemo(() => encodeImage(luma, SIZE, SIZE, quality), [luma, quality])
  const block = enc.blocks[sel.by * (SIZE / 8) + sel.bx]

  // The real .jpg, decoded by the browser's own JPEG decoder.
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([enc.file as BlobPart], { type: 'image/jpeg' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [enc])

  const errorImg = useMemo(() => {
    const out = new Uint8ClampedArray(SIZE * SIZE)
    const g = errorGain ? 8 : 1
    for (let i = 0; i < out.length; i++) out[i] = 128 + g * (enc.recon[i] - luma[i])
    return out
  }, [enc, luma, errorGain])

  const s = useStepper(STEPS.length, { speed: 1 })

  const pick = (bx: number, by: number) => setSel({ bx, by })
  const choosePreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'upload') setSel(DEFAULT_BLOCK[p])
  }

  const bitsByKind = useMemo(() => {
    const t = { dcCode: 0, dcExtra: 0, acCode: 0, acExtra: 0, eob: 0 }
    for (const b of enc.blocks)
      for (const x of b.syms) {
        if (x.kind === 'DC') {
          t.dcCode += x.code.length
          t.dcExtra += x.extra.length
        } else if (x.kind === 'AC') {
          t.acCode += x.code.length
          t.acExtra += x.extra.length
        } else t.eob += x.code.length
      }
    return t
  }, [enc])

  const rawBytes = SIZE * SIZE
  const zeros = Array.from(block.q).filter((v) => v === 0).length

  return (
    <div ref={pageRef}>
      <Page
        slug="jpeg"
        lede={
          <p>
            Every lossless coder on this site has to give back the exact bytes. JPEG does not, and that changes everything: it moves each 8×8
            block of pixels into the frequency domain, where a photograph’s energy piles up in a handful of smooth, low-frequency coefficients,
            then <b>rounds the rest away</b>. Everything after the rounding is lossless bookkeeping. The file on this page is a real baseline
            JPEG — your browser is decoding it.
          </p>
        }
      >
        <Bench
          side={
            <>
              <Group title="Image">
                <Segmented
                  value={preset}
                  onChange={choosePreset}
                  options={[
                    { value: 'sphere', label: 'Sphere', title: 'smooth shading and one hard edge' },
                    { value: 'text', label: 'Text', title: 'sharp edges — the worst case' },
                    { value: 'zone', label: 'Zone plate', title: 'every frequency at once' },
                    { value: 'noise', label: 'Noise', title: 'nothing to drop' },
                  ]}
                />
                <label className={'btn btn-ghost jp-upload' + (preset === 'upload' ? ' on' : '')}>
                  {preset === 'upload' ? 'Your image (choose another…)' : 'Upload your own…'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      try {
                        const l = await loadUpload(f)
                        setUpload(l)
                        setPreset('upload')
                        setSel(busiestBlock(l))
                      } catch {
                        /* unreadable image: keep the current one */
                      }
                    }}
                  />
                </label>
                <p className="small muted">Click any image to pick the 8×8 block to step through. Greyscale only — colour JPEG does the same thing three times.</p>
              </Group>
              <Group title="Quality" help="The libjpeg 1–100 scale. It does not mean anything by itself: it only scales the quantization table. 50 is the table printed in the standard; 100 divides by 1.">
                <Slider label="quality" value={quality} min={1} max={100} onChange={setQuality} />
                <div className="chips">
                  {[5, 15, 30, 50, 75, 90, 100].map((q) => (
                    <button key={q} type="button" className={'chip' + (q === quality ? ' on' : '')} onClick={() => setQuality(q)}>
                      {q}
                    </button>
                  ))}
                </div>
                <Stats>
                  <Stat label="file size" value={`${int(enc.file.length)} B`} tone="accent" help="The complete .jpg: entropy-coded data plus ~330 bytes of headers and tables." />
                  <Stat label="ratio" value={`${fmt(rawBytes / enc.file.length, 1)}:1`} sub={`vs ${int(rawBytes)} B raw`} />
                  <Stat label="bits / pixel" value={fmt((enc.file.length * 8) / rawBytes, 2)} help="Raw greyscale is 8 bits per pixel." />
                  <Stat
                    label="PSNR"
                    value={Number.isFinite(enc.psnr) ? `${fmt(enc.psnr, 1)} dB` : '∞'}
                    help="Peak signal-to-noise ratio: 10·log₁₀(255² / mean squared error). Around 30 dB looks rough, 40 dB is hard to tell apart, and it is a crude stand-in for what the eye actually sees."
                  />
                </Stats>
              </Group>
              <Group title="View">
                <Toggle label="Amplify error ×8" value={errorGain} onChange={setErrorGain} help="Mid-grey is no error. Brighter means the JPEG came out too light there, darker too dark." />
                <a className="btn btn-ghost" href={url ?? undefined} download={`playground-q${quality}.jpg`}>
                  Download this .jpg ({int(enc.file.length)} B)
                </a>
              </Group>
            </>
          }
        >
          <Panel title="Whole image" aside={`quality ${quality} · block (${sel.bx}, ${sel.by}) selected`}>
            <div className="jp-panes">
              <ImagePane title="Original" sub={`${int(rawBytes)} bytes`} data={luma} size={SIZE} sel={sel} onPick={pick} />
              <ImagePane title="The .jpg, decoded by your browser" sub={`${int(enc.file.length)} bytes`} size={SIZE} sel={sel} onPick={pick}>
                {url && <img src={url} alt={`JPEG at quality ${quality}`} className="jp-pixelated" />}
              </ImagePane>
              <ImagePane title={`Error${errorGain ? ' ×8' : ''}`} sub={`PSNR ${Number.isFinite(enc.psnr) ? fmt(enc.psnr, 1) + ' dB' : '∞'}`} data={errorImg} size={SIZE} sel={sel} onPick={pick} />
            </div>
          </Panel>

          <Panel title={`Block (${sel.bx}, ${sel.by}) — step ${s.index + 1}: ${STEPS[s.index]}`} aside={`${block.bits} bits vs 512 raw`}>
            <div className="jp-steps">
              {STEPS.map((name, i) => (
                <button key={name} type="button" className={i === s.index ? 'on' : i < s.index ? 'done' : ''} onClick={() => s.setIndex(i)}>
                  <small>{i + 1}</small>
                  {name}
                </button>
              ))}
            </div>
            <StepView step={s.index} block={block} table={enc.table} hot={hot} setHot={setHot} />
          </Panel>
          <Transport s={s} label={(i) => `${i + 1} / ${STEPS.length}`} />
          <Narration tone={s.index === STEPS.length - 1 ? 'done' : undefined}>
            <StepNarration step={s.index} block={block} table={enc.table} zeros={zeros} quality={quality} />
          </Narration>

          <Panel title="The 64 basis patterns" aside="hover one">
            <div className="jp-basis">
              <div className="jp-basis-atlas">
                <BasisAtlas live={block.q} hot={hot} onHover={setHot} theme={theme} />
                <p className="small muted">
                  Row = vertical frequency, column = horizontal. Outlined: the {64 - zeros} coefficient{64 - zeros === 1 ? '' : 's'} this block keeps at
                  quality {quality}.
                </p>
              </div>
              <BuildUp block={block} keep={keep} setKeep={setKeep} hot={hot} />
            </div>
          </Panel>

          <Panel title="Where the bits go" aside={`${int(enc.scanBits)} bits of entropy-coded data`}>
            <SizeBars
              rows={[
                { label: 'DC codes', value: bitsByKind.dcCode, note: 'size of Δ from last block' },
                { label: 'DC extra bits', value: bitsByKind.dcExtra, tone: 'faint' },
                { label: 'AC codes', value: bitsByKind.acCode, note: '(run, size) symbols' },
                { label: 'AC extra bits', value: bitsByKind.acExtra, tone: 'faint', note: 'coefficient values' },
                { label: 'EOB + ZRL', value: bitsByKind.eob, note: `${enc.blocks.length} blocks` },
                { label: 'headers', value: overheadBytes(enc) * 8, tone: 'ink', note: 'markers, tables, padding' },
              ]}
            />
          </Panel>
        </Bench>

        <JpegNotes />
      </Page>
    </div>
  )
}

// ---------------------------------------------------------------- one block

function Op({ children, label }: { children: ReactNode; label?: ReactNode }) {
  return (
    <div className="jp-op">
      <span>{children}</span>
      {label && <small>{label}</small>}
    </div>
  )
}

function StepView({ step, block, table, hot, setHot }: { step: number; block: Block; table: number[]; hot: number | null; setHot: (i: number | null) => void }) {
  const common = { hot, onHover: setHot }
  const ratio = useMemo(() => Array.from(block.coef, (c, i) => c / table[i]), [block, table])
  const err = useMemo(() => Array.from(block.recon, (r, i) => r - block.pixels[i]), [block])
  const coefScale = Math.max(1, ...Array.from(block.coef).slice(1).map(Math.abs))

  switch (step) {
    case 0:
      return (
        <div className="jp-flow">
          <Matrix values={block.pixels} mode="gray" label="pixels, 0…255" {...common} />
        </div>
      )
    case 1:
      return (
        <div className="jp-flow">
          <Matrix values={block.pixels} mode="gray" label="pixels" {...common} />
          <Op label="level shift">−128</Op>
          <Matrix values={block.shifted} mode="signed" label="centred on zero" scale={128} {...common} />
        </div>
      )
    case 2:
      return (
        <div className="jp-flow">
          <Matrix values={block.shifted} mode="signed" label="samples" scale={128} {...common} />
          <Op label="2-D DCT">→</Op>
          <Matrix values={block.coef} mode="signed" label="coefficients (DC top-left)" scale={coefScale} {...common} />
        </div>
      )
    case 3:
      return (
        <div className="jp-flow">
          <Matrix values={block.coef} mode="signed" label="coefficients" scale={coefScale} {...common} />
          <Op label="divide by">÷</Op>
          <Matrix values={table} mode="table" label="quantization table" scale={Math.max(...table)} {...common} />
        </div>
      )
    case 4:
      return (
        <div className="jp-flow">
          <Matrix values={ratio} mode="signed" digits={1} label="coefficient ÷ step" {...common} />
          <Op label="round">≈</Op>
          <Matrix values={block.q} mode="int" label="quantized integers" {...common} />
        </div>
      )
    case 5:
      return (
        <div className="jp-flow col">
          <Matrix values={block.q} mode="int" zigzag label="read along the zigzag" {...common} />
          <ZigzagStrip q={block.q} hot={hot} setHot={setHot} />
        </div>
      )
    case 6:
      return <SymbolTable syms={block.syms} prevDC={block.prevDC} dc={block.q[0]} />
    case 7:
      return (
        <div className="jp-flow">
          <Matrix values={block.q} mode="int" label="quantized" {...common} />
          <Op label="multiply by step">×</Op>
          <Matrix values={block.deq} mode="signed" label="dequantized coefficients" scale={coefScale} {...common} />
        </div>
      )
    case 8:
      return (
        <div className="jp-flow">
          <Matrix values={block.deq} mode="signed" label="dequantized" scale={coefScale} {...common} />
          <Op label="inverse DCT, +128">→</Op>
          <Matrix values={block.recon} mode="gray" label="decoded pixels" {...common} />
        </div>
      )
    default:
      return (
        <div className="jp-flow">
          <Matrix values={block.pixels} mode="gray" label="original" {...common} />
          <Matrix values={block.recon} mode="gray" label="decoded" {...common} />
          <Matrix values={err} mode="signed" label="decoded − original" scale={Math.max(8, ...err.map(Math.abs))} {...common} />
        </div>
      )
  }
}

function ZigzagStrip({ q, hot, setHot }: { q: ArrayLike<number>; hot: number | null; setHot: (i: number | null) => void }) {
  let last = 0
  for (let k = 63; k > 0; k--)
    if (q[ZIGZAG[k]] !== 0) {
      last = k
      break
    }
  return (
    <div className="jp-zzstrip" onMouseLeave={() => setHot(null)}>
      {ZIGZAG.map((n, k) => (
        <span
          key={k}
          className={'cell' + (q[n] !== 0 ? ' hl-1' : k > last ? ' dim' : '') + (hot === n ? ' cur' : '')}
          onMouseEnter={() => setHot(n)}
          title={`zigzag #${k} = row ${n >> 3}, col ${n & 7}`}
        >
          {q[n]}
          {k % 8 === 0 && <span className="cell-idx">{k}</span>}
        </span>
      ))}
    </div>
  )
}

const KIND_CLASS: Record<Sym['kind'], string> = { DC: 'hl-6', AC: 'hl-3', ZRL: 'hl-5', EOB: 'hl-2' }

function SymbolTable({ syms, prevDC, dc }: { syms: Sym[]; prevDC: number; dc: number }) {
  const [active, setActive] = useState<number | null>(null)
  let bits = ''
  const spans: { start: number; length: number; className: string; title: string }[] = []
  syms.forEach((x) => {
    const s = x.code + x.extra
    spans.push({ start: bits.length, length: s.length, className: KIND_CLASS[x.kind], title: `${x.kind}: ${x.code} ${x.extra}` })
    bits += s
  })
  return (
    <div className="jp-symbols">
      <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table className="data">
          <thead>
            <tr>
              <th>what</th>
              <th className="num">zz</th>
              <th className="num">
                run <Help text="How many zero coefficients were skipped (along the zigzag) before this one. Up to 15; a longer run is broken up with ZRL symbols, each worth 16 zeros." />
              </th>
              <th className="num">value</th>
              <th className="num">
                size <Help text="The category SSSS: how many bits the value needs. 1 covers ±1, 2 covers ±2…3, 3 covers ±4…7, and so on." />
              </th>
              <th>
                symbol <Help text="The byte the Huffman table actually codes: for DC just the size; for AC (run << 4) | size. The value itself is not Huffman-coded — it follows as `size` raw bits." />
              </th>
              <th>Huffman code</th>
              <th>extra bits</th>
            </tr>
          </thead>
          <tbody>
            {syms.map((x, i) => (
              <tr key={i} className={active === i ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
                <td>
                  <span className={'jp-kind ' + KIND_CLASS[x.kind]}>{x.kind === 'DC' ? 'DC Δ' : x.kind}</span>
                </td>
                <td className="num">{x.kind === 'EOB' ? `${x.k}…63` : x.k}</td>
                <td className="num">{x.kind === 'DC' ? '' : x.run}</td>
                <td className="num">{x.kind === 'DC' ? `${x.value >= 0 ? '+' : ''}${x.value}` : x.kind === 'AC' ? x.value : ''}</td>
                <td className="num">{x.size}</td>
                <td>0x{x.symbol.toString(16).padStart(2, '0')}</td>
                <td className="mono">{x.code}</td>
                <td className="mono">{x.extra}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: '10px 0 6px' }}>
        DC is coded as the change from the previous block: {dc} − {prevDC} = {dc - prevDC}. The block’s whole bitstream:
      </p>
      <BitRow bits={bits} spans={spans} active={active ?? undefined} onHover={setActive} />
      <div className="legend" style={{ marginTop: 8 }}>
        <span>
          <i className="hl-6" /> DC difference
        </span>
        <span>
          <i className="hl-3" /> AC (run, size) + value
        </span>
        <span>
          <i className="hl-5" /> ZRL (16 zeros)
        </span>
        <span>
          <i className="hl-2" /> EOB (rest are zero)
        </span>
      </div>
    </div>
  )
}

function StepNarration({ step, block, table, zeros, quality }: { step: number; block: Block; table: number[]; zeros: number; quality: number }) {
  const mean = block.pixels.reduce((a, b) => a + b, 0) / 64
  const dc = block.coef[0]
  let energyLow = 0
  let energy = 0
  for (let k = 0; k < 64; k++) {
    const e = block.coef[ZIGZAG[k]] ** 2
    energy += e
    if (k < 10) energyLow += e
  }
  const maxErr = Math.max(...Array.from(block.recon, (r, i) => Math.abs(r - block.pixels[i])))
  const nz = 64 - zeros
  const lastSym = block.syms[block.syms.length - 1]
  switch (step) {
    case 0:
      return (
        <>
          The 64 pixels of block ({block.bx}, {block.by}), mean brightness <b>{fmt(mean, 1)}</b>. Raw, they cost 64 × 8 = 512 bits. Click anywhere in
          the images to pick a different block.
        </>
      )
    case 1:
      return (
        <>
          Subtract 128 so the values sit around zero (−128…127). This changes nothing about the information; it just makes a flat mid-grey block
          turn into all zeros, so the DC coefficient is small for typical blocks.
        </>
      )
    case 2:
      return (
        <>
          The DCT rewrites the block as a weighted sum of the 64 cosine patterns below. DC = <b>{fmt(dc, 1)}</b>, which is 8 × the shifted mean (
          {fmt(mean - 128, 2)} × 8). The first 10 coefficients in zigzag order hold <b>{energy ? fmt((100 * energyLow) / energy, 1) : '100'}%</b> of
          the energy — nothing is lost yet, it has only been moved.
        </>
      )
    case 3:
      return (
        <>
          The quantization table at quality {quality}: step <b>{table[0]}</b> for DC up to <b>{Math.max(...table)}</b> for the finest detail. The
          steps grow towards the bottom-right because the eye barely sees high-frequency error. This table is stored in the file.
        </>
      )
    case 4:
      return (
        <>
          Divide each coefficient by its step and round to the nearest integer. <b>This is the only lossy step.</b> {zeros} of 64 coefficients
          became 0; {nz} survive. Whatever was below half a step is gone for good.
        </>
      )
    case 5:
      return (
        <>
          Read the integers along the zigzag, from low frequency to high, so the zeros clump at the end. Here everything after zigzag position{' '}
          {lastSym.kind === 'EOB' ? lastSym.k - 1 : 63} is zero — one end-of-block symbol will cover them all.
        </>
      )
    case 6:
      return (
        <>
          {block.syms.length} symbols, <b>{block.bits} bits</b> for this block — {fmt(block.bits / 64, 2)} bits per pixel instead of 8. Each symbol is a
          Huffman code from the standard’s Annex K tables, followed by the coefficient’s value as raw bits.
        </>
      )
    case 7:
      return (
        <>
          The decoder multiplies back. Every coefficient is now an exact multiple of its step — the rounding error from step 5 cannot be undone,
          and the zeroed coefficients stay zero.
        </>
      )
    case 8:
      return (
        <>
          The inverse DCT sums the surviving basis patterns, adds 128 back and clamps to 0…255. With only {nz} pattern{nz === 1 ? '' : 's'} left,
          sharp edges cannot be rebuilt exactly — the missing high frequencies show up as ripples (ringing) next to them.
        </>
      )
    default:
      return (
        <>
          Largest error in this block: <b>{maxErr}</b> grey levels. {maxErr <= 2 ? 'Invisible.' : maxErr <= 10 ? 'Hard to see on a photograph.' : 'Visible — drag quality down further and the blocks themselves appear.'} Each block was quantized on its own, so
          neighbouring blocks err differently: that seam is blocking.
        </>
      )
  }
}

// ------------------------------------------------------------- build-up view

function BuildUp({ block, keep, setKeep, hot }: { block: Block; keep: number; setKeep: (k: number) => void; hot: number | null }) {
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let k = keep >= 64 ? 0 : keep
    const id = setInterval(() => {
      k++
      setKeep(k)
      if (k >= 64) setPlaying(false)
    }, 160)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])
  const partial = useMemo(() => partialRecon(block.coef, keep), [block, keep])
  const contrib = useMemo(() => {
    if (hot === null) return null
    const F = new Float64Array(64)
    F[hot] = block.coef[hot]
    const f = idct(F)
    return Array.from(f, (v) => 128 + v)
  }, [block, hot])
  let e = 0
  let ek = 0
  for (let k = 0; k < 64; k++) {
    const x = block.coef[ZIGZAG[k]] ** 2
    e += x
    if (k < keep) ek += x
  }
  const v = hot !== null ? hot >> 3 : 0
  const u = hot !== null ? hot & 7 : 0
  return (
    <div className="jp-buildup">
      <div className="jp-tiles">
        <figure>
          <GreyCanvas data={partial} w={8} h={8} className="jp-tile" />
          <figcaption>first {keep} in zigzag</figcaption>
        </figure>
        <figure>
          <GreyCanvas data={block.pixels} w={8} h={8} className="jp-tile" />
          <figcaption>original block</figcaption>
        </figure>
        <figure>
          {contrib ? <GreyCanvas data={contrib} w={8} h={8} className="jp-tile" /> : <div className="jp-tile jp-tile-empty">hover a pattern</div>}
          <figcaption>{hot !== null ? `(${v}, ${u}) × ${fmt(block.coef[hot], 1)}` : 'one pattern’s share'}</figcaption>
        </figure>
      </div>
      <Slider label="coefficients kept" value={keep} min={0} max={64} onChange={setKeep} help="Rebuild the block from only the first k coefficients in zigzag order, unquantized. With the low frequencies alone, most blocks are already recognisable." />
      <div className="row">
        <Button onClick={() => setPlaying((p) => !p)} kind="primary">
          {playing ? 'Pause' : 'Add them one by one'}
        </Button>
        <span className="small mono">{e ? fmt((100 * ek) / e, 1) : '100.0'}% of the energy</span>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- notes

function JpegNotes() {
  return (
    <Notes>
      <h2>The transform</h2>
      <p>
        The discrete cosine transform was published by Nasir Ahmed, T. Natarajan and K. R. Rao in 1974 — Ahmed had proposed it for a grant and
        been turned down as “too simple”. For the sort of signal a photograph is, where neighbouring pixels are strongly correlated, the DCT
        comes very close to the Karhunen–Loève transform, the one that packs the most energy into the fewest coefficients for a given
        correlation, without needing to be computed per image. That is <b>energy compaction</b>, and it is the whole reason the method works:
        after the transform, a smooth block is a few large numbers and many tiny ones.
      </p>
      <Code>{`F(v,u) = ¼ C(u) C(v) Σₓ Σᵧ f(y,x) · cos((2x+1)uπ/16) · cos((2y+1)vπ/16)
C(0) = 1/√2,  C(k>0) = 1                         (ITU T.81 §A.3.3)`}</Code>
      <p>
        It is separable — eight 1-D transforms across the rows, then eight down the columns — and with orthonormal scaling the inverse is the
        transpose. Real codecs use factorisations (Arai–Agui–Nakajima needs 5 multiplications per 8 points) and fold the scale factors into the
        quantization table. 8×8 was a compromise from the late 1980s: big enough to capture correlation, small enough that a block is roughly
        uniform and the arithmetic fits the hardware.
      </p>
      <h2>Quantization is the only lossy step</h2>
      <p>
        Divide by a step size and round. Everything else — the DCT, the zigzag, the run-lengths, the Huffman codes — is reversible. The standard
        (ITU T.81 / ISO 10918-1, approved 1992 after the Joint Photographic Experts Group had worked on it since 1986) does not mandate a table;
        Annex K prints an example derived from visibility experiments by Lohscheller, and the libjpeg “quality” knob, which almost every program
        exposes, is nothing more than a scale factor on that example. Above quality 50 the steps shrink linearly; below, they grow as 50/q. At
        100 every step is 1 and the only loss left is the rounding of the transform itself.
      </p>
      <h2>Zigzag, run-length, Huffman</h2>
      <p>
        After quantization most high-frequency coefficients are zero, so they are read in zigzag order to put those zeros together at the end.
        The DC coefficient is coded as the difference from the previous block’s (neighbouring blocks have similar averages). Each non-zero AC
        coefficient becomes a symbol <code>(zeros skipped, bits needed)</code> — Huffman-coded — followed by the value’s bits; a run longer than 15
        uses ZRL, and EOB says “the rest are zero”. A file carries its own Huffman tables; this one uses the Annex K examples, as many encoders
        do. Optimised tables or the arithmetic-coding mode (rarely used, once patent-encumbered) save another 5–10%.
      </p>
      <h2>What breaks</h2>
      <ul>
        <li>
          <b>Blocking.</b> Each block is quantized independently, so at low quality neighbouring blocks get different DC levels and visible seams
          appear on a grid of 8. Look at the sphere’s sky at quality 5.
        </li>
        <li>
          <b>Ringing.</b> A sharp edge needs every frequency. Drop the high ones and the reconstruction overshoots and ripples beside the edge —
          the Gibbs phenomenon. That is why the <i>Text</i> image looks so much worse than the sphere at the same file size, and why screenshots,
          diagrams and line art belong in PNG.
        </li>
        <li>
          <b>Generation loss.</b> Decode, edit, re-encode with a different table, and the rounding happens again. Re-encoding with the same
          table and the same block alignment is nearly idempotent; anything else accumulates error.
        </li>
      </ul>
      <h2>Colour</h2>
      <p>
        Colour JPEGs convert RGB to YCbCr, keep luma (Y) at full resolution and usually halve the two chroma channels in both directions (4:2:0)
        before doing exactly what you see here to each plane with a coarser chroma table. Subsampling throws away three quarters of the colour
        samples before any DCT happens — the second lossy step, and one the eye almost never notices.
      </p>
      <h2>Successors</h2>
      <p>
        JPEG 2000 (2000) replaced blocks with a wavelet transform, so artefacts are blur rather than tiles. WebP (2010) and AVIF (2019) come from
        video codecs: they predict each block from its already-decoded neighbours and transform only the residual, with variable block sizes
        and in-loop deblocking filters. JPEG XL (2021) does the same and can also re-pack an existing JPEG losslessly about 20% smaller. Thirty
        years on, baseline JPEG is still the format every device can read.
      </p>
      <div className="aside">
        The file written here is complete baseline JFIF: SOI, APP0, DQT, SOF0, two DHT segments, SOS, the scan with 0xFF bytes stuffed, EOI. The
        test suite decodes it with an independent parser and checks every coefficient; the image in the middle pane is your browser’s own decoder
        reading it.
      </div>
    </Notes>
  )
}
