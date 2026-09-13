/**
 * NodeStylePreviewInjector — `panel-21` / P2 rule 7's Element (inline)
 * preview channel, the mirror of `ClassStyleInjector`'s `mc-classes-preview`
 * `<style>` tag for the CLASS target.
 *
 * The merged inspector composer (`WriteTargetStyleComposer`) can resolve a
 * scrub/drag to EITHER a class or the node's own inline layer
 * (`resolveWriteTarget.ts`); the class half already had a preview channel
 * (`previewClassStyles`) with no store write and no history entry. The
 * inline half did not — `InlineStyleComposer`/`MultiInlineStyleComposer`
 * wired `onPreview` to a no-op. This component + `previewNodeStyles` (the
 * store's UI-only transient state) close that gap the same way: a
 * higher-specificity `<style>` tag, never a store write.
 *
 * Mounted once per canvas frame document, alongside `ClassStyleInjector` —
 * see `IframeFrameSurface.tsx`.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { useResponsiveEditorMediaAssets } from '@admin/shared/media/hooks/useResponsiveBackgroundStyle'
import { generateNodePreviewCSS } from './canvasClassCss'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'
import { USER_AUTHORED_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'

const PREVIEW_STYLE_TAG_ID = 'mc-node-style-preview'

interface NodeStylePreviewInjectorProps {
  targetDocument?: Document
  viewport?: CanvasViewport
}

export function NodeStylePreviewInjector({ targetDocument, viewport }: NodeStylePreviewInjectorProps = {}) {
  const previewNodeStyles = useEditorStore((s) => s.previewNodeStyles)
  const { mediaAssets: responsiveMediaAssets } = useResponsiveEditorMediaAssets([])

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let previewEl = targetDoc.getElementById(PREVIEW_STYLE_TAG_ID) as HTMLStyleElement | null
    if (!previewNodeStyles) {
      if (previewEl) previewEl.textContent = ''
      return
    }
    if (!previewEl) {
      previewEl = targetDoc.createElement('style')
      previewEl.id = PREVIEW_STYLE_TAG_ID
      previewEl.setAttribute('data-source', 'NodeStylePreviewInjector')
      targetDoc.head.appendChild(previewEl)
    }
    const previewCss = generateNodePreviewCSS(previewNodeStyles.nodeId, previewNodeStyles.styles, {
      mediaAssets: responsiveMediaAssets,
    })
    const resolved = rewritePrefersColorScheme(
      viewport ? resolveViewportUnitsForCanvas(previewCss, viewport) : previewCss,
    )
    previewEl.textContent = resolved ? `@layer ${USER_AUTHORED_LAYER} {\n${resolved}\n}` : ''
  }, [targetDocument, viewport, previewNodeStyles, responsiveMediaAssets])

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    return () => {
      targetDoc.getElementById(PREVIEW_STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
