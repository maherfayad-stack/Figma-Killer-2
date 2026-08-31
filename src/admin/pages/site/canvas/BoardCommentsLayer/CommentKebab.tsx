/**
 * CommentKebab — the ⋯ menu carrying a comment's or a thread's own actions.
 *
 * Edit and Delete used to sit inline under every comment, which meant the
 * destructive action was a stray click away from Reply and the popover grew a
 * row of buttons per comment. Both belong behind one affordance: the actions
 * are rare, and hiding them keeps the conversation the thing you read.
 *
 * Built on the shared `ContextMenu`, so positioning, iframe-aware
 * dismiss-on-outside-click and styling match every other menu in the admin.
 * The menu portals to `document.body`, i.e. OUTSIDE the popover's DOM subtree
 * — which is exactly why `CommentThreadPopover` has to treat an open kebab as
 * "inside" for its own dismiss (see `menuOpenRef` there).
 */
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu } from '@ui/components/ContextMenu'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import styles from './CommentThreadPopover.module.css'

interface CommentKebabProps {
  ariaLabel: string
  /** Told when the menu opens or closes — the popover's dismiss needs to know. */
  onOpenChange?: (open: boolean) => void
  /** `close` lets an item dismiss the menu after acting. */
  children: (close: () => void) => ReactNode
}

export function CommentKebab({ ariaLabel, onOpenChange, children }: CommentKebabProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const setOpenAndNotify = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className={styles.kebabTrigger}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpenAndNotify(!open)}
      >
        <MoreHorizontalSolidIcon size={14} />
      </Button>
      {open ? (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="auto"
          offset={4}
          minWidth={160}
          ariaLabel={ariaLabel}
          onClose={() => setOpenAndNotify(false)}
        >
          {children(() => setOpenAndNotify(false))}
        </ContextMenu>
      ) : null}
    </>
  )
}
