import { useMemo, useState } from 'react'
import { glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { decodeTrace, layout, parse, tokenBits, tokenFields, type Format, type Params, type ParseStep, type Token } from './lz77'
import { Strip, type Band } from './Strip'
import './lz77.css'

type Mode = 'encode' | 'decode'

const FIELD_CLASS: Record<string, string> = { flag: 'hl-6', off: 'hl-1', len: 'hl-4', lit: 'hl-2' }

/** Bytes as a short quoted string for prose. */
function q(bytes: ArrayLike<number>, from: number, len: number, max = 24): string {
  let s = ''
  for (let i = 0; i < Math.min(len, max); i++) s += glyph(bytes[from + i])
  return '‘' + s + (len > max ? '…' : '') + '’'
}

export function tokenText(t: Token): string {
  if (t.kind === 'lit') return glyph(t.byte)
  if (t.kind === 'match') return `⟨${t.offset},${t.length}⟩`
  return `⟨${t.offset},${t.length},${glyph(t.next)}⟩`
}

const PRESETS = [
  { label: 'overlap: abcabc…', text: 'abcabcabcabcabcabcx' },
  { label: 'a run: aaaa…', text: 'aaaaaaaaaaaaaaaaaaaab' },
  { label: 'greedy trap', text: 'abcXbcdefYabcdef' },
]

export function Lz77() {
  const src = useSource('tobe', 2000)
  const [mode, setMode] = useState<Mode>('encode')
  const [format, setFormat] = useState<Format>('lzss')
  const [winBits, setWinBits] = useState(8)
  const [maxMatch, setMaxMatch] = useState(18)
  const [minMatch, setMinMatch] = useState(3)

  const p: Params = useMemo(
    () => ({ window: 2 ** winBits, maxMatch: Math.max(maxMatch, format === 'lzss' ? minMatch : 1), minMatch: format === 'lzss' ? minMatch : 1, format }),
    [winBits, maxMatch, minMatch, format],
  )
  const data = src.bytes
  const steps = useMemo(() => parse(data, p), [data, p])
  const tokens = useMemo(() => steps.map((s) => s.token), [steps])
  const dec = useMemo(() => decodeTrace(tokens), [tokens])
  const L = layout(p)

  const count = mode === 'encode' ? steps.length + 1 : dec.steps.length + 1
  const s = useStepper(count, { speed: mode === 'encode' ? 2 : 6, resetKey: src.key + mode + JSON.stringify(p) })

  const totalBits = tokens.reduce((a, t) => a + tokenBits(t, p), 0)
  const matches = tokens.filter((t) => t.kind !== 'lit' && (t.kind !== 'triple' || t.length > 0)).length
  const literals = tokens.length - matches

  return (
    <Page
      slug="lz77"
      lede={
        <p>
          In 1977 Abraham Lempel and Jacob Ziv published a compressor that has no model of the data at all. It keeps the last few thousand
          bytes it has seen — the <b>window</b> — and whenever what comes next already appears there, it sends a pointer instead: go back{' '}
          <i>this far</i>, copy <i>this many</i>. Every format in the ZIP, PNG, LZ4 and Zstandard family starts here.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['tobe', 'abra', 'runs', 'prose', 'json', 'dna', 'random']} maxBytes={2000} />
              <div className="btn-row">
                {PRESETS.map((x) => (
                  <Button key={x.label} kind="ghost" onClick={() => src.setText(x.text)}>
                    {x.label}
                  </Button>
                ))}
              </div>
            </Group>
            <Group title="Step through">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'encode', label: 'Encode' },
                  { value: 'decode', label: 'Decode' },
                ]}
              />
              <p className="small muted">
                {mode === 'encode' ? 'Each step finds the longest match in the window and emits one token.' : 'Each step writes one output byte — a literal, or one byte of a copy.'}
              </p>
            </Group>
            <Group title="Format" help="LZ77 as published sends a triple for everything. LZSS adds a flag bit and sends a literal whenever the match is too short to pay for its pointer.">
              <Segmented
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'lzss', label: 'LZSS', title: 'flag + literal or ⟨offset,length⟩' },
                  { value: 'triple', label: 'LZ77 triples', title: '⟨offset,length,next⟩' },
                ]}
              />
              <Slider
                label="window"
                value={winBits}
                min={3}
                max={12}
                onChange={setWinBits}
                display={`${2 ** winBits} bytes`}
                help="How far back a match may start. Bigger finds more, but every offset costs more bits — log₂(window) of them."
              />
              <Slider label="max match" value={p.maxMatch} min={Math.max(2, format === 'lzss' ? minMatch + 1 : 2)} max={64} onChange={setMaxMatch} help="The lookahead: the longest copy one token can describe." />
              <Slider
                label="min match"
                value={minMatch}
                min={1}
                max={8}
                disabled={format !== 'lzss'}
                onChange={setMinMatch}
                help="LZSS only. A match shorter than this is sent as literals instead, because the pointer would cost more than the bytes it replaces."
              />
              <p className="small mono muted">
                {format === 'lzss' ? (
                  <>
                    literal = 1 + 8 = {L.litBits} bits
                    <br />
                    match = 1 + {L.off} + {L.len} = {L.matchBits} bits
                  </>
                ) : (
                  <>
                    every token = {L.off} + {L.len} + 8 = {L.matchBits} bits
                  </>
                )}
              </p>
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="tokens" value={tokens.length} />
                <Stat label="matches" value={matches} sub={`${literals} literal${literals === 1 ? '' : 's'}`} />
                <Stat label="bits" value={totalBits} tone="accent" sub={`vs ${data.length * 8} raw`} />
                <Stat label="ratio" value={data.length ? (totalBits / (data.length * 8)).toFixed(3) : '—'} tone={totalBits < data.length * 8 ? 'good' : 'bad'} help="Output bits ÷ input bits. Below 1 means it shrank." />
              </Stats>
            </Group>
          </>
        }
      >
        {mode === 'encode' ? <EncodeStage data={data} steps={steps} p={p} index={s.index} onJump={s.setIndex} /> : <DecodeStage tokens={tokens} dec={dec} index={s.index} onJump={(ti) => s.setIndex(dec.steps.findIndex((d) => d.token === ti) + 1)} />}

        <Transport s={s} label={(i) => (mode === 'encode' ? `token ${i} / ${steps.length}` : `byte ${i} / ${dec.steps.length}`)} />

        <Panel title="How big is it">
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: data.length * 8, tone: 'faint' },
              ...(format === 'lzss' ? [{ label: 'all literals', value: data.length * 9, tone: 'faint', note: 'flag + byte, no matches' }] : []),
              { label: format === 'lzss' ? 'LZSS' : 'LZ77 triples', value: totalBits, note: `${tokens.length} tokens` },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Fixed-width fields, as above. Real formats Huffman-code the tokens afterwards — that is <a href="#/deflate">DEFLATE</a> — because small
            offsets and short lengths are far more common than big ones.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The algorithm</h2>
        <Code>{`i ← 0
while i < n:
    (offset, length) ← longest match for data[i…] starting in data[i−W … i−1]
    if length ≥ MIN:  emit ⟨offset, length⟩ ;  i ← i + length     # LZSS
    else:             emit literal data[i]  ;  i ← i + 1

decode ⟨offset, length⟩:
    repeat length times:  out.push(out[out.length − offset])     # byte by byte`}</Code>
        <p>
          The decoder is almost nothing — a loop that copies bytes from its own output — and it is fast for exactly that reason. All the work is
          in the encoder’s search, which is why LZ formats are asymmetric: decompression runs at gigabytes per second, compression at whatever
          effort you are willing to spend looking for matches.
        </p>
        <h2>Overlapping copies</h2>
        <p>
          Nothing says the source has to end before the destination begins. ⟨1, 7⟩ after an <code>a</code> means “copy the byte one back, seven
          times” — and because the decoder copies one byte at a time, each byte it writes becomes the source for the next. That is run-length
          encoding for free, and ⟨3, 9⟩ after <code>abc</code> repeats a three-byte pattern the same way. Step the decoder through the{' '}
          <i>overlap</i> preset and watch the copy read bytes it wrote a moment earlier. (It is also why a decoder must not use{' '}
          <code>memcpy</code> for overlapping matches.)
        </p>
        <h2>LZ77 versus LZSS</h2>
        <p>
          Ziv and Lempel’s original sends ⟨offset, length, next⟩ for every step, so even a brand-new byte costs a whole triple (⟨0, 0, c⟩), and
          every match drags one literal along whether it helps or not. Storer and Szymanski (1982) showed the cleaner design: a single flag bit
          chooses between a literal and a pointer, and a pointer is only used when it is shorter than the literals it replaces. With a 4 KiB
          window and 18-byte lookahead that threshold is 3 bytes; Okumura’s 1989 LZSS.C, which shipped in countless games and archivers, used
          exactly those numbers, and so does this site’s LZSS codec on the <a href="#/bench">bench</a>.
        </p>
        <h2>Why it works without a model</h2>
        <p>
          LZ77 is <b>universal</b>: Ziv and Lempel proved that for any stationary ergodic source, the compression ratio approaches the source’s
          entropy rate as the window grows — without the encoder knowing anything about the source. The window <i>is</i> the model. The catch is
          “as the window grows”: convergence is slow, which is why practical formats bolt an entropy coder on the back.
        </p>
        <h2>Greedy is not optimal</h2>
        <p>
          Taking the longest match at every position is not the same as taking the cheapest parse. Take the bench’s layout — 4 KiB window, a
          9-bit literal, a 17-bit match — and the <i>greedy trap</i> preset: the window holds <code>abcX</code> and <code>bcdefY</code>, then <code>abcdef</code> arrives. Greedy takes{' '}
          <code>abc</code> (17 bits) and then <code>def</code> (another 17). Sending <code>a</code> as a literal (9 bits) and then the 5-byte{' '}
          <code>bcdef</code> (17) is 26 bits instead of 34. DEFLATE encoders use <b>lazy matching</b> — find a match, then check whether one
          starting a byte later is longer before committing — and Zstandard’s and LZMA’s top levels run a full shortest-path search over the
          possible parses, pricing every token with the actual entropy coder.
        </p>
        <h2>Finding matches fast</h2>
        <p>
          This page checks every window position, which is fine for a demonstration and hopeless for a 32 KiB window over a gigabyte. Real
          encoders hash the next three or four bytes and keep <b>hash chains</b>: a table from hash to the most recent position, and for every
          position a link to the previous one with the same hash. Only positions that could match are visited, newest first, and a chain limit
          trades ratio for speed — that limit is most of what zlib’s levels 1–9 change. LZMA uses binary trees, and LZ4 keeps just one candidate
          per hash and is very fast because of it.
        </p>
        <div className="aside">
          The family tree: LZSS (1982) → DEFLATE (1993: LZ77 + Huffman, in ZIP, gzip, PNG) → LZMA/7-Zip (1998: huge windows + range coding) →
          LZ4 and Snappy (2011: no entropy coding, built for speed) → Zstandard and Brotli (2015–16: LZ77 + modern entropy coders). Every one of
          them is still “go back <i>d</i>, copy <i>n</i>”.
        </div>
      </Notes>
    </Page>
  )
}

