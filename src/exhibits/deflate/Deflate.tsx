import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { BitSpan } from '../../lib/bits'
import { fmt, glyph, hex2, pct } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { wrap, type Container } from './container'
import { deflate, type BlockChoice, type DeflateResult, type DynamicHeader } from './encoder'
import { inflate, type TraceField } from './inflate'
import type { Token } from './matcher'
import { CL_ORDER, DIST_BASE, DIST_EXTRA, LEN_BASE, LEN_EXTRA, distCode, lengthCode, rangeLabel } from './tables'
import './deflate.css'

type Mode = 'encode' | 'parse'

/** Colour for each kind of field, and what to call it in the legend. */
const KIND_CLASS: Record<string, string> = {
  header: 'hl-6',
  hlit: 'hl-6',
  hdist: 'hl-6',
  hclen: 'hl-6',
  stored: 'hl-6',
  cllen: 'hl-4',
  clcode: 'hl-4',
  clextra: 'k-extra',
  literal: 'hl-1',
  raw: 'hl-1',
  length: 'hl-5',
  lenextra: 'k-extra',
  dist: 'hl-2',
  distextra: 'k-extra',
  eob: 'hl-3',
  pad: 'k-pad',
}

const LEGEND: [string, string][] = [
  ['hl-6', 'block header'],
  ['hl-4', 'code-length tables'],
  ['hl-1', 'literal'],
  ['hl-5', 'length code'],
  ['hl-2', 'distance code'],
  ['k-extra', 'extra bits'],
  ['hl-3', 'end of block'],
  ['k-pad', 'padding'],
]

/** The stream as it is actually read: bit 0 of byte 0 first. */
function wireBits(bytes: Uint8Array, bitLength: number): string {
  let s = ''
  for (let i = 0; i < bitLength; i++) s += (bytes[i >> 3] >> (i & 7)) & 1
  return s
}

const BLOCK_NAME = { stored: 'stored', fixed: 'fixed Huffman', dynamic: 'dynamic Huffman' }

