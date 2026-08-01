import { type Ref } from 'react'
import { Button, type ButtonProps } from '@ui/components/Button'
import { Separator } from '@ui/components/Separator'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { cn } from '@ui/cn'
import styles from './ContextMenu.module.css'

interface ContextMenuItemProps extends Omit<ButtonProps, 'variant' | 'size' | 'menuItem' | 'tone' | 'ref'> {
  danger?: boolean
  /**
   * Marks this row as the current value of a single-select list — a model,
   * a reasoning-effort level, a permission mode, and so on. Renders a
   * trailing checkmark and, unless the caller passes an explicit `role`/
   * `aria-checked`, defaults both to the `menuitemradio` pattern so every
   * call site doesn't have to wire that up by hand.
   */
  selected?: boolean
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLButtonElement>
}

export function ContextMenuItem({
  danger = false,
  selected,
  className,
  children,
  role,
  'aria-checked': ariaChecked,
  ref,
  ...props
}: ContextMenuItemProps) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="xs"
      menuItem
      role={role ?? (selected === undefined ? 'menuitem' : 'menuitemradio')}
      aria-checked={ariaChecked ?? selected}
      tone={danger ? 'danger' : 'default'}
      className={cn(styles.item, className)}
      {...props}
    >
      {children}
      {selected && <CheckIcon size={12} aria-hidden="true" className={styles.itemCheck} />}
    </Button>
  )
}

export function ContextMenuSeparator() {
  return <Separator spacing="compact" className={styles.separator} />
}
