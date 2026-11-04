import type { ReactNode } from 'react'

/**
 * A small drawing per exhibit for the index cards — each one the picture the
 * exhibit is about, drawn in the shared highlighter colours so it follows the
 * colour scheme. 300 × 112 viewBox.
 */

const W = 300
const H = 112
const ink = 'var(--ink)'
const muted = 'var(--muted)'
const hl = (n: number) => `var(--hl-${n})`

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {children}
    </svg>
  )
}

function Cell({ x, y, w = 18, h = 20, fill = 'var(--paper)', ch, stroke = 'var(--line-strong)' }: { x: number; y: number; w?: number; h?: number; fill?: string; ch?: string; stroke?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={2} fill={fill} stroke={stroke} />
      {ch && (
        <text x={x + w / 2} y={y + h / 2 + 4} textAnchor="middle" fontSize={11} fill={ink}>
          {ch}
        </text>
      )}
    </g>
  )
}

const entropy = () => {
  const bars = [0.9, 0.62, 0.48, 0.3, 0.22, 0.16, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03]
  return (
    <Svg>
      {bars.map((b, i) => (
        <rect key={i} x={28 + i * 20} y={96 - b * 76} width={14} height={b * 76} fill={i < 3 ? hl(1) : 'var(--line-strong)'} stroke={ink} strokeWidth={i < 3 ? 1 : 0} />
      ))}
      <line x1={18} x2={282} y1={58} y2={58} stroke={ink} strokeDasharray="5 4" strokeWidth={1.5} />
      <text x={282} y={52} textAnchor="end" fontSize={10} fill={ink}>
        H = 3.12 bits
      </text>
      <line x1={18} x2={282} y1={96} y2={96} stroke={ink} />
    </Svg>
  )
}

const rle = () => {
  const runs = [5, 2, 7, 1, 3, 6, 2]
  let x = 20
  const cells: ReactNode[] = []
  const labels: ReactNode[] = []
  runs.forEach((r, k) => {
    const w = r * 10
    cells.push(<rect key={'c' + k} x={x} y={30} width={w} height={26} fill={k % 2 ? ink : 'var(--paper)'} stroke={ink} />)
    labels.push(
      <g key={'l' + k}>
        <rect x={x + w / 2 - 9} y={66} width={18} height={18} rx={3} fill={hl(2)} stroke={ink} />
        <text x={x + w / 2} y={79} textAnchor="middle" fontSize={10.5} fill="var(--hl-ink)">
          {r}
        </text>
      </g>,
    )
    x += w
  })
  return (
    <Svg>
      {cells}
      {labels}
    </Svg>
  )
}

const huffman = () => {
  const nodes: [number, number, string?][] = [
    [150, 16],
    [90, 46],
    [210, 46, 'e'],
    [55, 76, 't'],
    [125, 76],
    [100, 102, 'q'],
    [150, 102, 'z'],
  ]
  const edges: [number, number, string][] = [
    [0, 1, '0'],
    [0, 2, '1'],
    [1, 3, '0'],
    [1, 4, '1'],
    [4, 5, '0'],
    [4, 6, '1'],
  ]
  return (
    <Svg>
      {edges.map(([a, b, l], i) => (
        <g key={i}>
          <line x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} stroke={ink} strokeWidth={1.3} />
          <text x={(nodes[a][0] + nodes[b][0]) / 2 + (l === '0' ? -8 : 8)} y={(nodes[a][1] + nodes[b][1]) / 2} fontSize={9} fill={muted} textAnchor="middle">
            {l}
          </text>
        </g>
      ))}
      {nodes.map(([x, y, s], i) =>
        s ? (
          <g key={i}>
            <rect x={x - 10} y={y - 9} width={20} height={18} rx={3} fill={hl(3)} stroke={ink} />
            <text x={x} y={y + 4} fontSize={11} textAnchor="middle" fill="var(--hl-ink)">
              {s}
            </text>
          </g>
        ) : (
          <circle key={i} cx={x} cy={y} r={5} fill="var(--paper)" stroke={ink} strokeWidth={1.3} />
        ),
      )}
    </Svg>
  )
}

