import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { glyph, hex2 } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { fieldsForRun, imageRuns, mhCode, naivePackets, packbitsPackets, type Packet, type PixelRun } from './rle'
import './rle.css'

const W = 32
const H = 20

type Mode = 'pixels' | 'bytes'
type Preset = 'letters' | 'blank' | 'diagonal' | 'checker' | 'dither'

// 5×7 glyphs for "RLE", drawn at 2× so the three letters fill 32 columns exactly.
const FONT: Record<string, string[]> = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
}

function makePreset(p: Preset): boolean[][] {
  const img = Array.from({ length: H }, () => new Array<boolean>(W).fill(false))
  if (p === 'letters') {
    ;['R', 'L', 'E'].forEach((ch, k) => {
      const x0 = k * 11
      FONT[ch].forEach((line, y) => {
        for (let x = 0; x < 5; x++)
          if (line[x] === '1') for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) img[3 + y * 2 + dy][x0 + x * 2 + dx] = true
      })
    })
  } else if (p === 'diagonal') {
    for (let y = 0; y < H; y++) {
      const x = Math.round((y * (W - 1)) / (H - 1))
      img[y][x] = true
      if (x + 1 < W) img[y][x + 1] = true
    }
  } else if (p === 'checker') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y][x] = (x + y) % 2 === 1
  } else if (p === 'dither') {
    // 4×4 Bayer ordered dither of a left-to-right gradient.
    const bayer = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ]
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y][x] = (x / (W - 1)) * 16 > bayer[y % 4][x % 4] + 0.5
  }
  return img
}

const packetClass = (p: Packet, k: number) => (p.kind === 'repeat' ? (k % 2 ? 'hl-5' : 'hl-2') : k % 2 ? 'hl-6' : 'hl-4')

export function Rle() {
  const [mode, setMode] = useState<Mode>('pixels')
  return (
    <Page
      slug="rle"
      lede={
        <p>
          The oldest trick in compression: when the same thing repeats, say how many times instead of repeating it. Two kinds of data show it
          off — a <b>black-and-white picture</b>, where a fax machine sends only how far it is to the next change of colour, and plain{' '}
          <b>bytes</b>, where the hard part turns out to be not the runs but everything that isn’t one.
        </p>
      }
    >
      {mode === 'pixels' ? <PixelBench mode={mode} setMode={setMode} /> : <ByteBench mode={mode} setMode={setMode} />}

      <Notes>
        <h2>The algorithm</h2>
        <Code>{`row → alternating run lengths, white first:
  ....##.......#  →  4, 2, 7, 1
  ##............  →  0, 2, 12        (a row that starts black opens with 0)`}</Code>
        <p>
          Because the colours alternate, the colour itself never needs sending — only the lengths. That is the whole of the one-dimensional
          scheme in ITU-T Recommendation T.4 (1980), which every Group 3 fax machine still speaks. A page at 1728 pixels per line is mostly white,
          so a typical line collapses to a handful of numbers.
        </p>
        <h2>Fixed-width fields vs Modified Huffman</h2>
        <p>
          Sending each run in a fixed number of bits wastes space on short runs and has to split long ones. T.4 instead gives every run length its
          own prefix code, with separate tables for white and black built from the statistics of eight test documents: black runs of 2 and 3
          pixels (the width of a pen stroke) get 2-bit codes, white runs of 2–7 get 4 bits, and a run of white 0 — rare — costs 8. Runs of 64 and
          up use a “make-up” code for the multiple of 64 followed by a terminating code. That is <a href="#/huffman">Huffman coding</a> applied
          to run lengths, hence <i>Modified Huffman</i>. T.4’s 2-D mode (MR) and T.6 (MMR, Group 4) go further and code each line as changes
          relative to the line above.
        </p>
        <h2>PackBits: escaping the literals</h2>
        <p>
          On bytes, the naive ⟨count, byte⟩ pair spends two bytes on every run — including the overwhelmingly common run of length one — so text
          doubles. Apple’s PackBits (Macintosh, 1984; documented in Technical Note TN1023, later adopted by TIFF) uses one signed header byte:
        </p>
        <ul>
          <li>
            <code>0…127</code> — copy the next <i>n</i>+1 bytes literally;
          </li>
          <li>
            <code>−1…−127</code> — repeat the next byte 1−<i>n</i> times (2 to 128);
          </li>
          <li>
            <code>−128</code> — no-op.
          </li>
        </ul>
        <p>
          The worst case is a literal header every 128 bytes, so no input grows by more than ⌈<i>n</i>/128⌉ bytes. The same shape — a flag or
          count that says “literal” or “copy” — reappears in every format on this site. BMP’s RLE8, PCX and Targa (TGA) are close cousins.
        </p>
        <h2>Why runs matter later</h2>
        <p>
          Runs are rare in raw text, so RLE alone does little there. But other transforms <i>manufacture</i> runs: the{' '}
          <a href="#/bwt">Burrows–Wheeler transform</a> clusters equal letters and move-to-front turns them into runs of zeros, which bzip2 then
          run-length codes; <a href="#/jpeg">JPEG</a> quantization leaves long runs of zero coefficients and codes them as (run, size) pairs; and
          DEFLATE’s length-distance pairs with distance 1 are run-length encoding in disguise.
        </p>
        <div className="aside">
          Counting forbids a free lunch here as everywhere (see <a href="#/entropy">How Low Can It Go</a>): the checkerboard preset is the
          picture where every run has length 1, and every run-length scheme makes it bigger than the raw bitmap.
        </div>
      </Notes>
    </Page>
  )
}