export function Deflate() {
  const src = useSource('prose', 1024)
  const [block, setBlock] = useState<BlockChoice>('auto')
  const [lazy, setLazy] = useState(true)
  const [container, setContainer] = useState<Container>('gzip')
  const [mode, setMode] = useState<Mode>('encode')
  const [hover, setHover] = useState<number | null>(null)

  const data = src.bytes
  const enc = useMemo(() => deflate(data, { block, lazy, record: true }), [data, block, lazy])
  const wrapped = useMemo(() => wrap(container, enc.bytes, data), [container, enc, data])
  const parsed = useMemo(() => (mode === 'parse' ? inflate(enc.bytes, { trace: true }) : null), [mode, enc])
  const bits = useMemo(() => wireBits(enc.bytes, enc.bytes.length * 8), [enc])

  const count = mode === 'encode' ? enc.tokens.length + 1 : (parsed?.trace.length ?? 0) + 1
  const s = useStepper(count, { speed: mode === 'encode' ? 4 : 8, resetKey: src.key + mode + block + String(lazy) })

  const transport = <Transport s={s} label={(i) => (mode === 'encode' ? `token ${i} / ${count - 1}` : `field ${i} / ${count - 1}`)} />

  const lits = enc.tokens.filter((t) => t.kind === 'lit').length
  const matches = enc.tokens.length - lits
  const costs = enc.blocks.reduce(
    (acc, b) => ({ stored: acc.stored + b.cost.stored, fixed: acc.fixed + b.cost.fixed, dynamic: acc.dynamic + b.cost.dynamic }),
    { stored: 0, fixed: 0, dynamic: 0 },
  )

  return (
    <Page
      slug="deflate"
      lede={
        <p>
          Phil Katz’s format for PKZIP 2, written down by Peter Deutsch as RFC 1951 in 1996, and still the most deployed compressor on Earth. It is
          two ideas glued together: <a href="#/lz77">LZ77</a> turns the input into literals and <i>(length, distance)</i> copies, then{' '}
          <a href="#/huffman">Huffman</a> codes those tokens — with code tables that are themselves Huffman-coded. Everything below is a real
          stream: your browser’s own decompressor reads it back.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['prose', 'tobe', 'abra', 'json', 'runs', 'dna', 'random']} maxBytes={1024} />
            </Group>
            <Group title="Encoder">
              <Segmented
                label="Block type"
                help="Stored: raw bytes, no compression. Fixed: Huffman codes defined by the RFC, nothing to send. Dynamic: codes built for this data, sent in a header. Auto picks whichever is smallest per block, like zlib."
                value={block}
                onChange={setBlock}
                options={[
                  { value: 'auto', label: 'auto' },
                  { value: 'stored', label: 'stored' },
                  { value: 'fixed', label: 'fixed' },
                  { value: 'dynamic', label: 'dynamic' },
                ]}
              />
              <Toggle
                label="Lazy matching"
                value={lazy}
                onChange={setLazy}
                help="Before taking a match at position i, look at i+1. If a longer match starts there, send byte i as a literal and take the longer one. zlib does this from level 4 up."
              />
              <Segmented
                label="Container"
                help="Raw DEFLATE is what ZIP stores. zlib (RFC 1950) adds a 2-byte header and an Adler-32 — that is PNG. gzip (RFC 1952) adds a 10-byte header, a CRC-32 and the length — that is .gz and HTTP."
                value={container}
                onChange={setContainer}
                options={[
                  { value: 'raw', label: 'raw' },
                  { value: 'zlib', label: 'zlib' },
                  { value: 'gzip', label: 'gzip' },
                ]}
              />
            </Group>
            <Group title="Step through">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'encode', label: 'Encode tokens' },
                  { value: 'parse', label: 'Parse the bits' },
                ]}
              />
              <p className="small muted">
                {mode === 'encode'
                  ? 'Each step is one LZ77 token: a literal byte, or a copy of earlier text — and the bits it becomes.'
                  : 'Each step reads one field of the stream, exactly as an inflater does, and shows what it produced.'}
              </p>
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="input" value={data.length} sub="bytes" />
                <Stat label={container === 'raw' ? 'output' : container} value={wrapped.bytes.length} sub="bytes" tone="accent" />
                <Stat label="ratio" value={data.length ? pct(wrapped.bytes.length / data.length, 0) : '—'} help="Output size as a share of the input, envelope included. Under 100% means it got smaller." />
                <Stat label="bits / byte" value={data.length ? fmt(enc.bitLength / data.length, 2) : '—'} help="Raw DEFLATE bits per input byte, without the envelope." />
                <Stat label="literals" value={lits} />
                <Stat label="matches" value={matches} />
              </Stats>
              <div className="dfl-blocks">
                {enc.blocks.map((b, i) => (
                  <div key={i}>
                    <span>
                      block {i + 1}: {BLOCK_NAME[b.type]}
                    </span>
                    <span className="muted">{b.bitEnd - b.bitStart} bits</span>
                  </div>
                ))}
              </div>
            </Group>
          </>
        }
      >
        {mode === 'encode' ? (
          <EncodeStage enc={enc} data={data} bits={bits} index={s.index} hover={hover} setHover={setHover} transport={transport} />
        ) : (
          parsed && <ParseStage enc={enc} data={data} bits={bits} trace={parsed.trace} index={s.index} hover={hover} setHover={setHover} transport={transport} />
        )}

        <Panel title={`Output — ${wrapped.bytes.length} bytes`} aside={container === 'raw' ? 'raw DEFLATE' : `${container} envelope around ${enc.bytes.length} bytes of DEFLATE`}>
          <HexDump wrapped={wrapped} />
        </Panel>

        <div className="grid-2">
          <Panel title="Which block type">
            <SizeBars
              rows={[
                { label: 'input', value: data.length * 8, tone: 'faint' },
                { label: 'stored', value: costs.stored, tone: 'faint', note: 'header + LEN/NLEN + raw bytes' },
                { label: 'fixed Huffman', value: costs.fixed, note: 'no tables, fixed codes' },
                { label: 'dynamic Huffman', value: costs.dynamic, tone: 'ink', note: 'tables + tailored codes' },
              ]}
            />
            <p className="small muted" style={{ margin: '10px 0 0' }}>
              The dynamic header has a fixed cost of roughly 60–100 bits before the first symbol, so short inputs often come out smaller with the
              fixed code. {block === 'auto' ? 'Auto took the smallest for each block.' : `You forced ${block}.`}
            </p>
          </Panel>
          <BrowserCheck data={data} wrapped={wrapped.bytes} container={container} />
        </div>
      </Bench>

      <DeflateNotes />
    </Page>
  )
}

// ------------------------------------------------------------ encode stage

