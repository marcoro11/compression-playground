import { useEffect, useRef, type ReactNode } from 'react'
import { OPS, type Op } from './qoi'

/**
 * Drawing pieces for the QOI exhibit: an RGBA canvas over a checkerboard (so
 * alpha is visible), the per-pixel op map, a clickable image frame with the
 * current pixel marked, and the 64-slot colour cache.
 */

/** Highlighter per op — the same colour in the map, the legend, the bytes and the cascade. */
export const OP_HL: Record<Op, string> = {
  RUN: 'hl-4',
  INDEX: 'hl-6',
  DIFF: 'hl-3',
  LUMA: 'hl-1',
  RGB: 'hl-2',
  RGBA: 'hl-5',
}
/** Index into theme.hl for each op. */
export const OP_HL_INDEX: Record<Op, number> = { RUN: 3, INDEX: 5, DIFF: 2, LUMA: 0, RGB: 1, RGBA: 4 }

export const OP_LETTER: Record<Op, string> = { RUN: 'R', INDEX: 'I', DIFF: 'D', LUMA: 'L', RGB: 'C', RGBA: 'A' }

export function RgbaCanvas({ rgba, w, h }: { rgba: Uint8Array; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(w, h)
    img.data.set(rgba.subarray(0, w * h * 4))
    ctx.putImageData(img, 0, 0)
  }, [rgba, w, h])
  return <canvas ref={ref} className="qo-pixelated" />
}

/** Every pixel painted with the colour of the op that coded it. */
export function OpMapCanvas({ opOf, w, h, colors }: { opOf: Uint8Array; w: number; h: number; colors: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    const fills = OPS.map((op) => colors[OP_HL_INDEX[op]] || '#888')
    for (let p = 0; p < w * h; p++) {
      ctx.fillStyle = fills[opOf[p]]
      ctx.fillRect(p % w, Math.floor(p / w), 1, 1)
    }
  }, [opOf, w, h, colors])
  return <canvas ref={ref} className="qo-pixelated" />
}

/** A square frame: click to pick a pixel; the current pixel is outlined. */
export function Frame({
  w,
  h,
  sel,
  onPick,
  checker,
  title,
  sub,
  children,
}: {
  w: number
  h: number
  sel: { x: number; y: number }
  onPick: (x: number, y: number) => void
  checker?: boolean
  title: ReactNode
  sub?: ReactNode
  children: ReactNode
}) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  return (
    <figure className="qo-pane">
      <div
        className={'qo-frame' + (checker ? ' qo-checker' : '')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const x = Math.floor(((e.clientX - r.left) / r.width) * w)
          const y = Math.floor(((e.clientY - r.top) / r.height) * h)
          onPick(Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y)))
        }}
      >
        {children}
        <span className="qo-sel" style={{ left: pct(sel.x, w), top: pct(sel.y, h), width: pct(1, w), height: pct(1, h) }} />
      </div>
      <figcaption>
        {title}
        {sub && <span>{sub}</span>}
      </figcaption>
    </figure>
  )
}

const css = (c: ArrayLike<number>) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(3)})`

/** A colour chip with a checkerboard behind it, so translucent colours read as translucent. */
export function Swatch({ c, size = 22, title }: { c: ArrayLike<number>; size?: number; title?: string }) {
  return (
    <span className="qo-swatch qo-checker" style={{ width: size, height: size }} title={title}>
      <i style={{ background: css(c) }} />
    </span>
  )
}

/** The 64-entry cache as an 8 × 8 grid of swatches. */
export function CacheGrid({ cache, slot, wrote }: { cache: Uint8Array; slot: number; wrote: boolean }) {
  const cells = []
  for (let s = 0; s < 64; s++) {
    const c = cache.subarray(s * 4, s * 4 + 4)
    const empty = c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 0
    cells.push(
      <span
        key={s}
        className={'qo-slot' + (s === slot ? (wrote ? ' write' : ' read') : '') + (empty ? ' empty' : '')}
        title={`slot ${s}: ${empty ? 'empty (0,0,0,0)' : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`}`}
      >
        <span className="qo-checker">
          <i style={{ background: css(c) }} />
        </span>
        <small>{s}</small>
      </span>,
    )
  }
  return <div className="qo-cache">{cells}</div>
}

/** A short label for a byte in the hex view. */
export const hexGlyph = (b: number) => b.toString(16).padStart(2, '0')

/** Legend: op swatch, name, share of pixels and bytes. */
export function OpLegend({ pixels, bytes, total, totalBytes }: { pixels: Record<Op, number>; bytes: Record<Op, number>; total: number; totalBytes: number }) {
  return (
    <div className="legend qo-legend">
      {OPS.map((op) => (
        <span key={op} title={`${op}: ${pixels[op]} pixels, ${bytes[op]} bytes`}>
          <i className={OP_HL[op]} />
          {op} <b className="muted">{total ? ((100 * pixels[op]) / total).toFixed(1) : 0}% px</b>
          <b className="muted">· {totalBytes ? ((100 * bytes[op]) / totalBytes).toFixed(0) : 0}% bytes</b>
        </span>
      ))}
    </div>
  )
}

