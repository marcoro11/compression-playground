import { useEffect, useMemo, useRef, useState } from 'react'
import { glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Slider, Stat, Stats } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { CLEAR, decodeTrace, encodeTrace, firstFree, type Emitted, type Entry, type LzwParams, type Policy } from './lzw'
import '../lz77/lz77.css'

type Mode = 'encode' | 'decode'

const PRESETS = [
  { label: 'KwKwK: ababab…', text: 'abababababababab' },
  { label: 'a run: aaaa…', text: 'aaaaaaaaaaaaaaaaaaaa' },
]

const str = (bytes: ArrayLike<number>, max = 32) => {
  let s = ''
  for (let i = 0; i < Math.min(bytes.length, max); i++) s += glyph(bytes[i])
  return s + (bytes.length > max ? '…' : '')
}
const q = (bytes: ArrayLike<number>) => '‘' + str(bytes) + '’'

export function Lzw() {
  const src = useSource('tobe', 3000)
  const [mode, setMode] = useState<Mode>('encode')
  const [maxWidth, setMaxWidth] = useState(12)
  const [policy, setPolicy] = useState<Policy>('freeze')
  const p: LzwParams = useMemo(() => ({ maxWidth, policy }), [maxWidth, policy])

  const data = src.bytes
  const enc = useMemo(() => encodeTrace(data, p), [data, p])
  const dec = useMemo(() => decodeTrace(enc.codes, p), [enc, p])

  const count = mode === 'encode' ? enc.steps.length + 1 : dec.steps.length + 1
  const s = useStepper(count, { speed: 3, resetKey: src.key + mode + maxWidth + policy })

  const bits = enc.codes.reduce((a, c) => a + c.width, 0)
  const clears = enc.codes.filter((c) => c.code === CLEAR && policy === 'reset').length
  const kwk = dec.steps.filter((x) => x.kind === 'kwkwk').length

  return (
    <Page
      slug="lzw"
      lede={
        <p>
          LZ77 points back into the text. Its 1978 sibling, LZ78, builds an explicit <b>dictionary</b> of phrases instead and sends their
          numbers. Terry Welch’s 1984 refinement, LZW, starts the dictionary with every single byte, so it never has to send a raw character at
          all — and the decoder rebuilds the identical dictionary from the codes alone, one step behind the encoder.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['tobe', 'abra', 'banana', 'runs', 'prose', 'json', 'random']} maxBytes={3000} />
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
                {mode === 'encode' ? 'Each step reads one input byte: extend the current string, or send it and add a new entry.' : 'Each step reads one code, writes its string, and adds the entry the encoder made one step earlier.'}
              </p>
            </Group>
            <Group title="Dictionary">
              <Slider
                label="max code width"
                value={maxWidth}
                min={9}
                max={16}
                onChange={setMaxWidth}
                display={`${maxWidth} bits = ${(1 << maxWidth).toLocaleString('en-US')} codes`}
                help="Codes start 9 bits wide and grow by one bit each time the table passes a power of two, up to this cap. GIF stops at 12, Unix compress at 16."
              />
              <Segmented
                label="when full"
                value={policy}
                onChange={setPolicy}
                help="Freeze: stop learning and keep the table you have. Reset: send CLEAR (code 256), throw the table away and start learning again — what compress and GIF do, and much better when the data changes character."
                options={[
                  { value: 'freeze', label: 'freeze' },
                  { value: 'reset', label: 'reset (CLEAR)' },
                ]}
              />
              {policy === 'reset' && <p className="small muted">Code 256 is reserved for CLEAR, so new entries start at 257.</p>}
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="codes" value={enc.codes.length} sub={clears ? `${clears} CLEAR` : undefined} />
                <Stat label="entries made" value={enc.log.length} />
                <Stat label="bits" value={bits} tone="accent" sub={`vs ${data.length * 8} raw`} />
                <Stat label="ratio" value={data.length ? (bits / (data.length * 8)).toFixed(3) : '—'} tone={bits < data.length * 8 ? 'good' : 'bad'} />
                <Stat label="KwKwK" value={kwk} help="Codes the decoder received before it had defined them. Each one is resolved by the rule: previous string + its own first byte." />
              </Stats>
            </Group>
          </>
        }
      >
        {mode === 'encode' ? <EncodeStage data={data} enc={enc} p={p} index={s.index} /> : <DecodeStage enc={enc} dec={dec} p={p} index={s.index} onJump={(k) => s.setIndex(k + 1)} />}

        <Transport s={s} label={(i) => (mode === 'encode' ? `step ${i} / ${enc.steps.length}` : `code ${i} / ${dec.steps.length}`)} />

        <Panel title="How big is it">
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: data.length * 8, tone: 'faint' },
              { label: 'LZW', value: bits, note: `${enc.codes.length} codes, avg ${(bits / Math.max(1, enc.codes.length)).toFixed(1)} bits` },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            A 9-bit code that stands for a single byte costs more than the byte. LZW only wins once its phrases get long, which is why it is poor
            on short inputs and good on long, repetitive ones.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The algorithm</h2>
        <Code>{`table ← { 0…255: every single byte }            next ← 256
w ← first byte
for each next byte c:
    if w + c is in the table:   w ← w + c                     # keep extending
    else:
        emit code(w)
        add w + c as code next;  next ← next + 1               # learn
        w ← c
emit code(w)`}</Code>
        <p>
          Every entry is an earlier entry plus one byte, so the table is a <b>trie</b>: in the TOBEORNOT example, code 265 = code 256 (‘TO’) + ‘B’. It never needs to be sent. The
          decoder rebuilds it with the mirror-image rule: after reading a code, add (previous string + first byte of this string). The encoder
          made that same entry one step earlier — the moment it found that <i>w + c</i> was new.
        </p>
        <h2>The decoder is one step behind — KwKwK</h2>
        <p>
          The encoder adds an entry and can use it on the very next code. The decoder only learns that entry <i>while</i> reading the next code
          — so if that next code <i>is</i> the new entry, it arrives undefined. This happens exactly when the input contains K·w·K·w·K, where
          K·w is already in the table: try <i>ababab…</i> or <i>aaaa…</i> in Decode mode. The decoder is not stuck. The unknown entry must be the
          previous string plus one byte, and that byte is the first byte of the entry itself — which is the first byte of the previous string. So
          it is <code>prev + prev[0]</code>. Welch’s paper calls it out; most first implementations miss it.
        </p>
        <h2>Code widths</h2>
        <p>
          Codes are written with just enough bits for the largest code that could come next: 9 bits while every code is below 512, 10
          below 1,024, and so on. The decoder can compute the same width because it knows the table size — it is always one entry
          behind, and the KwKwK case is exactly the one extra code it has to allow for. When the cap is reached the table is either frozen or
          cleared. Unix <code>compress</code> clears it when the ratio starts to drop; GIF encoders usually clear as soon as it fills.
        </p>
        <h2>History, and a patent</h2>
        <p>
          Ziv and Lempel’s 1978 paper (LZ78) sent ⟨phrase number, next byte⟩ pairs. Welch, at Sperry, dropped the explicit byte by pre-loading
          the dictionary, published it in <i>IEEE Computer</i> in 1984, and Sperry (later Unisys) patented it. Unix <code>compress</code> (1985)
          and CompuServe’s GIF (1987) both used LZW. In late 1994 Unisys announced it would collect royalties on GIF software, and within weeks
          a group on Usenet began designing a patent-free replacement: <b>PNG</b>, which uses <a href="#/deflate">DEFLATE</a> instead. Gzip
          replaced compress for the same reason. The patents expired in 2003–2004, but by then LZ77 had won.
        </p>
        <h2>LZ77 versus LZ78</h2>
        <p>
          Both are universal — both reach the entropy rate of any stationary source in the limit. LZ78-style dictionaries adapt in coarse steps
          (one byte longer per phrase per occurrence), so they learn long repeats slowly; LZ77 can copy a 200-byte repeat in one token the
          second time it appears. LZ77 needs a search; LZW needs only a table lookup per byte, which made it the faster choice on 1980s hardware.
          Today LZW survives in GIF, TIFF and PDF’s LZWDecode filter.
        </p>
      </Notes>
    </Page>
  )
}

