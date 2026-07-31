/**
 * `studio_export_frames` (WS-9.2) — browser-bridged batch capture of Studio
 * board frames, driven by an external MCP agent auditing a board visually.
 *
 * Unlike `site_render_snapshot` (`renderSnapshotAtBreakpoint.ts`), which
 * mounts ONE transient, offscreen `AgentSnapshotFrame` at an exact
 * breakpoint width, a Studio board's per-page frames render side-by-side on
 * an infinite pan/zoom canvas (`BoardFramesLayer`), and every frame shares
 * one synthetic `'studio'` breakpoint id — there is no `Breakpoint` object in
 * `site.breakpoints` to hand a transient mount, and building one requires
 * touching `CanvasRoot.tsx`/`BoardFramesLayer.tsx` (reserved by a concurrent
 * work order at the time this shipped — see STATE.md `mcp-02`).
 *
 * Instead this captures the REAL, already-mounted board frame: for each
 * requested page it
 *   1. forces `zoom` to 1 and pans so the frame's board-space rect sits fully
 *      on screen — `getBoundingClientRect()` then reports the frame's true
 *      1:1 CSS pixel size, independent of whatever zoom the user had before
 *      the call (the CMS offscreen mount gets this same width-determinism
 *      for free; this is the equivalent guarantee for a visible frame),
 *   2. activates the page (`openPageInCanvas`, the same action a frame click
 *      performs) so the board actually mounts a live iframe for it,
 *   3. waits for the iframe to mount + settle (DOM-quiet + fonts, reusing
 *      `canvasCaptureSettle.ts`'s primitives — the same ones the CMS
 *      transient mount waits on), then
 *   4. captures via the SAME `captureAgentRenderSnapshot` pipeline
 *      `site_render_snapshot` uses, keyed by the new `pageId` filter on
 *      `findAgentRenderFrame` (`renderEvidence.ts`).
 *
 * Because step 3 waits on the frame's REAL DOM (mounted through the normal
 * `IframeFrameSurface`), every design-frame injector already applies —
 * `CanvasAnimationInjector` (freeze) and `CanvasScrollUnrollInjector`
 * (scroll-unroll) run for every design frame unconditionally, so this
 * capture honours both without any Studio-specific wiring.
 *
 * Side effect, by design: this temporarily changes the LIVE canvas's pan/
 * zoom/active-page (and, via `openPageInCanvas`, clears the current node
 * selection) for the duration of the batch, restoring pan/zoom/active-page
 * afterward. A user actively working in the same browser session sees their
 * view jump during the export and their selection drop — the same class of
 * disruption any browser-bridged tool accepts, documented here because
 * Studio (unlike CMS's single active document) keeps several pages visible
 * at once, so the jump is more noticeable. See STATE.md `mcp-02` for the
 * follow-up that removes it (an offscreen, zoom-independent mount once
 * `CanvasRoot.tsx` is free to touch).
 */
import {
  aiToolError,
  aiToolOk,
  StudioExportFramesInputSchema,
  type AiToolImage,
  type AiToolOutput,
} from '@core/ai'
import type { Static } from '@core/utils/typeboxHelpers'
import type { EditorStore } from '@site/store/types'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { FRAME_WIDTH, FRAME_HEIGHT } from '@site/canvas/BoardFramesLayer/frameGrid'
import { getAgentStoreApi } from './storeRef'
import { captureAgentRenderSnapshot, waitForAgentRenderFrame } from './renderEvidence'
import { waitForDelay, waitForDocumentQuiet, waitForPromise } from '../canvas/canvasCaptureSettle'

type StudioExportFramesInput = Static<typeof StudioExportFramesInputSchema>

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

const STUDIO_BREAKPOINT_ID = 'studio'
/** Safe on-screen offset (board units) so a frame's top-left never sits flush at the viewport edge. */
const VIEWPORT_MARGIN = 80
const FRAME_MOUNT_TIMEOUT_MS = 8_000
const SETTLE_TIMEOUT_MS = 4_000

// Serializes concurrent calls (mirrors `renderSnapshotAtBreakpoint.ts`'s own
// tail) — this tool drives shared canvas state (zoom/pan/activePageId), so
// two overlapping batches must not interleave their save/restore.
let exportTail: Promise<void> = Promise.resolve()

interface FrameExportSuccess {
  pageId: string
  ok: true
  width: number
  height: number
  /** Index into the tool result's `images[]` array — the MCP image block for this frame. */
  imageIndex: number
  /** Node rects in frame-local coordinates, reusable as `studio_diff_frames`' `nodeRects` input. */
  nodeRects: Array<{ nodeId: string; x: number; y: number; width: number; height: number }>
  warnings: string[]
}

