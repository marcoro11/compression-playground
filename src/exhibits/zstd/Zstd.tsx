import { useEffect, useMemo, useState } from 'react'
import { fmt, glyph, hex2, int, pct } from '../../lib/text'
import { toBin } from '../../lib/bits'
import { useStepper } from '../../lib/useStepper'
import { Group, Help, Segmented, SizeBars, Stat, Stats, Toggle } from '../../ui/Controls'
import { browserDeflateSize } from '../../ui/Home'
import { Bench, Code, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { BitRow, Tape } from '../../ui/Tape'
import { Narration, Transport } from '../../ui/Transport'
import { deflateCodec } from '../deflate/codec'
import { decode, type DecodeResult, type Region } from './decoder'
import { encode, type EncBlock, type EncSeq, type Effort } from './encoder'
import { LL_BASE, LL_BITS, ML_BASE, ML_BITS, type StreamName } from './tables'
import './zstd.css'

type View = 'seq' | 'frame'
type LitPref = 'auto' | 'raw' | 'huffman'
type TabPref = 'auto' | 'predefined' | 'fse'

const REGION_CLASS: Record<string, string> = {
  magic: 'hl-6',
  fhd: 'hl-6',
  window: 'hl-6',
  dict: 'hl-6',
  fcs: 'hl-6',
  blockhdr: 'hl-3',
  checksum: 'hl-3',
  lithdr: 'hl-4',
  huffdesc: 'hl-4',
  jump: 'hl-4',
  literals: 'hl-1',
  raw: 'hl-1',
  rle: 'hl-1',
  huffstream: 'hl-1',
  seqcount: 'hl-2',
  modes: 'hl-2',
  fsedesc: 'hl-2',
  seqstream: 'hl-5',
}

const REGION_LEGEND: [string, string][] = [
  ['hl-6', 'frame header'],
  ['hl-3', 'block header / checksum'],
  ['hl-4', 'literals header & Huffman table'],
  ['hl-1', 'literals'],
  ['hl-2', 'sequence count, modes, FSE tables'],
  ['hl-5', 'sequences bitstream'],
]

const REGION_WHY: Record<string, string> = {
  magic: 'Every Zstandard frame starts with these four bytes, so a file can be recognised without trusting its name.',
  fhd: 'One byte of flags, and it decides how the rest of the header is laid out.',
  window: 'How much history a decoder must keep. With a single segment the content size doubles as the window, and this byte is skipped.',
  dict: 'Which pre-shared dictionary the frame was compressed against.',
  fcs: 'The decompressed size, so a decoder can allocate once.',
  blockhdr: 'Three bytes, little-endian: 1 bit "last block", 2 bits block type, 21 bits size.',
  checksum: 'XXH64 of the decompressed content, truncated to 32 bits — Yann Collet’s other famous algorithm.',
  lithdr: 'Literal type and sizes, packed into one to five bytes depending on how big the numbers are.',
  huffdesc: 'The Huffman code for the literals, described as weights — not lengths, not a tree. The last symbol’s weight is implied.',
  jump: 'With four streams, three 16-bit sizes let a decoder start all four at once — four independent dependency chains for the CPU.',
  literals: 'The bytes no match covered, stored as they are.',
  raw: 'Bytes stored as they are.',
  rle: 'One byte, which the decoder repeats.',
  huffstream: 'Huffman codes for the literals, written backwards so the decoder can start from the end it finds first.',
  seqcount: 'How many (literal length, offset, match length) triples follow.',
  modes: 'For each of the three code streams: predefined table, a single repeated code (RLE), an FSE table shipped right here, or "same as last block".',
  fsedesc: 'An FSE table described by its normalised counts — the same counts the ANS exhibit spreads over its states.',
  seqstream: 'All three FSE states and every extra bit, interleaved in one backward bitstream.',
}

const SPAN_CLASS: Record<string, string> = {
  init: 'hl-6',
  state: 'hl-4',
  llx: 'hl-1',
  mlx: 'hl-5',
  ofx: 'hl-2',
  sentinel: 'hl-3',
  pad: 'zs-pad',
}

const STREAM_NAME: Record<StreamName, string> = { LL: 'literal lengths', OF: 'offsets', ML: 'match lengths' }

function tryDecode(bytes: Uint8Array): { r?: DecodeResult; err?: string } {
  try {
    return { r: decode(bytes) }
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) }
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function repName(rep: number) {
  return rep === 3 ? 'rep1 − 1' : `rep${rep + 1}`
}

export function Zstd() {
  const src = useSource('prose', 1024)
  const [effort, setEffort] = useState<Effort>('default')
  const [litPref, setLitPref] = useState<LitPref>('auto')
  const [tabPref, setTabPref] = useState<TabPref>('auto')
  const [checksum, setChecksum] = useState(true)
  const [view, setView] = useState<View>('seq')
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const data = src.bytes

  const enc = useMemo(() => encode(data, { effort, literals: litPref, tables: tabPref, checksum }), [data, effort, litPref, tabPref, checksum])
  const back = useMemo(() => tryDecode(enc.bytes), [enc])
  const roundTrip = back.r ? same(back.r.out, data) : false
  const seqs = useMemo(() => enc.blocks.flatMap((b) => b.seqs), [enc])
  const fileDec = useMemo(() => (file ? tryDecode(file.bytes) : null), [file])

  const showFile = view === 'frame' && file !== null
  const frameBytes = showFile ? file!.bytes : enc.bytes
  const regions = showFile ? (fileDec?.r?.regions ?? []) : (back.r?.regions ?? [])

  const count = view === 'seq' ? seqs.length + 1 : regions.length + 1
  const s = useStepper(count, {
    speed: view === 'seq' ? 2 : 3,
    resetKey: `${src.key}|${view}|${effort}|${litPref}|${tabPref}|${checksum}|${showFile ? file!.name : ''}`,
  })

  const [gz, setGz] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    browserDeflateSize(data, 'gzip').then((n) => live && setGz(n))
    return () => {
      live = false
    }
  }, [data])
  const deflateSize = useMemo(() => deflateCodec.encode(data).length, [data])

  const reps = seqs.filter((q) => q.rep >= 0).length
  const litCount = enc.blocks.reduce((t, b) => t + (b.literals?.count ?? 0), 0)

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setFile({ name: f.name, bytes: new Uint8Array(await f.slice(0, 1 << 20).arrayBuffer()) })
    setView('frame')
  }

  return (
    <Page
      slug="zstd"
      lede={
        <>
          <p>
            Zstandard is what DEFLATE would look like if it were designed in 2015: the same LZ77 idea, but the input becomes a list of{' '}
            <b>sequences</b> — <i>copy these literals, then copy this many bytes from that far back</i> — and the three numbers of every sequence
            go to three separate entropy coders. The literals get Huffman. The lengths and offsets get <b>FSE</b>, the table-driven{' '}
            <a href="#/ans">ANS</a> coder. And the last three offsets are remembered, so “the same distance as before” costs almost nothing.
          </p>
          <p>Everything below is a real .zst frame. The test suite hands every one to the zstd built into Node, and decodes Node’s own frames with this page’s decoder.</p>
        </>
      }
    >
      <Bench
        side={
          <>
            <Group title="Source">
              <SourceInput src={src} samples={['prose', 'json', 'tobe', 'abra', 'runs', 'skew', 'dna', 'random']} maxBytes={1024} />
            </Group>
            <Group title="Encoder">
              <Segmented
                label="match finder"
                value={effort}
                onChange={setEffort}
                help="How hard the hash-chain search tries: how many earlier positions it checks, and whether it waits one byte to see if a better match starts there (lazy matching)."
                options={[
                  { value: 'fast', label: 'fast' },
                  { value: 'default', label: 'default' },
                  { value: 'max', label: 'max' },
                ]}
              />
              <Segmented
                label="literals"
                value={litPref}
                onChange={setLitPref}
                help="Auto picks whichever is smallest: raw bytes, one repeated byte (RLE), or Huffman-coded."
                options={[
                  { value: 'auto', label: 'auto' },
                  { value: 'raw', label: 'raw' },
                  { value: 'huffman', label: 'Huffman' },
                ]}
              />
              <Segmented
                label="sequence tables"
                value={tabPref}
                onChange={setTabPref}
                help="Each of the three code streams can use the predefined distribution (free to describe), one repeated code (RLE), or its own FSE table (costs a few bytes to describe, fits the data). Auto prices all of them."
                options={[
                  { value: 'auto', label: 'auto' },
                  { value: 'predefined', label: 'predefined' },
                  { value: 'fse', label: 'own FSE' },
                ]}
              />
              <Toggle label="content checksum" value={checksum} onChange={setChecksum} help="Append the low 32 bits of XXH64 of the content. Costs 4 bytes; catches corruption." />
            </Group>
            <Group title="Step through">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'seq', label: 'Sequences' },
                  { value: 'frame', label: 'Read the frame' },
                ]}
              />
              <p className="small muted">
                {view === 'seq'
                  ? 'One step per sequence: the literals it carries, the match it copies, and what its three numbers cost.'
                  : 'One step per field, in the order a decoder meets them.'}
              </p>
              <label className="btn btn-ghost zs-file" style={{ textAlign: 'center' }}>
                Open a .zst file…
                <input type="file" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              {file && (
                <p className="small">
                  Reading <b>{file.name}</b>.{' '}
                  <u style={{ cursor: 'pointer' }} onClick={() => setFile(null)}>
                    Back to the input
                  </u>
                </p>
              )}
            </Group>
            <Group title="Result">
              <Stats>
                <Stat label="input" value={int(data.length)} sub="bytes" />
                <Stat label=".zst frame" value={int(enc.bytes.length)} sub={data.length ? pct(enc.bytes.length / data.length) + ' of input' : ''} tone="accent" />
                <Stat label="sequences" value={seqs.length} sub={`${reps} on a repeat offset`} help="Each sequence is: copy some literals, then copy a match. Matches whose distance is one of the last three cost only a tiny code." />
                <Stat label="literals" value={litCount} sub={enc.blocks[0]?.literals?.mode ?? '—'} />
              </Stats>
            </Group>
          </>
        }
      >
        {view === 'seq' ? (
          <SeqStage data={data} enc={enc.blocks} seqs={seqs} index={s.index} jump={(i) => s.setIndex(i)} />
        ) : (
          <FrameStage bytes={frameBytes} regions={regions} index={s.index} err={showFile ? fileDec?.err : back.err} />
        )}
        <Transport s={s} label={(i) => (view === 'seq' ? `sequence ${i} / ${seqs.length}` : `field ${i} / ${regions.length}`)} />

        {showFile ? (
          <FilePanel name={file!.name} dec={fileDec!} />
        ) : (
          <Panel title="Did it work?">
            <div className="zs-check">
              <div>
                This page’s decoder read the frame back:{' '}
                {roundTrip ? (
                  <span className="ok">✓ {int(data.length)} bytes, identical</span>
                ) : (
                  <span className="bad">✗ {back.err ?? 'different bytes'}</span>
                )}
                {checksum && back.r?.frames[0]?.checksum && (
                  <span className="muted"> — checksum {back.r.frames[0].checksum.stored.toString(16).padStart(8, '0')} matches</span>
                )}
              </div>
              <div className="small muted">
                The stronger test is outside this page: <code>npm run verify zstd</code> gives every frame this encoder makes — every sample, every
                literal and table mode — to the zstd library built into Node, and decodes Node’s own frames at levels 1, 3, 9 and 19 with this
                decoder. Browsers do not expose zstd to pages, so that check cannot run here.
              </div>
            </div>
          </Panel>
        )}

        <Panel title="How big is it" aside="whole files, headers included">
          <SizeBars
            unit="bytes"
            rows={[
              { label: 'input', value: data.length, tone: 'faint' },
              { label: 'Zstandard', value: enc.bytes.length, note: `frame header ${enc.headerBytes} B${checksum ? ' + 4 B checksum' : ''}` },
              { label: 'DEFLATE (raw)', value: deflateSize, tone: 'ink', note: 'this site’s encoder' },
              ...(gz !== null ? [{ label: 'browser gzip', value: gz, tone: 'ink', note: 'CompressionStream' }] : []),
            ]}
          />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            On text this small the two land close: Zstandard’s advantages — repeat offsets, a 128 KiB-plus window, fractional-bit FSE — need room
            to show. Its real lead is speed: the reference decoder runs several times faster than zlib at a better ratio.
          </p>
        </Panel>
      </Bench>

      <Notes>
        <h2>A frame, from the outside in</h2>
        <Code>{`frame    = magic 28 B5 2F FD · header · block… · [checksum]
block    = 3-byte header (last?, type, size) · raw | RLE | compressed
compressed block = literals section · sequences section
sequence = (literal length, offset, match length)
           → copy that many literals, then copy match length bytes from offset back`}</Code>
        <p>
          The decoder keeps two buffers: the literals of the block, already decoded, and the output. Executing a sequence copies literals from
          one to the other, then copies a match within the output. Literals left over after the last sequence go on the end. That is all the
          “decompression” there is — the cleverness is in how the three numbers of each sequence are written down.
        </p>

        <h2>Three streams instead of one alphabet</h2>
        <p>
          DEFLATE folds lengths into the literal alphabet and gives distances their own; Zstandard separates all three. Each number becomes a{' '}
          <b>code</b> (a bucket, like DEFLATE’s length codes) plus extra bits, and each kind of code has its own FSE table: 36 literal-length codes,
          53 match-length codes, and offset codes that are simply ⌊log₂ Offset_Value⌋. The codes are then interleaved through one backward
          bitstream. Separating them means each table fits its own statistics, and FSE spends fractional bits on them where Huffman could not.
        </p>
        <p>
          A block may ship a table (normalised counts, exactly as the <a href="#/ans">ANS exhibit</a> spreads them), use the predefined
          distributions written into the standard, say “every sequence has the same code” (RLE), or reuse the previous block’s table. The encoder
          here prices every option for every stream and keeps the cheapest — the alternatives show in the table panel.
        </p>

        <h2>Repeat offsets</h2>
        <p>
          Structured data repeats distances: the columns of a table, the fields of a record, the stride of an array. Zstandard remembers the last
          three offsets, and Offset_Value 1, 2 and 3 mean “use one of those” — real offsets are sent as distance + 3. When a sequence has no
          literals the meanings shift by one (repeating the very last offset with nothing in between would just be a longer previous match, so that
          code is reused for “rep1 − 1”). The match finder here checks the three repeat distances before searching the hash chains, and prefers
          them, because they cost two or three bits instead of twenty.
        </p>

        <h2>Literals: Huffman, described by weights</h2>
        <p>
          Literals get one Huffman code per block. Instead of code lengths the header sends <b>weights</b>: weight w means the symbol takes 2^(w−1)
          slots of a 2^maxBits table, so longer codes have smaller weights and absent symbols weight 0. The last symbol’s weight is never sent —
          it is whatever completes the table. The weights themselves are either packed as 4-bit numbers or, more compactly, FSE-compressed with two
          interleaved states. Above 1 KiB of literals the stream is cut into four, with a small jump table, so a CPU can decode four symbols at a
          time.
        </p>

        <h2>Why everything is read backwards</h2>
        <p>
          Every entropy-coded stream in Zstandard is written forwards and read from its end. That is what ANS needs — its decoder pops in the
          reverse of the encoder’s push order — and the format applies the same convention to the Huffman streams for uniformity. A single 1 bit
          marks where the data ends inside the last byte, so the decoder can find its starting point without a length field.
        </p>

        <h2>Levels, windows, dictionaries</h2>
        <p>
          The format does not change between level 1 and level 22; only the encoder does. Low levels use a single hash probe; middle levels lazy
          matching like this page’s “max”; the top levels run an <b>optimal parser</b> that prices whole paths of sequences with the real code
          costs. Windows go up to 128 MiB with <code>--long</code> mode for long-distance matches. For small messages — an API response, a log line —
          the killer feature is a <b>dictionary</b>: <code>zstd --train</code> builds one from samples, and a frame compressed against it starts with
          the statistics already learned.
        </p>

        <h2>History</h2>
        <p>
          Yann Collet wrote LZ4 in 2011, published FSE — his practical tANS, from Jarek Duda’s ANS papers — in 2013, and combined both ideas into
          Zstandard, released as 1.0 by Facebook in 2016 and standardised as RFC 8478 (2018), then RFC 8878 (2021). It is now in the Linux kernel
          (btrfs and SquashFS compression, compressed firmware and modules), in Arch Linux and Fedora packages, in HTTP as{' '}
          <code>Content-Encoding: zstd</code> (Chrome, 2024), and in Node’s own zlib module, which is what the test suite uses as the referee.
        </p>
        <div className="aside">
          What this encoder skips: dictionaries, the long-distance matcher, the optimal parser, block splitting by statistics, and “repeat” table
          modes on the encoding side (the decoder handles them, since real zstd output uses them). The format is all there; the effort is not.
        </div>
      </Notes>
    </Page>
  )
}

