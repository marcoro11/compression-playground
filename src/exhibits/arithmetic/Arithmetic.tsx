import { useMemo, useState, type CSSProperties } from 'react'
import { byteCounts, entropy } from '../../lib/entropy'
import { buildTree, codedBits } from '../../lib/huffman'
import { toBin } from '../../lib/bits'
import { fmt, glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { FreqModel, binaryDigits, bitsOf, codeWord, encode, idealIntervals, shortestPoint, type CoderState, type IdealStep, type Interval, type Model } from './coder'
import './arithmetic.css'

type View = 'ideal' | 'coder'
type ModelKind = 'static' | 'adaptive'

/** Exact view is BigInt and redraws every row; keep it to a readable length. */
const IDEAL_CAP = 40
/** Register width for the step-through coder: small enough to watch the shifts. */
const P = 16
const HALF = 2 ** (P - 1)
const Q1 = 2 ** (P - 2)
const Q3 = 3 * Q1

/** Slice colours cycle through the highlighters by alphabet position. */
const sliceClass = (k: number) => 'hl-' + ((k % 6) + 1)

export function Arithmetic() {
  const src = useSource('skew', 600)
  const [view, setView] = useState<View>('ideal')
  const [kind, setKind] = useState<ModelKind>('static')

  const data = src.bytes
  const hist = useMemo(() => byteCounts(data), [data])
  const alphabet = useMemo(() => {
    const a: number[] = []
    for (let b = 0; b < 256; b++) if (hist[b]) a.push(b)
    return a
  }, [hist])
  const syms = useMemo(() => {
    const idx = new Map(alphabet.map((b, i) => [b, i]))
    return Array.from(data, (b) => idx.get(b)!)
  }, [data, alphabet])

  const makeModel = useMemo(
    () => (): Model =>
      kind === 'static' ? new FreqModel(alphabet.map((b) => hist[b])) : new FreqModel(alphabet.map(() => 1), 1, Q1),
    [kind, alphabet, hist],
  )

  const ideal = useMemo(() => idealIntervals(syms.slice(0, IDEAL_CAP), makeModel()), [syms, makeModel])
  const coded = useMemo(() => encode(syms, makeModel(), P, true), [syms, makeModel])
  const idealBits = useMemo(() => {
    const m = makeModel()
    let b = 0
    for (const s of syms) {
      const [lo, hi] = m.range(s)
      b -= Math.log2((hi - lo) / m.total())
      m.update(s)
    }
    return b
  }, [syms, makeModel])

  const H = entropy(hist)
  const huffBits = useMemo(() => codedBits(hist, buildTree(hist).lengths), [hist])
  const n = data.length

  const count = view === 'ideal' ? ideal.length + 1 : coded.states.length
  const s = useStepper(count, { speed: view === 'ideal' ? 2 : 6, resetKey: src.key + view + kind })

  return (
    <Page
      slug="arithmetic"
      lede={
        <p>
          A message is a point on the number line. Start with [0, 1), and for each symbol cut out the slice of the current interval the model
          gives it — a likely symbol keeps most of the interval, a rare one keeps a sliver. What is left at the end has width equal to the
          probability of the <b>whole message</b>, and naming a number inside it takes about −log₂ of that many bits. No symbol ever has to cost a
          whole bit.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['skew', 'abra', 'banana', 'dna', 'tobe', 'prose', 'runs']} maxBytes={600} />
            </Group>
            <Group title="Step through">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'ideal', label: 'Exact intervals' },
                  { value: 'coder', label: '16-bit coder' },
                ]}
              />
              <p className="small muted">
                {view === 'ideal'
                  ? `Each step zooms into one symbol's slice, with exact fractions (first ${IDEAL_CAP} symbols).`
                  : 'Each step is one operation of a real integer coder: narrow the registers, or shift out a bit that can no longer change.'}
              </p>
            </Group>
            <Group title="Model" help="The model only answers one question: how likely is each symbol here? The coder is the same either way — that separation is the point of arithmetic coding.">
              <Segmented
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'static', label: 'Static' },
                  { value: 'adaptive', label: 'Adaptive' },
                ]}
              />
              <p className="small muted">
                {kind === 'static'
                  ? 'Counts from the whole input, fixed. The decoder needs them too, so a file must ship them up front (not counted below).'
                  : 'Every symbol starts at count 1 and gains 1 each time it is seen. The decoder updates the same counts as it goes, so nothing is shipped but the alphabet.'}
              </p>
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="arithmetic" value={n ? fmt(coded.bitLength / n, 3) : '—'} sub="bits / symbol" tone="accent" help="Actual output of the 16-bit coder, including the 2 termination bits, divided by the input length." />
                <Stat label="Huffman" value={n ? fmt(huffBits / n, 3) : '—'} sub="bits / symbol" help="The best whole-bit-per-symbol code for the same counts. It can never go below 1 bit per symbol." />
                <Stat label="entropy" value={fmt(H, 3)} sub="bits / symbol" help="Shannon's order-0 bound, −Σ p·log₂p, using the input's own counts." />
                <Stat
                  label="vs model ideal"
                  value={(coded.bitLength - idealBits >= 0 ? '+' : '') + fmt(coded.bitLength - idealBits, 1)}
                  sub="bits, whole message"
                  help="Actual output minus −Σ log₂ p for this model: the cost of finite-precision registers and of terminating the stream. It stays around 2 bits no matter how long the input."
                />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel title="Input" aside={`${n} symbols, ${alphabet.length} distinct`}>
          <Tape
            bytes={data}
            mark={(i) => {
              const cur = view === 'ideal' ? s.index - 1 : coded.states[s.index]?.symIndex
              if (i === cur) return 'cur ' + sliceClass(syms[i])
              if (cur !== undefined && i < cur) return sliceClass(syms[i])
              if (view === 'ideal' && i >= IDEAL_CAP) return 'dim ghost'
              return 'dim'
            }}
          />
        </Panel>

        {view === 'ideal' ? (
          <IdealStage steps={ideal} index={s.index} alphabet={alphabet} truncated={n > IDEAL_CAP} />
        ) : (
          <CoderStage states={coded.states} index={s.index} alphabet={alphabet} data={data} bits={coded.bits} />
        )}

        <Transport
          s={s}
          label={(i) =>
            view === 'ideal' ? `symbol ${i} / ${count - 1}` : `op ${i} / ${count - 1} · ${coded.states[i]?.kind ?? ''}`
          }
        />

        <Panel title="How big is it" aside={kind === 'static' ? 'model table not counted' : 'adaptive: nothing else to send'}>
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: n * 8, tone: 'faint' },
              { label: 'Huffman', value: huffBits, tone: 'faint', note: `${fmt(huffBits / Math.max(1, n), 2)} bits/symbol` },
              { label: 'arithmetic', value: coded.bitLength, note: `${fmt(coded.bitLength / Math.max(1, n), 2)} bits/symbol` },
              { label: '−log₂ P(message)', value: idealBits, tone: 'ink', note: 'this model, exact' },
              { label: 'entropy floor', value: H * n, tone: 'ink', note: 'order-0, static' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Try <b>Skewed</b>: ‘a’ is 90% of it, ideally worth 0.15 bits, but Huffman must spend a whole bit on every one. On text where no
            symbol dominates, the two land within a few percent — Huffman’s loss is largest exactly when one probability is close to 1.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The idea</h2>
        <Code>{`low, width ← 0, 1
for each symbol s:
    low   ← low + width · cum(s) / total      # where s's slice starts
    width ← width · freq(s) / total           # how much of it s keeps
emit the shortest binary fraction whose every continuation stays in [low, low + width)`}</Code>
        <p>
          The final width is the product of every probability, P(message), so the interval contains a dyadic interval of length at least
          P/4 and the code word needs at most ⌈−log₂ P⌉ + 1 bits. Spread over a long message, that last bit vanishes: arithmetic coding gets
          within <b>two bits of the model’s ideal for the whole message</b>, not within one bit per symbol. Huffman is the special case where every
          slice must be a power of ½.
        </p>
        <h2>From Elias to integers</h2>
        <p>
          The interval picture is Shannon–Fano–Elias coding (1948–63), and on paper it needs infinite precision: the fractions in the exact view
          grow by a factor of the total at every step. Jorma Rissanen and Richard Pasco independently showed in 1976 that you can do it with
          finite registers, and Witten, Neal and Cleary’s 1987 CACM paper “Arithmetic coding for data compression” gave the version almost
          everyone has implemented since — the one in the 16-bit step-through.
        </p>
        <h3>The three shifts</h3>
        <ul>
          <li>
            <b>E1</b> — both registers start with 0 (the interval is in the lower half). Every future number will too, so 0 is shipped and both
            registers shift left.
          </li>
          <li>
            <b>E2</b> — both start with 1. Ship 1, subtract the half, shift.
          </li>
          <li>
            <b>E3</b> — low starts 01 and high starts 10: the interval straddles the middle and could shrink forever without settling a bit
            (“underflow”). But it is inside the middle half, so whatever the next bit turns out to be, the bit after it is its opposite. The
            coder counts one <b>pending</b> bit, deletes the second bit of both registers, and expands. When E1 or E2 finally fires, it emits its
            bit followed by all the pending opposites.
          </li>
        </ul>
        <p>
          After any shift, low &lt; ½ ≤ high and the range is more than a quarter of the register, so every symbol keeps at least one integer
          value as long as the model’s total stays below 2<sup>P−2</sup>. That is the only constraint the model has to respect — and why
          adaptive models halve their counts now and then.
        </p>
        <h2>Modelling is the whole game</h2>
        <p>
          The coder is finished technology: it spends what the model says, to within a hair. All of the compression comes from how well the
          model predicts. An adaptive model costs nothing to transmit because the decoder learns in lock-step; an order-1 model (one table per
          previous byte) learns that <i>q</i> is followed by <i>u</i>; PPM and context mixing (PAQ, cmix) blend many such predictors, and modern
          neural compressors put a language model in exactly the same slot. The bench has order-0 and order-1 versions of this coder.
        </p>
        <h2>Where it went</h2>
        <p>
          For two decades arithmetic coding was a patent minefield — IBM’s Q-coder and its relatives covered most practical variants. JPEG
          standardised an arithmetic mode (the QM-coder) that gives files 5–10% smaller, and almost nobody used it: decoders did not support it
          because implementers would not pay the licence. Huffman won by default. The patents have since expired, and arithmetic coding now sits
          at the heart of H.264/H.265’s <b>CABAC</b>, JPEG 2000, JBIG2, LZMA/xz (a binary range coder — the same idea with bytes shifted instead
          of bits) and AV1.
        </p>
        <p>
          The newest branch is Jarek Duda’s <b>asymmetric numeral systems</b> (2009–14): the same compression as arithmetic coding, but the
          state is a single integer and decoding is a table lookup. tANS is the entropy stage of Zstandard and Apple’s LZFSE; rANS is in
          Oodle, AV1’s successor experiments and several genomics formats.
        </p>
        <div className="aside">
          Precision costs. The integer coder rounds each slice down to whole register values; at 16 bits this is visible in the “vs model ideal”
          figure on long inputs, at 32 bits it is a few millionths of a bit per symbol. Real coders also replace the division with a shift by
          keeping totals at a power of two.
        </div>
      </Notes>
    </Page>
  )
}

