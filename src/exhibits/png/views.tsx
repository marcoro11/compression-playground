import { useEffect, useRef, type ReactNode } from 'react'
import { FILTER_NAMES, type FilterType } from './filters'

/**
 * Drawing pieces for the PNG exhibit: an RGB image canvas you can click to pick
 * a pixel (with a crosshair on it), the per-row filter stripe, and a 256-bin
 * byte histogram.
 */

/** Highlighter class per filter type — the same colour in the stripe, the table and the legend. */
export const FILTER_HL = ['hl-6', 'hl-1', 'hl-4', 'hl-3', 'hl-2'] as const
/** Index into theme.hl (0-based) for each filter type. */
export const FILTER_HL_INDEX = [5, 0, 3, 2, 1] as const

function paintRgb(canvas: HTMLCanvasElement, rgb: ArrayLike<number>, w: number, h: number) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = rgb[i * 3]
    img.data[i * 4 + 1] = rgb[i * 3 + 1]
    img.data[i * 4 + 2] = rgb[i * 3 + 2]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

export function RgbCanvas({ rgb, w, h }: { rgb: ArrayLike<number>; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) paintRgb(ref.current, rgb, w, h)
  }, [rgb, w, h])
  return <canvas ref={ref} className="pn-pixelated" />
}

/** A square image pane; clicking picks a pixel, and the picked pixel and its row are marked. */
export function Pane({
  title,
  sub,
  w,
  h,
  sel,
  onPick,
  children,
  side,
}: {
  title: ReactNode
  sub?: ReactNode
  w: number
  h: number
  sel: { x: number; y: number }
  onPick?: (x: number, y: number) => void
  children: ReactNode
  side?: ReactNode
}) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  return (
    <figure className="pn-pane">
      <div className="pn-frame-row">
        <div
          className={'pn-frame' + (onPick ? ' pickable' : '')}
          onClick={(e) => {
            if (!onPick) return
            const r = e.currentTarget.getBoundingClientRect()
            const x = Math.floor(((e.clientX - r.left) / r.width) * w)
            const y = Math.floor(((e.clientY - r.top) / r.height) * h)
            onPick(Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y)))
          }}
        >
          {children}
          <span className="pn-rowmark" style={{ top: pct(sel.y, h), height: pct(1, h) }} />
          <span className="pn-sel" style={{ left: pct(sel.x, w), top: pct(sel.y, h), width: pct(1, w), height: pct(1, h) }} />
        </div>
        {side ?? <span className="pn-stripe-spacer" aria-hidden />}
      </div>
      <figcaption>
        {title}
        {sub && <span>{sub}</span>}
      </figcaption>
    </figure>
  )
}

/** One coloured cell per row: which filter that row used. */
export function FilterStripe({ types, colors, sel }: { types: FilterType[]; colors: string[]; sel: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = 1
    c.height = types.length
    const ctx = c.getContext('2d')!
    types.forEach((t, y) => {
      ctx.fillStyle = colors[FILTER_HL_INDEX[t]] || '#888'
      ctx.fillRect(0, y, 1, 1)
    })
  }, [types, colors])
  return (
    <div className="pn-stripe" title="Filter type chosen for each row">
      <canvas ref={ref} />
      <span className="pn-stripe-mark" style={{ top: `${(sel / types.length) * 100}%`, height: `${100 / types.length}%` }} />
    </div>
  )
}

export function FilterLegend({ counts }: { counts?: number[] }) {
  return (
    <div className="legend">
      {FILTER_NAMES.map((n, t) => (
        <span key={n}>
          <i className={FILTER_HL[t]} />
          {t} {n}
          {counts && <b className="muted">&nbsp;×{counts[t]}</b>}
        </span>
      ))}
    </div>
  )
}

/** 256 bars, byte value on x. Bars are scaled by √count so the tail stays visible next to a spike. */
export function Histogram({ hist, label, tone }: { hist: number[]; label: ReactNode; tone: string }) {
  const max = Math.max(1, ...hist)
  const H = 70
  return (
    <figure className="pn-hist">
      <svg viewBox={`0 0 256 ${H + 12}`} preserveAspectRatio="none" role="img" aria-label="byte histogram">
        <line x1={0} x2={256} y1={H} y2={H} stroke="var(--line-strong)" strokeWidth={0.6} />
        {hist.map((c, i) =>
          c ? <rect key={i} x={i} y={H - (Math.sqrt(c) / Math.sqrt(max)) * H} width={1} height={(Math.sqrt(c) / Math.sqrt(max)) * H} fill={tone} /> : null,
        )}
        {[0, 128, 255].map((v) => (
          <text key={v} x={v === 255 ? 254 : v + 1} y={H + 10} fontSize={8} textAnchor={v === 255 ? 'end' : v === 128 ? 'middle' : 'start'} fill="var(--muted)">
            {v}
          </text>
        ))}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  )
}
