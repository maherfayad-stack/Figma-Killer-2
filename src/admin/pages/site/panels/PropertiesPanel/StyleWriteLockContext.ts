/**
 * StyleWriteLockContext — carries "declarations typed into THIS style target
 * do not all reach disk, and here is how far they do" from the one component
 * that knows it (`StyleSurface`, reading `SelectionModel.inlineWriteReach`)
 * down to the controls that state it (`ClassPropertyRow`).
 *
 * A `.ts` context + hook with no component export, for the same Fast Refresh
 * reason `TokenCatalogContext.ts` is split from `TokenCatalogProvider.tsx`.
 * There is no provider component here at all: `StyleSurface` renders
 * `<StyleWriteLockContext.Provider>` directly around the mounted
 * `INSPECTOR_SECTIONS`, with `partialStyleWriteLock(model.inlineWriteReach)`
 * — a `partial` lock for a multi-selection aimed at Element, `null` for
 * everything else. Nothing in the app provides `blocked` today: a whole
 * target that cannot be written is the selection model's job
 * (`writableClasses[].lockReason`, `StyleSurface`'s nothing-writable notice),
 * and the state stays for the row contract it pins
 * (`classPropertyRowWriteLock.test.tsx`).
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
 * The provider wraps the node surface's mounted sections ONLY. The
 * global-selector surface (`SelectorInspector`) renders outside it and reads
 * `null`, i.e. unlocked, which is the honest default for "nobody asserted a
 * lock here".
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

/** The `partial` lock for a reach, or `null` when there is no reach to state (one layer, or a class target). */
export function partialStyleWriteLock(reach: StyleWriteReach | null): StyleWriteLock | null {
  return reach === null ? null : { kind: 'partial', reach }
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
