import { useEffect, useState } from 'react'

/**
 * CSS custom properties, read for canvas drawing. Canvas cannot use `var(--x)`,
 * so anything drawn on one asks here and re-renders when the colour scheme
 * flips (the hook subscribes to `prefers-color-scheme`).
 */
export interface Theme {
  paper: string
  card: string
  ink: string
  ink2: string
  muted: string
  faint: string
  line: string
  lineStrong: string
  accent: string
  hl: string[]
  good: string
  bad: string
  dark: boolean
}

export function readTheme(el: Element = document.documentElement): Theme {
  const cs = getComputedStyle(el)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return {
    paper: v('--paper'),
    card: v('--card'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    muted: v('--muted'),
    faint: v('--faint'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    accent: v('--accent'),
    hl: [v('--hl-1'), v('--hl-2'), v('--hl-3'), v('--hl-4'), v('--hl-5'), v('--hl-6')],
    good: v('--good'),
    bad: v('--bad'),
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
  }
}

/** The current theme; pass an element inside the page to pick up its `--accent`. */
export function useTheme(ref?: { current: Element | null }): Theme {
  const [theme, setTheme] = useState<Theme>(() => readTheme())
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(readTheme(ref?.current ?? document.documentElement))
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [ref])
  return theme
}
