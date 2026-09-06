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

/**
 * The lock reason for the style target currently being rendered, or `null`
 * when edits to it reach disk.
 */
export const StyleWriteLockContext = createContext<string | null>(null)

/** Reads the enclosing write lock. `null` = this control's edits can be saved. */
export function useStyleWriteLock(): string | null {
  return useContext(StyleWriteLockContext)
}
