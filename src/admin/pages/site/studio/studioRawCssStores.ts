/**
 * studioRawCssStores — WS-2.3/`board-27`'s tiny external stores for the two
 * kinds of read-only, raw CSS bytes a Studio load carries OUTSIDE the
 * `SiteDocument`: vendor package CSS and the project's own authored CSS.
 * Split out of `fsCodemodAdapter.ts` to keep that file under the
 * architecture's 700-line module-size ceiling (`module-size-budgets.test.ts`)
 * — same "tiny external store" pattern `studioProjectTrust.ts` uses for the
 * trust tier, for the same reason: `loadSite`'s only real coupling to either
 * store is one call each, handing over the value the `/load` response
 * carried. `fsCodemodAdapter.ts` re-exports both pairs verbatim so every
 * existing import site (`ProjectCssInjector`, tests) is unaffected.
 *
 * Neither value belongs in `SiteDocument` — both are ephemeral, server-
 * derived, per-load state, and neither is ever parsed into `StyleRule`s or
 * written back to disk. `ProjectCssInjector`/`AuthoredCssInjector` each read
 * their own store via `useSyncExternalStore` rather than subscribing to
 * `site`, whose reference changes on every unrelated node edit (Mutative
 * mints a new root object per mutation) — that would re-run the injector's
 * DOM work far more often than either value actually changes (once per
 * project load).
 *
 * ## Vendor vs. authored
 *
 * `vendorCss` (WS-2.3) is a design system's own package CSS, reached via a
 * bare-specifier import and resolved against the OPEN project's own
 * `node_modules` — read-only scaffolding the user never edits.
 *
 * `authoredCss` (`board-27`) is the project's OWN `.css`, read raw
 * (`server/handlers/studioCss.ts`'s `StudioStyles.authoredCss`) so the canvas
 * renders declarations happy-dom's CSSOM parser silently drops when building
 * `site.styleRules` (`color-mix()`, system colours, slash-alpha `rgb()`).
 * `AuthoredCssInjector` renders it directly; `canvasClassCss.ts`'s
 * `styleRuleNeedsCanvasOverlay` decides which `styleRules` entries ALSO need
 * to render through the editable-registry overlay (`ClassStyleInjector`), so
 * a live session edit still wins over this raw, on-disk snapshot.
 */

let vendorCss = ''
const vendorCssListeners = new Set<() => void>()

export function getStudioVendorCss(): string {
  return vendorCss
}

export function subscribeStudioVendorCss(listener: () => void): () => void {
  vendorCssListeners.add(listener)
  return () => vendorCssListeners.delete(listener)
}

/** Called by `fsCodemodAdapter.ts`'s `loadSite` with the `vendorCss` the `/load` response carried. */
export function setStudioVendorCss(next: string): void {
  if (next === vendorCss) return
  vendorCss = next
  for (const listener of vendorCssListeners) listener()
}

let authoredCss = ''
const authoredCssListeners = new Set<() => void>()

export function getStudioAuthoredCss(): string {
  return authoredCss
}

export function subscribeStudioAuthoredCss(listener: () => void): () => void {
  authoredCssListeners.add(listener)
  return () => authoredCssListeners.delete(listener)
}

/** Called by `fsCodemodAdapter.ts`'s `loadSite` with the `authoredCss` the `/load` response carried. */
export function setStudioAuthoredCss(next: string): void {
  if (next === authoredCss) return
  authoredCss = next
  for (const listener of authoredCssListeners) listener()
}
