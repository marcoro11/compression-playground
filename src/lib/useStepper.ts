import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The transport every step-through exhibit shares.
 *
 * `count` is the number of states (0 … count−1). State 0 is "before anything
 * happened" by convention, so a trace of n operations has n+1 states. Changing
 * `count` (new input) clamps the index rather than resetting it, so editing the
 * input while scrubbing does not throw you back to the start — unless the
 * caller passes a new `resetKey`.
 */
export interface Stepper {
  index: number
  count: number
  playing: boolean
  /** Steps per second. */
  speed: number
  setIndex(i: number): void
  next(): void
  prev(): void
  first(): void
  last(): void
  toggle(): void
  setPlaying(p: boolean): void
  setSpeed(s: number): void
  atEnd: boolean
}

export function useStepper(count: number, opts: { speed?: number; resetKey?: unknown; startAtEnd?: boolean } = {}): Stepper {
  const [index, setIndexRaw] = useState(opts.startAtEnd ? Math.max(0, count - 1) : 0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(opts.speed ?? 4)
  const max = Math.max(0, count - 1)

  const clamp = useCallback((i: number) => Math.max(0, Math.min(max, Math.round(i))), [max])
  const setIndex = useCallback((i: number) => setIndexRaw(clamp(i)), [clamp])

  // New input: clamp, or reset when the caller says the identity changed.
  const lastKey = useRef(opts.resetKey)
  useEffect(() => {
    if (lastKey.current !== opts.resetKey) {
      lastKey.current = opts.resetKey
      setIndexRaw(opts.startAtEnd ? max : 0)
      setPlaying(false)
    } else {
      setIndexRaw((i) => Math.min(i, max))
    }
  }, [max, opts.resetKey, opts.startAtEnd])

  // Playback. A fractional accumulator so 0.5 steps/s and 60 steps/s both work.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (t: number) => {
      acc += ((t - last) / 1000) * speed
      last = t
      if (acc >= 1) {
        const n = Math.floor(acc)
        acc -= n
        setIndexRaw((i) => {
          const j = Math.min(max, i + n)
          if (j >= max) setPlaying(false)
          return j
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, max])

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p) setIndexRaw((i) => (i >= max ? 0 : i)) // play from the end restarts
      return !p
    })
  }, [max])

  return {
    index: Math.min(index, max),
    count,
    playing,
    speed,
    setIndex,
    next: () => setIndex(index + 1),
    prev: () => setIndex(index - 1),
    first: () => setIndex(0),
    last: () => setIndex(max),
    toggle,
    setPlaying,
    setSpeed,
    atEnd: index >= max,
  }
}