// ---------------------------------------------------------------- ideal stage

/** The interval in a row: slices of the next model, the chosen one highlighted. */
function SliceRow({
  counts,
  alphabet,
  chosen,
  pending,
  label,
  right,
}: {
  counts: number[]
  alphabet: number[]
  chosen?: number
  pending?: number
  label: string
  right: string
}) {
  const total = counts.reduce((a, b) => a + b, 0)
  return (
    <div className="ar-row">
      <span className="ar-row-label">{label}</span>
      <div className="ar-bar">
        {counts.map((c, k) => {
          if (!c) return null
          const w = (100 * c) / total
          return (
            <span
              key={k}
              className={'ar-slice ' + sliceClass(k) + (k === chosen ? ' chosen' : chosen !== undefined ? ' off' : '') + (k === pending ? ' pending' : '')}
              style={{ width: w + '%' }}
              title={`‘${glyph(alphabet[k])}’  ${c}/${total}`}
            >
              {w > 3.2 ? glyph(alphabet[k]) : ''}
            </span>
          )
        })}
      </div>
      <span className="ar-row-right">{right}</span>
    </div>
  )
}

/** The trapezoid between a chosen slice and the full-width row below it. */
function Zoom({ lo, hi }: { lo: number; hi: number }) {
  return (
    <div className="ar-zoom">
      <span className="ar-row-label" />
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
        <polygon points={`${lo},0 ${hi},0 100,10 0,10`} className="ar-zoom-fill" />
        <line x1={lo} y1={0} x2={0} y2={10} vectorEffect="non-scaling-stroke" />
        <line x1={hi} y1={0} x2={100} y2={10} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="ar-row-right" />
    </div>
  )
}

