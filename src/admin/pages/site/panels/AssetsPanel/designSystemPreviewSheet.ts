/**
 * designSystemPreviewSheet — ONE `CSSStyleSheet`, built lazily, adopted by
 * every asset card's shadow root.
 *
 * Constructed stylesheets are shareable: ~70 cards adopt the same object, so
 * the ~120 KB of design-system CSS is parsed once per session rather than once
 * per card. It is built on first use (the first card that mounts a preview),
 * never at module load, so a user who never opens the Assets panel never pays
 * for it.
 *
 * The bytes are Studio's OWN bundled copy of the design system — the same
 * import `canvasVendorCss.ts` injects into every canvas frame, so a card and a
 * frame cannot disagree about what a component looks like.
 */
// Vite `?inline` yields the processed CSS as a default string export. The
// specifier is Studio's VENDORED package (`vendor/alm-design-system/`), not the
// retired npm — byte-for-byte the same module `canvasVendorCss.ts` imports, so
// Vite resolves both to one graph node and the bytes cannot drift. Imported
// from `dist/`, never `src/`, for the same reason it is there: the 40
// per-component `import './X.css'` side effects in the source would land in the
// admin document's cascade, which is the one thing the shadow root exists to
// prevent.
import designSystemCss from 'alm-design-system/dist/index.css?inline'
import { transformDesignSystemCssForShadow } from './assetPreviewCss'

/** `undefined` = not built yet; `null` = this browser cannot build one. */
let sheet: CSSStyleSheet | null | undefined

export function designSystemPreviewSheet(): CSSStyleSheet | null {
  if (sheet !== undefined) return sheet
  try {
    const built = new CSSStyleSheet()
    built.replaceSync(transformDesignSystemCssForShadow(designSystemCss as string))
    sheet = built
  } catch (err) {
    // Constructable stylesheets are missing in some test DOMs. A preview
    // without the design system's CSS is plain, not broken — and nothing
    // leaks into the document either way.
    console.warn('[assets] design-system preview stylesheet unavailable:', err)
    sheet = null
  }
  return sheet
}
