/**
 * CanvasHoverSuppressionInjector — stops the page's own `:hover` styles from
 * firing inside a DESIGN canvas frame. Live frames are a visitor preview and
 * keep real hover, exactly as `CanvasAnimationInjector` keeps real motion.
 *
 * The rewrite logic and the document-walking implementation live in
 * `@core/studio-runtime` (`hoverSuppressionRules.ts`) — shared verbatim with
 * the in-frame live runtime (`runtime.ts`), which needs the exact same
 * selector rewrite for a Tier 2 frame in its own `'design'` interaction mode.
 * See that module's docblock for the full "why a rewrite, not a stylesheet"
 * and "why a class" reasoning.
 *
 * This component owns exactly one thing the shared module cannot: WHICH
 * stylesheets in THIS document count as "page content" to rewrite. An
 * ALLOWLIST of the four page-content stylesheets, never a denylist: the
 * editor's own chrome (`studio-editor-chrome`, the selection overlay, the
 * resize handles) lives in this same document and uses `:hover` for real
 * affordances. A denylist would break those the moment anyone adds a fifth
 * chrome stylesheet; an allowlist fails closed, leaving a page rule
 * hovering, which is a visible nuisance rather than a broken editor. (The
 * live runtime uses the opposite shape — a DENYLIST of its own overlay ids —
 * because it has no separate "editor chrome" stylesheet namespace to
 * allowlist: a live frame IS the project's own document.)
 *
 * Portal mode only (`live-05`, STATE.md, Batch 5) — reads the frame's
 * `Document` through `PortalFrameAdapter`'s escape hatch, calling
 * `startHoverSuppression` directly rather than `adapter.setInteractionMode`,
 * for the same reason as its `CanvasAnimationInjector`/
 * `CanvasScrollUnrollInjector` siblings: `setInteractionMode`'s own hover
 * controller (Batch 1, for a future bridge-mode caller) uses a DENYLIST
 * allowlist shape unrelated to this component's own CONTENT_STYLE_IDS
 * allowlist, and coupling them now would mean this component stops
 * controlling ITS OWN mount/unmount lifecycle independently of scroll-unroll
 * and animation-freeze, which today it correctly does (`IframeFrameSurface`
 * mounts these three as three separate, independently-toggleable
 * components, not one bundle).
 */
import { useContext, useEffect } from 'react'
import { OVERLAY_ID_ATTR, startHoverSuppression } from '@core/studio-runtime'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'

/**
 * The page-content stylesheets, by the LOGICAL id each of the five CSS-text
 * injectors passes to `adapter.applyOverlay` (`mc-vendor`, `mc-authored`,
 * `mc-classes`, `mc-user-styles`) — kept here rather than imported from those
 * modules' own private `STYLE_TAG_ID` consts, since the list is this
 * component's own question ("whose CSS belongs to the page?"), not those
 * modules' API.
 *
 * Matched against `owner.getAttribute(OVERLAY_ID_ATTR)`, not `owner.id`:
 * since `live-05` (STATE.md), those four injectors mount through
 * `PortalFrameAdapter.applyOverlay`, whose managed style elements carry a
 * PREFIXED physical DOM `id` and store the bare logical name in this
 * attribute instead — see `overlayStyleAttr.ts`'s own doc.
 */
const CONTENT_STYLE_IDS = new Set(['mc-vendor', 'mc-authored', 'mc-classes', 'mc-user-styles'])

export function CanvasHoverSuppressionInjector() {
  const adapter = useContext(CanvasFrameAdapterContext)

  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const doc = adapter.getPortalWindow()?.document
    if (!doc) return
    const controller = startHoverSuppression(
      doc,
      (owner) => CONTENT_STYLE_IDS.has(owner.getAttribute(OVERLAY_ID_ATTR) ?? owner.id),
    )
    return () => controller.dispose()
  }, [adapter])

  return null
}