const arithmetic = () => {
  const rows = [
    [0, 1],
    [0.2, 0.7],
    [0.45, 0.6],
    [0.5, 0.55],
  ]
  return (
    <Svg>
      {rows.map(([lo, hi], i) => {
        const y = 14 + i * 24
        return (
          <g key={i}>
            <rect x={20} y={y} width={260} height={14} fill="var(--paper)" stroke={'var(--line-strong)'} />
            <rect x={20 + lo * 260} y={y} width={(hi - lo) * 260} height={14} fill={hl(4)} stroke={ink} />
            {i < rows.length - 1 && (
              <>
                <line x1={20 + rows[i + 1][0] * 260} y1={y + 14} x2={20} y2={y + 24} stroke={muted} strokeDasharray="2 2" />
                <line x1={20 + rows[i + 1][1] * 260} y1={y + 14} x2={280} y2={y + 24} stroke={muted} strokeDasharray="2 2" />
              </>
            )}
          </g>
        )
      })}
    </Svg>
  )
}

const lz77 = () => {
  const s = 'abcabcabcx'.split('')
  return (
    <Svg>
      {s.map((c, i) => (
        <Cell key={i} x={30 + i * 24} y={58} ch={c} fill={i < 3 ? hl(5) : i < 9 ? 'var(--paper)' : 'var(--paper)'} stroke={i >= 3 && i < 9 ? ink : 'var(--line-strong)'} />
      ))}
      <path d={`M ${30 + 3 * 24 + 9} 56 C ${30 + 3 * 24 + 9} 18, ${30 + 9} 18, ${30 + 9} 56`} fill="none" stroke={ink} strokeWidth={1.5} markerEnd="url(#arr)" />
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={ink} />
        </marker>
      </defs>
      <rect x={120} y={10} width={64} height={18} rx={3} fill={hl(5)} stroke={ink} />
      <text x={152} y={23} textAnchor="middle" fontSize={10.5} fill="var(--hl-ink)">
        ⟨3, 6⟩
      </text>
    </Svg>
  )
}

const lzw = () => {
  const rows = [
    ['256', 'TO'],
    ['257', 'OB'],
    ['258', 'BE'],
    ['259', 'EO'],
    ['260', 'TOB'],
  ]
  return (
    <Svg>
      {rows.map(([code, s], i) => (
        <g key={i}>
          <rect x={70} y={6 + i * 20} width={50} height={18} fill="var(--paper)" stroke={'var(--line-strong)'} />
          <text x={95} y={19 + i * 20} fontSize={10.5} textAnchor="middle" fill={muted}>
            {code}
          </text>
          <rect x={122} y={6 + i * 20} width={100} height={18} fill={i === 4 ? hl(6) : 'var(--paper)'} stroke={i === 4 ? ink : 'var(--line-strong)'} />
          <text x={130} y={19 + i * 20} fontSize={11} fill={i === 4 ? 'var(--hl-ink)' : ink}>
            {s}
          </text>
        </g>
      ))}
    </Svg>
  )
}

const deflate = () => {
  const segs = [
    [3, 6],
    [5, 3],
    [8, 1],
    [4, 4],
    [7, 1],
    [3, 5],
    [9, 2],
    [2, 6],
    [6, 1],
    [4, 4],
    [5, 3],
  ]
  let x = 16
  return (
    <Svg>
      {segs.map(([w, c], i) => {
        const el = <rect key={i} x={x} y={36} width={w * 4.4} height={20} fill={hl(c)} stroke={ink} strokeWidth={0.8} />
        x += w * 4.4 + 1
        return el
      })}
      <text x={16} y={78} fontSize={10.5} fill={muted}>
        1f 8b 08 00 … 0b c9 c8 2c 56
      </text>
      <text x={16} y={26} fontSize={10.5} fill={ink}>
        BFINAL BTYPE HLIT HDIST …
      </text>
    </Svg>
  )
}

const bwt = () => {
  const rows = ['$banana', 'a$banan', 'ana$ban', 'anana$b', 'banana$', 'na$bana', 'nana$ba']
  return (
    <Svg>
      {rows.map((r, i) =>
        r.split('').map((c, j) => (
          <g key={i + ':' + j}>
            {j === 6 && <rect x={96 + j * 16 - 2} y={4 + i * 15} width={15} height={14} fill={hl(1)} />}
            <text x={96 + j * 16 + 5} y={15 + i * 15} fontSize={11} textAnchor="middle" fill={j === 6 ? 'var(--hl-ink)' : j === 0 ? ink : muted}>
              {c}
            </text>
          </g>
        )),
      )}
    </Svg>
  )
}