// ---------------------------------------------------------------- encode

function TokenChips({ tokens, current, onJump, upto }: { tokens: Token[]; current: number; upto: number; onJump: (i: number) => void }) {
  return (
    <div className="lz-tokens">
      {tokens.map((t, i) => {
        const isMatch = t.kind === 'match' || (t.kind === 'triple' && t.length > 0)
        return (
          <button
            type="button"
            key={i}
            className={'lz-tok ' + (isMatch ? 'match' : 'lit') + (i === current ? ' on' : '') + (i >= upto ? ' future' : '')}
            onClick={() => onJump(i)}
            title={`token ${i} at byte ${t.pos}`}
          >
            {tokenText(t)}
          </button>
        )
      })}
    </div>
  )
}

function EncodeStage({ data, steps, p, index, onJump }: { data: Uint8Array; steps: ParseStep[]; p: Params; index: number; onJump: (i: number) => void }) {
  const [hoverSpan, setHoverSpan] = useState<number | null>(null)
  const step = index > 0 ? steps[index - 1] : null
  const pos = step ? step.pos : 0
  const t = step?.token
  const len = t && t.kind !== 'lit' ? t.length : 0
  const off = t && t.kind !== 'lit' ? t.offset : 0
  const ws = Math.max(0, pos - p.window)

  const mark = (i: number): string | undefined => {
    if (!step) return i === 0 ? 'cur' : 'future'
    if (len > 0 && i >= pos && i < pos + len) return 'hl-5 dst'
    if (len > 0 && i >= pos - off && i < pos - off + len) return 'hl-1 src'
    if (t!.kind === 'lit' && i === pos) return 'hl-2 cur'
    if (t!.kind === 'triple' && i === pos + len) return 'hl-2 cur'
    if (i < ws) return 'dim'
    if (i < pos) return 'win'
    if (i >= pos + step.covers) return 'future'
    return undefined
  }
  // The source range may overlap the destination; draw it with both styles where it does.
  const bands: Band[] = step
    ? [
        { start: ws, len: pos - ws, label: `search window (${p.window})`, className: 'window', row: 0 },
        { start: pos, len: Math.min(p.maxMatch, data.length - pos), label: `lookahead (${p.maxMatch})`, className: 'look', row: 1 },
      ]
    : []

  // Bits so far.
  let bits = ''
  const spans: { start: number; length: number; className: string; title: string }[] = []
  const tokenOfSpan: number[] = []
  for (let k = 0; k < index; k++) {
    for (const f of tokenFields(steps[k].token, p)) {
      if (!f.bits) continue
      spans.push({ start: bits.length, length: f.bits.length, className: FIELD_CLASS[f.kind], title: `token ${k}: ${f.label}` })
      tokenOfSpan.push(k)
      bits += f.bits
    }
  }

  const overlap = len > 0 && off < len
  const best = step?.candidates[0]
  return (
    <>
      <Panel title="Input" aside={step ? `position ${pos} · window ${ws}–${Math.max(ws, pos - 1)}` : `${data.length} bytes`}>
        <Strip
          bytes={data}
          mark={mark}
          arc={len > 0 ? { src: pos - off, dst: pos, len, label: `back ${off}, copy ${len}` } : null}
          bands={bands}
          focus={pos}
        />
        <div className="legend" style={{ marginTop: 8 }}>
          <span>
            <i className="hl-1" /> source
          </span>
          <span>
            <i className="hl-5" /> copied
          </span>
          <span>
            <i className="hl-2" /> literal
          </span>
        </div>
      </Panel>

      <Narration tone={index === steps.length && index > 0 ? 'done' : overlap ? 'warn' : undefined}>
        {!step && (data.length ? <>Nothing sent yet. The window is empty, so whatever comes first can only be sent as a literal.</> : <>Type something to compress.</>)}
        {step && t!.kind === 'lit' && (
          <>
            At {pos}: {best ? (
              <>
                the best match is only {best.length} byte{best.length === 1 ? '' : 's'} ({q(data, pos, best.length)}, {best.offset} back) — shorter
                than the minimum of {p.minMatch}, so it would cost more than it saves.
              </>
            ) : (
              <>‘{glyph(data[pos])}’ does not occur in the window.</>
            )}{' '}
            Emit literal ‘<b>{glyph(t!.byte)}</b>’ (9 bits).
          </>
        )}
        {step && t!.kind === 'match' && (
          <>
            At {pos}: {q(data, pos, len)} was seen {off} bytes back. Emit <b>⟨{off}, {len}⟩</b> — {tokenBits(t!, p)} bits for {len} bytes ({len * 8} as
            bytes).
            {overlap && (
              <>
                {' '}
                <b>Overlapping:</b> the source runs into the bytes being written (offset {off} &lt; length {len}), so the copy repeats a {off}-byte
                pattern — step the decoder to watch it.
              </>
            )}
          </>
        )}
        {step && t!.kind === 'triple' && (
          <>
            At {pos}:{' '}
            {len > 0 ? (
              <>
                {q(data, pos, len)} was seen {off} back, and the triple carries the byte after it too: <b>⟨{off}, {len}, {glyph(t!.next)}⟩</b>.
                {overlap && <> The copy overlaps itself (offset {off} &lt; length {len}).</>}
              </>
            ) : (
              <>
                no match, but a triple has no other way to send a byte: <b>⟨0, 0, {glyph(t!.next)}⟩</b> — {tokenBits(t!, p)} bits for one byte.
              </>
            )}
          </>
        )}
        {index === steps.length && index > 0 && (
          <>
            {' '}
            Done: {steps.length} tokens.
          </>
        )}
      </Narration>

      <div className="lz-split">
        <Panel title="Matches considered" aside={step ? `${step.examined} positions scanned` : ''}>
          {!step ? (
            <p className="small muted" style={{ margin: 0 }}>
              Each step scans every position in the window for one that starts with the next byte, and extends each as far as it agrees.
            </p>
          ) : step.candidates.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              No position in the window starts with ‘{glyph(data[pos])}’.
            </p>
          ) : (
            <div className="lz-cands">
              {step.candidates.slice(0, 8).map((c, k) => {
                const chosen = k === 0 && len > 0 && c.offset === off && c.length === len
                const short = p.format === 'lzss' && c.length < p.minMatch
                return (
                  <div key={c.offset} className={'lz-cand' + (chosen ? ' best' : '') + (short ? ' short' : '')}>
                    <span>back {c.offset}</span>
                    <span>len {c.length}</span>
                    <span className="txt">
                      {q(data, pos, c.length, 18)}
                      {chosen ? ' ✓' : short ? ' too short' : k > 0 && c.length === step.candidates[0].length ? ' farther' : ''}
                    </span>
                  </div>
                )
              })}
              {step.candidates.length > 8 && <span className="small muted">…and {step.candidates.length - 8} shorter</span>}
            </div>
          )}
        </Panel>
        <Panel title="Tokens" aside={`${index} of ${steps.length}`}>
          <TokenChips tokens={steps.map((x) => x.token)} current={index - 1} upto={index} onJump={(i) => onJump(i + 1)} />
        </Panel>
      </div>

      <Panel title="Output bits" aside={`${bits.length} bits`}>
        <div className="lz-bits">
          <BitRow bits={bits} spans={spans} active={hoverSpan ?? undefined} onHover={setHoverSpan} />
        </div>
        <div className="legend" style={{ marginTop: 8 }}>
          {p.format === 'lzss' && (
            <span>
              <i className="hl-6" /> flag
            </span>
          )}
          <span>
            <i className="hl-1" /> offset
          </span>
          <span>
            <i className="hl-4" /> length
          </span>
          <span>
            <i className="hl-2" /> {p.format === 'lzss' ? 'literal' : 'next byte'}
          </span>
          {hoverSpan !== null && <span className="muted">{spans[hoverSpan]?.title}</span>}
        </div>
      </Panel>
    </>
  )
}

