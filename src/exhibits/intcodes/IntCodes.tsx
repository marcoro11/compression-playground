import { useMemo, useState } from 'react'
import { fmt, int } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Segmented, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { Narration, Transport } from '../../ui/Transport'
import {
  CODES,
  bestParam,
  codeById,
  codeLength,
  distEntropy,
  expectedLength,
  ilog2,
  makeDist,
  optimalGolombM,
  tracingSource,
  zigzag,
  type CodeId,
  type DistId,
  type IntCode,
  type Part,
  type Role,
} from './codes'
import './intcodes.css'

/** Highlighter per role — the same meaning on every row and in the stream. */
const ROLE_CLASS: Record<Role, string> = { prefix: 'hl-6', stop: 'hl-1', payload: 'hl-3', flag: 'hl-4' }
const ROLE_LABEL: Record<Role, string> = { prefix: 'length / unary prefix', stop: 'terminator', payload: 'payload', flag: 'continuation flag' }

/** Line colours for the chart: saturated enough to read on paper and in the dark. */
const LINE: Record<CodeId, string> = {
  unary: '#8a8579',
  gamma: '#d9480f',
  delta: '#c2255c',
  omega: '#7048e8',
  fib: '#1c7ed6',
  golomb: '#0c8599',
  rice: '#2b8a3e',
  expgolomb: '#e67700',
  leb128: '#5f3dc4',
}

const MAX_SHOW = 140

function paramFor(c: IntCode, m: number, k: number): number {
  return c.param === 'm' ? m : c.param === 'k' ? k : 0
}

function paramLabel(c: IntCode, p: number): string {
  return c.param ? ` (${c.param} = ${p})` : ''
}

