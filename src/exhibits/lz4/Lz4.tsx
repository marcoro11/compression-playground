import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SAMPLES, sampleBytes } from '../../lib/samples'
import { fmt, glyph, hex2, int } from '../../lib/text'
import { useStepper } from '../../lib/useStepper'
import { Button, Group, Help, Segmented, SizeBars, Slider, Stat, Stats, Toggle } from '../../ui/Controls'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { deflateCodec } from '../deflate/codec'
import { lzssEncode } from '../lz77/codec'
import { Strip } from '../lz77/Strip'
import '../lz77/lz77.css'
import {
  BLOCK_SIZES,
  LASTLITERALS,
  MFLIMIT,
  compressBlock,
  compressFrame,
  decompressBlock,
  decompressBlockFast,
  decompressFrame,
  type DecodeOp,
  type FrameField,
  type Mode,
  type SeqLayout,
  type Sequence,
} from './lz4'
import './lz4.css'

type View = 'encode' | 'decode' | 'frame'
type Field = 'token' | 'litExt' | 'lits' | 'off' | 'mlExt'

const FIELD_CLASS: Record<Field, string> = { token: 'hl-6', litExt: 'hl-3', lits: 'hl-2', off: 'hl-1', mlExt: 'hl-4' }
const FIELD_NAME: Record<Field, string> = { token: 'token', litExt: 'literal-length bytes', lits: 'literals', off: 'offset', mlExt: 'match-length bytes' }
const FRAME_CLASS: Record<FrameField['kind'], string> = {
  magic: 'hl-6',
  flg: 'hl-4',
  bd: 'hl-4',
  csize: 'hl-4',
  hc: 'hl-3',
  bsize: 'hl-1',
  block: 'hl-2',
  raw: 'hl-5',
  bcheck: 'hl-3',
  end: 'hl-1',
  ccheck: 'hl-3',
}

const PRESETS = [
  { label: 'overlap: abcabc…', text: 'abcabcabcabcabcabcabcabcabcabcXYZ12' },
  { label: 'long run', text: 'a'.repeat(300) + 'bcdefgh' },
  { label: 'no repeats', text: 'The quick brown fox jumps over the lazy dog.' },
]

/** Which field of which sequence each block byte belongs to. */
function fieldMap(layout: SeqLayout[], total: number): { field: Field[]; seq: number[] } {
  const field = new Array<Field>(total)
  const seq = new Array<number>(total)
  layout.forEach((l, k) => {
    const set = (a: number, b: number, f: Field) => {
      for (let i = a; i < b; i++) {
        field[i] = f
        seq[i] = k
      }
    }
    set(l.token, l.token + 1, 'token')
    set(l.litExt[0], l.litExt[1], 'litExt')
    set(l.lits[0], l.lits[1], 'lits')
    if (l.off >= 0) set(l.off, l.off + 2, 'off')
    set(l.mlExt[0], l.mlExt[1], 'mlExt')
  })
  return { field, seq }
}

