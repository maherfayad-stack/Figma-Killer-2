/**
 * One-shot, offscreen canvas frame used by `site_render_snapshot`.
 *
 * The visible editor intentionally omits some viewport iframes: live mode only
 * mounts the active viewport, design frames may be collapsed, and a persisted
 * breakpoint may opt out through `previewFrame:false`. Snapshot capture must
 * not change any of that user-owned UI state, so CanvasRoot mounts this exact-
 * width frame only while the agent is waiting for it.
 *
 * Runtime scripts are deliberately absent. A visual evidence read must not run
 * authored behavior a second time or let an arbitrary script mutate the
 * transient DOM before it is captured.
 */

import { use, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Breakpoint, Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasComposedTree } from './CanvasComposedTree'
import {
  CanvasBreakpointContext,
  CanvasDocumentContext,
  CanvasFrameElementContext,
  CanvasTemplateContext,
} from './CanvasContexts'
import { IframeFrameSurface } from './IframeFrameSurface'
import {
  CanvasPreviewReadinessContext,
  createCanvasPreviewReadiness,
  type CanvasPreviewReadiness,
} from './CanvasPreviewReadiness'
import { settleCaptureDocument } from './canvasCaptureSettle'
import styles from './AgentSnapshotFrame.module.css'

interface AgentSnapshotFrameProps {
  requestId: string
  page: Page
  breakpoint: Breakpoint
  templateContext?: TemplateRenderDataContext
  templateContextLoading: boolean
}

export function AgentSnapshotFrame({
  requestId,
  page,
  breakpoint,
  templateContext,
  templateContextLoading,
}: AgentSnapshotFrameProps) {
  const [previewReadiness] = useState(createCanvasPreviewReadiness)
  if (typeof document === 'undefined') return null

  return createPortal(
    <CanvasPreviewReadinessContext.Provider value={previewReadiness}>
      <div
        className={styles.frame}
        data-agent-snapshot-frame=""
        data-agent-snapshot-request-id={requestId}
        data-agent-snapshot-breakpoint-id={breakpoint.id}
        aria-hidden="true"
        inert
      >
        <IframeFrameSurface
          breakpointId={breakpoint.id}
          width={breakpoint.width}
          interaction="capture"
          dataAttrs={{ 'data-agent-snapshot-iframe': requestId }}
        >
          <CanvasTemplateContext.Provider value={templateContext}>
            <CanvasBreakpointContext.Provider value={breakpoint.id}>
              <CanvasComposedTree page={page} />
              {!templateContextLoading ? (
                <AgentSnapshotReadyMarker
                  requestId={requestId}
                  previewReadiness={previewReadiness}
                />
              ) : null}
            </CanvasBreakpointContext.Provider>
          </CanvasTemplateContext.Provider>
        </IframeFrameSurface>
      </div>
    </CanvasPreviewReadinessContext.Provider>,
    document.body,
  )
}

/** Marks the host iframe after async preview data, fonts, and DOM settle. */
function AgentSnapshotReadyMarker({
  requestId,
  previewReadiness,
}: {
  requestId: string
  previewReadiness: CanvasPreviewReadiness
}) {
  const iframeDocument = use(CanvasDocumentContext)
  const iframe = use(CanvasFrameElementContext)

  useEffect(() => {
    if (!iframeDocument || !iframe) return
    const controller = new AbortController()
    void markAgentSnapshotFrameReady(
      iframe,
      iframeDocument,
      requestId,
      previewReadiness,
      controller.signal,
    )
    return () => {
      cleanupAgentSnapshotFrameReady(iframe, requestId, controller)
    }
  }, [iframe, iframeDocument, previewReadiness, requestId])

  return null
}

// Keep cross-document mutation outside the React component so the compiler can
// treat the context values as read-only React input.
async function markAgentSnapshotFrameReady(
  iframe: HTMLIFrameElement,
  iframeDocument: Document,
  requestId: string,
  previewReadiness: CanvasPreviewReadiness,
  signal: AbortSignal,
): Promise<void> {
  // One shared, bounded settle — see `canvasCaptureSettle.ts`. A frame whose
  // images 404 or whose fonts never arrive is READY, not broken: those pixels
  // are final, and the snapshot consumer needs a marked frame far more than it
  // needs a perfect one. Only a caller-side abort withholds the marker.
  const settle = await settleCaptureDocument({ document: iframeDocument, previewReadiness, signal })
  if (settle.aborted || signal.aborted) return
  // Readiness metadata belongs to editor chrome, not authored <html>/<body>.
  // User selectors therefore see exactly the DOM that will publish.
  iframe.dataset.agentSnapshotReady = requestId
}

function cleanupAgentSnapshotFrameReady(
  iframe: HTMLIFrameElement,
  requestId: string,
  controller: AbortController,
): void {
  controller.abort()
  if (iframe.dataset.agentSnapshotReady === requestId) {
    delete iframe.dataset.agentSnapshotReady
  }
}

