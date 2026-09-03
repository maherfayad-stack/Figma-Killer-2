/**
 * CanvasFrameInjectors — the fixed stack of stylesheets and behaviours every
 * canvas iframe document gets, in the one order that is load-bearing.
 *
 * Split out of `IframeFrameSurface`, which was at the module-size ceiling and
 * is about the IFRAME (sizing, events, lifecycle, the grow-to-content
 * contract). What CSS and chrome go INTO that document is a separate question
 * with a separate reason to change — and it is the question with the ordering
 * contract, so it deserves to be readable in one screen.
 *
 * ## The order is the contract
 *
 *   <EditorChromeInjector>   ← <style id="studio-editor-chrome">  UNLAYERED
 *   <ProjectCssInjector>     ← <style id="mc-vendor">             @layer vendor
 *   <AuthoredCssInjector>    ← <style id="mc-authored">           raw, before mc-classes
 *   <ClassStyleInjector>     ← <style id="mc-classes">            @layer user-authored
 *   <UserStylesheetInjector> ← <style id="mc-user-styles">        @layer user-authored
 *
 * Unlayered beats every layer, so editor chrome cannot be bled into by user or
 * vendor CSS at any specificity; `user-authored` is ordered above `vendor`
 * (`canvasCssLayers.ts`). `children` sit between the author CSS and the
 * runtime scripts because the scripts run against the node tree they mount.
 *
 * ## `!isLive` is a real distinction, not a flag
 *
 * A live frame is a visitor preview: real motion, real scrolling, real hover.
 * A design frame is a still working surface, so animations settle, internal
 * scroll regions unroll, and page `:hover` rules are rewritten so they cannot
 * match. Each of those has its own module and its own docblock explaining why.
 */
import type { ReactNode } from 'react'
import { EditorChromeInjector } from './EditorChromeInjector'
import { CanvasSelectionOverlayInjector } from './CanvasSelectionOverlayInjector'
import { ProjectCssInjector } from './ProjectCssInjector'
import { AuthoredCssInjector } from './AuthoredCssInjector'
import { ClassStyleInjector } from './ClassStyleInjector'
import { UserStylesheetInjector } from './UserStylesheetInjector'
import { CanvasAnimationInjector } from './CanvasAnimationInjector'
import { CanvasHoverSuppressionInjector } from './CanvasHoverSuppressionInjector'
import { CanvasScrollUnrollInjector } from './CanvasScrollUnrollInjector'
import { RuntimeScriptInjector } from './RuntimeScriptInjector'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import type { CanvasViewport } from './resolveViewportUnits'

interface CanvasFrameInjectorsProps {
  /** The frame's own document. Non-null — the caller only renders this inside its portal. */
  iframeDoc: Document
  /** A real-size visitor preview: keeps motion, scrolling and hover. */
  isLive: boolean
  /** An off-screen frame rendered only to be read back — no interactive editor chrome. */
  isCapture: boolean
  viewport: CanvasViewport | undefined
  runtimeScripts: InjectableRuntimeScript[]
  /**
   * Hands back the in-iframe overlay root once the injector has created it.
   * Typed to the injector's own `HTMLDivElement`, not a widened `HTMLElement`
   * — the caller keeps it in state and a wider parameter would not accept a
   * plain `setState`.
   */
  onOverlayRootReady: (root: HTMLDivElement | null) => void
  children: ReactNode
}

export function CanvasFrameInjectors({
  iframeDoc,
  isLive,
  isCapture,
  viewport,
  runtimeScripts,
  onOverlayRootReady,
  children,
}: CanvasFrameInjectorsProps) {
  return (
    <>
      {/* Editor-chrome stylesheet — UNLAYERED so it beats every other bucket */}
      <EditorChromeInjector targetDocument={iframeDoc} parentDocument={document} />
      {/* Design frames only: selection/hover rings + the node-name badge
          render INSIDE this document (WS-5.1) so they track the element
          with zero zoom/pan conversion. See its own docblock. */}
      {!isLive && !isCapture && (
        <CanvasSelectionOverlayInjector
          targetDocument={iframeDoc}
          parentDocument={document}
          onRootReady={onOverlayRootReady}
        />
      )}
      {/* Vendor package CSS (Alm design-system + the open project's own
          bare-specifier package CSS) — read-only, @layer vendor,
          ordered below @layer user-authored. See canvasCssLayers.ts. */}
      <ProjectCssInjector targetDocument={iframeDoc} />
      {/* Design frames only: animations play once and hold their last
          keyframe, so an imported app's infinite shimmers/spinners
          don't run forever behind the selection ring. Live mode is a
          visitor preview, so it keeps the real motion. */}
      {!isLive && <CanvasAnimationInjector targetDocument={iframeDoc} />}
      {/* Design frames only: internal scroll regions (a flex:1
          overflow:auto app shell) become content-sized so the whole
          screen is visible instead of a scrollable box. Live mode
          scrolls natively and keeps the app's own clipping. */}
      {!isLive && <CanvasScrollUnrollInjector targetDocument={iframeDoc} />}
      {/* Author CSS — @layer user-authored (board-27's raw AuthoredCssInjector always precedes mc-classes; see its own doc) */}
      <AuthoredCssInjector targetDocument={iframeDoc} viewport={viewport} />
      <ClassStyleInjector targetDocument={iframeDoc} viewport={viewport} />
      <UserStylesheetInjector targetDocument={iframeDoc} viewport={viewport} />
      {/* Design frames only, and mounted AFTER the four content
          stylesheets so its first pass sees them: the page's own
          `:hover` rules are rewritten so they cannot match. Crossing a
          board with the pointer stops repainting every control it
          passes, and the selection ring stops measuring a box the
          element only has while hovered. Live mode is a visitor
          preview and keeps real hover. */}
      {!isLive && <CanvasHoverSuppressionInjector targetDocument={iframeDoc} />}
      {children}
      {/* Runtime scripts (opt-in) run against the node tree mounted
          above. Empty list = no-op, so this is safe to always mount. */}
      <RuntimeScriptInjector targetDocument={iframeDoc} scripts={runtimeScripts} />
    </>
  )
}