function q(bytes: ArrayLike<number>, from: number, len: number, max = 20): string {
  let s = ''
  for (let i = 0; i < Math.min(len, max); i++) s += glyph(bytes[from + i])
  return '‘' + s + (len > max ? '…' : '') + '’'
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** A run-length extension spelled out: 285 → "255 + 30". */
function extText(v: number): string {
  const parts: number[] = []
  while (v >= 255) {
    parts.push(255)
    v -= 255
  }
  parts.push(v)
  return parts.join(' + ')
}

export function Lz4() {
  const src = useSource('prose', 1500)
  const [view, setView] = useState<View>('encode')
  const [parser, setParser] = useState<Mode>('fast')
  const [accel, setAccel] = useState(1)
  const [depth, setDepth] = useState(64)
  const [blockSizeId, setBlockSizeId] = useState<4 | 5 | 6 | 7>(4)
  const [contentChecksum, setContentChecksum] = useState(true)
  const [blockChecksum, setBlockChecksum] = useState(false)

  const data = src.bytes
  const opts = useMemo(() => ({ mode: parser, acceleration: accel, depth }), [parser, accel, depth])
  const block = useMemo(() => compressBlock(data, opts), [data, opts])
  const map = useMemo(() => fieldMap(block.layout, block.bytes.length), [block])
  const ops = useMemo(() => {
    const t: DecodeOp[] = []
    decompressBlock(block.bytes, [], t)
    return t
  }, [block])
  const frame = useMemo(() => compressFrame(data, { ...opts, blockSizeId, contentChecksum, blockChecksum }), [data, opts, blockSizeId, contentChecksum, blockChecksum])

  const count = view === 'encode' ? block.seqs.length + 1 : view === 'decode' ? ops.length + 1 : frame.fields.length + 1
  const s = useStepper(count, { speed: view === 'decode' ? 4 : 2, resetKey: src.key + view + JSON.stringify(opts) + blockSizeId + contentChecksum + blockChecksum })

  const matched = block.seqs.reduce((a, q) => a + q.matchLen, 0)
  const matches = block.seqs.filter((q) => q.matchLen).length

  const compare = useMemo(() => {
    const hc = parser === 'hc' ? block.bytes.length : compressBlock(data, { mode: 'hc', depth: 64 }).bytes.length
    const fast = parser === 'fast' ? block.bytes.length : compressBlock(data, { mode: 'fast' }).bytes.length
    return { hc, fast, lzss: lzssEncode(data).length - 4, deflate: deflateCodec.encode(data).length }
  }, [data, block, parser])

  return (
    <Page
      slug="lz4"
      lede={
        <>
          <p>
            Every other dictionary coder on this site spends its effort on the <i>size</i> of the output. LZ4 spends it on the <b>decoder</b>. Its
            output is a plain list of sequences — some literal bytes, then “go back <i>this far</i>, copy <i>this many</i>” — with every field a
            whole byte, no Huffman, no bit reader, nothing to look up. A CPU decodes it about as fast as it can copy memory.
          </p>
          <p>The price is ratio. This page shows exactly what is given up, and why the trade is so often worth it.</p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['prose', 'json', 'tobe', 'runs', 'dna', 'random']} maxBytes={1500} />
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
                value={view}
                onChange={setView}
                options={[
                  { value: 'encode', label: 'Encode' },
                  { value: 'decode', label: 'Decode' },
                  { value: 'frame', label: 'Frame' },
                ]}
              />
              <p className="small muted">
                {view === 'encode' && 'Each step is one sequence: some literals, then one match.'}
                {view === 'decode' && 'Each step reads one field of the block and does what it says.'}
                {view === 'frame' && 'Each step is one field of the .lz4 file wrapped around the blocks.'}
              </p>
            </Group>
            <Group title="Encoder" help="Both encoders write the same format; the decoder cannot tell them apart. They differ only in how hard they look for matches.">
              <Segmented
                value={parser}
                onChange={setParser}
                options={[
                  { value: 'fast', label: 'LZ4 (fast)', title: 'one hash slot per 4-byte value, no chains' },
                  { value: 'hc', label: 'LZ4 HC', title: 'hash chains: compare many earlier positions' },
                ]}
              />
              {parser === 'fast' ? (
                <Slider
                  label="acceleration"
                  value={accel}
                  min={1}
                  max={32}
                  onChange={setAccel}
                  help="After every 64 × acceleration misses the search step grows by one, so the encoder skips faster through data that is not matching. 1 is LZ4's default; bigger trades ratio for speed."
                />
              ) : (
                <Slider label="chain depth" value={depth} min={1} max={256} onChange={setDepth} help="How many earlier positions with the same 4-byte hash HC compares before taking the longest match." />
              )}
            </Group>
            {view === 'frame' && (
              <Group title="Frame options">
                <Segmented
                  label="max block size"
                  value={blockSizeId}
                  onChange={setBlockSizeId}
                  options={[
                    { value: 4, label: '64K' },
                    { value: 5, label: '256K' },
                    { value: 6, label: '1M' },
                    { value: 7, label: '4M' },
                  ]}
                />
                <Toggle label="content checksum" value={contentChecksum} onChange={setContentChecksum} help="XXH32 of the whole original, appended after the end mark." />
                <Toggle label="block checksums" value={blockChecksum} onChange={setBlockChecksum} help="XXH32 of each stored block, after the block." />
              </Group>
            )}
            <Group title="Result">
              <Stats>
                <Stat label="sequences" value={block.seqs.length} sub={`${matches} with a match`} />
                <Stat label="block" value={int(block.bytes.length)} sub={`bytes, from ${int(data.length)}`} tone="accent" />
                <Stat label="matched" value={data.length ? fmt((100 * matched) / data.length, 0) + '%' : '—'} sub="of the input copied" />
                <Stat label="avg match" value={matches ? fmt(matched / matches, 1) : '—'} sub="bytes" help="LZ4's shortest match is 4 bytes: a match always costs at least 3 bytes (token + offset), so anything shorter would not pay." />
              </Stats>
            </Group>
          </>
        }
      >
        {view === 'encode' && <EncodeStage data={data} block={block} map={map} index={s.index} onSeq={(k) => s.setIndex(k + 1)} parser={parser} accel={accel} />}
        {view === 'decode' && <DecodeStage block={block} map={map} ops={ops} index={s.index} />}
        {view === 'frame' && <FrameStage frame={frame} index={s.index} n={data.length} />}

        <Transport
          s={s}
          label={(i) => (view === 'encode' ? `sequence ${i} / ${count - 1}` : view === 'decode' ? `field ${i} / ${count - 1}` : `field ${i} / ${count - 1}`)}
        />

        <Panel title="How big is it" aside="bytes, block contents only">
          <SizeBars
            unit="bytes"
            rows={[
              { label: 'input', value: data.length, tone: 'faint' },
              { label: 'LZ4 fast', value: compare.fast },
              { label: 'LZ4 HC', value: compare.hc },
              { label: 'LZSS (bit-packed)', value: compare.lzss, tone: 'faint', note: 'flag bits, 4 KiB window' },
              { label: 'DEFLATE', value: compare.deflate, tone: 'ink', note: '+ Huffman coding' },
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            DEFLATE finds similar matches and then Huffman-codes them; LZ4 writes them as bytes. That difference — entropy coding — is most of the
            gap, and it is exactly the part that makes decoding slow.
          </p>
        </Panel>

        <SpeedPanel />
      </Bench>

      <Notes>
        <h2>The block format</h2>
        <Code>{`sequence := token  [literal-length bytes]  literals  offset(2, LE)  [match-length bytes]
token    := LLLL MMMM        LLLL = literal length    MMMM = match length − 4
            15 in either nibble means “more follows”: add bytes until one is not 255

last sequence: token, literals — and stop (no offset, no match)`}</Code>
        <p>
          That is the entire format. A literal run of 300 is <code>F0 FF 1E</code> (15, then 255 + 30); a match of 284 bytes is the low nibble 15 plus
          <code>FF 0A</code>. The offset is two bytes, so the window is 64 KiB, and a match is never shorter than 4: token plus offset already
          cost 3 bytes.
        </p>
        <h2>Why it decodes so fast</h2>
        <ul>
          <li>
            <b>Byte-aligned.</b> There is no bit reader, no shifting and masking, no Huffman table to build or consult. Every field starts on a byte
            boundary and is used as it is.
          </li>
          <li>
            <b>Wild copies.</b> A real decoder copies literals and matches 8 or 16 bytes at a time, even when only 5 are needed, and simply carries on
            from the right place. That turns a byte loop into a few wide loads and stores — and it is why the format has <b>end-of-block rules</b>: the
            last {LASTLITERALS} bytes are always literals, and no match starts within {MFLIMIT} bytes of the end, so an over-long copy can never run
            off the end of the buffer.
          </li>
          <li>
            <b>Short overlaps are special-cased.</b> A copy with offset 1–7 overlaps what it is writing (offset 1 is a run of one byte); the decoder
            widens the pattern first so the fast 8-byte copy still works.
          </li>
          <li>
            <b>Predictable branches.</b> One branch per sequence (“is the length 15?”) that almost always goes the same way.
          </li>
        </ul>
        <p>
          Native LZ4 decodes at several gigabytes per second per core, often faster than the disk or network feeding it — at which point compressing
          makes reading <i>faster</i>, not slower. The speed panel above measures this page’s JavaScript, which is far slower than native, but the
          ratio between the two decoders is the same story.
        </p>
        <h2>The encoder: one guess per position</h2>
        <p>
          The fast encoder keeps a table of 4 096 slots, each holding the last position whose next 4 bytes hashed there. At each position it looks in
          one slot. If the 4 bytes really match, it extends the match forwards (and a little backwards over pending literals); if not, it moves on —
          and after every 64 misses it moves on by one more byte at a time, so incompressible data is skimmed rather than searched. That is the{' '}
          <i>acceleration</i> knob. <b>LZ4 HC</b> keeps hash chains instead and compares dozens of candidates per position; it compresses several
          times slower and decodes at exactly the same speed, which makes it the right choice for data written once and read many times.
        </p>
        <h2>The frame format</h2>
        <p>
          A <code>.lz4</code> file wraps blocks in a frame: the magic number <code>04 22 4D 18</code>, a flag byte, a block-size byte, a one-byte
          header checksum (the second byte of the XXH32 of the descriptor), then each block preceded by its size — high bit set if it was stored
          raw because compressing did not help — a zero end mark, and optionally an XXH32 of the whole content. Blocks can be <i>independent</i> or{' '}
          <i>linked</i>, where a match may reach back into the previous block; linked compresses a little better, independent can be decoded in
          parallel.
        </p>
        <h2>History and where it ships</h2>
        <p>
          Yann Collet published LZ4 in 2011, the same year Google open-sourced <b>Snappy</b>, which makes the same bet with a slightly different byte
          layout. LZ4 is in the Linux kernel (zram swap, SquashFS, btrfs), is the default compression in ZFS, and moves data in Kafka, Cassandra,
          Hadoop, RocksDB and countless game engines streaming assets from disk. Collet’s next project was <a href="#/zstd">Zstandard</a>: at its
          fastest levels it competes with LZ4 on speed while adding the entropy coding LZ4 leaves out.
        </p>
        <div className="aside">
          Checked against the reference: during development every block and frame this page writes was decoded by liblz4 1.9.4, and the test
          suite decodes frames and blocks liblz4 wrote, including a frame whose blocks are linked.
        </div>
      </Notes>
    </Page>
  )
}

// ------------------------------------------------------------------ encode

function TokenView({ token, litLen, matchLen, last }: { token: number; litLen: number; matchLen: number; last: boolean }) {
  const bits = token.toString(2).padStart(8, '0').split('')
  const hi = token >>> 4
  const lo = token & 15
  return (
    <div className="lz4-token-byte" title={`token 0x${hex2(token)}`}>
      {bits.map((b, i) => (
        <span key={i} className={i < 4 ? 'hi' : 'lo'}>
          {b}
        </span>
      ))}
      <small>
        lit {hi}
        {hi === 15 ? '+' : ''} → {litLen}
      </small>
      <small>{last ? 'unused' : `${lo}${lo === 15 ? '+' : ''} + 4 → ${matchLen}`}</small>
    </div>
  )
}

function SeqTable({ bytes, l, seq, data }: { bytes: Uint8Array; l: SeqLayout; seq: Sequence; data: Uint8Array }) {
  const row = (f: Field, a: number, b: number, meaning: ReactNode) =>
    b > a && (
      <tr key={f}>
        <td>
          <span className={'lz4-chip ' + FIELD_CLASS[f]}>{FIELD_NAME[f]}</span>
        </td>
        <td className="bytes">
          {Array.from(bytes.subarray(a, Math.min(b, a + 12)), hex2).join(' ')}
          {b - a > 12 && ` … (${b - a})`}
        </td>
        <td style={{ whiteSpace: 'normal' }}>{meaning}</td>
      </tr>
    )
  const last = !seq.matchLen
  return (
    <div className="table-wrap lz4-fields">
      <table className="data">
        <thead>
          <tr>
            <th>field</th>
            <th>bytes</th>
            <th>meaning</th>
          </tr>
        </thead>
        <tbody>
          {row('token', l.token, l.token + 1, last ? `${seq.litLen} literals, no match` : `${Math.min(seq.litLen, 15)} | ${Math.min(seq.matchLen - 4, 15)}`)}
          {row('litExt', l.litExt[0], l.litExt[1], `15 + ${extText(seq.litLen - 15)} = ${seq.litLen}`)}
          {row('lits', l.lits[0], l.lits[1], q(data, seq.litStart, seq.litLen))}
          {!last && row('off', l.off, l.off + 2, `${seq.offset} back (little-endian)`)}
          {!last && row('mlExt', l.mlExt[0], l.mlExt[1], `4 + 15 + ${extText(seq.matchLen - 19)} = ${seq.matchLen}`)}
        </tbody>
      </table>
    </div>
  )
}

function BlockHex({
  bytes,
  map,
  mark,
  onClick,
}: {
  bytes: Uint8Array
  map: { field: Field[]; seq: number[] }
  mark: (i: number) => string
  onClick?: (seq: number) => void
}) {
  const cap = 1200
  const shown = bytes.length > cap ? bytes.subarray(0, cap) : bytes
  return (
    <>
      <div className="lz4-hex">
        <Tape
          bytes={shown}
          render={(i) => hex2(bytes[i])}
          mark={(i) => FIELD_CLASS[map.field[i]] + ' ' + mark(i)}
          cellTitle={(i) => `byte ${i}: ${FIELD_NAME[map.field[i]]} of sequence ${map.seq[i]}`}
          onClick={onClick ? (i) => onClick(map.seq[i]) : undefined}
        />
        {bytes.length > cap && <p className="small muted">… and {int(bytes.length - cap)} more bytes</p>}
      </div>
      <div className="legend lz4-legend" style={{ marginTop: 8 }}>
        {(Object.keys(FIELD_CLASS) as Field[]).map((f) => (
          <span key={f}>
            <i className={FIELD_CLASS[f]} /> {FIELD_NAME[f]}
          </span>
        ))}
      </div>
    </>
  )
}

function EncodeStage({
  data,
  block,
  map,
  index,
  onSeq,
  parser,
  accel,
}: {
  data: Uint8Array
  block: ReturnType<typeof compressBlock>
  map: { field: Field[]; seq: number[] }
  index: number
  onSeq: (k: number) => void
  parser: Mode
  accel: number
}) {
  const k = index - 1
  const cur = k >= 0 ? block.seqs[k] : null
  const l = k >= 0 ? block.layout[k] : null
  const owner = useMemo(() => {
    // For each input byte: which sequence, and literal or match.
    const seq = new Int32Array(data.length)
    const lit = new Uint8Array(data.length)
    block.seqs.forEach((q, j) => {
      for (let i = q.litStart; i < q.litStart + q.litLen; i++) {
        seq[i] = j
        lit[i] = 1
      }
      const m = q.litStart + q.litLen
      for (let i = m; i < m + q.matchLen; i++) seq[i] = j
    })
    return { seq, lit }
  }, [data, block])

  const mStart = cur ? cur.litStart + cur.litLen : 0
  const arc = cur && cur.matchLen ? { src: mStart - cur.offset, dst: mStart, len: cur.matchLen, label: `back ${cur.offset}, copy ${cur.matchLen}` } : null
  const mark = (i: number) => {
    if (!cur) return 'future'
    const j = owner.seq[i]
    if (j > k) {
      if (cur.matchLen && i >= mStart - cur.offset && i < mStart - cur.offset + cur.matchLen) return 'hl-1'
      return 'future'
    }
    if (j === k) {
      if (owner.lit[i]) return 'hl-2'
      return 'hl-5'
    }
    if (cur.matchLen && i >= mStart - cur.offset && i < mStart - cur.offset + cur.matchLen) return 'hl-1'
    return owner.lit[i] ? 'lz4-past-lit' : 'lz4-past-match'
  }
  const written = l ? l.end : 0

  let story: ReactNode
  if (!cur) {
    story = (
      <>
        The encoder walks the input looking for 4-byte strings it has seen in the last 64 KiB. Everything it cannot match piles up as literals until
        the next match is found; then one sequence is written for the pile and the match together. Step forward.
      </>
    )
  } else if (!cur.matchLen) {
    story = (
      <>
        The last sequence: {plural(cur.litLen, 'literal')} {q(data, cur.litStart, cur.litLen)} and no match. A block always ends this way — the
        final {LASTLITERALS} bytes must be literals and no match may start in the last {MFLIMIT}, so a decoder’s wide copies can never overrun the
        buffer. Token <code>0x{hex2((Math.min(cur.litLen, 15) << 4) & 0xff)}</code>: only the high nibble counts.
        {data.length < MFLIMIT + 1 && <> (Inputs under {MFLIMIT + 1} bytes are never searched at all.)</>} Block total: {block.bytes.length} bytes
        for {data.length}.
      </>
    )
  } else {
    const ml = cur.matchLen - 4
    story = (
      <>
        {cur.litLen ? (
          <>
            {plural(cur.litLen, 'literal')} {q(data, cur.litStart, cur.litLen)}, then a
          </>
        ) : (
          <>No literals — straight into a</>
        )}{' '}
        match of <b>{cur.matchLen}</b> bytes from <b>{cur.offset}</b> back
        {cur.offset < cur.matchLen && <> — it overlaps what it is writing, so a {plural(cur.offset, 'byte')} pattern repeats</>}. Token{' '}
        <code>0x{hex2(block.bytes[l!.token])}</code> holds {Math.min(cur.litLen, 15)} and {Math.min(ml, 15)}
        {(cur.litLen >= 15 || ml >= 15) && <>; 15 means “keep reading length bytes”</>}. This sequence costs {l!.end - l!.token} bytes for{' '}
        {cur.litLen + cur.matchLen}.{' '}
        {parser === 'fast' ? (
          <>
            Found on hash probe {cur.probes}
            {cur.probes > 64 * accel && <> — after {64 * accel} misses the search began stepping faster</>}
            {cur.backtrack > 0 && <>, then stretched {plural(cur.backtrack, 'byte')} backwards over pending literals</>}.
          </>
        ) : (
          <>HC compared {plural(cur.probes, 'candidate')} at this position and kept the longest.</>
        )}
      </>
    )
  }

  return (
    <>
      <Panel title="Input" aside={cur ? `sequence ${k} · bytes ${cur.litStart}–${mStart + cur.matchLen - 1}` : `${data.length} bytes`}>
        <Strip bytes={data} mark={mark} arc={arc} focus={arc ? Math.round((arc.src + arc.dst + arc.len) / 2) : cur ? mStart : 0} onCellClick={(i) => onSeq(owner.seq[i])} />
        <div className="legend" style={{ marginTop: 6 }}>
          <span>
            <i className="hl-2" /> literals
          </span>
          <span>
            <i className="hl-5" /> match (copied)
          </span>
          <span>
            <i className="hl-1" /> where it is copied from
          </span>
        </div>
      </Panel>
      {cur && l && (
        <Panel title="This sequence, byte by byte">
          <div className="lz4-token">
            <TokenView token={block.bytes[l.token]} litLen={cur.litLen} matchLen={cur.matchLen} last={!cur.matchLen} />
            <SeqTable bytes={block.bytes} l={l} seq={cur} data={data} />
          </div>
        </Panel>
      )}
      <Narration tone={cur && !cur.matchLen ? 'done' : undefined}>{story}</Narration>
      <Panel title="The block" aside={`${written} of ${block.bytes.length} bytes written · click a byte`}>
        <BlockHex bytes={block.bytes} map={map} mark={(i) => (i >= written ? 'future' : map.seq[i] === k ? 'cur' : '')} onClick={onSeq} />
      </Panel>
    </>
  )
}

// ------------------------------------------------------------------ decode

function DecodeStage({ block, map, ops, index }: { block: ReturnType<typeof compressBlock>; map: { field: Field[]; seq: number[] }; ops: DecodeOp[]; index: number }) {
  const op = index > 0 ? ops[index - 1] : null
  const outLen = op ? op.out[1] : 0
  const out = useMemo(() => Uint8Array.from(decompressBlock(block.bytes)), [block])
  const read = op ? op.inp[1] : 0
  const curSeq = op?.seq ?? -1
  const seqOps = op ? ops.filter((o) => o.seq === op.seq) : []
  const lit = seqOps.find((o) => o.kind === 'lits')
  const copy = seqOps.find((o) => o.kind === 'copy')

  let story: ReactNode = <>The decoder holds nothing but a read position in the block and the output so far. Step forward.</>
  if (op) {
    const t = block.bytes[block.layout[op.seq].token]
    switch (op.kind) {
      case 'token':
        story = (
          <>
            Token <code>0x{hex2(t)}</code> for sequence {op.seq}: high nibble <b>{t >>> 4}</b> literal{t >>> 4 === 1 ? '' : 's'}
            {t >>> 4 === 15 && ' (and more to come)'}, low nibble <b>{t & 15}</b> → a match of {(t & 15) + 4}
            {(t & 15) === 15 && ' or more'} — if a match follows at all.
          </>
        )
        break
      case 'litExt':
        story = (
          <>
            The literal nibble was 15, so length bytes follow: 15 + {extText(op.litLen! - 15)} = <b>{op.litLen}</b>. A 255 means “add and keep
            reading”; anything smaller ends the count.
          </>
        )
        break
      case 'lits':
        story =
          op.litLen === 0 ? (
            <>No literals in this sequence.</>
          ) : (
            <>
              Copy {plural(op.litLen!, 'literal')} straight from the block to the output: {q(out, op.out[0], op.litLen!)}. No decoding — the
              bytes are the bytes.
              {op.inp[1] === block.bytes.length && <> That was the end of the block, so this was the last sequence: done.</>}
            </>
          )
        break
      case 'offset':
        story = (
          <>
            Two bytes <code>
              {hex2(block.bytes[op.inp[0]])} {hex2(block.bytes[op.inp[0] + 1])}
            </code>{' '}
            → offset <b>{op.offset}</b>, little-endian: the match starts {op.offset} bytes back from the end of the output.
          </>
        )
        break
      case 'mlExt':
        story = (
          <>
            The match nibble was 15, so length bytes follow: 4 + 15 + {extText(op.matchLen! - 19)} = <b>{op.matchLen}</b>.
          </>
        )
        break
      case 'copy':
        story = (
          <>
            Copy {op.matchLen} bytes from {op.offset} back: {q(out, op.out[0], op.matchLen!)}.
            {op.offset! < op.matchLen! && (
              <>
                {' '}
                The source overlaps the destination, so the copy reads bytes it has just written — that is how a {plural(op.offset!, 'byte')}{' '}
                pattern becomes a run.
              </>
            )}{' '}
            Output is now {op.out[1]} bytes.
          </>
        )
        break
    }
  }
  const arc = copy && op && index - 1 >= ops.indexOf(copy) ? { src: copy.out[0] - copy.offset!, dst: copy.out[0], len: copy.matchLen!, label: `back ${copy.offset}, copy ${copy.matchLen}` } : null
  return (
    <>
      <Panel title="The block" aside={`${read} of ${block.bytes.length} bytes read`}>
        <BlockHex
          bytes={block.bytes}
          map={map}
          mark={(i) => (op && i >= op.inp[0] && i < op.inp[1] ? 'cur' : i >= read ? 'future' : '')}
        />
      </Panel>
      <Narration tone={op && op.inp[1] === block.bytes.length && op.kind === 'lits' ? 'done' : undefined}>{story}</Narration>
      <Panel title="Output" aside={`${outLen} bytes`}>
        <Strip
          bytes={out.subarray(0, Math.max(outLen, 1))}
          mark={(i) => {
            if (i >= outLen) return 'future'
            if (copy && op?.kind === 'copy' && i >= copy.out[0] && i < copy.out[1]) return 'hl-5'
            if (lit && op?.kind === 'lits' && i >= lit.out[0] && i < lit.out[1]) return 'hl-2'
            if (copy && op?.kind === 'copy' && i >= copy.out[0] - copy.offset! && i < copy.out[0] - copy.offset! + copy.matchLen!) return 'hl-1'
            return ''
          }}
          arc={op?.kind === 'copy' ? arc : null}
          focus={Math.max(0, outLen - 1)}
        />
        {curSeq >= 0 && <p className="small muted">sequence {curSeq}</p>}
      </Panel>
    </>
  )
}

// ------------------------------------------------------------------ frame

const FLG_BITS = ['version', 'version', 'B.Indep', 'B.Checksum', 'C.Size', 'C.Checksum', 'reserved', 'DictID']

function FrameStage({ frame, index, n }: { frame: ReturnType<typeof compressFrame>; index: number; n: number }) {
  const f = index > 0 ? frame.fields[index - 1] : null
  const bytes = frame.bytes
  const kindAt = useMemo(() => {
    const k = new Array<FrameField['kind']>(bytes.length)
    const fi = new Int32Array(bytes.length)
    frame.fields.forEach((x, j) => {
      for (let i = x.start; i < x.start + x.len; i++) {
        k[i] = x.kind
        fi[i] = j
      }
    })
    return { k, fi }
  }, [frame, bytes])
  // Show each field in full unless it is a long block; then its first 24 bytes and a count.
  const shown: number[] = []
  const skipped = new Map<number, number>()
  for (const x of frame.fields) {
    const keep = x.kind === 'block' || x.kind === 'raw' ? Math.min(x.len, 24) : x.len
    for (let i = x.start; i < x.start + keep; i++) shown.push(i)
    if (keep < x.len) skipped.set(shown.length - 1, x.len - keep)
  }
  const flg = bytes[4]
  const [check, setCheck] = useState<string | null>(null)
  useEffect(() => {
    try {
      const r = decompressFrame(bytes)
      setCheck(r.out.length === n ? 'ok' : 'length mismatch')
    } catch (e) {
      setCheck(e instanceof Error ? e.message : 'failed')
    }
  }, [bytes, n])

  const download = () => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'input.lz4'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  let story: ReactNode = <>A .lz4 file is a frame around the blocks: a small header, each block with its size in front, an end mark, an optional checksum.</>
  if (f) {
    const v = (o: number) => bytes[f.start + o]
    switch (f.kind) {
      case 'magic':
        story = (
          <>
            Four bytes <code>04 22 4D 18</code> — the number 0x184D2204 stored little-endian. Any program can recognise an LZ4 frame from these alone.
          </>
        )
        break
      case 'flg':
        story = (
          <>
            The flag byte <code>0x{hex2(v(0))}</code>: version 01 in the top two bits, then one bit each for independent blocks, block checksums,
            content size, content checksum and a dictionary ID. The grid below spells it out.
          </>
        )
        break
      case 'bd':
        story = (
          <>
            Block descriptor <code>0x{hex2(v(0))}</code>: bits 6–4 = {v(0) >> 4}, which means blocks of at most{' '}
            {BLOCK_SIZES[v(0) >> 4] >= 1 << 20 ? (BLOCK_SIZES[v(0) >> 4] >> 20) + ' MiB' : (BLOCK_SIZES[v(0) >> 4] >> 10) + ' KiB'}. A decoder can size
            its buffers before reading any data.
          </>
        )
        break
      case 'csize':
        story = <>The original size as a 64-bit little-endian number, so a decoder can allocate the output up front.</>
        break
      case 'hc':
        story = (
          <>
            Header checksum <code>0x{hex2(v(0))}</code>: XXH32 of the descriptor bytes (FLG, BD{flg & 8 ? ', size' : ''}), shifted right by 8 and
            truncated to one byte. One byte is enough to catch a corrupted header before trusting its flags.
          </>
        )
        break
      case 'bsize': {
        const w = v(0) | (v(1) << 8) | (v(2) << 16) | (v(3) << 24)
        story = (
          <>
            Block {f.block} size word: <b>{w & 0x7fffffff}</b> bytes
            {w & 0x80000000 ? (
              <> with the high bit set — this block is stored uncompressed, because compressing it would have made it bigger.</>
            ) : (
              <> of LZ4 sequences follow.</>
            )}
          </>
        )
        break
      }
      case 'block':
      case 'raw':
        story = <>{f.label}. Independent blocks: no match reaches into the previous one, so blocks could be decoded in parallel.</>
        break
      case 'bcheck':
        story = <>XXH32 of the block’s stored bytes, so a damaged block is caught before it is decoded.</>
        break
      case 'end':
        story = <>A size word of zero: no more blocks.</>
        break
      case 'ccheck':
        story = (
          <>
            {f.label}. The decoder hashes what it produced and compares. On this page the frame was just decoded again and{' '}
            {check === 'ok' ? 'the checksum matched' : `failed: ${check}`}.
          </>
        )
        break
    }
  }

  return (
    <>
      <Panel title="The .lz4 file" aside={`${int(bytes.length)} bytes for ${int(n)}`}>
        <div className="lz4-hex">
          <div className="tape wrap">
            {shown.map((i, j) => (
              <span key={i} style={{ display: 'contents' }}>
                <span
                  className={'cell ' + FRAME_CLASS[kindAt.k[i]] + (f && kindAt.fi[i] === index - 1 ? ' cur' : '') + (f && kindAt.fi[i] > index - 1 ? ' future' : '')}
                  title={frame.fields[kindAt.fi[i]].label}
                >
                  {hex2(bytes[i])}
                </span>
                {skipped.has(j) && <span className="cell more">… {int(skipped.get(j)!)} more</span>}
              </span>
            ))}
          </div>
        </div>
      </Panel>
      <Narration tone={f && (f.kind === 'ccheck' || (f.kind === 'end' && index === frame.fields.length)) ? 'done' : undefined}>{story}</Narration>
      <div className="grid-2">
        <Panel title="FLG, bit by bit">
          <div className="lz4-flg">
            {FLG_BITS.map((name, i) => {
              const bit = (flg >> (7 - i)) & 1
              return (
                <div key={i} className={bit ? 'on' : ''} title={name}>
                  <b>{bit}</b>
                  <small>{name}</small>
                </div>
              )
            })}
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            0x{hex2(flg)}. The decoder here also reads linked blocks, content size and block checksums from other encoders’ frames.
          </p>
        </Panel>
        <Panel title="Check it">
          <p className="small" style={{ margin: '0 0 8px' }}>
            {check === 'ok' ? (
              <>
                <span style={{ color: 'var(--good)' }}>✓</span> decoded back to {int(n)} bytes, header and checksums verified.
              </>
            ) : (
              <span style={{ color: 'var(--bad)' }}>✗ {check}</span>
            )}{' '}
            The file is a standard frame: <code>lz4 -d input.lz4</code> reads it.
          </p>
          <Button onClick={download}>Download input.lz4</Button>
        </Panel>
      </div>
      <Panel title="Fields">
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th className="num">offset</th>
                <th className="num">bytes</th>
                <th>field</th>
              </tr>
            </thead>
            <tbody>
              {frame.fields.map((x, j) => (
                <tr key={j} className={j === index - 1 ? 'on' : ''}>
                  <td className="num">{x.start}</td>
                  <td className="num">{int(x.len)}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <span className={'lz4-chip ' + FRAME_CLASS[x.kind]}>{x.kind}</span> {x.label}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}

// ------------------------------------------------------------------ speed

interface SpeedRow {
  label: string
  mbps: number
  note: string
  tone?: string
}

/** Best-of-k wall time for fn, in ms. */
function time(fn: () => void, k = 3): number {
  let best = Infinity
  for (let i = 0; i < k; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return Math.max(best, 0.01)
}

function SpeedPanel() {
  const [rows, setRows] = useState<SpeedRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true)
    setTimeout(() => {
      const prose = SAMPLES.find((x) => x.id === 'json')!
      const base = sampleBytes(prose)
      const size = 256 * 1024
      const d = new Uint8Array(size)
      for (let i = 0; i < size; i++) d[i] = base[i % base.length] ^ (i % 997 === 0 ? 1 : 0)
      const mb = size / (1 << 20)
      const fast = compressBlock(d).bytes
      const hcBlock = compressBlock(d, { mode: 'hc', depth: 64 }).bytes
      const def = deflateCodec.encode(d)
      const r: SpeedRow[] = [
        { label: 'LZ4 decode', mbps: mb / (time(() => decompressBlockFast(fast, size)) / 1000), note: `${int(fast.length)} B`, tone: 'good' },
        { label: 'DEFLATE decode', mbps: mb / (time(() => deflateCodec.decode(def)) / 1000), note: `${int(def.length)} B`, tone: 'ink' },
        { label: 'LZ4 encode', mbps: mb / (time(() => compressBlock(d)) / 1000), note: 'fast parser' },
        { label: 'LZ4 HC encode', mbps: mb / (time(() => compressBlock(d, { mode: 'hc', depth: 64 }), 2) / 1000), note: `${int(hcBlock.length)} B` },
        { label: 'DEFLATE encode', mbps: mb / (time(() => deflateCodec.encode(d), 1) / 1000), note: 'lazy matching', tone: 'ink' },
      ]
      setRows(r)
      setBusy(false)
    }, 30)
  }
  const max = rows ? Math.max(...rows.map((r) => r.mbps)) : 1
  return (
    <Panel
      title="Speed, measured here"
      aside={
        <Button onClick={run} disabled={busy}>
          {busy ? 'Measuring…' : rows ? 'Measure again' : 'Measure'}
        </Button>
      }
    >
      {rows ? (
        <div className="table-wrap">
          <table className="data lz4-speed">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="bar">
                    <span className="sizebar-track">
                      <span className={'sizebar-fill ' + (r.tone ?? '')} style={{ width: `${(100 * r.mbps) / max}%` }} />
                    </span>
                  </td>
                  <td className="num">{fmt(r.mbps, 0)} MB/s</td>
                  <td className="muted small">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Times this page’s own JavaScript encoders and decoders on 256 KiB of JSON-like text, best of three runs.
        </p>
      )}
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        These are this page’s JavaScript implementations on your machine{' '}
        <Help text="Native LZ4 decodes at 4–5 GB/s per core and zlib inflates at a few hundred MB/s. JavaScript is slower across the board, and the LZ4 decoder here copies byte by byte for clarity, but the ordering — and roughly the gap — is the same." />
        , not native code. The LZ4 decoder is the fast path the codec uses: <code>set</code> for literals and <code>copyWithin</code> for
        matches, JavaScript’s version of wide copies. It never touches a bit; the DEFLATE decoder reads every symbol bit by bit through a Huffman
        table.
      </p>
    </Panel>
  )
}
