import type { EditorStoreSliceCreator } from '@site/store/types'
import {
  INITIAL_ZOOM,
  RESET_ZOOM,
  clampZoom,
  clampPan,
  nearestZoomStep,
} from '@site/canvas/math'
import { DEFAULT_PREVIEW_AXES, type PreviewAxes } from '@core/studio-board'
// Type-only: the store carries the canvas's published gesture contract but
// never imports canvas DOM code at runtime.
import type { CanvasViewportCommands } from '@site/canvas/canvasViewportCommands'

type CanvasMode = 'select' | 'pan' | 'insert'

interface AgentSnapshotCaptureRequest {
  requestId: string
  breakpointId: string
}

/**
 * Canvas render mode.
 *
 * - 'design': the multi-breakpoint editing canvas — every breakpoint frame is
 *   shown side-by-side with pan/zoom. Fully reactive to property edits.
 * - 'live': a single editable frame at 100% (fluid full-width, optionally
 *   clamped to a breakpoint width) with normal vertical scrolling, like a
 *   conventional visual editor's live view. It reuses the SAME editable iframe
 *   the design canvas uses (React-rendered node tree), so selection, the
 *   properties panel, and structural edits all keep working — it is not a
 *   read-only preview.
 *
 * Both views render the editable node tree; `live` just drops the infinite
 * canvas (pan/zoom, multiple frames) in favour of a single, real-size frame.
 * Whether the site's runtime scripts also execute inside the editable frames
 * is governed by the orthogonal `runScripts` flag below — it applies to both
 * views.
 */
type CanvasView = 'design' | 'live'

interface CanvasSlice {
  zoom: number
  panX: number
  panY: number
  /** Active breakpoint ID — determines which viewport frame is "focused" */
  activeBreakpointId: string
  /**
   * Active custom-condition id (a `site.conditions` id) the style panel is
   * editing under, or null when editing the viewport-resolved styles (base /
   * breakpoint). Orthogonal to `activeBreakpointId`: a condition can't reframe
   * the canvas, so the viewport frame stays put while edits route to the
   * condition's `contextStyles` bag. Selecting a viewport clears this.
   */
  activeConditionId: string | null
  /** Active page ID */
  activePageId: string | null
  /**
   * Page ID to restore when exiting VC canvas mode.
   * Captured by setActiveDocument when transitioning into VC mode from
   * the default page canvas (activeDocument === null). Cleared on exit.
   */
  previousActivePageId: string | null
  /** Current editor interaction mode */
  canvasMode: CanvasMode
  /** Current canvas render mode — 'design' (multi-breakpoint canvas) or 'live' (single real-size editable frame) */
  canvasView: CanvasView
  /**
   * When true, the site's runtime scripts are bundled and injected into the
   * editable canvas iframes (both 'design' and 'live' views), so authored
   * behaviour runs in-place while the page stays editable. Opt-in (default
   * off): scripts mutate the same DOM React renders, so a Refresh re-runs them
   * after edits that React reconciles away.
   */
  runScripts: boolean
  /**
   * Breakpoint IDs whose design-canvas frame is collapsed to a slim header
   * (heavy iframe dropped) so the author can avoid rendering every breakpoint
   * at once. EDITOR-SESSION-ONLY and ephemeral — not persisted to the site
   * document, distinct from the breakpoint's `previewFrame` flag (which removes
   * the frame entirely via Settings). Reloading the editor clears it.
   */
  collapsedBreakpointIds: string[]
  /**
   * One ephemeral, offscreen frame requested by `site_render_snapshot` when the
   * exact viewport is not already mounted on the visible canvas. This is editor
   * session state only: it never changes the active viewport, canvas mode, or
   * persisted breakpoint configuration.
   */
  agentSnapshotCaptureRequest: AgentSnapshotCaptureRequest | null
  /**
   * WS-10 Phase 1 — the board's render-time preview axes (direction,
   * color scheme; `locale` is Phase 2, see `previewAxes.ts`'s module doc).
   * Board-global, not per-frame (that's WS-10 Phase 2's `BoardFrame.axes`
   * override). Persisted per project in `.studio/meta.json` — see
   * `PreviewAxesControls.tsx`, which hydrates this on project open and
   * writes through on every toggle.
   */
  previewAxes: PreviewAxes
  /**
   * viewport-01 — the imperative viewport gestures the MOUNTED canvas
   * publishes (`CanvasRoot`, design mode only), or `null` when no canvas is
   * mounted / the canvas is in live mode.
   *
   * Zoom-to-fit / fill / selection all need two things this slice cannot
   * have: DOM measurement of the laid-out frames and selection rings, and the
   * LIVE canvas transform, which leads these very fields by up to 100 ms
   * during a gesture (`useCanvas.ts`'s `CanvasTransform` doc). So the canvas
   * keeps the implementations and publishes them here, and chrome that
   * renders outside `CanvasRoot`'s provider — `ZoomControls`, in the eagerly
   * painted toolbar above the lazy editor body — calls them the same way it
   * already calls `zoomIn`/`zoomOut`/`resetView`. See
   * `canvas/canvasViewportCommands.ts` for the full rationale.
   *
   * Read it to gate UI too: `null` means "no canvas to act on", which is what
   * disables the toolbar's Fit control instead of letting it silently no-op.
   */
  canvasViewportCommands: CanvasViewportCommands | null

