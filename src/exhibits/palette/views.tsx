import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Theme } from '../../lib/theme'
import type { Box, DiffuseStep, RGB, TableEntry } from './quant'

/**
 * Drawing pieces for the palette exhibit: an RGB image canvas (with optional
 * "only this palette entry" highlighting and a selection rectangle), a
 * rotatable 3-D scatter of the colour cube, and the magnified error-diffusion
 * grid.
 */

const css = (c: ArrayLike<number>) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`

/** Packed RGB into a canvas drawn 1:1 (CSS scales it, pixelated). */
export function RgbCanvas({
  data,
  w,
  h,
  idx,
  only,
}: {
  data: Uint8ClampedArray
  w: number
  h: number
  /** Palette index per pixel; with `only`, every other entry is greyed out. */
  idx?: Uint8Array
  only?: number | null
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(w, h)
    for (let i = 0; i < w * h; i++) {
      let r = data[3 * i]
      let g = data[3 * i + 1]
      let b = data[3 * i + 2]
      if (idx && only !== null && only !== undefined && idx[i] !== only) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        r = g = b = 128 + (y - 128) * 0.25
      }
      img.data[4 * i] = r
      img.data[4 * i + 1] = g
      img.data[4 * i + 2] = b
      img.data[4 * i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [data, w, h, idx, only])
  return <canvas ref={ref} className="pl-pixelated" />
}

export function Pane({
  title,
  sub,
  size,
  sel,
  onPick,
  children,
}: {
  title: ReactNode
  sub?: ReactNode
  size: number
  /** Selection rectangle in image pixels. */
  sel?: { x: number; y: number; w: number; h: number }
  onPick?: (x: number, y: number) => void
  children: ReactNode
}) {
  const pct = (v: number) => `${(v / size) * 100}%`
  return (
    <figure className="pl-pane">
      <div
        className={'pl-frame' + (onPick ? ' pickable' : '')}
        onClick={(e) => {
          if (!onPick) return
          const r = e.currentTarget.getBoundingClientRect()
          onPick(Math.floor(((e.clientX - r.left) / r.width) * size), Math.floor(((e.clientY - r.top) / r.height) * size))
        }}
      >
        {children}
        {sel && <span className="pl-sel" style={{ left: pct(sel.x), top: pct(sel.y), width: pct(sel.w), height: pct(sel.h) }} />}
      </div>
      <figcaption>
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </figcaption>
    </figure>
  )
}

// ------------------------------------------------------------- 3-D scatter

interface View {
  yaw: number
  pitch: number
}

const CORNERS: RGB[] = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

function project(v: ArrayLike<number>, view: View, cx: number, cy: number, s: number, o: ArrayLike<number>): [number, number, number] {
  // Axes: red → x, green → up, blue → depth. `o` is the point that lands in the middle.
  const x = v[0] - o[0]
  const y = v[1] - o[1]
  const z = v[2] - o[2]
  const cyw = Math.cos(view.yaw)
  const syw = Math.sin(view.yaw)
  const x1 = x * cyw + z * syw
  const z1 = -x * syw + z * cyw
  const cp = Math.cos(view.pitch)
  const sp = Math.sin(view.pitch)
  const y2 = y * cp - z1 * sp
  const z2 = y * sp + z1 * cp
  return [cx + x1 * s, cy - y2 * s, z2]
}

function boxCorners(min: ArrayLike<number>, max: ArrayLike<number>): number[][] {
  const out: number[][] = []
  for (let i = 0; i < 8; i++) out.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]])
  return out
}

const EDGES: [number, number][] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

/**
 * The colour cloud in the RGB cube. Drag to turn it. Points are the image's
 * colours (the most-used few thousand), sized by how many pixels use them.
 */
export function Scatter({
  table,
  boxes,
  hot,
  cut,
  centres,
  moved,
  theme,
}: {
  table: TableEntry[]
  boxes?: Box[]
  /** Box indices to emphasise (the two halves of the latest split). */
  hot?: number[]
  /** The plane of the latest cut, drawn across the parent box. */
  cut?: { axis: 0 | 1 | 2; at: number; min: RGB; max: RGB }
  centres?: RGB[]
  /** Where each centre is about to move. */
  moved?: RGB[]
  theme: Theme
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ yaw: -0.65, pitch: 0.42 })
  const [width, setWidth] = useState(520)
  const [fit, setFit] = useState(true)
  const drag = useRef<{ x: number; y: number; v: View } | null>(null)

  const points = useMemo(() => {
    const sorted = table.slice().sort((a, b) => b.n - a.n)
    return sorted.slice(0, 2600)
  }, [table])
  const maxN = points.length ? points[0].n : 1
  // Zoom to the image's own colours: centre on their bounding box, scale to its size.
  const frame = useMemo(() => {
    if (!fit || !points.length) return { o: [127.5, 127.5, 127.5], half: 127.5 * Math.sqrt(3) * 0.62 }
    const lo = [255, 255, 255]
    const hi = [0, 0, 0]
    for (const p of points)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], p.c[c])
        hi[c] = Math.max(hi[c], p.c[c])
      }
    const half = Math.max(45, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
    return { o: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], half }
  }, [fit, points])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.min(640, el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = Math.round(width * 0.64)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = H * dpr
    c.style.width = width + 'px'
    c.style.height = H + 'px'
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, H)
    const s = (Math.min(width, H) * 0.44) / frame.half
    const cx = width / 2
    const cy = H / 2
    const P = (v: ArrayLike<number>) => project(v, view, cx, cy, s, frame.o)

    const lineBox = (min: ArrayLike<number>, max: ArrayLike<number>, stroke: string, lw: number, dash?: number[]) => {
      const cs = boxCorners(min, max).map(P)
      ctx.strokeStyle = stroke
      ctx.lineWidth = lw
      ctx.setLineDash(dash ?? [])
      ctx.beginPath()
      for (const [a, b] of EDGES) {
        ctx.moveTo(cs[a][0], cs[a][1])
        ctx.lineTo(cs[b][0], cs[b][1])
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // The cube.
    lineBox([0, 0, 0], [255, 255, 255], theme.lineStrong, 1, [3, 3])
    // Points, far to near.
    const proj = points.map((p) => ({ p, q: P(p.c) }))
    proj.sort((a, b) => a.q[2] - b.q[2])
    for (const { p, q } of proj) {
      const r = 1.7 + 3 * Math.sqrt(p.n / maxN)
      ctx.fillStyle = css(p.c)
      ctx.fillRect(q[0] - r, q[1] - r, 2 * r, 2 * r)
    }
    // Boxes.
    if (boxes) {
      boxes.forEach((b, i) => {
        if (hot?.includes(i)) return
        lineBox(b.min, b.max, theme.ink2, 0.8)
      })
      if (cut) {
        // The cut plane across the parent box.
        const a = cut.axis
        const quad: number[][] = []
        const o = [(a + 1) % 3, (a + 2) % 3]
        for (const [u, v] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]) {
          const p = [0, 0, 0]
          p[a] = cut.at
          p[o[0]] = u ? cut.max[o[0]] : cut.min[o[0]]
          p[o[1]] = v ? cut.max[o[1]] : cut.min[o[1]]
          quad.push(p)
        }
        const qs = quad.map(P)
        ctx.fillStyle = theme.accent
        ctx.globalAlpha = 0.35
        ctx.beginPath()
        qs.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])))
        ctx.closePath()
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = theme.ink
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      for (const i of hot ?? []) if (boxes[i]) lineBox(boxes[i].min, boxes[i].max, theme.ink, 2.2)
      // Box means as palette dots.
      for (const b of boxes) {
        const q = P(b.mean)
        ctx.fillStyle = css(b.mean)
        ctx.strokeStyle = theme.ink
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(q[0], q[1], 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
    if (centres) {
      centres.forEach((c, i) => {
        const q = P(c)
        if (moved && moved[i]) {
          const m = P(moved[i])
          ctx.strokeStyle = theme.ink
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.moveTo(q[0], q[1])
          ctx.lineTo(m[0], m[1])
          ctx.stroke()
        }
        ctx.fillStyle = css(c)
        ctx.strokeStyle = theme.ink
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(q[0], q[1], 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      })
    }
    // Cube corners, labelled with the colour they are.
    ctx.font = '10px "IBM Plex Mono", monospace'
    const names = ['black', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white']
    CORNERS.forEach((c, i) => {
      const q = P(c)
      ctx.fillStyle = css(c)
      ctx.strokeStyle = theme.ink
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.rect(q[0] - 4, q[1] - 4, 8, 8)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = theme.muted
      ctx.fillText(names[i], q[0] + 7, q[1] + 3)
    })
  }, [points, maxN, boxes, hot, cut, centres, moved, view, theme, width, H, frame])

  return (
    <div ref={wrap} className="pl-scatter">
      <canvas
        ref={ref}
        onPointerDown={(e) => {
          ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, v: view }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          setView({ yaw: d.v.yaw + (e.clientX - d.x) * 0.01, pitch: Math.max(-1.4, Math.min(1.4, d.v.pitch + (e.clientY - d.y) * 0.01)) })
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
      <button type="button" className="pl-zoom" onClick={() => setFit(!fit)} title="Zoom">
        {fit ? 'show whole cube' : 'zoom to the colours'}
      </button>
      <span className="pl-hint">drag to turn</span>
    </div>
  )
}

// ------------------------------------------------------- diffusion close-up

/** Signed, rounded, and never "−0". */
export const fmtE = (v: number) => {
  const r = Math.round(v)
  return r === 0 ? '0' : (r > 0 ? '+' : '−') + Math.abs(r)
}

/**
 * The magnified window: every pixel as a cell showing the colour it currently
 * *wants* (original + error received so far); processed cells show the palette
 * colour they got. The current pixel is outlined and arrows carry its error to
 * the neighbours with the kernel's fractions.
 */
export function DiffuseGrid({ w, h, step, palette, original }: { w: number; h: number; step: DiffuseStep | null; palette: RGB[]; original: Uint8ClampedArray }) {
  const cell = 34
  const W = w * cell
  const H = h * cell
  const cur = step
  const target = (x: number, y: number) => {
    if (!cur) return [original[3 * (y * w + x)], original[3 * (y * w + x) + 1], original[3 * (y * w + x) + 2]]
    const p = 3 * (y * w + x)
    return [cur.buf[p], cur.buf[p + 1], cur.buf[p + 2]]
  }
  const cells: ReactNode[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const doneIdx = cur ? cur.done[p] : -1
      const isCur = cur && cur.x === x && cur.y === y
      const want = target(x, y).map((v) => Math.max(0, Math.min(255, v)))
      cells.push(
        <g key={p}>
          {doneIdx >= 0 && !isCur ? (
            <rect x={x * cell} y={y * cell} width={cell} height={cell} fill={css(palette[doneIdx])} />
          ) : (
            <>
              <rect x={x * cell} y={y * cell} width={cell} height={cell} fill={css(want)} />
              {isCur && <rect x={x * cell + cell * 0.22} y={y * cell + cell * 0.22} width={cell * 0.56} height={cell * 0.56} fill={css(palette[cur!.chosen])} stroke="#000" strokeWidth={0.8} />}
            </>
          )}
          <rect x={x * cell + 0.5} y={y * cell + 0.5} width={cell - 1} height={cell - 1} fill="none" stroke="var(--line)" />
        </g>,
      )
    }
  const arrows: ReactNode[] = []
  const labels: ReactNode[] = []
  if (cur) {
    const ox = cur.x * cell + cell / 2
    const oy = cur.y * cell + cell / 2
    cur.pushes.forEach((t, i) => {
      if (!t.inside) return
      const tx = t.x * cell + cell / 2
      const ty = t.y * cell + cell / 2
      const len = Math.hypot(tx - ox, ty - oy)
      const ux = (tx - ox) / len
      const uy = (ty - oy) / len
      // Black with a white halo: the cells are arbitrary colours, so the theme's ink would vanish on some of them.
      const line = { x1: ox + ux * 9, y1: oy + uy * 9, x2: tx - ux * 9, y2: ty - uy * 9 }
      arrows.push(
        <g key={i}>
          <line {...line} stroke="#fff" strokeWidth={4} strokeLinecap="round" />
          <line {...line} stroke="#111" strokeWidth={1.6} markerEnd="url(#pl-arrow)" />
        </g>,
      )
      // Labels go on top of every arrow, so a long arrow never crosses a label.
      labels.push(
        <g key={i}>
          <rect x={tx - 13} y={ty - 8} width={26} height={15} rx={3} fill="var(--card)" stroke="var(--ink)" strokeWidth={0.8} />
          <text x={tx} y={ty + 3} fontSize={9.5} textAnchor="middle" fill="var(--ink)">
            {t.num}/{t.den}
          </text>
        </g>,
      )
    })
  }
  return (
    <div className="pl-diffuse scroll-x">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: '100%', height: 'auto' }}>
        <defs>
          <marker id="pl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#111" stroke="#fff" strokeWidth={1} />
          </marker>
        </defs>
        {cells}
        {cur && (
          <>
            <rect x={cur.x * cell + 1.5} y={cur.y * cell + 1.5} width={cell - 3} height={cell - 3} fill="none" stroke="#fff" strokeWidth={4} />
            <rect x={cur.x * cell + 1.5} y={cur.y * cell + 1.5} width={cell - 3} height={cell - 3} fill="none" stroke="#111" strokeWidth={2} />
          </>
        )}
        {arrows}
        {labels}
      </svg>
    </div>
  )
}

/** One step's arithmetic, as a small table: wanted, chosen, error. */
export function DiffuseReadout({ step, palette }: { step: DiffuseStep; palette: RGB[] }) {
  const ch = palette[step.chosen]
  const row = (label: string, v: ArrayLike<number>, swatch: boolean, signed = false) => (
    <tr>
      <td>{label}</td>
      <td>{swatch && <i className="pl-chip" style={{ background: css(v.length ? [0, 1, 2].map((i) => Math.max(0, Math.min(255, v[i]))) : [0, 0, 0]) }} />}</td>
      {[0, 1, 2].map((c) => (
        <td key={c} className="num">
          {signed ? fmtE(v[c]) : Math.round(v[c])}
        </td>
      ))}
    </tr>
  )
  return (
    <div className="table-wrap">
      <table className="data pl-readout">
        <thead>
          <tr>
            <th />
            <th />
            <th className="num">R</th>
            <th className="num">G</th>
            <th className="num">B</th>
          </tr>
        </thead>
        <tbody>
          {row('wants (original + carried error)', step.want, true)}
          {row(`nearest palette entry #${step.chosen}`, ch, true)}
          {row('error to pass on', step.err, false, true)}
        </tbody>
      </table>
    </div>
  )
}

