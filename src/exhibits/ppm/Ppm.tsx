import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { byteCounts, entropy } from '../../lib/entropy'
import { buildTree, codedBits } from '../../lib/huffman'
import { fmt, glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { arithOrder0 } from '../arithmetic/codec'
import { deflateRaw } from '../deflate/encoder'
import { ppmEncode } from './codec'
import { PpmModel, runModel, type EscapeMethod, type Level, type PpmOptions, type SymbolTrace } from './ppm'
import './ppm.css'

const CAP = 600

type StepBy = 'event' | 'symbol'

/** One step of the walk: symbol `si`, after level `li` (−1 = all levels done and counts updated). */
interface Step {
  si: number
  li: number
}

/** Highlighter by the order that finally coded a byte: long contexts green, brand-new bytes pink. */
export function orderClass(order: number): string {
  if (order < 0) return 'hl-2'
  if (order === 0) return 'hl-5'
  if (order === 1) return 'hl-1'
  if (order === 2) return 'hl-4'
  return 'hl-3'
}

const q = (b: number) => `‘${glyph(b)}’`
const ctxText = (bytes: number[]) => (bytes.length ? '“' + bytes.map(glyph).join('') + '”' : '“”')

const ESCAPE_HELP: Record<EscapeMethod, string> = {
  A: 'PPMA: the escape always counts 1, however many different bytes the context has seen. Simple, and too stingy with escapes early on.',
  B: 'PPMB: a byte must be seen twice before the context offers it (counts minus one); the escape counts the distinct bytes seen.',
  C: 'PPMC (Moffat 1990): the escape counts the number of distinct bytes this context has seen — a context that keeps meeting new bytes escapes often.',
  D: 'PPMD (Howard 1993): like C, but each byte counts 2c − 1 against an escape of q, out of 2n. Halfway between B and C, and usually best.',
}

export function Ppm() {
  const src = useSource('prose', CAP)
  const [order, setOrder] = useState(3)
  const [escape, setEscape] = useState<EscapeMethod>('C')
  const [exclusion, setExclusion] = useState(true)
  const [updateExclusion, setUpdateExclusion] = useState(true)
  const [stepBy, setStepBy] = useState<StepBy>('event')

  const opts: PpmOptions = useMemo(() => ({ order, escape, exclusion, updateExclusion }), [order, escape, exclusion, updateExclusion])
  const data = src.bytes
  const n = data.length
  const run = useMemo(() => runModel(data, opts), [data, opts])

  const steps = useMemo(() => {
    const out: Step[] = []
    run.traces.forEach((t, si) => {
      if (stepBy === 'event') t.levels.forEach((_, li) => out.push({ si, li }))
      out.push({ si, li: -1 })
    })
    return out
  }, [run, stepBy])

  const s = useStepper(steps.length + 1, {
    speed: stepBy === 'event' ? 4 : 8,
    resetKey: src.key + JSON.stringify(opts) + stepBy,
  })
  const step: Step | null = s.index > 0 ? steps[s.index - 1] : null
  const si = step ? step.si : 0
  const t: SymbolTrace | undefined = run.traces[si]
  /** Index of the symbol's first step, for jumping from the chart. */
  const firstStep = useMemo(() => {
    const m: number[] = []
    steps.forEach((st, i) => {
      if (m[st.si] === undefined) m[st.si] = i + 1
    })
    return m
  }, [steps])

  // ---- comparisons
  const hist = useMemo(() => byteCounts(data), [data])
  const H = entropy(hist)
  const huff = useMemo(() => codedBits(hist, buildTree(hist).lengths), [hist])
  const arith0 = useMemo(() => Math.max(0, arithOrder0.encode(data).length - 4) * 8, [data])
  const defl = useMemo(() => deflateRaw(data, { block: 'auto', lazy: true }).length * 8, [data])
  const actual = useMemo(() => {
    const e = ppmEncode(data, opts)
    const header = n < 128 ? 1 : n < 16384 ? 2 : 3
    return (e.length - header) * 8
  }, [data, opts, n])

  // ---- the model's view just before symbol si
  const prediction = useMemo(() => {
    const m = new PpmModel(opts)
    for (let i = 0; i < si && i < n; i++) m.explain(data[i])
    const p = m.predict()
    const ranked = p
      .map((v, b) => [b, v] as const)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
    let sum = 0
    for (const v of p) sum += v
    return { p, ranked, sum }
  }, [opts, data, si, n])

  // Keep the current byte visible when the input box scrolls (phones), without moving the page.
  const tapeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = tapeRef.current
    const cell = box?.querySelector<HTMLElement>('.cell.cur')
    if (!box || !cell || box.scrollHeight <= box.clientHeight) return
    const top = cell.offsetTop - box.offsetTop
    if (top < box.scrollTop || top + cell.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 2
  }, [si, step])

  const levelsDone = t && step ? (step.li < 0 ? t.levels.length : step.li + 1) : 0
  const curLevel: Level | undefined = t && step && step.li >= 0 ? t.levels[step.li] : undefined
  const bitsSoFar = t ? t.levels.slice(0, levelsDone).reduce((a, l) => a - Math.log2(l.prob), 0) : 0

  return (
    <Page
      slug="ppm"
      lede={
        <p>
          Every coder so far either counted symbols with no memory, or pointed back at repeats. PPM does what a reader does: it looks at the last few
          characters and <b>predicts</b> the next one. After “compressio” it has seen ‘n’ every time, so ‘n’ costs a fraction of a bit. When the
          prediction fails it says so — an <b>escape</b> — and asks a shorter context, all the way down to “any byte at all”. The probabilities go to
          an arithmetic coder, so a confident, correct guess costs almost nothing.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['prose', 'abra', 'json', 'tobe', 'dna', 'skew', 'banana', 'random']} maxBytes={CAP} />
            </Group>
            <Group title="Model">
              <Slider
                label="max order"
                value={order}
                min={0}
                max={5}
                onChange={setOrder}
                help="How many previous bytes the longest context uses. Order 0 is a plain adaptive frequency count; order 3 sees “the” before predicting the next letter."
              />
              <Segmented
                label="escape method"
                value={escape}
                onChange={setEscape}
                options={(['A', 'B', 'C', 'D'] as const).map((m) => ({ value: m, label: m, title: ESCAPE_HELP[m] }))}
                help="How much probability a context sets aside for “something I have not seen here”. Hover a letter for its rule."
              />
              <Toggle
                label="exclusion"
                value={exclusion}
                onChange={setExclusion}
                help="After escaping from a context, the next byte is known not to be any byte that context offered — so shorter contexts drop them from their totals. Without it, that probability is simply wasted."
              />
              <Toggle
                label="update exclusion"
                value={updateExclusion}
                onChange={setUpdateExclusion}
                help="After coding a byte, bump its count only in the context that predicted it and the longer ones. Shorter contexts then count how often a byte was new at the higher level — which is what they are actually asked."
              />
              <p className="small muted">{ESCAPE_HELP[escape]}</p>
            </Group>
            <Group title="Step by">
              <Segmented
                value={stepBy}
                onChange={setStepBy}
                options={[
                  { value: 'event', label: 'Context level' },
                  { value: 'symbol', label: 'Whole byte' },
                ]}
              />
            </Group>
            <Group title="Result">
              <Stats>
                <Stat
                  label="bits / byte"
                  value={n ? fmt(run.bits / n, 3) : '—'}
                  tone="accent"
                  help="Σ −log₂ p over the input under this model, divided by its length. The arithmetic coder gets within a couple of bits of the sum."
                />
                <Stat
                  label="order-0 entropy"
                  value={fmt(H, 3)}
                  help="The floor for any coder that ignores context. PPM goes under it by using the previous bytes."
                />
                <Stat
                  label="contexts"
                  value={run.contexts}
                  help="Distinct contexts (of every order) that now hold counts. Memory is the price of high orders."
                />
                <Stat
                  label="escapes"
                  value={run.escapes}
                  help="How many times a context had to say “not one of mine”. Each costs bits, but tells shorter contexts what to exclude."
                />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel title="Input" aside={t ? `byte ${si} of ${n}` : `${n} bytes`}>
          <div className="ppm-input" ref={tapeRef}>
            <Tape
              bytes={data}
              mark={(i) => {
                const tr = run.traces[i]
                const done = step && (i < si || (i === si && step.li < 0))
                if (step && i === si) return 'cur' + (done ? ' ' + orderClass(tr.foundAt) : '')
                if (done) return orderClass(tr.foundAt)
                return 'dim'
              }}
              cellTitle={(i) => {
                const tr = run.traces[i]
                return tr ? `#${i} ${q(tr.sym)} — ${fmt(tr.bits, 2)} bits, coded at order ${tr.foundAt}` : ''
              }}
              onClick={(i) => s.setIndex(firstStep[i] ?? 0)}
            />
          </div>
          <OrderLegend order={order} />
        </Panel>

        {t && step ? (
          <>
            <Ladder trace={t} levelsDone={levelsDone} current={step.li} data={data} />
            {curLevel ? (
              <LevelPanel level={curLevel} target={t.sym} exclusion={exclusion} />
            ) : (
              <UpdatePanel trace={t} data={data} updateExclusion={updateExclusion} />
            )}
          </>
        ) : (
          <Panel title="Contexts">
            <p className="small muted" style={{ margin: 0 }}>
              Step forward. For each byte the model takes the last {order} byte{order === 1 ? '' : 's'} as a context and asks the longest one first.
              Click any byte above to jump to it.
            </p>
          </Panel>
        )}

        <Narration tone={s.atEnd && n > 0 ? 'done' : undefined}>
          <StepNarration step={step} trace={t} n={n} opts={opts} bitsSoFar={bitsSoFar} total={run.bits} levelsDone={levelsDone} />
        </Narration>

        <Transport s={s} label={(i) => (i === 0 ? `start · ${steps.length} steps` : `byte ${steps[i - 1].si + 1} / ${n}`)} />

        <div className="grid-2">
          <Panel title="What the model expects next" aside={t ? `before byte ${si}` : ''}>
            <Expectation prediction={prediction} actual={t?.sym} />
          </Panel>
          <Panel title="Bits per byte" aside="click a bar to jump">
            <BitsChart traces={run.traces} H={H} current={step ? si : -1} onPick={(i) => s.setIndex(firstStep[i] ?? 0)} />
          </Panel>
        </div>

        <Panel title="How big is it" aside="adaptive models ship no tables">
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: n * 8, tone: 'faint' },
              { label: 'Huffman', value: huff, tone: 'faint', note: 'static, table not counted' },
              { label: 'arithmetic o0', value: arith0, tone: 'faint', note: 'adaptive, no context' },
              { label: 'DEFLATE', value: defl, tone: 'faint', note: 'this site’s encoder' },
              { label: 'PPM, ideal', value: run.bits, tone: 'ink', note: 'Σ −log₂ p' },
              { label: 'PPM, coded', value: actual, note: `${fmt(actual / Math.max(1, n), 2)} bits/byte` },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            On a few hundred bytes every new letter costs a full 8 bits plus its escapes, so PPM and DEFLATE run close; PPM pulls away on long natural
            text, where the contexts have had time to fill. The Bench runs order 5 with method D — load a large text file there to see it.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The algorithm</h2>
        <Code>{`for each byte x:
    for k = min(maxOrder, position) down to 0:
        C ← counts for the last k bytes          # skip if never seen
        drop bytes excluded above                # exclusion
        if x ∈ C:  code x with p = w(x) / (Σw + esc);  break
        else:      code ESCAPE with p = esc / (Σw + esc);  exclude C's bytes
    if not found: code x uniformly among the bytes not excluded   # order −1
    add 1 to x's count in the contexts that should learn it      # update`}</Code>
        <p>
          Contexts are counted as they are seen, so the decoder can keep an identical model: it decodes a byte, updates the same counts, and is ready
          for the next. Nothing about the model is ever transmitted. All the cleverness is in two places: <b>how much to set aside for the escape</b>,
          and <b>which counts to update</b>.
        </p>
        <h2>The zero-frequency problem</h2>
        <p>
          A context that has seen ‘t’ three times and nothing else would, by pure counting, give every other byte probability zero — and an arithmetic
          coder cannot code a zero. The escape is the fix: reserve some probability for “something new”. How much is a guess about novelty, and Cleary
          and Witten’s 1984 paper tried two: <b>A</b> (one count, always) and <b>B</b> (one count per distinct byte seen, with each byte needing two
          sightings to be predicted). Alistair Moffat’s <b>C</b> (1990) keeps B’s escape and drops the “seen twice” rule; Paul Howard’s <b>D</b>{' '}
          (1993) splits the difference. Switch between them above and watch the escape row of the count table change.
        </p>
        <h2>Exclusion</h2>
        <p>
          Once order 3 has escaped, the decoder knows the byte is <i>not</i> any of the ones order 3 offered — otherwise the encoder would have coded
          it there. A shorter context that still counts those bytes is spending probability on outcomes that cannot happen. Exclusion removes them
          from its total. It is free information, and it is visible: turn it off, and the “What the model expects next” panel’s probabilities stop
          summing to 1 — the missing part is code space the coder can never use. The test suite checks both facts exactly, with rational arithmetic.
        </p>
        <h2>Beyond PPMC</h2>
        <ul>
          <li>
            <b>PPM*</b> (Cleary, Teahan &amp; Witten 1995) drops the maximum order: it uses the shortest <i>deterministic</i> context — one that has
            only ever been followed by one byte — however long. That is how a context model eats long repeats the way LZ77 does.
          </li>
          <li>
            <b>PPMd / PPMII</b> (Dmitry Shkarin, 2002) — the one in 7-Zip and RAR — adds <b>information inheritance</b> (a new context starts with
            counts borrowed from its parent rather than from nothing) and <b>SEE</b>, secondary escape estimation: the escape probability is itself
            learned, from a small table indexed by features of the context.
          </li>
          <li>
            <b>Context mixing</b> (Matt Mahoney’s PAQ, 2002 onwards; Byron Knoll’s cmix) stops choosing one context. Hundreds of models each predict
            the next <i>bit</i>, and a small neural network mixes their predictions in the logistic domain, learning online which to trust. These hold
            the records on the Hutter Prize (compress 1 GB of Wikipedia) — at speeds of kilobytes per second.
          </li>
        </ul>
        <h2>Prediction is compression</h2>
        <p>
          Nothing here is specific to counting. Any model that outputs a probability for the next symbol can drive an arithmetic coder, and the file
          costs exactly the model’s log-loss: −Σ log₂ p. A better predictor is a better compressor, and vice versa — the two problems are the same
          problem. That is why researchers measure language models in bits per character, and why a large language model feeding its next-token
          probabilities into an arithmetic coder compresses text far below anything on this site (if you do not count the size of the model). PPM is
          the same machine with a lookup table for a brain.
        </p>
        <div className="aside">
          Where it ships: PPMd in 7-Zip (<code>.7z</code> with <code>-m0=PPMd</code>), RAR’s text mode, and as an option in ZIP (method 98). Context
          mixing lives in ZPAQ and in the lossless modes of some archival tools; its ideas — learned mixing of many predictors — are what Zstandard
          and Brotli do not do, which is why they are a hundred times faster.
        </div>
      </Notes>
    </Page>
  )
}

