import { useEffect, useRef } from 'react'
import { ath, bark, db, spreading, type Band, type Mask } from './psy'

// ------------------------------------------------------------- spectrogram

/** Inferno-ish stops: readable on paper and on dark, and independent of the theme. */
const STOPS: [number, number, number][] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]

function heat(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const w = x - i
  const a = STOPS[i]
  const b = STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
}

const ZMAX = 24.5

/**
 * Time × frequency, frequency on a Bark axis so it matches the ear (and the
 * frame chart below). `frames` are MDCT spectra; colour is dB SPL 0…100.
 */
export function Spectrogram({
  frames,
  fs,
  cal,
  frame,
  onPick,
  marks,
  label,
}: {
  frames: Float64Array[]
  fs: number
  cal: number
  frame: number
  onPick: (f: number) => void
  /** Per-frame 0…1 badness, drawn as a strip underneath (share of bands above the mask). */
  marks?: number[]
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const H = 150
  useEffect(() => {
    const c = ref.current
    if (!c || !frames.length) return
    const F = frames.length
    const N = frames[0].length
    const binHz = fs / 2 / N
    const zTop = Math.min(ZMAX, bark(fs / 2))
    c.width = F
    c.height = H
    const g = c.getContext('2d')!
    const img = g.createImageData(F, H)
    // Bin range for each pixel row (row 0 = top = highest frequency).
    const rows: [number, number][] = []
    for (let y = 0; y < H; y++) {
      const z1 = zTop * (1 - y / H)
      const z0 = zTop * (1 - (y + 1) / H)
      rows.push([Math.floor(barkToHz(z0) / binHz), Math.max(Math.floor(barkToHz(z0) / binHz) + 1, Math.ceil(barkToHz(z1) / binHz))])
    }
    for (let f = 0; f < F; f++) {
      const X = frames[f]
      for (let y = 0; y < H; y++) {
        const [a, b] = rows[y]
        let m = 0
        for (let k = Math.max(0, a); k < Math.min(N, b); k++) m = Math.max(m, X[k] * X[k] + (k + 1 < N ? X[k + 1] * X[k + 1] : 0))
        const [r, gg, bb] = heat((db(m) + cal) / 100)
        const o = (y * F + f) * 4
        img.data[o] = r
        img.data[o + 1] = gg
        img.data[o + 2] = bb
        img.data[o + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
  }, [frames, fs, cal])

  const F = Math.max(1, frames.length)
  const ticks = [100, 500, 1000, 2000, 5000, 10000].filter((f) => f < fs / 2)
  const zTop = Math.min(ZMAX, bark(fs / 2))
  return (
    <div className="pa-spec">
      <div className="pa-spec-wrap">
        <canvas
          ref={ref}
          role="img"
          aria-label={label}
          className="pa-spec-canvas"
          onClick={(e) => {
            const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
            onPick(Math.max(0, Math.min(F - 1, Math.floor(((e.clientX - r.left) / r.width) * F))))
          }}
        />
        <div className="pa-spec-cursor" style={{ left: `${((frame + 0.5) / F) * 100}%` }} />
        {ticks.map((f) => (
          <span key={f} className="pa-spec-tick" style={{ top: `${(1 - bark(f) / zTop) * 100}%` }}>
            {f >= 1000 ? f / 1000 + 'k' : f}
          </span>
        ))}
      </div>
      {marks && (
        <div className="pa-marks" title="Share of bands whose noise is above the mask, per frame">
          {marks.map((m, i) => (
            <i key={i} style={{ opacity: m > 0 ? 0.25 + 0.75 * Math.min(1, m * 4) : 0 }} className={i === frame ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Inverse of Traunmüller (ignoring the end corrections, which only matter for axis placement). */
function barkToHz(z: number): number {
  let zz = z
  if (zz < 2) zz = (zz - 0.3) / 0.85
  else if (zz > 20.1) zz = (zz + 4.422) / 1.22
  return (1960 * (zz + 0.53)) / (26.28 - zz)
}

// ------------------------------------------------------------- frame chart

export interface ChartLayers {
  spectrum: boolean
  bands: boolean
  ath: boolean
  spread: boolean
  /** Band index whose own spreading curve is drawn. */
  masker?: number
  threshold: boolean
  /** Per-band noise level (dB SPL per coefficient) to draw, if any. */
  noise?: number[]
  /** Quantised spectrum to overlay. */
  quantised?: Float64Array
  highlight?: number
}

const W = 760
const HH = 300
const PAD_L = 38
const PAD_B = 26
const PAD_T = 10
const YMIN = -20
const YMAX = 110

export function FrameChart({ X, bands, mask, fs, cal, layers }: { X: Float64Array; bands: Band[]; mask: Mask; fs: number; cal: number; layers: ChartLayers }) {
  const N = X.length
  const binHz = fs / 2 / N
  const zTop = Math.min(ZMAX, bark(fs / 2))
  const px = (z: number) => PAD_L + (z / zTop) * (W - PAD_L - 6)
  const py = (d: number) => PAD_T + (1 - (Math.max(YMIN, Math.min(YMAX, d)) - YMIN) / (YMAX - YMIN)) * (HH - PAD_T - PAD_B)
  const zb = (k: number) => bark(Math.max(1, k * binHz))

  const spec = () => {
    let d = ''
    for (let k = 0; k < N; k++) d += `${k ? 'L' : 'M'}${px(zb(k + 0.5)).toFixed(1)},${py(db(X[k] * X[k]) + cal).toFixed(1)}`
    return d
  }
  const steps = (vals: number[]) => {
    let d = ''
    bands.forEach((b, i) => {
      const x0 = px(zb(b.lo))
      const x1 = px(zb(b.hi))
      const y = py(vals[i])
      d += `${i ? 'L' : 'M'}${x0.toFixed(1)},${y.toFixed(1)}L${x1.toFixed(1)},${y.toFixed(1)}`
    })
    return d
  }
  const athPath = () => {
    let d = ''
    for (let i = 0; i <= 200; i++) {
      const z = (i / 200) * zTop
      d += `${i ? 'L' : 'M'}${px(z).toFixed(1)},${py(ath(barkToHz(Math.max(0.2, z)))).toFixed(1)}`
    }
    return d
  }
  const maskerCurve = (m: number) => {
    const b = bands[m]
    let e = 0
    for (let k = b.lo; k < b.hi; k++) e += X[k] * X[k]
    const offset = mask.tonality[m] * (14.5 + b.z) + (1 - mask.tonality[m]) * 5.5
    let d = ''
    for (let i = 0; i <= 200; i++) {
      const z = (i / 200) * zTop
      // Per-coefficient level at z, assuming a band of the local width there.
      const j = bands.findIndex((bb) => zb(bb.hi) >= z)
      const width = j >= 0 ? bands[j].hi - bands[j].lo : 4
      const v = db(e) + cal + spreading(z - b.z) - offset - db(width)
      d += `${i ? 'L' : 'M'}${px(z).toFixed(1)},${py(v).toFixed(1)}`
    }
    return d
  }
  const yTicks = [0, 20, 40, 60, 80, 100]
  const fTicks = [100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f < fs / 2)
  const hb = layers.highlight !== undefined ? bands[layers.highlight] : undefined

  return (
    <svg viewBox={`0 0 ${W} ${HH}`} className="pa-chart" role="img" aria-label="Spectrum, threshold of hearing, masking threshold and quantisation noise for this frame">
      {hb && <rect x={px(zb(hb.lo))} y={PAD_T} width={Math.max(2, px(zb(hb.hi)) - px(zb(hb.lo)))} height={HH - PAD_T - PAD_B} className="pa-hl" />}
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 6} y1={py(t)} y2={py(t)} className="pa-grid" />
          <text x={PAD_L - 5} y={py(t) + 3.5} textAnchor="end" className="pa-axis">
            {t}
          </text>
        </g>
      ))}
      {fTicks.map((f) => (
        <text key={f} x={px(bark(f))} y={HH - 8} textAnchor="middle" className="pa-axis">
          {f >= 1000 ? f / 1000 + 'k' : f}
        </text>
      ))}
      <text x={PAD_L} y={HH - 8} textAnchor="end" className="pa-axis" dx={-6}>
        Hz
      </text>
      {layers.bands &&
        bands.map((b, i) => <line key={i} x1={px(zb(b.lo))} x2={px(zb(b.lo))} y1={PAD_T} y2={HH - PAD_B} className="pa-bandline" />)}
      {layers.spectrum && <path d={spec()} className="pa-spectrum" />}
      {layers.quantised && (
        <path
          d={(() => {
            let d = ''
            for (let k = 0; k < N; k++) {
              const v = layers.quantised![k]
              if (v === 0) continue
              const x = px(zb(k + 0.5)).toFixed(1)
              d += `M${x},${py(YMIN)}L${x},${py(db(v * v) + cal).toFixed(1)}`
            }
            return d
          })()}
          className="pa-quant"
        />
      )}
      {layers.bands && <path d={steps(mask.level)} className="pa-level" />}
      {layers.ath && <path d={athPath()} className="pa-ath" />}
      {layers.spread && layers.masker !== undefined && <path d={maskerCurve(layers.masker)} className="pa-masker" />}
      {layers.spread && <path d={steps(mask.spread)} className="pa-spread" />}
      {layers.threshold && <path d={steps(mask.threshold)} className="pa-threshold" />}
      {layers.noise &&
        bands.map((b, i) => {
          const v = layers.noise![i]
          if (v < YMIN) return null // noise of a silent band: nothing to draw
          const over = v > mask.threshold[i]
          return <line key={i} x1={px(zb(b.lo))} x2={px(zb(b.hi))} y1={py(v)} y2={py(v)} className={over ? 'pa-noise over' : 'pa-noise'} />
        })}
      <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={HH - PAD_B} className="pa-axisline" />
      <text x={6} y={PAD_T + 8} className="pa-axis">
        dB
      </text>
    </svg>
  )
}

export function ChartLegend({ items }: { items: { cls: string; label: string }[] }) {
  return (
    <div className="legend pa-legend">
      {items.map((i) => (
        <span key={i.label}>
          <svg width="18" height="10" aria-hidden>
            <line x1="1" x2="17" y1="5" y2="5" className={i.cls} />
          </svg>
          {i.label}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ band bars

/** NMR per band (bars around 0 dB) and bits per band underneath. */
export function BandBars({ nmr, bits, bands, highlight, active, topLabel = 'NMR' }: { nmr: number[]; bits: number[]; bands: Band[]; highlight?: number; active: boolean[]; topLabel?: string }) {
  const n = bands.length
  const w = 760
  const h1 = 110
  const h2 = 60
  const bw = (w - 40) / n
  const nmrY = (v: number) => h1 / 2 - (Math.max(-40, Math.min(40, v)) / 40) * (h1 / 2 - 4)
  const maxBits = Math.max(16, ...bits)
  return (
    <svg viewBox={`0 0 ${w} ${h1 + h2 + 26}`} className="pa-bars" role="img" aria-label="Noise-to-mask ratio and bits per band">
      <text x={0} y={12} className="pa-axis">
        {topLabel}
      </text>
      <text x={0} y={h1 + 14} className="pa-axis">
        bits
      </text>
      {[20, 0, -20].map((t) => (
        <g key={t}>
          <line x1={34} x2={w} y1={nmrY(t)} y2={nmrY(t)} className={t === 0 ? 'pa-zero' : 'pa-grid'} />
          <text x={30} y={nmrY(t) + 3.5} textAnchor="end" className="pa-axis">
            {t > 0 ? '+' + t : t}
          </text>
        </g>
      ))}
      {bands.map((_, i) => {
        const x = 40 + i * bw
        const v = nmr[i]
        const y0 = nmrY(0)
        const y1 = nmrY(v)
        const on = i === highlight
        return (
          <g key={i}>
            {on && <rect x={x - 1} y={0} width={bw} height={h1 + h2 + 8} className="pa-hl" />}
            {active[i] && <rect x={x} y={Math.min(y0, y1)} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(y1 - y0))} className={v > 0 ? 'pa-bar bad' : 'pa-bar good'} />}
            <rect x={x} y={h1 + h2 - (bits[i] / maxBits) * (h2 - 6) + 4} width={Math.max(1, bw - 2)} height={(bits[i] / maxBits) * (h2 - 6)} className="pa-bar bits" />
          </g>
        )
      })}
      <text x={40} y={h1 + h2 + 22} className="pa-axis">
        band 0 (lowest)
      </text>
      <text x={w} y={h1 + h2 + 22} textAnchor="end" className="pa-axis">
        band {n - 1}
      </text>
    </svg>
  )
}

// ------------------------------------------------------------- scope

export function Scope({ series, height = 120, label }: { series: { data: ArrayLike<number>; cls: string; scale?: number }[]; height?: number; label: string }) {
  const w = 760
  let amp = 1
  for (const s of series) for (let i = 0; i < s.data.length; i++) amp = Math.max(amp, Math.abs(s.data[i] * (s.scale ?? 1)))
  const paths = series.map((s) => {
    const n = s.data.length
    const cols = Math.min(n, 380)
    let d = ''
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c / cols) * n)
      const b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n))
      let lo = Infinity
      let hi = -Infinity
      for (let i = a; i < b; i++) {
        const v = s.data[i] * (s.scale ?? 1)
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const x = ((c + 0.5) / cols) * w
      const y = (v: number) => height / 2 - (v / amp) * (height / 2 - 3)
      d += `M${x.toFixed(1)},${y(hi).toFixed(1)}L${x.toFixed(1)},${(y(lo) + 0.6).toFixed(1)}`
    }
    return d
  })
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="pa-scope" role="img" aria-label={label}>
      <line x1={0} x2={w} y1={height / 2} y2={height / 2} className="pa-zero" />
      {paths.map((d, i) => (
        <path key={i} d={d} className={series[i].cls} />
      ))}
    </svg>
  )
}