const pow2 = (bits: number) => (bits === 0 ? '1' : `2^−${fmt(bits, 2)}`)

function IdealStage({ steps, index, alphabet, truncated }: { steps: IdealStep[]; index: number; alphabet: number[]; truncated: boolean }) {
  if (steps.length === 0) return <Narration>Type something to code.</Narration>
  const SHOW = 6
  const from = Math.max(0, index - SHOW)
  const cur: Interval = index > 0 ? steps[index - 1].after : { L: 0n, W: 1n, D: 1n }
  const nextStep = index < steps.length ? steps[index] : null
  const bits = bitsOf(cur)

  const rows = []
  for (let k = from; k < index; k++) {
    const st = steps[k]
    rows.push(
      <SliceRow
        key={'r' + k}
        counts={st.counts}
        alphabet={alphabet}
        chosen={st.symbol}
        label={`#${k + 1}`}
        right={`${glyph(alphabet[st.symbol])} · ${st.ch - st.cl}/${st.total}`}
      />,
    )
    rows.push(<Zoom key={'z' + k} lo={(100 * st.cl) / st.total} hi={(100 * st.ch) / st.total} />)
  }
  if (nextStep) {
    rows.push(<SliceRow key="next" counts={nextStep.counts} alphabet={alphabet} pending={nextStep.symbol} label={index ? 'now' : 'start'} right="next ?" />)
  } else {
    rows.push(
      <div className="ar-row" key="final">
        <span className="ar-row-label">end</span>
        <div className="ar-bar">
          <span className="ar-slice final" style={{ width: '100%' }}>
            final interval
          </span>
        </div>
        <span className="ar-row-right">done</span>
      </div>,
    )
  }

  // Binary expansions of low and high: the common prefix is already decided.
  const nDigits = Math.min(72, Math.max(12, Math.ceil(bits) + 6))
  const lowBin = binaryDigits(cur.L, cur.D, nDigits)
  const highBin = cur.L + cur.W >= cur.D ? '1'.repeat(nDigits) : binaryDigits(cur.L + cur.W, cur.D, nDigits)
  let common = 0
  while (common < nDigits && lowBin[common] === highBin[common]) common++
  const done = index === steps.length
  const cw = done ? codeWord(cur) : ''
  const sp = done ? shortestPoint(cur) : ''

  return (
    <>
      <Panel title="Zooming in" aside={from > 0 ? `last ${SHOW} of ${index} steps; each row is the previous slice, magnified` : 'each row is the previous slice, magnified'}>
        <div className="ar-stack">{rows}</div>
      </Panel>
      <Panel title="The interval so far" aside={`width = ${pow2(bits)}`}>
        <div className="ar-regs">
          <div className="ar-reg">
            <span className="ar-reg-name">high</span>
            <BinFrac digits={highBin} common={common} />
          </div>
          <div className="ar-reg">
            <span className="ar-reg-name">low</span>
            <BinFrac digits={lowBin} common={common} />
          </div>
        </div>
        <div className="ar-stats">
        <Stats>
          <Stat label="symbols coded" value={index} />
          <Stat label="−log₂ width" value={fmt(bits, 2)} sub="bits of information so far" help="The width of the interval is the product of the probabilities of every symbol coded so far. Pinning down a number inside it takes about −log₂(width) bits." />
          <Stat label="settled bits" value={common} sub="low and high agree" help="Digits where the binary expansions of low and high agree. Every number in the interval starts with them, so a coder could already have sent them — this is what the integer coder's E1/E2 shifts do." />
          {done && <Stat label="code word" value={cw.length} sub="bits" tone="accent" help="Shortest bit string whose every continuation stays inside the final interval. At most ⌈−log₂ width⌉ + 1." />}
        </Stats>
        </div>
        {done && (
          <p className="small" style={{ margin: '12px 0 0' }}>
            Code word <code className="ar-code">0.{cw || '0'}</code> — {cw.length} bits for {index} symbols. The shortest number inside the interval is{' '}
            <code className="ar-code">0.{sp || '0'}</code> ({sp.length} bits), but a decoder reading it could not tell whether more bits follow; the
            code word works whatever comes after it.
          </p>
        )}
      </Panel>
      <Narration tone={done ? 'done' : undefined}>
        {index === 0 && nextStep && (
          <>
            The whole interval [0, 1) belongs to the message. The model slices it in proportion to its counts; the first symbol,{' '}
            <b>‘{glyph(alphabet[nextStep.symbol])}’</b>, owns the dashed slice.
          </>
        )}
        {index > 0 && !done && (
          <>
            Coded ‘<b>{glyph(alphabet[steps[index - 1].symbol])}</b>’ with p = {steps[index - 1].ch - steps[index - 1].cl}/{steps[index - 1].total}: the
            interval kept that fraction of itself, costing {fmt(-Math.log2((steps[index - 1].ch - steps[index - 1].cl) / steps[index - 1].total), 2)}{' '}
            bits. Total so far {fmt(bits, 2)} bits, of which the first {common} are already fixed.
          </>
        )}
        {done && (
          <>
            All {index} symbols coded. Width {pow2(bits)}, so ⌈{fmt(bits, 2)}⌉ + 1 = {Math.ceil(bits) + 1} bits are always enough; this interval
            needs {cw.length}. Compare {index * 8} bits as plain bytes.
            {truncated && <> (Only the first {IDEAL_CAP} symbols are shown exactly — the 16-bit coder handles all of them.)</>}
          </>
        )}
      </Narration>
    </>
  )
}

