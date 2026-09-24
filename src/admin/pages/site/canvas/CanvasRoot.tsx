/**
 * CanvasRoot — the top-level canvas component.
 *
 * Responsibilities:
 * - Captures all wheel, drag, and pinch gestures via useCanvas
 * - Manages the CanvasSelectionContext (click → selectNode, hover → hoverNode)
 * - Registers the canvas keyboard SCOPES on the editor key ladder
 *   (`editorKeyDispatcher.ts`); the one listener lives in `SitePage`
 * - Delegates the rename modal to useCanvasRenameDialog + CanvasRenameDialog
 * - Delegates the right-click menu to useCanvasLayerContextMenu + CanvasLayerContextMenu
 * - Renders CanvasTransformLayer inside the gesture-capture area
 * - Renders CanvasNotch (position: absolute, not in transform layer)
 * - Handles double-click on base.visual-component-ref → enters VC canvas mode
 *
 * Performance architecture:
 * - Pan/zoom writes go directly to CanvasTransformLayer's style.transform via ref
 * - No React state is updated during active interaction (60fps pan/zoom)
 * - NodeRenderer components memo'd per node — only affected nodes re-render on edit
 *
 * Accessibility:
 * - tabIndex={0} so the canvas can hold focus — Tab / ⇧Tab cycle siblings only
 *   while focus is on the canvas (`isCanvasKeyboardSurface`)
 * - aria-label for screen reader orientation
 * - prefers-reduced-motion: CSS transitions are disabled for users who opt out
 */

import { lazy, Suspense, useEffect, useRef } from 'react'
import { useEditorStore, selectActiveCanvasPage, selectRightSidebarExpanded } from '@site/store/store'
import type { Breakpoint } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { ChromeBoundary } from '@site/ui/ChromeBoundary'
import { useCanvas } from '@site/hooks/useCanvas'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { CanvasTransformLayer } from './CanvasTransformLayer'
import { resolveCanvasFocusTarget } from './canvasFocusTarget'
import { CanvasLiveSurface } from './CanvasLiveSurface'
import { AgentSnapshotFrame } from './AgentSnapshotFrame'
import { useRuntimeScriptBuild } from './useRuntimeScriptBuild'
import { CanvasNotch } from './CanvasNotch'
import { CanvasModeToggle } from './CanvasModeToggle'
import { CanvasContextSelector } from './CanvasContextSelector'
import { CanvasRulers } from './CanvasRulers/CanvasRulers'
import { CanvasSelectionContext, CanvasViewportActionsContext } from './CanvasContexts'
// Class / user-stylesheet injectors are now mounted per breakpoint frame
// (inside each iframe's document) by `IframeFrameSurface`. CanvasRoot no
// longer injects site CSS into the editor's document — that path was a
// stopgap before the iframe cut-over. See
// `docs/features/canvas-iframe-per-frame.md`.
import { PluginCanvasOverlayLayer } from './PluginCanvasOverlayLayer'
import { LazyStudioCanvasChrome } from './LazyStudioCanvasChrome'
import { CanvasRenameDialog } from './CanvasRenameDialog'
import { useCanvasRenameDialog } from './useCanvasRenameDialog'
import { CanvasLayerContextMenu } from './CanvasLayerContextMenu'
import { useCanvasLayerContextMenu } from './useCanvasLayerContextMenu'
import { useCanvasNodeShortcuts } from './useCanvasNodeShortcuts'
import { useCanvasNodeArrowKeys } from './useCanvasNodeArrowKeys'
import { useEditorHistoryShortcuts } from './useEditorHistoryShortcuts'
import { useCanvasSelectionKeyboard } from './useCanvasSelectionKeyboard'
import { useBoardAnnotationKeyboard } from './useBoardAnnotationKeyboard'
import { usePrototypeLinkKeyboard } from './usePrototypeLinkKeyboard'
import { usePrototypePlayTriggers } from './usePrototypePlayTriggers'
import { usePrototypePlayback } from './usePrototypePlayback'
import { useCanvasNodeInteraction } from './useCanvasNodeInteraction'
import { useBoardFrameNudge } from './useBoardFrameNudge'
import { useCanvasToolShortcuts } from './useCanvasToolShortcuts'
import { useCanvasHandTool } from './useCanvasHandTool'
import { useCanvasFileDrop } from './useCanvasFileDrop'
import { CanvasFileDropHint } from './CanvasFileDropHint'
import { useBoardSelectAllShortcut } from './useBoardSelectAllShortcut'
import { useCopyAsPngShortcut } from './useCopyAsPngShortcut'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { useEditorPreference, readEditorSelectPreference } from '@site/preferences/editorPreferences'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import styles from './CanvasRoot.module.css'