export function IntCodes() {
  const [raw, setRaw] = useState('9')
  const [m, setM] = useState(3)
  const [k, setK] = useState(2)
  const [selected, setSelected] = useState<CodeId>('gamma')
  const [hoverCode, setHoverCode] = useState<CodeId | null>(null)
  const [dist, setDist] = useState<DistId>('geometric')
  const [geoQ, setGeoQ] = useState(0.1)
  const [zipfS, setZipfS] = useState(2)
  const [uniLog, setUniLog] = useState(10)
  const [streamCode, setStreamCode] = useState<CodeId>('gamma')
  const [streamRaw, setStreamRaw] = useState('3, 1, 4, 1, 5, 9, 2, 6, 5, 3')

  const parsed = parseInt(raw.trim(), 10)
  const valid = Number.isFinite(parsed) && Math.abs(parsed) < 2 ** 31
  const v = valid ? parsed : 0
  const n = v < 0 ? zigzag(v) : v

  return (
    <Page
      slug="intcodes"
      lede={
        <p>
          Huffman needs a table and arithmetic coding needs a model. Sometimes you have neither — just a stream of numbers of unknown size: run
          lengths, match offsets, prediction errors, field tags. A <b>universal code</b> writes any integer with no table at all, and still knows
          where each one ends. Every such code is a bet on how big your numbers tend to be, and the length of its codewords tells you exactly
          what it is betting.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="A number" help="Type any integer. Negative numbers are first folded to non-negative with the zigzag map protobuf uses: 0, −1, 1, −2, 2 … → 0, 1, 2, 3, 4 …">
              <input className="ic-input" value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="numeric" aria-label="Number to encode" />
              <div className="chips">
                {['0', '1', '2', '9', '100', '1000', '624485', '-3'].map((s) => (
                  <button key={s} type="button" className={'chip' + (raw === s ? ' on' : '')} onClick={() => setRaw(s)}>
                    {s}
                  </button>
                ))}
              </div>
              {!valid && <p className="small" style={{ color: 'var(--bad)' }}>Type an integer below 2³¹.</p>}
              {valid && v < 0 && (
                <p className="small muted">
                  zigzag({v}) = {n}: the codes below write {n}.
                </p>
              )}
            </Group>
            <Group title="Parameters">
              <Slider label="Golomb m" value={m} min={1} max={64} onChange={setM} help="Golomb splits n into a quotient ⌊n/m⌋, sent in unary, and a remainder n mod m, sent in (truncated) binary. Large m suits large numbers." />
              <Slider
                label="Rice / Exp-Golomb k"
                value={k}
                min={0}
                max={12}
                onChange={setK}
                help="Rice is Golomb with m = 2ᵏ, so the remainder is exactly k plain bits. Exp-Golomb with parameter k sends the low k bits plainly and the rest with an Elias-γ-like prefix."
              />
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="log₂ n" value={n > 0 ? fmt(Math.log2(n), 2) : '—'} help="The information in n if you already knew it was about this size. No code can do much better for every n at once." />
                <Stat label="binary digits" value={n > 0 ? ilog2(n) + 1 : 1} help="Plain binary — but a decoder would not know where it ends." />
                <Stat label="shortest here" value={valid ? shortest(n, m, k) : '—'} tone="accent" />
              </Stats>
            </Group>
          </>
        }
      >
        <CodewordTable n={n} m={m} k={k} selected={selected} setSelected={setSelected} />
        <LengthChart n={n} m={m} k={k} hover={hoverCode} setHover={setHoverCode} />
        <DistPanel dist={dist} setDist={setDist} geoQ={geoQ} setGeoQ={setGeoQ} zipfS={zipfS} setZipfS={setZipfS} uniLog={uniLog} setUniLog={setUniLog} m={m} k={k} />
        <StreamPanel code={streamCode} setCode={setStreamCode} raw={streamRaw} setRaw={setStreamRaw} m={m} k={k} />
      </Bench>

      <Notes>
        <h2>A code length is a probability</h2>
        <p>
          Kraft’s inequality says a prefix code with lengths L(n) exists exactly when Σ 2<sup>−L(n)</sup> ≤ 1. Read backwards, every code is a
          probability distribution in disguise: it is optimal for P(n) = 2<sup>−L(n)</sup>. So choosing an integer code <i>is</i> choosing a model.
        </p>
        <ul>
          <li>
            <b>Unary</b> spends n + 1 bits on n, so it is perfect for P(n) = 2<sup>−(n+1)</sup> — each number half as likely as the one before.
            Catastrophic for anything else.
          </li>
          <li>
            <b>Elias γ</b> spends 2⌊log₂n⌋ + 1 bits, which is optimal for P(n) ≈ 1/(2n²): small numbers likely, large ones possible.
          </li>
          <li>
            <b>Golomb</b> with parameter m is optimal for a geometric source, P(n) = (1−θ)θⁿ, when m is the smallest integer with θᵐ + θᵐ⁺¹ ≤ 1
            (Gallager &amp; van Voorhis, 1975). The distribution panel computes that m and checks it against every other choice.
          </li>
        </ul>
        <h2>Elias: universal codes (1975)</h2>
        <p>
          Peter Elias’s “Universal codeword sets and representations of the integers” introduced γ, δ and ω. A code is <i>universal</i> when, for
          any distribution with decreasing probabilities, its expected length is within a constant factor of the entropy — you do not need to
          know the distribution, only that small numbers are likelier. γ writes the length in unary and then the number; δ writes the length
          itself in γ, costing log₂n + 2 log₂log₂n; ω recurses all the way down, each group announcing the size of the next, and approaches
          log₂n + log₂log₂n + … .
        </p>
        <Code>{`γ(9):   000 1 001        3 zeros → 4 digits; the 1 is n's own top bit
δ(10):  00 1 00 010      γ(4) says 4 digits; then 10's low 3 digits
ω(10):  11 1010 0        "11" = 3 → next group has 4 digits; 0 = stop`}</Code>
        <h2>Fibonacci codes</h2>
        <p>
          Write n as a sum of non-consecutive Fibonacci numbers (Zeckendorf’s theorem says this is always possible and unique), list the digits
          lowest first, and append a 1. Because the representation never has two adjacent ones, “11” can only mean <i>end of number</i>. That
          makes the code self-synchronising: a flipped bit corrupts one or two numbers and the decoder recovers at the next “11”, where a γ
          stream would be garbage from that point on (Apostolico &amp; Fraenkel, 1987).
        </p>
        <h2>Golomb and Rice</h2>
        <p>
          Solomon Golomb’s 1966 note “Run-length encodings” asked how to send the gaps between rare events — a geometric distribution — and
          answered: divide by m, send the quotient in unary and the remainder in binary. Robert Rice at JPL restricted m to powers of two in 1979,
          so the remainder is just the low k bits: no division, no truncated binary, a shift and a mask. That trade is why Rice codes are
          everywhere a prediction error has to be written fast: <a href="#/flac">FLAC</a> and Shorten, Apple Lossless, JPEG-LS/LOCO-I (which
          adapts k per context on the fly), and the CCSDS lossless standard on spacecraft.
        </p>
        <p>
          The penalty for the wrong parameter is lopsided. Too small and the unary part explodes linearly; too large and you waste a bit or two
          per number. Encoders therefore estimate k from the mean, k ≈ log₂(mean), and refine — FLAC re-estimates it for every partition of every
          block.
        </p>
        <h2>Exp-Golomb</h2>
        <p>
          Teuhola’s exponential Golomb codes (1978) grow buckets geometrically instead of linearly: k = 0 is γ shifted to start at zero. H.264 and
          HEVC use it for almost every header field — <code>ue(v)</code> for unsigned values and <code>se(v)</code> for signed ones, which maps
          1, −1, 2, −2 … to 1, 2, 3, 4 … first.
        </p>
        <h2>Varints: give up on bits</h2>
        <p>
          LEB128 (“little-endian base 128”) splits the number into 7-bit groups and uses the top bit of each byte to say whether another byte
          follows. It is never better than 8/7 of the binary length and is often worse than γ for small numbers — but it is byte-aligned, so
          decoding is a few instructions with no bit shuffling. DWARF debug info, WebAssembly, protobuf (with zigzag for <code>sint32</code>),
          Git packfiles and Android’s DEX all use it. UTF-8 is a cousin: its leading byte announces the length, which buys self-synchronisation
          at the cost of a few bits.
        </p>
        <div className="aside">
          Where they turn up on this site: Rice codes carry FLAC’s residuals; DEFLATE’s “extra bits” are a hand-made Golomb-like bucketing of
          lengths and distances; JPEG’s (size, value) pairs are an Exp-Golomb relative with a Huffman-coded prefix; bzip2’s RUNA/RUNB is
          bijective base 2.
        </div>
      </Notes>
    </Page>
  )
}

