/**
 * CanvasFrameContexts — everything a mounted canvas frame publishes to the
 * React tree portaled into it, in one place.
 *
 * Three contexts, all scoped to the same thing (the nearest frame) and all
 * set from the same three values `IframeFrameSurface` already has in hand:
 *
 *   - the host `<iframe>` element,
 *   - its `contentDocument`,
 *   - the preview axes (direction / colour scheme) the frame renders under —
 *     the board's, with this frame's own `BoardFrame.axes` merged over them.
 *
 * They were three nested `<X.Provider>` pairs inline in `IframeFrameSurface`,
 * which is a file already sitting exactly on the module-size ceiling. "Which
 * contexts does a frame publish" is its own reason to change, separate from
 * "how is the iframe mounted, measured and wired for events", so it is its own
 * module — and adding a fourth later costs that file nothing.
 */
import type { ReactNode } from 'react'
import type { PreviewAxes } from '@core/studio-board'
import { CanvasDocumentContext, CanvasFrameElementContext } from './CanvasContexts'
import { FramePreviewAxesContext } from './previewAxesFrameEffect'

export function CanvasFrameContexts({
  frameElement,
  frameDocument,
  axes,
  children,
}: {
  frameElement: HTMLIFrameElement | null
  frameDocument: Document
  /** The frame's EFFECTIVE axes — see `FramePreviewAxesContext` for why a component may need these and `html[dir]` is not enough. */
  axes: PreviewAxes
  children: ReactNode
}) {
  return (
    <CanvasFrameElementContext.Provider value={frameElement}>
      <CanvasDocumentContext.Provider value={frameDocument}>
        <FramePreviewAxesContext.Provider value={axes}>{children}</FramePreviewAxesContext.Provider>
      </CanvasDocumentContext.Provider>
    </CanvasFrameElementContext.Provider>
  )
}
