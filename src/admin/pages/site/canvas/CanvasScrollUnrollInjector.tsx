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

import { useContext, useEffect } from 'react'
import { startScrollUnroll } from '@core/studio-runtime'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'

const STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

interface CanvasScrollUnrollInjectorProps {
  /** Toggleable per board ("Unroll scroll" in the canvas toolbar). Default on. */
  enabled?: boolean
}

/**
 * Portal mode only (`live-05`, STATE.md, Batch 5) — reads the frame's
 * `Document` through `PortalFrameAdapter`'s escape hatch, calling
 * `startScrollUnroll` directly exactly as before rather than
 * `adapter.setInteractionMode`. Kept independent of `setInteractionMode` for
 * the same reason as `CanvasAnimationInjector`: this component has its own
 * `enabled` toggle (the canvas toolbar's "Unroll scroll" switch) that
 * `setInteractionMode`'s binary design/live coupling doesn't model, and
 * `setInteractionMode`'s own scroll-unroll controller (built in Batch 1 for
 * a future bridge-mode caller) uses a DIFFERENT style-tag id — no literal
 * collision either way, but running both would be pure redundant work with
 * no real caller needing it yet.
 */
export function CanvasScrollUnrollInjector({ enabled = true }: CanvasScrollUnrollInjectorProps) {
  const adapter = useContext(CanvasFrameAdapterContext)

  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const targetDocument = adapter.getPortalWindow()?.document
    if (!targetDocument) return
    if (!enabled) {
      targetDocument.getElementById(STYLE_TAG_ID)?.remove()
      return
    }
    const controller = startScrollUnroll(targetDocument, STYLE_TAG_ID, 'CanvasScrollUnrollInjector')
    return () => controller.dispose()
  }, [adapter, enabled])

  return null
}