// ---------------------------------------------------------------- decode

function DecodeStage({ tokens, dec, index, onJump }: { tokens: Token[]; dec: ReturnType<typeof decodeTrace>; index: number; onJump: (ti: number) => void }) {
  const st = index > 0 ? dec.steps[index - 1] : null
  const out = dec.out.slice(0, index)
  const t = st ? tokens[st.token] : null
  const tokStart = st ? st.at - st.k : 0
  const isCopy = st !== null && st.from >= 0
  const selfRef = isCopy && st!.from >= tokStart

  const mark = (i: number): string | undefined => {
    if (!st) return undefined
    if (i === st.at) return (isCopy ? 'hl-5' : 'hl-2') + ' dst'
    if (isCopy && i === st.from) return 'hl-1 src'
    if (i >= tokStart && i < st.at) return 'hl-5'
    return undefined
  }
  return (
    <>
      <Panel title="Tokens" aside={st ? `token ${st.token}: ${tokenText(t!)}` : `${tokens.length} tokens`}>
        <TokenChips tokens={tokens} current={st ? st.token : -1} upto={st ? st.token + 1 : 0} onJump={onJump} />
      </Panel>
      <Panel title="Output" aside={`${out.length} of ${dec.out.length} bytes`}>
        <Strip bytes={out} mark={mark} arc={isCopy ? { src: st!.from, dst: st!.at, len: 1, label: `back ${st!.at - st!.from}` } : null} focus={st ? st.at : 0} />
      </Panel>
      <Narration tone={index === dec.steps.length && index > 0 ? 'done' : selfRef ? 'warn' : undefined}>
        {!st && <>The decoder starts with nothing. It only ever appends: a literal, or a byte copied from its own output.</>}
        {st && !isCopy && t?.kind === 'lit' && (
          <>
            Literal: write ‘<b>{glyph(st.byte)}</b>’ at {st.at}.
          </>
        )}
        {st && !isCopy && t?.kind === 'triple' && (
          <>
            The triple’s trailing byte: write ‘<b>{glyph(st.byte)}</b>’ at {st.at}
            {st.of > 0 ? <> after the {st.of}-byte copy</> : <> (a ⟨0, 0, c⟩ triple — no copy at all)</>}.
          </>
        )}
        {st && isCopy && (
          <>
            Copy {st.k + 1} of {st.of}: read position {st.from} (‘{glyph(st.byte)}’), {st.at - st.from} back, and write it at {st.at}.
            {selfRef && (
              <>
                {' '}
                <b>That byte was written by this same copy</b>, {st.at - st.from === 1 ? 'one step' : `${st.at - st.from} steps`} ago — the source
                is overtaking the destination, which is how one token produces a run.
              </>
            )}
          </>
        )}
        {index === dec.steps.length && index > 0 && <> All {dec.out.length} bytes rebuilt.</>}
      </Narration>
    </>
  )
}

