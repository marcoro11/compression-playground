import { useMemo, useState, type ReactNode } from 'react'
import { counts, entropyOf } from '../../lib/entropy'
import { fmt, glyph, int, pct } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { RUNA, bwtForward, lfMapping, mtfEncode, usedSymbols, zeroRunTokens } from './bwt'
import { bwtEncode } from './codec'
import './bwt.css'

type Stage = 'forward' | 'inverse' | 'mtf' | 'runs'

/** How many bytes the step-through stages show. The numbers in the side panel always use the whole input. */
const VIS = 160
/** Above this length a matrix row is shown as its first WIDE characters, an ellipsis, and the last. */
const WIDE = 22
const ROWH = 21

/** A visual sequence: bytes, optionally shifted up by one with 0 as a '$' sentinel. */
interface Seq {
  vals: number[]
  alphabet: number
  sentinel: boolean
}

const symGlyph = (seq: Seq, v: number) => (seq.sentinel ? (v === 0 ? '$' : glyph(v - 1)) : glyph(v))
const symClass = (seq: Seq, v: number) => (seq.sentinel && v === 0 ? ' sentinel hl-2' : '')

/** Runs of equal values: run id per position and which runs are longer than one. */
function runsOf(a: ArrayLike<number>): { id: number[]; long: boolean[]; count: number } {
  const id: number[] = []
  const len: number[] = []
  for (let i = 0; i < a.length; i++) {
    if (i > 0 && a[i] === a[i - 1]) len[len.length - 1]++
    else len.push(1)
    id.push(len.length - 1)
  }
  return { id, long: len.map((l) => l > 1), count: len.length }
}

const runClass = (r: { id: number[]; long: boolean[] }, i: number) => (r.long[r.id[i]] ? (r.id[i] % 2 ? 'hl-4' : 'hl-1') : undefined)

