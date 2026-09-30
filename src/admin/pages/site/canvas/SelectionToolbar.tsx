/**
 * SelectionToolbar — the floating action bar for the current canvas selection:
 * drag handle, insert-module, "Edit points" on an editable inline `<svg>`
 * (P5-D vector edit mode's visible door — `vectorEditEntry.ts`), duplicate,
 * delete.
 *
 * Extracted from `BreakpointSelectionOverlay.tsx`, which named this exact
 * split as its own extraction candidate when it was grandfathered over the
 * module-size ceiling. The two are cleanly separable: the overlay owns
 * MEASUREMENT (the RAF tick, the rect sources, the `--selection-anchor-*`
 * channel) and this file owns the toolbar's markup and its two selection
 * actions, which need nothing from the tick beyond the ref it positions.
 *
 * Positioning stays with the overlay: it hands down `toolbarRef` and calls
 * `positionToolbar` on it. `mode` mirrors the overlay's `toolbarMode` —
 * `scoped` when the chrome is portaled into the canvas root, `fixed` in the
 * body fallback.
 *
 * Styles come from `BreakpointSelectionOverlay.module.css` rather than a
 * module of this file's own, because these class names are part of that
 * overlay's one visual system (`CanvasTreeLadderMenu.tsx` imports the same
 * sheet for the same reason). Splitting the CSS would fork the tokens that
 * keep the toolbar and the rings looking like one control surface.
 */
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { shortcutLabelFor } from '@admin/spotlight/keybindings'
import { cn } from '@ui/cn'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { HandGrabSolidIcon } from 'pixel-art-icons/icons/hand-grab-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { PenGlyphIcon } from '@ui/components/ElementIcons'
import { CanvasInsertModuleButton } from './CanvasInsertModuleButton'
import { tryEnterVectorEdit, vectorEditVerdict } from './BoardVectorLayer/vectorEditEntry'
import { useVectorEditTarget } from './BoardVectorLayer/vectorEditState'
import styles from './BreakpointSelectionOverlay.module.css'

interface SelectionToolbarProps {
  /** Positioned imperatively by the overlay's RAF tick (`positionToolbar`). */
  toolbarRef: React.RefObject<HTMLDivElement | null>
  /** `scoped` when portaled into the canvas root, `fixed` in the body fallback. */
  mode: 'scoped' | 'fixed'
  onDragPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  /** The board frame this toolbar floats over — the frame vector edit mode measures its points in. */
  frameId: string | null
}

/**
 * Start a prototype link from the selected node.
 *
 * The `+` handle beside the element is the primary affordance, but it can only
 * be drawn where the canvas can measure the node — so the action also lives
 * here, on chrome that is already floating over the selection. This sets the
 * request; `usePrototypeLinkPick` turns it into a draft once it has the board
 * geometry the toolbar has no way to know.
 */
function startPrototypeLink() {
  const state = useEditorStore.getState()
  const nodeId = state.selectedNodeId
  const pageId = state.activePageId
  if (!nodeId || !pageId) return
  state.requestLinkFromNode({ pageId, nodeId })
}

function duplicateSelectedLayers() {
  const ids = useEditorStore.getState().selectedNodeIds
  if (ids.length === 0) return
  useEditorStore.getState().duplicateNodes(ids)
}

function deleteSelectedLayers() {
  const ids = useEditorStore.getState().selectedNodeIds
  if (ids.length === 0) return
  const state = useEditorStore.getState()
  state.deleteNodes(ids)
  state.clearSelection()
}

export function SelectionToolbar({ toolbarRef, mode, onDragPointerDown, frameId }: SelectionToolbarProps) {
  const inPrototypeMode = useEditorStore((s) => s.boardMode === 'prototype')
  const picking = useEditorStore((s) => s.linkDraft?.mode === 'pick' || s.pendingLinkSource !== null)
  // Only where entering would succeed: a refused svg (an `.svg`-file icon, a
  // list row, a locked node) keeps its explanation on the double-click, and a
  // button that could only ever refuse is noise on every icon.
  const vectorNodeId = useEditorStore((s) =>
    s.selectedNodeIds.length === 1 && vectorEditVerdict(s, s.selectedNodeIds[0]).kind === 'editable'
      ? s.selectedNodeIds[0]
      : null,
  )
  const vectorEditTarget = useVectorEditTarget()
  const editingPoints = vectorNodeId !== null && vectorEditTarget?.hostNodeId === vectorNodeId

  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selection actions"
      className={styles.selectionToolbar}
      data-canvas-selection-toolbar="true"
      data-canvas-toolbar-mode={mode}
      // The toolbar is portaled into the canvas root, whose onClick clears the
      // selection on background clicks. Without this guard a toolbar click
      // bubbles up, clears the selection, and unmounts the toolbar mid-action
      // (e.g. the Insert-module action would clear the selection as the canvas
      // reselects the element behind). Same pattern as CanvasNotch.
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Drag selected layers"
        tooltip="Drag selected layers"
        className={cn(styles.selectionToolbarButton, styles.dragToolbarButton)}
        onPointerDown={onDragPointerDown}
      >
        <HandGrabSolidIcon size={13} color="var(--text)" />
      </Button>
      <CanvasInsertModuleButton buttonClassName={styles.selectionToolbarButton} />

      {vectorNodeId && (
        <Button
          variant="secondary"
          size="xs"
          iconOnly
          aria-label="Edit points"
          aria-pressed={editingPoints}
          tooltip="Edit points (or double-click the graphic)"
          className={styles.selectionToolbarButton}
          data-testid="canvas-selection-edit-points"
          onClick={() => tryEnterVectorEdit(vectorNodeId, frameId)}
        >
          <PenGlyphIcon size={13} />
        </Button>
      )}

      {inPrototypeMode && (
        <Button
          variant="secondary"
          size="xs"
          iconOnly
          aria-label="Draw a prototype link from this element"
          aria-pressed={picking}
          tooltip={picking ? 'Click a screen to link to — Esc cancels' : 'Link this element to a screen'}
          className={styles.selectionToolbarButton}
          onClick={startPrototypeLink}
        >
          <LinkIcon size={13} />
        </Button>
      )}

      <Button
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Duplicate selected layers"
        tooltip="Duplicate selected layers"
        tooltipShortcut={shortcutLabelFor('layers.duplicate')}
        className={styles.selectionToolbarButton}
        onClick={duplicateSelectedLayers}
      >
        <CopyPlusSolidIcon size={13} color="var(--text)" />
      </Button>
      <Button
        variant="secondary"
        size="xs"
        iconOnly
        tone="danger"
        aria-label="Delete selected layers"
        tooltip="Delete selected layers"
        tooltipShortcut={shortcutLabelFor('layers.delete')}
        className={styles.selectionToolbarButton}
        onClick={deleteSelectedLayers}
      >
        <TrashSolidIcon size={13} color="var(--danger-light)" />
      </Button>
    </div>
  )
}
