/**
 * ProjectCssInjector — injects VENDOR CSS into a canvas iframe's `<head>`:
 * CSS that belongs to a package, not to the user's own project, so it must
 * render but stay READ-ONLY and lose to the user's own edits. WS-2.3 of
 * `STUDIO-IMPORT-V2-PLAN.md`.
 *
 * Two sources, concatenated into one bucket
 * ──────────────────────────────────────────
 * 1. The BUILT-IN design system's bundled stylesheet — Studio's own vendored
 *    copy (`vendor/alm-design-system/dist/index.css`, a committed build
 *    artefact), not anything the open project installed, imported once at
 *    Studio's own build time via Vite `?inline` (`canvasVendorCss.ts`). It is
 *    injected into EVERY frame, at every trust tier, because the `alm.*`
 *    module pack renders from Studio's own code — a project's own
 *    `design-system/` folder exists so its repository builds standalone, and
 *    is never read back for the canvas.
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
 * rewrites the project's own CSS — see `darkSchemeCssTransform.ts`. That
 * rewrite, and the concatenation feeding it, live in `canvasVendorCss.ts` and
 * are memoised across frames: the bytes are identical in every iframe, so
 * paying for them per mount was pure waste.
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
import { useContext, useEffect, useSyncExternalStore } from 'react'
import { getStudioVendorCss, subscribeStudioVendorCss } from '@site/studio/fsCodemodAdapter'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { buildVendorCss } from './canvasVendorCss'

const STYLE_TAG_ID = 'mc-vendor'

export function ProjectCssInjector() {
  const projectVendorCss = useSyncExternalStore(subscribeStudioVendorCss, getStudioVendorCss, getStudioVendorCss)
  const adapter = useContext(CanvasFrameAdapterContext)

  useEffect(() => {
    if (!adapter) return
    adapter.applyOverlay(STYLE_TAG_ID, buildVendorCss(projectVendorCss))
  }, [adapter, projectVendorCss])

  useEffect(() => {
    return () => adapter?.removeOverlay(STYLE_TAG_ID)
  }, [adapter])

  return null
}