export function Bwt() {
  const src = useSource('banana', 4096)
  const [stage, setStage] = useState<Stage>('forward')
  const [sentinel, setSentinel] = useState(true)

  const data = src.bytes
  const visBytes = useMemo(() => data.subarray(0, VIS), [data])
  const seq: Seq = useMemo(
    () =>
      sentinel
        ? { vals: [...Array.from(visBytes, (b) => b + 1), 0], alphabet: 257, sentinel: true }
        : { vals: Array.from(visBytes), alphabet: 256, sentinel: false },
    [visBytes, sentinel],
  )
  const vbwt = useMemo(() => bwtForward(seq.vals, seq.alphabet), [seq])

  // The bzip2 path (no sentinel) on the visual slice, for MTF and runs.
  const bBwt = useMemo(() => bwtForward(visBytes), [visBytes])
  const bUsed = useMemo(() => usedSymbols(visBytes), [visBytes])
  const bMtf = useMemo(() => mtfEncode(bBwt.last, bUsed), [bBwt, bUsed])
  const bTokens = useMemo(() => zeroRunTokens(bMtf), [bMtf])

  // Whole-input numbers.
  const full = useMemo(() => {
    const n = data.length
    const b = bwtForward(data)
    const used = usedSymbols(data)
    const mtf = mtfEncode(b.last, used)
    const toks = zeroRunTokens(mtf)
    const syms: number[] = []
    for (const t of toks) syms.push(...t.symbols)
    syms.push(used.length + 1)
    const symH = entropyOf(syms, used.length + 2)
    const encoded = bwtEncode(data)
    return {
      n,
      hRaw: entropyOf(data),
      hL: entropyOf(b.last),
      hMtf: entropyOf(mtf),
      zeros: mtf.filter((x) => x === 0).length,
      symCount: syms.length,
      symH,
      encodedBytes: encoded.length,
      runsIn: runsOf(data).count,
      runsL: runsOf(b.last).count,
    }
  }, [data])

  const n = seq.vals.length
  const count = stage === 'forward' ? n + 4 : stage === 'inverse' ? n + 2 : stage === 'mtf' ? bMtf.length + 1 : bTokens.length + 1
  const s = useStepper(count, { speed: stage === 'forward' ? 2 : 4, resetKey: src.key + stage + sentinel })

  return (
    <Page
      slug="bwt"
      lede={
        <p>
          Write the text out once per rotation, sort the rows, and keep only the last column. It is the same letters in a different order — yet
          the transform is <b>reversible</b>, and the new order is full of runs, because sorting rows by what <i>follows</i> each letter puts
          letters with the same context side by side. Michael Burrows and David Wheeler published it in 1994; bzip2 is built on it.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['banana', 'abra', 'tobe', 'prose', 'json', 'dna', 'runs', 'random']} maxBytes={4096} />
              {data.length > VIS && (
                <p className="small muted">
                  Step-through shows the first {VIS} bytes; the numbers below use all {int(data.length)}.
                </p>
              )}
            </Group>
            <Group title="Stage">
              <Segmented
                value={stage}
                onChange={setStage}
                options={[
                  { value: 'forward', label: '1 BWT', title: 'Sort the rotations, keep the last column' },
                  { value: 'inverse', label: '2 Undo', title: 'Rebuild the text from the last column' },
                  { value: 'mtf', label: '3 MTF', title: 'Move-to-front' },
                  { value: 'runs', label: '4 Runs', title: 'Zero runs and Huffman' },
                ]}
              />
              <p className="small muted">
                {stage === 'forward' && 'Every rotation of the text, sorted. The last column L is the output.'}
                {stage === 'inverse' && 'From L and one row number back to the text, one character per step, using only counting.'}
                {stage === 'mtf' && 'Replace each byte of L by its position in a list, then move it to the front. Runs become zeros.'}
                {stage === 'runs' && 'Code the runs of zeros in bijective base 2 (RUNA / RUNB), then Huffman-code what is left.'}
              </p>
              {(stage === 'forward' || stage === 'inverse') && (
                <Toggle
                  label="End sentinel $"
                  value={sentinel}
                  onChange={setSentinel}
                  help="The textbook version appends a unique character '$' that sorts before everything; the original text is then the row ending in $. bzip2 instead stores the row number of the original (the primary index). Stages 3 and 4 follow bzip2."
                />
              )}
            </Group>
            <Group title="Whole input">
              <Stats>
                <Stat label="runs in input" value={int(full.runsIn)} help="Maximal blocks of one repeated byte in the original." />
                <Stat label="runs in L" value={int(full.runsL)} tone="accent" help="The same count for the BWT output. Fewer runs means longer ones — that is what the sort bought." />
                <Stat label="H before" value={fmt(full.hRaw, 2)} sub="bits / byte" help="Order-0 entropy of the input: what a Huffman or arithmetic coder could reach on it directly." />
                <Stat label="H after MTF" value={fmt(full.hMtf, 2)} sub="bits / byte" tone="good" help="Order-0 entropy of the move-to-front output. BWT itself leaves the order-0 entropy unchanged (same letters); MTF is what turns its local clustering into skewed statistics." />
                <Stat label="zeros after MTF" value={full.n ? pct(full.zeros / full.n, 0) : '—'} />
                <Stat label="codec output" value={`${int(full.encodedBytes)} B`} sub={full.n ? `${pct(full.encodedBytes / full.n)} of input` : ''} help="The real encoder below: header + in-use map + code lengths + Huffman-coded run symbols." />
              </Stats>
            </Group>
          </>
        }
      >
        <StageBar stage={stage} setStage={setStage} />
        {stage === 'forward' && <ForwardStage seq={seq} bwt={vbwt} index={s.index} />}
        {stage === 'inverse' && <InverseStage seq={seq} bwt={vbwt} index={s.index} />}
        {stage === 'mtf' && <MtfStage last={bBwt.last} used={bUsed} mtf={bMtf} index={s.index} />}
        {stage === 'runs' && <RunsStage mtf={bMtf} tokens={bTokens} used={bUsed} index={s.index} />}

        <Transport
          s={s}
          label={(i) =>
            stage === 'forward'
              ? i === 0
                ? 'input'
                : i === 1
                  ? 'rotations'
                  : i === 2
                    ? 'sorted'
                    : i < count - 1
                      ? `row ${i - 3} / ${n}`
                      : 'L'
              : stage === 'inverse'
                ? i === 0
                  ? 'given L'
                  : `${i - 1} / ${n} chars`
                : stage === 'mtf'
                  ? `${i} / ${count - 1} bytes`
                  : `${i} / ${count - 1} tokens`
          }
        />

        <Panel title="Where the bits go" aside="whole input">
          <SizeBars
            rows={[
              { label: 'as bytes', value: full.n * 8, tone: 'faint' },
              { label: 'H₀ of input', value: full.hRaw * full.n, tone: 'faint', note: 'order-0 bound' },
              { label: 'H₀ of L', value: full.hL * full.n, tone: 'faint', note: 'same letters' },
              { label: 'H₀ after MTF', value: full.hMtf * full.n, note: 'skew exposed' },
              { label: 'after runs', value: full.symH * full.symCount, note: `${int(full.symCount)} symbols` },
              { label: 'codec, total', value: full.encodedBytes * 8, tone: 'ink', note: 'incl. tables' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            The BWT row does not move — it only reorders — and that is the point: an order-0 coder cannot see the gain until move-to-front turns
            “the same letter as a moment ago” into the symbol 0.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The transform</h2>
        <Code>{`forward(T):                       # n = |T|
    rows ← the n rotations of T, sorted
    L    ← last character of every row
    p    ← the row that equals T        # or: append '$', and p is implicit
    return L, p

inverse(L, p):
    C[c]    ← number of characters in L smaller than c
    LF[i]   ← C[L[i]] + (occurrences of L[i] in L[0..i))
    r ← p
    for k = n−1 down to 0:
        T[k] ← L[r];  r ← LF[r]`}</Code>
        <p>
          The first column F is just L sorted, so storing L loses nothing about which letters there are. What makes it invertible is the{' '}
          <b>LF mapping</b>: every row is a cycle, so L[i] is the character that comes right before F[i] in the text. And among rows that end in
          the same character c, the order of the rows is decided by what follows c — which is exactly the order those same occurrences of c have
          in F. Hence the rule the inverse stage animates: <i>the k-th c in L is the k-th c in F</i>. Following it from the original row walks
          the text backwards, one character per step, with nothing but counting.
        </p>
        <h2>Why the output clusters</h2>
        <p>
          Sorting rotations sorts every position of the text by its <b>right context</b> — the characters that follow it. Two positions next to
          each other in the sorted order share a long prefix of what comes after them, and in natural text the character <i>before</i> a context
          is highly predictable: almost every “he␣” in English is preceded by ‘t’. So L contains long stretches of ‘t’ wherever the rows begin
          with “he”. It is the same statistics that PPM-style context models exploit explicitly (predict a symbol from its neighbours), arrived at
          by sorting instead of modelling — Cleary and Teahan made the connection precise in 1997.
        </p>
        <h2>Move-to-front and the runs</h2>
        <p>
          BWT output is locally skewed but globally it has exactly the input’s letter frequencies, so its order-0 entropy is unchanged. Move-to-front
          (Bentley, Sleator, Tarjan &amp; Wei, 1986) converts locality into frequency: a letter seen moments ago is near the front of the list and
          codes as a small number, so the output is dominated by 0s and 1s. bzip2 then replaces each run of zeros by its length in bijective
          base 2 — digits RUNA = 1 and RUNB = 2, least significant first, so 1 = A, 2 = B, 3 = AA, 4 = BA, 5 = AB … — which needs about log₂ n
          symbols for a run of n and no terminator, because there is no digit for zero.
        </p>
        <h2>bzip2, as shipped</h2>
        <p>
          Julian Seward’s bzip2 (1996) runs: an initial run-length pass (four equal bytes and then a count, originally to protect the sort from
          long runs), the BWT on blocks of up to 900 kB, MTF, RUNA/RUNB, and then Huffman — with up to six tables, chosen afresh for every group
          of 50 symbols and themselves refined by a few rounds of re-estimation. Each block carries its primary index and a CRC. The codec on
          this page keeps the pipeline and drops the refinements: one block, one table.
        </p>
        <h2>Sorting fast</h2>
        <p>
          Sorting n rotations naively costs O(n log n) string comparisons that can each run n characters — quadratic on a file of zeros. The
          encoder here sorts by <b>prefix doubling</b>: rank rotations by their first character, then by their first 2, 4, 8 … using the ranks
          from the previous round as keys, with counting sorts, for O(n log n) overall. Production code builds a suffix array (SA-IS, divsufsort)
          in linear time; bzip2 itself uses a tuned multi-key quicksort with a fallback for repetitive data.
        </p>
        <div className="aside">
          History: Wheeler had the idea in 1983 and did not publish; the transform appeared as DEC Systems Research Center Report 124, “A
          Block-sorting Lossless Data Compression Algorithm” (1994). It has a second life outside compression: the <b>FM-index</b> (Ferragina &amp;
          Manzini, 2000) searches a BWT directly with the LF mapping, and it is how read aligners such as BWA and Bowtie fit an indexed human
          genome into a few gigabytes.
        </div>
      </Notes>
    </Page>
  )
}

function StageBar({ stage, setStage }: { stage: Stage; setStage: (s: Stage) => void }) {
  const steps: [Stage, string][] = [
    ['forward', 'BWT'],
    ['inverse', '(undo)'],
    ['mtf', 'move-to-front'],
    ['runs', 'RUNA/RUNB → Huffman'],
  ]
  return (
    <div className="bwt-stagebar">
      <span>input →</span>
      {steps.map(([k, l], i) => (
        <span key={k}>
          <button type="button" className={'chip' + (k === stage ? ' on' : '')} onClick={() => setStage(k)}>
            {l}
          </button>
          {i < steps.length - 1 && <span> →</span>}
        </span>
      ))}
    </div>
  )
}

// ----------------------------------------------------------- 1 · forward BWT

function RowCells({ seq, start, mark }: { seq: Seq; start: number; mark: (col: number, v: number) => string }) {
  const n = seq.vals.length
  const cols: number[] = n > WIDE + 2 ? [...Array.from({ length: WIDE }, (_, k) => k), -1, n - 1] : Array.from({ length: n }, (_, k) => k)
  return (
    <>
      {cols.map((c, k) => {
        if (c < 0) return <span key="ell" className="ell">…</span>
        const v = seq.vals[(start + c) % n]
        return (
          <span key={k} className={'cell' + (c === 0 ? ' fcol' : '') + (c === n - 1 ? ' lcol' : '') + symClass(seq, v) + ' ' + mark(c, v)}>
            {symGlyph(seq, v)}
          </span>
        )
      })}
    </>
  )
}

function ForwardStage({ seq, bwt, index }: { seq: Seq; bwt: ReturnType<typeof bwtForward>; index: number }) {
  const n = seq.vals.length
  const rank = useMemo(() => {
    const r = new Int32Array(n)
    bwt.order.forEach((start, row) => (r[start] = row))
    return r
  }, [bwt, n])
  const lRuns = useMemo(() => runsOf(bwt.last), [bwt])
  const inRuns = useMemo(() => runsOf(seq.vals), [seq])

  if (n === 0) return <Narration>Type something to transform.</Narration>

  const sorted = index >= 2
  const reading = index >= 3 ? Math.min(index - 3, n) : -1 // rows of L revealed: [0, reading)
  const done = index === n + 3
  const curRow = index >= 3 && !done ? index - 3 : -1
  const curStart = curRow >= 0 ? bwt.order[curRow] : -1

  const lMark = (row: number) => {
    if (row >= reading && !done) return 'dim'
    return (runClass(lRuns, row) ?? '') + (row === curRow ? ' cur' : '')
  }

  const ctx = (start: number, k: number) => {
    let s = ''
    for (let c = 0; c < Math.min(k, n - 1); c++) s += symGlyph(seq, seq.vals[(start + c) % n])
    return s
  }

  const textShown = seq.vals.map((v) => symGlyph(seq, v)).join('')

  let narration: ReactNode
  if (index === 0)
    narration = seq.sentinel ? (
      <>
        The input, with a <b>$</b> appended: a symbol that occurs once and sorts before every byte. It will mark which row is the original.
      </>
    ) : (
      <>
        The input, {n} bytes. Without a sentinel, we will have to remember which sorted row holds the original — bzip2 stores it as the{' '}
        <b>primary index</b>.
      </>
    )
  else if (index === 1)
    narration = (
      <>
        Every rotation: row i is the text read from position i, wrapping around. Each row is a cycle, so the first column F and the last column
        L hold the same letters — and L[i] is the letter that comes <i>just before</i> F[i] in the text.
      </>
    )
  else if (index === 2)
    narration = (
      <>
        Sorted. F is now just the letters in order — it carries no information. The original text sits in row <b>{bwt.primary}</b>
        {seq.sentinel ? ', the one that ends in $' : ' (the primary index)'}. Everything we keep is L, plus that row number.
      </>
    )
  else if (!done) {
    const v = bwt.last[curRow]
    narration = (
      <>
        Row {curRow} begins “<b>{ctx(curStart, 8)}</b>…” and ends in ‘<b>{symGlyph(seq, v)}</b>’: in the text, ‘{symGlyph(seq, v)}’ is
        followed by “{ctx(curStart, 8)}”. Rows are ordered by what follows, so letters with the same right-context land next to each other in L.
      </>
    )
  } else
    narration = (
      <>
        L = <code>{bwt.last.map((v) => symGlyph(seq, v)).join('')}</code>. The input had {inRuns.count} runs of equal letters; L has{' '}
        <b>{lRuns.count}</b>. Same letters, regrouped by context — highlighted runs are where the sort paid off.
      </>
    )

  return (
    <>
      <Panel title={sorted ? 'Sorted rotations' : 'Rotations'} aside={n > WIDE + 2 ? `${n} × ${n} — middle columns elided` : `${n} × ${n}`}>
        <div className="bwt-scroll">
          <div className="bwt-matrix" style={{ height: n * ROWH, minWidth: 46 + (Math.min(n, WIDE + 3) + 1) * 19 + 90 }}>
            {Array.from({ length: n }, (_, start) => {
              const row = sorted ? rank[start] : start
              const visible = index >= 1 || start === 0
              const isCur = start === curStart
              const isPrimary = start === 0 && sorted
              return (
                <div key={start} className={'bwt-row' + (visible ? '' : ' hidden') + (isCur ? ' cur' : '')} style={{ transform: `translateY(${row * ROWH}px)` }}>
                  <span className="bwt-label" title={`rotation starting at position ${start}`}>
                    {sorted ? row : `i=${start}`}
                  </span>
                  <RowCells seq={seq} start={start} mark={(col) => (col === n - 1 && index >= 3 ? lMark(row) : isCur && col < 8 ? 'hl-6' : '')} />
                  {isPrimary && <span className="bwt-marker">◀ original{seq.sentinel ? '' : ` · p = ${bwt.primary}`}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </Panel>
      <Panel title="Input → L" aside={index >= 3 ? `${Math.min(reading, n)} of ${n} read` : ''}>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <Tape bytes={seq.vals} render={(i) => symGlyph(seq, seq.vals[i])} mark={(i) => (runClass(inRuns, i) ?? '') + symClass(seq, seq.vals[i])} cellTitle={() => textShown} />
          {index >= 3 && (
            <Tape
              bytes={bwt.last}
              render={(i) => symGlyph(seq, bwt.last[i])}
              mark={(i) => ((i < reading || done ? runClass(lRuns, i) ?? '' : 'dim') + (i === curRow ? ' cur' : '') + symClass(seq, bwt.last[i]))}
            />
          )}
        </div>
      </Panel>
      <Narration tone={done ? 'done' : undefined}>{narration}</Narration>
    </>
  )
}

// ----------------------------------------------------------- 2 · inverse BWT

function InverseStage({ seq, bwt, index }: { seq: Seq; bwt: ReturnType<typeof bwtForward>; index: number }) {
  const n = seq.vals.length
  const { lf, rank, C } = useMemo(() => lfMapping(bwt.last, seq.alphabet), [bwt, seq.alphabet])
  const F = useMemo(() => bwt.last.slice().sort((a, b) => a - b), [bwt])
  const chain = useMemo(() => {
    const rows = [bwt.primary]
    for (let k = 1; k <= n; k++) rows.push(lf[rows[k - 1]])
    return rows
  }, [bwt, lf, n])

  if (n === 0) return <Narration>Type something to transform.</Narration>

  const showF = index >= 1
  const k = Math.max(0, index - 1) // characters emitted
  const done = k === n
  const from = k > 0 ? chain[k - 1] : -1 // row whose L we just read
  const to = k > 0 ? chain[k] : -1 // row it maps to
  const rebuilt: number[] = []
  for (let j = 0; j < k; j++) rebuilt.unshift(bwt.last[chain[j]])

  // Column x positions for the arrow overlay (label 46, flex gaps of 2, cells 26 wide, spacer 70).
  const xF = 46 + 2 + 26
  const xL = xF + 2 + 70 + 2
  const y = (row: number) => row * ROWH + ROWH / 2

  const sub = (r: number) => <sub>{r + 1}</sub>
  const cur = (row: number) => row === from

  const textVal = (v: number) => symGlyph(seq, v)

  let narration: ReactNode
  if (index === 0)
    narration = (
      <>
        All the decoder gets: L = <code>{bwt.last.map(textVal).join('')}</code> and the row number <b>{bwt.primary}</b>. Next it sorts L to
        recover F.
      </>
    )
  else if (index === 1)
    narration = (
      <>
        F is L sorted. Number the copies of each letter in both columns: <b>the k-th ‘a’ in L is the k-th ‘a’ in F</b> — both orders are
        decided by the text that follows that ‘a’. Start at row {bwt.primary}: it is the original, so its last letter is the text’s last
        letter.
      </>
    )
  else {
    const v = bwt.last[from]
    narration = (
      <>
        Row {from}: L holds ‘<b>{textVal(v)}</b>’<sub>{rank[from] + 1}</sub> — copy {rank[from] + 1} of ‘{textVal(v)}’ in L, so it is copy{' '}
        {rank[from] + 1} in F too, which is row {to} ({C[v]} letter{C[v] === 1 ? '' : 's'} sort before ‘{textVal(v)}’, plus {rank[from]} earlier ‘{textVal(v)}’). Prepend ‘{textVal(v)}’
        and continue from row {to}.
        {done && <> All {n} characters recovered.</>}
      </>
    )
  }

  return (
    <>
      <Panel title="F and L, with occurrence numbers" aside={`LF(i) = C[L[i]] + rank(i)`}>
        <div className="bwt-scroll">
          <div className="bwt-colhead">
            <span style={{ width: 46, minWidth: 46, textAlign: 'right', paddingRight: 6 }}>row</span>
            <span style={{ width: 26 }}>F</span>
            <span style={{ width: 70 }} />
            <span style={{ width: 26 }}>L</span>
          </div>
          <div className="bwt-lf" style={{ height: n * ROWH, width: 46 + 26 * 2 + 76 + 40 }}>
            {Array.from({ length: n }, (_, row) => {
              const fv = F[row]
              const fr = row - C[fv]
              return (
                <div key={row} className={'bwt-lf-row' + (cur(row) ? ' cur' : '')}>
                  <span className="bwt-label">
                    {row}
                    {row === bwt.primary ? ' p' : ''}
                  </span>
                  <span className={'cell' + (showF ? '' : ' ghost') + (row === to ? ' hl-1 cur' : '') + symClass(seq, fv)}>
                    {showF ? (
                      <>
                        {textVal(fv)}
                        {sub(fr)}
                      </>
                    ) : (
                      '?'
                    )}
                  </span>
                  <span className="gap">{row === bwt.primary && index <= 1 ? 'start →' : '⋯'}</span>
                  <span className={'cell' + (row === from ? ' hl-1 cur' : chain.slice(0, k).includes(row) ? ' hl-3' : '') + symClass(seq, bwt.last[row])}>
                    {textVal(bwt.last[row])}
                    {showF && sub(rank[row])}
                  </span>
                </div>
              )
            })}
            {from >= 0 && (
              <svg width={xL + 30} height={n * ROWH}>
                <defs>
                  <marker id="bwt-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink)" />
                  </marker>
                </defs>
                <path
                  d={`M ${xL} ${y(from)} C ${xL - 40} ${y(from)}, ${xF + 40} ${y(to)}, ${xF + 3} ${y(to)}`}
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth={1.8}
                  markerEnd="url(#bwt-arr)"
                />
              </svg>
            )}
          </div>
        </div>
      </Panel>
      <Panel title="Rebuilt text" aside={`${k} of ${n}, back to front`}>
        <Tape
          bytes={Array.from({ length: n }, (_, j) => (j >= n - k ? rebuilt[j - (n - k)] : 0))}
          render={(j) => (j >= n - k ? textVal(rebuilt[j - (n - k)]) : '·')}
          mark={(j) => (j < n - k ? 'ghost' : j === n - k ? 'cur hl-1' : 'hl-3') + (j >= n - k ? symClass(seq, rebuilt[j - (n - k)]) : '')}
          cellTitle={(j) => `position ${j}`}
        />
      </Panel>
      <Narration tone={done ? 'done' : undefined}>{narration}</Narration>
    </>
  )
}

// ------------------------------------------------------------ 3 · move-to-front

const mtfClass = (v: number) => (v === 0 ? 'hl-3' : v === 1 ? 'hl-1' : v <= 3 ? 'hl-4' : undefined)

function MtfStage({ last, used, mtf, index }: { last: number[]; used: number[]; mtf: number[]; index: number }) {
  const n = last.length
  const SHOW = 16
  // List state before step k (k = index − 1) and after it.
  const { before, after } = useMemo(() => {
    const list = used.slice()
    let prev = list.slice()
    for (let i = 0; i < index; i++) {
      prev = list.slice()
      const j = list.indexOf(last[i])
      list.splice(j, 1)
      list.unshift(last[i])
    }
    return { before: prev, after: list }
  }, [used, last, index])

  if (n === 0) return <Narration>Type something to transform.</Narration>

  const k = index - 1
  const j = k >= 0 ? mtf[k] : -1
  const zerosSoFar = mtf.slice(0, index).filter((x) => x === 0).length
  const done = index === n

  const listView = (list: number[], hi: number, front: boolean) => (
    <div className="bwt-mini">
      {list.slice(0, SHOW).map((b, i) => (
        <span className="bwt-mtf-col" key={i}>
          <span className={'cell' + (i === hi ? (front ? ' hl-3 cur' : ' hl-1 cur') : '')}>{glyph(b)}</span>
          <span className="idx">{i}</span>
        </span>
      ))}
      {list.length > SHOW && <span className="muted small"> +{list.length - SHOW}</span>}
    </div>
  )

  return (
    <>
      <Panel title="L, the BWT output" aside={`no sentinel · ${used.length} distinct bytes`}>
        <Tape bytes={last} mark={(i) => (i === k ? 'cur hl-1' : i < index ? undefined : 'dim')} />
      </Panel>
      <Panel title="The list" aside="starts as the bytes in use, in order">
        <div className="bwt-listrow">
          <span>before</span>
          {listView(index === 0 ? used : before, j, false)}
        </div>
        <div className="bwt-listrow">
          <span>after</span>
          {listView(index === 0 ? used : after, index === 0 ? -1 : 0, true)}
        </div>
      </Panel>
      <Panel title="MTF output" aside={`${index} emitted · ${index ? pct(zerosSoFar / index, 0) : '—'} zeros`}>
        <div className="bwt-num">
          <Tape bytes={mtf} render={(i) => String(mtf[i])} mark={(i) => (i < index ? (mtfClass(mtf[i]) ?? '') + (i === k ? ' cur' : '') : 'ghost')} />
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          <span>
            <i className="hl-3" /> 0
          </span>
          <span>
            <i className="hl-1" /> 1
          </span>
          <span>
            <i className="hl-4" /> 2–3
          </span>
        </div>
      </Panel>
      <Narration tone={done ? 'done' : undefined}>
        {index === 0 ? (
          <>
            The list starts with the {used.length} bytes that occur, in byte order (bzip2 stores which ones in a 256-bit “in use” map). Each byte
            of L is replaced by where it sits in the list, and then moved to the front.
          </>
        ) : (
          <>
            ‘<b>{glyph(last[k])}</b>’ is at position <b>{j}</b> → emit {j}
            {j === 0 ? ' — it was the last byte seen, so it was already in front. A run in L becomes a run of zeros.' : ', then move it to the front.'}
            {done && (
              <>
                {' '}
                Done: {pct(zerosSoFar / n, 0)} of the output is 0 — the clustering BWT created is now plain skew an entropy coder can use.
              </>
            )}
          </>
        )}
      </Narration>
    </>
  )
}

// ------------------------------------------------------------ 4 · runs + Huffman

function symLabel(s: number) {
  return s === RUNA ? 'A' : s === 1 ? 'B' : String(s)
}

function RunsStage({ mtf, tokens, used, index }: { mtf: number[]; tokens: ReturnType<typeof zeroRunTokens>; used: number[]; index: number }) {
  const m = used.length
  const EOB = m + 1
  const allSyms = useMemo(() => {
    const out: number[] = []
    for (const t of tokens) out.push(...t.symbols)
    out.push(EOB)
    return out
  }, [tokens, EOB])
  const symH = entropyOf(allSyms, m + 2)
  const hist = counts(allSyms, m + 2)

  const t = index > 0 ? tokens[index - 1] : null
  const tokOf = useMemo(() => {
    const a = new Array<number>(mtf.length)
    tokens.forEach((tk, ti) => {
      const len = tk.run || 1
      for (let q = 0; q < len; q++) a[tk.at + q] = ti
    })
    return a
  }, [tokens, mtf.length])
  if (mtf.length === 0) return <Narration>Type something to transform.</Narration>
  const emitted: number[] = []
  const owner: number[] = []
  for (let ti = 0; ti < index; ti++) for (const sy of tokens[ti].symbols) (emitted.push(sy), owner.push(ti))
  const done = index === tokens.length
  if (done) (emitted.push(EOB), owner.push(-1))

  let narration: ReactNode
  if (!t)
    narration = (
      <>
        The MTF output, {mtf.length} numbers. Runs of zeros will be written as their length in bijective base 2; every other value v becomes
        the symbol v + 1, leaving 0 and 1 for the run digits.
      </>
    )
  else if (t.run > 0) {
    const parts = t.symbols.map((sy, i) => `${sy === RUNA ? 1 : 2}·${2 ** i}`).join(' + ')
    narration = (
      <>
        A run of <b>{t.run}</b> zero{t.run > 1 ? 's' : ''}: {t.run} = {parts} → <b>{t.symbols.map(symLabel).join(' ')}</b> (RUNA = 1, RUNB =
        2, lowest digit first). {t.symbols.length} symbol{t.symbols.length > 1 ? 's' : ''} for {t.run} zero{t.run > 1 ? 's' : ''}.
      </>
    )
  } else
    narration = (
      <>
        MTF value <b>{t.value}</b> → symbol <b>{t.value + 1}</b>.
      </>
    )

  return (
    <>
      <Panel title="MTF output" aside={`${tokens.length} tokens`}>
        <div className="bwt-num">
          <Tape
            bytes={mtf}
            render={(i) => String(mtf[i])}
            mark={(i) => {
              const ti = tokOf[i]
              if (ti >= index) return 'dim'
              return (mtfClass(mtf[i]) ?? '') + (ti === index - 1 ? ' cur' : '')
            }}
          />
        </div>
      </Panel>
      <Panel title="Symbols for the entropy coder" aside={`${emitted.length} so far vs ${mtf.length} numbers in`}>
        <div className="bwt-num">
          <Tape
            bytes={emitted}
            render={(i) => (emitted[i] === EOB && owner[i] === -1 ? 'EOB' : symLabel(emitted[i]))}
            mark={(i) => (emitted[i] <= 1 ? 'hl-3' : owner[i] === -1 ? 'hl-2' : '') + (owner[i] === index - 1 ? ' cur' : '')}
          />
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          <span>
            <i className="hl-3" /> A / B = RUNA / RUNB
          </span>
          <span>
            <i className="hl-2" /> end of block
          </span>
        </div>
      </Panel>
      {done && (
        <Panel title="Then Huffman" aside={`${allSyms.length} symbols, alphabet of ${m + 2}`}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>symbol</th>
                  <th className="num">count</th>
                  <th className="num">
                    −log₂p <Help text="Ideal bits for this symbol. The codec rounds these to whole-bit Huffman code lengths." />
                  </th>
                </tr>
              </thead>
              <tbody>
                {hist
                  .map((c, sy) => ({ c, sy }))
                  .filter((x) => x.c > 0)
                  .sort((a, b) => b.c - a.c)
                  .slice(0, 10)
                  .map(({ c, sy }) => (
                    <tr key={sy}>
                      <td>{sy === EOB ? 'EOB' : sy === RUNA ? 'RUNA' : sy === 1 ? 'RUNB' : `${sy}  (MTF ${sy - 1})`}</td>
                      <td className="num">{c}</td>
                      <td className="num">{(-Math.log2(c / allSyms.length)).toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Entropy {fmt(symH, 2)} bits/symbol × {allSyms.length} symbols ≈ {Math.ceil(symH * allSyms.length)} bits for these {mtf.length} bytes
            ({fmt((symH * allSyms.length) / mtf.length, 2)} bits/byte).
          </p>
        </Panel>
      )}
      <Narration tone={done ? 'done' : undefined}>
        {narration}
        {done && <> Finally an end-of-block symbol, and the whole stream is Huffman-coded with one table.</>}
      </Narration>
    </>
  )
}