  setZoom: (zoom: number) => void
  /** Publish (or, with `null`, retract) the mounted canvas's viewport gestures. */
  setCanvasViewportCommands: (commands: CanvasViewportCommands | null) => void
  setPan: (x: number, y: number) => void
  setCanvasTransform: (zoom: number, x: number, y: number) => void
  setActiveBreakpoint: (id: string) => void
  /** Set (or clear, with null) the active custom-condition editing context. */
  setActiveConditionId: (id: string | null) => void
  setActivePage: (pageId: string) => void
  setCanvasMode: (mode: CanvasMode) => void
  setCanvasView: (view: CanvasView) => void
  /** Toggle (or set) whether runtime scripts run inside the editable iframes. */
  setRunScripts: (run: boolean) => void
  /** Toggle whether a breakpoint's design-canvas frame is collapsed to its slim header. */
  toggleBreakpointCollapsed: (id: string) => void
  /** Mount or release the agent's one-shot offscreen snapshot frame. */
  setAgentSnapshotCaptureRequest: (request: AgentSnapshotCaptureRequest | null) => void
  /**
   * Merge a partial update into `previewAxes` (e.g. `{ direction: 'rtl' }`).
   * Editor-session state only — persistence to `.studio/meta.json` is the
   * caller's job (`PreviewAxesControls.tsx`), same split `setActiveBreakpoint`
   * vs. a breakpoint's own persisted config uses elsewhere in this slice.
   */
  setPreviewAxes: (patch: Partial<PreviewAxes>) => void
  resetView: () => void
  /**
   * Step zoom up to the next preset level. When `originX`/`originY` are
   * provided (in viewport-space, relative to the canvas root), the pan is
   * adjusted so that origin point stays fixed on screen — i.e. the zoom is
   * "around" that point. Toolbar buttons / keyboard shortcuts pass the
   * canvas viewport center; without an origin the zoom uses (0, 0) which
   * pulls content toward the top-left of the document.
   */
  zoomIn: (originX?: number, originY?: number) => void
  zoomOut: (originX?: number, originY?: number) => void
  zoomTo: (zoom: number, originX?: number, originY?: number) => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends CanvasSlice {}
}