const jpeg = () => {
  const cells: ReactNode[] = []
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      const mag = Math.exp(-(u + v) / 2.2)
      cells.push(<rect key={u * 8 + v} x={40 + v * 12} y={8 + u * 12} width={11} height={11} fill={u + v < 4 ? hl(5) : 'var(--paper)'} opacity={u + v < 4 ? 0.35 + mag : 1} stroke={'var(--line-strong)'} strokeWidth={0.5} />)
    }
  const px: ReactNode[] = []
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const g = Math.round(128 + 90 * Math.cos(((2 * x + 1) * Math.PI) / 16) * Math.cos(((2 * y + 1) * 2 * Math.PI) / 16))
      px.push(<rect key={y * 8 + x} x={170 + x * 12} y={8 + y * 12} width={12} height={12} fill={`rgb(${g},${g},${g})`} />)
    }
  return (
    <Svg>
      {cells}
      <text x={150} y={60} fontSize={14} textAnchor="middle" fill={ink}>
        ⇄
      </text>
      {px}
    </Svg>
  )
}

const bench = () => {
  const rows = [0.95, 0.62, 0.48, 0.41, 0.36]
  return (
    <Svg>
      {rows.map((r, i) => (
        <g key={i}>
          <rect x={30} y={10 + i * 19} width={240 * r} height={13} fill={i === 0 ? 'var(--line-strong)' : hl(((i + 1) % 6) + 1)} stroke={ink} strokeWidth={0.8} />
        </g>
      ))}
    </Svg>
  )
}

const ans = () => {
  // The state x on a log scale: each symbol pushes it up by log2(1/p); renormalisation drops it back.
  const xs = [30, 52, 61, 84, 46, 70, 92, 55, 63, 88]
  const pts = xs.map((v, i) => [24 + i * 27, 100 - v] as const)
  return (
    <Svg>
      <line x1={18} x2={286} y1={20} y2={20} stroke={muted} strokeDasharray="4 3" />
      <text x={22} y={14} fontSize={9.5} fill={muted}>
        renormalise → emit bits
      </text>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={ink} strokeWidth={1.6} />
      {pts.map(([x, y], i) => (
        <rect key={i} x={x - 4} y={y - 4} width={8} height={8} fill={hl((i % 6) + 1)} stroke={ink} />
      ))}
      <line x1={18} x2={286} y1={100} y2={100} stroke={ink} />
      <text x={22} y={95} fontSize={9.5} fill={muted}>
        log₂ x
      </text>
    </Svg>
  )
}

const intcodes = () => {
  const rows: [string, string][] = [
    ['1', ''],
    ['01', '0'],
    ['01', '1'],
    ['001', '00'],
    ['001', '01'],
    ['0001', '000'],
  ]
  return (
    <Svg>
      {rows.map(([pre, suf], i) => (
        <g key={i}>
          <text x={60} y={18 + i * 16} fontSize={10} textAnchor="end" fill={muted}>
            {i + 1}
          </text>
          {pre.split('').map((b, j) => (
            <Cell key={'p' + j} x={70 + j * 15} y={8 + i * 16} w={14} h={14} ch={b} fill={hl(6)} />
          ))}
          {suf.split('').map((b, j) => (
            <Cell key={'s' + j} x={70 + (pre.length + j) * 15} y={8 + i * 16} w={14} h={14} ch={b} fill={hl(3)} />
          ))}
        </g>
      ))}
      <path d="M 200 98 Q 230 60 280 14" fill="none" stroke={ink} strokeWidth={1.4} />
      <text x={214} y={100} fontSize={9.5} fill={muted}>
        2·log₂n
      </text>
    </Svg>
  )
}

const ppm = () => {
  const ctx = 'compressio'.split('')
  const bars: [string, number][] = [
    ['n', 0.86],
    ['u', 0.06],
    ['esc', 0.08],
  ]
  return (
    <Svg>
      {ctx.map((c, i) => (
        <Cell key={i} x={14 + i * 17} y={14} w={16} h={20} ch={c} fill={i >= 7 ? hl(5) : 'var(--paper)'} />
      ))}
      <Cell x={14 + 10 * 17} y={14} w={16} h={20} ch="?" stroke={ink} />
      {bars.map(([s, p], i) => (
        <g key={s}>
          <text x={34} y={58 + i * 18} fontSize={10.5} textAnchor="end" fill={ink}>
            {s}
          </text>
          <rect x={40} y={48 + i * 18} width={230 * p} height={13} fill={i === 0 ? hl(5) : 'var(--line-strong)'} stroke={ink} strokeWidth={0.8} />
        </g>
      ))}
    </Svg>
  )
}

