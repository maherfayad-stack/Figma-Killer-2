/**
 * CanvasRoot — the top-level canvas component.
 *
 * Responsibilities:
 * - Captures all wheel, drag, and pinch gestures via useCanvas
 * - Manages the CanvasSelectionContext (click → selectNode, hover → hoverNode)
 * - Delegates canvas-level keyboard shortcuts to useCanvasKeyboardShortcuts
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
 * - tabIndex={0} so the canvas receives keyboard events
 * - aria-label for screen reader orientation
 * - prefers-reduced-motion: CSS transitions are disabled for users who opt out
 */

import { lazy, Suspense, useContext, useEffect, useEffectEvent, useRef } from 'react'
import { useEditorStore, selectActiveCanvasPage, selectRightSidebarExpanded } from '@site/store/store'
import type { Breakpoint } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { SpotlightContext } from '@admin/spotlight/spotlightContext'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
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
import { BoardNotesToolbar } from './BoardNotesLayer'
import { CanvasRenameDialog } from './CanvasRenameDialog'
import { useCanvasRenameDialog } from './useCanvasRenameDialog'
import { CanvasLayerContextMenu } from './CanvasLayerContextMenu'
import { useCanvasLayerContextMenu } from './useCanvasLayerContextMenu'
import { useCanvasKeyboardShortcuts, isTextInputTarget } from './useCanvasKeyboardShortcuts'
import { useCanvasSelectionKeyboard } from './useCanvasSelectionKeyboard'
import { clientPointToEditorDoc } from './canvasDomGeometry'
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
  const spotlight = useContext(SpotlightContext)

  // Store subscriptions
  const canvasPage = useEditorStore(selectActiveCanvasPage)
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
  const selectNode = useEditorStore((s) => s.selectNode)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  // Multi-select: keyboard shortcuts dispatch the *Nodes batch actions when a
  // multi-selection is active so a single Ctrl+D / Delete / Cmd+C/X/V acts on
  // every selected layer in one undo step.
  const deleteNodes = useEditorStore((s) => s.deleteNodes)
  const duplicateNode = useEditorStore((s) => s.duplicateNode)
  const duplicateNodes = useEditorStore((s) => s.duplicateNodes)
  const renameNode = useEditorStore((s) => s.renameNode)
  const wrapNode = useEditorStore((s) => s.wrapNode)
  const copyNode = useEditorStore((s) => s.copyNode)
  const copyNodes = useEditorStore((s) => s.copyNodes)
  const cutNode = useEditorStore((s) => s.cutNode)
  const cutNodes = useEditorStore((s) => s.cutNodes)
  const pasteNode = useEditorStore((s) => s.pasteNode)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const startInlineEdit = useEditorStore((s) => s.startInlineEdit)
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
  const { bind, handleKeyDown: canvasKeyDown, panBy, centerOnBreakpointFrame, transformRef } = useCanvas({
    canvasRootRef: canvasRef,
    transformLayerRef,
    enabled: !isLive,
  })

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

  const onNodeClick = (nodeId: string, e: React.MouseEvent, breakpointId?: string, frameId?: string | null) => {
    e.stopPropagation()
    if (breakpointId && breakpointId !== activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
      if (preserveSelectionWhenActivatingBreakpoint) {
        setFocusedPanel('canvas')
        return
      }
    }
    // Modifier-aware selection (multi-select): Cmd/Ctrl-click toggles, Shift-
    // click extends a range from the anchor. Plain clicks replace the
    // selection (default mode in `selectNode`).
    const mode = e.shiftKey
      ? 'range'
      : e.metaKey || e.ctrlKey
        ? 'toggle'
        : 'replace'
    // WS-10 Phase 2 — `frameId` scopes this selection to the originating
    // BoardFrame so a sibling "duplicate as variant" frame of the same page
    // doesn't also light up. See `selectedNodeFrameId`'s doc.
    selectNode(nodeId, mode, { frameId })
    setFocusedPanel('canvas')
  }

  const onNodeHover = (nodeId: string | null, breakpointId?: string, frameId?: string | null) => {
    hoverNode(nodeId, breakpointId, frameId)
  }

  const onNodeContextMenu = (nodeId: string, e: React.MouseEvent, breakpointId?: string, frameId?: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    if (!editable) return
    if (breakpointId && breakpointId !== activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
    }
    // If the right-clicked node is part of an existing multi-selection,
    // KEEP the selection (the menu acts on the whole set). Otherwise replace
    // the selection with just this node — matches Figma / VS Code behavior.
    const currentIds = useEditorStore.getState().selectedNodeIds
    if (!currentIds.includes(nodeId)) {
      selectNode(nodeId, 'replace', { frameId })
    }
    setFocusedPanel('canvas')
    // The right-click event originates inside the per-breakpoint iframe, so
    // `e.clientX` / `e.clientY` are relative to the iframe's own viewport.
    // The context menu is portaled into the editor's `document.body` with
    // `position: fixed` — it needs editor-document coordinates, which
    // `clientPointToEditorDoc` produces by adding the iframe's outer rect
    // (scaled by the canvas zoom).
    const point = clientPointToEditorDoc(e.nativeEvent ?? e)
    contextMenu.open({ x: point.x, y: point.y, nodeId })
  }

  /**
   * Double-click on a canvas node → start an inline text-edit session when
   * the node's module declares `inlineTextEdit` (base.text, base.button,
   * childless base.link — `startInlineEdit` resolves the contract and
   * no-ops for everything else, so other modules keep the old no-op).
   *
   * Design-canvas only: the editing element lives inside a breakpoint iframe,
   * so a live-mode double-click must not open a session. Entering VC canvas
   * mode on double-click stays removed — VC entry works from the Site panel
   * and Spotlight (see `docs/features/canvas-iframe-per-frame.md`).
   */
  const onNodeDoubleClick = (nodeId: string, e: React.MouseEvent, breakpointId?: string, frameId?: string | null) => {
    e.stopPropagation()
    if (isLive || !editable || !permissions.canEditContent) return
    // WS-10 §4.4 (Phase 4) — `frameId` lets the session resolve/mutate the
    // RIGHT tree when it belongs to a locale-variant board frame (a
    // "duplicate as variant" sibling shares this node id — trap #2). See
    // `inlineEditSlice.ts`'s `startInlineEdit` doc.
    startInlineEdit(nodeId, breakpointId ?? activeBreakpointId, frameId ?? null)
  }

  // Context carries only stable callbacks — selectedNodeId/hoveredNodeId are
  // intentionally excluded (Perf fix — Contribution #495). Each NodeRenderer
  // subscribes to its own boolean directly, so only the 2 affected nodes
  // re-render per selection/hover event rather than the entire canvas tree.
  const selectionContextValue = { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick }

  const viewportActionsContextValue = { canvasRootRef: canvasRef, panBy, transformRef }

  // ─── Canvas-level keyboard shortcuts ──────────────────────────────────────
  // Match predicates come from the keybindings registry — single source of truth.

  const handleKeyDown = useCanvasKeyboardShortcuts({
    canvasKeyDown,
    selectedNodeId,
    editable,
    clearSelection,
    requestDeleteNode,
    deleteNodes,
    duplicateNode,
    duplicateNodes,
    copyNode,
    copyNodes,
    cutNode,
    cutNodes,
    pasteNode,
    runShortcut: spotlight?.runShortcut,
  })

  const requestDeleteSelectionFromShortcut = useEffectEvent((
    currentSelectedNodeId: string,
    currentIds: readonly string[],
  ) => {
    if (currentIds.length > 1) {
      deleteNodes([...currentIds])
      clearSelection()
    } else {
      requestDeleteNode(currentSelectedNodeId)
    }
  })

  useEffect(() => {
    if (isLive || !editable) return
    const deleteBinding = getKeybindingForCommand('layers.delete')
    if (!deleteBinding) return

    const isCanvasEvent = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && canvasRef.current?.contains(target)) return true
      const activeElement = document.activeElement
      return activeElement instanceof Element && canvasRef.current?.contains(activeElement)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (!deleteBinding.match(event)) return
      if (!isCanvasEvent(event)) return

      const state = useEditorStore.getState()
      const currentIds = state.selectedNodeIds
      const currentSelectedNodeId = state.selectedNodeId
      if (!currentSelectedNodeId) return

      event.preventDefault()
      event.stopPropagation()

      requestDeleteSelectionFromShortcut(currentSelectedNodeId, currentIds)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive])

  // ─── ⌘/Ctrl+A — select every frame on the active studio board ─────────────
  //
  // `board-02`: this was previously handled inside `useCanvasKeyboardShortcuts`,
  // a React `onKeyDown` on the canvas div — which only fires while a
  // descendant of the canvas holds DOM focus. The moment the user touches any
  // panel, focus moves there and this handler never sees the key, so the
  // browser's native select-all ran instead (the reported bug: "ctrl A
  // selects text in the canvas panels not in the canvas itself"). Fixed by
  // scoping on INTENT instead of focus, mirroring the `layers.delete`
  // document-level listener above: a document-level listener that fires
  // regardless of which panel currently holds focus, and only stands down
  // for an editable field (`isTextInputTarget` — input/textarea/
  // contenteditable, which covers a panel text field, the DOM tree's rename
  // input, and a code editor's contenteditable surface alike) or while a
  // node is already selected (node selection has no "select all" of its own,
  // WS-7.1 — this only ever competes with the browser's native select-all).
  useEffect(() => {
    if (isLive || !editable) return
    const selectAllBinding = getKeybindingForCommand('board.selectAllFrames')
    if (!selectAllBinding) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (!selectAllBinding.match(event)) return
      if (isTextInputTarget(event.target)) return
      if (useEditorStore.getState().selectedNodeId) return

      event.preventDefault()
      useEditorStore.getState().selectAllFrames()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive])

  // ─── Enter / Escape: the whole selection ladder ────────────────────────────
  // Enter steps into a `studio.instance` (instance-ui-01); Escape steps back
  // out, and otherwise clears the node + frame selection and leaves VC mode
  // (select-01). Document-level, not React `onKeyDown` — see that file for why
  // focus-scoping silently killed Escape the moment the user touched a panel.
  useCanvasSelectionKeyboard(editable, isLive)

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
    clearSelection()
    // WS-7.1 — a background click also deselects any board-frame
    // multi-selection (a no-op outside studio board mode, where
    // `selectedFrameIds` never leaves its empty default).
    useEditorStore.getState().clearFrameSelection()
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
  const onCanvasKeyDown = isLive ? undefined : handleKeyDown
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
          // FIRST, before the explicit handlers below — @use-gesture's own
          // `drag` action binds its OWN `onKeyDown`/`onKeyUp` (arrow-key
          // accessible dragging; see `keyDown`/`keyUp` in
          // `@use-gesture/core`'s pointer action). JSX prop spreading is
          // last-one-wins, so spreading this AFTER `onKeyDown` (as it used
          // to be) silently discarded EVERY canvas keyboard shortcut —
          // Escape, +/-, Ctrl+C/X/V/D — to that library-internal handler.
          // `board-02` found this while diagnosing why Escape didn't clear
          // a frame selection; it explains the same for every OTHER
          // shortcut `useCanvasKeyboardShortcuts` owns, not just the frame
          // ones. Empty in preview mode — see gestureBindings above.
          {...gestureBindings}
          onKeyDown={onCanvasKeyDown}
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
            <CanvasContextSelector />
          )}

          {/*
          A buggy module render must not blank the toolbar / DOM panel /
          properties panel that share the editor shell. Resetting on the
          active page id means switching pages naturally clears stuck
          errors — the user navigates away from a broken module preview
          rather than getting "stuck" on the failure screen.
        */}
          <ErrorBoundary
            location="canvas"
            resetKeys={[canvasPage?.id ?? null, activeDocument?.kind ?? null, canvasView]}
          >
            {isLive ? (
              <CanvasLiveSurface
                page={canvasPage}
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
            <CanvasRulers canvasRootRef={canvasRef} transformRef={transformRef} />
          )}

          {/*
          Plugin-registered canvas overlays. Mounted after the transform
          layer so they paint above rendered nodes. Only active in design
          (editable) mode — preview-mode canvases don't need overlays and
          plugin code shouldn't paint over the visitor preview.
        */}
          {!isLive && editable && <PluginCanvasOverlayLayer />}

          {/* Studio-mode "+ Sticky note" button — untransformed canvas chrome,
              a sibling of the transform layer so it never scales with pan/zoom.
              Self-gates on active board (no-op outside studio mode). */}
          {!isLive && editable && <BoardNotesToolbar />}

          {!isLive && editable && contextMenu.position && (
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
