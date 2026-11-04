import type { ReactNode } from 'react'
import { fmt } from '../lib/text'

/**
 * A small `?` that explains the word next to it. Opens on hover and on focus,
 * and the text doubles as the accessible label. Keep it plain: it is there for
 * someone meeting "prefix code" or "extra bits" for the first time.
 */
export function Help({ text }: { text: string }) {
  return (
    <span className="help">
      <button type="button" className="help-dot" aria-label={text}>
        ?
      </button>
      <span className="help-bubble" role="tooltip">
        {text}
      </span>
    </span>
  )
}

/** A titled block in the side panel. */
export function Group({ title, help, children, aside }: { title?: ReactNode; help?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="group">
      {title && (
        <h3 className="group-title">
          <span>
            {title}
            {help && <Help text={help} />}
          </span>
          {aside && <span className="group-aside">{aside}</span>}
        </h3>
      )}
      <div className="group-body">{children}</div>
    </section>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  digits?: number
  disabled?: boolean
  help?: string
  /** Custom display of the value (e.g. "2^12 = 4096"). */
  display?: ReactNode
  onChange: (v: number) => void
}

export function Slider({ label, value, min, max, step = 1, unit, digits = 0, disabled, help, display, onChange }: SliderProps) {
  return (
    <label className={'ctl slider' + (disabled ? ' is-disabled' : '')}>
      <span className="ctl-head">
        <span className="ctl-label">
          {label}
          {help && <Help text={help} />}
        </span>
        <span className="ctl-value">
          {display ?? fmt(value, digits)}
          {unit && <em>{unit}</em>}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  )
}

export function Toggle({ label, value, onChange, help }: { label: string; value: boolean; onChange: (v: boolean) => void; help?: string }) {
  return (
    <label className="ctl toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span className="ctl-label">
        {label}
        {help && <Help text={help} />}
      </span>
    </label>
  )
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label?: string
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  help?: string
}) {
  return (
    <div className="ctl segmented">
      {label && (
        <span className="ctl-label">
          {label}
          {help && <Help text={help} />}
        </span>
      )}
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'on' : ''}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  title,
}: {
  children: ReactNode
  onClick: () => void
  kind?: 'default' | 'primary' | 'ghost'
  disabled?: boolean
  title?: string
}) {
  return (
    <button type="button" className={'btn btn-' + kind} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  )
}

/** A number with a label underneath. `tone` colours the value. */
export function Stat({
  label,
  value,
  sub,
  help,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  help?: string
  tone?: 'good' | 'bad' | 'accent'
}) {
  return (
    <div className={'stat' + (tone ? ' tone-' + tone : '')}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">
        {label}
        {help && <Help text={help} />}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>
}

/**
 * A horizontal bar comparing sizes, e.g. original vs compressed vs the entropy
 * floor. Values share one scale so the bars are honest against each other.
 */
export function SizeBars({ rows, unit = 'bits' }: { rows: { label: string; value: number; tone?: string; note?: string }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="sizebars">
      {rows.map((r) => (
        <div className="sizebar" key={r.label}>
          <span className="sizebar-label">{r.label}</span>
          <span className="sizebar-track">
            <span className={'sizebar-fill ' + (r.tone ?? '')} style={{ width: `${(100 * r.value) / max}%` }} />
          </span>
          <span className="sizebar-value">
            {Math.round(r.value).toLocaleString('en-US')} <em>{unit}</em>
            {r.note && <small>{r.note}</small>}
          </span>
        </div>
      ))}
    </div>
  )
}