// --------------------------------------------------------------------- pieces

function OrderLegend({ order }: { order: number }) {
  const rows: [number, string][] = []
  for (let k = Math.min(order, 3); k >= 0; k--) rows.push([k, k === 3 && order > 3 ? `order ≥3` : `order ${k}`])
  rows.push([-1, 'new byte (order −1)'])
  return (
    <div className="legend" style={{ marginTop: 12 }}>
      <span className="muted">coded at:</span>
      {rows.map(([k, label]) => (
        <span key={k}>
          <i className={orderClass(k)} />
          {label}
        </span>
      ))}
    </div>
  )
}

function Ladder({ trace, levelsDone, current, data }: { trace: SymbolTrace; levelsDone: number; current: number; data: Uint8Array }) {
  const rows: { order: number; level?: Level; idx: number }[] = []
  for (let k = trace.top; k >= -1; k--) {
    const idx = trace.levels.findIndex((l) => l.order === k)
    rows.push({ order: k, level: idx >= 0 ? trace.levels[idx] : undefined, idx })
  }
  return (
    <Panel title={`Contexts for byte ${trace.pos}`} aside={`${q(trace.sym)} — longest first`}>
      <div className="ppm-ladder">
        {rows.map(({ order, level, idx }) => {
          const reached = level && idx < levelsDone
          const isCur = idx === current
          let status: ReactNode = <span className="muted">not needed</span>
          if (level && !reached) status = <span className="muted">…</span>
          else if (level && reached) {
            if (level.status === 'unseen') status = <span className="muted">never seen · free drop</span>
            else if (level.status === 'empty') status = <span className="muted">nothing left to offer · free drop</span>
            else if (level.status === 'escape')
              status = (
                <span>
                  escape{' '}
                  <b>
                    {level.num}/{level.den}
                  </b>{' '}
                  <span className="muted">({fmt(-Math.log2(level.prob), 2)} b)</span>
                </span>
              )
            else
              status = (
                <span>
                  {q(trace.sym)}{' '}
                  <b>
                    {level.num}/{level.den}
                  </b>{' '}
                  <span className="muted">({fmt(-Math.log2(level.prob), 2)} b)</span>
                </span>
              )
          }
          const tone = reached ? (level!.status === 'hit' ? orderClass(order) : level!.status === 'escape' ? 'esc' : 'skip') : 'pending'
          return (
            <div key={order} className={'ppm-rung ' + tone + (isCur ? ' on' : '')}>
              <span className="ppm-rung-order">{order < 0 ? 'order −1' : `order ${order}`}</span>
              <span className="ppm-rung-ctx">
                {order > 0 ? (
                  <Tape bytes={data.subarray(trace.pos - order, trace.pos)} className="ppm-mini" />
                ) : (
                  <span className="muted small">{order === 0 ? 'no context' : 'every byte alike'}</span>
                )}
                <span className="ppm-next">{reached && level!.status === 'hit' ? glyph(trace.sym) : '?'}</span>
              </span>
              <span className="ppm-rung-status">{status}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function LevelPanel({ level, target, exclusion }: { level: Level; target: number; exclusion: boolean }) {
  if (level.order < 0) {
    return (
      <Panel title="Order −1: the fallback" aside={`1 / ${level.den}`}>
        <p className="small" style={{ margin: 0 }}>
          No context knows {q(target)}. At the bottom every byte is equally likely —{' '}
          {level.den === 256 ? 'all 256 of them' : `the ${level.den} that ${exclusion ? 'were not excluded above' : 'remain'}`} — so it costs{' '}
          <b>
            log₂ {level.den} = {fmt(Math.log2(level.den), 2)} bits
          </b>
          . This is what makes PPM never assign zero probability to anything.
        </p>
      </Panel>
    )
  }
  if (level.status === 'unseen') {
    return (
      <Panel title={`Order ${level.order}: ${ctxText(level.context)}`} aside="no counts">
        <p className="small muted" style={{ margin: 0 }}>
          This context has never occurred before, so there is nothing to code here. The decoder can see that too, so moving down a level costs no
          bits.
        </p>
      </Panel>
    )
  }
  const items = level.items.slice().sort((a, b) => b.count - a.count || a.sym - b.sym)
  const max = Math.max(1, ...items.map((i) => i.weight), level.escWeight)
  return (
    <Panel
      title={`Order ${level.order}: counts after ${level.order ? ctxText(level.context) : 'anything'}`}
      aside={level.total ? `total ${level.total}` : 'nothing offered'}
    >
      <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table className="data ppm-counts">
          <thead>
            <tr>
              <th>next</th>
              <th className="num">count</th>
              <th className="num">
                weight{' '}
                <Help text="What the escape method turns the count into: c for A and C, c − 1 for B, 2c − 1 for D. Excluded bytes weigh nothing." />
              </th>
              <th style={{ width: '45%' }}>p</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const isT = it.sym === target
              return (
                <tr key={it.sym} className={(it.excluded ? 'ppm-excl ' : '') + (isT && level.status === 'hit' ? 'on' : '')}>
                  <td>
                    <span className={'cell ' + (isT ? 'cur' : '')} style={{ height: 20, minWidth: 20 }}>
                      {glyph(it.sym)}
                    </span>
                    {it.excluded && <span className="muted small"> excluded</span>}
                  </td>
                  <td className="num">{it.count}</td>
                  <td className="num">{it.weight}</td>
                  <td>
                    <span className="ppm-bar">
                      <span style={{ width: `${(100 * it.weight) / max}%` }} />
                    </span>
                    <span className="ppm-p">{level.total && it.weight ? `${it.weight}/${level.total}` : '—'}</span>
                  </td>
                </tr>
              )
            })}
            {level.status !== 'empty' && (
              <tr className={'ppm-esc-row ' + (level.status === 'escape' ? 'on' : '')}>
                <td>
                  <span className="cell" style={{ height: 20 }}>
                    esc
                  </span>
                </td>
                <td className="num">{items.filter((i) => !i.excluded).length}</td>
                <td className="num">{level.escWeight}</td>
                <td>
                  <span className="ppm-bar esc">
                    <span style={{ width: `${(100 * level.escWeight) / max}%` }} />
                  </span>
                  <span className="ppm-p">
                    {level.escWeight}/{level.total}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function UpdatePanel({ trace, data, updateExclusion }: { trace: SymbolTrace; data: Uint8Array; updateExclusion: boolean }) {
  const ctxOf = (k: number) => Array.from(data.subarray(trace.pos - k, trace.pos))
  return (
    <Panel title="Update" aside={`${q(trace.sym)} cost ${fmt(trace.bits, 2)} bits`}>
      <div className="ppm-updates">
        {trace.updated.map((k) => (
          <span key={k} className="ppm-update">
            <span className="muted">order {k}</span> {k ? ctxText(ctxOf(k)) : '“”'} → {q(trace.sym)} <b>+1</b>
          </span>
        ))}
      </div>
      {updateExclusion && trace.foundAt > 0 && (
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Update exclusion: orders below {trace.foundAt} are left alone — they were never asked about this byte.
        </p>
      )}
    </Panel>
  )
}

function StepNarration({
  step,
  trace,
  n,
  opts,
  bitsSoFar,
  total,
  levelsDone,
}: {
  step: Step | null
  trace?: SymbolTrace
  n: number
  opts: PpmOptions
  bitsSoFar: number
  total: number
  levelsDone: number
}) {
  if (!n) return <>Type something to model.</>
  if (!step || !trace) {
    return (
      <>
        Nothing coded yet. Every count starts at zero, so the first byte has no context at all and falls straight to order −1: one of 256, 8 bits.
        Step forward.
      </>
    )
  }
  const path = trace.levels.slice(0, levelsDone).filter((l) => l.status === 'escape' || l.status === 'hit')
  const product = path.map((l) => `${l.num}/${l.den}`).join(' × ')
  if (step.li < 0) {
    return (
      <>
        {q(trace.sym)} cost <b>{fmt(trace.bits, 2)} bits</b>
        {path.length > 1 && <> ({product})</>}
        {trace.foundAt >= 0 ? `, found at order ${trace.foundAt}` : ', as a brand-new byte'}. Counts updated in order
        {trace.updated.length === 1 ? '' : 's'} {trace.updated.join(', ')}.
        {trace.pos === n - 1 && (
          <>
            {' '}
            Done: {fmt(total, 1)} bits for {n} bytes, {fmt(total / n, 3)} per byte.
          </>
        )}
      </>
    )
  }
  const l = trace.levels[step.li]
  const ctx = l.order > 0 ? `the context ${ctxText(l.context)}` : l.order === 0 ? 'order 0 (no context)' : ''
  switch (l.status) {
    case 'unseen':
      return (
        <>
          Order {l.order}: {ctx} has never occurred, so it has no counts. The decoder knows that too — dropping to order {l.order - 1} is free.
        </>
      )
    case 'empty':
      return (
        <>
          Order {l.order}: {ctx} has only seen bytes that are {opts.escape === 'B' ? 'excluded or seen just once' : 'already excluded'} — it has
          nothing to offer, so the drop is free.
        </>
      )
    case 'escape':
      return (
        <>
          Order {l.order}: {ctx} has seen{' '}
          {l.items
            .filter((i) => !i.excluded)
            .map((i) => q(i.sym))
            .join(' ')}{' '}
          but never {q(trace.sym)}. Code an <b>escape</b>: {l.num}/{l.den} = {fmt(l.prob, 3)} ({fmt(-Math.log2(l.prob), 2)} bits).
          {opts.exclusion && l.excludedHere.length > 0 && (
            <>
              {' '}
              Those {l.excludedHere.length} byte{l.excludedHere.length === 1 ? ' is' : 's are'} now excluded below.
            </>
          )}
        </>
      )
    case 'hit':
      if (l.order < 0)
        return (
          <>
            Order −1: no context has seen {q(trace.sym)}, so it is coded as one of the {l.den} remaining bytes, 1/{l.den}. Total for this byte:{' '}
            {product} → <b>{fmt(bitsSoFar, 2)} bits</b>.
          </>
        )
      return (
        <>
          Order {l.order}: {ctx} has seen {q(trace.sym)} {l.items.find((i) => i.sym === trace.sym)?.count} time
          {l.items.find((i) => i.sym === trace.sym)?.count === 1 ? '' : 's'} — code it at {l.num}/{l.den} = {fmt(l.prob, 3)}. Total for this byte:{' '}
          {path.length > 1 ? product + ' → ' : ''}
          <b>{fmt(bitsSoFar, 2)} bits</b>
          {bitsSoFar < 1 ? ' — less than one bit, which Huffman could never do.' : '.'}
        </>
      )
  }
}

function Expectation({ prediction, actual }: { prediction: { ranked: (readonly [number, number])[]; sum: number }; actual?: number }) {
  const top = prediction.ranked.slice(0, 8)
  const rank = actual === undefined ? -1 : prediction.ranked.findIndex(([b]) => b === actual)
  const pa = rank >= 0 ? prediction.ranked[rank][1] : 0
  const max = Math.max(1e-9, ...top.map(([, v]) => v))
  return (
    <div className="ppm-expect">
      {top.map(([b, v]) => (
        <div key={b} className={'ppm-expect-row' + (b === actual ? ' hit' : '')}>
          <span className="cell" style={{ height: 22, minWidth: 22 }}>
            {glyph(b)}
          </span>
          <span className="ppm-bar">
            <span style={{ width: `${(100 * v) / max}%` }} />
          </span>
          <span className="ppm-p">{(100 * v).toFixed(v < 0.01 ? 2 : 1)}%</span>
        </div>
      ))}
      {actual !== undefined && (
        <p className="small" style={{ margin: '8px 0 0' }}>
          Actually next: {q(actual)}, ranked <b>#{rank + 1}</b> at {(100 * pa).toFixed(pa < 0.01 ? 3 : 1)}% → {fmt(-Math.log2(pa), 2)} bits.
          {prediction.sum < 0.999999 && (
            <span className="muted">
              {' '}
              These sum to {(100 * prediction.sum).toFixed(2)}%: without exclusion the rest is code space nothing can use.
            </span>
          )}
        </p>
      )}
    </div>
  )
}

function BitsChart({ traces, H, current, onPick }: { traces: SymbolTrace[]; H: number; current: number; onPick: (i: number) => void }) {
  const n = traces.length
  if (!n) return <p className="small muted">No input.</p>
  const W = 600
  const Hh = 150
  const top = 16
  const bw = W / n
  const y = (b: number) => Hh - (Math.min(b, top) / top) * Hh
  let run = 0
  const avg: string[] = []
  traces.forEach((t, i) => {
    run += t.bits
    avg.push(`${i ? 'L' : 'M'} ${(i + 0.5) * bw} ${y(run / (i + 1))}`)
  })
  return (
    <div className="ppm-chart">
      <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" role="img" aria-label="bits spent on each byte">
        {[4, 8, 12].map((b) => (
          <line key={b} x1={0} x2={W} y1={y(b)} y2={y(b)} className="grid" />
        ))}
        {traces.map((t, i) => (
          <rect
            key={i}
            x={i * bw}
            y={y(t.bits)}
            width={Math.max(bw - (bw > 3 ? 0.6 : 0), 0.4)}
            height={Hh - y(t.bits)}
            className={'bar ' + orderClass(t.foundAt) + (i === current ? ' cur' : '')}
            onClick={() => onPick(i)}
          />
        ))}
        <line x1={0} x2={W} y1={y(H)} y2={y(H)} className="h0" />
        <path d={avg.join(' ')} className="avg" />
        {current >= 0 && <line x1={(current + 0.5) * bw} x2={(current + 0.5) * bw} y1={0} y2={Hh} className="cursor" />}
      </svg>
      <div className="legend">
        <span>
          <i className="ppm-leg-h0" /> order-0 entropy {fmt(H, 2)}
        </span>
        <span>
          <i className="ppm-leg-avg" /> running average
        </span>
        <span className="muted">scale 0–{top} bits</span>
      </div>
    </div>
  )
}
