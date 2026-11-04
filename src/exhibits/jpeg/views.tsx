import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ZIGZAG, basis } from './jpeg'
import type { Theme } from '../../lib/theme'

/**
 * Drawing pieces for the JPEG exhibit: a greyscale image canvas you can click
 * to pick a block, a tiny 8×8 block canvas, the 8×8 number grid that the whole
 * step-through is built from, and the 64-basis atlas.
 */

/** Grey values (any scale) into an ImageData-backed canvas, drawn 1:1; CSS scales it up crisply. */
function paintGrey(canvas: HTMLCanvasElement, data: ArrayLike<number>, w: number, h: number) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = data[i] < 0 ? 0 : data[i] > 255 ? 255 : data[i]
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

export function GreyCanvas({ data, w, h, className, style }: { data: ArrayLike<number>; w: number; h: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) paintGrey(ref.current, data, w, h)
  }, [data, w, h])
  return <canvas ref={ref} className={'jp-pixelated ' + (className ?? '')} style={style} />
}

/**
 * An image pane with the selected 8×8 block outlined. Clicking picks a block.
 * `children` replaces the canvas (used for the browser-decoded <img>).
 */
export function ImagePane({
  title,
  sub,
  data,
  size,
  sel,
  onPick,
  children,
}: {
  title: ReactNode
  sub?: ReactNode
  data?: ArrayLike<number>
  size: number
  sel: { bx: number; by: number }
  onPick?: (bx: number, by: number) => void
  children?: ReactNode
}) {
  const pct = (v: number) => `${(v / size) * 100}%`
  return (
    <figure className="jp-pane">
      <div
        className={'jp-frame' + (onPick ? ' pickable' : '')}
        onClick={(e) => {
          if (!onPick) return
          const r = e.currentTarget.getBoundingClientRect()
          const x = ((e.clientX - r.left) / r.width) * size
          const y = ((e.clientY - r.top) / r.height) * size
          onPick(Math.max(0, Math.min(size / 8 - 1, Math.floor(x / 8))), Math.max(0, Math.min(size / 8 - 1, Math.floor(y / 8))))
        }}
      >
        {children ?? (data && <GreyCanvas data={data} w={size} h={size} />)}
        <span className="jp-sel" style={{ left: pct(sel.bx * 8), top: pct(sel.by * 8), width: pct(8), height: pct(8) }} />
      </div>
      <figcaption>
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </figcaption>
    </figure>
  )
}

export type MatrixMode = 'gray' | 'signed' | 'table' | 'int'

/**
 * The 8×8 grid of numbers. Colour carries the value so the eye sees structure
 * before reading digits: grey for pixels, two highlighter colours for signed
 * values (blue +, pink −), orange intensity for the quantization table, and
 * yellow for the coefficients that survived quantization.
 */
