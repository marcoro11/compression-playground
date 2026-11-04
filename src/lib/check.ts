/**
 * The tiny assertion kit `npm run verify` uses. A check is a name and a
 * function that throws on failure. Each exhibit can ship a `<name>.verify.ts`
 * exporting `checks: Check[]`; the runner finds them on its own.
 */

export interface Check {
  name: string
  run: () => void | Promise<void>
}

export class CheckFailure extends Error {}

export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CheckFailure(msg)
}

export function eq<T>(actual: T, expected: T, msg = ''): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new CheckFailure(`${msg ? msg + ': ' : ''}expected ${e.slice(0, 300)}, got ${a.slice(0, 300)}`)
}

export function near(actual: number, expected: number, tol: number, msg = ''): void {
  if (!(Math.abs(actual - expected) <= tol)) throw new CheckFailure(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`)
}

export function bytesEq(a: Uint8Array, b: Uint8Array, msg = ''): void {
  if (a.length !== b.length) throw new CheckFailure(`${msg ? msg + ': ' : ''}length ${a.length} ≠ ${b.length}`)
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new CheckFailure(`${msg ? msg + ': ' : ''}first difference at byte ${i}: ${a[i]} ≠ ${b[i]}`)
  }
}
