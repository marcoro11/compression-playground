import { useMemo, useState, type ReactNode } from 'react'
import { toBin } from '../../lib/bits'
import { byteCounts, entropy } from '../../lib/entropy'
import { buildTree, codedBits } from '../../lib/huffman'
import { fmt, glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { arithOrder0 } from '../arithmetic/codec'
import {
  buildTans,
  lowerBound,
  modelBits,
  ransModel,
  stateBits,
  streamDecode,
  streamEncode,
  tansEncode,
  toyDecode,
  toyEncode,
  type RansModel,
  type StreamParams,
  type Tans,
} from './ans'
import './ans.css'

type Mode = 'toy' | 'stream' | 'tans'
type Dir = 'encode' | 'decode'

/** The toy coder uses unbounded integers; keep the number on screen readable. */
const TOY_CAP = 24
const MAX_INPUT = 400

const cls = (k: number) => 'hl-' + ((k % 6) + 1)

/** A big decimal, abbreviated in the middle once it stops fitting on a line. */
function bigDec(x: bigint | number): string {
  const s = x.toString()
  return s.length <= 26 ? s : `${s.slice(0, 10)}…${s.slice(-8)} (${s.length} digits)`
}

function log2Big(x: bigint): number {
  const s = x.toString(2)
  const top = s.slice(0, 50)
  return Math.log2(parseInt(top, 2)) + (s.length - top.length)
}

export function Ans() {
  const src = useSource('skew', MAX_INPUT)
  const [mode, setMode] = useState<Mode>('stream')
  const [dir, setDir] = useState<Dir>('encode')
  const [kWanted, setK] = useState(5)
  const [h, setH] = useState(2)
  const [rWanted, setR] = useState(5)

  const data = src.bytes
  const n = data.length
  const hist = useMemo(() => byteCounts(data), [data])
  const alphabet = useMemo(() => {
    const a: number[] = []
    for (let b = 0; b < 256; b++) if (hist[b]) a.push(b)
    return a
  }, [hist])
  const counts = useMemo(() => alphabet.map((b) => hist[b]), [alphabet, hist])
  const syms = useMemo(() => {
    const idx = new Map(alphabet.map((b, i) => [b, i]))
    return Array.from(data, (b) => idx.get(b)!)
  }, [data, alphabet])

  const kMin = Math.max(2, Math.ceil(Math.log2(Math.max(2, alphabet.length))))
  const k = Math.max(kMin, kWanted)
  const rMin = Math.max(4, kMin)
  const R = Math.max(rMin, rWanted)

  const model = useMemo(() => (alphabet.length ? ransModel(counts, k) : null), [counts, k, alphabet.length])
  const params: StreamParams | null = useMemo(() => (model ? { m: model, h } : null), [model, h])
  const tans = useMemo(() => (alphabet.length ? buildTans(counts, R) : null), [counts, R, alphabet.length])

  // ---- all three coders, for the size comparison and the stages
  const toySyms = useMemo(() => syms.slice(0, TOY_CAP), [syms])
  const toy = useMemo(() => (model ? toyEncode(toySyms, model) : null), [toySyms, model])
  const stream = useMemo(() => (params ? streamEncode(syms, params) : null), [syms, params])
  const streamDec = useMemo(() => (params && stream ? streamDecode(stream.final, stream.stack, n, params) : null), [params, stream, n])
  const tEnc = useMemo(() => (tans ? tansEncode(syms, tans) : null), [syms, tans])

  const H = entropy(hist)
  const huffBits = useMemo(() => codedBits(hist, buildTree(hist).lengths), [hist])
  const arithBits = useMemo(() => (n ? arithOrder0.encode(data).length * 8 - 32 : 0), [data, n])
  const streamBits = stream && params ? stream.stack.length + stateBits(params) : 0
  const tansBits = tEnc && tans ? tEnc.steps.reduce((a, s) => a + s.nb, 0) + tans.R : 0
  const quantBits = model ? modelBits(syms, model) : 0
  const tansIdeal = tans ? syms.reduce((a, s) => a + Math.log2(tans.L / tans.counts[s]), 0) : 0

  const toyN = toySyms.length
  const count =
    mode === 'toy'
      ? toyN + 1
      : mode === 'stream'
        ? dir === 'encode'
          ? n + 2
          : n + 1
        : dir === 'encode'
          ? n + 2
          : n + 1
  const s = useStepper(count, { speed: 3, resetKey: src.key + mode + dir + k + h + R })

  const toyBits = toy ? log2Big(toy.x) - log2Big(toy.x0) : 0
  const coderLabel = mode === 'tans' ? 'tANS' : mode === 'toy' ? 'big integer' : 'rANS'
  const coderBits = mode === 'tans' ? tansBits : mode === 'toy' ? toyBits : streamBits
  const coderN = mode === 'toy' ? toySyms.length : n

  return (
    <Page
      slug="ans"
      lede={
        <>
          <p>
            Arithmetic coding keeps an interval and narrows it. Jarek Duda noticed you can keep a <b>single integer</b> instead. Coding a symbol
            with probability p turns x into roughly x/p — so log₂ x grows by exactly the symbol’s information, −log₂ p — and decoding reads the
            symbol back out of x and shrinks it again. Push, pop: it is a stack of fractional bits.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['skew', 'abra', 'banana', 'dna', 'tobe', 'runs', 'prose']} maxBytes={MAX_INPUT} />
            </Group>
            <Group title="Step through">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'toy', label: 'Big integer' },
                  { value: 'stream', label: 'rANS' },
                  { value: 'tans', label: 'tANS' },
                ]}
              />
              <Segmented
                value={dir}
                onChange={setDir}
                options={[
                  { value: 'encode', label: 'Encode' },
                  { value: 'decode', label: 'Decode' },
                ]}
              />
              <p className="small muted">
                {mode === 'toy' && `The pure arithmetic: x is an unbounded integer and nothing is ever shifted out (first ${TOY_CAP} symbols).`}
                {mode === 'stream' && 'Real rANS: x lives in a fixed window [L, 2L), and bits are shifted out onto a stack to keep it there.'}
                {mode === 'tans' && 'Tabled ANS, as in Zstandard: the same coding function precomputed for every state, so each step is a lookup.'}
              </p>
            </Group>
            <Group title="Model" help="ANS needs probabilities as fractions with a power-of-two denominator M, so the counts are rounded to integers that sum to M. Coarser M, cheaper tables, more rounding loss.">
              {mode !== 'tans' ? (
                <>
                  <Slider
                    label="M = 2^k"
                    value={k}
                    min={kMin}
                    max={12}
                    onChange={setK}
                    display={`2^${k} = ${2 ** k}`}
                    help={`Total of the quantised frequencies. At least ${2 ** kMin}, so every one of the ${alphabet.length} symbols gets a slot.`}
                  />
                  {mode === 'stream' && (
                    <Slider
                      label="headroom h"
                      value={h}
                      min={0}
                      max={8}
                      onChange={setH}
                      display={`L = M·2^${h}`}
                      help="The state window is [L, 2L) with L = M·2^h. With no headroom, x/f is rounded hard on every step; a few spare bits make the rounding loss negligible. The codec uses 11 bits of headroom and shifts whole bytes."
                    />
                  )}
                </>
              ) : (
                <Segmented
                  label="states L"
                  value={R}
                  onChange={setR}
                  options={[4, 5, 6, 7]
                    .filter((r) => r >= rMin)
                    .map((r) => ({ value: r, label: String(2 ** r) }))}
                  help="Table size. Every symbol occupies (count/total)·L of the L slots; Zstandard uses 2^5 to 2^9 for its sequence codes and up to 2^11 for literals."
                />
              )}
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label={coderLabel} value={coderN ? fmt(coderBits / coderN, 3) : '—'} sub="bits / symbol" tone="accent" help={mode === 'toy' ? 'log₂ of how much x grew, divided by the number of symbols pushed (the first ' + TOY_CAP + ').' : 'Bits the coder actually produced (including the final state), divided by the input length.'} />
                <Stat label="entropy" value={fmt(H, 3)} sub="bits / symbol" help="Order-0 Shannon bound for the input’s own counts." />
                <Stat label="Huffman" value={n ? fmt(huffBits / n, 3) : '—'} sub="bits / symbol" help="Whole-bit code for the same counts — never below 1 bit per symbol." />
                <Stat
                  label="rounding"
                  value={'+' + fmt(((mode === 'tans' ? tansIdeal : quantBits) - H * n) / Math.max(1, n), 3)}
                  sub="bits / symbol"
                  help="The price of rounding the probabilities to fractions of M (or of L): Σ log₂(M/f) minus the entropy. It shrinks as M grows."
                />
              </Stats>
            </Group>
          </>
        }
      >
        {!model || !params || !tans || n === 0 ? (
          <Narration>Type something to code.</Narration>
        ) : (
          <>
            <Panel
              title="Input"
              aside={dir === 'encode' ? 'encoded from the END: the decoder pops in reading order' : 'decoded front to back'}
            >
              <InputTape data={data} syms={syms} mode={mode} dir={dir} index={s.index} toyN={toyN} n={n} />
            </Panel>

            {mode !== 'tans' && <FreqPanel m={model} alphabet={alphabet} counts={counts} />}

            {mode === 'toy' && <ToyStage m={model} alphabet={alphabet} syms={toySyms} dir={dir} index={s.index} enc={toy!} />}
            {mode === 'stream' && <StreamStage p={params} alphabet={alphabet} syms={syms} dir={dir} index={s.index} enc={stream!} dec={streamDec!} />}
            {mode === 'tans' && <TansStage t={tans} alphabet={alphabet} syms={syms} dir={dir} index={s.index} enc={tEnc!} />}

            <Transport
              s={s}
              label={(i) => {
                const total = count - 1
                if (dir === 'encode' && mode !== 'toy' && i === total) return `flush · ${total} / ${total}`
                return `${dir === 'encode' ? 'push' : 'pop'} ${i} / ${total}`
              }}
            />
          </>
        )}

        <Panel title="How big is it" aside="tables not counted">
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: n * 8, tone: 'faint' },
              { label: 'Huffman', value: huffBits, tone: 'faint', note: 'whole bits' },
              { label: 'arithmetic', value: arithBits, tone: 'faint', note: 'adaptive, 32-bit' },
              { label: `rANS, M=2^${k}`, value: streamBits, note: `h = ${h}` },
              { label: `tANS, L=${2 ** R}`, value: tansBits },
              { label: 'entropy floor', value: H * n, tone: 'ink' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            On <b>Skewed</b> both ANS coders sit near the entropy while Huffman is stuck at 1 bit per symbol. Push M or L down to see the rounding
            cost appear: a symbol whose true probability is 0.02 cannot have less than 1/M.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>One number instead of an interval</h2>
        <p>
          Write a number in base 2 and append a bit b: x becomes 2x + b. Every symbol costs exactly one bit because the two symbols share the
          number line evenly — evens are 0, odds are 1. ANS makes the sharing uneven. Split the integers into blocks of M, give symbol s a run
          of f(s) consecutive slots in every block, and let the <i>k</i>-th integer whose slot belongs to s stand for “the state k, followed by
          s”. Then pushing s onto x means: find the x-th integer belonging to s.
        </p>
        <Code>{`encode  C(s, x) = ⌊x / f⌋ · M  +  c(s)  +  (x mod f)
decode  slot = x mod M ;  s = the symbol owning slot
        D(x) = f · ⌊x / M⌋  +  slot − c(s)`}</Code>
        <p>
          Because s owns f of every M integers, its x-th one is near x·M/f: log₂ x grows by log₂(M/f) = −log₂ p, the symbol’s information
          content — fractional, not rounded to a whole bit. The step-through shows the running total of “bits shipped + bits still in the
          state” tracking the ideal line almost exactly.
        </p>
        <h2>Why it runs backwards</h2>
        <p>
          C and D are inverses, so the last symbol pushed is the first popped — a stack. To let the decoder read the message front to back, the
          encoder processes it back to front and the bit stream is reversed. That is the main practical nuisance of ANS (an encoder must buffer a
          block), and the price for its speed.
        </p>
        <h2>Renormalisation</h2>
        <p>
          An unbounded x is as impractical as arithmetic coding’s infinite-precision interval. rANS keeps x in [L, 2L) — or [L, 256·L) when
          shifting whole bytes. Before pushing s, the encoder shifts x right until C(s, x) would land back in the window, which is exactly when
          x &lt; 2·f·L/M. The decoder does the mirror image after popping: while x &lt; L, shift a bit back in. The two agree without any signalling
          because the window is the same on both sides — Duda’s key lemma is that the encoder’s condition and the decoder’s are equivalent.
        </p>
        <h2>tANS: the whole coder as a table</h2>
        <p>
          With L states, every possible (state, symbol) pair can be precomputed. Spread each symbol over count(s) of the L slots — Zstandard
          steps through the table by (L/2 + L/8 + 3), which is odd and so visits every slot once while scattering each symbol evenly — then:
        </p>
        <Code>{`decode:  s = spread[X] ;  X = base[X] + read(nbBits[X])
encode:  nb = bits to shift so that x >> nb ∈ [count(s), 2·count(s))
         write(x mod 2^nb, nb) ;  x = enc[s][(x >> nb) − count(s)]`}</Code>
        <p>
          That is a finite-state machine, like a Huffman decoder table, but the number of bits read varies by state as well as by symbol: a
          symbol occupying 3 of 16 slots costs 2 bits from some states and 3 from others, averaging log₂(16/3) ≈ 2.42. Huffman is the special
          case where every symbol’s slots form an aligned power-of-two block.
        </p>
        <h2>Why everyone switched</h2>
        <ul>
          <li>
            <b>Speed.</b> Decoding rANS with M a power of two is one multiply, a mask, a shift and a table lookup; tANS is a lookup and a bit
            read. No division, no carry propagation, no pending bits.
          </li>
          <li>
            <b>Interleaving.</b> Several independent states can be run round-robin over one stream, which keeps a superscalar or SIMD CPU busy —
            Fabian Giesen’s interleaved rANS decodes at several GB/s.
          </li>
          <li>
            <b>Precision.</b> It reaches arithmetic coding’s compression: the only losses are rounding probabilities to 1/M and the final state.
          </li>
        </ul>
        <h2>History</h2>
        <p>
          Duda posted the first ANS papers in 2007–09 and the definitive “Asymmetric numeral systems: entropy coding combining speed of Huffman
          coding with compression rate of arithmetic coding” in 2013, deliberately unpatented. Yann Collet’s Finite State Entropy (2013) made
          tANS practical and became the entropy stage of <b>Zstandard</b> (2016); Apple’s <b>LZFSE</b> uses it too. rANS is in Google’s Draco mesh
          compression, the CRAM 3.1 genomics format, <b>JPEG XL</b>, and RAD’s Oodle. In 2022 the US patent office granted Microsoft a patent on
          an adaptive rANS variant over Duda’s public objections — a reminder of why the arithmetic-coding patents of the 1980s mattered.
        </p>
        <div className="aside">
          Not everything modern is ANS: AV1 and H.264/H.265 use adaptive (multi-symbol or binary) arithmetic coders, because they need
          probabilities that change after every symbol, which is awkward when the encoder runs backwards.
        </div>
      </Notes>
    </Page>
  )
}