function shortest(n: number, m: number, k: number): string {
  const lens = CODES.filter((c) => n >= c.min).map((c) => ({ c, L: codeLength(c, n, paramFor(c, m, k)) }))
  const best = Math.min(...lens.map((x) => x.L))
  const names = lens.filter((x) => x.L === best).map((x) => x.c.name)
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ')
}

// ------------------------------------------------------------ codeword table

function PartBits({ parts, onHover }: { parts: Part[]; onHover?: (p: Part | null) => void }) {
  return (
    <span className="ic-bits">
      {parts.map((p, i) => (
        <span key={i} className={'ic-part ' + ROLE_CLASS[p.role]} title={p.label} onMouseEnter={onHover ? () => onHover(p) : undefined} onMouseLeave={onHover ? () => onHover(null) : undefined}>
          {p.bits}
        </span>
      ))}
    </span>
  )
}

function CodewordTable({ n, m, k, selected, setSelected }: { n: number; m: number; k: number; selected: CodeId; setSelected: (c: CodeId) => void }) {
  const [hoverPart, setHoverPart] = useState<Part | null>(null)
  const rows = CODES.map((c) => {
    const p = paramFor(c, m, k)
    if (n < c.min) return { c, p, len: NaN, parts: null as Part[] | null }
    const len = codeLength(c, n, p)
    return { c, p, len, parts: len <= MAX_SHOW ? c.encode(n, p) : null }
  })
  const best = Math.min(...rows.filter((r) => Number.isFinite(r.len)).map((r) => r.len))
  const sel = rows.find((r) => r.c.id === selected)!
  return (
    <>
      <Panel title={`${int(n)} in every code`} aside="click a row to read it">
        <div className="legend" style={{ marginBottom: 10 }}>
          {(Object.keys(ROLE_CLASS) as Role[]).map((r) => (
            <span key={r}>
              <i className={ROLE_CLASS[r]} />
              {ROLE_LABEL[r]}
            </span>
          ))}
        </div>
        <div className="table-wrap">
          <table className="data ic-table">
            <thead>
              <tr>
                <th>code</th>
                <th>codeword</th>
                <th className="num">bits</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.c.id} className={r.c.id === selected ? 'on' : ''} onClick={() => setSelected(r.c.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <b>{r.c.name}</b>
                    <span className="muted">{paramLabel(r.c, r.p)}</span>
                  </td>
                  <td className="ic-cw">
                    {Number.isNaN(r.len) ? (
                      <span className="muted">codes n ≥ 1 only</span>
                    ) : r.parts ? (
                      <PartBits parts={r.parts} onHover={r.c.id === selected ? setHoverPart : undefined} />
                    ) : (
                      <span className="muted">{int(r.len)} bits — too long to print</span>
                    )}
                  </td>
                  <td className="num" style={{ fontWeight: r.len === best ? 700 : 400, color: r.len === best ? 'var(--good)' : undefined }}>
                    {Number.isNaN(r.len) ? '—' : int(r.len)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Narration>
        {sel.parts ? (
          <>
            <b>{sel.c.name}</b>
            {paramLabel(sel.c, sel.p)} of {int(n)}:{' '}
            {(hoverPart ? [hoverPart] : sel.parts).map((p, i) => (
              <span key={i}>
                {i > 0 && '; '}
                <code className={ROLE_CLASS[p.role]}>{p.bits.length > 24 ? p.bits.slice(0, 12) + '…' : p.bits}</code> {p.label}
              </span>
            ))}
            . <span className="muted">Used by: {sel.c.where}.</span>
          </>
        ) : Number.isNaN(sel.len) ? (
          <>
            <b>{sel.c.name}</b> starts at 1 — it has no codeword for 0. Formats that need zero send n + 1.
          </>
        ) : (
          <>
            <b>{sel.c.name}</b> would spend {int(sel.len)} bits on {int(n)}: the unary part grows linearly with n, which is the whole risk of a
            Golomb-family code with too small a parameter.
          </>
        )}
      </Narration>
    </>
  )
}

// ------------------------------------------------------------------ the chart

function LengthChart({ n, m, k, hover, setHover }: { n: number; m: number; k: number; hover: CodeId | null; setHover: (c: CodeId | null) => void }) {
  const W = 760
  const H = 300
  const L = 40
  const R = 12
  const T = 12
  const B = 34
  const XMAX = 20
  const YMAX = 64
  const xs = useMemo(() => {
    const out: number[] = []
    for (let t = 0; t <= XMAX * 16; t++) {
      const v = Math.round(2 ** (t / 16))
      if (!out.length || out[out.length - 1] !== v) out.push(v)
    }
    return out
  }, [])
  const px = (v: number) => L + (Math.log2(v) / XMAX) * (W - L - R)
  const py = (bits: number) => T + (1 - Math.min(bits, YMAX + 4) / YMAX) * (H - T - B)
  const lines = useMemo(
    () =>
      CODES.map((c) => {
        const p = paramFor(c, m, k)
        let d = ''
        let started = false
        for (const v of xs) {
          const len = codeLength(c, v, p)
          if (len > YMAX + 4) {
            if (started) d += `L ${px(v)} ${py(YMAX + 4)} `
            break
          }
          d += `${started ? 'L' : 'M'} ${px(v).toFixed(1)} ${py(len).toFixed(1)} `
          started = true
        }
        return { c, d }
      }),
    [m, k, xs],
  )
  let ref = ''
  xs.forEach((v, i) => (ref += `${i ? 'L' : 'M'} ${px(v).toFixed(1)} ${py(Math.log2(v)).toFixed(1)} `))
  const nn = Math.max(1, n)
  return (
    <Panel title="Length against n" aside="log scale; dashed = log₂ n">
      <div className="scroll-x">
        <svg viewBox={`0 0 ${W} ${H}`} className="ic-chart" role="img" aria-label="Code length against n for every code">
          {[0, 4, 8, 12, 16, 20].map((e) => (
            <g key={e}>
              <line x1={px(2 ** e)} x2={px(2 ** e)} y1={T} y2={H - B} stroke="var(--line)" />
              <text x={px(2 ** e)} y={H - B + 16} fontSize={11} textAnchor="middle" fill="var(--muted)">
                {e === 0 ? '1' : `2^${e}`}
              </text>
            </g>
          ))}
          {[0, 16, 32, 48, 64].map((b) => (
            <g key={b}>
              <line x1={L} x2={W - R} y1={py(b)} y2={py(b)} stroke="var(--line)" />
              <text x={L - 6} y={py(b) + 4} fontSize={11} textAnchor="end" fill="var(--muted)">
                {b}
              </text>
            </g>
          ))}
          <text x={L} y={H - 4} fontSize={11} fill="var(--muted)">
            n →
          </text>
          <path d={ref} fill="none" stroke="var(--ink)" strokeDasharray="5 4" strokeWidth={1.4} />
          {lines.map(({ c, d }) => (
            <path
              key={c.id}
              d={d}
              fill="none"
              stroke={LINE[c.id]}
              strokeWidth={hover === c.id ? 3.4 : 1.8}
              opacity={hover && hover !== c.id ? 0.25 : 1}
              strokeLinejoin="round"
            />
          ))}
          {n <= 2 ** XMAX && (
            <line x1={px(nn)} x2={px(nn)} y1={T} y2={H - B} stroke="var(--ink)" strokeWidth={1} strokeDasharray="2 3" />
          )}
        </svg>
      </div>
      <div className="ic-keys">
        {CODES.map((c) => (
          <button key={c.id} type="button" onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(c.id)} onBlur={() => setHover(null)}>
            <i style={{ background: LINE[c.id] }} />
            {c.name}
            {paramLabel(c, paramFor(c, m, k))}
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Unary, Golomb and Rice climb in a straight line — on a log axis, that is the curve shooting off the top. γ is twice the dashed line; δ
        and ω hug it; LEB128 moves in 8-bit stairs.
      </p>
    </Panel>
  )
}

// ----------------------------------------------------------- distributions

function DistPanel({
  dist,
  setDist,
  geoQ,
  setGeoQ,
  zipfS,
  setZipfS,
  uniLog,
  setUniLog,
  m,
  k,
}: {
  dist: DistId
  setDist: (d: DistId) => void
  geoQ: number
  setGeoQ: (v: number) => void
  zipfS: number
  setZipfS: (v: number) => void
  uniLog: number
  setUniLog: (v: number) => void
  m: number
  k: number
}) {
  const param = dist === 'geometric' ? geoQ : dist === 'zipf' ? zipfS : 2 ** uniLog
  const d = useMemo(() => makeDist(dist, param), [dist, param])
  const H = useMemo(() => distEntropy(d), [d])
  const rows = useMemo(
    () =>
      CODES.map((c) => {
        const bp = c.param ? bestParam(c, d) : 0
        const cur = paramFor(c, m, k)
        return { c, bp, best: expectedLength(c, d, bp), cur, atCur: c.param ? expectedLength(c, d, cur) : NaN }
      }),
    [d, m, k],
  )
  const max = Math.max(H, ...rows.map((r) => r.best).filter((x) => x < 200))
  const winner = rows.reduce((a, b) => (b.best < a.best ? b : a))
  const gvv = dist === 'geometric' ? optimalGolombM(1 - geoQ) : null
  return (
    <Panel title="Which code for which numbers" aside={`entropy ${fmt(H, 3)} bits`}>
      <div className="ic-distctl">
        <Segmented
          value={dist}
          onChange={setDist}
          options={[
            { value: 'geometric', label: 'Geometric' },
            { value: 'zipf', label: 'Zipf' },
            { value: 'uniform', label: 'Uniform' },
          ]}
        />
        {dist === 'geometric' && (
          <Slider
            label="P(0) = q"
            value={geoQ}
            min={0.01}
            max={0.9}
            step={0.01}
            digits={2}
            onChange={setGeoQ}
            help="P(n) = q(1−q)ⁿ for n = 0, 1, 2 … — the gaps between independent rare events, and roughly what a good predictor’s errors look like."
          />
        )}
        {dist === 'zipf' && (
          <Slider label="exponent s" value={zipfS} min={1.1} max={3} step={0.05} digits={2} onChange={setZipfS} help="P(n) ∝ 1/nˢ on 1 … 100 000: word ranks, file sizes, city populations. Heavy-tailed: large values are rare but not negligible." />
        )}
        {dist === 'uniform' && <Slider label="N" value={uniLog} min={1} max={16} step={1} display={`2^${uniLog} = ${int(2 ** uniLog)}`} onChange={setUniLog} help="Every value 1 … N equally likely. The best you can do is log₂N bits — plain fixed-width binary." />}
      </div>
      <div className="ic-dist">
        {rows.map((r) => (
          <div key={r.c.id} className={'ic-distrow' + (r === winner ? ' win' : '')}>
            <span className="ic-distname">
              {r.c.name}
              {r.c.param && <small>best {r.c.param} = {r.bp}</small>}
            </span>
            <span className="sizebar-track">
              <span className="sizebar-fill" style={{ width: `${Math.min(100, (100 * r.best) / max)}%`, background: LINE[r.c.id] }} />
              <span className="ic-hline" style={{ left: `${(100 * H) / max}%` }} />
            </span>
            <span className="ic-distval">
              {r.best > 999 ? '≫' : fmt(r.best, 2)}
              {r.c.param && Number.isFinite(r.atCur) && r.cur !== r.bp && (
                <small>
                  {r.c.param} = {r.cur}: {r.atCur > 999 ? '≫' : fmt(r.atCur, 2)}
                </small>
              )}
            </span>
          </div>
        ))}
      </div>
      <Narration>
        <b>{winner.c.name}</b>
        {winner.c.param ? ` with ${winner.c.param} = ${winner.bp}` : ''} wins at {fmt(winner.best, 3)} bits per number, {fmt(winner.best - H, 3)} above the
        entropy (the black tick).
        {gvv !== null && (
          <>
            {' '}
            Gallager–van Voorhis predicts the best Golomb m from q alone: the smallest m with (1−q)ᵐ + (1−q)ᵐ⁺¹ ≤ 1 is <b>{gvv}</b>
            {rows.find((r) => r.c.id === 'golomb')!.bp === gvv ? ' — and the exhaustive search agrees.' : '.'}
          </>
        )}
        {dist === 'uniform' && ' On a flat distribution every bet on “small numbers” loses; only codes that can be told the range keep up.'}
      </Narration>
    </Panel>
  )
}

// ------------------------------------------------------------- the stream

interface StreamState {
  bits: string
  /** Per bit: the code part it belongs to and the index of the number. */
  owner: { num: number; role: Role }[]
  notes: string[]
  /** ends[i] = number of bits consumed after decoding number i. */
  ends: number[]
  values: number[]
  dropped: number
}

function buildStream(code: IntCode, values: number[], p: number): StreamState {
  const owner: StreamState['owner'] = []
  let bits = ''
  const kept: number[] = []
  let dropped = 0
  for (const v of values) {
    if (v < code.min || codeLength(code, v, p) > 400) {
      dropped++
      continue
    }
    kept.push(v)
    for (const part of code.encode(v, p)) {
      bits += part.bits
      for (let i = 0; i < part.bits.length; i++) owner.push({ num: kept.length - 1, role: part.role })
    }
  }
  const src = tracingSource(bits)
  const ends: number[] = []
  for (let i = 0; i < kept.length; i++) {
    code.decode(src, p)
    ends.push(src.pos)
  }
  return { bits, owner, notes: src.notes, ends, values: kept, dropped }
}

function StreamPanel({ code, setCode, raw, setRaw, m, k }: { code: CodeId; setCode: (c: CodeId) => void; raw: string; setRaw: (s: string) => void; m: number; k: number }) {
  const c = codeById(code)
  const p = paramFor(c, m, k)
  const values = useMemo(
    () =>
      raw
        .split(/[\s,;]+/)
        .map((x) => parseInt(x, 10))
        .filter((x) => Number.isFinite(x) && x >= 0 && x < 2 ** 31)
        .slice(0, 40),
    [raw],
  )
  const st = useMemo(() => buildStream(c, values, p), [c, values, p])
  const s = useStepper(st.bits.length + 1, { speed: 4, resetKey: code + '|' + raw + '|' + p })
  const i = s.index
  const doneCount = st.ends.filter((e) => e <= i).length
  const cur = i > 0 ? st.owner[i - 1] : null
  const justFinished = i > 0 && st.ends.includes(i)
  return (
    <>
      <Panel title="Decode a stream, one bit at a time" aside={`${st.bits.length} bits for ${st.values.length} numbers`}>
        <div className="ic-streamctl">
          <label className="ctl-label" htmlFor="ic-nums">
            numbers
          </label>
          <input id="ic-nums" className="ic-input" value={raw} onChange={(e) => setRaw(e.target.value)} />
          <div className="chips">
            {CODES.map((x) => (
              <button key={x.id} type="button" className={'chip' + (x.id === code ? ' on' : '')} onClick={() => setCode(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
        </div>
        <div className="ic-stream" aria-label="bitstream">
          {st.bits.split('').map((b, j) => {
            const o = st.owner[j]
            const gap = j > 0 && st.owner[j - 1].num !== o.num
            return (
              <i key={j} className={ROLE_CLASS[o.role] + (j < i ? ' read' : ' unread') + (j === i - 1 ? ' cur' : '') + (gap ? ' gap' : '')} title={`bit ${j}`}>
                {b}
              </i>
            )
          })}
        </div>
        <div className="ic-out">
          <span className="muted small">decoded:</span>
          {st.values.map((v, j) => (
            <span key={j} className={'ic-num' + (j < doneCount ? ' done' : '') + (cur && cur.num === j && !justFinished ? ' busy' : '') + (justFinished && j === doneCount - 1 ? ' fresh' : '')}>
              {j < doneCount ? v : '·'}
            </span>
          ))}
        </div>
        {st.dropped > 0 && (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {st.dropped} number{st.dropped === 1 ? '' : 's'} skipped: {c.min === 1 ? `${c.name} cannot write 0` : 'too long to show with this parameter'}.
          </p>
        )}
      </Panel>
      <Transport s={s} label={(x) => `bit ${x} / ${st.bits.length}`} />
      <Narration tone={i === st.bits.length && i > 0 ? 'done' : undefined}>
        {i === 0 ? (
          <>
            The decoder knows only the code — {c.name}
            {paramLabel(c, p)} — and nothing about where one number ends and the next begins. Step through and watch it find the boundaries
            on its own.
          </>
        ) : (
          <>
            Bit {i - 1} = <code>{st.bits[i - 1]}</code>: {st.notes[i - 1]}.
            {justFinished && (
              <>
                {' '}
                <b>Number {doneCount} done: {st.values[doneCount - 1]}.</b>
              </>
            )}
          </>
        )}
      </Narration>
    </>
  )
}
