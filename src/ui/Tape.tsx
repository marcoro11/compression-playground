import type { ReactNode } from 'react'
import { glyph, hex2, isOpaque } from '../lib/text'

/**
 * A strip of bytes, one cell each — the site's basic unit of display.
 *
 * `mark(i)` returns extra class names for cell i. The vocabulary is shared
 * across exhibits so a colour means the same thing everywhere:
 *
 *   hl-1 … hl-6   highlighter colours (yellow, pink, green, blue, orange, violet)
 *   cur           the read head / current position (outlined)
 *   dim           already consumed, or outside the window
 *   src / dst     the two ends of a copy (LZ77 source, destination)
 */
export function Tape({
  bytes,
  mark,
  index = false,
  onHover,
  onClick,
  cellTitle,
  render,
  wrap = true,
  className,
}: {
  bytes: ArrayLike<number>
  mark?: (i: number) => string | undefined
  /** Show position numbers under every 8th cell. */
  index?: boolean
  onHover?: (i: number | null) => void
  onClick?: (i: number) => void
  cellTitle?: (i: number) => string
  /** Custom cell content; defaults to `glyph(byte)`. */
  render?: (i: number) => ReactNode
  wrap?: boolean
  className?: string
}) {
  const cells = []
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    const m = mark?.(i)
    cells.push(
      <span
        key={i}
        className={'cell' + (isOpaque(b) && !render ? ' hex' : '') + (m ? ' ' + m : '') + (onClick ? ' clickable' : '')}
        title={cellTitle ? cellTitle(i) : `#${i}  0x${hex2(b)}  ${b}`}
        onMouseEnter={onHover ? () => onHover(i) : undefined}
        onClick={onClick ? () => onClick(i) : undefined}
      >
        {render ? render(i) : glyph(b)}
        {index && i % 8 === 0 && <sub>{i}</sub>}
      </span>,
    )
  }
  return (
    <div className={'tape' + (wrap ? ' wrap' : ' nowrap') + (index ? ' indexed' : '') + (className ? ' ' + className : '')} onMouseLeave={onHover ? () => onHover(null) : undefined}>
      {cells}
    </div>
  )
}

/**
 * A run of bits, grouped and coloured by span. `spans` partition (some of) the
 * stream; bits outside every span render plain.
 */
export function BitRow({
  bits,
  spans = [],
  active,
  group = 0,
  onHover,
}: {
  bits: string
  spans?: { start: number; length: number; className: string; title?: string }[]
  /** Span index to emphasise. */
  active?: number
  /** Insert a thin gap every `group` bits (8 = byte boundaries). 0 = off. */
  group?: number
  onHover?: (spanIndex: number | null) => void
}) {
  const out: ReactNode[] = []
  let pos = 0
  const pushPlain = (from: number, to: number) => {
    for (let i = from; i < to; i++) out.push(<i key={'p' + i} className={'bit' + (group && i % group === 0 && i ? ' gap' : '')}>{bits[i]}</i>)
  }
  spans.forEach((s, k) => {
    if (s.start > pos) pushPlain(pos, s.start)
    const inner: ReactNode[] = []
    for (let i = s.start; i < s.start + s.length && i < bits.length; i++) {
      inner.push(<i key={i} className={'bit' + (group && i % group === 0 && i ? ' gap' : '')}>{bits[i]}</i>)
    }
    out.push(
      <span
        key={'s' + k}
        className={'bitspan ' + s.className + (active === k ? ' active' : '')}
        title={s.title}
        onMouseEnter={onHover ? () => onHover(k) : undefined}
        onMouseLeave={onHover ? () => onHover(null) : undefined}
      >
        {inner}
      </span>,
    )
    pos = Math.max(pos, s.start + s.length)
  })
  if (pos < bits.length) pushPlain(pos, bits.length)
  return <div className="bitrow">{out}</div>
}
