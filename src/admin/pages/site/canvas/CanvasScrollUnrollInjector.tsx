/**
 * CanvasScrollUnrollInjector — turns every scroll region inside a DESIGN
 * canvas frame into a content-sized block, so the frame shows the whole
 * screen instead of a scrollable box.
 *
 * The stylesheet text, the pure classification (`classifyUnrollElement`),
 * and the full "measure → tag → style" DOM pass live in
 * `@core/studio-runtime` (`scrollUnrollRules.ts`) — ONE implementation,
 * shared verbatim with the in-frame live runtime (`runtime.ts`), which runs
 * the identical behaviour for a Tier 2 frame in its own `'design'`
 * interaction mode. See that module's docblock for the full rationale
 * (why the override is scoped to confirmed scroll regions, the pin ⇄ unroll
 * height contract, the `min-height` inheritance trap, and what this does not
 * handle).
 *
 * This component's only remaining job is React lifecycle: start the shared
 * behaviour when mounted + enabled, dispose it on unmount / toggle-off /
 * document swap.
 *
 * Scope
 * ─────
 * Design frames only, and only while `enabled` (default on — see
 * `IframeFrameSurface`). Never mounted in live/preview mode, never reaches
 * the publisher: this is an iframe-only `<style>` + `data-*` tagging pass,
 * not a page-tree mutation, and none of it is written back to source.
 */

import { useEffect } from 'react'
import { startScrollUnroll } from '@core/studio-runtime'

const STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

interface CanvasScrollUnrollInjectorProps {
  /** The iframe document to inject the stylesheet + tagging pass into. */
  targetDocument: Document
  /** Toggleable per board ("Unroll scroll" in the canvas toolbar). Default on. */
  enabled?: boolean
}

export function CanvasScrollUnrollInjector({
  targetDocument,
  enabled = true,
}: CanvasScrollUnrollInjectorProps) {
  useEffect(() => {
    if (!enabled) {
      targetDocument.getElementById(STYLE_TAG_ID)?.remove()
      return
    }
    const controller = startScrollUnroll(targetDocument, STYLE_TAG_ID, 'CanvasScrollUnrollInjector')
    return () => controller.dispose()
  }, [targetDocument, enabled])

  return null
}
