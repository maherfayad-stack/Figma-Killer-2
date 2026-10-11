/**
 * FrameModeChips - the mode chips in a board frame's header and the "+ Mode"
 * button (CT-4).
 *
 * One chip per mode axis the project's own CSS declares (Light/Dark, a
 * `data-density` axis, ...): it names the mode THIS frame renders under and
 * opens the axis' modes. Choosing one pins it on the frame (`BoardFrame.axes`,
 * persisted in `boards.json`), and the frame repaints under that mode's gate
 * without a reload (`useApplyPreviewAxes`). "+ Mode" duplicates the frame into
 * another mode, beside the source, so light and dark sit side by side.
 *
 * Renders nothing for a project whose CSS declares no mode: no disabled chip.
 */
import { createPortal } from 'react-dom'
import { useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { mergePreviewAxes, withAxisMode, type BoardFrame } from '@core/studio-board'
import { getStudioTokenCatalog, subscribeStudioTokenCatalog } from '@site/studio/studioTokenCatalogStore'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { frameModeChips, frameModeVariants } from './frameModeOptions'
import styles from './BoardFramesLayer.module.css'

type OpenMenu = { kind: 'chip'; axisId: string; x: number; y: number } | { kind: 'add'; x: number; y: number }

/** The header drags the frame; a press on a chip is the chip's, not the drag's. */
function keepPressOffHeader(event: ReactPointerEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function FrameModeChips({ frame }: { frame: BoardFrame }) {
  const catalog = useSyncExternalStore(subscribeStudioTokenCatalog, getStudioTokenCatalog, getStudioTokenCatalog)
  const boardAxes = useEditorStore((s) => s.previewAxes)
  const [menu, setMenu] = useState<OpenMenu | null>(null)

  const chips = frameModeChips(catalog?.axes ?? [], mergePreviewAxes(boardAxes, frame.axes))
  if (chips.length === 0) return null
  const variants = frameModeVariants(chips, frame.axes)

  const open = (event: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, next: (x: number, y: number) => OpenMenu) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu(next(rect.left, rect.bottom + 4))
  }
  const chooseMode = (axisId: string, modeId: string | null) => {
    setMenu(null)
    useEditorStore.getState().setFrameAxes(frame.id, withAxisMode({ ...frame.axes }, axisId, modeId ?? undefined))
  }
  const addMode = (axes: (typeof variants)[number]['axes']) => {
    setMenu(null)
    useEditorStore.getState().duplicateFrameAsVariant(frame.id, axes)
  }
  const openChip = menu?.kind === 'chip' ? chips.find((chip) => chip.axisId === menu.axisId) : undefined

  return (
    <>
      {chips.map((chip) => (
        <Button
          key={chip.axisId}
          variant="ghost"
          size="micro"
          className={styles.modeChip}
          data-testid="board-frame-mode-chip"
          data-axis={chip.axisId}
          data-mode={chip.current.id ?? 'default'}
          aria-haspopup="menu"
          aria-label={`${chip.axisLabel}: ${chip.current.label}. Choose a mode for this frame.`}
          onPointerDown={keepPressOffHeader}
          onClick={(event) => open(event, (x, y) => ({ kind: 'chip', axisId: chip.axisId, x, y }))}
        >
          {chip.current.label}
        </Button>
      ))}
      {variants.length > 0 && (
        <Button
          variant="ghost"
          size="micro"
          className={styles.modeChip}
          data-testid="board-frame-add-mode"
          aria-haspopup="menu"
          aria-label="Add a mode: duplicate this frame in another mode"
          onPointerDown={keepPressOffHeader}
          onClick={(event) => open(event, (x, y) => ({ kind: 'add', x, y }))}
        >
          <PlusIcon size={10} aria-hidden="true" />
          Mode
        </Button>
      )}
      {/* Portalled to <body>: the board is CSS-transformed, which would re-anchor a fixed-position menu. */}
      {menu?.kind === 'chip' && openChip && createPortal(
        <ContextMenu x={menu.x} y={menu.y} ariaLabel={`${openChip.axisLabel} modes`} animateExit onClose={() => setMenu(null)}>
          {openChip.choices.map((choice) => (
            <ContextMenuItem
              key={choice.id ?? 'default'}
              data-testid="board-frame-mode-option"
              data-mode={choice.id ?? 'default'}
              selected={choice.id === openChip.current.id}
              onClick={() => chooseMode(openChip.axisId, choice.id)}
            >
              {choice.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>,
        document.body,
      )}
      {menu?.kind === 'add' && createPortal(
        <ContextMenu x={menu.x} y={menu.y} ariaLabel="Duplicate in another mode" animateExit onClose={() => setMenu(null)}>
          {variants.map((variant) => (
            <ContextMenuItem key={variant.label} data-testid="board-frame-add-mode-option" onClick={() => addMode(variant.axes)}>
              {variant.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}
