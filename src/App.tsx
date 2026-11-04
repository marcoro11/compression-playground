import { Suspense, useEffect, useState } from 'react'
import { EXHIBITS } from './exhibits/registry'
import { Home } from './ui/Home'
import { TopBar } from './ui/Page'

/** Hash routing — no dependency, and the site stays a static bundle that GitHub Pages can serve. */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#\/?/, '')
}

export function App() {
  const route = useHashRoute()
  const ex = EXHIBITS.find((e) => e.slug === route)

  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = ex ? `${ex.title} — Compression Playground` : 'Compression Playground'
  }, [route, ex])

  if (!ex) return <Home />
  const View = ex.component
  return (
    <Suspense
      fallback={
        <>
          <TopBar current={ex.slug} />
          <div className="loading">Loading {ex.title}…</div>
        </>
      }
    >
      <View key={ex.slug} />
    </Suspense>
  )
}