// ================================================================== pixels

function PixelBench({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const [preset, setPreset] = useState<Preset>('letters')
  const [img, setImg] = useState(() => makePreset('letters'))
  const [width, setWidth] = useState(5)
  const runs = useMemo(() => imageRuns(img), [img])
  const s = useStepper(runs.length + 1, { speed: 8, resetKey: preset })
  const max = 2 ** width - 1

  const fixedBits = runs.reduce((t, r) => t + fieldsForRun(r.length, max) * width, 0)
  const mhBits = runs.reduce((t, r) => t + mhCode(r).length, 0)
  const raw = W * H

  const load = (p: Preset) => {
    setPreset(p)
    setImg(makePreset(p))
  }

  const cur = s.index > 0 ? runs[s.index - 1] : null
  const done = s.index === runs.length

  return (
    <Bench
      side={
        <>
          <ModeGroup mode={mode} setMode={setMode} />
          <Group title="Picture" help="Click or drag on the picture to paint; drag starting on a black pixel to erase.">
            <div className="btn-row">
              {(
                [
                  ['letters', 'RLE'],
                  ['blank', 'blank'],
                  ['diagonal', 'diagonal'],
                  ['dither', 'dithered'],
                  ['checker', 'checkerboard'],
                ] as [Preset, string][]
              ).map(([p, l]) => (
                <Button key={p} kind={p === preset ? 'primary' : 'default'} onClick={() => load(p)}>
                  {l}
                </Button>
              ))}
            </div>
            <p className="small muted">{W}×{H} pixels, one bit each. Paint on it while stepping — the runs update live.</p>
          </Group>
          <Group title="Fixed-width field">
            <Slider
              label="bits per run"
              value={width}
              min={1}
              max={6}
              onChange={setWidth}
              display={`${width} → max ${max}`}
              help="Each run length is sent in this many bits. A run longer than the maximum is split: max, then an empty run of the other colour, then the rest."
            />
          </Group>
          <Group title="Result">
            <Stats>
              <Stat label="runs" value={runs.length} help="Total runs over all rows, including the zero-length white run that opens a row starting black." />
              <Stat label="raw bits" value={raw} />
              <Stat label="fixed-width" value={fixedBits} tone={fixedBits < raw ? 'good' : 'bad'} />
              <Stat label="T.4 MH" value={mhBits} tone={mhBits < raw ? 'good' : 'bad'} help="Bits under fax's Modified Huffman tables (terminating codes only; end-of-line codes not counted)." />
            </Stats>
          </Group>
        </>
      }
    >
      <Panel title="Picture" aside={cur ? `row ${cur.row}, ${cur.black ? 'black' : 'white'} run of ${cur.length}` : 'click or drag to paint'}>
        <PixelCanvas img={img} setImg={setImg} cur={cur} scanned={cur ? cur.row * W + cur.start + cur.length : 0} />
        <div className="legend rle-legend" style={{ marginTop: 8 }}>
          <span>
            <i className="w" /> white (0)
          </span>
          <span>
            <i className="b" /> black (1)
          </span>
          <span>
            <i style={{ background: 'var(--accent)' }} /> run just coded
          </span>
        </div>
      </Panel>
      <Transport s={s} label={(i) => `run ${i} / ${runs.length}`} />
      <Narration tone={done ? 'done' : undefined}>
        {s.index === 0 && <>The scanner starts at the top-left, white. It counts pixels until the colour changes, sends the count, and flips colour.</>}
        {cur && !done && (
          <>
            Row {cur.row}: {cur.black ? 'black' : 'white'} run of <b>{cur.length}</b>
            {cur.length === 0 && ' — the row starts black, so it opens with an empty white run to keep the colours in step'}
            {cur.length > max && ` — longer than ${max}, so it costs ${fieldsForRun(cur.length, max)} fields (${max}, 0, …)`}. Fax would send{' '}
            <code>{mhCode(cur)}</code> ({mhCode(cur).length} bits) for it.
          </>
        )}
        {done && (
          <>
            All {H} rows coded in {runs.length} runs: {fixedBits} bits at {width} bits per field, {mhBits} with fax’s Modified Huffman tables,
            against {raw} raw.{' '}
            {mhBits > raw ? 'Run-length coding made this picture bigger: there are too many short runs.' : `That is ${((100 * mhBits) / raw).toFixed(0)}% of the bitmap.`}
          </>
        )}
      </Narration>
      <Panel title="Runs, row by row" aside="white, black, white, …">
        <RunList runs={runs} upto={s.index} />
        {cur && (
          <div className="rle-mh">
            Modified Huffman, {cur.black ? 'black' : 'white'} {cur.length}: <code>{mhCode(cur)}</code>
          </div>
        )}
      </Panel>
      <Panel title="How big is it">
        <SizeBars
          rows={[
            { label: '1 bit / pixel', value: raw, tone: 'faint' },
            { label: `${width}-bit fields`, value: fixedBits, tone: fixedBits > raw ? 'bad' : undefined },
            { label: 'T.4 MH codes', value: mhBits, tone: mhBits > raw ? 'bad' : 'good', note: 'variable-length' },
          ]}
        />
      </Panel>
    </Bench>
  )
}

function PixelCanvas({ img, setImg, cur, scanned }: { img: boolean[][]; setImg: (f: (p: boolean[][]) => boolean[][]) => void; cur: PixelRun | null; scanned: number }) {
  const C = 18
  const ref = useRef<SVGSVGElement>(null)
  const paint = useRef<boolean | null>(null)
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * W)
    const y = Math.floor(((e.clientY - r.top) / r.height) * H)
    return x >= 0 && x < W && y >= 0 && y < H ? [x, y] : null
  }
  const set = (x: number, y: number, v: boolean) =>
    setImg((p) => {
      if (p[y][x] === v) return p
      const n = p.map((row) => row.slice())
      n[y][x] = v
      return n
    })
  const down = (e: PointerEvent) => {
    const p = at(e)
    if (!p) return
    ref.current!.setPointerCapture(e.pointerId)
    paint.current = !img[p[1]][p[0]]
    set(p[0], p[1], paint.current)
  }
  const move = (e: PointerEvent) => {
    if (paint.current === null) return
    const p = at(e)
    if (p) set(p[0], p[1], paint.current)
  }
  const up = () => {
    paint.current = null
  }
  const cells = []
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x
      cells.push(
        <rect
          key={k}
          x={x * C}
          y={y * C}
          width={C}
          height={C}
          fill={img[y][x] ? 'var(--ink)' : 'var(--card)'}
          stroke="var(--line)"
          strokeWidth={0.6}
          opacity={scanned > 0 && k >= scanned ? 0.45 : 1}
        />,
      )
    }
  return (
    <svg ref={ref} className="rle-canvas" viewBox={`-1 -1 ${W * C + 2} ${H * C + 2}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {cells}
      {cur && cur.length > 0 && (
        <rect x={cur.start * C} y={cur.row * C} width={cur.length * C} height={C} fill="var(--accent)" opacity={cur.black ? 0.55 : 0.85} stroke="var(--ink)" strokeWidth={2.5} />
      )}
      {cur && cur.length === 0 && <line x1={0} x2={0} y1={cur.row * C} y2={cur.row * C + C} stroke="var(--accent)" strokeWidth={5} />}
    </svg>
  )
}

function RunList({ runs, upto }: { runs: PixelRun[]; upto: number }) {
  const box = useRef<HTMLDivElement>(null)
  // Keep the current run in view inside the list without scrolling the page.
  useEffect(() => {
    const el = box.current
    const cur = el?.querySelector<HTMLElement>('.rle-run.cur')
    if (!el || !cur) return
    const top = cur.offsetTop // the list is position: relative, so this is measured from its top
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 30) el.scrollTop = top - el.clientHeight / 2
  }, [upto])
  const rows: PixelRun[][] = []
  for (let i = 0; i < upto; i++) (rows[runs[i].row] ??= []).push(runs[i])
    return (
    <div className="rle-rows" ref={box}>
      {upto === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing sent yet.</p>}
      {rows.map((rs, r) =>
        rs ? (
          <div className="rle-row" key={r}>
            <b>row {r}</b>
            {rs.map((run, k) => (
              <span key={k} className={'rle-run ' + (run.black ? 'b' : 'w') + (run === runs[upto - 1] ? ' cur' : '')}>
                {run.length}
              </span>
            ))}
          </div>
        ) : null,
      )}
    </div>
  )
}

function ModeGroup({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <Group title="Data">
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: 'pixels', label: 'Pixels (fax)' },
          { value: 'bytes', label: 'Bytes (PackBits)' },
        ]}
      />
    </Group>
  )
}

// =================================================================== bytes

type Scheme = 'packbits' | 'naive'

function ByteBench({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const src = useSource('runs', 1024)
  const [scheme, setScheme] = useState<Scheme>('packbits')
  const data = src.bytes
  const pb = useMemo(() => packbitsPackets(data), [data])
  const nv = useMemo(() => naivePackets(data), [data])
  const packets = scheme === 'packbits' ? pb : nv
  const s = useStepper(packets.length + 1, { speed: 4, resetKey: src.key + scheme })
  const pbSize = pb.reduce((t, p) => t + p.out.length, 0)
  const nvSize = nv.reduce((t, p) => t + p.out.length, 0)

  const k = s.index - 1
  const cur = k >= 0 ? packets[k] : null
  const done = s.index === packets.length

  // Which packet covers each input byte, and the output so far with per-byte packet / header info.
  const owner = useMemo(() => {
    const o = new Int32Array(data.length)
    packets.forEach((p, i) => o.fill(i, p.start, p.start + p.length))
    return o
  }, [packets, data.length])
  const out: number[] = []
  const outOwner: number[] = []
  const outHdr: boolean[] = []
  for (let i = 0; i < s.index; i++) {
    packets[i].out.forEach((b, j) => {
      out.push(b)
      outOwner.push(i)
      outHdr.push(scheme === 'packbits' ? j === 0 : j === 0)
    })
  }

  return (
    <Bench
      side={
        <>
          <ModeGroup mode={mode} setMode={setMode} />
          <Group title="Source">
            <SourceInput src={src} samples={['runs', 'skew', 'tobe', 'prose', 'json', 'random']} maxBytes={1024} />
          </Group>
          <Group title="Scheme">
            <Segmented
              value={scheme}
              onChange={setScheme}
              options={[
                { value: 'packbits', label: 'PackBits' },
                { value: 'naive', label: '⟨count, byte⟩' },
              ]}
            />
            <p className="small muted">
              {scheme === 'packbits'
                ? 'One signed header byte per packet: 0…127 means “copy n+1 literal bytes”, −1…−127 means “repeat the next byte 1−n times”.'
                : 'Every run, even a run of one, becomes two bytes: how many, then which.'}
            </p>
          </Group>
          <Group title="Result">
            <Stats>
              <Stat label="input bytes" value={data.length} />
              <Stat label="packets" value={packets.length} />
              <Stat label="PackBits" value={pbSize} tone={pbSize <= data.length ? 'good' : 'bad'} />
              <Stat label="naive pairs" value={nvSize} tone={nvSize <= data.length ? 'good' : 'bad'} />
            </Stats>
          </Group>
        </>
      }
    >
      <Panel title="Input" aside={cur ? `bytes ${cur.start}–${cur.start + cur.length - 1}` : `${data.length} bytes`}>
        <Tape bytes={data} mark={(i) => (owner[i] < s.index ? packetClass(packets[owner[i]], owner[i]) + (owner[i] === k ? ' cur' : '') : 'dim')} />
      </Panel>
      <Panel title="Output" aside={`${out.length} bytes`}>
        {out.length ? (
          <Tape
            bytes={out}
            mark={(i) => (outHdr[i] ? 'rle-hdr' : packetClass(packets[outOwner[i]], outOwner[i])) + (outOwner[i] === k ? ' cur' : '')}
            render={(i) => (outHdr[i] ? (scheme === 'packbits' ? signed(out[i]) : String(out[i])) : glyph(out[i]))}
            cellTitle={(i) => (outHdr[i] ? `header 0x${hex2(out[i])} = ${signed(out[i])}` : `0x${hex2(out[i])}`)}
          />
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Nothing written yet.
          </p>
        )}
        <div className="legend" style={{ marginTop: 10 }}>
          <span>
            <i className="hl-4" /> literal packet
          </span>
          <span>
            <i className="hl-2" /> repeat packet
          </span>
          <span>
            <i style={{ border: '1.5px solid var(--ink)' }} /> header / count byte
          </span>
        </div>
      </Panel>
      <Transport s={s} label={(i) => `packet ${i} / ${packets.length}`} />
      <Narration tone={done && s.index > 0 ? (scheme === 'naive' && nvSize > data.length ? 'warn' : 'done') : undefined}>
        {s.index === 0 && <>Step forward to cut the input into packets.</>}
        {cur && !done && <PacketSentence p={cur} scheme={scheme} data={data} />}
        {done && s.index > 0 && (
          <>
            {data.length} bytes → {scheme === 'packbits' ? pbSize : nvSize} bytes in {packets.length} packets.{' '}
            {scheme === 'naive'
              ? nvSize > data.length
                ? 'Most runs here have length 1, and each costs two bytes — the input grew.'
                : 'Long runs pay for the two-byte pairs.'
              : pbSize > data.length
                ? `Nothing repeats, so PackBits only pays its literal headers: ${pbSize - data.length} extra byte${pbSize - data.length === 1 ? '' : 's'}.`
                : `Saved ${data.length - pbSize} bytes.`}
          </>
        )}
      </Narration>
      <Panel title="How big is it">
        <SizeBars
          unit="bytes"
          rows={[
            { label: 'input', value: data.length, tone: 'faint' },
            { label: 'PackBits', value: pbSize, tone: pbSize > data.length ? 'bad' : undefined, note: `worst case ≤ ${data.length + Math.ceil(data.length / 128)}` },
            { label: '⟨count, byte⟩', value: nvSize, tone: nvSize > data.length ? 'bad' : 'good', note: `worst case ${2 * data.length}` },
          ]}
        />
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          PackBits only switches to a repeat packet for runs of 3 or more <Help text="A run of 2 inside literals costs the same either way, and breaking a literal packet to code it would spend an extra header byte." />.
        </p>
      </Panel>
    </Bench>
  )
}

function signed(b: number): string {
  const n = b > 127 ? b - 256 : b
  return n > 0 ? '+' + n : n < 0 ? '−' + -n : '0'
}

function PacketSentence({ p, scheme, data }: { p: Packet; scheme: Scheme; data: Uint8Array }) {
  const b = data[p.start]
  if (scheme === 'naive')
    return (
      <>
        A run of {p.length} × ‘<b>{glyph(b)}</b>’ → two bytes <code>{p.length}</code> <code>{hex2(b)}</code>
        {p.length === 1 ? ' — a run of one still costs two bytes, double the input.' : ` — ${p.length} bytes in 2.`}
      </>
    )
  if (p.kind === 'repeat')
    return (
      <>
        Repeat packet: ‘<b>{glyph(b)}</b>’ × {p.length}. Header <code>{hex2(p.out[0])}</code> = {signed(p.out[0])}, so the decoder repeats the next
        byte 1 − ({signed(p.out[0])}) = {p.length} times. {p.length} bytes in 2.
      </>
    )
  return (
    <>
      Literal packet: {p.length} byte{p.length === 1 ? '' : 's'} with no run of 3 among them. Header <code>{hex2(p.out[0])}</code> = {p.out[0]},
      so the decoder copies the next {p.out[0]} + 1 bytes as they are{p.length === 128 ? ' — the longest a literal packet can be' : ''}. Cost: one
      extra byte.
    </>
  )
}
