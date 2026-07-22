import { createContext, type MouseEvent, type RefObject } from 'react'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'

interface CanvasSelectionContextValue {
  onNodeClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
  onNodeHover: (nodeId: string | null, breakpointId?: string) => void
  onNodeContextMenu: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
  onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
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
