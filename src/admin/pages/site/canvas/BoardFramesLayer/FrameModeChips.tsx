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
import { useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { mergePreviewAxes, withAxisMode, type BoardFrame } from '@core/studio-board'
import { getStudioTokenCatalog, subscribeStudioTokenCatalog } from '@site/studio/studioTokenCatalogStore'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { frameModeChips, frameModeVariants } from './frameModeOptions'
import styles from './BoardFramesLayer.module.css'

type OpenMenu = { kind: 'chip'; axisId: string } | { kind: 'add' }

export function FrameModeChips({ frame }: { frame: BoardFrame }) {
  const catalog = useSyncExternalStore(subscribeStudioTokenCatalog, getStudioTokenCatalog, getStudioTokenCatalog)
  const boardAxes = useEditorStore((s) => s.previewAxes)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  // The button the open menu hangs from. The menu treats a press on its anchor
  // as "not outside", so the click that opened it cannot also dismiss it.
  const anchorRef = useRef<HTMLElement | null>(null)

  const chips = frameModeChips(catalog?.axes ?? [], mergePreviewAxes(boardAxes, frame.axes))
  if (chips.length === 0) return null
  const variants = frameModeVariants(chips, frame.axes)

  const open = (event: ReactMouseEvent<HTMLElement>, next: OpenMenu) => {
    anchorRef.current = event.currentTarget
    setMenu(next)
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
          data-frame-header-control=""
          onClick={(event) => open(event, { kind: 'chip', axisId: chip.axisId })}
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
          data-frame-header-control=""
          onClick={(event) => open(event, { kind: 'add' })}
        >
          <PlusIcon size={10} aria-hidden="true" />
          Mode
        </Button>
      )}
      {menu?.kind === 'chip' && openChip && (
        <ContextMenu anchorRef={anchorRef} ariaLabel={`${openChip.axisLabel} modes`} onClose={() => setMenu(null)}>
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
        </ContextMenu>
      )}
      {menu?.kind === 'add' && (
        <ContextMenu anchorRef={anchorRef} ariaLabel="Duplicate in another mode" onClose={() => setMenu(null)}>
          {variants.map((variant) => (
            <ContextMenuItem key={variant.label} data-testid="board-frame-add-mode-option" onClick={() => addMode(variant.axes)}>
              {variant.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