function BinFrac({ digits, common }: { digits: string; common: number }) {
  return (
    <span className="ar-frac">
      0.
      <span className="ar-settled">{digits.slice(0, common)}</span>
      <span>{digits.slice(common)}</span>…
    </span>
  )
}

// ---------------------------------------------------------------- coder stage

function Register({ name, value, mark }: { name: string; value: number; mark?: 'top' | 'e3' }) {
  const b = toBin(value, P)
  return (
    <div className="ar-reg">
      <span className="ar-reg-name">{name}</span>
      <span className="ar-bits">
        {b.split('').map((c, i) => (
          <span key={i} className={'ar-bit' + (c === '1' ? ' one' : '') + ((mark === 'top' && i === 0) || (mark === 'e3' && i <= 1) ? ' hot' : '')}>
            {c}
          </span>
        ))}
      </span>
      <span className="ar-reg-num">{value}</span>
    </div>
  )
}

/** The register range [0, 2^P) with its quarter marks, the previous interval and the current one. */
function RangeBar({ st, alphabet }: { st: CoderState; alphabet: number[] }) {
  const span = 2 ** P
  const pct = (v: number) => (100 * v) / span
  const slices =
    st.kind === 'narrow' && st.counts
      ? (() => {
          const range = st.prevHigh - st.prevLow + 1
          const out: { k: number; a: number; b: number }[] = []
          let acc = 0
          st.counts.forEach((c, k) => {
            if (!c) return
            const a = st.prevLow + Math.floor((range * acc) / st.total!)
            acc += c
            const b = st.prevLow + Math.floor((range * acc) / st.total!)
            out.push({ k, a, b })
          })
          return out
        })()
      : []
  return (
    <div className="ar-range">
      <div className="ar-range-track">
        {[Q1, HALF, Q3].map((q) => (
          <span key={q} className={'ar-tick' + (q === HALF ? ' half' : '')} style={{ left: pct(q) + '%' }} />
        ))}
        {st.kind !== 'start' && <span className="ar-prev" style={{ left: pct(st.prevLow) + '%', width: pct(st.prevHigh + 1 - st.prevLow) + '%' }} />}
        {slices.map((sl) => (
          <span
            key={sl.k}
            className={'ar-rslice ' + sliceClass(sl.k) + (sl.k === undefined ? '' : '')}
            style={{ left: pct(sl.a) + '%', width: pct(sl.b - sl.a) + '%', opacity: st.low >= sl.a && st.high < sl.b ? 1 : 0.35 } as CSSProperties}
            title={`‘${glyph(alphabet[sl.k])}’`}
          />
        ))}
        <span className="ar-cur" style={{ left: pct(st.low) + '%', width: Math.max(0.4, pct(st.high + 1 - st.low)) + '%' }} />
      </div>
      <div className="ar-range-scale">
        <span style={{ left: '0%' }}>0</span>
        <span style={{ left: '25%' }}>¼</span>
        <span style={{ left: '50%' }}>½</span>
        <span style={{ left: '75%' }}>¾</span>
        <span style={{ left: '100%' }}>1</span>
      </div>
    </div>
  )
}