/** Palette swatches with a usage bar; hovering one isolates its pixels in the image above. */
export function Swatches({ palette, usage, onHover, hover }: { palette: RGB[]; usage: number[]; onHover: (i: number | null) => void; hover: number | null }) {
  const total = usage.reduce((a, b) => a + b, 0) || 1
  const order = palette.map((_, i) => i).sort((a, b) => usage[b] - usage[a] || a - b)
  const max = Math.max(1, ...usage)
  return (
    <div className="pl-swatches" onMouseLeave={() => onHover(null)}>
      {order.map((i) => (
        <button
          type="button"
          key={i}
          className={'pl-swatch' + (hover === i ? ' on' : '') + (usage[i] === 0 ? ' unused' : '')}
          onMouseEnter={() => onHover(i)}
          onFocus={() => onHover(i)}
          title={`#${i}  rgb(${palette[i].map((v) => Math.round(v)).join(', ')})  ${usage[i]} px (${((100 * usage[i]) / total).toFixed(1)}%)`}
        >
          <i style={{ background: css(palette[i]) }} />
          <span style={{ width: `${(100 * usage[i]) / max}%` }} />
        </button>
      ))}
    </div>
  )
}

/** Distortion per iteration as a tiny line chart. */
export function Sparkline({ values, at, theme }: { values: number[]; at: number; theme: Theme }) {
  const W = 220
  const H = 56
  if (values.length < 1) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const x = (i: number) => 6 + (i / Math.max(1, values.length - 1)) * (W - 12)
  const y = (v: number) => 6 + (1 - (v - min) / Math.max(1e-9, max - min)) * (H - 16)
  const d = values.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(v)}`).join(' ')
  return (
    <svg width={W} height={H} className="pl-spark" aria-label="distortion per iteration">
      <path d={d} fill="none" stroke={theme.ink} strokeWidth={1.5} />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={i === at ? 4 : 2} fill={i === at ? theme.accent : theme.ink} stroke={theme.ink} />
      ))}
      <text x={W - 4} y={H - 2} fontSize={9} textAnchor="end" fill={theme.muted}>
        iteration
      </text>
    </svg>
  )
}