const VisualComponentModeControl = lazy(() =>
  import('./VisualComponentModeControl').then((module) => ({ default: module.default })),
)

const TemplateModeControl = lazy(() =>
  import('./TemplateModeControl').then((module) => ({ default: module.default })),
)

/**
 * Stable empty-breakpoints sentinel — used as the `?? fallback` in the
 * breakpoints selector so that `Object.is(prev, next)` returns `true` when
 * the site is null, preventing useSyncExternalStore from entering an
 * infinite re-render loop.  Never use `?? []` inline in a useEditorStore
 * selector — a new array literal has a new identity on every call.
 */
const EMPTY_BREAKPOINTS: Breakpoint[] = []

interface CanvasRootProps {
  editable?: boolean
}

export function CanvasRoot({ editable = true }: CanvasRootProps) {
  const transformLayerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  // Store subscriptions
  const editingPage = useEditorStore(selectActiveCanvasPage)
  // Arming the player changes what is BEING LOOKED AT, never what is being
  // edited: selection, the properties panel and the page tree all keep pointing
  // at `editingPage`, so disarming puts the editor back where it was.
  const {
    canvasPage,
    overlayPage,
    screenTransition: playScreenTransition,
    overlayTransition: playOverlayTransition,
    overlayLeaveTransition: playOverlayLeaveTransition,
    playMode,
    stackDepth: playStackDepth,
  } = usePrototypePlayback(editingPage)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const canvasView = useEditorStore((s) => s.canvasView)
  const agentSnapshotCaptureRequest = useEditorStore((s) => s.agentSnapshotCaptureRequest)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  const isLive = canvasView === 'live'
  const runScripts = useEditorStore((s) => s.runScripts)
  // selectedNodeId is needed here for canvas-level keyboard shortcuts (Delete, Ctrl+D).
  // hoveredNodeId is NOT subscribed here — NodeRenderer handles its own hover state
  // via per-node selectors to avoid O(N) re-renders on every hover event (#495).
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  // Subscribed here only because the right-click menu renders them as actions.
  // The KEYBOARD equivalents (including the `*Nodes` batch variants a
  // multi-selection needs) read the store live inside `useCanvasNodeShortcuts`
  // — a shortcut handler has no reason to re-render this component.
  const duplicateNode = useEditorStore((s) => s.duplicateNode)
  const renameNode = useEditorStore((s) => s.renameNode)
  const wrapNode = useEditorStore((s) => s.wrapNode)
  const copyNode = useEditorStore((s) => s.copyNode)
  const cutNode = useEditorStore((s) => s.cutNode)
  const pasteNode = useEditorStore((s) => s.pasteNode)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const {
    context: templatePreviewContext,
    loading: templatePreviewContextLoading,
  } = useTemplatePreviewContext(canvasPage)
  const agentSnapshotBreakpoint = agentSnapshotCaptureRequest
    ? breakpoints.find((breakpoint) => breakpoint.id === agentSnapshotCaptureRequest.breakpointId) ?? null
    : null
  // Permission context — gates canvas affordances:
  //   canEditContent → double-click inline text editing
  //   canEditStyle / canEditStructure → properties sidebar
  const permissions = useEditorPermissions()
  // Auto-dim non-active breakpoints when a layer is selected and the
  // properties panel is open — gated by the `dimInactiveBreakpoints` user
  // preference so designers comparing breakpoints side-by-side can keep
  // them all bright.
  const dimInactiveBreakpointsPref = useEditorPreference('dimInactiveBreakpoints')
  const focusActiveBreakpoint =
    dimInactiveBreakpointsPref && Boolean(selectedNodeId && rightSidebarExpanded)
  const preserveSelectionWhenActivatingBreakpoint = Boolean(selectedNodeId && rightSidebarExpanded)

  // Routes destructive actions through the editor's central confirm dialog.
  // When the `confirmBeforeDelete` preference is off, the commit callback
  // runs synchronously — same behaviour as before this preference existed.
  const confirmDelete = useConfirmDelete()
  const requestDeleteNode = (nodeId: string) => {
    const page = canvasPage
    if (!page) return
    const node = page.nodes[nodeId]
    const definition = node ? registry.get(node.moduleId) : undefined
    const label = node
      ? getNodeDisplayName(node, definition, useEditorStore.getState().site?.visualComponents)
      : 'this layer'
    confirmDelete({
      title: 'Delete layer?',
      description: `${label} and any of its children will be removed. This can be undone with Ctrl/Cmd+Z.`,
      confirmLabel: 'Delete',
      commit: () => {
        deleteNode(nodeId)
        if (nodeId === useEditorStore.getState().selectedNodeId) clearSelection()
      },
    })
  }

  // Canvas gesture hook (pan/zoom). Disabled in preview mode — preview owns
  // its own surface (CanvasLiveSurface) and pan/zoom is meaningless on a
  // single sandboxed iframe. Critically, this also stops wheel events from
  // silently mutating transformRef while in preview, which would otherwise
  // make the design canvas visibly jump on the first interaction after
  // returning from preview.
  const {
    bind,
    panBy,
    centerOnBreakpointFrame,
    transformRef,
    zoomToFit,
    zoomToFill,
    zoomToSelection,
  } = useCanvas({
    canvasRootRef: canvasRef,
    transformLayerRef,
    enabled: !isLive,
  })

  // viewport-01 — publish the three DOM-measuring viewport gestures while this
  // canvas is mounted in design mode, so the toolbar's zoom menu (rendered
  // outside this tree, above the lazy editor body) runs the real gesture
  // instead of duplicating the measurement. Retracted on unmount / in live
  // mode: `ZoomControls` reads `null` as "nothing to fit" and disables the
  // control rather than letting it no-op. See `canvasViewportCommands.ts`.
  const setCanvasViewportCommands = useEditorStore((s) => s.setCanvasViewportCommands)
  useEffect(() => {
    if (isLive) return
    setCanvasViewportCommands({ zoomToFit, zoomToFill, zoomToSelection })
    return () => setCanvasViewportCommands(null)
  }, [isLive, zoomToFit, zoomToFill, zoomToSelection, setCanvasViewportCommands])

  // ─── Focus the chosen viewport frame: loading skeleton → page → switches ───
  // The canvas always mounts at pan (0,0), which shows the left-most (mobile)
  // frame. Pan to horizontally center the chosen viewport so it's actually
  // focused on screen. This runs in three situations, all funnelled through the
  // same effect:
  //
  //  1. While the page data loads, `CanvasTransformLayer` renders skeleton
  //     frames. We center the skeleton for the user's `defaultBreakpoint`
  //     preference — what `activeBreakpointId` WILL become once the site loads
  //     (`applyDefaultBreakpointPreference` in usePersistence). Centering the
  //     skeleton on the same frame means there's no jump when real content
  //     replaces it.
  //  2. Once the page is available, we center the real frame for the resolved
  //     `activeBreakpointId`.
  //  3. On document switch (page ↔ page, entering/leaving a Visual Component),
  //     we re-center so jumping from a long page you'd scrolled down to a
  //     shorter one brings the active frame back into view.
  //
  // The effect keys on `canvasPage.id` (a stable per-document string) rather
  // than the page OBJECT: Mutative hands back a fresh page object on every edit,
  // and depending on the object would re-run this effect — cancelling the
  // in-flight retry before it fires — on every keystroke during load. Keying on
  // the id (null during the skeleton phase) means we run once per document:
  // ordinary editing never yanks the canvas, and breakpoint switches (toolbar,
  // node clicks) keep the designer's place.
  //
  // We retry on a short timer rather than requestAnimationFrame because the
  // frames mount a few ticks after the effect runs (the per-frame iframes lay
  // out asynchronously), and rAF only fires while the tab is painting — a
  // centering scheduled while the editor is backgrounded would silently never
  // run. setTimeout fires regardless, and reading getBoundingClientRect forces
  // the layout we need synchronously. The cap is a safety valve for a breakpoint
  // that has no preview frame at all.
  // WHICH change re-frames the canvas is decided by `resolveCanvasFocusTarget`
  // — see it for why the active page is the wrong unit on a studio board (it is
  // a selection artifact there, and every board frame shares one breakpoint id,
  // so centering on it snapped the canvas back to frame #1 on every selection).
  const canvasPageId = canvasPage?.id ?? null
  const activeBoardId = useEditorStore((s) => s.activeBoardId)
  const lastCenteredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (isLive) return

    const { centerKey, shouldCenter } = resolveCanvasFocusTarget({
      activeBoardId,
      canvasPageId,
      lastCenteredKey: lastCenteredKeyRef.current,
    })
    if (!shouldCenter) return

    let timerId: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const MAX_ATTEMPTS = 200 // ~3s at 16ms — frames are ready well within this
    const RETRY_MS = 16
    const tryCenter = () => {
      // Loaded: the resolved active breakpoint. Skeleton (no page yet): the
      // preferred default breakpoint, which is what active WILL resolve to.
      const targetId = canvasPageId
        ? useEditorStore.getState().activeBreakpointId
        : readEditorSelectPreference('defaultBreakpoint')
      if (centerOnBreakpointFrame(targetId)) {
        // Record only on success: a failed attempt must not consume the key, or
        // a board whose frames were not laid out yet would never get framed.
        lastCenteredKeyRef.current = centerKey
        return
      }
      if (attempts++ >= MAX_ATTEMPTS) return
      timerId = setTimeout(tryCenter, RETRY_MS)
    }
    tryCenter()
    return () => clearTimeout(timerId)
  }, [canvasPageId, activeBoardId, isLive, centerOnBreakpointFrame])

  // ─── Modals & overlays ─────────────────────────────────────────────────────

  const renameDialog = useCanvasRenameDialog(renameNode)
  const contextMenu = useCanvasLayerContextMenu()

  // "Paste HTML here…" — read the clipboard, then open the import modal
  // with the clicked node as the insertion parent.
  const openImportHtmlModal = useEditorStore((s) => s.openImportHtmlModal)
  const handlePasteHtml = async (nodeId: string) => {
    let prefillHtml = ''
    try {
      prefillHtml = await navigator.clipboard.readText()
    } catch (_err) {
      // Clipboard permission denied or API unavailable — open with an empty editor.
    }
    openImportHtmlModal({ parentId: nodeId, prefillHtml })
  }

  // ─── Selection context value ───────────────────────────────────────────────
  // What a click / hover / right-click / double-click on a canvas node does
  // lives in its own module — see `useCanvasNodeInteraction`. Context carries
  // only these stable callbacks; selectedNodeId/hoveredNodeId are intentionally
  // excluded (Perf fix — Contribution #495), so each NodeRenderer subscribes to
  // its own boolean and only the 2 affected nodes re-render per event.
  const selectionContextValue = useCanvasNodeInteraction({
    editable,
    isLive,
    canEditContent: permissions.canEditContent,
    playMode,
    canvasPage,
    overlayPage,
    activeBreakpointId,
    preserveSelectionWhenActivatingBreakpoint,
    openContextMenu: contextMenu.open,
  })

  const viewportActionsContextValue = { canvasRootRef: canvasRef, panBy, transformRef }

  // ─── Canvas keyboard scopes ───────────────────────────────────────────────
  //
  // None of these mount a listener. Each registers a handler on ONE rung of
  // the editor key ladder (`editorKeyDispatcher.ts`), whose single `document`
  // listener lives in `SitePage`. The ladder — not the order of the calls
  // below — decides who wins a shared keystroke; the order here only fixes
  // sequence WITHIN a rung, which matters for `node` (the selection ladder is
  // consulted before the node shortcuts) and for `board` (no overlaps).
  //
  // The canvas div has no `onKeyDown` at all any more. Delete and ⌘D used to
  // be there, and later the viewport keys (+ / − / ⇧1 / ⇧2) — a React handler
  // on the canvas div stops firing the moment the user clicks the Properties
  // panel. Every one of them is a scope on the ladder now; the viewport keys
  // are registered by `useCanvas` itself (`useCanvasViewportKeys`, P2-B).

  // `prototype-link` — Delete removes the selected connector, Escape deselects
  // it. Above `node` so a Delete pressed with BOTH a connector and an element
  // selected removes only the connector.
  usePrototypeLinkKeyboard(editable && !isLive)

  // `annotation` — sticky notes + doc cards: delete / duplicate / copy-paste /
  // nudge. Above `node` and `board`, which is what makes a mixed marquee
  // selection nudge the notes rather than the frames.
  useBoardAnnotationKeyboard(editable, isLive)

  // `node`, first handler — Enter steps into a `studio.instance`
  // (instance-ui-01); Escape steps back out, and otherwise clears the node +
  // frame selection and leaves VC mode (select-01). viewport-01 also gave it
  // ⇧Enter (select parent), Enter's select-first-child fallback, and ⌘R → the
  // canvas's own rename dialog. Registered before the node shortcuts below so
  // Enter / Escape / ⌘R are decided first.
  useCanvasSelectionKeyboard(editable, isLive, renameDialog.open)

  // `node`, second handler — Delete / ⌘D / ⌘C / ⌘X / ⌘V / ⌥↑ / ⌥↓.
  useCanvasNodeShortcuts({ editable, isLive, requestDeleteNode })

  // `node`, third handler — bare arrows move the selected layer (P2-C): an
  // absolute one nudges, a layout child reorders. Above `board`, so a node
  // selection never nudges a frame.
  useCanvasNodeArrowKeys(editable, isLive)

  // `board` — ⌘/Ctrl+A selects every frame on the active board (board-02).
  useBoardSelectAllShortcut(editable, isLive)

  // `board` — ⌘⇧C copies the selection as a PNG. Not gated on `editable`:
  // photographing a screen reads the board, it never writes to it.
  useCopyAsPngShortcut(isLive)

  // The two screen-scoped prototype triggers — `after-delay` and `key`. The
  // other three arrive as pointer events on a node and belong to
  // `useCanvasNodeInteraction`; these have no element under them when they
  // fire. Mounted here because this is where the player's current screen and
  // overlay are already derived.
  usePrototypePlayTriggers({
    playMode,
    screenPageId: canvasPage?.id ?? null,
    overlayPageId: overlayPage?.id ?? null,
    stackDepth: playStackDepth,
  })

  // `board` — arrow-key frame nudge. Also broadcasts the keyup that closes an
  // arrow-nudge undo burst, for annotations as well as frames.
  useBoardFrameNudge(editable, isLive)

  // `board` — bare-letter tool keys: T (text), F (container inside), C
  // (comment mode), H (hand), K (scale), R / O (box beside the selection).
  useCanvasToolShortcuts(editable, isLive)

  // Not a key scope: mirrors the latched hand tool onto the shared space-pan
  // flag, which is what every pan-aware surface already reads.
  useCanvasHandTool()

  // D2 G15 — an image file dragged in from the operating system. Mounted ONCE
  // for the whole board (not per frame): the relay re-dispatches a drop that
  // started inside a frame onto the iframe element in this document, so the
  // listener has to sit above every frame. Off in live view, where a drop
  // belongs to the running app rather than to the editor.
  const fileDrop = useCanvasFileDrop({ enabled: permissions.canEditStructure && !isLive, transformRef })

  // `global`, the bottom rung — undo / redo: what you get when nothing more
  // specific claimed the key. Moved off `UndoRedoButtons` so it survives the
  // notch being hidden and stands down during an inline edit.
  useEditorHistoryShortcuts()

  // ─── Canvas background click → deselect ───────────────────────────────────
  //
  // `board-02`: this handler sits on the OUTERMOST canvas div, so a click
  // anywhere inside it — including one that started on a frame header, a
  // node, a sticky note — still bubbles here as a native 'click' event
  // (nothing downstream stops it). Only a click that lands on genuine empty
  // background is a "deselect" gesture: either directly on this outer div
  // (studio board mode — `.transformLayer` has no intrinsic size there, see
  // `BoardFramesLayer`'s module doc, so board background clicks always
  // target this div) or directly on the transform layer itself (CMS mode —
  // the gap/padding around `BreakpointFrame`s inside the flex-laid-out
  // transform layer, which DOES have real size there). Anything deeper
  // (a frame header, a node, a sticky note) is excluded — without this,
  // EVERY frame-header click's own trailing 'click' event reached here a
  // tick after `BoardFrameView`'s pointerdown handler selected it,
  // immediately clearing the selection it had just made.
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && e.target !== transformLayerRef.current) return
    contextMenu.close()
    useEditorStore.getState().clearAllSelections()
  }

  // Resolve the active breakpoint object for the live surface (which wants the
  // full Breakpoint, not just the id, to read .width).
  const activeBreakpoint = breakpoints.find((bp) => bp.id === activeBreakpointId) ?? breakpoints[0] ?? null

  // Runtime scripts (opt-in "Run scripts" toggle). Built once here and shared
  // by every editable frame — the design canvas's per-breakpoint frames AND
  // the live surface's single frame — so the same bundle runs everywhere
  // without rebuilding per frame. Idle (no build) while the toggle is off.
  const scriptBuild = useRuntimeScriptBuild({
    page: canvasPage,
    breakpointId: activeBreakpointId,
    templateContext: templatePreviewContext,
    enabled: runScripts,
  })
  const runtimeScripts = scriptBuild.scripts

  // Live mode skips canvas-level pan/zoom gestures and shortcuts: the single
  // real-size frame scrolls natively. Spreading {} keeps the outer div's prop
  // shape stable when toggling.
  const gestureBindings = isLive ? {} : bind()
  // The ONLY React key handler left on the canvas div: the viewport keys
  // (+ / − / ⇧1 / ⇧2), which are legitimately focus-scoped — they act on the
  // thing under the cursor's canvas, not on a selection. Every selection-acting
  // shortcut moved to the editor key ladder (see the scopes block above).
  const onCanvasClick = isLive ? undefined : handleCanvasClick

  return (
    <CanvasViewportActionsContext.Provider value={viewportActionsContextValue}>
      <CanvasSelectionContext.Provider value={selectionContextValue}>
        <div
          ref={canvasRef}
          role="region"
          aria-label="Canvas — infinite editing surface"
          tabIndex={0}
          data-testid="canvas-root"
          data-studio-canvas-root="true"
          data-canvas-state={canvasPage ? 'canvas-ready' : 'canvas-empty'}
          data-canvas-view={canvasView}
          data-vc-mode={activeDocument?.kind === 'visualComponent' ? 'true' : undefined}
          className={styles.canvas}
          // Spread gesture handlers from useGesture (wheel, drag, pinch)
          // FIRST, before the explicit handlers below. `board-02` once lost
          // every canvas shortcut to the library's own arrow-key drag
          // `onKeyDown` riding this spread; `useCanvas` now turns that off
          // (`drag.keys: false`) and the canvas div binds no key handler of
          // its own. Empty in preview mode — see gestureBindings above.
          {...gestureBindings}
          onClick={onCanvasClick}
          onFocus={() => setFocusedPanel('canvas')}
        >
          {/* CSS for prefers-reduced-motion — no transitions for accessibility */}
          <style>{`
          @media (prefers-reduced-motion: reduce) {
            [data-testid="canvas-transform-layer"] {
              transition: none !important;
            }
          }
        `}</style>

          {/* Site CSS (class registry + user stylesheets) lives inside each
            breakpoint iframe now — mounted per-frame by IframeFrameSurface
            so the canvas sees the same cascade the published page sees. */}

          {/* Insert toolbar — shown in both design and live modes. Both are
            editable surfaces (live reuses the same editable iframe + selection
            overlay), so the notch's quick-insert and history controls apply
            equally; only the frame layout differs (all frames vs. one). In live
            mode the frame is flush with the top edge, so the notch auto-hides
            (peek) and rolls down on hover instead of overlaying the page. */}
          {editable && (
            <CanvasNotch
              peek={isLive}
              floatingControl={
                activeDocument?.kind === 'visualComponent' ? (
                  <Suspense fallback={null}>
                    <VisualComponentModeControl />
                  </Suspense>
                ) : canvasPage?.template?.enabled ? (
                  <Suspense fallback={null}>
                    <TemplateModeControl />
                  </Suspense>
                ) : null
              }
            />
          )}

          {/* Design / Live view toggle — top-left chrome. In live mode this
            also hosts inline breakpoint switcher buttons, and the toggle owns
            the "Run scripts" switch + its build status / Refresh. */}
          <CanvasModeToggle
            peek={isLive}
            scriptStatus={scriptBuild.status}
            onRefreshScripts={scriptBuild.refresh}
          />

          {/* The editing-context switcher targets per-context style overrides
              (viewports + custom conditions), so it's only meaningful for
              callers who can edit style or structure. Content-only Clients and
              pure Viewers get the same plain frames without this affordance.
              D3 — hidden on a Studio board: every board frame renders under
              ONE hardcoded synthetic breakpoint id (`'studio'`,
              `BoardFramesLayer.tsx`) that ignores `activeBreakpointId`
              entirely, so this control renders and takes clicks but changes
              nothing a board frame actually reads — a genuine no-op, not a
              degraded affordance. Keyed off `activeBoardId` (not a board-mode
              prop) because that's the exact same signal `CanvasTransformLayer`
              already uses to decide whether to render `BoardFramesLayer`
              instead of ordinary breakpoint frames (`selectActiveBoard`). */}
          {!isLive && !activeBoardId && rightSidebarExpanded && (permissions.canEditStyle || permissions.canEditStructure) && (
            <ChromeBoundary id="canvas-context-selector">
              <CanvasContextSelector />
            </ChromeBoundary>
          )}

          {/*
          A buggy module render must not blank the toolbar / DOM panel /
          properties panel that share the editor shell. Resetting on the
          active page id means switching pages naturally clears stuck
          errors — the user navigates away from a broken module preview
          rather than getting "stuck" on the failure screen.
          ERR-13 — and it retries ONCE on its own before showing that screen:
          the commonest canvas crash is a render racing a resync that is about
          to replace the page it read, and the retry renders the settled page.
        */}
          <ErrorBoundary
            location="canvas"
            resetKeys={[canvasPage?.id ?? null, activeDocument?.kind ?? null, canvasView]}
            autoRetry={1}
          >
            {isLive ? (
              <CanvasLiveSurface
                page={canvasPage}
                overlayPage={overlayPage}
                overlayTransition={playOverlayTransition}
                overlayLeaveTransition={playOverlayLeaveTransition}
                screenTransition={playScreenTransition}
                playMode={playMode}
                activeBreakpoint={activeBreakpoint}
                templateContext={templatePreviewContext}
                runtimeScripts={runtimeScripts}
              />
            ) : (
              <CanvasTransformLayer
                ref={transformLayerRef}
                page={canvasPage}
                breakpoints={breakpoints}
                activeBreakpointId={activeBreakpointId}
                dimInactiveBreakpoints={focusActiveBreakpoint}
                activationHintEnabled={preserveSelectionWhenActivatingBreakpoint}
                onBreakpointActivate={setActiveBreakpoint}
                templateContext={templatePreviewContext}
                runtimeScripts={runtimeScripts}
              />
            )}
          </ErrorBoundary>

          {/* D1 — rulers. A SIBLING of CanvasTransformLayer, never inside it
              (see CanvasRulers/rulerGeometry.ts for why) — same untransformed
              chrome tier as CanvasNotch/CanvasModeToggle. Design mode only: a
              live frame has no pan/zoom to rule against. */}
          {!isLive && editable && (
            <ChromeBoundary id="canvas-rulers">
              <CanvasRulers canvasRootRef={canvasRef} transformRef={transformRef} />
            </ChromeBoundary>
          )}

          {/* D2 G15 — where an OS file drag's cursor chip is painted while the
              pointer is over the empty BOARD. Over a frame the same chip goes
              in that frame's own drag layer; this layer exists only for the
              case where there is no frame to put it in. Untransformed chrome,
              a sibling of the transform layer, like the rulers above. */}
          {!isLive && editable && permissions.canEditStructure && (
            <CanvasFileDropHint layerRef={fileDrop.hintLayerRef} />
          )}

          {/*
          Plugin-registered canvas overlays. Mounted after the transform
          layer so they paint above rendered nodes. Only active in design
          (editable) mode — preview-mode canvases don't need overlays and
          plugin code shouldn't paint over the visitor preview.
        */}
          {!isLive && editable && <PluginCanvasOverlayLayer />}

          {/* Studio-mode untransformed chrome: notes/comment toolbar + the armed comment tool. */}
          {!isLive && editable && (
            <ChromeBoundary id="studio-canvas-chrome">
              <LazyStudioCanvasChrome transformLayerRef={transformLayerRef} />
            </ChromeBoundary>
          )}

          {!isLive && editable && contextMenu.position && (
            <ChromeBoundary id="canvas-context-menu">
              <CanvasLayerContextMenu
                position={contextMenu.position}
                onClose={contextMenu.close}
                actions={{
                  requestDeleteNode,
                  duplicateNode,
                  openRenameDialog: renameDialog.open,
                  wrapNode,
                  copyNode,
                  cutNode,
                  pasteNode,
                  pasteHtml: handlePasteHtml,
                }}
              />
            </ChromeBoundary>
          )}

          {!isLive && editable && renameDialog.state && (
            <CanvasRenameDialog
              state={renameDialog.state}
              onChange={renameDialog.replace}
              onCommit={renameDialog.commit}
              onClose={renameDialog.close}
            />
          )}

          {agentSnapshotCaptureRequest && canvasPage && agentSnapshotBreakpoint ? (
            <AgentSnapshotFrame
              key={agentSnapshotCaptureRequest.requestId}
              requestId={agentSnapshotCaptureRequest.requestId}
              page={canvasPage}
              breakpoint={agentSnapshotBreakpoint}
              templateContext={templatePreviewContext}
              templateContextLoading={templatePreviewContextLoading}
            />
          ) : null}
        </div>
      </CanvasSelectionContext.Provider>
    </CanvasViewportActionsContext.Provider>
  )
}
