import { createContext, type MouseEvent, type RefObject } from 'react'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import type { IframeInteraction } from './iframeBodyReset'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'

/**
 * WS-10 Phase 2 — `frameId` is a SEPARATE dimension from `breakpointId`, not
 * an alias for it. `breakpointId` is load-bearing for CSS write-back and the
 * `data-breakpoint-id` selector scope (`styleRuleWriteback.test.ts` gates the
 * literal `'studio'` id every board frame shares — see `BoardFramesLayer.tsx`'s
 * "KNOWN LIMITATION"), so it CANNOT be repurposed to carry per-`BoardFrame`
 * identity. `frameId` is `null` outside board context (every CMS/VC frame,
 * where selection/hover intentionally stay UNSCOPED — see
 * `BreakpointSelectionOverlay.tsx`'s "Selection applies to all frames
 * simultaneously" doc) and the owning `BoardFrame.id` inside one. Two board
 * frames of the SAME page ("duplicate as variant") share every node id
 * (trap #2 — a node id is a write target, not a display identity), so this is
 * the only thing that can tell them apart for editor-session state.
 */
export const CanvasFrameContext = createContext<string | null>(null)

interface CanvasSelectionContextValue {
  onNodeClick: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void
  /** A click forwarded out of a cross-origin bridge frame — see `useCanvasNodeInteraction`'s `onFrameNodeClick`. */
  onFrameNodeClick: (
    nodeId: string,
    modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
    breakpointId?: string,
    frameId?: string | null,
  ) => void
  onNodeHover: (nodeId: string | null, breakpointId?: string, frameId?: string | null) => void
  onNodeContextMenu: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void
  onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void
  /**
   * The press and the release of ONE pointer gesture on a node, which is how
   * the armed player follows a link — see `useCanvasNodeInteraction`'s
   * `onNodePointerDown`. Both are no-ops unless the player is armed; the
   * editing canvas still activates on `click`.
   */
  onNodePointerDown: (nodeId: string) => void
  onNodePointerUp: (nodeId: string) => void
}

export const CanvasSelectionContext = createContext<CanvasSelectionContextValue>({
  onNodeClick: () => {},
  onFrameNodeClick: () => {},
  onNodeHover: () => {},
  onNodeContextMenu: () => {},
  onNodeDoubleClick: () => {},
  onNodePointerDown: () => {},
  onNodePointerUp: () => {},
})

interface CanvasViewportActionsContextValue {
  canvasRootRef: RefObject<HTMLElement | null>
  panBy: (dx: number, dy: number) => void
  /**
   * D1 — the LIVE canvas transform ref from `useCanvas()`. Threaded through
   * context (rather than a prop) so deep consumers that don't otherwise sit
   * in `CanvasRoot`'s own JSX — `RulerGuidesLayer`, several `CanvasTransformLayer`
   * levels down — can read live pan/zoom without a prop-drilled chain through
   * every intermediate layer. See `CanvasTransform`'s doc in `useCanvas.ts`
   * for why the store's `zoom`/`panX`/`panY` are the wrong thing to read here.
   */
  transformRef: RefObject<CanvasTransform>
}

export const CanvasViewportActionsContext =
  createContext<CanvasViewportActionsContextValue | null>(null)

export const CanvasBreakpointContext = createContext<string | undefined>(undefined)
/**
 * The page id whose tree the current frame renders. `null` (the default, used
 * by every CMS/VC frame) means "resolve the active canvas document" — i.e.
 * pre-board behavior. Board frames render multiple pages at once, so each frame
 * provides its own page id here and `NodeRenderer` resolves node content against
 * it instead of the single active document. See `selectCanvasPageFor`.
 */
export const CanvasPageContext = createContext<string | null>(null)
export const CanvasTemplateContext = createContext<TemplateRenderDataContext | undefined>(undefined)
/**
 * The `FrameDocumentAdapter` for the nearest `IframeFrameSurface` — `null`
 * only before the surface's iframe document exists yet (never null once a
 * frame has actually loaded). Every injector/hook under `canvas/` reads the
 * frame's document through this adapter instead of a raw `Document`, so the
 * SAME call sites drive a same-origin portal frame (`PortalFrameAdapter`) or
 * a cross-origin Tier 2 bridge frame (`BridgeFrameAdapter`) — see
 * `frameAdapter/FrameDocumentAdapter.ts` and `STATE.md`'s `live-05` entry.
 */
export const CanvasFrameAdapterContext = createContext<FrameDocumentAdapter | null>(null)
/** Host iframe element owned by the nearest IframeFrameSurface. */
export const CanvasFrameElementContext = createContext<HTMLIFrameElement | null>(null)
/**
 * What KIND of frame a node is being rendered into, from the nearest
 * `IframeFrameSurface`.
 *
 * A design frame is an editing surface where an authored control must not
 * activate — clicking a `<select>` should select the node, not drop the
 * browser's picker over the canvas. A LIVE frame is the opposite: it is the
 * page as a visitor gets it, so its controls have to work, including typing
 * into a field. Every other live-vs-design divergence in a frame is already
 * decided from this same value (`iframeBodyReset`, the hover / animation /
 * scroll-unroll injectors, `useCanvasFormControlSuppression`), and node-level
 * suppression was the one place still deciding it for both at once.
 *
 * `'canvas'` by default so a node rendered outside any frame keeps the editing
 * behaviour it has always had.
 */
export const CanvasInteractionContext = createContext<IframeInteraction>('canvas')
/**
 * Z5/P8 — the key under which this frame's runtime diagnostics are published,
 * so a component OUTSIDE the frame (the board frame's badge, the Play
 * surface's crash card) can subscribe to them.
 *
 * Deliberately NOT `CanvasFrameContext` (the board-frame id), even though a
 * board frame passes exactly that value: the Play surface has no board frame
 * and provides `live:<pageId>` instead, and `CanvasFrameContext` is read by
 * `NodeRenderer` to scope SELECTION — giving the player's frames one would
 * change what a selection means, to make a badge work. Two different
 * questions, two contexts.
 *
 * `null` (the default) means "collect for the agent, notify no UI" — which is
 * the right answer for a capture frame and an agent snapshot frame, neither of
 * which any human is looking at.
 *
 * Crosses the `createPortal` boundary like every other context here: a portal
 * is a DOM relocation, not a fiber-tree one, so a provider outside
 * `IframeFrameSurface` still reaches the injectors rendered inside the frame.
 */
export const CanvasDiagnosticsScopeContext = createContext<string | null>(null)
