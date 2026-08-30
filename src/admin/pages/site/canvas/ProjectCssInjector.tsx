/**
 * ProjectCssInjector — injects VENDOR CSS into a canvas iframe's `<head>`:
 * CSS that belongs to a package, not to the user's own project, so it must
 * render but stay READ-ONLY and lose to the user's own edits. WS-2.3 of
 * `STUDIO-IMPORT-V2-PLAN.md`.
 *
 * Two sources, concatenated into one bucket
 * ──────────────────────────────────────────
 * 1. `@alm-design/design-system`'s bundled stylesheet — Studio's OWN
 *    dependency (not the open project's), imported once at Studio's own
 *    build time via Vite `?inline`. This is what `AlmDesignSystemCssInjector`
 *    used to inject on its own; `standing-07` in `STATE.md` keeps this
 *    dependency and `src/modules/alm/` alive until the generic package-
 *    component pipeline is proven to render the eSIM board equivalently —
 *    this injector still needs to feed it CSS in the meantime.
 * 2. The OPEN project's own package CSS, reached through a bare-specifier
 *    import (`import '@acme/ui/dist/style.css'`) inside ITS source, resolved
 *    against ITS OWN `node_modules` server-side
 *    (`server/handlers/studio/styleCompile.ts`'s `collectVendorCss`) and
 *    threaded onto the client as `GET /admin/api/studio/load`'s `vendorCss`
 *    field. `getStudioVendorCss()`/`subscribeStudioVendorCss()`
 *    (`fsCodemodAdapter.ts`) expose the last-loaded value reactively.
 *
 * Cascade — see `canvasCssLayers.ts` for the full explanation of why vendor
 * CSS lives in `@layer vendor` (ordered below `user-authored`) rather than
 * unlayered the way the old Alm-only injector had it. In short: unlayered
 * ALWAYS beats `@layer`d regardless of specificity, so an unlayered vendor
 * stylesheet would have beaten the user's own edits — exactly backwards from
 * "vendor is read-only scaffolding, the user's edits win."
 *
 * Never a writeback target. Neither CSS source here is ever parsed into a
 * `StyleRule`, never touches `site.styleRules`/`classIds`, and never appears
 * in the Properties panel's editable class list — the bytes are read and
 * concatenated verbatim, server-side for source 2, at Studio's own build
 * time for source 1.
 *
 * Mounted unconditionally (both design AND live mode) — mirrors
 * `ClassStyleInjector`/`UserStylesheetInjector`. It's real page CSS, not
 * editor-only chrome, so live mode needs it exactly as a design frame does.
 * Only `CanvasAnimationInjector`/`CanvasScrollUnrollInjector` are design-only.
 *
 * WS-10 Phase 1 — a package's own `prefers-color-scheme` media query (many
 * design systems ship one) is rewritten the same way `UserStylesheetInjector`
 * rewrites the project's own CSS — see `darkSchemeCssTransform.ts`.
 *
 * This injector does NOT set a theme attribute on the frame root. It used to
 * pin `data-theme="light"` (the design system's tokens default to DARK via
 * `:root:not([data-theme=light])`, so an unset root rendered dark components
 * on a white canvas) — written before the board had a dark-mode control, and
 * a second writer of the same attribute once it did. `previewAxesFrameEffect.ts`
 * is the single owner of every root attribute the preview axes drive, and it
 * now writes `data-theme` explicitly in BOTH schemes for exactly the reason
 * this pin existed. See `VENDOR_THEME_ATTR` there.
 */
import { useEffect, useSyncExternalStore } from 'react'
// Vite `?inline` yields the processed CSS as a default string export. This is
// STUDIO's OWN dependency, bundled at Studio's own build time — see source 1
// in this module's doc.
import almDesignSystemCss from '@alm-design/design-system/dist/index.css?inline'
import { getStudioVendorCss, subscribeStudioVendorCss } from '@site/studio/fsCodemodAdapter'
import { CANVAS_CSS_LAYER_ORDER, VENDOR_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'

const STYLE_TAG_ID = 'mc-vendor'

export function ProjectCssInjector({ targetDocument }: { targetDocument?: Document } = {}) {
  const projectVendorCss = useSyncExternalStore(subscribeStudioVendorCss, getStudioVendorCss, getStudioVendorCss)

  useEffect(() => {
    const doc = targetDocument ?? document
    let styleEl = doc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = doc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'ProjectCssInjector')
      // Prepend so this stylesheet — and the layer-order declaration it opens
      // with — is read before any `@layer user-authored` stylesheet, giving
      // the pre-declaration the best chance of being the very first mention
      // of either layer name. See `canvasCssLayers.ts` for why every side
      // repeats the declaration regardless.
      doc.head.insertBefore(styleEl, doc.head.firstChild)
    }
    const vendorCss = rewritePrefersColorScheme(
      [almDesignSystemCss as string, projectVendorCss].filter(Boolean).join('\n\n'),
    )
    styleEl.textContent = vendorCss
      ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${VENDOR_LAYER} {\n${vendorCss}\n}`
      : `${CANVAS_CSS_LAYER_ORDER}\n/* no vendor css */`

    return () => {
      doc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument, projectVendorCss])

  return null
}
