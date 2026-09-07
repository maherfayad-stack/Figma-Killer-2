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
 *   3. **The settle waits on module registration.** An editor frame is mounted
 *      into a session whose modules registered minutes ago and re-renders
 *      through `registry.subscribe` if one arrives late; this frame is
 *      photographed once, so it takes `mountCanvasModuleSet`'s promise as a
 *      settle precondition. See `canvasCaptureSettle.ts`'s `modules` phase.
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
import { CAPTURE_SETTLE_TIMEOUT_MS, settleCaptureDocument } from '@site/canvas/canvasCaptureSettle'
import type { AgentCaptureFrameReport, AgentCaptureNodeRect } from '@core/studio-capture'
import { AGENT_CAPTURE_FRAME_ATTR } from '@core/studio-capture'
import { registerSettledFrameDocument } from './frameInspectBridge'
import styles from './CaptureFrame.module.css'

/** Mirrors `BoardFrameView.tsx`'s `STUDIO_BREAKPOINT_BASE` — the board's one synthetic breakpoint. */
const STUDIO_BREAKPOINT_BASE = {
  id: 'studio',
  label: 'Studio',
  mediaQuery: '(max-width: 1024px)',
  icon: 'monitor',
} as const

/**
 * A frame that never settles must not hold the whole batch hostage. The
 * server's own `readyTimeoutMs` is longer, so this bound fires first and the
 * frame reports itself with a NAMED reason rather than producing an opaque
 * driver timeout.
 *
 * It is the OUTER bound only — `settleCaptureDocument` bounds each phase
 * (images, fonts, DOM quiet) well inside it and turns an expired phase into a
 * warning on an otherwise-good capture. Reaching this ceiling no longer fails
 * the frame; see `settleAndReport`.
 */
const FRAME_SETTLE_TIMEOUT_MS = CAPTURE_SETTLE_TIMEOUT_MS

interface CaptureFrameProps {
  page: Page
  width: number
  /**
   * `mountCanvasModuleSet`'s in-flight registration for this project. The
   * frame must not be measured before it lands or a `pkg.*` node is
   * photographed as a placeholder — see `canvasCaptureSettle.ts`'s `modules`
   * phase. Shared by every frame in the batch: the module registry is global.
   */
  moduleRegistration: Promise<void>
  onSettled: (report: AgentCaptureFrameReport) => void
}

export function CaptureFrame({ page, width, moduleRegistration, onSettled }: CaptureFrameProps) {
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
                moduleRegistration={moduleRegistration}
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
 * The wait is `settleCaptureDocument`'s, for the reason it exists: a first
 * React commit is not a finished screen. Preview data requests can still be in
 * flight, web fonts change every glyph's metrics after they load, and images
 * reflow the layout around them. Capturing before all three settle produces an
 * image that looks like evidence and is not.
 *
 * The `AbortController` here is ONLY unmount/cancellation. The settle deadline
 * belongs to `settleCaptureDocument`, which returns a bounded result instead of
 * being cut off — an abort would leave this frame with no entry at all, and the
 * capture run would hang until the driver's own (longer) ready timeout.
 */
function CaptureSettleReporter({
  pageId,
  previewReadiness,
  moduleRegistration,
  onSettled,
}: {
  pageId: string
  previewReadiness: CanvasPreviewReadiness
  moduleRegistration: Promise<void>
  onSettled: (report: AgentCaptureFrameReport) => void
}) {
  const iframeDocument = use(CanvasDocumentContext)

  useEffect(() => {
    if (!iframeDocument) return
    const controller = new AbortController()
    void settleAndReport(pageId, iframeDocument, previewReadiness, moduleRegistration, controller.signal, onSettled)
    return () => { controller.abort() }
  }, [iframeDocument, pageId, previewReadiness, moduleRegistration, onSettled])

  return null
}

// Cross-document measurement stays outside the React component so the compiler
// can treat the context values as read-only React input — same split
// `AgentSnapshotFrame` makes for its own ready marker.
async function settleAndReport(
  pageId: string,
  iframeDocument: Document,
  previewReadiness: CanvasPreviewReadiness,
  moduleRegistration: Promise<void>,
  signal: AbortSignal,
  onSettled: (report: AgentCaptureFrameReport) => void,
): Promise<void> {
  const settle = await settleCaptureDocument({
    document: iframeDocument,
    previewReadiness,
    moduleRegistration,
    signal,
    timeoutMs: FRAME_SETTLE_TIMEOUT_MS,
  })
  // An ABORT is the caller going away (unmount, a superseded run) — there is
  // nobody left to report to, and reporting a failure would poison a batch the
  // driver has already stopped reading.
  if (settle.aborted) return

  // A frame that did not fully settle is still PHOTOGRAPHED. A 404 image and a
  // font that never arrives will not change these pixels again, and a document
  // that never stops mutating has no "after" to wait for — so the honest answer
  // is the image the user is looking at, plus the named reason it is imperfect.
  // Refusing here is what turned one broken asset into "PNG export failed".
  // See `canvasCaptureSettle.ts`'s module doc.
  registerSettledFrameDocument(pageId, iframeDocument)
  const report = measureFrame(pageId, iframeDocument)
  if (!report.ok || settle.warnings.length === 0) {
    onSettled(report)
    return
  }
  onSettled({ ...report, warnings: [...report.warnings, ...settle.warnings] })
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
