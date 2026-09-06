/**
 * One screen, rendered exactly the way a board frame renders it, with nothing
 * around it.
 *
 * The composition is `AgentSnapshotFrame`'s — `IframeFrameSurface` in
 * `interaction="capture"` mode wrapping `CanvasComposedTree`, so the frame's
 * `<body>` is a real document, every design-frame injector applies
 * (`AuthoredCssInjector`, `ClassStyleInjector`, `ProjectCssInjector`,
 * `CanvasAnimationInjector`'s freeze, `CanvasScrollUnrollInjector`'s
 * scroll-unroll) and the DOM the driver photographs is the DOM the canvas
 * shows. Two differences, both deliberate:
 *
 *   1. **In flow, not offscreen.** `AgentSnapshotFrame` portals itself to
 *      `position: fixed; inset-inline-start: -100000px` because it is a
 *      transient mount inside a live editor that must not be seen. Here the
 *      whole document IS the capture surface, and a headless driver
 *      rasterises the frame element itself — so the frames sit in ordinary
 *      block flow, each tagged `data-agent-capture-frame="<pageId>"`.
 *   2. **`CanvasPageContext`, so several pages render at once.** A board frame
 *      provides its page id so `NodeRenderer` resolves against THAT page
 *      rather than the store's active document (see `BoardFrameView.tsx`).
 *      That is what makes a five-page batch one navigation instead of five.
 *
 * The synthetic breakpoint is the board's own (`id: 'studio'`, the frame's
 * width) — `[data-breakpoint-id="studio"]`-scoped class CSS has to match here
 * exactly as it matches on the board, or the capture would render unstyled in
 * precisely the cases breakpoint-scoped rules exist for.
 */
import { use, useEffect, useState } from 'react'
import type { Breakpoint, Page } from '@core/page-tree'
import { CanvasComposedTree } from '@site/canvas/CanvasComposedTree'
import {
  CanvasBreakpointContext,
  CanvasDocumentContext,
  CanvasPageContext,
} from '@site/canvas/CanvasContexts'
import { IframeFrameSurface } from '@site/canvas/IframeFrameSurface'
import {
  CanvasPreviewReadinessContext,
  createCanvasPreviewReadiness,
  type CanvasPreviewReadiness,
} from '@site/canvas/CanvasPreviewReadiness'
import { waitForDelay, waitForDocumentQuiet, waitForPromise } from '@site/canvas/canvasCaptureSettle'
import type { AgentCaptureFrameReport, AgentCaptureNodeRect } from '@core/studio-capture'
import { AGENT_CAPTURE_FRAME_ATTR } from '@core/studio-capture'
import styles from './CaptureFrame.module.css'

/** Mirrors `BoardFrameView.tsx`'s `STUDIO_BREAKPOINT_BASE` — the board's one synthetic breakpoint. */
const STUDIO_BREAKPOINT_BASE = {
  id: 'studio',
  label: 'Studio',
  mediaQuery: '(max-width: 1024px)',
  icon: 'monitor',
} as const

/**
 * A frame that never settles must not hold the whole batch hostage — it
 * reports itself as a per-frame failure and lets the other frames answer. The
 * server's own `readyTimeoutMs` is longer, so this fires first and produces a
 * NAMED failure rather than an opaque driver timeout.
 */
const FRAME_SETTLE_TIMEOUT_MS = 20_000

interface CaptureFrameProps {
  page: Page
  width: number
  onSettled: (report: AgentCaptureFrameReport) => void
}

export function CaptureFrame({ page, width, onSettled }: CaptureFrameProps) {
  const [previewReadiness] = useState(createCanvasPreviewReadiness)
  const breakpoint: Breakpoint = { ...STUDIO_BREAKPOINT_BASE, width }

  return (
    <CanvasPreviewReadinessContext.Provider value={previewReadiness}>
      <div
        className={styles.frame}
        {...{ [AGENT_CAPTURE_FRAME_ATTR]: page.id }}
        data-agent-capture-width={String(width)}
      >
        <IframeFrameSurface breakpointId={breakpoint.id} width={width} interaction="capture">
          <CanvasPageContext.Provider value={page.id}>
            <CanvasBreakpointContext.Provider value={breakpoint.id}>
              <CanvasComposedTree page={page} />
              <CaptureSettleReporter
                pageId={page.id}
                previewReadiness={previewReadiness}
                onSettled={onSettled}
              />
            </CanvasBreakpointContext.Provider>
          </CanvasPageContext.Provider>
        </IframeFrameSurface>
      </div>
    </CanvasPreviewReadinessContext.Provider>
  )
}