// --------------------------------------------------------------- sequences

function SeqStage({ data, enc, seqs, index, jump }: { data: Uint8Array; enc: EncBlock[]; seqs: EncSeq[]; index: number; jump: (i: number) => void }) {
  const [tableStream, setTableStream] = useState<StreamName>('OF')
  const cur = index > 0 ? seqs[index - 1] : null
  const blk = cur ? enc[cur.block] : enc[0]
  const local = cur && blk ? blk.seqs.indexOf(cur) : -1

  // Which sequence covers each input byte, as literal or match.
  const owner = useMemo(() => {
    const lit = new Int32Array(data.length).fill(-1)
    const mat = new Int32Array(data.length).fill(-1)
    seqs.forEach((q, k) => {
      for (let i = q.litStart; i < q.litStart + q.ll; i++) lit[i] = k
      for (let i = q.litStart + q.ll; i < q.litStart + q.ll + q.ml; i++) mat[i] = k
    })
    return { lit, mat }
  }, [data, seqs])

  const srcStart = cur ? cur.litStart + cur.ll - cur.offset : -1
  const mark = (i: number) => {
    const k = index - 1
    let c = ''
    if (owner.lit[i] === k) c = 'hl-1'
    else if (owner.mat[i] === k) c = 'hl-5'
    else if (owner.lit[i] >= 0 && owner.lit[i] < k) c = 'zs-pastlit'
    else if (owner.mat[i] >= 0 && owner.mat[i] < k) c = 'zs-pastmatch'
    else if (owner.lit[i] < 0 && owner.mat[i] < 0 && index === seqs.length && seqs.length) c = 'zs-pastlit'
    else c = 'dim'
    if (cur && i >= srcStart && i < srcStart + cur.ml) c += ' src'
    return c
  }

  let narration
  if (!cur) {
    narration = seqs.length ? (
      <>
        The match finder has cut the input into <b>{seqs.length}</b> sequences. Each one says: copy some literal bytes, then copy a run of bytes
        from earlier. Step forward to see them one at a time — and what their three numbers cost.
      </>
    ) : (
      <>No match of 3 bytes or more anywhere, so there are no sequences: the block is all literals.</>
    )
  } else {
    const litText = Array.from(data.subarray(cur.litStart, cur.litStart + cur.ll), glyph).join('')
    const matchText = Array.from(data.subarray(cur.litStart + cur.ll, cur.litStart + cur.ll + Math.min(cur.ml, 24)), glyph).join('')
    narration = (
      <>
        {cur.ll ? (
          <>
            Copy {cur.ll} literal{cur.ll === 1 ? '' : 's'} <code>{litText.length > 30 ? litText.slice(0, 30) + '…' : litText}</code>, then{' '}
          </>
        ) : (
          <>No literals; </>
        )}
        copy <b>{cur.ml}</b> bytes <code>{matchText}{cur.ml > 24 ? '…' : ''}</code> from <b>{cur.offset}</b> back
        {cur.offset < cur.ml && <> — overlapping itself, so it repeats a {cur.offset}-byte pattern</>}.{' '}
        {cur.rep >= 0 ? (
          <>
            That distance is already remembered as <b>{repName(cur.rep)}</b>, so the offset is just Offset_Value {cur.ofValue} — code {cur.ofCode}
            {cur.ofCode ? `, ${cur.ofCode} extra bit` : ', no extra bits'}.{cur.ll === 0 && ' With no literals the repeat codes shift by one.'}
          </>
        ) : (
          <>
            A new distance: Offset_Value = {cur.offset} + 3 = {cur.ofValue}, sent as code {cur.ofCode} plus {cur.ofCode} extra bits, and pushed to the
            front of the repeat list.
          </>
        )}
        {blk && blk.type !== 'compressed' && <> (This block ended up stored as {blk.type}, so these sequences were not sent.)</>}
      </>
    )
  }

  return (
    <>
      <Panel title="Input, as sequences" aside={cur ? `sequence ${index}: ${cur.ll} literals + ${cur.ml}-byte match` : `${seqs.length} sequences`}>
        <div className="zs-tape">
          <Tape bytes={data} mark={mark} onClick={(i) => {
            const k = owner.lit[i] >= 0 ? owner.lit[i] : owner.mat[i]
            if (k >= 0) jump(k + 1)
          }} />
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          <span>
            <i className="hl-1" /> literals
          </span>
          <span>
            <i className="hl-5" /> match
          </span>
          <span>
            <i style={{ boxShadow: 'inset 0 -3px 0 var(--ink)' }} /> where it is copied from
          </span>
          <span>
            <i className="zs-pastlit" /> <i className="zs-pastmatch" /> done
          </span>
        </div>
        {cur && <SeqCard q={cur} />}
      </Panel>
      <Narration tone={index === seqs.length && seqs.length > 0 ? 'done' : undefined}>{narration}</Narration>

      {blk?.streams && blk.bitSpans && (
        <SeqBits blk={blk} local={local} />
      )}

      <div className="grid-2">
        <Panel title="The three code streams" aside={`${seqs.length} rows`}>
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th className="num">LL</th>
                  <th className="num">ML</th>
                  <th className="num">offset</th>
                  <th className="num">LL code</th>
                  <th className="num">OF code</th>
                  <th className="num">ML code</th>
                </tr>
              </thead>
              <tbody>
                {seqs.map((q, k) => (
                  <tr key={k} className={k === index - 1 ? 'on' : ''} onClick={() => jump(k + 1)} style={{ cursor: 'pointer' }}>
                    <td className="num">{k + 1}</td>
                    <td className="num">{q.ll}</td>
                    <td className="num">{q.ml}</td>
                    <td className="num">{q.rep >= 0 ? `${repName(q.rep)} = ${q.offset}` : q.offset}</td>
                    <td className="num">{q.llCode}</td>
                    <td className="num">{q.ofCode}</td>
                    <td className="num">{q.mlCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <LiteralsPanel blk={blk} />
      </div>

      {blk?.streams && <TablePanel blk={blk} stream={tableStream} setStream={setTableStream} local={local} />}
    </>
  )
}

function SeqCard({ q }: { q: EncSeq }) {
  const llExtra = q.ll - LL_BASE[q.llCode]
  const mlExtra = q.ml - ML_BASE[q.mlCode]
  const ofExtra = q.ofValue - 2 ** q.ofCode
  const used = q.rep < 0 ? -1 : q.rep === 3 ? 0 : q.rep
  return (
    <>
      <div className="zs-seq">
        <div className="zs-field">
          <h4>literal length</h4>
          <div className="big">{q.ll}</div>
          <span className="code hl-1">code {q.llCode}</span>
          <small>
            = {LL_BASE[q.llCode]}
            {LL_BITS[q.llCode] ? ` + ${LL_BITS[q.llCode]}-bit extra ${toBin(llExtra, LL_BITS[q.llCode])}` : ', no extra bits'}
          </small>
        </div>
        <div className="zs-field">
          <h4>offset</h4>
          <div className="big">{q.rep >= 0 ? repName(q.rep) : q.offset}</div>
          <span className="code hl-2">code {q.ofCode}</span>
          <small>
            {q.rep >= 0 ? `= ${q.offset} back · ` : ''}Offset_Value {q.ofValue} = 2^{q.ofCode}
            {q.ofCode ? ` + ${toBin(ofExtra, q.ofCode)}₂` : ''}
          </small>
        </div>
        <div className="zs-field">
          <h4>match length</h4>
          <div className="big">{q.ml}</div>
          <span className="code hl-5">code {q.mlCode}</span>
          <small>
            = {ML_BASE[q.mlCode]}
            {ML_BITS[q.mlCode] ? ` + ${ML_BITS[q.mlCode]}-bit extra ${toBin(mlExtra, ML_BITS[q.mlCode])}` : ', no extra bits'}
          </small>
        </div>
      </div>
      <div className="zs-reps">
        <span>repeat offsets</span>
        {q.repsBefore.map((r, k) => (
          <span key={'b' + k} className={'slot' + (k === used ? ' used' : '')}>
            {r}
            <small>rep{k + 1}</small>
          </span>
        ))}
        <span className="arrow">→</span>
        {q.repsAfter.map((r, k) => (
          <span key={'a' + k} className="slot">
            {r}
            <small>rep{k + 1}</small>
          </span>
        ))}
        <Help text="The decoder keeps the last three distinct offsets. A new offset pushes onto the front; reusing rep2 or rep3 moves it to the front; reusing rep1 changes nothing. Offset_Value 1–3 refer to these slots, so a repeated distance costs at most one extra bit." />
      </div>
    </>
  )
}

function SeqBits({ blk, local }: { blk: EncBlock; local: number }) {
  // Show the fields in the order the decoder reads them: from the end of the stream.
  const spans = blk.bitSpans!.slice().reverse().filter((x) => x.length > 0)
  let bits = ''
  const rows = spans.map((sp) => {
    const r = { start: bits.length, length: sp.length, className: '', title: `${sp.label}: ${sp.bits}` }
    bits += sp.bits
    const mine = local >= 0 && sp.label.startsWith(`seq ${local}:`)
    const isInit = sp.kind === 'init'
    r.className = (SPAN_CLASS[sp.kind] ?? '') + (local >= 0 && !mine && !(isInit && local === 0) ? ' zs-faint' : '')
    return r
  })
  return (
    <Panel title="The sequences bitstream, as the decoder reads it" aside={`${blk.seqStreamBits} bits for ${blk.seqs.length} sequences`}>
      <div className="zs-bits">
        <BitRow bits={bits} spans={rows} />
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span>
          <i className="hl-6" /> initial states
        </span>
        <span>
          <i className="hl-1" /> literal-length extra
        </span>
        <span>
          <i className="hl-5" /> match-length extra
        </span>
        <span>
          <i className="hl-2" /> offset extra
        </span>
        <span>
          <i className="hl-4" /> state updates
        </span>
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        The encoder wrote this back to front — last sequence first — so the decoder, reading from the end, meets them in order: the three
        initial states, then for each sequence its offset, match-length and literal-length extra bits, then the bits that move the three states
        on. The codes themselves are never written: they are what the states <i>are</i>.
      </p>
    </Panel>
  )
}

function LiteralsPanel({ blk }: { blk?: EncBlock }) {
  const L = blk?.literals
  if (!L) return <Panel title="Literals">No compressed block.</Panel>
  const h = L.huff
  const rows = h
    ? h.table.weights
        .map((w, sym) => ({ sym, w, count: h.counts[sym] }))
        .filter((r) => r.w > 0)
        .sort((a, b) => b.count - a.count || a.sym - b.sym)
    : []
  return (
    <Panel title="Literals section" aside={`${L.count} literals → ${L.bytes} bytes`}>
      <div className="zs-alts">
        {L.alternatives.map((a) => (
          <span key={a.mode} className={a.mode === L.mode ? 'won' : ''}>
            {a.mode} {a.bytes} B
          </span>
        ))}
      </div>
      {h ? (
        <>
          <p className="small" style={{ margin: '0 0 8px' }}>
            Huffman, {L.streams} stream{L.streams > 1 ? 's' : ''}, longest code {h.table.maxBits} bits. The table costs {h.descBytes} bytes, weights{' '}
            {h.via === 'direct' ? 'packed two per byte' : `FSE-coded (accuracy ${h.fse?.log})`}.
          </p>
          <div className="table-wrap" style={{ maxHeight: 210, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>byte</th>
                  <th className="num">count</th>
                  <th className="num">
                    weight <Help text="Weight w = maxBits + 1 − code length. The symbol fills 2^(w−1) slots of the decoding table." />
                  </th>
                  <th className="num">bits</th>
                  <th>code</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sym}>
                    <td>{glyph(r.sym)}</td>
                    <td className="num">{r.count}</td>
                    <td className="num">{r.w}</td>
                    <td className="num">{h.table.lengths[r.sym]}</td>
                    <td>{toBin(h.table.codes[r.sym], h.table.lengths[r.sym])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {L.mode === 'RLE' ? 'Every literal is the same byte: it is stored once.' : 'Stored as they are — a Huffman table would cost more than it saves here.'}
        </p>
      )}
    </Panel>
  )
}

function TablePanel({ blk, stream, setStream, local }: { blk: EncBlock; stream: StreamName; setStream: (s: StreamName) => void; local: number }) {
  const st = blk.streams![stream]
  const t = st.table
  const size = 1 << t.log
  const curState = local >= 0 ? st.states[local] : -1
  const cell = curState >= 0 ? t.cells[curState] : null
  const maxNorm = Math.max(1, ...t.norm.map(Math.abs))
  const symClass = (s: number) => `hl-${(s % 6) + 1}`
  return (
    <Panel
      title={`FSE table — ${STREAM_NAME[stream]}`}
      aside={
        <Segmented
          value={stream}
          onChange={setStream}
          options={[
            { value: 'LL', label: 'LL' },
            { value: 'OF', label: 'OF' },
            { value: 'ML', label: 'ML' },
          ]}
        />
      }
    >
      <div className="zs-alts">
        {st.alternatives.map((a) => (
          <span key={a.mode} className={(a.mode === st.mode || (st.mode === 'FSE' && a.mode === `FSE, accuracy ${t.log}`)) ? 'won' : ''}>
            {a.mode}: {a.bits} bits
          </span>
        ))}
      </div>
      <p className="small" style={{ margin: '0 0 6px' }}>
        Mode <b>{st.mode}</b>
        {st.mode === 'RLE'
          ? ` — every sequence in this block has ${stream} code ${st.codes[0]}, so one byte describes the stream and it costs no bits at all.`
          : ` — ${size} states (accuracy ${t.log}). ${st.stateBits} bits of state for ${st.codes.length} codes, ${fmt(st.stateBits / Math.max(1, st.codes.length), 2)} per code, plus ${st.extraBits} extra bits.${st.mode === 'FSE' ? ` Describing the table cost ${st.descBytes} bytes.` : ' The predefined table costs nothing to describe.'}`}
      </p>
      {t.log > 0 && (
        <>
          <div className="zs-norm" title="normalised counts per code">
            {t.norm.map((c, k) => (
              <span key={k} className={c ? symClass(k) : ''} style={{ height: `${(100 * Math.abs(c)) / maxNorm}%`, opacity: c ? 1 : 0.15 }} title={`code ${k}: ${c === -1 ? 'less than 1' : c}`} />
            ))}
          </div>
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Normalised counts per code (they sum to {size}). Below, every state: the code it decodes to, and how many bits move it to the next.
          </p>
          <div className="zs-grid">
            {t.cells.map((c, u) => (
              <div key={u} className={'zs-cell ' + symClass(c.symbol) + (u === curState ? ' on' : '')} title={`state ${u}: code ${c.symbol}, read ${c.nbBits} bits, next = ${c.baseline} + bits`}>
                <span className="st">{u}</span>
                <b>{c.symbol}</b>
                <i>
                  {c.nbBits}b·{c.baseline}
                </i>
              </div>
            ))}
          </div>
          {cell && (
            <p className="small" style={{ margin: '8px 0 0' }}>
              Sequence {local + 1} of this block: the {STREAM_NAME[stream]} decoder is in state <b>{curState}</b>, which <i>is</i> code {cell.symbol}.
              {local < st.codes.length - 1 ? ` It then reads ${cell.nbBits} bits and moves to ${cell.baseline} + those bits.` : ' It is the last sequence, so no update.'}
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------- frame

function FrameStage({ bytes, regions, index, err }: { bytes: Uint8Array; regions: Region[]; index: number; err?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const owner = useMemo(() => {
    const o = new Int32Array(bytes.length).fill(-1)
    regions.forEach((r, k) => {
      for (let i = r.start; i < r.end && i < bytes.length; i++) o[i] = k
    })
    return o
  }, [bytes, regions])
  const active = hover ?? (index > 0 ? index - 1 : null)
  const r = active !== null ? regions[active] : null
  const shown = Math.min(bytes.length, 4096)
  return (
    <>
      <Panel title={`The frame — ${int(bytes.length)} bytes`} aside={r ? `bytes ${r.start}–${r.end - 1}` : 'hover a byte'}>
        {err && <p className="small" style={{ color: 'var(--bad)' }}>Could not parse: {err}</p>}
        <div className="zs-hex" onMouseLeave={() => setHover(null)}>
          {Array.from(bytes.subarray(0, shown), (b, i) => {
            const k = owner[i]
            const cls = k >= 0 ? REGION_CLASS[regions[k].kind] ?? 'plain' : 'plain'
            const on = active !== null && k === active
            const dim = index > 0 && hover === null && k > index - 1
            return (
              <span key={i} className={cls + (on ? ' on' : '') + (dim ? ' dimmed' : '')} onMouseEnter={() => k >= 0 && setHover(k)}>
                {hex2(b)}
              </span>
            )
          })}
          {bytes.length > shown && <span className="plain">… {int(bytes.length - shown)} more</span>}
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          {REGION_LEGEND.map(([c, l]) => (
            <span key={c}>
              <i className={c} /> {l}
            </span>
          ))}
        </div>
        <div className="zs-hover">{r ? r.label : 'Each colour is one field. Step through, or hover any byte.'}</div>
      </Panel>
      <Narration tone={index === regions.length && regions.length > 0 ? 'done' : undefined}>
        {index === 0 ? (
          <>A decoder reads a frame front to back, one field at a time. Step forward to follow it.</>
        ) : r ? (
          <>
            <b>{r.label}.</b> {REGION_WHY[r.kind] ?? ''}
          </>
        ) : null}
      </Narration>
    </>
  )
}

function FilePanel({ name, dec }: { name: string; dec: { r?: DecodeResult; err?: string } }) {
  if (!dec.r) {
    return (
      <Panel title={`Reading ${name}`}>
        <p className="small" style={{ color: 'var(--bad)', margin: 0 }}>
          This page’s decoder could not read it: {dec.err}. (Dictionaries are not supported.)
        </p>
      </Panel>
    )
  }
  const r = dec.r
  const text = new TextDecoder('utf-8', { fatal: false }).decode(r.out.subarray(0, 2000))
  const types = r.blocks.reduce<Record<string, number>>((m, b) => ((m[b.type] = (m[b.type] ?? 0) + 1), m), {})
  return (
    <Panel title={`Reading ${name}`} aside={`${int(r.out.length)} bytes out`}>
      <p className="small" style={{ margin: '0 0 8px' }}>
        {r.frames.length} frame{r.frames.length > 1 ? 's' : ''}, {r.blocks.length} block{r.blocks.length > 1 ? 's' : ''} (
        {Object.entries(types)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')}
        ), {r.blocks.reduce((t, b) => t + (b.seqs?.length ?? 0), 0)} sequences.
        {r.frames[0]?.checksum && <> Checksum {r.frames[0].checksum.ok ? '✓' : '✗'}.</>}
      </p>
      <div className="zs-preview">{text}{r.out.length > 2000 ? '…' : ''}</div>
    </Panel>
  )
}
