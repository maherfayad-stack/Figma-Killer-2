/**
 * StudioCanvasLayersList - the "Canvas" section of the Studio explorer: the
 * loose layers on the active board (P5-G), the ones that live on the board
 * itself and not inside any frame, so they are as findable as a frame's
 * elements are (FC-7).
 *
 * Front first, like Figma's top-level layers: row 0 is painted last. A row
 * selects the layer (Shift/Cmd adds), double-click renames it (the name is
 * board furniture in `boards.json`, never in the user's code), and dragging a
 * row reorders it - written as `z` through `reorderCanvasLayer`, one undo step.
 *
 * The section is absent while the board has no loose layers, so a project that
 * never uses the free canvas never sees it.
 *
 * Reads only the placement list and a per-row display name, never the parsed
 * layer pages (`canvas-layer-isolation` (b)): `canvasLayerDisplayName` is the
 * store's own reader of those.
 */
import { useRef, useState } from 'react'
import { boardLayers, layerPaintOrder } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { canvasLayerDisplayName } from '@site/store/slices/canvasLayerSlice'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow, treeDropStyles } from '@site/ui/Tree'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { dropSlotAt, paintIndexForDrop } from './canvasLayerRowDrop'
import styles from './StudioCanvasLayersList.module.css'

/** Pointer travel (screen px) before a press on a row becomes a reorder drag. */
const REORDER_THRESHOLD_PX = 5

export function StudioCanvasLayersList() {
  const board = useEditorStore(selectActiveBoard)
  const listRef = useRef<HTMLDivElement>(null)
  // The gap the dragged row would land in; only changes when the pointer crosses a row midpoint.
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const suppressClickRef = useRef(false)

  const ids = board ? layerPaintOrder(boardLayers(board)).map((layer) => layer.id).reverse() : []
  if (ids.length === 0) return null

  const startReorder = (event: React.PointerEvent<HTMLElement>, from: number) => {
    if (event.button !== 0 || event.target instanceof HTMLInputElement) return
    const startY = event.clientY
    let dragging = false
    let slot = from
    const bounds = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-canvas-layer-row]') ?? []).map((row) => {
      const rect = row.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    })

    const move = (moveEvent: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientY - startY) < REORDER_THRESHOLD_PX) return
        dragging = true
      }
      const next = dropSlotAt(bounds, moveEvent.clientY)
      if (next === slot) return
      slot = next
      setDropSlot(next)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDropSlot(null)
      if (!dragging) return
      // The click that ends this drag must not also select the row.
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      if (!commit) return
      const to = paintIndexForDrop(from, slot, bounds.length)
      useEditorStore.getState().reorderCanvasLayer(ids[from]!, to)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div className={styles.section} data-testid="studio-canvas-layers">
      <div className={styles.header}>
        <span className={styles.heading}>Canvas</span>
      </div>
      <TreeContainer ariaLabel="Canvas layers" testId="studio-canvas-layers-tree" containerRef={listRef} className={styles.list}>
        {ids.map((id, index) => (
          <CanvasLayerRow
            key={id}
            layerId={id}
            dropEdge={dropSlot === index ? 'before' : dropSlot === ids.length && index === ids.length - 1 ? 'after' : null}
            onPressRow={(event) => startReorder(event, index)}
            shouldSuppressClick={() => suppressClickRef.current}
          />
        ))}
      </TreeContainer>
    </div>
  )
}

interface CanvasLayerRowProps {
  layerId: string
  /** Where the drop line sits relative to this row while a reorder drag is over the list. */
  dropEdge: 'before' | 'after' | null
  onPressRow: (event: React.PointerEvent<HTMLElement>) => void
  shouldSuppressClick: () => boolean
}

function CanvasLayerRow({ layerId, dropEdge, onPressRow, shouldSuppressClick }: CanvasLayerRowProps) {
  const name = useEditorStore((s) => canvasLayerDisplayName(s, layerId))
  const selected = useEditorStore((s) => s.selectedCanvasLayerIds.includes(layerId))
  const hidden = useEditorStore((s) => selectActiveBoard(s)?.layers?.find((layer) => layer.id === layerId)?.hidden === true)
  const [rename, renameInputRef] = useInlineRename({
    onCommit: (next) => useEditorStore.getState().renameCanvasLayer(layerId, next),
  })

  return (
    <TreeRow
      depth={0}
      selected={selected}
      hidden={hidden}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      data-canvas-layer-row=""
      data-canvas-layer-id={layerId}
      data-testid="canvas-layer-row"
      className={cn(dropEdge === 'before' && treeDropStyles.dropBefore, dropEdge === 'after' && treeDropStyles.dropAfter)}
      onPointerDown={onPressRow}
      onClick={(event) => {
        if (shouldSuppressClick()) return
        useEditorStore.getState().selectCanvasLayer(layerId, event.shiftKey || event.metaKey || event.ctrlKey ? 'toggle' : 'replace')
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        rename.start(name)
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') {
          event.preventDefault()
          useEditorStore.getState().selectCanvasLayer(layerId, 'replace')
        }
        if (event.key === 'F2') {
          event.preventDefault()
          rename.start(name)
        }
      }}
    >
      <TreeIconSlot icon={LayoutSolidIcon} iconSize={11} iconColor="var(--text-disabled)" />
      {rename.isRenaming ? (
        <Input
          ref={renameInputRef}
          fieldSize="xs"
          autoFocus
          value={rename.value}
          onChange={(event) => rename.setValue(event.target.value)}
          onKeyDown={rename.handleKeyDown}
          onBlur={rename.commit}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={`Rename canvas layer ${name}`}
          className={styles.renameInput}
        />
      ) : (
        <TreeLabel>{name}</TreeLabel>
      )}
    </TreeRow>
  )
}
