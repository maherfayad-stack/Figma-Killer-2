/**
 * TokenCatalogContext — hoists the framework token catalogs
 * (`useSpacingTokens`/`useTypographyTokens`) so they're computed ONCE per
 * properties-panel render instead of once per `ClassPropertyRow` instance.
 *
 * Split into a `.ts` (this file — context + hook) and a sibling `.tsx`
 * (`TokenCatalogProvider.tsx`) because React Fast Refresh requires a file to
 * export only components OR only non-components (same split
 * `EditorPermissionsContext.ts`/`EditorPermissionsProvider.tsx` already use).
 *
 * ## The cost this removes
 *
 * `useSpacingTokens`/`useTypographyTokens` (`tokenUtils.ts`) each subscribe
 * to a framework settings slice via the editor store, then call
 * `expandTokensFromGroups`, which allocates a brand-new `Token[]` from
 * scratch — one entry per step of every enabled group. `ClassPropertyRow`
 * called BOTH hooks unconditionally on every render "because hooks must run
 * unconditionally" — true, but nothing said each of the panel's ~101 curated
 * property rows needed its OWN store subscription and its OWN freshly
 * allocated array. A comment on `ClassPropertyRow` used to call this "no
 * cost" — wrong: `StyleSurface` re-renders once per keystroke that edits
 * the selected node's style, sections default open
 * (`propertiesSectionsExpanded`), and EVERY visible row re-renders with it —
 * so that "no cost" ran up to 101 times per character typed (up to 202 when
 * both the Element and Class blocks are visible at once, since
 * `StyleSectionsEditor` mounts twice — see `StyleSurface`'s Track F1/S6
 * doc), on rows that in the overwhelming majority of cases don't even have
 * a `tokenSource`.
 *
 * `TokenCatalogProvider` calls both hooks exactly once, at the top of
 * `StyleSurface`'s render tree; every row reads the shared result through
 * `useTokenCatalog()` — a plain `useContext`, no store subscription, no
 * array allocation, of its own.
 *
 * ## Invalidation
 *
 * `useSpacingTokens`/`useTypographyTokens` still subscribe to the LIVE
 * store slice (`site.settings.framework.{spacing,typography}.groups`), so
 * the provider's own value changes — and every row consuming it re-renders
 * with the new catalog — exactly when the framework settings actually
 * change. There is no snapshot here that can go stale; this only removes
 * the redundant re-computation of the SAME catalog on renders that have
 * nothing to do with it.
 */
import { createContext, useContext } from 'react'
import type { Token } from './tokenUtils'

export interface TokenCatalog {
  spacingTokens: ReadonlyArray<Token>
  typographyTokens: ReadonlyArray<Token>
}

export const EMPTY_TOKEN_CATALOG: TokenCatalog = { spacingTokens: [], typographyTokens: [] }

export const TokenCatalogContext = createContext<TokenCatalog | null>(null)

/**
 * Reads the catalog `TokenCatalogProvider` computed higher up the tree.
 * Falls back to empty arrays (NOT to calling the raw hooks itself) outside a
 * provider: every real call site renders under `StyleSurface`, which always
 * mounts one; a bare unit test rendering `ClassPropertyRow` in isolation
 * gets "no token suggestions" rather than silently paying for its own
 * duplicate store subscription.
 */
export function useTokenCatalog(): TokenCatalog {
  return useContext(TokenCatalogContext) ?? EMPTY_TOKEN_CATALOG
}
