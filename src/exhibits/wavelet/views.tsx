import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Theme } from '../../lib/theme'
import type { PassState } from './wavelet'

/**
 * Drawing pieces for the wavelet exhibit: a greyscale canvas, the Mallat mosaic
 * (picture-like regions in grey, detail bands in a signed two-colour map, each
 * band contrast-stretched on its own), a 1-D bar chart for the warm-up, and the
 * rate–distortion plot.
 */

type RGB = [number, number, number]

/** Resolve any CSS colour string (hex, rgb(), named…) to RGB by letting a canvas parse it. */
export function cssRgb(color: string, fallback: RGB = [128, 128, 128]): RGB {
  if (typeof document === 'undefined' || !color) return fallback
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const x = c.getContext('2d')
  if (!x) return fallback
  x.fillStyle = '#000'
  x.fillStyle = color
  x.fillRect(0, 0, 1, 1)
  const d = x.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2]]
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

export interface Palette {
  paper: RGB
  pos: RGB
  neg: RGB
}

/** Signed-map colours from the theme: highlighter blue for +, pink for −, pushed a little toward ink for contrast. */
export function usePalette(theme: Theme): Palette {
  return useMemo(() => {
    const ink = cssRgb(theme.ink)
    return {
      paper: cssRgb(theme.paper, [245, 242, 233]),
      pos: mix(cssRgb(theme.hl[3]), ink, 0.38),
      neg: mix(cssRgb(theme.hl[1]), ink, 0.32),
    }
  }, [theme])
}

function paintGrey(canvas: HTMLCanvasElement, data: ArrayLike<number>, w: number, h: number) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = data[i] < 0 ? 0 : data[i] > 255 ? 255 : data[i]
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

export function GreyCanvas({ data, w, h }: { data: ArrayLike<number>; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) paintGrey(ref.current, data, w, h)
  }, [data, w, h])
  return <canvas ref={ref} className="wv-px" />
}

type Rect = { x: number; y: number; w: number; h: number }

/**
 * 99th percentile of |v| over a rectangle — the scale a band is stretched to —
 * but never below `floor`, so a band of pure sensor grain stays pale instead of
 * being blown up to full contrast.
 */
function bandScale(data: ArrayLike<number>, stride: number, r: Rect, floor = 28): number {
  const vs: number[] = []
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) vs.push(Math.abs(data[y * stride + x]))
  if (!vs.length) return 1
  vs.sort((a, b) => a - b)
  return Math.max(floor, vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.99))])
}

function paintMosaic(canvas: HTMLCanvasElement, data: ArrayLike<number>, w: number, h: number, low: Rect[], high: Rect[], pal: Palette, fixedScale?: number) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(w, h)
  const put = (i: number, c: RGB) => {
    img.data[i * 4] = c[0]
    img.data[i * 4 + 1] = c[1]
    img.data[i * 4 + 2] = c[2]
    img.data[i * 4 + 3] = 255
  }
  for (const r of low) {
    let lo = Infinity
    let hi = -Infinity
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = data[y * w + x]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    const span = hi - lo || 1
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const g = ((data[y * w + x] - lo) / span) * 255
        put(y * w + x, [g, g, g])
      }
  }
  for (const r of high) {
    const s = fixedScale ?? bandScale(data, w, r)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = data[y * w + x]
        const t = Math.min(1, Math.abs(v) / s) ** 0.75
        put(y * w + x, mix(pal.paper, v >= 0 ? pal.pos : pal.neg, t))
      }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * The Mallat mosaic of one pass state, with band outlines and labels drawn in
 * SVG on top. `hot` outlines the region the current pass just rewrote.
 */
export function Mosaic({
  state,
  w,
  h,
  pal,
  hot,
  labels = true,
  fixedScale,
}: {
  state: Pick<PassState, 'data' | 'low' | 'high'>
  w: number
  h: number
  pal: Palette
  hot?: Rect | null
  labels?: boolean
  fixedScale?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) paintMosaic(ref.current, state.data, w, h, state.low, state.high, pal, fixedScale)
  }, [state, w, h, pal, fixedScale])
  return (
    <div className="wv-mosaic">
      <canvas ref={ref} className="wv-px" />
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        {state.high.map((r) => (
          <rect key={r.x + ':' + r.y + ':' + r.w} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="var(--ink)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.55} />
        ))}
        {hot && <rect x={hot.x} y={hot.y} width={hot.w} height={hot.h} fill="none" stroke="var(--accent)" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
      </svg>
      {labels && (
        <div className="wv-labels">
          {(state.high as (Rect & { label?: string })[])
            .filter((r) => r.label && r.w >= w / 16)
            .map((r) => (
              <span key={r.label} style={{ left: `${((r.x + 3) / w) * 100}%`, top: `${((r.y + 3) / h) * 100}%` }}>
                {r.label}
              </span>
            ))}
        </div>
      )}
    </div>
  )
}

