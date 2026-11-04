import type { HNode } from '../../lib/huffman'
import { glyph } from '../../lib/text'

/**
 * Draws a forest of Huffman (sub)trees side by side, roots on top. Used for the
 * build (many roots shrinking to one) and for encode/decode (one tree, a path lit).
 *
 * Layout is the simple one: leaves take consecutive columns left to right, an
 * internal node sits midway over its two children, depth sets the row. That keeps
 * every leaf readable, which matters more here than a compact tree.
 */

const UX = 34
const UY = 50
const PAD = 22

interface Pos {
  x: number
  y: number
}

export function layoutForest(roots: HNode[]): { pos: Map<number, Pos>; width: number; height: number } {
  const pos = new Map<number, Pos>()
  let col = 0
  let maxDepth = 0
  const place = (n: HNode, d: number): number => {
    maxDepth = Math.max(maxDepth, d)
    let x: number
    if (!n.left || !n.right) {
      x = col++
    } else {
      const a = place(n.left, d + 1)
      const b = place(n.right, d + 1)
      x = (a + b) / 2
    }
    pos.set(n.id, { x: PAD + x * UX, y: PAD + d * UY })
    return x
  }
  roots.forEach((r, i) => {
    if (i > 0) col += 0.5
    place(r, 0)
  })
  return { pos, width: PAD * 2 + Math.max(0, col - 1) * UX, height: PAD * 2 + maxDepth * UY + 14 }
}

export function TreeView({
  roots,
  hot,
  path,
  pending,
  showBits = true,
  onHoverSymbol,
  symbolClass,
}: {
  roots: HNode[]
  /** Node ids drawn emphasised (e.g. the parent just created and its two children). */
  hot?: Set<number>
  /** Node ids along a root→node path; the edges between them are drawn heavy. */
  path?: number[]
  /** Node ids that are next in line (the two lightest in the queue). */
  pending?: Set<number>
  showBits?: boolean
  onHoverSymbol?: (s: number | null) => void
  symbolClass?: (s: number) => string | undefined
}) {
  const { pos, width, height } = layoutForest(roots)
  const onPath = new Set(path ?? [])
  const pathEdge = new Set<string>()
  if (path) for (let i = 1; i < path.length; i++) pathEdge.add(path[i - 1] + '>' + path[i])

  const edges: JSX.Element[] = []
  const nodes: JSX.Element[] = []
  const visit = (n: HNode) => {
    const p = pos.get(n.id)!
    for (const [child, bit] of [
      [n.left, '0'],
      [n.right, '1'],
    ] as const) {
      if (!child) continue
      const c = pos.get(child.id)!
      const heavy = pathEdge.has(n.id + '>' + child.id)
      edges.push(
        <g key={'e' + child.id}>
          <line x1={p.x} y1={p.y} x2={c.x} y2={c.y} stroke={heavy ? 'var(--ink)' : 'var(--line-strong)'} strokeWidth={heavy ? 3 : 1.2} />
          {showBits && (
            <text
              x={(p.x + c.x) / 2 + (bit === '0' ? -7 : 7)}
              y={(p.y + c.y) / 2 + 2}
              fontSize={10}
              textAnchor="middle"
              fill={heavy ? 'var(--ink)' : 'var(--muted)'}
              fontWeight={heavy ? 700 : 400}
            >
              {bit}
            </text>
          )}
        </g>,
      )
      visit(child)
    }
    const isHot = hot?.has(n.id)
    const isPending = pending?.has(n.id)
    const lit = onPath.has(n.id)
    if (n.symbol !== undefined) {
      const cls = symbolClass?.(n.symbol)
      nodes.push(
        <g
          key={'n' + n.id}
          onMouseEnter={onHoverSymbol ? () => onHoverSymbol(n.symbol!) : undefined}
          onMouseLeave={onHoverSymbol ? () => onHoverSymbol(null) : undefined}
          style={{ cursor: onHoverSymbol ? 'default' : undefined }}
        >
          <rect
            x={p.x - 13}
            y={p.y - 12}
            width={26}
            height={24}
            rx={4}
            fill={isHot || lit ? 'var(--accent)' : cls ? `var(--${cls})` : 'var(--paper)'}
            stroke="var(--ink)"
            strokeWidth={isHot || lit || isPending ? 2.2 : 1}
            strokeDasharray={isPending ? '3 2' : undefined}
          />
          <text x={p.x} y={p.y + 4.5} fontSize={12.5} textAnchor="middle" fill={isHot || lit || cls ? 'var(--hl-ink)' : 'var(--ink)'}>
            {glyph(n.symbol)}
          </text>
          <text x={p.x} y={p.y + 25} fontSize={9.5} textAnchor="middle" fill="var(--muted)">
            {n.weight}
          </text>
        </g>,
      )
    } else {
      nodes.push(
        <g key={'n' + n.id}>
          <circle
            cx={p.x}
            cy={p.y}
            r={11}
            fill={isHot ? 'var(--accent)' : lit ? 'var(--ink)' : 'var(--card)'}
            stroke="var(--ink)"
            strokeWidth={isHot || isPending ? 2.2 : 1.2}
            strokeDasharray={isPending ? '3 2' : undefined}
          />
          <text x={p.x} y={p.y + 3.5} fontSize={9.5} textAnchor="middle" fill={lit && !isHot ? 'var(--paper)' : isHot ? 'var(--hl-ink)' : 'var(--ink)'}>
            {n.weight}
          </text>
        </g>,
      )
    }
  }
  roots.forEach(visit)

  return (
    <div className="scroll-x">
      <svg width={Math.max(width, 120)} height={height} style={{ display: 'block', margin: '0 auto' }}>
        {edges}
        {nodes}
      </svg>
    </div>
  )
}
