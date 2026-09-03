/**
 * SelectionToolbar — the floating action bar for the current canvas selection:
 * drag handle, insert-module, duplicate, delete — plus, in prototype mode, the
 * second way to draw a link.
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
import { cn } from '@ui/cn'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { HandGrabSolidIcon } from 'pixel-art-icons/icons/hand-grab-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CanvasInsertModuleButton } from './CanvasInsertModuleButton'
import styles from './BreakpointSelectionOverlay.module.css'

interface SelectionToolbarProps {
  /** Positioned imperatively by the overlay's RAF tick (`positionToolbar`). */
  toolbarRef: React.RefObject<HTMLDivElement | null>
  /** `scoped` when portaled into the canvas root, `fixed` in the body fallback. */
  mode: 'scoped' | 'fixed'
  /** True while a reorder drag started from this toolbar's handle is in flight. */
  dragging: boolean
  onDragPointerDown: (event: React.PointerEvent<HTMLElement>) => void
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

export function SelectionToolbar({ toolbarRef, mode, dragging, onDragPointerDown }: SelectionToolbarProps) {
  const inPrototypeMode = useEditorStore((s) => s.boardMode === 'prototype')
  const picking = useEditorStore((s) => s.linkDraft?.mode === 'pick' || s.pendingLinkSource !== null)

  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selection actions"
      className={styles.selectionToolbar}
      data-canvas-selection-toolbar="true"
      data-canvas-toolbar-mode={mode}
      data-canvas-dragging={dragging ? 'true' : undefined}
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
          <LinkIcon size={13} color={picking ? 'var(--canvas-prototype-link)' : 'var(--text)'} />
        </Button>
      )}

      <Button
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Duplicate selected layers"
        tooltip="Duplicate selected layers"
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
        className={styles.selectionToolbarButton}
        onClick={deleteSelectedLayers}
      >
        <TrashSolidIcon size={13} color="var(--danger-light)" />
      </Button>
    </div>
  )
}