/** A captioned square frame for an image. Clicking reports the position in image pixels. */
export function Pane({ title, sub, children, onPick, size, mark }: { title: ReactNode; sub?: ReactNode; children: ReactNode; onPick?: (x: number, y: number) => void; size: number; mark?: Rect | null }) {
  const pct = (v: number) => `${(v / size) * 100}%`
  return (
    <figure className="wv-pane">
      <div
        className={'wv-frame' + (onPick ? ' pickable' : '')}
        onClick={(e) => {
          if (!onPick) return
          const r = e.currentTarget.getBoundingClientRect()
          onPick(((e.clientX - r.left) / r.width) * size, ((e.clientY - r.top) / r.height) * size)
        }}
      >
        {children}
        {mark && <span className="wv-mark" style={{ left: pct(mark.x), top: pct(mark.y), width: pct(mark.w), height: pct(mark.h) }} />}
      </div>
      <figcaption>
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </figcaption>
    </figure>
  )
}

// ------------------------------------------------------------- 1-D bars

export interface Bar {
  v: number
  /** 'low' (picture), 'detail' (signed), 'ghost' (not computed yet), 'src' (read by this step), 'dst' (written). */
  kind: 'low' | 'detail' | 'ghost' | 'plain'
  hot?: 'src' | 'dst'
  label?: string
}

/**
 * Bars on one shared scale, so a detail of ±3 next to a pixel of 200 looks as
 * small as it is. Values print under each bar.
 */
