import { useEffect, type ReactNode } from 'react'
import type { Stepper } from '../lib/useStepper'

/**
 * Play / step / scrub for a `useStepper`. Also binds ← → (step), Home/End and
 * space (play) while focus is not in a text field, so you can drive an
 * algorithm from the keyboard with the explanation in view.
 */
export function Transport({ s, label, children, keys = true }: { s: Stepper; label?: (i: number) => ReactNode; children?: ReactNode; keys?: boolean }) {
  useEffect(() => {
    if (!keys) return
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight') s.next()
      else if (e.key === 'ArrowLeft') s.prev()
      else if (e.key === 'Home') s.first()
      else if (e.key === 'End') s.last()
      else if (e.key === ' ') s.toggle()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [s, keys])

  const max = Math.max(0, s.count - 1)
  return (
    <div className="transport">
      <div className="transport-buttons">
        <button type="button" onClick={s.first} disabled={s.index === 0} title="First step (Home)" aria-label="First step">
          ⏮
        </button>
        <button type="button" onClick={s.prev} disabled={s.index === 0} title="Previous step (←)" aria-label="Previous step">
          ◀
        </button>
        <button type="button" className="play" onClick={s.toggle} title="Play / pause (space)" aria-label={s.playing ? 'Pause' : 'Play'}>
          {s.playing ? '❚❚' : '▶'}
        </button>
        <button type="button" onClick={s.next} disabled={s.atEnd} title="Next step (→)" aria-label="Next step">
          ▶
        </button>
        <button type="button" onClick={s.last} disabled={s.atEnd} title="Last step (End)" aria-label="Last step">
          ⏭
        </button>
      </div>
      <input
        className="transport-scrub"
        type="range"
        min={0}
        max={max}
        step={1}
        value={s.index}
        onChange={(e) => s.setIndex(parseInt(e.target.value, 10))}
        aria-label="Step"
      />
      <span className="transport-pos">{label ? label(s.index) : `${s.index} / ${max}`}</span>
      <label className="transport-speed" title="Steps per second">
        <select value={s.speed} onChange={(e) => s.setSpeed(parseFloat(e.target.value))} aria-label="Speed">
          {[0.5, 1, 2, 4, 8, 16, 60, 240].map((v) => (
            <option key={v} value={v}>
              {v}×/s
            </option>
          ))}
        </select>
      </label>
      {children}
    </div>
  )
}

/**
 * The sentence under the stage that says what the current step did. Every
 * step-through exhibit has one; it is the difference between an animation and
 * an explanation.
 */
export function Narration({ children, tone }: { children: ReactNode; tone?: 'done' | 'warn' }) {
  return (
    <div className={'narration' + (tone ? ' ' + tone : '')} aria-live="polite">
      {children}
    </div>
  )
}
