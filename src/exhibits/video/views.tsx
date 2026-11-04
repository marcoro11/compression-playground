import { useEffect, useRef, type ReactNode } from 'react'
import { fmtHalf, px, type Frame, type SearchStep } from './motion'
import { H, W } from './frames'
import type { FrameResult } from './encoder'

/**
 * Drawing pieces for the motion-compensation exhibit. Pictures are pictures —
 * greyscale stays greyscale in either colour scheme — and signed images
 * (residuals, differences) use mid-grey for zero, orange for "brighter than
 * predicted" and blue for "darker", amplified so small errors are visible.
 */

/** Signed value → RGB on a grey base. */
export function signedRGB(v: number, gain: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, (v * gain) / 128))
  if (t >= 0) return [128 + 127 * t, 128 + 22 * t, 128 - 98 * t]
  const u = -t
  return [128 - 98 * u, 128 + 2 * u, 128 + 127 * u]
}

type Overlay = (ctx: CanvasRenderingContext2D, scale: number) => void

/**
 * A frame-sized canvas drawn at `scale`× (pixelated), with an optional vector
 * overlay drawn at full resolution on top. `signed` switches to the residual map.
 */
export function FrameCanvas({
  data,
  w = W,
  h = H,
  signed,
  gain = 3,
  overlay,
  scale = 3,
  onPick,
  dim,
}: {
  data: ArrayLike<number> | null
  w?: number
  h?: number
  signed?: boolean
  gain?: number
  overlay?: Overlay
  scale?: number
  onPick?: (x: number, y: number) => void
  dim?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = w * scale
    c.height = h * scale
    const ctx = c.getContext('2d')
    if (!ctx) return
    const small = document.createElement('canvas')
    small.width = w
    small.height = h
    const sctx = small.getContext('2d')!
    const img = sctx.createImageData(w, h)
    for (let i = 0; i < w * h; i++) {
      let r: number
      let g: number
      let b: number
      if (!data) r = g = b = 128
      else if (signed) [r, g, b] = signedRGB(data[i], gain)
      else r = g = b = data[i]
      if (dim) {
        r = 128 + (r - 128) * 0.35
        g = 128 + (g - 128) * 0.35
        b = 128 + (b - 128) * 0.35
      }
      img.data[i * 4] = r
      img.data[i * 4 + 1] = g
      img.data[i * 4 + 2] = b
      img.data[i * 4 + 3] = 255
    }
    sctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, 0, 0, w * scale, h * scale)
    overlay?.(ctx, scale)
  }, [data, w, h, signed, gain, overlay, scale, dim])
  return (
    <canvas
      ref={ref}
      className={'vd-canvas' + (onPick ? ' pickable' : '')}
      style={{ aspectRatio: `${w} / ${h}` }}
      onClick={
        onPick
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onPick(((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h)
            }
          : undefined
      }
    />
  )
}

/** Arrow with a dark outline and a bright core, readable over any picture. */
export function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, s: number, color = '#ffd23f') {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const draw = (width: number, stroke: string) => {
    ctx.strokeStyle = stroke
    ctx.fillStyle = stroke
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    if (len > 2 * s) {
      const a = Math.atan2(y2 - y1, x2 - x1)
      const hl = Math.min(3.2 * s, len * 0.6)
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - hl * Math.cos(a - 0.5), y2 - hl * Math.sin(a - 0.5))
      ctx.lineTo(x2 - hl * Math.cos(a + 0.5), y2 - hl * Math.sin(a + 0.5))
      ctx.closePath()
      ctx.fill()
    }
  }
  draw(s * 0.9 + 2, 'rgba(0,0,0,0.75)')
  draw(s * 0.55, color)
}

/** Vectors are drawn this many times longer than they are: a 1.5 px pan would otherwise be a dot. */
export const ARROW_GAIN = 3

