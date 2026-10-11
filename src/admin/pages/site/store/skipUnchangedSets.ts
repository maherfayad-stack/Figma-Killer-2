/**
 * skipUnchangedSets — a store write that changes nothing notifies nobody.
 *
 * Zustand notifies every subscriber on every `set`, and an OBJECT partial
 * (`set({ focusedPanel: panel })`) always produces a new state object, so it
 * notifies even when every value it carries is already the current one. A
 * recipe (`set((s) => { … })`) does not have this problem: Mutative returns
 * the same state when the recipe changed nothing, and Zustand skips an
 * identical state.
 *
 * The canvas makes that cost real. Every `NodeRenderer` of every mounted frame
 * subscribes to the store (P2-I), so on the 40-frame × 300-element board one
 * `set` runs ~2,800 components' selectors — measured ~8–10 ms of a production
 * click (P6-C). A click on the canvas made TWO such writes that changed
 * nothing (focusing a canvas that already had focus is one), each paying the
 * whole sweep before the selection ring could paint. Audit `01-perf.md`'s
 * PERF-11 asked for an equality guard at each hot call site; this is that
 * guard, once, for every call site that exists or ever will.
 *
 * Placed between `subscribeWithSelector` and `mutative`: it wraps the `set`
 * Mutative hands its result to, so it sees an object partial exactly as the
 * caller passed it, and a recipe as the function Mutative made of it (which
 * it passes through — Zustand's own identity check covers those). A
 * `replace` write is never skipped.
 */
import type { StateCreator, StoreMutatorIdentifier } from 'zustand'

type SkipUnchangedSets = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initializer: StateCreator<T, Mps, Mcs>,
) => StateCreator<T, Mps, Mcs>

type AnySet = (partial: unknown, replace?: boolean, ...rest: unknown[]) => void

/** Every key of `partial` already holds that exact value in `state`. */
export function partialChangesNothing(state: object, partial: object): boolean {
  const current = state as Record<string, unknown>
  for (const [key, value] of Object.entries(partial)) {
    if (!Object.is(current[key], value)) return false
  }
  return true
}

const skipUnchangedSetsImpl =
  (initializer: StateCreator<unknown>): StateCreator<unknown> =>
  (set, get, api) => {
    const guardedSet: AnySet = (partial, replace, ...rest) => {
      if (
        replace !== true &&
        typeof partial === 'object' &&
        partial !== null &&
        partialChangesNothing(get() as object, partial)
      ) {
        return
      }
      ;(set as AnySet)(partial, replace, ...rest)
    }
    return initializer(guardedSet as typeof set, get, api)
  }

export const skipUnchangedSets = skipUnchangedSetsImpl as unknown as SkipUnchangedSets
