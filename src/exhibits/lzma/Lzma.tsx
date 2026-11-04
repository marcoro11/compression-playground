import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Codec } from '../../lib/codec'
import { fmt, glyph, hex2 } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { deflateCodec } from '../deflate/codec'
import { encode, propsByte, STATE_NAMES, type CodedBit, type Packet, type PacketKind } from './lzma'
import './lzma.css'

/**
 * Zstandard lives in a sibling exhibit that may or may not exist in this build;
 * a glob that finds nothing is just an empty object, so the comparison row
 * appears only when there is something to compare with.
 */
const zstdModules = import.meta.glob<{ codecs?: Codec[] }>('../zstd/codec.ts', { eager: true })
const zstdCodec: Codec | undefined = Object.values(zstdModules).flatMap((m) => m.codecs ?? []).find((c) => c.id.startsWith('zstd'))

const KIND_CLASS: Record<PacketKind, string> = {
  LIT: 'hl-1',
  MATCH: 'hl-5',
  SHORTREP: 'hl-2',
  REP0: 'hl-3',
  REP1: 'hl-4',
  REP2: 'hl-4',
  REP3: 'hl-4',
  END: 'hl-6',
}

const KIND_LABEL: Record<PacketKind, string> = {
  LIT: 'literal',
  MATCH: 'match (new distance)',
  SHORTREP: 'short rep (1 byte at rep0)',
  REP0: 'rep0',
  REP1: 'rep1',
  REP2: 'rep2',
  REP3: 'rep3',
  END: 'end marker',
}

const COLOUR_TABLE = 'red=ff0000 grn=00ff00 blu=0000ff red=ee0000 grn=00ee00 blu=0000ee red=dd0000 grn=00dd00 blu=0000dd'

const bin = (v: number, w: number) => v.toString(2).padStart(w, '0')
const hex = (v: number, w: number) => Math.floor(v).toString(16).padStart(w, '0')

