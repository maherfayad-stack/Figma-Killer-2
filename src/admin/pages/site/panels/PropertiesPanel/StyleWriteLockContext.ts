/**
 * StyleWriteLockContext — carries "declarations typed into THIS style target
 * cannot reach disk, and here is why" from the one component that knows it
 * (`StyleSurface`, via `classCssWritability.ts`) down to the controls that
 * have to stop accepting edits (`ClassPropertyRow`).
 *
 * A `.ts` context + hook with no component export, for the same Fast Refresh
 * reason `TokenCatalogContext.ts` is split from `TokenCatalogProvider.tsx`.
 * There is no provider component here at all: `StyleSurface` renders
 * `<StyleWriteLockContext.Provider>` directly around the CLASS block, which
 * is the only subtree the lock applies to.
 *
 * ## Why a context rather than a prop
 *
 * The path from the fact to the control is `StyleSurface` ->
 * `StyleRuleComposer` -> `StyleSectionsEditor` -> a section -> a row. Every
 * link in that chain would have to grow a prop it does not otherwise care
 * about, and any section that forgot to forward it would silently render an
 * editable row for an unwritable class — precisely the failure this exists to
 * remove. The panel already solves the same shape the same way one level up
 * (`TokenCatalogContext`, read by the same `ClassPropertyRow`).
 *
 * ## Scope, precisely
 *
 * The provider wraps the class composer ONLY. The Element (inline) block has
 * its own, unrelated writability story — per-property `codeProps` locks that
 * `InlineStyleComposer` surfaces itself — and must not inherit a class's
 * verdict. `LockedStylePreview`'s phantom teaser rows and the global-selector
 * surface render outside any provider and read `null`, i.e. unlocked, which
 * is the honest default for "nobody asserted a lock here".
 */
import { createContext, useContext } from 'react'
import { describeReach, type StyleWriteReach } from './styleWriteReach'

/**
 * ## Three states, not two (W8-3 phase 2)
 *
 * A single-node surface has one target and one answer, so a `string | null`
 * said everything there was to say. A multi-selection has N targets and the
 * bulk mutation writes the ones it can, so "locked" and "unlocked" both lie
 * about the middle case. The third state carries the numbers instead:
 *
 *   - `blocked` — nothing typed here reaches disk. Controls render disabled,
 *     the remove button disappears, and the reason is the row's `title`.
 *     This is the original lock, unchanged.
 *   - `partial` — the write lands on some targets and not others, per
 *     PROPERTY (see `styleWriteReach.ts` for why per-property). Controls stay
 *     ENABLED — refusing an edit that works for three of five layers would
 *     cost the three to protect the two — and the row states the count.
 *   - `null` — every write reaches disk.
 */
export type StyleWriteLock =
  | { kind: 'blocked'; reason: string }
  | { kind: 'partial'; reach: StyleWriteReach }

/** The `blocked` lock, so callers with a plain reason string don't build the object by hand. */
export function blockedStyleWriteLock(reason: string | null): StyleWriteLock | null {
  return reason === null ? null : { kind: 'blocked', reason }
}

/**
 * The lock state for the style target currently being rendered, or `null`
 * when every edit to it reaches disk.
 */
export const StyleWriteLockContext = createContext<StyleWriteLock | null>(null)

/** Reads the enclosing write lock. `null` = this control's edits can be saved. */
export function useStyleWriteLock(): StyleWriteLock | null {
  return useContext(StyleWriteLockContext)
}

/**
 * What ONE property row must do about the enclosing lock: whether to disable
 * itself, and the sentence to show. Resolved here so no row re-implements the
 * `blocked` / `partial` distinction — `partial` never disables.
 */
export function resolveRowWriteLock(
  lock: StyleWriteLock | null,
  property: string,
): { disabled: boolean; reason: string | null } {
  if (lock === null) return { disabled: false, reason: null }
  if (lock.kind === 'blocked') return { disabled: true, reason: lock.reason }
  return { disabled: false, reason: describeReach(lock.reach, property) }
}
