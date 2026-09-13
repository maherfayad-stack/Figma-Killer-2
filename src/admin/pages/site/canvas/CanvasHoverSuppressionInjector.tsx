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
 */
import { useEffect } from 'react'
import { startHoverSuppression } from '@core/studio-runtime'

/**
 * The page-content stylesheets, by the `id` each injector gives its `<style>`
 * element. Kept here rather than imported from four modules that each keep it
 * as a private `STYLE_TAG_ID` const — the list is this component's own
 * question ("whose CSS belongs to the page?"), not those modules' API.
 */
const CONTENT_STYLE_IDS = new Set(['mc-vendor', 'mc-authored', 'mc-classes', 'mc-user-styles'])

interface CanvasHoverSuppressionInjectorProps {
  targetDocument: Document | null
}

export function CanvasHoverSuppressionInjector({ targetDocument }: CanvasHoverSuppressionInjectorProps) {
  useEffect(() => {
    const doc = targetDocument
    if (!doc) return
    const controller = startHoverSuppression(doc, (owner) => CONTENT_STYLE_IDS.has(owner.id))
    return () => controller.dispose()
  }, [targetDocument])

  return null
}