const png = () => {
  const g = (x: number, y: number) => Math.round(70 + 9 * x + 6 * y)
  const cells: ReactNode[] = []
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 7; x++) {
      const v = g(x, y)
      cells.push(<rect key={x + ':' + y} x={20 + x * 16} y={14 + y * 16} width={15} height={15} fill={`rgb(${v},${v + 20},${v + 40})`} />)
    }
  const lbl = (x: number, y: number, t: string, f: string) => (
    <g>
      <rect x={20 + x * 16} y={14 + y * 16} width={15} height={15} fill={f} stroke={ink} strokeWidth={1.5} />
      <text x={20 + x * 16 + 7.5} y={14 + y * 16 + 11} fontSize={10} textAnchor="middle" fill="var(--hl-ink)">
        {t}
      </text>
    </g>
  )
  return (
    <Svg>
      {cells}
      {lbl(3, 2, 'c', hl(4))}
      {lbl(4, 2, 'b', hl(4))}
      {lbl(3, 3, 'a', hl(4))}
      {lbl(4, 3, 'x', hl(1))}
      <text x={150} y={52} fontSize={11} fill={ink}>
        x − Paeth(a, b, c)
      </text>
      <text x={150} y={72} fontSize={11} fill={muted}>
        = 0, 0, 1, 0, −1, 0 …
      </text>
    </Svg>
  )
}

const flac = () => {
  const n = 120
  let wave = ''
  let res = ''
  for (let i = 0; i < n; i++) {
    const x = 16 + i * 2.25
    const v = Math.sin(i / 7) * 0.7 + Math.sin(i / 2.3) * 0.2
    const r = Math.sin(i * 1.7) * 0.06 + Math.sin(i * 0.9) * 0.03
    wave += `${i ? 'L' : 'M'} ${x} ${44 - v * 30} `
    res += `${i ? 'L' : 'M'} ${x} ${92 - r * 60} `
  }
  return (
    <Svg>
      <path d={wave} fill="none" stroke={ink} strokeWidth={1.5} />
      <line x1={16} x2={286} y1={92} y2={92} stroke={'var(--line-strong)'} />
      <path d={res} fill="none" stroke="var(--good)" strokeWidth={1.5} />
      <text x={286} y={84} fontSize={9.5} textAnchor="end" fill={muted}>
        residual
      </text>
    </Svg>
  )
}

const wavelet = () => {
  const s = 92
  const x0 = 104
  const y0 = 10
  return (
    <Svg>
      <rect x={x0} y={y0} width={s} height={s} fill="var(--paper)" stroke={ink} />
      <rect x={x0} y={y0} width={s / 2} height={s / 2} fill="var(--paper)" stroke={ink} />
      <rect x={x0} y={y0} width={s / 4} height={s / 4} fill="var(--paper)" stroke={ink} />
      <rect x={x0} y={y0} width={s / 8} height={s / 8} fill={hl(4)} stroke={ink} />
      <text x={x0 + s * 0.75} y={y0 + s * 0.27} fontSize={10} textAnchor="middle" fill={muted}>
        HL
      </text>
      <text x={x0 + s * 0.25} y={y0 + s * 0.77} fontSize={10} textAnchor="middle" fill={muted}>
        LH
      </text>
      <text x={x0 + s * 0.75} y={y0 + s * 0.77} fontSize={10} textAnchor="middle" fill={muted}>
        HH
      </text>
      <text x={x0 + s * 0.375} y={y0 + s * 0.15} fontSize={8} textAnchor="middle" fill={muted}>
        HL
      </text>
      <text x={x0 + s * 0.125} y={y0 + s * 0.39} fontSize={8} textAnchor="middle" fill={muted}>
        LH
      </text>
    </Svg>
  )
}

const palette = () => {
  const cells: ReactNode[] = []
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 22; x++) {
      const t = x / 21
      const on = t * 16 > bayer[(y % 4) * 4 + (x % 4)]
      cells.push(<rect key={x + ':' + y} x={20 + x * 8} y={10 + y * 8} width={8} height={8} fill={on ? hl(2) : hl(4)} />)
    }
  const sw = [1, 2, 3, 4, 5, 6]
  return (
    <Svg>
      {cells}
      {sw.map((k, i) => (
        <rect key={k} x={210 + (i % 3) * 24} y={22 + Math.floor(i / 3) * 24} width={20} height={20} rx={3} fill={hl(k)} stroke={ink} />
      ))}
    </Svg>
  )
}

export const CARD_ART: Record<string, () => ReactNode> = {
  entropy,
  rle,
  huffman,
  arithmetic,
  ans,
  intcodes,
  lz77,
  lzw,
  ppm,
  png,
  flac,
  deflate,
  bwt,
  jpeg,
  wavelet,
  palette,
  bench,
}
