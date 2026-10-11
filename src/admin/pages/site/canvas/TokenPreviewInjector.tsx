/**
 * TokenPreviewInjector - paints the Variables panel's in-progress token value
 * into one canvas frame (CT-3). Mounted in every iframe frame AFTER the
 * stylesheet injectors, in `@layer user-authored` like the author's own CSS,
 * with a doubled selector (`tokenPreviewCss.ts`) so it beats the real
 * declaration. Renders nothing when no value is being typed.
 *
 * Its own `<style id="mc-token-preview">` through the frame adapter's overlay
 * API, so a keystroke rewrites this one tag and nothing else - no class CSS is
 * regenerated, no document is reloaded, and the preview vanishes the moment
 * the store clears it.
 */
import { useContext, useEffect, useSyncExternalStore } from 'react'
import { getStudioTokenPreview, subscribeStudioTokenPreview } from '@site/studio/studioTokenPreview'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { USER_AUTHORED_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'
import { buildTokenPreviewCss } from './tokenPreviewCss'

const STYLE_TAG_ID = 'mc-token-preview'

export function TokenPreviewInjector() {
  const adapter = useContext(CanvasFrameAdapterContext)
  const preview = useSyncExternalStore(subscribeStudioTokenPreview, getStudioTokenPreview, getStudioTokenPreview)

  useEffect(() => {
    if (!adapter) return
    const css = rewritePrefersColorScheme(buildTokenPreviewCss(preview))
    adapter.applyOverlay(STYLE_TAG_ID, css ? `@layer ${USER_AUTHORED_LAYER} {\n${css}\n}` : '')
  }, [adapter, preview])

  useEffect(() => {
    return () => adapter?.removeOverlay(STYLE_TAG_ID)
  }, [adapter])

  return null
}