export const createCanvasSlice: EditorStoreSliceCreator<CanvasSlice> = (set, get) => ({
  zoom: INITIAL_ZOOM,
  panX: 0,
  panY: 0,
  activeBreakpointId: 'desktop',
  activeConditionId: null,
  activePageId: null,
  previousActivePageId: null,
  canvasMode: 'select',
  canvasView: 'design',
  runScripts: false,
  collapsedBreakpointIds: [],
  agentSnapshotCaptureRequest: null,
  previewAxes: DEFAULT_PREVIEW_AXES,
  canvasViewportCommands: null,

  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

  // `set({ ... })` (replace), not a draft mutation: the value is a bag of
  // functions owned by the canvas, and Mutative must hand it back by identity
  // rather than try to draft it.
  setCanvasViewportCommands: (commands) => set({ canvasViewportCommands: commands }),

  setPan: (panX, panY) => set({ panX: clampPan(panX), panY: clampPan(panY) }),

  setCanvasTransform: (zoom, panX, panY) => set({
    zoom: clampZoom(zoom),
    panX: clampPan(panX),
    panY: clampPan(panY),
  }),

  // Picking a viewport switches editing back to that viewport's styles, so the
  // condition overlay is cleared.
  setActiveBreakpoint: (id) => set({ activeBreakpointId: id, activeConditionId: null }),

  setActiveConditionId: (id) => set({ activeConditionId: id }),

  setActivePage: (pageId) => set({ activePageId: pageId }),

  setCanvasMode: (mode) => set({ canvasMode: mode }),

  /**
   * Switch canvas view — and arm or disarm the prototype player with it.
   *
   * THE PLAYER BELONGS TO LIVE VIEW. Live mode is one real-size frame of the
   * app, which is where following a prototype link means anything; the board
   * shows every screen at once, and a click there is a selection. Leaving live
   * with `playMode` still set was a trap with no way out: `CanvasModeToggle`
   * only draws the Play button in live view, so the board silently routed every
   * click to the player — no selection, no ring, no visible control to turn it
   * off, and only a page reload cleared it.
   *
   * Arriving in live view arms BOTH the player and the site's runtime scripts,
   * because that is what live mode is for: seeing the thing run. Either can be
   * switched off from the toggle without leaving the view.
   */
  setCanvasView: (view) => {
    if (Object.is(get().canvasView, view)) return
    set({ canvasView: view, ...(view === 'live' ? { runScripts: true } : {}) })
    // Through the player's own action rather than a second copy of it here:
    // disarming also has to reset the screen stack, and that is its job.
    get().setPlayMode(view === 'live')
  },

  setRunScripts: (run) => set({ runScripts: run }),

  toggleBreakpointCollapsed: (id) => set((s) => {
    const idx = s.collapsedBreakpointIds.indexOf(id)
    if (idx === -1) s.collapsedBreakpointIds.push(id)
    else s.collapsedBreakpointIds.splice(idx, 1)
  }),

  setAgentSnapshotCaptureRequest: (agentSnapshotCaptureRequest) => set({
    agentSnapshotCaptureRequest,
  }),

  setPreviewAxes: (patch) => set((s) => {
    s.previewAxes = { ...s.previewAxes, ...patch }
  }),

  resetView: () => set({ zoom: RESET_ZOOM, panX: 0, panY: 0 }),

  zoomIn: (originX, originY) => {
    const { zoom, panX, panY, zoomTo } = get()
    const next = nearestZoomStep(zoom, 1)
    if (originX !== undefined && originY !== undefined) {
      zoomTo(next, originX, originY)
    } else {
      // Fallback: keep current pan. Used by call sites that don't have a
      // viewport rect handy (shouldn't occur for user-facing actions).
      set({ zoom: next, panX: clampPan(panX), panY: clampPan(panY) })
    }
  },

  zoomOut: (originX, originY) => {
    const { zoom, panX, panY, zoomTo } = get()
    const next = nearestZoomStep(zoom, -1)
    if (originX !== undefined && originY !== undefined) {
      zoomTo(next, originX, originY)
    } else {
      set({ zoom: next, panX: clampPan(panX), panY: clampPan(panY) })
    }
  },

  /**
   * Zoom to a target level, optionally around a viewport origin point.
   * Used for Ctrl+Wheel zoom (zoom towards cursor position).
   */
  zoomTo: (targetZoom, originX = 0, originY = 0) => {
    const { zoom, panX, panY } = get()
    const newZoom = clampZoom(targetZoom)
    const scale = newZoom / zoom
    // Adjust pan so the origin point stays fixed in viewport space
    const newPanX = clampPan(originX - scale * (originX - panX))
    const newPanY = clampPan(originY - scale * (originY - panY))
    set({ zoom: newZoom, panX: newPanX, panY: newPanY })
  },
})
