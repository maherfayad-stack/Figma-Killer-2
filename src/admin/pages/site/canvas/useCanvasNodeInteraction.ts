/**
 * useCanvasNodeInteraction — what a pointer gesture on a canvas node DOES.
 *
 * The four handlers `CanvasSelectionContext` carries, built in one place:
 * click, hover, right-click and double-click. They were inline in `CanvasRoot`,
 * which is a file that sits exactly on the 700-line ceiling
 * (`module-size-budgets`) and whose remaining job — mount the surface, own the
 * transform, wire the keyboard — is a different reason to change from "what
 * happens when you click an element".
 *
 * They are grouped rather than split four ways because they are one contract:
 * the context value is all four together, they share the frame-activation and
 * focus rules, and three of them make the SAME decision about `frameId` (WS-10
 * Phase 2: scope this to the originating BoardFrame so a "duplicate as variant"
 * sibling of the same page does not also light up).
 *
 * The options are read fresh on every render and closed over, so nothing here
 * needs a dependency array: the returned object is rebuilt each render and the
 * React Compiler memoizes it. `CanvasSelectionContext` deliberately carries
 * only these callbacks and never the selected/hovered ids — each `NodeRenderer`
 * subscribes to its own boolean, so a selection change re-renders two nodes
 * rather than the whole canvas tree (Contribution #495).
 */
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { followPrototypeLinkAt } from '@site/studio/playNavigation'
import { clientPointToEditorDoc } from './canvasDomGeometry'

export interface CanvasNodeInteractionOptions {
  /** False on a read-only canvas: right-click and double-click stand down. */
  editable: boolean
  /** Live view. Inline text editing lives inside a design frame only. */
  isLive: boolean
  /** The user may start an inline text edit at all. */
  canEditContent: boolean
  /** The prototype player is armed — a click FOLLOWS a link instead of selecting. */
  playMode: boolean
  /** The page the canvas is showing (the play screen, when armed). */
  canvasPage: Page | null
  /** The overlay presented over it, or null. */
  overlayPage: Page | null
  activeBreakpointId: string
  /**
   * Activating a frame should keep the current selection — true while a node is
   * selected and the right sidebar is open, where clearing it would collapse
   * the panel the user is working in.
   */
  preserveSelectionWhenActivatingBreakpoint: boolean
  /** Opens the canvas layer context menu at an editor-document point. */
  openContextMenu: (position: { x: number; y: number; nodeId: string }) => void
}

export interface CanvasNodeInteraction {
  onNodeClick: (nodeId: string, e: ReactMouseEvent, breakpointId?: string, frameId?: string | null) => void
  onNodeHover: (nodeId: string | null, breakpointId?: string, frameId?: string | null) => void
  onNodeContextMenu: (nodeId: string, e: ReactMouseEvent, breakpointId?: string, frameId?: string | null) => void
  onNodeDoubleClick: (nodeId: string, e: ReactMouseEvent, breakpointId?: string, frameId?: string | null) => void
}

export function useCanvasNodeInteraction(options: CanvasNodeInteractionOptions): CanvasNodeInteraction {
  const selectNode = useEditorStore((s) => s.selectNode)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const startInlineEdit = useEditorStore((s) => s.startInlineEdit)

  const onNodeClick = (nodeId: string, e: ReactMouseEvent, breakpointId?: string, frameId?: string | null) => {
    e.stopPropagation()
    // An ARMED player owns every click in the live frame. Falling through to
    // selection when no link is found would make the same gesture mean two
    // different things depending on where it landed, which is the exact
    // ambiguity the Play toggle exists to remove.
    if (options.playMode && options.canvasPage) {
      // Overlay first: it is on top, and a node id alone does not say which of
      // the two mounted surfaces the click came from.
      followPrototypeLinkAt(nodeId, [options.overlayPage?.id ?? null, options.canvasPage.id])
      return
    }
    if (breakpointId && breakpointId !== options.activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
      if (options.preserveSelectionWhenActivatingBreakpoint) {
        setFocusedPanel('canvas')
        return
      }
    }
    // Modifier-aware selection (multi-select): Cmd/Ctrl-click toggles, Shift-
    // click extends a range from the anchor. Plain clicks replace the
    // selection (default mode in `selectNode`).
    const mode = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace'
    // WS-10 Phase 2 — `frameId` scopes this selection to the originating
    // BoardFrame so a sibling "duplicate as variant" frame of the same page
    // doesn't also light up. See `selectedNodeFrameId`'s doc.
    selectNode(nodeId, mode, { frameId })
    setFocusedPanel('canvas')
  }

  const onNodeHover = (nodeId: string | null, breakpointId?: string, frameId?: string | null) => {
    hoverNode(nodeId, breakpointId, frameId)
  }

  const onNodeContextMenu = (
    nodeId: string,
    e: ReactMouseEvent,
    breakpointId?: string,
    frameId?: string | null,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    if (!options.editable) return
    if (breakpointId && breakpointId !== options.activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
    }
    // If the right-clicked node is part of an existing multi-selection, KEEP
    // the selection (the menu acts on the whole set). Otherwise replace the
    // selection with just this node — matches Figma / VS Code behaviour.
    const currentIds = useEditorStore.getState().selectedNodeIds
    if (!currentIds.includes(nodeId)) {
      selectNode(nodeId, 'replace', { frameId })
    }
    setFocusedPanel('canvas')
    // The right-click event originates inside the per-breakpoint iframe, so
    // `e.clientX` / `e.clientY` are relative to the iframe's own viewport. The
    // context menu is portaled into the editor's `document.body` with
    // `position: fixed` — it needs editor-document coordinates, which
    // `clientPointToEditorDoc` produces by adding the iframe's outer rect
    // (scaled by the canvas zoom).
    const point = clientPointToEditorDoc(e.nativeEvent ?? e)
    options.openContextMenu({ x: point.x, y: point.y, nodeId })
  }

  /**
   * Double-click on a canvas node → start an inline text-edit session when the
   * node's module declares `inlineTextEdit` (base.text, base.button, childless
   * base.link — `startInlineEdit` resolves the contract and no-ops for
   * everything else, so other modules keep the old no-op).
   *
   * Design-canvas only: the editing element lives inside a breakpoint iframe,
   * so a live-mode double-click must not open a session. Entering VC canvas
   * mode on double-click stays removed — VC entry works from the Site panel and
   * Spotlight (see `docs/features/canvas-iframe-per-frame.md`).
   */
  const onNodeDoubleClick = (
    nodeId: string,
    e: ReactMouseEvent,
    breakpointId?: string,
    frameId?: string | null,
  ) => {
    e.stopPropagation()
    if (options.isLive || !options.editable || !options.canEditContent) return
    // WS-10 §4.4 (Phase 4) — `frameId` lets the session resolve/mutate the
    // RIGHT tree when it belongs to a locale-variant board frame (a "duplicate
    // as variant" sibling shares this node id — trap #2). See
    // `inlineEditSlice.ts`'s `startInlineEdit` doc.
    startInlineEdit(nodeId, breakpointId ?? options.activeBreakpointId, frameId ?? null)
  }

  return { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick }
}