// ------------------------------------------------------------------- shared

function DictTable({ log, genStart, logLen, newCode, onCode, policy }: { log: Entry[]; genStart: number; logLen: number; newCode?: number; onCode?: number; policy: Policy }) {
  const ref = useRef<HTMLDivElement>(null)
  const target = newCode ?? onCode
  useEffect(() => {
    const box = ref.current
    if (!box || target === undefined) return
    const row = box.querySelector<HTMLElement>(`[data-code="${target}"]`)
    if (!row) return
    const top = row.offsetTop
    if (top < box.scrollTop + 30 || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = Math.max(0, top - box.clientHeight / 2)
  }, [target, logLen])
  const rows = log.slice(genStart, logLen)
  return (
    <div className="lzw-table" ref={ref}>
      <table className="data">
        <thead>
          <tr>
            <th className="num">code</th>
            <th>string</th>
            <th className="num">len</th>
          </tr>
        </thead>
        <tbody>
          <tr className={onCode !== undefined && onCode < 256 ? 'on' : ''}>
            <td className="num muted">0–255</td>
            <td className="muted" style={{ whiteSpace: 'normal' }}>
              every single byte{onCode !== undefined && onCode < 256 ? <> — here ‘{glyph(onCode)}’ = {onCode}</> : ''}
            </td>
            <td className="num muted">1</td>
          </tr>
          {policy === 'reset' && (
            <tr className={onCode === CLEAR ? 'on' : ''}>
              <td className="num muted">256</td>
              <td className="muted">CLEAR</td>
              <td className="num muted">—</td>
            </tr>
          )}
          {rows.map((e) => (
            <tr key={e.code} data-code={e.code} className={e.code === newCode ? 'new' : e.code === onCode ? 'on' : ''}>
              <td className="num">{e.code}</td>
              <td>{str(e.bytes, 40)}</td>
              <td className="num">{e.bytes.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="small muted" style={{ margin: '8px 0 0' }}>No entries yet.</p>}
    </div>
  )
}

function CodeChips({ codes, upto, current, kinds, onJump }: { codes: Emitted[]; upto: number; current: number; kinds?: string[]; onJump?: (i: number) => void }) {
  return (
    <div className="lzw-codes">
      {codes.map((c, i) => (
        <button
          type="button"
          key={i}
          className={
            'lzw-code' +
            (c.code === CLEAR && c.len === 0 ? ' clear' : c.code >= 256 ? ' hi' : '') +
            (i === current ? ' on' : '') +
            (i >= upto ? ' future' : '') +
            (kinds && i < upto && kinds[i] === 'kwkwk' ? ' kwk' : '')
          }
          onClick={onJump ? () => onJump(i) : undefined}
          title={c.code === CLEAR && c.len === 0 ? 'CLEAR' : `code ${c.code}, ${c.width} bits`}
        >
          {c.code === CLEAR && c.len === 0 ? 'CLR' : c.code}
          <sub>{c.width}</sub>
        </button>
      ))}
    </div>
  )
}

function bitsOf(codes: Emitted[], upto: number) {
  let bits = ''
  const spans: { start: number; length: number; className: string; title: string }[] = []
  for (let k = 0; k < upto; k++) {
    const c = codes[k]
    const b = c.code.toString(2).padStart(c.width, '0')
    spans.push({ start: bits.length, length: c.width, className: c.code === CLEAR && c.len === 0 ? 'hl-2' : k % 2 ? 'hl-4' : 'hl-6', title: `code ${c.code} in ${c.width} bits` })
    bits += b
  }
  return { bits, spans }
}

// ------------------------------------------------------------------- encode

function EncodeStage({ data, enc, p, index }: { data: Uint8Array; enc: ReturnType<typeof encodeTrace>; p: LzwParams; index: number }) {
  const step = index > 0 ? enc.steps[index - 1] : null
  const owner = useMemo(() => {
    const o = new Int32Array(data.length).fill(-1)
    enc.codes.forEach((c, k) => {
      for (let i = c.start; i < c.start + c.len; i++) o[i] = k
    })
    return o
  }, [data, enc])
  const codesLen = step ? step.codesLen : 0
  const lastRead = step ? (step.kind === 'flush' ? data.length - 1 : step.i) : -1

  const mark = (i: number): string | undefined => {
    if (!step) return i === 0 ? 'cur' : 'dim'
    if (owner[i] >= 0 && owner[i] < codesLen) {
      const justEmitted = owner[i] === codesLen - 1 || (enc.codes[codesLen - 1]?.code === CLEAR && owner[i] === codesLen - 2)
      return (owner[i] % 2 ? 'hl-4' : 'hl-6') + (justEmitted && step.kind !== 'extend' && step.kind !== 'start' ? ' cur' : '')
    }
    if (i >= step.wStart && i < step.wStart + step.wLen) return 'hl-1' + (i === lastRead ? ' cur' : '')
    if (i > lastRead) return 'dim'
    return undefined
  }

  const { bits, spans } = bitsOf(enc.codes, codesLen)
  const w = step ? data.subarray(step.prevStart, step.prevStart + step.prevLen) : null
  const c = step && step.i >= 0 ? data[step.i] : null
  const emitted = step && (step.kind === 'emit' || step.kind === 'flush') ? enc.codes[step.cleared ? codesLen - 2 : codesLen - 1] : null
  const onCode = step ? (step.kind === 'extend' ? step.found : emitted ? emitted.code : step.wCode) : undefined

  return (
    <>
      <Panel title="Input" aside={step ? `${lastRead + 1} of ${data.length} bytes read` : `${data.length} bytes`}>
        <Tape bytes={data} mark={mark} />
        <div className="legend" style={{ marginTop: 8 }}>
          <span>
            <i className="hl-1" /> w (current string)
          </span>
          <span>
            <i className="hl-6" />
            <i className="hl-4" /> sent as one code each
          </span>
        </div>
      </Panel>

      <Narration tone={index === enc.steps.length && index > 0 ? 'done' : step?.cleared ? 'warn' : undefined}>
        {!step && (data.length ? <>The table starts with all 256 single bytes. Step forward to read the first one.</> : <>Type something to compress.</>)}
        {step?.kind === 'start' && (
          <>
            Read ‘<b>{glyph(data[0])}</b>’. Every single byte is already in the table, so w = ‘{glyph(data[0])}’ (code {data[0]}).
          </>
        )}
        {step?.kind === 'extend' && (
          <>
            Read ‘<b>{glyph(c!)}</b>’. {q([...w!, c!])} is in the table as <b>{step.found}</b>, so keep going: w = {q([...w!, c!])}. Nothing sent.
          </>
        )}
        {step?.kind === 'emit' && (
          <>
            Read ‘<b>{glyph(c!)}</b>’. {q([...w!, c!])} is new. Send <b>{emitted!.code}</b> for {q(w!)} in {emitted!.width} bits
            {step.added && (
              <>
                , add <b>{step.added.code}</b> = {q(step.added.bytes)}
              </>
            )}
            {step.cleared && (
              <>
                . The table is full ({1 << p.maxWidth} codes), so send <b>CLEAR</b> and start over at 9 bits
              </>
            )}
            {step.frozen && <>. The table is full, so nothing is added — it is frozen from here on</>}, and restart from w = ‘{glyph(c!)}’.
          </>
        )}
        {step?.kind === 'flush' && (
          <>
            End of input: send <b>{emitted!.code}</b> for the last w, {q(w!)}. Done — {enc.codes.length} codes, {bits} bits.
          </>
        )}
      </Narration>

      <div className="lz-split">
        <Panel title="State">
          <div className="lz-state">
            <span>w</span>
            <span>{w ? <>{q(w)} = {step!.prevCode}</> : '—'}</span>
            <span>c</span>
            <span>{c !== null ? `‘${glyph(c)}’` : '—'}</span>
            <span>w + c</span>
            <span>
              {step?.kind === 'extend' && <>in table → {step.found}</>}
              {step?.kind === 'emit' && <>not in table → send {emitted!.code}</>}
              {(!step || step.kind === 'start' || step.kind === 'flush') && '—'}
            </span>
            <span>next code</span>
            <span>
              {step ? step.next : firstFree(p.policy)}
              <Help text="The number the next new entry will get. The code width is set by it: enough bits for next − 1." />
            </span>
          </div>
        </Panel>
        <Panel title="Dictionary" aside={step ? `${step.logLen - step.genStart} entries` : '0 entries'}>
          <DictTable log={enc.log} genStart={step?.genStart ?? 0} logLen={step?.logLen ?? 0} newCode={step?.added?.code} onCode={onCode} policy={p.policy} />
        </Panel>
      </div>

      <Panel title="Output codes" aside={`${codesLen} codes · ${bits.length} bits`}>
        <CodeChips codes={enc.codes} upto={codesLen} current={emitted ? enc.codes.indexOf(emitted) : -1} />
        <div className="lz-bits">
          <BitRow bits={bits} spans={spans} />
        </div>
      </Panel>
    </>
  )
}

// ------------------------------------------------------------------- decode

function DecodeStage({
  enc,
  dec,
  p,
  index,
  onJump,
}: {
  enc: ReturnType<typeof encodeTrace>
  dec: ReturnType<typeof decodeTrace>
  p: LzwParams
  index: number
  onJump: (k: number) => void
}) {
  const st = index > 0 ? dec.steps[index - 1] : null
  const kinds = dec.steps.map((x) => x.kind)
  const outLen = st ? st.outStart + st.outLen : 0
  const out = dec.out.slice(0, outLen)
  const prevBytes = st && st.prev >= 0 ? (st.prev < 256 ? [st.prev] : dec.log.find((e) => e.code === st.prev)?.bytes ?? []) : []
  const cur = st ? dec.out.slice(st.outStart, st.outStart + st.outLen) : []
  const { bits, spans } = bitsOf(enc.codes, index)
  const activeSpan = index > 0 ? index - 1 : undefined

  return (
    <>
      <Panel title="Codes received" aside={st ? `code ${index} of ${dec.steps.length}` : `${dec.steps.length} codes`}>
        <CodeChips codes={enc.codes} upto={index} current={index - 1} kinds={kinds} onJump={onJump} />
        <div className="lz-bits">
          <BitRow bits={bits} spans={spans} active={activeSpan} />
        </div>
      </Panel>

      <Narration tone={index === dec.steps.length && index > 0 ? 'done' : st?.kind === 'kwkwk' ? 'warn' : undefined}>
        {!st && <>The decoder starts with the same 256 single bytes and nothing else. It never sees the encoder’s table.</>}
        {st?.kind === 'first' && (
          <>
            Read <b>{st.code}</b> ({st.width} bits): ‘{glyph(st.code)}’. {st.prev < 0 && index > 1 ? 'The table was just cleared, so' : 'This is the first code, so'} there is no previous string and nothing to add yet.
          </>
        )}
        {st?.kind === 'known' && (
          <>
            Read <b>{st.code}</b> ({st.width} bits) = {q(cur)}. Write it, then add what the encoder added a step ago: previous {q(prevBytes)} + first byte ‘
            {glyph(cur[0])}’ = <b>{st.added ? `${st.added.code} = ${q(st.added.bytes)}` : '(table full, nothing added)'}</b>.
          </>
        )}
        {st?.kind === 'kwkwk' && (
          <>
            <span className="badge warn">KwKwK</span> Read <b>{st.code}</b> — which is not in the table yet. The encoder created it one step ago and used it
            immediately. It must be the previous string {q(prevBytes)} plus one byte, and that byte is its own first byte, ‘{glyph(prevBytes[0])}’. So{' '}
            {st.code} = <b>{q(cur)}</b>: write it and add it.
          </>
        )}
        {st?.kind === 'clear' && (
          <>
            Read <b>CLEAR</b> (256): forget every learned entry and go back to 9-bit codes. The next code starts a fresh string.
          </>
        )}
        {index === dec.steps.length && index > 0 && <> All {dec.out.length} bytes rebuilt — and the table matches the encoder’s.</>}
      </Narration>

      <div className="lz-split">
        <Panel title="Decoder’s dictionary" aside={st ? `${st.logLen - st.genStart} entries` : '0 entries'}>
          <DictTable log={dec.log} genStart={st?.genStart ?? 0} logLen={st?.logLen ?? 0} newCode={st?.added?.code} onCode={st ? st.code : undefined} policy={p.policy} />
        </Panel>
        <Panel title="Output" aside={`${out.length} bytes`}>
          <Tape bytes={out} mark={(i) => (st && i >= st.outStart ? 'hl-6 cur' : undefined)} />
        </Panel>
      </div>
    </>
  )
}
