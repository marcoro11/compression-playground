import { useEffect, useMemo, useState } from 'react'
import type { Codec } from '../../lib/codec'
import { byteCounts, entropy } from '../../lib/entropy'
import { SAMPLES, sampleBytes } from '../../lib/samples'
import { fmt, int } from '../../lib/text'
import { Group, Help, Segmented, Stat, Stats } from '../../ui/Controls'
import { browserDeflateSize } from '../../ui/Home'
import { Bench, Notes, Page, Panel } from '../../ui/Page'
import { SourceInput, useSource } from '../../ui/Source'
import { Narration } from '../../ui/Transport'

/**
 * Every exhibit folder that ships a `codec.ts` is picked up here automatically —
 * the same files `npm run verify` round-trips — so a new coder lands on the
 * bench without anyone editing this page.
 */
const modules = import.meta.glob<{ codecs?: Codec[] }>('../*/codec.ts', { eager: true })
const ORDER = ['rle', 'intcodes', 'huffman', 'arithmetic', 'ans', 'lz77', 'lz4', 'lzw', 'ppm', 'flac', 'deflate', 'zstd', 'lzma', 'bwt']
const CODECS: Codec[] = Object.entries(modules)
  .sort(([a], [b]) => {
    const ia = ORDER.findIndex((o) => a.includes('/' + o + '/'))
    const ib = ORDER.findIndex((o) => b.includes('/' + o + '/'))
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  .flatMap(([, m]) => m.codecs ?? [])

/** gzip is DEFLATE plus 18 bytes; on the matrix it is just a redundant column. */
const MATRIX_CODECS = CODECS.filter((c) => c.id !== 'gzip')

interface Row {
  id: string
  name: string
  family: string
  bytes: number
  encMs: number
  decMs: number
  ok: boolean | null
  error?: string
  reference?: boolean
}

function runCodec(c: Codec, data: Uint8Array): Row {
  try {
    let t = performance.now()
    const enc = c.encode(data)
    const encMs = performance.now() - t
    t = performance.now()
    const dec = c.decode(enc)
    const decMs = performance.now() - t
    let ok = dec.length === data.length
    for (let i = 0; ok && i < data.length; i++) if (dec[i] !== data[i]) ok = false
    return { id: c.id, name: c.name, family: c.family, bytes: enc.length, encMs, decMs, ok }
  } catch (e) {
    return { id: c.id, name: c.name, family: c.family, bytes: NaN, encMs: 0, decMs: 0, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

type View = 'one' | 'matrix'

export function BenchView() {
  const src = useSource('prose', 1 << 20)
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [view, setView] = useState<View>('one')
  const data = file?.bytes ?? src.bytes

  const rows = useMemo(() => CODECS.map((c) => runCodec(c, data)), [data])
  const [browser, setBrowser] = useState<{ raw: number | null; gzip: number | null }>({ raw: null, gzip: null })
  useEffect(() => {
    let live = true
    Promise.all([browserDeflateSize(data, 'deflate-raw'), browserDeflateSize(data, 'gzip')]).then(([raw, gzip]) => live && setBrowser({ raw, gzip }))
    return () => {
      live = false
    }
  }, [data])

  const H = entropy(byteCounts(data))
  const floor = (H * data.length) / 8
  const all: Row[] = [...rows]
  if (browser.raw !== null) all.push({ id: 'browser-raw', name: 'Browser DEFLATE', family: 'CompressionStream("deflate-raw") — your browser’s zlib', bytes: browser.raw, encMs: NaN, decMs: NaN, ok: null, reference: true })
  if (browser.gzip !== null) all.push({ id: 'browser-gzip', name: 'Browser gzip', family: 'CompressionStream("gzip") — same, plus 18 bytes of header and CRC', bytes: browser.gzip, encMs: NaN, decMs: NaN, ok: null, reference: true })
  const sorted = all.slice().sort((a, b) => (Number.isNaN(a.bytes) ? 1 : Number.isNaN(b.bytes) ? -1 : a.bytes - b.bytes))
  const best = sorted.find((r) => !r.reference && !Number.isNaN(r.bytes))
  const max = Math.max(data.length, ...sorted.map((r) => (Number.isNaN(r.bytes) ? 0 : r.bytes)), 1)
  const failures = rows.filter((r) => r.ok === false)

  const onFile = async (f: File | undefined) => {
    if (!f) return
    const buf = new Uint8Array(await f.slice(0, 2 << 20).arrayBuffer())
    setFile({ name: f.name, bytes: buf })
  }

  return (
    <Page
      slug="bench"
      lede={
        <p>
          Every coder on this site, run on the same bytes, next to the DEFLATE built into your browser. Each row is the codec’s real output — header,
          tables and all — and each one is decoded again and compared with the input before it gets a tick. There is no overall winner: what wins
          depends on what you feed it.
        </p>
      }
    >
      <Bench
        side={
          <>
            <Group title="Input">
              {file ? (
                <div className="source">
                  <div className="source-binary">
                    <b>{file.name}</b> — {int(file.bytes.length)} bytes{file.bytes.length >= 2 << 20 ? ' (first 2 MiB)' : ''}.{' '}
                    <u onClick={() => setFile(null)} style={{ cursor: 'pointer' }}>
                      Back to samples
                    </u>
                  </div>
                </div>
              ) : (
                <SourceInput src={src} maxBytes={1 << 20} rows={4} />
              )}
              <label className="btn btn-ghost" style={{ textAlign: 'center' }}>
                Load a file…
                <input type="file" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <p className="small muted">Files never leave your machine — everything runs in this tab.</p>
            </Group>
            <Group title="View">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'one', label: 'This input' },
                  { value: 'matrix', label: 'All samples' },
                ]}
              />
            </Group>
            <Group title="Summary">
              <Stats>
                <Stat label="input" value={int(data.length)} sub="bytes" />
                <Stat label="best here" value={best ? best.name : '—'} tone="accent" sub={best ? `${int(best.bytes)} bytes` : ''} />
                <Stat label="order-0 floor" value={int(Math.ceil(floor))} sub={`${fmt(H, 3)} bits/byte`} help="Shannon entropy of the byte histogram × length. A coder that looks at bytes one at a time cannot beat it; coders that use context (LZ, BWT) can, and on text usually do." />
                <Stat label="round-trips" value={failures.length ? `${failures.length} ✗` : `${rows.length} ✓`} tone={failures.length ? 'bad' : 'good'} />
              </Stats>
            </Group>
          </>
        }
      >
        {view === 'one' ? (
          <>
            <Panel title="Compressed size" aside={`input ${int(data.length)} bytes · bar = size relative to the largest`}>
              <div className="table-wrap">
                <table className="data bench-table">
                  <thead>
                    <tr>
                      <th>codec</th>
                      <th style={{ width: '40%' }}>size</th>
                      <th className="num">bytes</th>
                      <th className="num">
                        ratio <Help text="Compressed size ÷ original. Below 100% saved space; above 100% made it bigger." />
                      </th>
                      <th className="num">bits/byte</th>
                      <th className="num">enc ms</th>
                      <th className="num">dec ms</th>
                      <th>✓</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="muted">
                      <td>original</td>
                      <td>
                        <span className="sizebar-track" style={{ display: 'block' }}>
                          <span className="sizebar-fill faint" style={{ width: `${(100 * data.length) / max}%` }} />
                        </span>
                      </td>
                      <td className="num">{int(data.length)}</td>
                      <td className="num">100%</td>
                      <td className="num">8.00</td>
                      <td />
                      <td />
                      <td />
                    </tr>
                    {sorted.map((r) => (
                      <tr key={r.id} title={r.family + (r.error ? ' — ' + r.error : '')}>
                        <td>
                          <b>{r.name}</b>
                          <div className="small muted" style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                            {r.family}
                          </div>
                        </td>
                        <td>
                          <span className="sizebar-track" style={{ display: 'block' }}>
                            <span
                              className={'sizebar-fill ' + (r.reference ? 'ink' : r.bytes > data.length ? 'bad' : '')}
                              style={{ width: `${Number.isNaN(r.bytes) ? 0 : (100 * r.bytes) / max}%` }}
                            />
                          </span>
                        </td>
                        <td className="num">{Number.isNaN(r.bytes) ? '—' : int(r.bytes)}</td>
                        <td className="num" style={{ color: r.bytes > data.length ? 'var(--bad)' : undefined }}>
                          {data.length ? fmt((100 * r.bytes) / data.length, 1) + '%' : '—'}
                        </td>
                        <td className="num">{data.length ? fmt((8 * r.bytes) / data.length, 2) : '—'}</td>
                        <td className="num">{Number.isNaN(r.encMs) ? '' : fmt(r.encMs, 1)}</td>
                        <td className="num">{Number.isNaN(r.decMs) ? '' : fmt(r.decMs, 1)}</td>
                        <td>{r.ok === null ? <span className="muted">ref</span> : r.ok ? <span style={{ color: 'var(--good)' }}>✓</span> : <span style={{ color: 'var(--bad)' }}>✗</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Narration tone={failures.length ? 'warn' : undefined}>
              {failures.length ? (
                <>Round-trip failed for {failures.map((f) => f.name).join(', ')} — that is a bug, and `npm run verify` should be catching it.</>
              ) : data.length === 0 ? (
                <>Nothing to compress. Every format still has to write a header, so every one of them makes the empty file bigger.</>
              ) : sorted.filter((r) => !r.reference && r.bytes > data.length).length === rows.length ? (
                <>Every coder made this input bigger. That is not a failure of engineering: almost all inputs are incompressible, and this one looks like most of them.</>
              ) : (
                <>
                  <b>{best?.name}</b> wins here at {fmt((100 * (best?.bytes ?? 0)) / data.length, 1)}% of the original. The order-0 floor is{' '}
                  {fmt((100 * floor) / data.length, 1)}% —{' '}
                  {best && best.bytes < floor ? 'beaten, because it exploits context that a byte histogram cannot see.' : 'not beaten: on this input, context does not buy much.'}
                </>
              )}
            </Narration>
          </>
        ) : (
          <Matrix />
        )}
      </Bench>
      <Notes>
        <h2>Reading the numbers</h2>
        <p>
          Sizes include everything a decoder needs: length prefixes, Huffman tables, block headers. That is why the static Huffman row is useless on
          a 24-byte input (its table alone is 128 bytes) and why the adaptive coders shine there — they ship no table, because the decoder learns
          the statistics as it goes.
        </p>
        <h2>Why the winners change</h2>
        <ul>
          <li>
            <b>Long runs of one byte</b> — RLE is nearly unbeatable for its simplicity, and everything with a run or a match mechanism gets close.
          </li>
          <li>
            <b>Skewed but unstructured</b> (one symbol dominates, no repeats) — arithmetic coding wins: it can spend 0.15 bits on a 90% symbol,
            where Huffman must spend 1.
          </li>
          <li>
            <b>Text and JSON</b> — the context users (LZ77/DEFLATE, BWT) pull away, because the next byte depends on the previous few, and a
            histogram cannot know that.
          </li>
          <li>
            <b>Random bytes</b> — everything loses. A counting argument says it must: there are fewer short files than long ones, so any coder
            that shrinks some inputs has to grow others. Good formats keep the damage to a few bytes by falling back to storing.
          </li>
        </ul>
        <h2>The reference rows</h2>
        <p>
          “Browser DEFLATE” is your browser’s own zlib via <code>CompressionStream</code> — the same algorithm as this site’s DEFLATE exhibit, but
          with decades of tuning in its match finder and block splitting. The gap between the two is roughly what that tuning is worth.
        </p>
      </Notes>
    </Page>
  )
}

/** Ratio of every codec on every sample: the "no free lunch" picture. */
function Matrix() {
  const data = useMemo(() => {
    return SAMPLES.map((s) => {
      const bytes = sampleBytes(s)
      return {
        sample: s,
        n: bytes.length,
        h: entropy(byteCounts(bytes)),
        cells: MATRIX_CODECS.map((c) => {
          const r = runCodec(c, bytes)
          return { ratio: r.bytes / Math.max(1, bytes.length), ok: r.ok }
        }),
      }
    })
  }, [])
  const tone = (r: number) => {
    if (!Number.isFinite(r)) return 'transparent'
    if (r >= 1) return `color-mix(in srgb, var(--bad) ${Math.min(60, 15 + (r - 1) * 40)}%, transparent)`
    return `color-mix(in srgb, var(--good) ${Math.round(10 + (1 - r) * 60)}%, transparent)`
  }
  return (
    <>
      <Panel title="Compressed size ÷ original, every codec × every sample" aside="green shrank it · red grew it">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>sample</th>
                <th className="num">bytes</th>
                <th className="num">H₀</th>
                {MATRIX_CODECS.map((c) => (
                  <th key={c.id} className="num" title={c.family} style={{ whiteSpace: 'normal', verticalAlign: 'bottom', minWidth: 52 }}>
                    {c.name.replace(/\s*\((.*)\)/, ' $1').replace(' + MTF + Huffman', '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const bestRatio = Math.min(...row.cells.map((c) => c.ratio))
                return (
                  <tr key={row.sample.id}>
                    <td title={row.sample.note}>{row.sample.label}</td>
                    <td className="num">{row.n}</td>
                    <td className="num">{fmt(row.h, 2)}</td>
                    {row.cells.map((c, i) => (
                      <td key={i} className="num" style={{ background: tone(c.ratio), fontWeight: c.ratio === bestRatio ? 700 : 400 }}>
                        {c.ok ? fmt(100 * c.ratio, 0) + '%' : '✗'}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Narration>
        Read down a column to see a coder’s personality, across a row to see which idea an input rewards. The samples are tiny, so fixed costs —
        headers and tables — dominate several of them; that is part of the lesson, not noise.
      </Narration>
    </>
  )
}