/**
 * Waits for this frame to be genuinely finished, then measures it.
 *
 * The wait is `AgentSnapshotFrame`'s, for the same reason it exists there: a
 * first React commit is not a finished screen. Preview data requests can still
 * be in flight, web fonts change every glyph's metrics after they load, and
 * images reflow the layout around them. Capturing before all three settle
 * produces an image that looks like evidence and is not.
 */
function CaptureSettleReporter({
  pageId,
  previewReadiness,
  onSettled,
}: {
  pageId: string
  previewReadiness: CanvasPreviewReadiness
  onSettled: (report: AgentCaptureFrameReport) => void
}) {
  const iframeDocument = use(CanvasDocumentContext)

  useEffect(() => {
    if (!iframeDocument) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FRAME_SETTLE_TIMEOUT_MS)
    void settleAndReport(pageId, iframeDocument, previewReadiness, controller.signal, onSettled)
      .finally(() => { clearTimeout(timeout) })
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [iframeDocument, pageId, previewReadiness, onSettled])

  return null
}

// Cross-document measurement stays outside the React component so the compiler
// can treat the context values as read-only React input — same split
// `AgentSnapshotFrame` makes for its own ready marker.
async function settleAndReport(
  pageId: string,
  iframeDocument: Document,
  previewReadiness: CanvasPreviewReadiness,
  signal: AbortSignal,
  onSettled: (report: AgentCaptureFrameReport) => void,
): Promise<void> {
  const settled = await waitForFrameSettled(iframeDocument, previewReadiness, signal)
  if (!settled) {
    onSettled({
      pageId,
      ok: false,
      error: `"${pageId}" did not finish rendering within ${FRAME_SETTLE_TIMEOUT_MS}ms — its preview data, fonts, or images never settled.`,
    })
    return
  }
  onSettled(measureFrame(pageId, iframeDocument))
}

/** `AgentSnapshotFrame`'s settle loop: preview-data idle → DOM quiet → fonts → DOM quiet again, restarting if new work appeared. */
async function waitForFrameSettled(
  iframeDocument: Document,
  previewReadiness: CanvasPreviewReadiness,
  signal: AbortSignal,
): Promise<boolean> {
  // Let descendant effects register their first data/media requests before an
  // initially-idle tracker can be mistaken for a finished preview.
  if (!await waitForDelay(0, signal)) return false

  while (!signal.aborted) {
    if (!await previewReadiness.waitUntilIdle(signal)) return false
    const settledRevision = previewReadiness.revision()
    if (!await waitForDocumentQuiet(iframeDocument, signal)) return false
    if (
      previewReadiness.pendingCount() !== 0 ||
      previewReadiness.revision() !== settledRevision
    ) continue

    const fonts = iframeDocument.fonts
    if (fonts?.status === 'loading' && !await waitForPromise(fonts.ready, signal)) return false
    if (!await waitForDocumentQuiet(iframeDocument, signal)) return false
    // A settled data request can add more asynchronous preview work during the
    // resource phase. Restart so the final committed DOM is included as well.
    if (
      previewReadiness.pendingCount() === 0 &&
      previewReadiness.revision() === settledRevision
    ) return true
  }
  return false
}

/**
 * Node rects in FRAME-LOCAL CSS px — the same space `studio_export_frames`
 * reports, so `studio_diff_frames` and `studio_compare` map a differing region
 * back to node ids identically whichever path captured it. Measured against
 * the iframe's own `documentElement`, which IS the captured region here.
 */
function measureFrame(pageId: string, iframeDocument: Document): AgentCaptureFrameReport {
  const root = iframeDocument.documentElement
  const rootRect = root.getBoundingClientRect()
  const cssWidth = Math.round(rootRect.width)
  const cssHeight = Math.round(Math.max(rootRect.height, root.scrollHeight))

  if (cssWidth <= 0 || cssHeight <= 0) {
    return { pageId, ok: false, error: `"${pageId}" rendered with no visible size (${cssWidth}x${cssHeight}).` }
  }

  const nodeRects: AgentCaptureNodeRect[] = []
  for (const element of iframeDocument.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const nodeId = element.dataset.nodeId
    if (!nodeId) continue
    const rect = element.getBoundingClientRect()
    nodeRects.push({
      nodeId,
      x: Math.round(rect.left - rootRect.left),
      y: Math.round(rect.top - rootRect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }

  const warnings: string[] = []
  if (root.scrollWidth > cssWidth + 2) {
    warnings.push('The captured region has horizontal overflow.')
  }

  return { pageId, ok: true, cssWidth, cssHeight, nodeRects, warnings }
}
