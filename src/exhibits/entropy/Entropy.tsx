import { useEffect, useMemo, useRef, useState } from 'react'
import { byteCounts, conditionalEntropy, entropy } from '../../lib/entropy'
import { randomBytes } from '../../lib/samples'
import { fmt, glyph, utf8 } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Stat, Stats } from '../../ui/Controls'
import { browserDeflateSize } from '../../ui/Home'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { guessBounds, stringsOfLength, stringsShorterThan } from './info'
import './entropy.css'

/** Surprisal buckets in bits: [0,2) [2,3) [3,4) [4,5) [5,6.5) [6.5,∞). */
const HEAT_EDGES = [2, 3, 4, 5, 6.5]
const heat = (bits: number) => {
  let k = 0
  while (k < HEAT_EDGES.length && bits >= HEAT_EDGES[k]) k++
  return k
}

export function Entropy() {
  const src = useSource('prose', 2000)
  const data = src.bytes
  const n = data.length
  const hist = useMemo(() => byteCounts(data), [data])
  const H = entropy(hist)
  const symbols = useMemo(() => {
    const s: number[] = []
    for (let b = 0; b < 256; b++) if (hist[b]) s.push(b)
    return s.sort((a, b) => hist[b] - hist[a] || a - b)
  }, [hist])
  const s = useStepper(symbols.length + 1, { speed: 2, resetKey: src.key })

  return (
    <Page
      slug="entropy"
      lede={
        <>
          <p>
            In 1948 Claude Shannon defined the <b>information</b> in an event as how surprised you should be by it: −log₂ p bits. Average that
            over a source and you get its <b>entropy</b>, and Shannon proved it is a hard floor — no code that handles symbols one at a time can
            average fewer bits per symbol. Every other exhibit on this site is measured against this number.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['prose', 'tobe', 'abra', 'skew', 'dna', 'json', 'runs', 'random']} maxBytes={2000} />
            </Group>
            <Group title="The floor">
              <Stats>
                <Stat label="bits / char" value={fmt(H, 3)} tone="accent" help="Order-0 entropy H = −Σ p·log₂p over the byte frequencies of this input." />
                <Stat label="symbols" value={symbols.length} help="Distinct byte values." />
                <Stat label="as bytes" value={n * 8} sub="bits" />
                <Stat label="floor" value={Math.ceil(H * n)} sub="bits" help="n × H: the fewest bits any symbol-by-symbol code could use for this input with these frequencies." />
              </Stats>
              <p className="small muted">
                {n ? `${fmt((100 * H) / 8, 1)}% of the 8 bits each byte occupies.` : ''} log₂ {symbols.length || 1} = {fmt(Math.log2(Math.max(1, symbols.length)), 2)} would be
                the cost if every symbol were equally likely.
              </p>
            </Group>
          </>
        }
      >
        <SurprisePanel data={data} hist={hist} />

        <SumPanel symbols={symbols} hist={hist} n={n} index={s.index} H={H} />
        <Transport s={s} label={(i) => `term ${i} / ${symbols.length}`} />
        <SumNarration symbols={symbols} hist={hist} n={n} index={s.index} H={H} />

        <ContextPanel data={data} />
        <GuessPanel />
        <PigeonPanel />
        <RandomPanel data={data} />
      </Bench>

      <Notes>
        <h2>Self-information</h2>
        <p>
          Shannon wanted a measure of information with three properties: it depends only on the probability of an event, it is larger for rarer
          events, and the information in two independent events is the sum of each. The only function that turns a product of probabilities into a
          sum is a logarithm, so the information in an event of probability <i>p</i> is −log <i>p</i>; base 2 makes the unit a bit. A fair coin
          flip is 1 bit. A letter ‘e’ in English (p ≈ 0.12) is about 3 bits; a ‘z’ (p ≈ 0.0007) is about 10.
        </p>
        <Code>{`I(x) = −log₂ p(x)                     bits of surprise in one symbol
H    = Σ p(x) · I(x) = −Σ p(x) log₂ p(x)   the average, in bits per symbol`}</Code>
        <h2>The source coding theorem</h2>
        <p>
          Shannon’s first theorem (1948) says that a source of entropy <i>H</i> can be coded in an average of <i>H</i> + ε bits per symbol for any
          ε &gt; 0 by coding long enough blocks, and in no fewer than <i>H</i>. The short version for a prefix code on single symbols: the average
          length L satisfies H ≤ L &lt; H + 1, and <a href="#/huffman">Huffman</a> achieves the best L. The +1 is the price of whole bits per
          symbol; <a href="#/arithmetic">arithmetic coding</a> pays it once per message instead of once per symbol.
        </p>
        <h2>Entropy belongs to a model, not to a file</h2>
        <p>
          The number in the side panel is the entropy of a <i>model</i>: “each byte independently, with these frequencies.” Change the model and the
          number changes. Conditioning on the previous character (order-1) already pulls English from about 4.1 to about 3.3 bits/char, and
          Shannon’s guessing experiments put the real figure for English at roughly 0.6–1.3 bits/char. Dictionary coders like{' '}
          <a href="#/lz77">LZ77</a> and context mixers beat the order-0 floor on text precisely by using a better model. The order-k estimates on
          this page are computed from the input itself, which is why they fall too fast on short inputs: a context seen once predicts its follower
          perfectly, in hindsight.
        </p>
        <h2>The guessing game</h2>
        <p>
          In “Prediction and Entropy of Printed English” (1951) Shannon had people guess text one letter at a time and recorded how many guesses
          each letter took. The sequence of guess counts is a reversible encoding of the text — an identical twin with the same knowledge could
          reproduce the text from it — so its entropy, −Σ qᵢ log₂ qᵢ, bounds the entropy of the text from above. He also gave a lower bound,
          Σ i (qᵢ − qᵢ₊₁) log₂ i. Human readers are excellent language models: that is the whole point of the experiment.
        </p>
        <h2>Kolmogorov complexity</h2>
        <p>
          A different definition skips probability altogether: the information in one particular string is the length of the shortest program
          that prints it. The first million digits of π have almost none by that measure, though they look random to every statistical test. It is
          the right idea and uncomputable — no algorithm can find the shortest program in general — which is why practical compressors are built
          on models whose entropy they can measure.
        </p>
        <h2>The counting argument</h2>
        <p>
          There are 2ⁿ files of n bits and only 2ⁿ − 1 files shorter than that, counting the empty one. A lossless compressor must map different
          inputs to different outputs, so at least one n-bit input cannot get shorter. Worse: at most 2<sup>n−k+1</sup> − 1 inputs can shrink by k
          bits or more, fewer than one in 2<sup>k−1</sup>. Fewer than one file in 128 can lose even a byte. Every compressor that wins on text
          loses, a little, on nearly everything else — which is why formats like DEFLATE have a “stored” mode that caps the damage at a few bytes.
        </p>
        <div className="aside">
          A claim of a compressor that shrinks <i>every</i> file, or shrinks random data, or can be applied repeatedly, is wrong by counting. The
          comp.compression FAQ has kept a list of them since the early 1990s.
        </div>
      </Notes>
    </Page>
  )
}

