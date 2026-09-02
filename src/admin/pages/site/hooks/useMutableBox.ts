/**
 * useMutableBox — a `{ current: T | null }` box, mutated directly (never
 * through a setter) to hold "the previous render's value" across renders.
 *
 * This deliberately is NOT `useRef`. `eslint-plugin-react-hooks`'s `refs`
 * rule (`docs/reference/react-compiler.md` exception 3) flags reading a
 * REF's `.current` synchronously during render — refs are for imperative,
 * non-rendering escape hatches (event handlers, effects), and this repo
 * enforces that split as a hard lint gate. What callers of this hook need is
 * the opposite: a value read DURING render, on every render, to decide part
 * of that render's own output (e.g. "is the value I just computed the same
 * as last time, so I can reuse the old reference and let downstream
 * consumers bail out?") — which is exactly what `useState`'s lazy
 * initializer is for (`docs/reference/react-compiler.md`: "`useState(() =>
 * …)` lazy initializers... are NOT memoization — always fine"). The returned
 * object's `.current` field is then mutated in place by the caller; the
 * setter is never called, so mutating it does not itself trigger a
 * re-render — the same behaviour a ref would give, without tripping a rule
 * that exists for a different reason (`useInspectComputedStyle.ts`'s
 * `stabilizeRecord` and `StyleSurface`'s provenance-map reuse both use this).
 */
import { useState } from 'react'

export function useMutableBox<T>(): { current: T | null } {
  const [box] = useState<{ current: T | null }>(() => ({ current: null }))
  return box
}
