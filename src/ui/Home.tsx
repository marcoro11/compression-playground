import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { EXHIBITS, TIERS } from '../exhibits/registry'
import { byteCounts, entropy } from '../lib/entropy'
import { buildTree, codedBits } from '../lib/huffman'
import { utf8 } from '../lib/text'
import { CARD_ART } from './cardArt'
import { TopBar } from './Page'

/** Size of `data` after the browser's own DEFLATE (CompressionStream), or null if unavailable. */
export async function browserDeflateSize(data: Uint8Array, format: 'deflate-raw' | 'gzip' = 'deflate-raw'): Promise<number | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream(format))
    const buf = await new Response(stream).arrayBuffer()
    return buf.byteLength
  } catch {
    return null
  }
}

function Demo() {
  const [text, setText] = useState('she sells sea shells by the sea shore, and the shells she sells are sea shells for sure')
  const bytes = useMemo(() => utf8(text), [text])
  const hist = useMemo(() => byteCounts(bytes), [bytes])
  const h = entropy(hist)
  const huff = useMemo(() => codedBits(hist, buildTree(hist).lengths), [hist])
  const [gz, setGz] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    browserDeflateSize(bytes).then((n) => live && setGz(n))
    return () => {
      live = false
    }
  }, [bytes])
  return (
    <div className="home-demo">
      <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Try a sentence" />
      <div className="demo-row">
        <span>
          as typed <b>{bytes.length * 8}</b> bits
        </span>
        <span>
          entropy floor <b>{Math.ceil(h * bytes.length)}</b> bits <span className="muted">({h.toFixed(2)}/char)</span>
        </span>
        <span>
          Huffman <b>{huff}</b> bits
        </span>
        {gz !== null && (
          <span>
            your browser’s DEFLATE <b>{gz * 8}</b> bits
          </span>
        )}
      </div>
    </div>
  )
}

export function Home() {
  return (
    <>
      <TopBar />
      <div className="home">
        <header className="home-head">
          <div className="rule">A workbench for squeezing bits</div>
          <h1>
            Every compressor is a <span className="hl">bet about what comes next</span>.
          </h1>
          <p>
            Step through the algorithms inside ZIP, PNG, GIF, FLAC, bzip2, Zstandard and JPEG one decision at a time — the merge that builds a Huffman tree, the
            match a sliding window finds, the interval an arithmetic coder zooms into, the bits of a real gzip stream. Every encoder here produces
            the actual bitstream it describes, and every one decodes it back.
          </p>
          <p className="muted">
            Use <kbd>←</kbd> <kbd>→</kbd> and <kbd>space</kbd> to drive any step-through. Anything with a <span className="mono">?</span> next to it
            explains itself.
          </p>
        </header>
        <Demo />
        {TIERS.map((t) => {
          const list = EXHIBITS.filter((e) => e.tier === t.id)
          if (!list.length) return null
          return (
            <section className="tier" key={t.id}>
              <div className="tier-head">
                <h2>{t.title}</h2>
                <span>{t.blurb}</span>
              </div>
              <div className="card-grid">
                {list.map((e) => (
                  <a key={e.slug} href={'#/' + e.slug} className="card" style={{ '--accent': e.accent } as CSSProperties}>
                    <span className="card-art">{CARD_ART[e.slug]?.()}</span>
                    <span className="card-body">
                      <span className="kicker">{e.kicker}</span>
                      <h2>
                        <span className="hl">{e.title}</span>
                      </h2>
                      <p>{e.tagline}</p>
                      <span className="tags">
                        {e.tags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </span>
                    </span>
                  </a>
                ))}
              </div>
            </section>
          )
        })}
        <footer className="home-foot">
          <p>
            Nothing here is a mock-up. The DEFLATE, Zstandard and LZMA exhibits write streams that real decompressors accept, and the PNG,
            QOI and JPEG exhibits write files your browser decodes. The test suite checks every codec round-trips, and pins the algorithms
            against answers that existed before this site: RFC examples, the standards’ own tables, textbook traces, Node’s zlib and zstd,
            and xz. One of a series of playgrounds.
          </p>
        </footer>
      </div>
    </>
  )
}