interface FrameExportFailure {
  pageId: string
  ok: false
  error: string
}

export async function runStudioExportFrames(rawInput: unknown): Promise<AiToolOutput> {
  const input = rawInput as StudioExportFramesInput
  const precedingExport = exportTail
  let releaseExport!: () => void
  exportTail = new Promise<void>((resolve) => { releaseExport = resolve })
  await precedingExport
  try {
    return await exportFrames(input)
  } finally {
    releaseExport()
  }
}

async function exportFrames(input: StudioExportFramesInput): Promise<AiToolOutput> {
  const store = getStoreState()
  if (!store.site) return aiToolError('No project is open in the Studio editor.')
  const board = selectActiveBoard(store)
  if (!board) {
    return aiToolError(
      'No Studio board is open. Open the project at /admin/site?studio (as the connector owner) and try again.',
    )
  }

  const original = { activePageId: store.activePageId, zoom: store.zoom, panX: store.panX, panY: store.panY }

  const results: Array<FrameExportSuccess | FrameExportFailure> = []
  const images: AiToolImage[] = []

  try {
    for (const pageId of input.pageIds) {
      const page = store.site.pages.find((p) => p.id === pageId)
      if (!page) {
        results.push({ pageId, ok: false, error: `Page not found: ${pageId}` })
        continue
      }
      const frame = board.frames.find((f) => f.pageId === pageId)
      if (!frame) {
        results.push({
          pageId,
          ok: false,
          error: `Page ${pageId} is not on the currently open board ("${board.name}"). Switch to the board that curates it and retry.`,
        })
        continue
      }

      const frameWidth = frame.width ?? FRAME_WIDTH
      const frameHeight = frame.height ?? FRAME_HEIGHT
      getStoreState().setCanvasTransform(1, VIEWPORT_MARGIN - frame.x, VIEWPORT_MARGIN - frame.y)
      getStoreState().openPageInCanvas(pageId)

      const mounted = await waitForAgentRenderFrame(
        { breakpointId: STUDIO_BREAKPOINT_ID, pageId, source: 'visible', requireReady: true },
        FRAME_MOUNT_TIMEOUT_MS,
      )
      if (!mounted) {
        results.push({
          pageId,
          ok: false,
          error: `Frame for page ${pageId} did not mount within ${FRAME_MOUNT_TIMEOUT_MS}ms (frame size ${frameWidth}x${frameHeight}).`,
        })
        continue
      }

      const iframeDoc = mounted.querySelector<HTMLIFrameElement>('iframe')?.contentDocument ?? null
      if (iframeDoc) await waitForSettle(iframeDoc)

      const snapshot = await captureAgentRenderSnapshot({
        breakpointId: STUDIO_BREAKPOINT_ID,
        pageId,
        captureScreenshot: true,
        pixelRatio: input.dpr,
        frame: mounted,
      })
      if (!snapshot || snapshot.screenshot.status !== 'ok' || !snapshot.screenshot.data) {
        results.push({
          pageId,
          ok: false,
          error: snapshot?.screenshot.status === 'error'
            ? snapshot.screenshot.error ?? 'Screenshot capture failed.'
            : `Could not capture page ${pageId} — the frame was not in a capturable state.`,
        })
        continue
      }

      const imageIndex = images.length
      images.push({ mimeType: snapshot.screenshot.mimeType ?? 'image/png', data: snapshot.screenshot.data })
      results.push({
        pageId,
        ok: true,
        width: snapshot.screenshot.width ?? snapshot.width,
        height: snapshot.screenshot.height ?? snapshot.layout.viewport.height,
        imageIndex,
        nodeRects: snapshot.layout.nodes.map((n) => ({
          nodeId: n.nodeId,
          x: n.rect.x,
          y: n.rect.y,
          width: n.rect.width,
          height: n.rect.height,
        })),
        warnings: snapshot.layout.warnings.map((w) => w.message),
      })
    }
  } finally {
    getStoreState().setCanvasTransform(original.zoom, original.panX, original.panY)
    if (original.activePageId) getStoreState().openPageInCanvas(original.activePageId)
  }

  return aiToolOk({ frames: results }, images)
}

/** Bounded DOM-quiet + fonts-ready wait, reusing the same primitives the CMS transient capture waits on. */
async function waitForSettle(doc: Document): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SETTLE_TIMEOUT_MS)
  try {
    if (!await waitForDelay(0, controller.signal)) return
    if (!await waitForDocumentQuiet(doc, controller.signal)) return
    const fonts = doc.fonts
    if (fonts?.status === 'loading') {
      if (!await waitForPromise(fonts.ready, controller.signal)) return
    }
    await waitForDocumentQuiet(doc, controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}
