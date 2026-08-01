import { createContext, type MouseEvent, type RefObject } from 'react'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'

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
  onNodeHover: (nodeId: string | null, breakpointId?: string, frameId?: string | null) => void
  onNodeContextMenu: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void
  onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void
}

export const CanvasSelectionContext = createContext<CanvasSelectionContextValue>({
  onNodeClick: () => {},
  onNodeHover: () => {},
  onNodeContextMenu: () => {},
  onNodeDoubleClick: () => {},
})

interface CanvasViewportActionsContextValue {
  canvasRootRef: RefObject<HTMLElement | null>
  panBy: (dx: number, dy: number) => void
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
/** Final srcDoc document owned by the nearest IframeFrameSurface. */
export const CanvasDocumentContext = createContext<Document | null>(null)
/** Host iframe element owned by the nearest IframeFrameSurface. */
export const CanvasFrameElementContext = createContext<HTMLIFrameElement | null>(null)
