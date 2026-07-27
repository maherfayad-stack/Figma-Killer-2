/**
 * cssomSheet — acquiring a `CSSStyleSheet` constructor to parse CSS through.
 *
 * Split out of `cssToStyleRules.ts` so that module stays about parsing CSS
 * rather than about which environment it happens to be running in. Three
 * environments matter and they disagree:
 *
 *   - **Browser** — `CSSStyleSheet` is a global.
 *   - **`bun test`** — happy-dom is installed by `src/__tests__/setup.ts`, which
 *     puts the constructor on `window` rather than `globalThis`.
 *   - **The Bun server** — no CSSOM at all. Studio's `.css` import
 *     (`server/handlers/studioCss.ts`) constructs happy-dom's own
 *     `GlobalWindow` and passes its constructor in explicitly, rather than
 *     assigning browser globals onto a long-lived server process.
 */

/** Resolution order: an explicitly injected constructor, then the ambient global, then a happy-dom `window`. `null` when no CSS engine is available at all. */
export function getSheetConstructor(injected: typeof CSSStyleSheet | undefined): typeof CSSStyleSheet | null {
  if (injected) return injected
  if (typeof CSSStyleSheet !== 'undefined') return CSSStyleSheet
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null
  if (w?.CSSStyleSheet) return w.CSSStyleSheet as typeof CSSStyleSheet
  return null
}