export function Lzma() {
  const src = useSource('json', 1200)
  const [lc, setLc] = useState(3)
  const [lp, setLp] = useState(0)
  const [pb, setPb] = useState(2)
  const [endMarker, setEndMarker] = useState(false)
  const [lazy, setLazy] = useState(true)
  const [hoverBit, setHoverBit] = useState<number | null>(null)

  const data = src.bytes
  const res = useMemo(() => encode(data, { lc, lp, pb, endMarker, lazy, record: true, dictSize: 1 << 16 }), [data, lc, lp, pb, endMarker, lazy])
  const packets = res.packets
  const s = useStepper(packets.length + 1, { speed: 4, resetKey: src.key + lc + lp + pb + endMarker + lazy })
  const pk: Packet | null = s.index > 0 ? packets[s.index - 1] : null
  useEffect(() => setHoverBit(null), [s.index])

  // Which packet produced each input byte, for colouring the tape.
  const owner = useMemo(() => {
    const o = new Int32Array(data.length).fill(-1)
    packets.forEach((p, k) => {
      for (let i = p.pos; i < p.pos + p.len && i < data.length; i++) o[i] = k
    })
    return o
  }, [packets, data.length])

  const deflateBytes = useMemo(() => deflateCodec.encode(data).length, [data])
  const zstdBytes = useMemo(() => (zstdCodec ? zstdCodec.encode(data).length : null), [data])
  const totalBits = Object.values(res.bitsByKind).reduce((a, b) => a + b, 0)

  const cur = pk ? pk.pos + pk.len : 0
  const mark = (i: number): string | undefined => {
    const k = owner[i]
    if (!pk) return i === 0 ? 'cur' : 'dim'
    if (k === s.index - 1) return 'cur ' + KIND_CLASS[pk.kind]
    if (pk.dist && i >= pk.pos - pk.dist && i < pk.pos - pk.dist + pk.len) {
      if (k < s.index - 1) return 'src ' + (k >= 0 ? KIND_CLASS[packets[k].kind] : '')
    }
    if (k >= 0 && k < s.index - 1) return KIND_CLASS[packets[k].kind]
    return i >= cur ? 'dim' : undefined
  }

  const bitRow = pk && hoverBit !== null ? pk.bits[hoverBit] : pk ? pk.bits[pk.bits.length - 1] : null
  const outSoFar = pk ? res.body.slice(0, bitRow ? bitRow.out : pk.outAfter) : new Uint8Array(0)
  const packetCost = pk ? pk.bits.reduce((a, b) => a + b.cost, 0) : 0

  return (
    <Page
      slug="lzma"
      lede={
        <>
          <p>
            DEFLATE writes Huffman codes: whole bits, from tables fixed for a block. LZMA never writes a code at all. It breaks everything — “is
            this a match?”, “is bit 5 of this literal a one?” — into <b>yes/no decisions</b>, gives each decision its own probability that learns
            from every previous answer in the same context, and lets a range coder charge −log₂p for each. A decision the model saw coming costs a
            tenth of a bit.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['json', 'prose', 'tobe', 'abra', 'runs', 'dna', 'random']} maxBytes={1200} />
              <button type="button" className={'chip' + (src.text === COLOUR_TABLE ? ' on' : '')} onClick={() => src.setText(COLOUR_TABLE)} title="Short reps and rep1 in action">
                colour table
              </button>
            </Group>
            <Group title="Properties" help="The three numbers packed into the first header byte as (pb·5 + lp)·9 + lc. They choose how many contexts the probabilities are split into.">
              <Slider label="lc — literal context bits" value={lc} min={0} max={8} onChange={setLc} help="How many high bits of the previous byte select the literal probabilities. 3 means the top 3 bits: 8 sets of 768 probabilities." />
              <Slider label="lp — literal position bits" value={lp} min={0} max={4} onChange={setLp} help="Low bits of the position mixed into the literal context — useful for data made of 2- or 4-byte records." />
              <Slider label="pb — position bits" value={pb} min={0} max={4} onChange={setPb} help="Low bits of the position mixed into the match/rep decisions. 2 suits 32-bit aligned data; 0 suits text." />
              <p className="small mono">
                props byte 0x{hex2(propsByte({ lc, lp, pb }))} · {(0x300 << (lc + lp)).toLocaleString('en-US')} literal probabilities
              </p>
              <Toggle label="End marker (unknown size)" value={endMarker} onChange={setEndMarker} help="xz writes the size as 'unknown' and ends the stream with a special match whose distance is all ones. With a known size the decoder just stops." />
              <Toggle label="Lazy matching" value={lazy} onChange={setLazy} help="Before taking a match, look one byte ahead for a longer one." />
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="file bytes" value={res.bytes.length} tone="accent" sub={`13 header + ${res.body.length}`} />
                <Stat label="bits / byte" value={data.length ? fmt((8 * res.body.length) / data.length, 2) : '—'} help="Range-coded body only, per input byte." />
                <Stat label="packets" value={packets.length} />
                <Stat label="vs DEFLATE" value={`${res.bytes.length - deflateBytes >= 0 ? '+' : ''}${res.bytes.length - deflateBytes}`} sub="bytes" tone={res.bytes.length <= deflateBytes ? 'good' : 'bad'} />
              </Stats>
            </Group>
          </>
        }
      >
        <Panel title="Input" aside={pk ? `byte ${pk.pos}${pk.len > 1 ? '–' + (pk.pos + pk.len - 1) : ''} of ${data.length}` : `${data.length} bytes`}>
          <Tape bytes={data} mark={mark} onClick={(i) => owner[i] >= 0 && s.setIndex(owner[i] + 1)} />
          <div className="legend lz-legend">
            {(['LIT', 'MATCH', 'REP0', 'REP1', 'SHORTREP'] as PacketKind[]).map((k) => (
              <span key={k}>
                <i className={KIND_CLASS[k]} /> {k === 'REP1' ? 'rep1–3' : KIND_LABEL[k]}
              </span>
            ))}
            <span>
              <i className="lz-src" /> copy source
            </span>
          </div>
        </Panel>

        <div className="lz-grid">
          <Panel title="State machine" aside={pk ? `${pk.stateBefore} → ${pk.stateAfter}` : 'state 0'}>
            <StateDiagram before={pk?.stateBefore ?? 0} after={pk?.stateAfter ?? 0} />
            <p className="small muted lz-statecap">
              {pk ? (
                <>
                  Now in state <b>{pk.stateAfter}</b>: “{STATE_NAMES[pk.stateAfter]}”.{' '}
                  {pk.stateAfter >= 7 ? 'The next literal will be coded against the byte at rep0.' : 'The next literal is coded plainly.'}
                </>
              ) : (
                'States 0–6 come after a literal, 7–11 after a match or rep. Every flag probability is chosen by state, so the model learns e.g. that a match is rarely followed by another match.'
              )}
            </p>
          </Panel>
          <Panel title="Remembered distances" aside="rep0 … rep3">
            <Reps before={pk?.repsBefore ?? [1, 1, 1, 1]} after={pk?.repsAfter ?? [1, 1, 1, 1]} kind={pk?.kind} />
            {pk && (pk.kind === 'LIT' || pk.kind === 'SHORTREP') && (
              <LiteralView byte={pk.byte!} matchByte={pk.kind === 'SHORTREP' ? pk.byte : pk.matchByte} kind={pk.kind} />
            )}
          </Panel>
        </div>

        <Panel
          title={pk ? <>Packet {s.index}: <span className={'lz-kind ' + KIND_CLASS[pk.kind]}>{pk.kind}</span></> : 'Packet'}
          aside={pk ? `${pk.bits.length} decisions · ${fmt(packetCost, 2)} bits` : ''}
        >
          {pk ? (
            <>
              <p className="lz-why">{pk.why}</p>
              <div className="table-wrap lz-bits">
                <table className="data">
                  <thead>
                    <tr>
                      <th>decision</th>
                      <th style={{ minWidth: 110 }}>
                        P(0) <Help text="The model's probability that this bit is 0, before coding it. Bars near full mean 'surely 0'; near empty, 'surely 1'. Direct bits have no model: always ½." />
                      </th>
                      <th className="num">bit</th>
                      <th className="num">
                        cost <Help text="−log₂ of the probability given to what actually happened. A well-predicted bit costs far less than 1; a surprise costs more." />
                      </th>
                      <th className="num">P(0) after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pk.bits.map((b, k) => (
                      <tr key={k} className={hoverBit === k ? 'on' : ''} onMouseEnter={() => setHoverBit(k)} onClick={() => setHoverBit(k)}>
                        <td className={'lz-dec k-' + b.kind}>{b.label}</td>
                        <td>
                          <ProbBar p={b.p} bit={b.bit} />
                        </td>
                        <td className="num">
                          <b>{b.bit}</b>
                        </td>
                        <td className="num" style={{ color: b.cost > 1.5 ? 'var(--bad)' : b.cost < 0.3 ? 'var(--good)' : undefined }}>
                          {b.cost.toFixed(2)}
                        </td>
                        <td className="num muted">{b.p === null ? '—' : `${(b.p / 2048).toFixed(3)} → ${(b.pAfter! / 2048).toFixed(3)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="small muted">
              Every probability starts at exactly ½ (1024 out of 2048), so the first few packets cost about a bit per decision. Step forward and watch
              the costs fall as the model learns this input.
            </p>
          )}
        </Panel>

        <Transport s={s} label={(i) => `packet ${i} / ${packets.length}`} />
        <Narration tone={s.atEnd && packets.length ? 'done' : undefined}>{narrate(pk, s.index, packets.length, res.bytes.length, data.length)}</Narration>

        <Panel title="Range coder" aside={bitRow ? (hoverBit !== null ? `after “${bitRow.label}”` : 'after the last decision of this packet') : 'initial state'}>
          <RangeView bit={bitRow} />
          <div className="lz-out">
            <div className="small muted">
              output so far — {outSoFar.length} byte{outSoFar.length === 1 ? '' : 's'}
              {bitRow && bitRow.pending > 1 ? ` · ${bitRow.pending} bytes held back (cache 0x${hex2(bitRow.cache)} + ${bitRow.pending - 1} × 0xFF) until a carry is ruled out` : ''}
            </div>
            <Tape
              bytes={outSoFar.length > 96 ? outSoFar.slice(outSoFar.length - 96) : outSoFar}
              render={(i) => hex2((outSoFar.length > 96 ? outSoFar.slice(outSoFar.length - 96) : outSoFar)[i])}
              mark={(i) => {
                const len = Math.min(96, outSoFar.length)
                const newly = pk ? outSoFar.length - Math.max(pk.outBefore, outSoFar.length - len) : 0
                return i >= len - newly ? 'hl-6' : undefined
              }}
            />
          </div>
        </Panel>

        <div className="lz-grid">
          <Panel title="Where the bits went" aside="model prices, whole input">
            <SizeBars
              rows={(['LIT', 'MATCH', 'REP0', 'REP1', 'REP2', 'REP3', 'SHORTREP', 'END'] as PacketKind[])
                .filter((k) => res.countByKind[k] > 0)
                .map((k) => ({
                  label: `${k} ×${res.countByKind[k]}`,
                  value: res.bitsByKind[k],
                  tone: k === 'LIT' ? 'faint' : k === 'MATCH' ? 'ink' : '',
                  note: `${fmt(res.bitsByKind[k] / res.countByKind[k], 1)} bits each`,
                }))}
            />
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Total {fmt(totalBits, 0)} bits by the model’s own prices; the stream is {res.body.length * 8} bits — the difference is the range
              coder’s flush and rounding.
            </p>
          </Panel>
          <Panel title="Against the neighbours" aside="whole files">
            <SizeBars
              unit="bytes"
              rows={[
                { label: 'input', value: data.length, tone: 'faint' },
                { label: 'DEFLATE (raw)', value: deflateBytes, tone: 'ink' },
                ...(zstdBytes !== null ? [{ label: 'Zstandard', value: zstdBytes, tone: 'ink' }] : []),
                { label: 'LZMA (.lzma)', value: res.bytes.length, note: 'incl. 13-byte header' },
              ]}
            />
          </Panel>
        </div>

        <Panel title="The header" aside="13 bytes">
          <Header bytes={res.header} />
        </Panel>
      </Bench>

      <Notes>
        <h2>The packets</h2>
        <p>
          The LZ part of LZMA is ordinary LZ77 with one twist: the coder remembers the <b>last four distances</b> it used (rep0–rep3), and a match
          at one of them is a much cheaper packet than a match at a new distance. Structured data — tables, records, columns — repeats distances
          constantly. Every packet starts with a few flag bits:
        </p>
        <Code>{`0                    LIT       a literal byte follows (8 more decisions)
1 0                  MATCH     length, then distance slot, then distance bits
1 1 0 0              SHORTREP  one byte copied from rep0
1 1 0 1              REP0      length follows; distance = rep0
1 1 1 0              REP1      … rep1 moves to the front
1 1 1 1 0            REP2
1 1 1 1 1            REP3`}</Code>
        <p>
          Each of those bits has its own probability, indexed by the 12-value <b>state</b> (what the last couple of packets were) and, for the
          first flag, by the low <code>pb</code> bits of the position. After a match, the model has learned that another match is unlikely; after
          a run of literals in text, that a literal is likely.
        </p>
        <h2>Bitwise literals, and the matched-literal trick</h2>
        <p>
          A literal is coded one bit at a time, top bit first, walking a 256-leaf binary tree: the probability for bit 5 depends on bits 7 and 6
          already sent, and on the top <code>lc</code> bits of the previous byte. That is a full order-1 model for the high bits, learned on the fly,
          with no table to transmit.
        </p>
        <p>
          Right after a match, the byte at rep0 is a strong hint — the match ended because this byte <i>differs</i> from it, yet it often differs
          only slightly. So while the literal’s bits agree with that byte’s bits, LZMA uses a second set of probabilities indexed by the match
          byte’s bit. The first disagreeing bit switches back to the plain tree.
        </p>
        <h2>Lengths and distances</h2>
        <p>
          Lengths 2–273 go through a small three-level coder (2–9, 10–17, 18–273), with the first two levels split by position state. Distances
          are split into a 6-bit <b>slot</b> — roughly the position of the top bit, plus the bit below it — coded with a tree whose probabilities
          depend on the length (short matches tend to be near). Below slot 14 the remaining bits are modelled too; above it the middle bits are
          sent raw at exactly 1 bit each and only the bottom four are modelled, because alignment patterns in binaries live there.
        </p>
        <h2>The range coder</h2>
        <p>
          The coder keeps an interval of width <code>range</code> starting at <code>low</code>. A decision with probability p of being 0 splits
          the range at <code>bound = (range ≫ 11) · p</code>: a 0 keeps the bottom part, a 1 the top. Whenever the range drops below 2²⁴ the top
          byte of <code>low</code> is settled and shifted out — except that adding to <code>low</code> later could carry into it. So the encoder
          holds the last byte back in a <i>cache</i>, along with any 0xFF bytes after it (a carry would turn them all to 0x00 and bump the
          cache), and releases them once a carry is impossible. Hover a decision above to see the registers right after it.
        </p>
        <h2>What the real encoder does better</h2>
        <p>
          This page parses greedily with one byte of look-ahead, choosing between packets with a few rules and the current prices. Pavlov’s
          encoder runs an <b>optimal parser</b>: for the next few kilobytes it prices every literal, match and rep option with the live
          probability tables and finds the cheapest path through them, dynamic-programming style. That, a binary-tree match finder and a 64 MiB
          dictionary are most of the gap to <code>xz -9</code> on large files — on small ones this page’s output is within a few bytes of xz’s.
        </p>
        <h2>History and where it ships</h2>
        <p>
          Igor Pavlov designed LZMA for the 7z format of 7-Zip (around 1998–2001) and put the SDK in the public domain. Lasse Collin’s xz-utils
          wraps it as <b>LZMA2</b> — the same coder cut into chunks that can reset state or be stored uncompressed, so incompressible data costs
          almost nothing and blocks can be decoded in parallel — plus <b>BCJ filters</b> that rewrite relative jump targets in executables to
          absolute ones, so repeated calls become repeated bytes. xz compresses the Linux kernel images and most distribution packages; in 2024 a
          backdoor was found planted in xz-utils 5.6.0/5.6.1 release tarballs by a co-maintainer who had spent about two years earning commit access, a supply-chain attack caught by a
          Microsoft engineer who noticed SSH logins getting slower. The algorithm itself was never the problem.
        </p>
        <p>
          The trade is speed: every decision is a multiply, a compare and an unpredictable branch, so LZMA decompresses at tens to a couple of
          hundred MB/s where DEFLATE and Zstandard manage several hundred to a few thousand. LZHAM tried to keep the ratio and win the speed back;
          Brotli and Zstandard took the other route, keeping Huffman/ANS-style table coding and getting their gains from context-modelled
          Huffman tables and bigger windows.
        </p>
        <div className="aside">
          Verified, not assumed: <code>npm run verify</code> hands every file this page’s encoder writes to <code>xz --format=lzma -dc</code>,
          and decodes xz’s own output at levels 0, 6 and 9 and with odd lc/lp/pb — xz-utils shares no code with this one.
        </div>
      </Notes>
    </Page>
  )
}

function narrate(pk: Packet | null, index: number, total: number, fileBytes: number, n: number): ReactNode {
  if (!pk) {
    return total === 0 ? (
      <>Nothing to code — the file is just the 13-byte header and the range coder’s 5 flush bytes.</>
    ) : (
      <>
        The header is written, every probability is ½ and the state is 0. Step forward to code the first packet — {total} in all.
      </>
    )
  }
  const cost = pk.bits.reduce((a, b) => a + b.cost, 0)
  const tail = index === total ? ` That was the last packet: ${fileBytes} bytes for ${n}.` : ''
  switch (pk.kind) {
    case 'LIT':
      return (
        <>
          Literal ‘<b>{glyph(pk.byte!)}</b>’ in {pk.bits.length - 1} bit decisions{pk.matchByte !== undefined ? <>, compared bit by bit with ‘{glyph(pk.matchByte)}’ at rep0 because the last packet was a match</> : ''}
          : {fmt(cost, 2)} bits instead of 8.{tail}
        </>
      )
    case 'SHORTREP':
      return (
        <>
          Short rep: copy the one byte at rep0 (distance {pk.dist}) — four flag decisions, {fmt(cost, 2)} bits.{tail}
        </>
      )
    case 'MATCH':
      return (
        <>
          Match of <b>{pk.len}</b> at a new distance <b>{pk.dist}</b>: flags, length and distance slot cost {fmt(cost, 2)} bits, and {pk.dist} becomes rep0
          while the old reps shift down.{tail}
        </>
      )
    case 'END':
      return <>End marker: a length-2 match at distance 2³² that no data can contain. {fmt(cost, 1)} bits — the price of not stating the size up front.{tail}</>
    default:
      return (
        <>
          {pk.kind}: {pk.len} bytes at distance {pk.dist}, named by index instead of value — {fmt(cost, 2)} bits
          {pk.kind !== 'REP0' ? `, and that distance moves to the front as rep0` : ''}.{tail}
        </>
      )
  }
}

// --------------------------------------------------------------------- pieces

function StateDiagram({ before, after }: { before: number; after: number }) {
  const pos = (s: number) => (s < 7 ? { x: 22 + s * 40, y: 26 } : { x: 62 + (s - 7) * 40, y: 82 })
  const a = pos(before)
  const b = pos(after)
  return (
    <svg viewBox="0 0 290 110" className="lz-states" role="img" aria-label={`state ${before} to ${after}`}>
      <text x={4} y={10} fontSize={8.5} fill="var(--muted)">
        after a literal
      </text>
      <text x={4} y={108} fontSize={8.5} fill="var(--muted)">
        after a match / rep / short rep
      </text>
      {before !== after && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--ink)" strokeWidth={1.6} strokeDasharray="4 3" />}
      {Array.from({ length: 12 }, (_, s) => {
        const p = pos(s)
        const on = s === after
        return (
          <g key={s}>
            <title>{`state ${s}: ${STATE_NAMES[s]}`}</title>
            <circle cx={p.x} cy={p.y} r={14} fill={on ? 'var(--accent)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth={on || s === before ? 2 : 1} strokeDasharray={s === before && !on ? '3 2' : undefined} />
            <text x={p.x} y={p.y + 4} fontSize={11} textAnchor="middle" fill={on ? 'var(--accent-ink)' : 'var(--ink)'}>
              {s}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Reps({ before, after, kind }: { before: number[]; after: number[]; kind?: PacketKind }) {
  const used = kind === 'REP0' || kind === 'SHORTREP' ? 0 : kind === 'REP1' ? 1 : kind === 'REP2' ? 2 : kind === 'REP3' ? 3 : -1
  return (
    <div className="lz-reps">
      <div className="lz-reprow">
        <span className="small muted">before</span>
        {before.map((d, i) => (
          <span key={i} className={'lz-rep' + (i === used ? ' used' : '')}>
            <small>rep{i}</small>
            {d}
          </span>
        ))}
      </div>
      <div className="lz-reprow">
        <span className="small muted">after</span>
        {after.map((d, i) => (
          <span key={i} className={'lz-rep' + (i === 0 && (kind === 'MATCH' || used > 0) ? ' new' : '')}>
            <small>rep{i}</small>
            {d}
          </span>
        ))}
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        {kind === 'MATCH'
          ? 'A new distance pushes onto the front; rep3 falls off.'
          : used > 0
            ? `rep${used} was used, so it moves to the front.`
            : used === 0
              ? 'rep0 used again: the list does not change.'
              : 'Literals leave the list alone.'}
      </p>
    </div>
  )
}

function LiteralView({ byte, matchByte, kind }: { byte: number; matchByte?: number; kind: PacketKind }) {
  if (kind === 'SHORTREP') return null
  const bits = bin(byte, 8)
  const mb = matchByte !== undefined ? bin(matchByte, 8) : null
  let agree = 0
  if (mb) while (agree < 8 && bits[agree] === mb[agree]) agree++
  return (
    <div className="lz-lit">
      <div className="lz-litrow">
        <span className="small muted">literal ‘{glyph(byte)}’</span>
        <span className="mono">
          {bits.split('').map((c, i) => (
            <i key={i} className={mb ? (i <= agree ? 'lz-matched' : '') : ''}>
              {c}
            </i>
          ))}
        </span>
      </div>
      {mb && (
        <div className="lz-litrow">
          <span className="small muted">byte at rep0 ‘{glyph(matchByte!)}’</span>
          <span className="mono">
            {mb.split('').map((c, i) => (
              <i key={i} className={i <= agree ? 'lz-matched' : 'muted'}>
                {c}
              </i>
            ))}
          </span>
        </div>
      )}
      {mb && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {agree >= 8
            ? 'All 8 bits coded with the matched-literal probabilities.'
            : `The first ${agree + 1} bit${agree ? 's' : ''} use the matched-literal probabilities; bit ${7 - agree} disagrees, so the rest go through the plain tree.`}
        </p>
      )}
    </div>
  )
}

function ProbBar({ p, bit }: { p: number | null; bit: number }) {
  const p0 = p === null ? 0.5 : p / 2048
  return (
    <span className="lz-prob" title={`P(0) = ${p0.toFixed(3)}`}>
      <span className="lz-prob0" style={{ width: `${p0 * 100}%` }} />
      <span className={'lz-probmark ' + (bit ? 'one' : 'zero')} style={{ left: bit ? `${p0 * 100}%` : 0, width: `${(bit ? 1 - p0 : p0) * 100}%` }} />
    </span>
  )
}

function RangeView({ bit }: { bit: CodedBit | null }) {
  const low = bit ? bit.low : 0
  const range = bit ? bit.range : 0xffffffff
  const carry = low >= 2 ** 32
  const lo32 = low % 2 ** 32
  return (
    <div className="lz-regs">
      <div className="lz-reg">
        <span className="lz-regname">
          low <Help text="Bottom of the current interval, 32 bits plus a possible carry bit. Its top byte is shifted out whenever range gets small." />
        </span>
        <code>
          {carry ? <b className="lz-carry">1</b> : '0'}
          {' '}
          {hex(lo32, 8)}
        </code>
        <span className="mono small lz-binary">{bin(lo32, 32).replace(/(.{8})/g, '$1 ')}</span>
      </div>
      <div className="lz-reg">
        <span className="lz-regname">
          range <Help text="Width of the interval. Coding a decision with probability p multiplies it by about p; once it falls below 2^24 it is shifted left by 8 and a byte of low leaves." />
        </span>
        <code>{hex(range, 8)}</code>
        <span className="mono small lz-binary">{bin(range, 32).replace(/(.{8})/g, '$1 ')}</span>
      </div>
      <div className="lz-rangebar" title="range as a fraction of 2^32">
        <span style={{ width: `${Math.max(0.5, (range / 2 ** 32) * 100)}%` }} />
      </div>
      <p className="small muted" style={{ margin: '4px 0 0' }}>
        log₂ range = {fmt(Math.log2(range), 2)} — it shrinks by the cost of every decision and is topped back up 8 bits at a time.
      </p>
    </div>
  )
}

function Header({ bytes }: { bytes: Uint8Array }) {
  const props = bytes[0]
  const lc = props % 9
  const lp = Math.floor(props / 9) % 5
  const pb = Math.floor(props / 45)
  const dict = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0
  const unknown = bytes.slice(5, 13).every((b) => b === 0xff)
  let size = 0
  for (let i = 12; i >= 5; i--) size = size * 256 + bytes[i]
  return (
    <div className="lz-header">
      <Tape
        bytes={bytes}
        render={(i) => hex2(bytes[i])}
        mark={(i) => (i === 0 ? 'hl-6' : i < 5 ? 'hl-4' : 'hl-3')}
        cellTitle={(i) => (i === 0 ? 'properties' : i < 5 ? 'dictionary size (LE)' : 'uncompressed size (LE)')}
      />
      <div className="legend" style={{ marginTop: 8 }}>
        <span>
          <i className="hl-6" /> props 0x{hex2(props)} = (pb {pb}·5 + lp {lp})·9 + lc {lc}
        </span>
        <span>
          <i className="hl-4" /> dictionary {dict.toLocaleString('en-US')} bytes
        </span>
        <span>
          <i className="hl-3" /> size {unknown ? 'unknown (all ones) — end marker follows' : size.toLocaleString('en-US') + ' bytes'}
        </span>
      </div>
    </div>
  )
}
