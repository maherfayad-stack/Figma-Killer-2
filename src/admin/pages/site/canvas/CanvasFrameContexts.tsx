/**
 * CanvasFrameContexts — everything a mounted canvas frame publishes to the
 * React tree portaled into it, in one place.
 *
 * Four contexts, all scoped to the same thing (the nearest frame) and all set
 * from values `IframeFrameSurface` already has in hand:
 *
 *   - the host `<iframe>` element,
 *   - its `contentDocument`,
 *   - the preview axes (direction / colour scheme) the frame renders under —
 *     the board's, with this frame's own `BoardFrame.axes` merged over them,
 *   - and its interaction model, which is what tells a node whether it is being
 *     edited or used.
 *
 * They were nested `<X.Provider>` pairs inline in `IframeFrameSurface`, which
 * is a file already sitting exactly on the module-size ceiling. "Which contexts
 * does a frame publish" is its own reason to change, separate from "how is the
 * iframe mounted, measured and wired for events", so it is its own module —
 * and adding another later costs that file nothing.
 */
import type { ReactNode } from 'react'
import type { PreviewAxes } from '@core/studio-board'
import {
  CanvasDocumentContext,
  CanvasFrameAdapterContext,
  CanvasFrameElementContext,
  CanvasInteractionContext,
} from './CanvasContexts'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import type { IframeInteraction } from './iframeBodyReset'
import { FramePreviewAxesContext } from './previewAxesFrameEffect'

export function CanvasFrameContexts({
  frameElement,
  frameDocument,
  adapter,
  axes,
  interaction,
  children,
}: {
  frameElement: HTMLIFrameElement | null
  frameDocument: Document
  /**
   * The frame's `FrameDocumentAdapter` — see `CanvasFrameAdapterContext`'s
   * own doc. `IframeFrameSurface` constructs this (`PortalFrameAdapter` for
   * `documentMode: 'portal'`, today's only real mode).
   */
  adapter: FrameDocumentAdapter | null
  /** The frame's EFFECTIVE axes — see `FramePreviewAxesContext` for why a component may need these and `html[dir]` is not enough. */
  axes: PreviewAxes
  /** Editing surface or live page — see `CanvasInteractionContext`. */
  interaction: IframeInteraction
  children: ReactNode
}) {
  return (
    <CanvasFrameElementContext.Provider value={frameElement}>
      <CanvasFrameAdapterContext.Provider value={adapter}>
        {/* `CanvasDocumentContext` is deprecated — remaining consumers are
            migrating to `CanvasFrameAdapterContext` above (STATE.md,
            `live-05`). Deleted once none are left. */}
        <CanvasDocumentContext.Provider value={frameDocument}>
          <CanvasInteractionContext.Provider value={interaction}>
            <FramePreviewAxesContext.Provider value={axes}>{children}</FramePreviewAxesContext.Provider>
          </CanvasInteractionContext.Provider>
        </CanvasDocumentContext.Provider>
      </CanvasFrameAdapterContext.Provider>
    </CanvasFrameElementContext.Provider>
  )
}