function EncodeStage({
  enc,
  data,
  bits,
  index,
  hover,
  setHover,
  transport,
}: {
  enc: DeflateResult
  data: Uint8Array
  bits: string
  index: number
  hover: number | null
  setHover: (h: number | null) => void
  transport: ReactNode
}) {
  const { tokens, tokenSpans, spans, blocks } = enc
  const t: Token | undefined = index > 0 ? tokens[index - 1] : undefined
  const blk = blocks.find((b) => (t ? index - 1 >= b.tokenStart && index - 1 < b.tokenEnd : true)) ?? blocks[0]
  const isStored = blk.type === 'stored'

  // Position → token index, for colouring the input.
  const tokenAt = useMemo(() => {
    const a = new Int32Array(data.length)
    tokens.forEach((tk, k) => {
      const len = tk.kind === 'lit' ? 1 : tk.length
      for (let p = tk.pos; p < tk.pos + len; p++) a[p] = k
    })
    return a
  }, [tokens, data])

  const curEnd = t ? t.pos + (t.kind === 'lit' ? 1 : t.length) : 0
  const mark = (i: number): string | undefined => {
    if (t) {
      if (t.kind === 'match') {
        const inDst = i >= t.pos && i < curEnd
        const inSrc = i >= t.pos - t.dist && i < t.pos - t.dist + t.length
        if (inDst) return 'dst hl-5'
        if (inSrc) return 'src hl-5'
      } else if (i === t.pos) return 'cur hl-1'
    }
    if (i >= curEnd) return 'dim'
    return tokens[tokenAt[i]].kind === 'match' ? 'k-pastmatch' : undefined
  }

  // Bits visible so far: through the current token's last span (or the first block's header).
  const [s0, s1] = t ? tokenSpans[index - 1] : [0, 0]
  let shownSpanEnd: number
  if (t && !isStored && s1 > s0) shownSpanEnd = s1
  else if (t && isStored) shownSpanEnd = spans.findIndex((sp) => sp.start >= blk.bitEnd)
  else shownSpanEnd = spans.findIndex((sp) => sp.kind === 'literal' || sp.kind === 'length' || sp.kind === 'raw' || sp.kind === 'eob')
  if (index === tokens.length) shownSpanEnd = spans.length
  if (shownSpanEnd < 0) shownSpanEnd = spans.length
  const visible = spans.slice(0, shownSpanEnd)
  const cut = visible.length ? visible[visible.length - 1].start + visible[visible.length - 1].length : 0
  const rowSpans = visible.map((sp, k) => ({ start: sp.start, length: sp.length, className: KIND_CLASS[sp.kind] ?? '', title: sp.label, k }))
  const activeSet = t && !isStored ? [s0, s1] : null

  return (
    <>
      <Panel title="LZ77 pass" aside={t ? `token ${index}: ${t.kind === 'lit' ? 'literal' : `copy ${t.length} from ${t.dist} back`}` : `${tokens.length} tokens`}>
        <Tape bytes={data} mark={mark} />
      </Panel>

      <Narration tone={index === tokens.length && index > 0 ? 'done' : undefined}>
        <TokenStory t={t} enc={enc} index={index} isStored={isStored} blockType={blk.type} />
      </Narration>
      {transport}

      <Panel title="This token, in bits" aside={blk ? `${BLOCK_NAME[blk.type]} block` : ''}>
        {t && !isStored && s1 > s0 ? (
          <div className="dfl-token-fields">
            {spans.slice(s0, s1).map((sp, k) => (
              <div className="dfl-field" key={k}>
                <span className={'bitspan ' + (KIND_CLASS[sp.kind] ?? '')}>{bits.slice(sp.start, sp.start + sp.length)}</span>
                <span>{sp.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ marginTop: 0 }}>
            {isStored ? 'Stored blocks ignore the tokens: the bytes go out as they are.' : 'Step forward to encode the first token.'}
          </p>
        )}
        <div className="dfl-sub">
          Length codes 257–285 <Help text="A length of 3…258 is sent as one of 29 codes, then 0–5 extra bits picking the exact value inside the code’s range." />
        </div>
        <CodeGrid kind="len" active={t?.kind === 'match' ? lengthCode(t.length).code : undefined} used={useUsed(tokens, 'len')} />
        <div className="dfl-sub">
          Distance codes 0–29 <Help text="A distance of 1…32768 is sent as one of 30 codes, then 0–13 extra bits. Ranges double every two codes: nearby copies are common and cheap, far ones rarer and costlier." />
        </div>
        <CodeGrid kind="dist" active={t?.kind === 'match' ? distCode(t.dist).code : undefined} used={useUsed(tokens, 'dist')} />
      </Panel>

      {blk.header && <HeaderPanel h={blk.header} />}

      <Panel title="The bitstream" aside={`${Math.min(cut, enc.bitLength)} of ${enc.bitLength} bits${enc.bytes.length * 8 > enc.bitLength ? ` + ${enc.bytes.length * 8 - enc.bitLength} padding` : ''}`}>
        <Legend />
        <div className="dfl-bits-scroll">
          <BitRow
            bits={bits.slice(0, cut)}
            spans={rowSpans}
            active={activeSet && hover === null ? s1 - 1 : hover ?? undefined}
            onHover={setHover}
          />
        </div>
        <HoverLine span={hover !== null ? spans[hover] : t && !isStored && s1 > s0 ? spans[s1 - 1] : undefined} bits={bits} />
      </Panel>
    </>
  )
}

function useUsed(tokens: Token[], kind: 'len' | 'dist'): Set<number> {
  return useMemo(() => {
    const s = new Set<number>()
    for (const t of tokens) if (t.kind === 'match') s.add(kind === 'len' ? lengthCode(t.length).code : distCode(t.dist).code)
    return s
  }, [tokens, kind])
}

function TokenStory({ t, enc, index, isStored, blockType }: { t: Token | undefined; enc: DeflateResult; index: number; isStored: boolean; blockType: string }) {
  if (!t) {
    if (enc.tokens.length === 0) return <>Empty input: the whole stream is one final block holding nothing but an end-of-block code.</>
    return (
      <>
        The encoder will walk the input left to right. At each position it hashes the next three bytes and looks back up to 32 KiB for the
        longest earlier copy. The first block is <b>{blockType}</b>
        {blockType === 'dynamic' ? ': its code tables are sent first (the coloured bits already in the stream below).' : '.'}
      </>
    )
  }
  const n = enc.tokens.length
  const tail = index === n ? <> That was the last token — an end-of-block code closes the block. {n} tokens, {enc.bitLength} bits.</> : null
  const [s0, s1] = enc.tokenSpans[index - 1]
  let tbits = 0
  for (let k = s0; k < s1; k++) tbits += enc.spans[k].length
  if (t.kind === 'lit') {
    return (
      <>
        No copy of ‘<b>{glyph(t.byte)}</b>’ (with at least 2 more matching bytes) within reach: emit it as a <b>literal</b>
        {isStored ? '' : <> — {tbits} bits instead of 8</>}.{tail}
      </>
    )
  }
  const lc = lengthCode(t.length)
  const dc = distCode(t.dist)
  const overlap = t.dist < t.length
  return (
    <>
      {t.lazy && <>Lazy step: the previous byte went out as a literal because a longer match starts here. </>}
      These <b>{t.length}</b> bytes already appeared <b>{t.dist}</b> back: emit length {t.length} (code {lc.code}
      {lc.extraBits ? ` + ${lc.extraBits} extra bit${lc.extraBits > 1 ? 's' : ''}` : ''}) and distance {t.dist} (code {dc.code}
      {dc.extraBits ? ` + ${dc.extraBits} extra bit${dc.extraBits > 1 ? 's' : ''}` : ''})
      {isStored ? '' : <> — {tbits} bits for {t.length} bytes</>}.
      {overlap && <> The copy overlaps itself (distance &lt; length): the decoder copies byte by byte, so it repeats the pattern.</>}
      {tail}
    </>
  )
}

function CodeGrid({ kind, active, used }: { kind: 'len' | 'dist'; active?: number; used: Set<number> }) {
  const base = kind === 'len' ? LEN_BASE : DIST_BASE
  const extra = kind === 'len' ? LEN_EXTRA : DIST_EXTRA
  return (
    <div className="dfl-grid">
      {base.map((b, i) => {
        const code = kind === 'len' ? 257 + i : i
        return (
          <div key={i} className={'dfl-chip' + (code === active ? ' on' : used.has(code) ? ' used' : ' unused')} title={`${extra[i]} extra bits`}>
            <b>{code}</b>
            <small>
              {rangeLabel(b, extra[i])}
              {extra[i] ? ` +${extra[i]}b` : ''}
            </small>
          </div>
        )
      })}
    </div>
  )
}

function Legend() {
  return (
    <div className="legend dfl-legend" style={{ marginBottom: 10 }}>
      {LEGEND.map(([c, n]) => (
        <span key={c}>
          <i className={c} />
          {n}
        </span>
      ))}
    </div>
  )
}

function HoverLine({ span, bits }: { span?: { start: number; length: number; label: string; kind: string; bits?: string }; bits: string }) {
  if (!span) return <div className="dfl-hover muted">Hover any coloured run of bits to see what it means.</div>
  const wire = bits.slice(span.start, span.start + span.length)
  const isCode = ['literal', 'length', 'dist', 'eob', 'clcode'].includes(span.kind)
  return (
    <div className="dfl-hover">
      <b>{span.label}</b>
      <br />
      bits {span.start}–{span.start + span.length - 1} on the wire: <code>{wire}</code>
      {span.length > 1 &&
        (isCode ? (
          <span className="muted"> — a Huffman code, sent most-significant bit first, so it reads in order.</span>
        ) : (
          <span className="muted">
            {' '}
            — a number, sent least-significant bit first: read it backwards, <code>{wire.split('').reverse().join('')}</code> = {parseInt(wire.split('').reverse().join(''), 2)}.
          </span>
        ))}
    </div>
  )
}

// ------------------------------------------------------------ header panel

function Bars({ lens, color }: { lens: number[]; color: (i: number) => string }) {
  const n = lens.length
  const w = 4
  return (
    <svg viewBox={`0 0 ${n * w} 64`} preserveAspectRatio="none" aria-hidden>
      {lens.map((l, i) =>
        l ? <rect key={i} x={i * w + 0.5} y={64 - l * 4} width={w - 1} height={l * 4} fill={color(i)} stroke="var(--ink)" strokeWidth={0.3} /> : null,
      )}
      <line x1={0} x2={n * w} y1={63.5} y2={63.5} stroke="var(--line-strong)" strokeWidth={1} />
    </svg>
  )
}

function HeaderPanel({ h, activeCl }: { h: DynamicHeader; activeCl?: number }) {
  const nlit = h.hlit + 257
  const ndist = h.hdist + 1
  const lit = h.litLens.slice(0, nlit)
  const dist = h.distLens.slice(0, ndist)
  return (
    <Panel title="The dynamic block header" aside={`${h.headerBits + 3} bits before the first symbol`}>
      <div className="dfl-sub">
        Literal/length code lengths — {nlit} symbols <Help text="Bar height is the code length in bits (taller = longer = rarer). Literals 0–255 in yellow, end-of-block in green, length codes in orange. Missing bars are unused symbols (length 0)." />
      </div>
      <div className="dfl-bars">
        <Bars lens={lit} color={(i) => (i < 256 ? 'var(--hl-1)' : i === 256 ? 'var(--hl-3)' : 'var(--hl-5)')} />
        <div className="dfl-axis">
          <span>0</span>
          <span>‘A’=65</span>
          <span>‘a’=97</span>
          <span>255 | 256 EOB | {nlit - 1}</span>
        </div>
      </div>
      <div className="dfl-sub">Distance code lengths — {ndist} symbols</div>
      <div className="dfl-bars" style={{ maxWidth: Math.max(120, ndist * 22) }}>
        <Bars lens={dist} color={() => 'var(--hl-2)'} />
      </div>
      <div className="dfl-sub">
        Those {h.lengthSeq.length} lengths, run-length coded → {h.clSeq.length} symbols{' '}
        <Help text="The list of code lengths is itself compressed. 0–15 are literal lengths; 16 repeats the previous length 3–6 times; 17 is 3–10 zeros; 18 is 11–138 zeros. Most of the 256 literal slots are unused in text, so 17 and 18 do a lot of work." />
      </div>
      <div className="dfl-cl">
        {h.clSeq.map((c, i) => (
          <span key={i} className={(c.sym === 16 ? 'rep' : c.sym >= 17 ? 'zero' : '') + (i === activeCl ? ' on' : '')} title={`symbol ${c.sym}`}>
            {c.sym < 16 ? c.sym : c.sym === 16 ? `↻${c.covers}` : `0×${c.covers}`}
          </span>
        ))}
      </div>
      <div className="dfl-sub">
        …and those symbols get their own Huffman code (lengths 0–7), sent first, 3 bits each, in this order{' '}
        <Help text="The order 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 puts the symbols least likely to be used at the end, so trailing zeros can be cut off. HCLEN says how many are sent." />
      </div>
      <div className="dfl-order">
        {CL_ORDER.map((sym, i) => (
          <div key={sym} className={i >= h.hclen + 4 ? 'cut' : ''} title={i >= h.hclen + 4 ? 'not sent (trailing zero)' : `${h.clLens[sym]}-bit code`}>
            {sym}
            <small>{h.clLens[sym] || '·'}</small>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        Three layers of Huffman: a code for the code lengths of the code for the data. The decoder rebuilds every code from lengths alone using
        the canonical rule, so no tree shape is ever sent.
      </p>
    </Panel>
  )
}

// ------------------------------------------------------------- parse stage

const KIND_EXPLAIN: Record<string, string> = {
  header: '',
  hlit: 'Lengths for codes 257+ are only sent up to the highest length code used.',
  hdist: '',
  hclen: '',
  cllen: 'These 3-bit numbers define the small Huffman code used to read the code lengths that follow.',
  clcode: 'Decoded with the code-length code just defined.',
  clextra: '',
  literal: 'Decoded with the literal/length code: append this byte to the output.',
  raw: 'Stored block: copied straight through.',
  length: 'A value ≥ 257 is not a byte: it starts a copy. The distance comes next.',
  lenextra: '',
  dist: 'Decoded with the distance code: now copy from that far back.',
  distextra: '',
  eob: 'Symbol 256 ends the block.',
  pad: 'Skipped: stored blocks start on a byte boundary.',
  stored: '',
}

function ParseStage({
  enc,
  data,
  bits,
  trace,
  index,
  hover,
  setHover,
  transport,
}: {
  enc: DeflateResult
  data: Uint8Array
  bits: string
  trace: TraceField[]
  index: number
  hover: number | null
  setHover: (h: number | null) => void
  transport: ReactNode
}) {
  const f = index > 0 ? trace[index - 1] : undefined
  const outLen = f ? f.out : 0
  const prevOut = index > 1 ? trace[index - 2].out : 0
  const rowSpans = trace.map((sp, k) => ({
    start: sp.start,
    length: sp.length,
    className: (KIND_CLASS[sp.kind] ?? '') + (k >= index ? ' k-future' : ''),
    title: sp.label,
  }))
  const blk = f ? enc.blocks[f.block] : enc.blocks[0]
  // Which code-length symbol is being read, for the header panel.
  let activeCl: number | undefined
  if (f && f.kind === 'clcode') {
    activeCl = 0
    for (let k = 0; k < index - 1; k++) if (trace[k].kind === 'clcode' && trace[k].block === f.block) activeCl++
  }
  const showHeader = blk?.header && f && ['hlit', 'hdist', 'hclen', 'cllen', 'clcode', 'clextra'].includes(f.kind)
  const copied = f && (f.kind === 'dist' || f.kind === 'distextra') ? outLen - prevOut : 0
  return (
    <>
      <Panel title="The bitstream, as the inflater reads it" aside={f ? `bit ${Math.min(f.start + f.length, enc.bitLength)} of ${enc.bitLength}` : `${enc.bitLength} bits`}>
        <Legend />
        <div className="dfl-bits-scroll">
          <BitRow bits={bits} spans={rowSpans} active={hover ?? (index > 0 ? index - 1 : undefined)} onHover={setHover} />
        </div>
        <HoverLine span={hover !== null ? (trace[hover] as unknown as BitSpan) : (f as unknown as BitSpan | undefined)} bits={bits} />
      </Panel>
      <Narration tone={index === trace.length && index > 0 ? 'done' : undefined}>
        {!f ? (
          <>The inflater starts at bit 0 of byte 0. It knows nothing yet — not even whether the block is compressed.</>
        ) : (
          <>
            <b>{f.label}</b>. {KIND_EXPLAIN[f.kind]}
            {copied > 0 && <> Copied {copied} bytes.</>}
            {index === trace.length && <> The final block is done: {outLen} bytes recovered.</>}
          </>
        )}
      </Narration>
      {transport}
      {showHeader && blk.header && <HeaderPanel h={blk.header} activeCl={activeCl} />}
      <Panel title="Output so far" aside={`${outLen} of ${data.length} bytes`}>
        <Tape bytes={data.subarray(0, outLen)} mark={(i) => (i >= prevOut && i < outLen ? (copied > 0 ? 'hl-5' : 'hl-1') : undefined)} />
      </Panel>
    </>
  )
}

// ------------------------------------------------------------ hex + check

function HexDump({ wrapped }: { wrapped: ReturnType<typeof wrap> }) {
  const [hover, setHover] = useState<number | null>(null)
  const fieldOf = (i: number) => wrapped.fields.find((f) => i >= f.start && i < f.start + f.length)
  const hf = hover !== null ? fieldOf(hover) : undefined
  return (
    <>
      <Tape
        bytes={wrapped.bytes}
        render={(i) => hex2(wrapped.bytes[i])}
        mark={(i) => {
          const f = fieldOf(i)
          return f?.kind === 'head' ? 'hl-6' : f?.kind === 'tail' ? 'hl-2' : undefined
        }}
        onHover={setHover}
        cellTitle={(i) => `byte ${i}: ${fieldOf(i)?.label ?? ''}`}
      />
      <div className="dfl-hover">{hf ? <b>{hf.label}</b> : <span className="muted">Hover a byte. Purple: envelope header, pink: checksum trailer, plain: the DEFLATE stream.</span>}</div>
    </>
  )
}

const FORMAT: Record<Container, CompressionFormat> = { raw: 'deflate-raw', zlib: 'deflate', gzip: 'gzip' }

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function BrowserCheck({ data, wrapped, container }: { data: Uint8Array; wrapped: Uint8Array; container: Container }) {
  const [res, setRes] = useState<{ ok: boolean | null; err?: string; theirs: number | null }>({ ok: null, theirs: null })
  useEffect(() => {
    let live = true
    ;(async () => {
      if (typeof DecompressionStream === 'undefined') {
        if (live) setRes({ ok: null, err: 'This browser has no DecompressionStream.', theirs: null })
        return
      }
      let ok: boolean | null = null
      let err: string | undefined
      try {
        const back = await pipe(wrapped, new DecompressionStream(FORMAT[container]))
        ok = back.length === data.length && back.every((b, i) => b === data[i])
      } catch (e) {
        ok = false
        err = e instanceof Error ? e.message : String(e)
      }
      let theirs: number | null = null
      try {
        theirs = (await pipe(data, new CompressionStream(FORMAT[container]))).length
      } catch {
        theirs = null
      }
      if (live) setRes({ ok, err, theirs })
    })()
    return () => {
      live = false
    }
  }, [data, wrapped, container])

  const download = () => {
    const ext = container === 'gzip' ? 'gz' : container === 'zlib' ? 'zz' : 'deflate'
    const url = URL.createObjectURL(new Blob([wrapped as BlobPart], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `input.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Panel title="Check it with your browser">
      <div className="dfl-check">
        <div>
          <span className="mono small muted">DecompressionStream('{FORMAT[container]}')</span>
          <br />
          {res.ok === null && !res.err && <span className="muted">checking…</span>}
          {res.ok === true && <span className="ok">✓ your browser decoded it back to the same {data.length} bytes</span>}
          {res.ok === false && <span className="bad">✗ {res.err ?? 'decoded to different bytes'}</span>}
          {res.ok === null && res.err && <span className="muted">{res.err}</span>}
        </div>
        {res.theirs !== null && (
          <div>
            <span className="mono small muted">CompressionStream('{FORMAT[container]}')</span>
            <br />
            your browser’s own encoder: <b className="mono">{res.theirs}</b> bytes vs ours <b className="mono">{wrapped.length}</b>
            {res.theirs !== wrapped.length && <span className="muted"> ({wrapped.length < res.theirs ? 'ours is smaller' : `+${wrapped.length - res.theirs}`})</span>}
          </div>
        )}
        <div className="btn-row">
          <Button onClick={download}>Download {container === 'gzip' ? '.gz' : container === 'zlib' ? '.zz' : '.deflate'}</Button>
        </div>
        {container === 'gzip' && (
          <p className="small muted" style={{ margin: 0 }}>
            The download is a real gzip file: <code>gunzip -c input.gz</code> prints your text.
          </p>
        )}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------------ notes

function DeflateNotes() {
  return (
    <Notes>
      <h2>A stream of blocks</h2>
      <p>
        A DEFLATE stream is a sequence of blocks; each starts with 3 bits — <code>BFINAL</code> (is this the last one?) and <code>BTYPE</code>{' '}
        (00 stored, 01 fixed Huffman, 10 dynamic Huffman). An encoder may switch type from block to block, and zlib ends a block roughly every
        16 K symbols so the codes can track data whose statistics drift.
      </p>
      <Code>{`stored:   BFINAL BTYPE=00 · pad to byte · LEN(16) NLEN(16) · LEN raw bytes
fixed:    BFINAL BTYPE=01 · symbols… · 256
dynamic:  BFINAL BTYPE=10 · HLIT(5) HDIST(5) HCLEN(4)
          · (HCLEN+4) × 3-bit lengths of the code-length code
              (order 16 17 18 0 8 7 9 6 10 5 11 4 12 3 13 2 14 1 15)
          · HLIT+257 lit/len lengths, HDIST+1 distance lengths,
              coded with that code (16/17/18 = runs)
          · symbols… · 256

symbol 0–255    literal byte
symbol 256      end of block
symbol 257–285  length 3–258 (+0–5 extra bits),
                then distance code 0–29 (+0–13 extra bits)`}</Code>
      <h2>One alphabet for literals and lengths</h2>
      <p>
        The neat trick is that literals and match lengths share a single Huffman alphabet of 286 symbols. The decoder reads one symbol and the
        value itself says what comes next: below 256 it is a byte, 256 ends the block, above 256 it is a length and a distance follows. No flag
        bit is ever spent saying “a match is coming” — unlike LZSS, which pays one bit per token for that.
      </p>
      <h2>Buckets and extra bits</h2>
      <p>
        There are 256 possible lengths and 32 768 distances — far too many to give each a code. So both are bucketed. Buckets are narrow where
        values are common (lengths 3–10 have a code each; distances 1–4 too) and double in width as values grow, with the position inside a
        bucket sent as raw extra bits. The Huffman code only has to learn the coarse shape of the distribution; the fine detail, which is close
        to uniform anyway, goes out uncoded.
      </p>
      <h2>Why the header sends lengths, not trees</h2>
      <p>
        Because the codes are <a href="#/huffman">canonical</a>: given only the length of every symbol’s code, there is exactly one way to assign
        the codes. So a dynamic header is a list of up to 316 small numbers. That list is mostly zeros and repeats, so it is run-length coded
        (16 = repeat previous 3–6×, 17 = 3–10 zeros, 18 = 11–138 zeros) — and the 19 resulting symbols get their own little Huffman code, whose
        lengths go first as 3-bit numbers. The odd order of those 19 puts the rarely used lengths last so the tail can be dropped.
      </p>
      <h2>The bit-order gotcha</h2>
      <p>
        Bits are packed into each byte starting from the least-significant bit. Ordinary numbers — <code>HLIT</code>, extra bits,{' '}
        <code>LEN</code> — are written least-significant bit first, so on the wire they read backwards. Huffman codes are written
        most-significant bit first, because the decoder consumes them one bit at a time from the root. Hover the bitstream above: the panel
        tells you which kind each field is and reverses the numbers for you. Almost every from-scratch inflater has this bug once.
      </p>
      <h2>Finding matches: hash chains and laziness</h2>
      <p>
        zlib keeps, for every 3-byte prefix hash, a linked list of earlier positions with that hash, newest first. To find a match it walks the
        list, comparing, until it has looked at <code>max_chain</code> candidates or found one at least <code>nice_length</code> long. The
        compression levels are just different settings of those knobs (level 1: chain 4, no lazy; level 6: chain 128, lazy below 16; level 9:
        chain 4096, lazy up to 258). This page uses level 6’s.
      </p>
      <p>
        Lazy matching fixes greedy parsing’s classic mistake: grabbing a 3-byte match that hides a 10-byte one starting one byte later. Before
        committing, look at the next position; if it does better, emit a literal and take that one instead. Toggle it and watch the token count
        and the size change.
      </p>
      <h2>History</h2>
      <p>
        In the late 1980s the popular archivers used LZW, and Unisys held the LZW patent. Phil Katz designed DEFLATE for PKZIP 2.0 (1993)
        around LZ77, which was believed unencumbered; Jean-loup Gailly and Mark Adler’s gzip and zlib made it free and portable, and Peter
        Deutsch documented it as RFC 1951 (1996), with zlib (RFC 1950) and gzip (RFC 1952) as envelopes. PNG was created in 1995 largely to
        escape GIF’s LZW, and chose zlib.
      </p>
      <div className="aside">
        Where it ships: every .zip, .gz, .png, .docx/.xlsx (ZIP inside), .jar and .apk; HTTP <code>Content-Encoding: gzip</code> and{' '}
        <code>deflate</code>; PDF’s <code>FlateDecode</code>; git objects. Brotli and Zstandard beat it on both speed and ratio, but it is in
        everything, so it is not going anywhere.
      </div>
    </Notes>
  )
}