export function Bars({ bars, max, title, split }: { bars: Bar[]; max: number; title?: ReactNode; split?: number }) {
  const W = 36
  const H = 120
  const base = H * 0.78
  const up = base - 8
  const down = H - base - 6
  const y = (v: number) => (v >= 0 ? base - (v / max) * up : base + Math.min(down, (-v / max) * up))
  const width = bars.length * W + 8
  return (
    <figure className="wv-bars">
      {title && <figcaption>{title}</figcaption>}
      <div className="scroll-x">
        <svg width={width} height={H + 34} viewBox={`0 0 ${width} ${H + 34}`}>
          <line x1={0} x2={width} y1={base} y2={base} stroke="var(--line-strong)" />
          {split !== undefined && <line x1={4 + split * W - 1} x2={4 + split * W - 1} y1={2} y2={H + 30} stroke="var(--ink)" strokeDasharray="3 3" />}
          {bars.map((b, i) => {
            const x = 4 + i * W + 4
            // Not computed yet: a short dashed placeholder sitting on the baseline.
            const known = Number.isFinite(b.v)
            const top = known ? Math.min(y(b.v), base) : base - 14
            const hgt = known ? Math.max(b.v !== 0 ? 1.5 : 0, Math.abs(y(b.v) - base)) : 14
            const fill =
              b.kind === 'ghost' ? 'transparent' : b.kind === 'detail' ? (b.v >= 0 ? 'var(--hl-4)' : 'var(--hl-2)') : b.kind === 'low' ? 'var(--accent)' : 'var(--line-strong)'
            return (
              <g key={i}>
                {b.hot && <rect x={x - 3} y={2} width={W - 2} height={H + 30} rx={4} fill={b.hot === 'dst' ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--ink) 8%, transparent)'} />}
                <rect
                  x={x}
                  y={top}
                  width={W - 8}
                  height={hgt}
                  fill={fill}
                  stroke={b.kind === 'ghost' ? 'var(--faint)' : 'var(--ink)'}
                  strokeDasharray={b.kind === 'ghost' ? '3 2' : undefined}
                  strokeWidth={b.hot === 'dst' ? 2 : 0.8}
                />
                <text x={x + (W - 8) / 2} y={H + 14} fontSize={11} textAnchor="middle" fill={b.kind === 'ghost' ? 'var(--faint)' : 'var(--ink)'} fontWeight={b.hot === 'dst' ? 700 : 400}>
                  {Number.isFinite(b.v) ? fmtNum(b.v) : ''}
                </text>
                {b.label && (
                  <text x={x + (W - 8) / 2} y={H + 28} fontSize={9.5} textAnchor="middle" fill="var(--muted)">
                    {b.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </figure>
  )
}

export const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)).replace('-', '−')

// ------------------------------------------------------- rate–distortion

export function RdChart({
  wavelet,
  dct,
  current,
  waveletLabel,
}: {
  wavelet: { bpp: number; psnr: number }[]
  dct: { bpp: number; psnr: number }[]
  current?: { bpp: number; wav: number; dct: number }
  waveletLabel: string
}) {
  const W = 520
  const H = 240
  const m = { l: 36, r: 14, t: 10, b: 36 }
  const xmax = Math.min(2.5, Math.max(...wavelet.map((p) => p.bpp), ...dct.map((p) => p.bpp), 0.5))
  const finite = [...wavelet, ...dct].map((p) => p.psnr).filter(Number.isFinite)
  const ymin = Math.floor(Math.min(...finite, 40) / 5) * 5
  const ymax = Math.ceil(Math.max(...finite.filter((v) => v < 70), ymin + 10) / 5) * 5
  const X = (b: number) => m.l + (Math.min(b, xmax) / xmax) * (W - m.l - m.r)
  const Y = (p: number) => H - m.b - ((Math.max(ymin, Math.min(ymax, p)) - ymin) / (ymax - ymin)) * (H - m.t - m.b)
  const path = (pts: { bpp: number; psnr: number }[]) =>
    pts
      .filter((p) => p.bpp <= xmax * 1.001 && Number.isFinite(p.psnr))
      .sort((a, b) => a.bpp - b.bpp)
      .map((p, i) => `${i ? 'L' : 'M'} ${X(p.bpp).toFixed(1)} ${Y(p.psnr).toFixed(1)}`)
      .join(' ')
  const xt: number[] = []
  const stepX = xmax > 1.5 ? 0.5 : xmax > 0.6 ? 0.25 : 0.1
  for (let v = 0; v <= xmax + 1e-9; v += stepX) xt.push(+v.toFixed(2))
  const yt: number[] = []
  for (let v = ymin; v <= ymax; v += 5) yt.push(v)
  return (
    <div className="wv-rd">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="PSNR against bits per pixel for the wavelet and the 8×8 DCT">
        {yt.map((v) => (
          <g key={'y' + v}>
            <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--line)" />
            <text x={m.l - 6} y={Y(v) + 4} fontSize={11} textAnchor="end" fill="var(--muted)">
              {v}
            </text>
          </g>
        ))}
        {xt.map((v) => (
          <text key={'x' + v} x={X(v)} y={H - m.b + 16} fontSize={11} textAnchor="middle" fill="var(--muted)">
            {v}
          </text>
        ))}
        <text x={(W + m.l) / 2} y={H - 4} fontSize={11} textAnchor="middle" fill="var(--muted)">
          bits per pixel (estimate)
        </text>
        <text x={m.l + 6} y={m.t + 12} fontSize={11} fill="var(--muted)">
          PSNR, dB
        </text>
        <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--ink)" />
        <path d={path(dct)} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(wavelet)} fill="none" stroke="var(--ink)" strokeWidth={2.4} />
        {current && current.bpp <= xmax && (
          <g>
            <line x1={X(current.bpp)} x2={X(current.bpp)} y1={m.t} y2={H - m.b} stroke="var(--ink)" strokeDasharray="2 3" opacity={0.6} />
            {Number.isFinite(current.dct) && <circle cx={X(current.bpp)} cy={Y(current.dct)} r={5} fill="var(--paper)" stroke="var(--muted)" strokeWidth={2} />}
            {Number.isFinite(current.wav) && <circle cx={X(current.bpp)} cy={Y(current.wav)} r={5.5} fill="var(--accent)" stroke="var(--ink)" strokeWidth={2} />}
          </g>
        )}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--ink)', height: 3, border: 0 }} /> {waveletLabel}
        </span>
        <span>
          <i style={{ background: 'repeating-linear-gradient(90deg, var(--muted) 0 5px, transparent 5px 8px)', height: 3, border: 0 }} /> 8×8 DCT (JPEG’s transform)
        </span>
        <span>
          <i style={{ background: 'var(--accent)', borderRadius: '50%' }} /> where the slider is
        </span>
      </div>
    </div>
  )
}