export function Matrix({
  values,
  mode,
  digits = 0,
  hot,
  onHover,
  zigzag,
  label,
  scale,
}: {
  values: ArrayLike<number>
  mode: MatrixMode
  digits?: number
  hot?: number | null
  onHover?: (i: number | null) => void
  zigzag?: boolean
  label?: ReactNode
  /** Value that maps to full colour intensity (signed/table); defaults to max |v|. */
  scale?: number
}) {
  let max = scale ?? 0
  if (!scale) for (let i = 0; i < 64; i++) max = Math.max(max, Math.abs(values[i]))
  if (!max) max = 1
  const cells = []
  for (let i = 0; i < 64; i++) {
    const v = values[i]
    let style: CSSProperties = {}
    let cls = 'jp-cell'
    if (mode === 'gray') {
      const g = Math.max(0, Math.min(255, Math.round(v)))
      style = { background: `rgb(${g},${g},${g})`, color: g < 120 ? '#f5f2e9' : '#1b1a17' }
    } else if (mode === 'signed') {
      const t = Math.sqrt(Math.min(1, Math.abs(v) / max))
      const pctv = Math.round(t * 100)
      style = { background: `color-mix(in srgb, var(${v >= 0 ? '--hl-4' : '--hl-2'}) ${pctv}%, var(--paper))` }
      if (Math.abs(v) < 0.5) cls += ' zero'
    } else if (mode === 'table') {
      const t = Math.min(1, v / max)
      style = { background: `color-mix(in srgb, var(--hl-5) ${Math.round(15 + t * 85)}%, var(--paper))` }
    } else {
      if (v === 0) cls += ' zero'
      else style = { background: 'var(--hl-1)', color: 'var(--hl-ink)' }
    }
    if (hot === i) cls += ' hot'
    const r = digits ? v.toFixed(digits) : String(Math.round(v))
    const text = /^-0(\.0+)?$/.test(r) ? r.slice(1) : r
    cells.push(
      <span key={i} className={cls} style={style} onMouseEnter={onHover ? () => onHover(i) : undefined} title={`row ${i >> 3}, col ${i & 7}: ${text}`}>
        {text}
      </span>,
    )
  }
  const pts = ZIGZAG.map((n) => `${(n & 7) + 0.5},${(n >> 3) + 0.5}`).join(' ')
  return (
    <figure className="jp-matrix">
      <div className={'jp-grid' + (digits ? ' dec' : '')} onMouseLeave={onHover ? () => onHover(null) : undefined}>
        {cells}
        {zigzag && (
          <svg className="jp-zz" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden>
            <polyline points={pts} fill="none" stroke="var(--ink)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity={0.75} />
            <circle cx={0.5} cy={0.5} r={0.14} fill="var(--ink)" />
          </svg>
        )}
      </div>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  )
}

/**
 * All 64 basis images in one canvas, (v, u) at row v, column u. Coefficients
 * that survive quantization in the current block get an outline. Hover reports
 * the natural index under the mouse.
 */
export function BasisAtlas({ live, hot, onHover, theme }: { live: ArrayLike<number>; hot: number | null; onHover: (i: number | null) => void; theme: Theme }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const S = 6 // pixels per basis pixel
  const G = 4 // gap
  const cell = 8 * S + G
  const size = 8 * cell - G
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, size, size)
    const img = ctx.createImageData(8, 8)
    const tmp = document.createElement('canvas')
    tmp.width = 8
    tmp.height = 8
    const tctx = tmp.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    for (let v = 0; v < 8; v++)
      for (let u = 0; u < 8; u++) {
        const b = basis(v, u)
        // Each basis spans ±1/4 (±1/8 for DC rows/cols); normalise each to full contrast.
        let m = 0
        for (let i = 0; i < 64; i++) m = Math.max(m, Math.abs(b[i]))
        for (let i = 0; i < 64; i++) {
          const g = u === 0 && v === 0 ? 200 : Math.round(128 + (127 * b[i]) / m)
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g
          img.data[i * 4 + 3] = 255
        }
        tctx.putImageData(img, 0, 0)
        ctx.drawImage(tmp, u * cell, v * cell, 8 * S, 8 * S)
        const n = v * 8 + u
        if (live[n] !== 0 || hot === n) {
          ctx.strokeStyle = hot === n ? theme.ink : theme.accent
          ctx.lineWidth = hot === n ? 4 : 3
          ctx.strokeRect(u * cell + 1.5, v * cell + 1.5, 8 * S - 3, 8 * S - 3)
        }
      }
  }, [live, hot, theme, size, cell, S])
  return (
    <canvas
      ref={ref}
      className="jp-atlas"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const x = ((e.clientX - r.left) / r.width) * size
        const y = ((e.clientY - r.top) / r.height) * size
        const u = Math.min(7, Math.floor(x / cell))
        const v = Math.min(7, Math.floor(y / cell))
        onHover(v * 8 + u)
      }}
      onMouseLeave={() => onHover(null)}
    />
  )
}
