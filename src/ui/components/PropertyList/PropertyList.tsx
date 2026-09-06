/**
 * PropertyList — the Fill / Stroke / Effects list shape (F13, F14, F16, F20 in
 * docs/features/inspector-disclosure.md §3.2). One component, three future
 * consumers: fill layers, stroke, and shadow/blur effects. It must not know
 * what a fill is — every entry is opaque `ReactNode` content supplied by the
 * caller.
 *
 * Law 1 (the plan's §1): an unused section costs one line. This component
 * renders the LIST ONLY — zero entries means this component renders `null`.
 * The section's title row and its `+` trigger belong to the caller's
 * `Section` (`@ui/components/Section`), which already has an `actions` slot
 * for exactly this. Do not add a header here; a second header would defeat
 * the reason this primitive exists.
 *
 * Row anatomy: `[leading] [summary] [value] [visibility] [remove]`. A row is
 * itself activatable — click or Enter/Space on the row (not on one of its
 * trailing buttons) fires `onActivate` with a stable ref to the row's own DOM
 * node, so the caller can anchor an `InspectorPopover` editor to it without
 * this component knowing what a popover is.
 *
 * Reordering is keyboard-only here, deliberately: `Alt+ArrowUp` /
 * `Alt+ArrowDown` on a focused row, matching the repo's existing reorder
 * convention (`layers.moveUp` / `layers.moveDown` in
 * `src/admin/spotlight/commands/layers.ts`). Pointer drag-reordering is a
 * real gap for fill/stroke/shadow lists (order changes the rendered
 * `box-shadow` / background layers) but the repo is mid-migration off
 * `@dnd-kit/core` — that is a follow-up, not something to bolt on here with a
 * new drag dependency.
 *
 * The visibility eye is opt-in and OFF by default: pass `onToggleVisible` to
 * render it. CSS has no "disabled declaration" to honestly back a hidden-but-
 * present fill/stroke/effect yet (plan §8, open decision 1) — until a caller
 * has a real storage model for that, the eye must not exist, not render
 * disabled.
 */
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Button } from '@ui/components/Button'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import styles from './PropertyList.module.css'

export interface PropertyListEntry<T = unknown> {
  /** Stable identity — used for the React key, ref tracking, and reorder maths. */
  id: string
  /** The accessible name for THIS entry ("Drop shadow 2", "Fill 1 — #FFFFFF"). Powers "Remove <name>" / "Hide <name>" button labels — never just "Remove". */
  label: string
  /** A swatch, a shadow preview swatch, an effect-kind icon — whatever identifies the entry's kind at a glance. */
  leading?: ReactNode
  /** The entry's primary text (a hex value, "Drop shadow", a gradient preview). */
  summary: ReactNode
  /** Optional trailing value, right-aligned before the action buttons (an opacity %). */
  value?: ReactNode
  /** Caller-owned payload (the actual fill/stroke/effect object) — handed back verbatim through `onActivate` / `onRemove` / `onReorder` so the caller never has to re-look-up an entry by `id`. */
  data: T
}

export interface PropertyListProps<T = unknown> {
  /** Accessible name for the list as a whole, e.g. "Fill layers". */
  listLabel: string
  entries: PropertyListEntry<T>[]
  /**
   * Fired when a row is activated (click, or Enter/Space while the row itself
   * — not a nested button — has focus). Receives a ref to the row's DOM node
   * so the caller can anchor an editor popover to it.
   */
  onActivate?: (entry: PropertyListEntry<T>, anchorRef: RefObject<HTMLElement | null>) => void
  /** Fired to remove an entry. */
  onRemove: (entry: PropertyListEntry<T>) => void
  /**
   * Fired with (fromIndex, toIndex) from `Alt+ArrowUp` / `Alt+ArrowDown` on a
   * focused row. Omit to leave the list without keyboard reordering (e.g. a
   * single-entry list where order is meaningless).
   */
  onReorder?: (fromIndex: number, toIndex: number) => void
  /**
   * Opt-in visibility toggle (F14 / F16's eye). The eye does not render at
   * all unless this is passed — see the module doc comment.
   */
  onToggleVisible?: (entry: PropertyListEntry<T>) => void
  /** Whether `entry` is currently visible. Only consulted when `onToggleVisible` is passed; defaults to visible. */
  isVisible?: (entry: PropertyListEntry<T>) => boolean
  /**
   * Ref to the section header's own `+` trigger. When the last entry is
   * removed, focus moves there instead of disappearing — the `+` lives in the
   * caller's `Section`, so this is the one seam back to it.
   */
  addTriggerRef?: RefObject<HTMLElement | null>
}

