/**
 * npm run verify [filter]
 *
 * 1. Every `src/exhibits/<x>/codec.ts` exports `codecs`; each one is round-tripped
 *    over the whole corpus (lib/samples.ts) and must decode to the exact input.
 * 2. Every `src/exhibits/<x>/<x>.verify.ts` (or any `*.verify.ts` there) exports
 *    `checks`; each runs and must not throw. These pin the algorithms against
 *    answers known independently — RFC examples, textbook traces, Node's zlib.
 *
 * An optional argument filters by exhibit folder name, e.g. `npm run verify deflate`.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Codec } from './src/lib/codec'
import type { Check } from './src/lib/check'
import { corpus } from './src/lib/samples'

const filter = process.argv[2]
const root = join(import.meta.dirname, 'src', 'exhibits')
let pass = 0
let fail = 0
const failures: string[] = []

async function run(name: string, fn: () => void | Promise<void>) {
  const t = performance.now()
  try {
    await fn()
    pass++
    const ms = performance.now() - t
    console.log(`  \x1b[32m✓\x1b[0m ${name}${ms > 300 ? `  \x1b[2m(${(ms / 1000).toFixed(1)}s)\x1b[0m` : ''}`)
  } catch (e) {
    fail++
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${msg}`)
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${msg}`)
  }
}

const dirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!filter || d.name.includes(filter)))
  .map((d) => d.name)
  .sort()

const data = corpus()

for (const dir of dirs) {
  const files = readdirSync(join(root, dir))
  const codecFile = join(root, dir, 'codec.ts')
  const verifyFiles = files.filter((f) => f.endsWith('.verify.ts'))
  if (!existsSync(codecFile) && verifyFiles.length === 0) continue
  console.log(`\n\x1b[1m${dir}\x1b[0m`)

  if (existsSync(codecFile)) {
    const mod = (await import(pathToFileURL(codecFile).href)) as { codecs?: Codec[] }
    for (const c of mod.codecs ?? []) {
      await run(`${c.name} round-trips the corpus (${data.length} inputs)`, () => {
        for (const { id, data: input } of data) {
          const enc = c.encode(input)
          const dec = c.decode(enc)
          if (dec.length !== input.length) throw new Error(`${id}: decoded ${dec.length} bytes, expected ${input.length}`)
          for (let i = 0; i < input.length; i++) if (dec[i] !== input[i]) throw new Error(`${id}: first difference at byte ${i}`)
        }
      })
    }
  }

  for (const f of verifyFiles) {
    const mod = (await import(pathToFileURL(join(root, dir, f)).href)) as { checks?: Check[] }
    for (const ch of mod.checks ?? []) await run(ch.name, ch.run)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
