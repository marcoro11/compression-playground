import type { CSSProperties, ReactNode } from 'react'
import { META, metaBySlug } from '../exhibits/meta'

/**
 * The frame every exhibit sits in: a slim top bar back to the index, a header
 * with the kicker / title / lede, then whatever the exhibit lays out, and a
 * prev/next footer. Sets `--accent` from the exhibit's metadata.
 */
export function Page({ slug, children, lede }: { slug: string; children: ReactNode; lede?: ReactNode }) {
  const m = metaBySlug(slug)
  const i = META.findIndex((x) => x.slug === slug)
  const prev = i > 0 ? META[i - 1] : undefined
  const next = i >= 0 && i < META.length - 1 ? META[i + 1] : undefined
  return (
    <div className="page" style={{ '--accent': m?.accent } as CSSProperties}>
      <TopBar current={slug} />
      <header className="page-head">
        <div className="kicker">{m?.kicker}</div>
        <h1>
          <span className="hl">{m?.title}</span>
        </h1>
        {lede && <div className="lede">{lede}</div>}
      </header>
      <main className="page-body">{children}</main>
      <footer className="page-foot">
        {prev ? (
          <a href={'#/' + prev.slug} className="pager prev">
            <small>← previous</small>
            {prev.title}
          </a>
        ) : (
          <span />
        )}
        {next ? (
          <a href={'#/' + next.slug} className="pager next">
            <small>next →</small>
            {next.title}
          </a>
        ) : (
          <span />
        )}
      </footer>
    </div>
  )
}

export function TopBar({ current }: { current?: string }) {
  return (
    <nav className="topbar">
      <a href="#/" className="brand">
        <span className="brand-mark" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        Compression Playground
      </a>
      <div className="topbar-links">
        {META.map((m) => (
          <a
            key={m.slug}
            href={'#/' + m.slug}
            className={m.slug === current ? 'on' : ''}
            style={{ '--accent': m.accent } as CSSProperties}
            title={m.title}
          >
            {m.title}
          </a>
        ))}
      </div>
    </nav>
  )
}

/**
 * The working area: a wide stage on the left and a sticky control column on the
 * right. Collapses to one column on narrow screens with the controls first.
 */
export function Bench({ side, children }: { side: ReactNode; children: ReactNode }) {
  return (
    <div className="bench">
      <div className="bench-stage">{children}</div>
      <aside className="bench-side">{side}</aside>
    </div>
  )
}

/** A bordered panel on the stage with an optional title row. */
export function Panel({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={'panel' + (className ? ' ' + className : '')}>
      {(title || aside) && (
        <div className="panel-head">
          <h2>{title}</h2>
          {aside && <div className="panel-aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * Long-form explanation below the bench: history, the maths, what real formats
 * do differently. Plain prose with h2/h3/p/ul/pre — styled as a technical note.
 */
export function Notes({ children }: { children: ReactNode }) {
  return <article className="notes">{children}</article>
}

/** Monospace block for pseudocode or a worked example. */
export function Code({ children }: { children: ReactNode }) {
  return <pre className="code">{children}</pre>
}