type PendingFocus = { kind: 'reorder'; id: string } | { kind: 'remove'; index: number }

export function PropertyList<T = unknown>({
  listLabel,
  entries,
  onActivate,
  onRemove,
  onReorder,
  onToggleVisible,
  isVisible,
  addTriggerRef,
}: PropertyListProps<T>) {
  const rowRefsRef = useRef(new Map<string, RefObject<HTMLElement | null>>())
  const pendingFocusRef = useRef<PendingFocus | null>(null)

  useEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null

    if (pending.kind === 'reorder') {
      rowRefsRef.current.get(pending.id)?.current?.focus()
      return
    }

    // 'remove' — focus the row that now occupies the removed row's index, or
    // the previous row if it was last, or the section's `+` when the list is
    // now empty. A focus black hole after delete is the most common defect in
    // this pattern.
    if (entries.length === 0) {
      addTriggerRef?.current?.focus()
      return
    }
    const nextIndex = Math.min(pending.index, entries.length - 1)
    const nextEntry = entries[nextIndex]
    if (nextEntry) rowRefsRef.current.get(nextEntry.id)?.current?.focus()
  }, [entries, addTriggerRef])

  // Law 1: an empty list costs nothing. The header + `+` are the caller's
  // `Section`, not this component.
  if (entries.length === 0) return null

  function getRowRef(id: string): RefObject<HTMLElement | null> {
    const map = rowRefsRef.current
    let ref = map.get(id)
    if (!ref) {
      ref = { current: null }
      map.set(id, ref)
    }
    return ref
  }

  function handleRemove(index: number, entry: PropertyListEntry<T>) {
    pendingFocusRef.current = { kind: 'remove', index }
    onRemove(entry)
  }

  function handleToggleVisible(entry: PropertyListEntry<T>) {
    onToggleVisible?.(entry)
  }

  function handleRowClick(entry: PropertyListEntry<T>) {
    onActivate?.(entry, getRowRef(entry.id))
  }

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, index: number, entry: PropertyListEntry<T>) {
    if (onReorder && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const toIndex = event.key === 'ArrowUp' ? index - 1 : index + 1
      if (toIndex < 0 || toIndex >= entries.length) return
      event.preventDefault()
      event.stopPropagation()
      pendingFocusRef.current = { kind: 'reorder', id: entry.id }
      onReorder(index, toIndex)
      return
    }

    // Only treat Enter/Space as row activation when the row itself — not a
    // nested eye/remove button — is the event target, so the browser's own
    // Enter/Space-triggers-click behaviour on those buttons isn't doubled up.
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleRowClick(entry)
    }
  }

  function stopRowActivation(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
  }

  return (
    <div className={styles.list} role="list" aria-label={listLabel}>
      {entries.map((entry, index) => {
        const visible = onToggleVisible ? (isVisible ? isVisible(entry) : true) : true

        return (
          <div
            key={entry.id}
            ref={(el) => {
              getRowRef(entry.id).current = el
            }}
            role="listitem"
            tabIndex={0}
            className={styles.row}
            onClick={() => handleRowClick(entry)}
            onKeyDown={(event) => handleRowKeyDown(event, index, entry)}
          >
            {entry.leading && <span className={styles.leading}>{entry.leading}</span>}
            <span className={styles.summary}>{entry.summary}</span>
            {entry.value !== undefined && <span className={styles.value}>{entry.value}</span>}
            {onToggleVisible && (
              <Button
                variant="ghost"
                size="micro"
                iconOnly
                aria-label={`${visible ? 'Hide' : 'Show'} ${entry.label}`}
                tooltip={visible ? 'Hide' : 'Show'}
                onClick={(event) => {
                  stopRowActivation(event)
                  handleToggleVisible(entry)
                }}
              >
                {visible ? <EyeSolidIcon size={12} aria-hidden="true" /> : <EyeOffSolidIcon size={12} aria-hidden="true" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              tone="danger"
              aria-label={`Remove ${entry.label}`}
              tooltip="Remove"
              onClick={(event) => {
                stopRowActivation(event)
                handleRemove(index, entry)
              }}
            >
              <MinusIcon size={12} aria-hidden="true" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