// ----------------------------------------------------------- surprise tape

function SurprisePanel({ data, hist }: { data: Uint8Array; hist: number[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = data.length
  const bits = (b: number) => -Math.log2(hist[b] / n)
  const total = useMemo(() => {
    let t = 0
    for (let i = 0; i < data.length; i++) t += -Math.log2(hist[data[i]] / data.length)
    return t
  }, [data, hist])
  const shown = Math.min(n, 800)
  return (
    <Panel title="Surprise, character by character" aside={n ? `Σ = ${fmt(total, 1)} bits = n × H` : ''}>
      <Tape
        bytes={data.subarray(0, shown)}
        mark={(i) => 'heat-' + heat(bits(data[i])) + (hover === i ? ' cur' : '')}
        onHover={setHover}
        cellTitle={(i) => `‘${glyph(data[i])}’  p = ${(hist[data[i]] / n).toFixed(4)}  →  ${bits(data[i]).toFixed(2)} bits`}
      />
      {shown < n && <p className="small muted">First {shown} of {n} characters shown.</p>}
      <div className="ent-hover">
        {hover !== null && hover < n ? (
          <>
            ‘<b>{glyph(data[hover])}</b>’ occurs {hist[data[hover]]} time{hist[data[hover]] === 1 ? '' : 's'} in {n}: p = {(hist[data[hover]] / n).toFixed(4)}, so seeing it
            is worth −log₂ p = <b>{bits(data[hover]).toFixed(2)} bits</b>.
          </>
        ) : (
          <span className="muted">Hover a character to see what it is worth. Common characters are pale; rare ones are hot.</span>
        )}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {['< 2', '2–3', '3–4', '4–5', '5–6.5', '≥ 6.5'].map((l, k) => (
          <span key={k}>
            <i className={'heat-' + k} /> {l} bits
          </span>
        ))}
      </div>
    </Panel>
  )
}

// --------------------------------------------------------- the sum, stepped

function SumPanel({ symbols, hist, n, index, H }: { symbols: number[]; hist: number[]; n: number; index: number; H: number }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    const row = el?.querySelector<HTMLElement>('tr.on')
    if (!el || !row) return
    const top = row.offsetTop
    if (top < el.scrollTop + 30 || top > el.scrollTop + el.clientHeight - 30) el.scrollTop = top - el.clientHeight / 2
  }, [index])
  const maxP = symbols.length ? hist[symbols[0]] / n : 1
  let running = 0
  return (
    <Panel title="The sum, term by term" aside={index === symbols.length && n ? `H = ${fmt(H, 4)} bits / char` : `${index} of ${symbols.length} terms`}>
      <div className="table-wrap" ref={box} style={{ maxHeight: 360, overflowY: 'auto', position: 'relative' }}>
        <table className="data">
          <thead>
            <tr>
              <th>sym</th>
              <th className="num">count</th>
              <th>p</th>
              <th className="num">
                −log₂p <Help text="The ideal code length for this symbol: how many bits a perfect code would spend on it." />
              </th>
              <th className="num">
                p·(−log₂p) <Help text="This symbol's share of the average: how often it occurs times what it costs." />
              </th>
              <th className="num">running Σ</th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((b, i) => {
              const p = hist[b] / n
              const term = -p * Math.log2(p)
              const revealed = i < index
              if (revealed) running += term
              return (
                <tr key={b} className={i === index - 1 ? 'on' : revealed ? '' : 'ent-later'}>
                  <td>
                    <span className="cell" style={{ height: 20, minWidth: 20 }}>
                      {glyph(b)}
                    </span>
                  </td>
                  <td className="num">{hist[b]}</td>
                  <td>
                    <span className="ent-bar" style={{ width: Math.max(2, (60 * p) / maxP) }} /> {p.toFixed(3)}
                  </td>
                  <td className="num">{(-Math.log2(p)).toFixed(2)}</td>
                  <td className="num">{revealed ? term.toFixed(4) : '·'}</td>
                  <td className="num">{revealed ? <b>{running.toFixed(4)}</b> : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SumNarration({ symbols, hist, n, index, H }: { symbols: number[]; hist: number[]; n: number; index: number; H: number }) {
  if (!n) return <Narration>Type something to measure.</Narration>
  if (index === 0)
    return (
      <Narration>
        The entropy is a weighted average: each symbol’s ideal code length −log₂ p, weighted by how often it occurs. Step forward to add the
        symbols in, most common first.
      </Narration>
    )
  let running = 0
  for (let i = 0; i < index; i++) {
    const p = hist[symbols[i]] / n
    running -= p * Math.log2(p)
  }
  const b = symbols[index - 1]
  const p = hist[b] / n
  if (index === symbols.length)
    return (
      <Narration tone="done">
        Last term: ‘<b>{glyph(b)}</b>’ adds {(-p * Math.log2(p)).toFixed(4)}. <b>H = {fmt(H, 3)} bits per character</b>, so these {n} characters need
        at least {Math.ceil(H * n)} bits in any symbol-by-symbol code — {fmt((100 * H) / 8, 1)}% of the {n * 8} they occupy as bytes.
        {symbols.length === 1 && ' One symbol, no surprise: zero bits.'}
      </Narration>
    )
  return (
    <Narration>
      ‘<b>{glyph(b)}</b>’ occurs {hist[b]} times in {n}: p = {p.toFixed(3)}. Its ideal code is −log₂ {p.toFixed(3)} = {(-Math.log2(p)).toFixed(2)} bits, and it
      contributes {p.toFixed(3)} × {(-Math.log2(p)).toFixed(2)} = <b>{(-p * Math.log2(p)).toFixed(4)}</b> bits per character. Running total{' '}
      {running.toFixed(3)}.
    </Narration>
  )
}

// ---------------------------------------------------------------- contexts

function ContextPanel({ data }: { data: Uint8Array }) {
  const rows = useMemo(
    () =>
      [0, 1, 2, 3].map((k) => {
        const contexts = new Set<string>()
        for (let i = k; i < data.length; i++) contexts.add(String.fromCharCode(...data.subarray(i - k, i)))
        const samples = Math.max(0, data.length - k)
        return { k, h: conditionalEntropy(data, k), contexts: k === 0 ? 1 : contexts.size, samples }
      }),
    [data],
  )
  const max = Math.max(0.001, ...rows.map((r) => r.h))
  // A context seen fewer than ~4 times on average has not been measured, it has been memorised.
  const shaky = (r: (typeof rows)[number]) => r.k > 0 && r.samples / Math.max(1, r.contexts) < 4
  const anyShaky = rows.some(shaky)
  return (
    <Panel title="What the previous characters tell you" aside="H(next | previous k)">
      <div className="ent-ctx">
        {rows.map((r) => (
          <FragmentRow key={r.k} label={r.k === 0 ? 'order 0' : `order ${r.k}`} sub={r.k === 0 ? 'no context' : `${r.contexts} contexts`} value={r.h} max={max} shaky={shaky(r)} />
        ))}
      </div>
      {anyShaky ? (
        <p className="ent-warn">
          Striped bars are not to be trusted. Measured on its own {data.length} characters, an order-k model sees most contexts only a handful of
          times, so it “predicts” followers it has already seen — the estimate falls toward zero because it has memorised the input, not learned
          the language. Real context models have to pay to learn, and the honest numbers come from coding text the model has not seen.
        </p>
      ) : (
        <p className="small muted" style={{ margin: '12px 0 0' }}>
          Each extra character of context can only lower the conditional entropy. The drop from order 0 to order 1 is the part of the structure
          a symbol-by-symbol code throws away.
        </p>
      )}
    </Panel>
  )
}

function FragmentRow({ label, sub, value, max, shaky }: { label: string; sub: string; value: number; max: number; shaky: boolean }) {
  return (
    <>
      <span>
        {label}
        <small>{sub}</small>
      </span>
      <span className="track">
        <span className={'fill' + (shaky ? ' shaky' : '')} style={{ width: `${(100 * value) / max}%` }} />
      </span>
      <span>
        <b>{value.toFixed(3)}</b> <span className="muted">bits</span>
      </span>
    </>
  )
}

// ------------------------------------------------------- Shannon's game

const GAME_TEXTS = [
  'the quick brown fox jumps over the lazy dog',
  'there is no such thing as a free lunch',
  'information is the resolution of uncertainty',
  'to be or not to be that is the question',
]

function GuessPanel() {
  const [t, setT] = useState(0)
  const text = GAME_TEXTS[t]
  const [pos, setPos] = useState(0)
  const [tried, setTried] = useState<string[]>([])
  const [counts, setCounts] = useState<number[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const done = pos >= text.length

  const reset = (k = t) => {
    setT(k)
    setPos(0)
    setTried([])
    setCounts([])
  }

  const guess = (raw: string) => {
    if (done) return
    const c = raw.toLowerCase()
    if (!/^[a-z ]$/.test(c) || tried.includes(c)) return
    if (c === text[pos]) {
      setCounts((cs) => [...cs, tried.length + 1])
      setPos(pos + 1)
      setTried([])
    } else setTried([...tried, c])
  }
  const giveUp = () => {
    if (done) return
    setCounts((cs) => [...cs, 27])
    setPos(pos + 1)
    setTried([])
  }

  const b = guessBounds(counts)
  const avg = counts.length ? counts.reduce((a, x) => a + x, 0) / counts.length : 0
  const firstTry = counts.filter((c) => c === 1).length

  return (
    <Panel title="Shannon’s guessing game" aside="you are the language model">
      <p className="small" style={{ marginTop: 0 }}>
        Guess the hidden sentence one character at a time (letters and space). Every wrong guess is counted. The guess counts are a code for the
        text, so their entropy is an upper bound on how many bits per character the text really needs — given what you know about English.
      </p>
      <div className="ent-game-text" aria-live="polite">
        {Array.from(text).map((ch, i) =>
          i < pos ? (
            <span key={i} className={counts[i] === 1 ? 'hl-3' : counts[i] <= 3 ? 'hl-1' : 'hl-2'} title={`${counts[i]} guess${counts[i] === 1 ? '' : 'es'}`}>
              {ch === ' ' ? '␣' : ch}
              <sup>{counts[i] > 1 ? counts[i] : ''}</sup>
            </span>
          ) : i === pos ? (
            <span key={i} className="here">
              ?
            </span>
          ) : (
            <span key={i} className="todo">
              ·
            </span>
          ),
        )}
      </div>
      <input
        ref={inputRef}
        className="ent-game-input"
        placeholder={done ? 'Done — pick another sentence' : 'Type your guess for the next character…'}
        value=""
        onChange={(e) => guess(e.target.value.slice(-1))}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault()
            guess(' ')
          }
        }}
        disabled={done}
        aria-label="Guess the next character"
      />
      <div className="legend">
        <span>
          <i className="hl-3" /> first try
        </span>
        <span>
          <i className="hl-1" /> 2–3 guesses
        </span>
        <span>
          <i className="hl-2" /> 4 or more
        </span>
      </div>
      <div className="ent-tried">
        {tried.length > 0 && (
          <>
            wrong so far:{' '}
            {tried.map((c) => (
              <s key={c}>{c === ' ' ? '␣' : c}</s>
            ))}
          </>
        )}
      </div>
      <div className="row" style={{ margin: '10px 0' }}>
        <Button onClick={giveUp} disabled={done} title="Reveal this character and count it as 27 guesses">
          reveal
        </Button>
        <Segmented value={t} onChange={(k) => reset(k)} options={GAME_TEXTS.map((_, k) => ({ value: k, label: `#${k + 1}` }))} />
      </div>
      <Stats>
        <Stat label="characters" value={`${pos} / ${text.length}`} />
        <Stat label="first try" value={counts.length ? `${Math.round((100 * firstTry) / counts.length)}%` : '—'} />
        <Stat label="avg guesses" value={counts.length ? fmt(avg, 2) : '—'} />
        <Stat
          label="≤ bits / char"
          value={counts.length ? fmt(b.upper, 2) : '—'}
          tone="accent"
          help="Entropy of your guess-count distribution, −Σ qᵢ log₂ qᵢ. Shannon's upper bound on the text's entropy for a reader who knows what you know. Noisy on one short sentence."
        />
      </Stats>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        For comparison: log₂ 27 = 4.75 bits if every character were equally likely; order-0 English is about 4.1. Shannon’s subjects reached about
        1 bit per character on long passages.
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------- pigeons

function PigeonPanel() {
  const [n, setN] = useState(3)
  const longs = stringsOfLength(n)
  const shorts = stringsShorterThan(n)
  const [victim, setVictim] = useState<number | null>(null)
  const v = victim !== null && victim < longs.length ? victim : longs.length - 1
  // Everyone but the victim gets its own shorter output in order; the victim is left with ε, already taken.
  const target: number[] = []
  let next = 0
  longs.forEach((_, i) => {
    target.push(i === v ? 0 : next++)
  })
  const RH = 22
  const rows = longs.length
  const height = rows * RH + 14
  const xL = 60
  const xR = 360
  const yOf = (i: number) => 14 + i * RH
  const shareWith = target.findIndex((t, i) => i !== v && t === 0)
  return (
    <Panel title="The pigeonhole" aside={`${longs.length} inputs, ${shorts.length} shorter outputs`}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Segmented label="input length n" value={n} onChange={(k) => (setN(k), setVictim(null))} options={[1, 2, 3, 4].map((k) => ({ value: k, label: `${k} bit${k > 1 ? 's' : ''}` }))} />
      </div>
      <svg className="ent-pigeon" viewBox={`0 0 420 ${height}`}>
        <text x={xL} y={8} fontSize={10} textAnchor="middle" fill="var(--muted)">
          every {n}-bit input
        </text>
        <text x={xR} y={8} fontSize={10} textAnchor="middle" fill="var(--muted)">
          every shorter output
        </text>
        {longs.map((_, i) => {
          const bad = i === v || i === shareWith
          return (
            <line
              key={'l' + i}
              x1={xL + 28}
              y1={yOf(i) + 8}
              x2={xR - 28}
              y2={yOf(target[i]) + 8}
              stroke={bad ? 'var(--bad)' : 'var(--line-strong)'}
              strokeWidth={bad ? 2.2 : 1}
            />
          )
        })}
        {longs.map((s, i) => (
          <g key={'L' + i} className="long" onClick={() => setVictim(i)}>
            <rect x={xL - 28} y={yOf(i)} width={56} height={17} rx={3} fill={i === v ? 'var(--hl-2)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth={i === v ? 2 : 1} />
            <text x={xL} y={yOf(i) + 12.5} fontSize={11} textAnchor="middle" fill={i === v ? 'var(--hl-ink)' : 'var(--ink)'}>
              {s}
            </text>
          </g>
        ))}
        {shorts.map((s, i) => (
          <g key={'S' + i}>
            <rect x={xR - 28} y={yOf(i)} width={56} height={17} rx={3} fill={i === 0 ? 'var(--hl-2)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth={i === 0 ? 2 : 1} />
            <text x={xR} y={yOf(i) + 12.5} fontSize={11} textAnchor="middle" fill={i === 0 ? 'var(--hl-ink)' : 'var(--ink)'}>
              {s === '' ? 'ε' : s}
            </text>
          </g>
        ))}
      </svg>
      <Narration tone="warn">
        {longs.length} inputs but only {shorts.length} shorter outputs (ε is the empty file). Give every other input its own output, and the one
        left over — click any input to make it the unlucky one — finds them all taken: <b>{longs[v]}</b> has to share ε with{' '}
        <b>{longs[shareWith]}</b>, and the decoder cannot tell which one it was given.
      </Narration>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        In general at most 2<sup>n−k+1</sup> − 1 of the 2ⁿ inputs can shrink by k bits or more. For 1 KiB files and k = 8, that means fewer than 1 in{' '}
        {2 ** (8 - 1)} of them can lose even a byte.
      </p>
    </Panel>
  )
}

// ----------------------------------------------------------- random bytes

function RandomPanel({ data }: { data: Uint8Array }) {
  const random = useMemo(() => randomBytes(4096, 21), [])
  const prose = useMemo(() => utf8('It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness. '.repeat(37)), [])
  const [sizes, setSizes] = useState<{ yours: number | null; random: number | null; prose: number | null }>({ yours: null, random: null, prose: null })
  useEffect(() => {
    let live = true
    Promise.all([browserDeflateSize(data), browserDeflateSize(random), browserDeflateSize(prose)]).then(([yours, r, p]) => {
      if (live) setSizes({ yours, random: r, prose: p })
    })
    return () => {
      live = false
    }
  }, [data, random, prose])
  if (sizes.random === null && sizes.yours === null)
    return (
      <Panel title="Random bytes do not shrink">
        <p className="small muted" style={{ margin: 0 }}>
          This browser has no CompressionStream, so the live check is unavailable.
        </p>
      </Panel>
    )
  return (
    <Panel title="Random bytes do not shrink" aside="your browser’s own DEFLATE">
      <SizeBars
        unit="bytes"
        rows={[
          { label: 'your input', value: data.length, tone: 'faint' },
          { label: 'input → deflate', value: sizes.yours ?? 0, tone: (sizes.yours ?? 0) > data.length ? 'bad' : 'good' },
          { label: 'prose ×37', value: prose.length, tone: 'faint' },
          { label: 'prose → deflate', value: sizes.prose ?? 0, tone: 'good' },
          { label: '4 KiB random', value: random.length, tone: 'faint' },
          { label: 'random → deflate', value: sizes.random ?? 0, tone: (sizes.random ?? 0) > random.length ? 'bad' : 'good', note: 'block headers' },
        ]}
      />
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        A production DEFLATE gives up on random input and falls back to stored blocks, so it grows by only a few bytes — the cheapest possible
        failure. The counting argument says it cannot do better than that on average.
      </p>
    </Panel>
  )
}
