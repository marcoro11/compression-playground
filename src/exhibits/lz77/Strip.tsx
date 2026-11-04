import { useEffect, useRef } from 'react'
import { glyph, hex2, isOpaque } from '../../lib/text'

/**
 * A one-line tape of fixed-pitch cells with an arc drawn over it from a copy's
 * destination back to its source, and labelled bands underneath (search
 * window, lookahead). Fixed pitch is what lets the arc be computed rather than
 * measured, and the strip scrolls itself to keep the action in view.
 */

const PITCH = 26 // 24px cell + 2px gap
const ARC_H = 58
const CELL_H = 26

export interface Arc {
  /** Source range [start, start+len). */
  src: number
  /** Destination range [start, start+len). */
  dst: number
  len: number
  label: string
}

export interface Band {
  start: number
  len: number
  label: string
  className: string
  row: 0 | 1
}

const cx = (i: number) => i * PITCH + 12

export function Strip({
  bytes,
  mark,
  arc,
  bands = [],
  focus,
  onCellClick,
  cellTitle,
}: {
  bytes: ArrayLike<number>
  mark?: (i: number) => string | undefined
  arc?: Arc | null
  bands?: Band[]
  /** Index to keep scrolled into view. */
  focus?: number
  onCellClick?: (i: number) => void
  cellTitle?: (i: number) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const n = bytes.length
  const width = Math.max(n * PITCH, 40)
  const height = ARC_H + CELL_H + 16 + 2 * 18

  useEffect(() => {
    const el = ref.current
    if (!el || focus === undefined) return
    const x = cx(focus)
    const left = el.scrollLeft
    const w = el.clientWidth
    if (x < left + 60 || x > left + w - 120) {
      const target = Math.max(0, x - w * 0.55)
      if (typeof el.scrollTo === 'function') el.scrollTo({ left: target, behavior: Math.abs(target - left) > w ? 'auto' : 'smooth' })
      else el.scrollLeft = target
    }
  }, [focus])

  let arcEl = null
  if (arc && arc.len > 0) {
    const a = arc.src * PITCH + (arc.len * PITCH - 2) / 2
    const b = arc.dst * PITCH + (arc.len * PITCH - 2) / 2
    const dist = Math.abs(b - a)
    const h = Math.min(ARC_H - 16, 14 + dist * 0.18)
    const y = ARC_H - 4
    const mid = (a + b) / 2
    arcEl = (
      <g>
        <line x1={arc.src * PITCH} x2={(arc.src + arc.len) * PITCH - 2} y1={y} y2={y} stroke="var(--ink)" strokeWidth={2} />
        <line x1={arc.dst * PITCH} x2={(arc.dst + arc.len) * PITCH - 2} y1={y} y2={y} stroke="var(--ink)" strokeWidth={2} strokeDasharray="4 3" />
        <path d={`M ${b} ${y} C ${b} ${y - h}, ${a} ${y - h}, ${a} ${y - 2}`} fill="none" stroke="var(--ink)" strokeWidth={1.6} markerEnd="url(#lz-arrow)" />
        <g transform={`translate(${mid}, ${y - h * 0.75 - 6})`}>
          <rect x={-arc.label.length * 3.4 - 6} y={-10} width={arc.label.length * 6.8 + 12} height={17} rx={3} fill="var(--hl-1)" stroke="var(--ink)" />
          <text x={0} y={2.5} fontSize={10.5} textAnchor="middle" fill="var(--hl-ink)">
            {arc.label}
          </text>
        </g>
      </g>
    )
  }

  return (
    <div className="lz-strip" ref={ref}>
      <div className="lz-strip-inner" style={{ width, height }}>
        <svg className="lz-arc" width={width} height={ARC_H}>
          <defs>
            <marker id="lz-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink)" />
            </marker>
          </defs>
          {arcEl}
        </svg>
        <div className="lz-cells" style={{ top: ARC_H }}>
          {Array.from({ length: n }, (_, i) => {
            const b = bytes[i]
            const m = mark?.(i)
            return (
              <span
                key={i}
                className={'cell' + (isOpaque(b) ? ' hex' : '') + (m ? ' ' + m : '') + (onCellClick ? ' clickable' : '')}
                title={cellTitle ? cellTitle(i) : `#${i}  0x${hex2(b)}`}
                onClick={onCellClick ? () => onCellClick(i) : undefined}
              >
                {glyph(b)}
              </span>
            )
          })}
        </div>
        <div className="lz-index" style={{ top: ARC_H + CELL_H + 2 }}>
          {Array.from({ length: Math.ceil(n / 8) }, (_, k) => (
            <span key={k} style={{ left: k * 8 * PITCH }}>
              {k * 8}
            </span>
          ))}
        </div>
        {bands.map((b, k) =>
          b.len > 0 ? (
            <div
              key={k}
              className={'lz-band ' + b.className}
              style={{ left: b.start * PITCH, width: b.len * PITCH - 2, top: ARC_H + CELL_H + 18 + b.row * 18 }}
              title={b.label}
            >
              <span>{b.label}</span>
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}
