import { useMemo, useState } from 'react'
import { byteCounts, entropy } from '../../lib/entropy'
import { buildTree, canonicalCodes, codedBits, kraft, limitedLengths, treeCodes, type HNode } from '../../lib/huffman'
import { toBin } from '../../lib/bits'
import { fmt, glyph } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { TreeView } from './TreeView'

type Mode = 'build' | 'encode' | 'decode'

/** The highlighter colour a symbol gets in the bitstream, cycling so neighbours differ. */
const spanClass = (k: number) => 'hl-' + ((k % 2) + 3)

export function Huffman() {
  const src = useSource('abra', 600)
  const [mode, setMode] = useState<Mode>('build')
  const [limit, setLimit] = useState(false)
  const [maxBits, setMaxBits] = useState(4)
  const [hoverSym, setHoverSym] = useState<number | null>(null)

  const data = src.bytes
  const hist = useMemo(() => byteCounts(data), [data])
  const build = useMemo(() => buildTree(hist), [hist])
  const codes = useMemo(() => treeCodes(build.root, 256), [build])
  const used = build.leaves.length
  const H = entropy(hist)
  const huffBits = codedBits(hist, build.lengths)
  const fixedWidth = Math.max(1, Math.ceil(Math.log2(Math.max(2, used))))
  const maxLen = Math.max(0, ...build.lengths)

  const minLimit = Math.max(1, Math.ceil(Math.log2(Math.max(2, used))))
  const cap = Math.max(minLimit, Math.min(maxBits, 15))
  const limited = useMemo(() => (limit && used > 0 ? limitedLengths(hist, cap) : null), [limit, hist, cap, used])
  const canonLengths = limited ?? build.lengths
  const canon = useMemo(() => canonicalCodes(canonLengths), [canonLengths])

  // ---- step counts per mode
  const buildStates = build.steps.length + 1
  const encodeStates = data.length + 1
  const decodeTrace = useMemo(() => traceDecode(build.root, codes, data), [build, codes, data])
  const decodeStates = decodeTrace.length

  const count = mode === 'build' ? buildStates : mode === 'encode' ? encodeStates : decodeStates
  const s = useStepper(count, { speed: mode === 'build' ? 2 : 6, resetKey: src.key + mode, startAtEnd: false })

  const symbolsByWeight = useMemo(
    () =>
      build.leaves
        .map((l) => l.symbol!)
        .sort((a, b) => hist[b] - hist[a] || build.lengths[a] - build.lengths[b] || a - b),
    [build, hist],
  )

  return (
    <Page
      slug="huffman"
      lede={
        <>
          <p>
            In 1951 David Huffman was given a choice by his professor, Robert Fano: sit the final, or find the most efficient binary code. Fano
            himself had not managed it. Huffman found that if you build the tree from the <b>bottom up</b> — always merging the two rarest things
            you have — the result is provably optimal among codes that give each symbol its own whole number of bits.
          </p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['abra', 'tobe', 'skew', 'dna', 'prose', 'json', 'banana']} maxBytes={600} />
            </Group>
            <Group title="Step through">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'build', label: 'Build tree' },
                  { value: 'encode', label: 'Encode' },
                  { value: 'decode', label: 'Decode' },
                ]}
              />
              <p className="small muted">
                {mode === 'build' && 'Each step takes the two lightest nodes in the queue and joins them under a new parent.'}
                {mode === 'encode' && 'Each step looks up one input byte and appends its path from the root.'}
                {mode === 'decode' && 'Each step reads one bit and moves one edge down the tree. A leaf emits a byte and jumps back to the root.'}
              </p>
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="symbols" value={used} help="Distinct byte values in the input — the leaves of the tree." />
                <Stat label="bits / symbol" value={data.length ? fmt(huffBits / data.length, 3) : '—'} tone="accent" help="Average Huffman code length, weighted by how often each symbol occurs." />
                <Stat label="entropy" value={fmt(H, 3)} help="Shannon's lower bound for any code that handles one symbol at a time: −Σ p·log₂p." />
                <Stat
                  label="redundancy"
                  value={data.length ? fmt(huffBits / data.length - H, 3) : '—'}
                  help="How far above the entropy the Huffman average is. It is always less than 1 bit, and it is zero only when every probability is a power of ½."
                />
              </Stats>
            </Group>
            <Group title="Length limit" help="Real formats cap how long a code may be — DEFLATE allows 15 bits, JPEG 16. The plain algorithm can exceed any cap on a skewed enough input.">
              <Toggle label="Cap code length" value={limit} onChange={setLimit} />
              <Slider
                label="max bits"
                value={cap}
                min={minLimit}
                max={Math.max(minLimit, Math.min(15, Math.max(maxLen, minLimit + 1)))}
                disabled={!limit}
                onChange={setMaxBits}
                help={`At least ⌈log₂ ${used}⌉ = ${minLimit} bits are needed to give ${used} symbols distinct codes.`}
              />
              {limit && limited && (
                <p className="small">
                  Package-merge: {codedBits(hist, limited)} bits vs {huffBits} unconstrained ({codedBits(hist, limited) - huffBits >= 0 ? '+' : ''}
                  {codedBits(hist, limited) - huffBits}).
                </p>
              )}
            </Group>
          </>
        }
      >
        {mode === 'build' && <BuildStage build={build} index={s.index} hist={hist} />}
        {mode === 'encode' && <EncodeStage data={data} codes={codes} root={build.root} index={s.index} hoverSym={hoverSym} setHoverSym={setHoverSym} />}
        {mode === 'decode' && <DecodeStage trace={decodeTrace} root={build.root} index={s.index} />}

        <Transport s={s} label={(i) => (mode === 'build' ? `merge ${i} / ${count - 1}` : mode === 'encode' ? `byte ${i} / ${count - 1}` : `bit ${i} / ${count - 1}`)} />

        <Panel title="Code table" aside={limit ? `canonical, capped at ${cap} bits` : 'tree codes and their canonical form'}>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>sym</th>
                  <th className="num">count</th>
                  <th className="num">p</th>
                  <th className="num">
                    −log₂p <Help text="The ideal code length for this symbol, in (fractional) bits. Huffman rounds each one to a whole number of bits, which is where its waste comes from." />
                  </th>
                  <th>tree code</th>
                  <th>
                    canonical <Help text="Same lengths, but codes re-assigned in a fixed order: shorter first, then by byte value. A decoder can rebuild these from the lengths alone, so a file only needs to store lengths." />
                  </th>
                  <th className="num">bits</th>
                </tr>
              </thead>
              <tbody>
                {symbolsByWeight.map((sym) => {
                  const p = hist[sym] / data.length
                  const L = canonLengths[sym]
                  const known = mode !== 'build' || s.atEnd
                  return (
                    <tr key={sym} className={hoverSym === sym ? 'on' : ''} onMouseEnter={() => setHoverSym(sym)} onMouseLeave={() => setHoverSym(null)}>
                      <td>
                        <span className="cell" style={{ height: 20, minWidth: 20 }}>
                          {glyph(sym)}
                        </span>
                      </td>
                      <td className="num">{hist[sym]}</td>
                      <td className="num">{p.toFixed(3)}</td>
                      <td className="num">{(-Math.log2(p)).toFixed(2)}</td>
                      <td>{known ? codes[sym] : <span className="muted">…</span>}</td>
                      <td>{known ? toBin(canon[sym], L) : <span className="muted">…</span>}</td>
                      <td className="num">{known ? hist[sym] * L : '…'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Kraft sum Σ2<sup>−len</sup> = {fmt(kraft(canonLengths), 4)}
            <Help text="For any prefix code, Σ 2^(−length) ≤ 1. Huffman codes always hit exactly 1: the tree is full, so no bit pattern is wasted." />
          </p>
        </Panel>

        <Panel title="How big is it">
          <SizeBars
            rows={[
              { label: '8 bits / byte', value: data.length * 8, tone: 'faint' },
              { label: `fixed ${fixedWidth}-bit`, value: data.length * fixedWidth, tone: 'faint', note: `⌈log₂ ${used}⌉ bits, no statistics` },
              { label: 'Huffman', value: limited ? codedBits(hist, limited) : huffBits },
              { label: 'entropy floor', value: H * data.length, tone: 'ink', note: 'no symbol-by-symbol code beats this' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Not counted: the table. A decoder needs the code lengths too — the bench’s Huffman format spends 128 bytes on them, which is why it
            loses on tiny inputs.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>The algorithm</h2>
        <Code>{`queue ← one leaf per symbol, weighted by its count
while queue has more than one node:
    a ← remove lightest            # ties: oldest first
    b ← remove lightest
    insert node(weight = a + b, left = a, right = b)
code(symbol) = the 0/1 path from the root to its leaf`}</Code>
        <p>
          The rarest symbols are merged first, so they end up deepest and get the longest codes. Every merge adds one bit to the code of every
          leaf underneath it, which is why the total coded length is simply the sum of the weights of every internal node — watch it in the build:
          each new parent’s weight is exactly the number of bits that merge costs.
        </p>
        <h2>Why it is optimal</h2>
        <p>
          Two facts do all the work. In an optimal tree the two least frequent symbols can always be made siblings at the deepest level (swapping
          a deeper, commoner symbol up can only shorten the total). And merging those two into one symbol of their combined weight leaves a
          smaller problem whose optimal tree, expanded back, is optimal for the original. Induction finishes it.
        </p>
        <p>
          “Optimal” has a fine print: among codes that spend a <b>whole number of bits on each symbol</b>, considered one at a time. A symbol with
          probability 0.9 ideally costs 0.15 bits, but Huffman cannot spend less than 1. Try the <i>Skewed</i> sample: the redundancy is large,
          and it is exactly the gap <a href="#/arithmetic">arithmetic coding</a> closes. Huffman is perfect only when every probability is a power
          of ½.
        </p>
        <h2>Prefix codes and decoding</h2>
        <p>
          No code is a prefix of another, because symbols only live at leaves. That is what lets the decoder read a bitstream with no separators:
          walk down from the root, one edge per bit, and the moment you land on a leaf you know the symbol is complete. Real decoders do not walk;
          they look up the next 9 or 10 bits in a table at once and get the symbol and its length in one step.
        </p>
        <h2>Canonical codes</h2>
        <p>
          The tree shape is not unique — swapping any node’s children gives an equally good code — so formats throw the shape away and keep only
          the lengths. Codes are then handed out in a fixed order: by length, then by symbol value, each one the previous plus one (shifted left
          when the length grows). This is RFC 1951 §3.2.2, and it is why a DEFLATE block header is a list of lengths, not a tree. JPEG, PNG,
          bzip2, Zstandard and Brotli all do the same.
        </p>
        <h2>Length limits</h2>
        <p>
          A Fibonacci-shaped histogram makes Huffman produce a code as long as the alphabet is wide. Formats cap the length so decoders can use
          fixed-size tables. The optimal fix is <b>package-merge</b> (Larmore &amp; Hirschberg, 1990), which this page uses when you switch the
          cap on; zlib instead uses a quick heuristic that shuffles leaves between levels, which is almost always as good.
        </p>
        <div className="aside">
          Where it ships: DEFLATE (ZIP, gzip, PNG), JPEG’s baseline entropy coder, MP3’s spectral data, bzip2’s final stage, and as the “literal”
          coder in Zstandard and Brotli.
        </div>
      </Notes>
    </Page>
  )
}

// --------------------------------------------------------------- build stage

function BuildStage({ build, index, hist }: { build: ReturnType<typeof buildTree>; index: number; hist: number[] }) {
  const { steps, nodes, root } = build
  if (!root) return <Narration>Type something to build a tree from.</Narration>

  const queueIds = index < steps.length ? steps[index].queue : [root.id]
  const roots = queueIds.map((id) => nodes[id])
  const just = index > 0 ? steps[index - 1] : null
  const hot = new Set<number>(just ? [just.parent.id, just.a.id, just.b.id] : [])
  const pending = new Set<number>(index < steps.length ? [steps[index].a.id, steps[index].b.id] : [])
  // Bits paid so far = Σ weights of internal nodes created.
  let paid = 0
  for (let k = 0; k < index; k++) paid += steps[k].parent.weight

  const label = (n: HNode) => (n.symbol !== undefined ? `‘${glyph(n.symbol)}’ (${n.weight})` : `a ${n.weight}-node`)

  return (
    <>
      <Panel title={index < steps.length ? `The queue — ${roots.length} trees` : 'The tree'} aside={`bits paid so far: ${paid}`}>
        <TreeView roots={roots} hot={hot} pending={pending} showBits={index === steps.length} />
      </Panel>
      <Narration tone={index === steps.length ? 'done' : undefined}>
        {index === 0 && steps.length > 0 && (
          <>
            Start with one leaf per symbol, lightest first. The two dashed ones — {label(steps[0].a)} and {label(steps[0].b)} — are the rarest and
            will be merged first.
          </>
        )}
        {index === 0 && steps.length === 0 && <>Only one distinct symbol: it gets a 1-bit code by convention, and there is nothing to merge.</>}
        {just && index < steps.length && (
          <>
            Merged {label(just.a)} and {label(just.b)} into a node of weight <b>{just.parent.weight}</b>. Every symbol beneath it just got one bit
            longer — {just.parent.weight} more bits in total. Next: {label(steps[index].a)} and {label(steps[index].b)}.
          </>
        )}
        {index === steps.length && steps.length > 0 && (
          <>
            One tree left. Its internal weights sum to <b>{paid}</b> bits — exactly Σ count × code length ={' '}
            {codedBits(hist, build.lengths)}. Edges are labelled: left is 0, right is 1.
          </>
        )}
      </Narration>
    </>
  )
}

// -------------------------------------------------------------- encode stage

function pathTo(root: HNode | null, sym: number): number[] {
  const out: number[] = []
  const go = (n: HNode): boolean => {
    out.push(n.id)
    if (n.symbol === sym) return true
    if (n.left && go(n.left)) return true
    if (n.right && go(n.right)) return true
    out.pop()
    return false
  }
  if (root) go(root)
  return out
}

function EncodeStage({
  data,
  codes,
  root,
  index,
  hoverSym,
  setHoverSym,
}: {
  data: Uint8Array
  codes: string[]
  root: HNode | null
  index: number
  hoverSym: number | null
  setHoverSym: (s: number | null) => void
}) {
  const [hoverSpan, setHoverSpan] = useState<number | null>(null)
  const cur = index > 0 ? data[index - 1] : null
  const focus = hoverSpan !== null ? data[hoverSpan] : hoverSym ?? cur
  let bits = ''
  const spans: { start: number; length: number; className: string; title: string }[] = []
  for (let i = 0; i < index; i++) {
    const c = codes[data[i]]
    spans.push({ start: bits.length, length: c.length, className: spanClass(i), title: `‘${glyph(data[i])}’ → ${c}` })
    bits += c
  }
  return (
    <>
      <Panel title="Input" aside={`${index} of ${data.length} bytes encoded`}>
        <Tape
          bytes={data}
          mark={(i) => (i === hoverSpan ? 'cur hl-1' : i === index - 1 ? 'cur ' + spanClass(i) : i < index ? spanClass(i) : 'dim')}
          onHover={(i) => setHoverSym(i === null ? null : data[i])}
        />
      </Panel>
      <Panel title="Tree" aside={focus !== null ? `‘${glyph(focus)}’ = ${codes[focus]}` : ''}>
        <TreeView roots={root ? [root] : []} path={focus !== null ? pathTo(root, focus) : undefined} onHoverSymbol={setHoverSym} />
      </Panel>
      <Panel title="Output bits" aside={`${bits.length} bits vs ${index * 8} as bytes`}>
        <BitRow bits={bits} spans={spans} active={hoverSpan ?? undefined} onHover={setHoverSpan} />
      </Panel>
      <Narration tone={index === data.length && index > 0 ? 'done' : undefined}>
        {index === 0 ? (
          <>Step forward to encode the first byte. Each one is replaced by its path from the root.</>
        ) : (
          <>
            ‘<b>{glyph(cur!)}</b>’ → <code>{codes[cur!]}</code> ({codes[cur!].length} bit{codes[cur!].length === 1 ? '' : 's'} instead of 8).
            {index === data.length && <> Done: {bits.length} bits, {fmt(bits.length / data.length, 3)} per byte.</>}
          </>
        )}
      </Narration>
    </>
  )
}

// -------------------------------------------------------------- decode stage

interface DecodeState {
  bitIndex: number
  /** Path from root to the current node (ids). */
  path: number[]
  out: number[]
  emitted: number | null
}

function traceDecode(root: HNode | null, codes: string[], data: Uint8Array): DecodeTrace {
  const bits = Array.from(data, (b) => codes[b]).join('')
  const states: DecodeState[] = [{ bitIndex: 0, path: root ? [root.id] : [], out: [], emitted: null }]
  const result = { bits, states, length: 0 }
  const done = () => ((result.length = states.length), result)
  if (!root) return done()
  // Single-symbol tree: every '0' bit is a symbol.
  if (root.symbol !== undefined) {
    const out: number[] = []
    for (let i = 0; i < bits.length; i++) {
      out.push(root.symbol)
      states.push({ bitIndex: i + 1, path: [root.id], out: out.slice(), emitted: root.symbol })
    }
    return done()
  }
  let node = root
  let path = [root.id]
  const out: number[] = []
  for (let i = 0; i < bits.length; i++) {
    node = bits[i] === '0' ? node.left! : node.right!
    path = path.concat(node.id)
    let emitted: number | null = null
    if (node.symbol !== undefined) {
      out.push(node.symbol)
      emitted = node.symbol
    }
    states.push({ bitIndex: i + 1, path, out: out.slice(), emitted })
    if (emitted !== null) {
      node = root
      path = [root.id]
    }
  }
  return done()
}

interface DecodeTrace {
  bits: string
  states: DecodeState[]
  length: number
}

function DecodeStage({ trace, root, index }: { trace: DecodeTrace; root: HNode | null; index: number }) {
  const st = trace.states[Math.min(index, trace.states.length - 1)]
  const total = trace.states.length - 1
  const allBits = trace.bits
  const spans = [
    { start: 0, length: st.bitIndex, className: 'hl-3', title: 'consumed' },
    ...(st.bitIndex < allBits.length ? [{ start: st.bitIndex, length: 1, className: 'hl-1', title: 'next bit' }] : []),
  ]
  return (
    <>
      <Panel title="Input bits" aside={`${st.bitIndex} of ${total} read`}>
        <BitRow bits={allBits} spans={spans} active={1} />
      </Panel>
      <Panel title="Tree">
        <TreeView roots={root ? [root] : []} path={st.path} />
      </Panel>
      <Panel title="Output" aside={`${st.out.length} bytes`}>
        <Tape bytes={st.out} mark={(i) => (i === st.out.length - 1 && st.emitted !== null ? 'cur hl-3' : undefined)} />
      </Panel>
      <Narration tone={index === total && total > 0 ? 'done' : undefined}>
        {index === 0 ? (
          <>The decoder starts at the root. Each bit says which way to go: 0 left, 1 right.</>
        ) : st.emitted !== null ? (
          <>
            Read <code>{allBits[st.bitIndex - 1]}</code> and landed on a leaf: emit ‘<b>{glyph(st.emitted)}</b>’ and jump back to the root. No
            separator was needed — no code is a prefix of another.
          </>
        ) : (
          <>
            Read <code>{allBits[st.bitIndex - 1]}</code>, moved {allBits[st.bitIndex - 1] === '0' ? 'left' : 'right'}. Still on an internal node,
            so the symbol is not finished yet.
          </>
        )}
      </Narration>
    </>
  )
}