/** The vector field of a P-frame: one arrow per macroblock, from its centre to where it was found in the reference. */
export function vectorOverlay(f: FrameResult | undefined, bs: number, selected: number | null): Overlay {
  return (ctx, s) => {
    const cols = W / bs
    if (f?.type === 'P')
      for (const mb of f.mbs!) {
        const cx = (mb.x + bs / 2) * s
        const cy = (mb.y + bs / 2) * s
        if (mb.mv.mx === 0 && mb.mv.my === 0) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)'
          ctx.beginPath()
          ctx.arc(cx, cy, s * 0.9, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#ffd23f'
          ctx.beginPath()
          ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2)
          ctx.fill()
        } else arrow(ctx, cx, cy, cx + (mb.mv.mx / 2) * s * ARROW_GAIN, cy + (mb.mv.my / 2) * s * ARROW_GAIN, s / 2.2)
      }
    if (selected !== null) {
      const x = (selected % cols) * bs * s
      const y = Math.floor(selected / cols) * bs * s
      ctx.lineWidth = 3
      ctx.strokeStyle = '#000'
      ctx.strokeRect(x, y, bs * s, bs * s)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#ffd23f'
      ctx.strokeRect(x, y, bs * s, bs * s)
    }
  }
}

/** A small block (bs×bs) magnified, plain or signed. */
export function BlockCanvas({ data, size, signed, gain = 3, px: cell = 8 }: { data: ArrayLike<number>; size: number; signed?: boolean; gain?: number; px?: number }) {
  return <FrameCanvas data={data} w={size} h={size} signed={signed} gain={gain} scale={cell} />
}

/**
 * The search window around one macroblock in the reference frame, magnified,
 * with the probes of every step so far drawn on top: faint for earlier steps,
 * bold for the current one, and the best-so-far candidate outlined.
 */
export function SearchWindow({
  refFrame,
  x0,
  y0,
  bs,
  R,
  steps,
  upto,
  showBest,
}: {
  refFrame: Frame
  x0: number
  y0: number
  bs: number
  R: number
  steps: SearchStep[]
  /** Steps 0 … upto−1 are drawn; the last of them is "current". */
  upto: number
  showBest: boolean
}) {
  const side = bs + 2 * R
  const data = new Uint8ClampedArray(side * side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) data[y * side + x] = px(refFrame, x0 - R + x, y0 - R + y)
  const scale = Math.max(4, Math.floor(288 / side))
  const overlay: Overlay = (ctx, s) => {
    // Co-located position: where the block would be with no motion.
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.strokeRect(R * s, R * s, bs * s, bs * s)
    ctx.setLineDash([])
    const centre = (m: number) => (R + m / 2 + bs / 2) * s
    for (let k = 0; k < upto && k < steps.length; k++) {
      const cur = k === upto - 1
      for (const p of steps[k].probes) {
        ctx.beginPath()
        ctx.arc(centre(p.mx), centre(p.my), cur ? s * 0.75 + 1 : s * 0.35 + 0.5, 0, Math.PI * 2)
        ctx.fillStyle = cur ? '#ff5fa2' : 'rgba(255,210,63,0.75)'
        ctx.fill()
        if (cur) {
          ctx.lineWidth = 1
          ctx.strokeStyle = '#000'
          ctx.stroke()
        }
      }
    }
    if (showBest && upto > 0) {
      const b = steps[Math.min(upto, steps.length) - 1].best
      const x = (R + b.mx / 2) * s
      const y = (R + b.my / 2) * s
      ctx.lineWidth = 3.5
      ctx.strokeStyle = '#000'
      ctx.strokeRect(x, y, bs * s, bs * s)
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ffd23f'
      ctx.strokeRect(x, y, bs * s, bs * s)
      arrow(ctx, centre(0), centre(0), centre(b.mx), centre(b.my), Math.max(2, s / 2.5))
    }
  }
  return <FrameCanvas data={data} w={side} h={side} scale={scale} overlay={overlay} />
}

/** An 8×8 grid of quantised coefficients: non-zeros highlighted. */
export function CoefGrid({ q, title }: { q: ArrayLike<number>; title?: ReactNode }) {
  let nz = 0
  for (let i = 0; i < 64; i++) if (q[i]) nz++
  return (
    <figure className="vd-coef">
      <div className="vd-coef-grid">
        {Array.from({ length: 64 }, (_, i) => (
          <span key={i} className={q[i] ? 'nz' : ''}>
            {q[i] || ''}
          </span>
        ))}
      </div>
      <figcaption>
        {title} · {nz} non-zero
      </figcaption>
    </figure>
  )
}

export const fmtMV = (mx: number, my: number) => `(${fmtHalf(mx)}, ${fmtHalf(my)})`

export function fmtBits(b: number): string {
  if (b < 10000) return b.toLocaleString('en-US') + ' bits'
  return (b / 8 / 1024).toFixed(1) + ' KiB'
}