// ---------------------------------------------------------------- the input

function InputTape({ data, syms, mode, dir, index, toyN, n }: { data: Uint8Array; syms: number[]; mode: Mode; dir: Dir; index: number; toyN: number; n: number }) {
  const limit = mode === 'toy' ? toyN : n
  // Encode works from the end: after `index` pushes, symbols limit−index … limit−1 are in the state.
  const cur = dir === 'encode' ? (index >= 1 && index <= limit ? limit - index : -1) : index >= 1 ? index - 1 : -1
  return (
    <Tape
      bytes={data}
      mark={(i) => {
        if (i >= limit) return 'dim ghost'
        if (i === cur) return 'cur ' + cls(syms[i])
        const done = dir === 'encode' ? i > limit - index - 1 && index > 0 && i < limit : i < index - 1
        return done ? cls(syms[i]) : 'dim'
      }}
    />
  )
}

// ---------------------------------------------------------- frequency table

function FreqPanel({ m, alphabet, counts }: { m: RansModel; alphabet: number[]; counts: number[] }) {
  const total = counts.reduce((a, b) => a + b, 0)
  return (
    <Panel title={`Quantised model — M = ${m.M}`} aside="each symbol owns f consecutive slots out of every M">
      <SlotStrip M={m.M} lookup={m.lookup} alphabet={alphabet} />
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              <th>sym</th>
              <th className="num">count</th>
              <th className="num">p</th>
              <th className="num">
                f <Help text="The count rounded to a whole number of slots out of M. Every present symbol gets at least one." />
              </th>
              <th className="num">slots</th>
              <th className="num">−log₂ p</th>
              <th className="num">
                log₂(M/f) <Help text="What the coder actually charges for this symbol. Close to −log₂ p when M is big enough." />
              </th>
            </tr>
          </thead>
          <tbody>
            {alphabet.map((b, s) => (
              <tr key={b}>
                <td>
                  <span className={'cell ' + cls(s)} style={{ height: 20, minWidth: 20 }}>
                    {glyph(b)}
                  </span>
                </td>
                <td className="num">{counts[s]}</td>
                <td className="num">{(counts[s] / total).toFixed(3)}</td>
                <td className="num">{m.freq[s]}</td>
                <td className="num">
                  {m.cum[s]}…{m.cum[s] + m.freq[s] - 1}
                </td>
                <td className="num">{(-Math.log2(counts[s] / total)).toFixed(2)}</td>
                <td className="num">{Math.log2(m.M / m.freq[s]).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** The M slots of one block, coloured by owner. Individual cells up to 64, a proportional bar beyond. */
function SlotStrip({ M, lookup, alphabet, hot, hotSym }: { M: number; lookup: number[]; alphabet: number[]; hot?: number; hotSym?: number }) {
  if (M <= 64) {
    return (
      <div className="ans-slots">
        {lookup.map((s, i) => (
          <span key={i} className={'ans-slot ' + cls(s) + (i === hot ? ' hot' : '') + (hotSym !== undefined && s !== hotSym ? ' off' : '')} title={`slot ${i}: ‘${glyph(alphabet[s])}’`}>
            <b>{glyph(alphabet[s])}</b>
            <i>{i}</i>
          </span>
        ))}
      </div>
    )
  }
  const runs: { s: number; from: number; len: number }[] = []
  for (let i = 0; i < M; i++) {
    const last = runs[runs.length - 1]
    if (last && last.s === lookup[i]) last.len++
    else runs.push({ s: lookup[i], from: i, len: 1 })
  }
  return (
    <div className="ans-slotbar">
      {runs.map((r) => (
        <span
          key={r.from}
          className={cls(r.s) + (hotSym !== undefined && r.s !== hotSym ? ' off' : '')}
          style={{ width: `${(100 * r.len) / M}%` }}
          title={`slots ${r.from}…${r.from + r.len - 1}: ‘${glyph(alphabet[r.s])}’`}
        >
          {r.len / M > 0.04 ? glyph(alphabet[r.s]) : ''}
          {hot !== undefined && hot >= r.from && hot < r.from + r.len && <em className="ans-slotbar-mark" style={{ left: `${(100 * (hot - r.from + 0.5)) / r.len}%` }} />}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ ledger chart

/**
 * "Bits so far" against the ideal: for the toy, log₂(x/x₀); for streaming
 * coders, bits shipped + log₂(x/L). The two lines should hug each other.
 */
function Ledger({ actual, ideal, at, label }: { actual: number[]; ideal: number[]; at: number; label: string }) {
  const n = actual.length
  if (n < 2) return null
  const max = Math.max(1, ...actual, ...ideal)
  const W = 600
  const Hh = 120
  const x = (i: number) => 30 + (i / (n - 1)) * (W - 40)
  const y = (v: number) => Hh - 18 - (v / max) * (Hh - 30)
  const path = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <div className="ans-ledger">
      <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line x1={30} x2={W - 10} y1={y(0)} y2={y(0)} className="axis" />
        <text x={26} y={y(max) + 4} textAnchor="end" className="tick">
          {Math.round(max)}
        </text>
        <text x={26} y={y(0) + 4} textAnchor="end" className="tick">
          0
        </text>
        <path d={path(ideal)} className="ideal" vectorEffect="non-scaling-stroke" />
        <path d={path(actual.slice(0, at + 1))} className="actual" vectorEffect="non-scaling-stroke" />
        <line x1={x(at)} x2={x(at)} y1={8} y2={Hh - 18} className="now" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--ink)' }} /> {label}
        </span>
        <span>
          <i className="ans-dash" /> ideal Σ −log₂ p (quantised model)
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- toy stage

function ToyStage({
  m,
  alphabet,
  syms,
  dir,
  index,
  enc,
}: {
  m: RansModel
  alphabet: number[]
  syms: number[]
  dir: Dir
  index: number
  enc: ReturnType<typeof toyEncode>
}) {
  const n = syms.length
  const dec = useMemo(() => toyDecode(enc.x, n, m), [enc, n, m])
  const x0 = enc.x0
  // State after `index` operations.
  const states = dir === 'encode' ? [x0, ...enc.steps.map((s) => s.after)] : dec.states
  const x = states[index]
  const bitsNow = log2Big(x) - log2Big(x0)

  const actual = states.map((v) => log2Big(v) - log2Big(x0))
  const idealCum: number[] = [0]
  const order = dir === 'encode' ? enc.steps.map((s) => s.sym) : dec.syms
  for (const s of order) idealCum.push(idealCum[idealCum.length - 1] + Math.log2(m.M / m.freq[s]))
  // Decode: ideal shrinks from the total.
  const ideal = dir === 'encode' ? idealCum : idealCum.map((v) => idealCum[n] - v)

  let narration: ReactNode
  let formula = ''
  let hotSlot: number | undefined
  let hotSym: number | undefined
  if (index === 0) {
    narration =
      dir === 'encode' ? (
        <>
          Start with x = M = {m.M}. Symbols are pushed from the <b>last</b> one backwards, because the decoder will pop them like a stack.
        </>
      ) : (
        <>
          The decoder is handed one number — {bigDec(enc.x)}, a {enc.x.toString(2).length}-bit integer — and nothing else but the model and the
          length.
        </>
      )
  } else if (dir === 'encode') {
    const st = enc.steps[index - 1]
    const f = m.freq[st.sym]
    hotSym = st.sym
    hotSlot = Number(st.after % BigInt(m.M))
    formula = `x = ⌊${bigDec(st.before)} / ${f}⌋ · ${m.M} + ${m.cum[st.sym]} + (${bigDec(st.before)} mod ${f}) = ${bigDec(st.after)}`
    const grew = log2Big(st.after) - log2Big(st.before)
    narration = (
      <>
        Push ‘<b>{glyph(alphabet[st.sym])}</b>’ (position {st.i}, f = {f} of {m.M}): x becomes about x·{m.M}/{f}. log₂ x grew by{' '}
        <b>{fmt(grew, 3)}</b> bits; the symbol’s information is −log₂({f}/{m.M}) = {fmt(Math.log2(m.M / f), 3)}.
        {index === n && <> All {n} pushed: the whole message is this one integer.</>}
      </>
    )
  } else {
    const before = dec.states[index - 1]
    const after = dec.states[index]
    const sym = dec.syms[index - 1]
    const slot = Number(before % BigInt(m.M))
    hotSlot = slot
    hotSym = sym
    formula = `slot = ${bigDec(before)} mod ${m.M} = ${slot} → ‘${glyph(alphabet[sym])}’;  x = ${m.freq[sym]} · ⌊x / ${m.M}⌋ + ${slot} − ${m.cum[sym]} = ${bigDec(after)}`
    narration = (
      <>
        x mod M = <b>{slot}</b>, which belongs to ‘<b>{glyph(alphabet[sym])}</b>’ (slots {m.cum[sym]}…{m.cum[sym] + m.freq[sym] - 1}). Pop it: x
        shrinks by {fmt(Math.log2(m.M / m.freq[sym]), 3)} bits.
        {index === n && <> Back to x = {m.M}, exactly where the encoder started — nothing left over.</>}
      </>
    )
  }

  return (
    <>
      <Panel title="The state x" aside={`${x.toString(2).length} bits · log₂(x / x₀) = ${fmt(bitsNow, 2)}`}>
        <div className="ans-big">
          <div>
            <span className="muted">decimal</span>
            <code>{x.toString()}</code>
          </div>
          <div>
            <span className="muted">binary</span>
            <code>{x.toString(2)}</code>
          </div>
        </div>
        {formula && <div className="ans-formula">{formula}</div>}
        <div style={{ marginTop: 10 }}>
          <SlotStrip M={m.M} lookup={m.lookup} alphabet={alphabet} hot={hotSlot} hotSym={hotSym} />
        </div>
        <Ledger actual={actual} ideal={ideal} at={index} label="log₂(x / x₀)" />
      </Panel>
      <Narration tone={index === n && n > 0 ? 'done' : undefined}>{narration}</Narration>
    </>
  )
}

// ------------------------------------------------------------- stream stage

/** x as a binary register of fixed width, with its low `out` bits marked as leaving. */
function Register({ x, width, out = 0, inBits = 0, label, note }: { x: number; width: number; out?: number; inBits?: number; label: string; note?: ReactNode }) {
  const b = toBin(x, width)
  return (
    <div className="ans-reg">
      <span className="ans-reg-label">{label}</span>
      <span className="ans-reg-bits">
        {b.split('').map((c, i) => (
          <i key={i} className={i >= width - out ? 'leaving' : i >= width - inBits ? 'arriving' : x < 2 ** (width - 1 - i) ? 'lead' : ''}>
            {c}
          </i>
        ))}
      </span>
      <span className="ans-reg-dec">{x}</span>
      {note && <span className="ans-reg-note">{note}</span>}
    </div>
  )
}

function StreamStage({
  p,
  alphabet,
  syms,
  dir,
  index,
  enc,
  dec,
}: {
  p: StreamParams
  alphabet: number[]
  syms: number[]
  dir: Dir
  index: number
  enc: ReturnType<typeof streamEncode>
  dec: ReturnType<typeof streamDecode>
}) {
  const { m } = p
  const n = syms.length
  const L = lowerBound(p)
  const W = stateBits(p)
  const scale = 2 ** p.h

  // Stack contents and "bits so far" after each operation.
  const stackLen: number[] = [0]
  if (dir === 'encode') for (const st of enc.steps) stackLen.push(stackLen[stackLen.length - 1] + st.bits.length)
  else {
    let len = enc.stack.length
    stackLen[0] = len
    for (const st of dec.steps) stackLen.push((len -= st.bits.length))
  }
  const xs = dir === 'encode' ? [L, ...enc.steps.map((s) => s.after)] : [enc.final, ...dec.steps.map((s) => s.after)]
  const actual = xs.map((x, i) => stackLen[i] + Math.log2(x / L))
  const order = dir === 'encode' ? enc.steps.map((s) => s.sym) : dec.syms
  const cum: number[] = [0]
  for (const s of order) cum.push(cum[cum.length - 1] + Math.log2(m.M / m.freq[s]))
  const ideal = dir === 'encode' ? cum : cum.map((v) => cum[n] - v)

  const flush = dir === 'encode' && index === n + 1
  const opIndex = Math.min(index, n)
  const st = opIndex > 0 ? (dir === 'encode' ? enc.steps[opIndex - 1] : dec.steps[opIndex - 1]) : null

  const visibleStack = enc.stack.slice(0, stackLen[opIndex])
  const moved = st ? st.bits.length : 0

  let narration: ReactNode
  let regs: ReactNode
  let hotSlot: number | undefined
  let hotSym: number | undefined
  if (dir === 'encode') {
    if (index === 0) {
      narration = (
        <>
          The state window is [L, 2L) = [{L}, {2 * L}): {W} bits, always with the top bit set. Start at x = L and push the last symbol first.
        </>
      )
      regs = <Register x={L} width={W} label="x" />
    } else if (flush) {
      narration = (
        <>
          All {n} symbols pushed. Flush: the final state x = {enc.final} goes out as {W} bits, and the stream is read in reverse — state first,
          then the stack from the top. Total {enc.stack.length + W} bits for {n} symbols.
        </>
      )
      regs = <Register x={enc.final} width={W} label="final x" note="→ written first" />
    } else if (st) {
      const f = m.freq[st.sym]
      hotSym = st.sym
      hotSlot = st.after % m.M
      const lo = f * scale
      regs = (
        <>
          <Register x={st.before} width={W} out={moved} label="x" note={moved ? `≥ 2·f·2^h = ${2 * lo}: shift ${moved} bit${moved > 1 ? 's' : ''} out` : `< 2·f·2^h = ${2 * lo}: fits`} />
          <Register x={st.mid} width={W} label="x′" note={`∈ [${lo}, ${2 * lo})`} />
          <Register x={st.after} width={W} label="C(s,x′)" note={`⌊${st.mid}/${f}⌋·${m.M} + ${m.cum[st.sym]} + ${st.mid % f}`} />
        </>
      )
      narration = (
        <>
          Push ‘<b>{glyph(alphabet[st.sym])}</b>’ (f = {f}/{m.M}).{' '}
          {moved ? (
            <>
              Coding it would multiply x by about {fmt(m.M / f, 2)} and overflow the window, so first <b>{moved}</b> low bit{moved > 1 ? 's go' : ' goes'} onto
              the stack ({st.bits.join('')}).
            </>
          ) : (
            <>x is already small enough — no bits move.</>
          )}{' '}
          Then x′ → {st.after}, back inside [{L}, {2 * L}).
        </>
      )
    }
  } else {
    if (index === 0) {
      narration = (
        <>
          The decoder reads the {W}-bit final state, x = {enc.final}. The rest of the stream is the encoder’s stack, popped from the top.
        </>
      )
      regs = <Register x={enc.final} width={W} label="x" />
    } else if (st) {
      const slot = st.before % m.M
      hotSlot = slot
      hotSym = st.sym
      regs = (
        <>
          <Register x={st.before} width={W} label="x" note={`slot = x mod ${m.M} = ${slot}`} />
          <Register x={st.mid} width={W} label="D(x)" note={`${m.freq[st.sym]}·⌊x/${m.M}⌋ + ${slot} − ${m.cum[st.sym]}`} />
          <Register x={st.after} width={W} inBits={moved} label="x" note={moved ? `< L: pull ${moved} bit${moved > 1 ? 's' : ''} in` : '≥ L: nothing to read'} />
        </>
      )
      narration = (
        <>
          Slot {slot} belongs to ‘<b>{glyph(alphabet[st.sym])}</b>’ — emit it.{' '}
          {moved ? (
            <>
              D(x) = {st.mid} has dropped below L = {L}, so pop <b>{moved}</b> bit{moved > 1 ? 's' : ''} ({st.bits.join('')}) off the stack to
              refill it: x = {st.after}.
            </>
          ) : (
            <>D(x) = {st.mid} is still at least L = {L}, so nothing is read.</>
          )}
          {index === n && <> Done: x is back to L and the stack is empty.</>}
        </>
      )
    }
  }

  const spans =
    dir === 'encode' && moved && !flush ? [{ start: visibleStack.length - moved, length: moved, className: 'hl-1', title: 'just pushed' }] : []

  return (
    <>
      <Panel title="The state" aside={`window [${L}, ${2 * L}) · ${W}-bit register`}>
        <div className="ans-regs">{regs}</div>
        <div style={{ marginTop: 12 }}>
          <SlotStrip M={m.M} lookup={m.lookup} alphabet={alphabet} hot={hotSlot} hotSym={hotSym} />
        </div>
        <Ledger actual={actual} ideal={ideal} at={opIndex} label="bits on the stack + log₂(x / L)" />
      </Panel>
      <Panel
        title="The stack"
        aside={`${visibleStack.length} bits${dir === 'decode' && moved ? ` · ${moved} just popped` : ''} · top is on the right`}
      >
        {visibleStack.length ? <BitRow bits={visibleStack.join('')} spans={spans} group={8} /> : <span className="muted small">empty</span>}
        {dir === 'decode' && st && moved > 0 && (
          <div className="ans-popped">
            popped: <code>{st.bits.join('')}</code>
          </div>
        )}
      </Panel>
      <Narration tone={(dir === 'encode' && flush) || (dir === 'decode' && index === n) ? 'done' : undefined}>{narration}</Narration>
    </>
  )
}

// ----------------------------------------------------------------- tANS

function TansTable({ t, alphabet, hot }: { t: Tans; alphabet: number[]; hot?: number }) {
  return (
    <Panel title={`The table — L = ${t.L} states`} aside={`spread step ${(t.L >> 1) + (t.L >> 3) + 3}`}>
      <div className="ans-tgrid" style={{ gridTemplateColumns: `repeat(${Math.min(16, t.L)}, minmax(0, 1fr))` }}>
        {t.spread.map((s, u) => (
          <div key={u} className={'ans-tcell ' + cls(s) + (u === hot ? ' hot' : '')} title={`state ${t.L + u}: emits ‘${glyph(alphabet[s])}’, reads ${t.nbBits[u]} bits, base ${t.base[u]}`}>
            <span className="ans-tstate">{t.L + u}</span>
            <b>{glyph(alphabet[s])}</b>
            <span className="ans-tnb">
              {t.nbBits[u]}b +{t.base[u]}
            </span>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Each cell is a state: the symbol it decodes to, how many raw bits it reads, and the base those bits are added to.{' '}
        {alphabet.map((b, s) => (
          <span key={b} className="ans-tcount">
            ‘{glyph(b)}’ {t.counts[s]}/{t.L}
          </span>
        ))}
      </p>
    </Panel>
  )
}

function TansStage({
  t,
  alphabet,
  syms,
  dir,
  index,
  enc,
}: {
  t: Tans
  alphabet: number[]
  syms: number[]
  dir: Dir
  index: number
  enc: ReturnType<typeof tansEncode>
}) {
  const n = syms.length
  // Decode trace, from the encoder's chunks in reverse.
  const dec = useMemo(() => {
    const chunks = enc.steps.slice().reverse()
    let X = enc.final - t.L
    const out: { X: number; sym: number; nb: number; value: number; next: number }[] = []
    for (let i = 0; i < n; i++) {
      const c = chunks[i]
      const next = t.base[X] + c.value
      out.push({ X, sym: t.spread[X], nb: t.nbBits[X], value: c.value, next })
      X = next
    }
    return out
  }, [enc, t, n])

  const flush = dir === 'encode' && index === n + 1
  const op = Math.min(index, n)
  const emitted = enc.steps.slice(0, op)
  const shipped = emitted.reduce((a, s) => a + s.nb, 0)

  let hot: number | undefined
  let narration: ReactNode
  let detail: ReactNode = null
  if (dir === 'encode') {
    const st = op > 0 ? enc.steps[op - 1] : null
    if (index === 0) {
      narration = (
        <>
          The encoder state x runs over [{t.L}, {2 * t.L}). Start at x = {t.L} and push the last symbol first.
        </>
      )
    } else if (flush) {
      hot = enc.final - t.L
      narration = (
        <>
          All pushed. The final state {enc.final} is written as {t.R} bits (x − L = {enc.final - t.L}), then the raw bits in reverse. Total{' '}
          {shipped + t.R} bits, {fmt((shipped + t.R) / n, 3)} per symbol.
        </>
      )
    } else if (st) {
      hot = st.after - t.L
      const c = t.counts[st.sym]
      detail = (
        <div className="ans-regs">
          <Register x={st.before} width={t.R + 1} out={st.nb} label="x" note={`shift until x >> nb ∈ [${c}, ${2 * c})`} />
          <Register x={st.reduced} width={t.R + 1} label="x >> nb" note={`occurrence ${st.reduced} of ‘${glyph(alphabet[st.sym])}’`} />
          <Register x={st.after} width={t.R + 1} label="new x" note={`enc[‘${glyph(alphabet[st.sym])}’][${st.reduced - c}] = state ${st.after}`} />
        </div>
      )
      narration = (
        <>
          Push ‘<b>{glyph(alphabet[st.sym])}</b>’, which owns {c} of {t.L} states. x = {st.before} must shrink into [{c}, {2 * c}): write its low{' '}
          <b>{st.nb}</b> bit{st.nb === 1 ? '' : 's'}
          {st.nb ? ` (${toBin(st.value, st.nb)})` : ''}, leaving {st.reduced}; the table maps that to state <b>{st.after}</b>. Ideal cost{' '}
          {fmt(Math.log2(t.L / c), 2)} bits — this push paid {st.nb}, and the difference is carried in the state.
        </>
      )
    }
  } else {
    const d = op > 0 ? dec[op - 1] : null
    if (index === 0) {
      hot = enc.final - t.L
      narration = (
        <>
          The decoder reads the {t.R}-bit state X = {enc.final - t.L} (state {enc.final}).
        </>
      )
    } else if (d) {
      hot = d.X
      detail = (
        <div className="ans-regs">
          <Register x={d.X + t.L} width={t.R + 1} label="state" note={`emits ‘${glyph(alphabet[d.sym])}’`} />
          <Register x={d.next + t.L} width={t.R + 1} inBits={d.nb} label="next" note={`${t.base[d.X]} + ${d.nb ? toBin(d.value, d.nb) : '∅'} → ${d.next}`} />
        </div>
      )
      narration = (
        <>
          State {d.X + t.L} decodes to ‘<b>{glyph(alphabet[d.sym])}</b>’. Read <b>{d.nb}</b> bit{d.nb === 1 ? '' : 's'}
          {d.nb ? ` (${toBin(d.value, d.nb)})` : ''} and add them to the base {t.base[d.X]}: next state {d.next + t.L}. One lookup, one read —
          that is the entire decoder.
          {index === n && <> Done: the state is back to {t.L}.</>}
        </>
      )
    }
  }

  // Bits so far: emission order for encode, read order for decode.
  let bits = ''
  const spans: { start: number; length: number; className: string; title: string }[] = []
  if (dir === 'encode') {
    emitted.forEach((s) => {
      if (s.nb) spans.push({ start: bits.length, length: s.nb, className: cls(s.sym), title: `‘${glyph(alphabet[s.sym])}’: ${s.nb} bits` })
      bits += toBin(s.value, s.nb)
    })
  } else {
    bits = toBin(enc.final - t.L, t.R)
    spans.push({ start: 0, length: t.R, className: 'hl-1', title: 'initial state' })
    dec.slice(0, op).forEach((d) => {
      if (d.nb) spans.push({ start: bits.length, length: d.nb, className: cls(d.sym), title: `after ‘${glyph(alphabet[d.sym])}’: ${d.nb} bits` })
      bits += toBin(d.value, d.nb)
    })
  }

  return (
    <>
      <TansTable t={t} alphabet={alphabet} hot={hot} />
      {detail && <Panel title="This step">{detail}</Panel>}
      <Panel title={dir === 'encode' ? 'Raw bits written' : 'Bits read'} aside={`${bits.length} bits`}>
        {bits ? <BitRow bits={bits} spans={spans} /> : <span className="muted small">none yet</span>}
      </Panel>
      <Narration tone={(dir === 'encode' && flush) || (dir === 'decode' && index === n) ? 'done' : undefined}>{narration}</Narration>
    </>
  )
}