function CoderStage({ states, index, alphabet, data, bits }: { states: CoderState[]; index: number; alphabet: number[]; data: Uint8Array; bits: string }) {
  const st = states[Math.min(index, states.length - 1)]
  if (!st) return null
  const shown = bits.slice(0, st.outLength)
  const spans = st.emitted ? [{ start: st.outLength - st.emitted.length, length: st.emitted.length, className: 'hl-1', title: `${st.kind} emitted ${st.emitted}` }] : []
  const lowTop = st.low >= HALF ? 1 : 0
  const highTop = st.high >= HALF ? 1 : 0
  // What the coder will do next, so the registers can hint at it.
  const nextKind = states[index + 1]?.kind
  const mark = nextKind === 'E1' || nextKind === 'E2' ? 'top' : nextKind === 'E3' ? 'e3' : undefined
  const sym = st.symIndex >= 0 && st.symIndex < data.length ? data[st.symIndex] : null
  const p = st.kind === 'narrow' ? `${st.ch! - st.cl!}/${st.total}` : ''

  return (
    <>
      <Panel title={`Registers (${P}-bit)`} aside={`pending: ${st.pending}`}>
        <div className="ar-regs">
          <Register name="high" value={st.high} mark={mark} />
          <Register name="low" value={st.low} mark={mark} />
        </div>
        <RangeBar st={st} alphabet={alphabet} />
        <div className="legend" style={{ marginTop: 8 }}>
          <span>
            <i className="ar-legend-prev" /> before
          </span>
          <span>
            <i className="ar-legend-cur" /> after
          </span>
          <span>ticks at ¼ ½ ¾ decide E1 / E2 / E3</span>
        </div>
      </Panel>
      <Panel title="Output" aside={`${st.outLength} bits`}>
        {shown ? <BitRow bits={shown} spans={spans} active={0} group={8} /> : <span className="small muted">nothing emitted yet</span>}
      </Panel>
      <Narration tone={st.kind === 'flush' ? 'done' : undefined}>
        {st.kind === 'start' && (
          <>
            The registers hold the whole range: low = 0000…, high = 1111… (high’s trailing 1s stand for the infinitely repeating 0.1111… = 1).
          </>
        )}
        {st.kind === 'narrow' && sym !== null && (
          <>
            Symbol {st.symIndex + 1}, ‘<b>{glyph(sym)}</b>’ (p = {p}): [low, high] is cut to its slice, keeping {fmt((100 * (st.high - st.low + 1)) / (st.prevHigh - st.prevLow + 1), 1)}% of
            the range. {highTop === lowTop ? <>Both now start with {highTop} — a shift follows.</> : <>They still disagree on the top bit, so nothing can be sent yet.</>}
          </>
        )}
        {(st.kind === 'E1' || st.kind === 'E2') && (
          <>
            <b>{st.kind}</b>: the interval was entirely in the {st.kind === 'E1' ? 'lower' : 'upper'} half, so every number in it starts with{' '}
            {st.kind === 'E1' ? 0 : 1}. Emitted <code>{st.emitted}</code>
            {st.emitted.length > 1 && <> — the {st.kind === 'E1' ? 0 : 1} plus {st.emitted.length - 1} pending {st.kind === 'E1' ? '1' : '0'}s now resolved</>}. Both
            registers shift left; low takes in a 0, high a 1.
          </>
        )}
        {st.kind === 'E3' && (
          <>
            <b>E3</b>: low started 01 and high 10 — the interval straddles ½ but sits inside the middle half. The next bit is still unknown, but the
            one after it must be its opposite. Pending is now <b>{st.pending}</b>; the second bit is dropped from both registers and the middle
            expanded to the full range.
          </>
        )}
        {st.kind === 'flush' && (
          <>
            End of message. Two more bits (plus any pending) name a point safely inside [low, high]; the decoder pads with zeros. Emitted{' '}
            <code>{st.emitted}</code> — {st.outLength} bits in total for {data.length} symbols.
          </>
        )}
      </Narration>
      <p className="small muted" style={{ margin: 0 }}>
        <Help text="The decoder runs the same register arithmetic, plus a third register holding the next 16 bits of the stream. It asks the model which slice that value falls in, which is the symbol, and then makes exactly the same narrow and shift moves as the encoder did." />{' '}
        The decoder mirrors every move above with one extra register holding the next {P} input bits.
      </p>
    </>
  )
}
