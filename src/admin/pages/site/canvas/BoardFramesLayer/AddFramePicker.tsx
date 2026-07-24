/**
 * AddFramePicker — "+ Frame" trigger that opens a menu of `site.pages` not
 * yet curated onto the active board, so picking one calls `addFrame(pageId)`.
 *
 * Shared by `BoardFramesLayer`'s empty state and `StudioPagesTree`'s section
 * header (the permanent home for adding a frame once a board already has
 * some — the empty state alone would strand this action) — one component,
 * one menu, so both call sites agree on which pages are "available" without
 * duplicating the filter logic.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio board
 * mode.
 */
import { useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { Button, type ButtonProps } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PlusIcon } from 'pixel-art-icons/icons/plus'

interface AddFramePickerProps {
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  /** Compact icon-only trigger (e.g. a panel section header's "+"). Requires
   *  `ariaLabel` — falls back to `label` when omitted. */
  iconOnly?: boolean
  ariaLabel?: string
}

export function AddFramePicker({
  label = 'Add frame',
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  ariaLabel,
}: AddFramePickerProps) {
  const board = useEditorStore(selectActiveBoard)
  const pages = useEditorStore((s) => s.site?.pages ?? [])
  const addFrame = useEditorStore((s) => s.addFrame)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!board) return null

  const availablePages = pages.filter((page) => !board.frames.some((f) => f.pageId === page.id))
  const noneAvailable = availablePages.length === 0

  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        disabled={noneAvailable}
        aria-label={iconOnly ? (ariaLabel ?? label) : undefined}
        tooltip={noneAvailable ? 'Every page is already on this board' : iconOnly ? (ariaLabel ?? label) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon size={iconOnly ? 11 : 12} aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
      </Button>
      {open && (
        <ContextMenu
          ariaLabel="Add frame to board"
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          side="bottom"
          align="start"
          width={220}
          maxHeight={280}
        >
          {availablePages.map((page) => (
            <ContextMenuItem
              key={page.id}
              onClick={() => {
                setOpen(false)
                addFrame(page.id)
              }}
            >
              <span>{page.title}</span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
