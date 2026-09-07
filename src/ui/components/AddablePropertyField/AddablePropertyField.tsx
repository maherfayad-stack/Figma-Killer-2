/**
 * AddablePropertyField — Figma's "Add min width…" field (F30/F31).
 *
 * A `ScrubInput` (drag-scrub, arrow-nudge, `MIXED` — all already shipped
 * there and reused verbatim, never reimplemented) plus a trailing chevron
 * that opens a `ContextMenu` carrying up to three groups, in order:
 *
 *   1. `modes` — the field's own mode options (e.g. Fixed / Hug / Fill).
 *      The active mode carries a checkmark and, via `activeLabel`, quotes
 *      the live value ("Fixed width (54)"); every other mode shows its
 *      plain `label` ("Hug contents").
 *   2. `additions` — one "Add <companion>…" item per unset companion
 *      property the caller currently offers (min-width, max-width, …).
 *      Selecting one calls `onAdd(key)` and nothing else — see below.
 *   3. `actions` — caller-supplied extras (e.g. "Apply variable…").
 *
 * Law 3 (`docs/features/inspector-disclosure.md` §1): a property with no
 * value and no default-worth is not a field, it is a menu item on the
 * field it constrains. Concretely: `onAdd` NEVER writes a CSS value. It
 * only tells the caller "reveal this companion row, unset, with the
 * computed value as a placeholder" — the caller renders a `RevealedField`
 * for it. The property is written for the first time only when the user
 * commits a value into that revealed row. This matters here specifically
 * because this repo's controls write real CSS into the user's own source
 * files: "Add min width" must never put `min-width: 0` in someone's
 * stylesheet just because a menu item was clicked.
 *
 * Mode-word display: when the active mode carries a `word` (e.g. Hug /
 * Fill), the field shows that word instead of a number — right-aligned, to
 * read as a state rather than a quantity — while the input's `aria-label`
 * stays the identity passed in (`aria-label`), spelled out, regardless of
 * what's currently displayed. Typing over the word (a commit that isn't the
 * word itself) switches the field back to `numericMode` before forwarding
 * the typed value to `onChange` — Figma's own affordance for overriding
 * Hug/Fill with an explicit number.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { isMixed, type Mixed } from '@ui/components/MixedValue'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import styles from './AddablePropertyField.module.css'

type FieldSize = 'xs' | 'sm' | 'md'

export interface AddablePropertyFieldMode {
  /** Stable id for this mode (e.g. `'fixed'` / `'hug'` / `'fill'`). */
  value: string
  /** Menu label shown when this mode is NOT the active one ("Hug contents"). */
  label: ReactNode
  /**
   * Menu label shown when this mode IS active. Receives the field's live
   * `value` so it can quote it (F30's "Fixed width (54)"). Omit for modes
   * whose `label` needs no value quoted — `label` is reused instead.
   */
  activeLabel?: (value: string | Mixed | undefined) => ReactNode
  /**
   * The word the field itself displays, in place of a number, while this
   * mode is active (F4's "Hug"). Omit for exactly one mode — the numeric
   * one named by `numericMode` — whose field shows `value` as a number.
   */
  word?: string
  /**
   * Why this mode cannot be chosen right now. Present ⇒ the menu row is
   * rendered disabled with this string as its tooltip, rather than hidden —
   * the same disabled-with-a-named-reason shape `AlignBar`'s
   * `alignDisabledReasons` uses. A mode the user can't have should still be
   * visible and should say why; silently dropping it from the menu teaches
   * nothing. `SizeSection` uses this for Hug/Fill when the selected
   * element's parent layout can't be read (`elementSizing.ts`).
   */
  disabledReason?: string
}

export interface AddablePropertyFieldAddition {
  /** Stable key passed back to `onAdd`. */
  key: string
  /** Full menu row content, spelled out — e.g. `"Add minimum width…"`. */
  label: ReactNode
  /** Optional leading glyph (e.g. `MinWidthIcon`). */
  icon?: ReactNode
}

export interface AddablePropertyFieldAction {
  key: string
  label: ReactNode
  icon?: ReactNode
  onSelect: () => void
}

export interface AddablePropertyFieldProps {
  /**
   * The field's human identity — "Width", "Height". Builds the chevron's
   * accessible name ("Width options") and the menu's `aria-label`.
   */
  name: string
  /** In-field leading mark for the `ScrubInput` (a letterform or glyph). */
  label: ReactNode
  /**
   * Always-spelled-out accessible name for the input, e.g. "Width". Stays
   * the same regardless of whether the field is showing a number or a mode
   * word.
   */
  'aria-label': string

  /** Current numeric CSS value. */
  value: string | Mixed | undefined
  onChange: (next: string) => void
  onPreview?: (next: string) => void
  onClearPreview?: () => void

  /** Mode group (menu group 1). Omit or pass `[]` to hide it entirely. */
  modes?: AddablePropertyFieldMode[]
  /** id of the currently active mode. Required when `modes` is non-empty. */
  mode?: string
  onModeChange?: (mode: string) => void
  /**
   * id of the one mode whose field shows `value` as a number. Used only to
   * know which mode to switch to when the user types over a mode `word`.
   */
  numericMode?: string

  /** "Add <companion>…" items (menu group 2). Caller owns which are unset. */
  additions?: AddablePropertyFieldAddition[]
  /** Fired when an addition is chosen. MUST NOT write any CSS — see docblock. */
  onAdd?: (key: string) => void

  /** Caller-supplied extra actions (menu group 3), e.g. "Apply variable…". */
  actions?: AddablePropertyFieldAction[]

  unit?: string
  step?: number
  shiftStep?: number
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
  fieldSize?: FieldSize
  className?: string
  'data-testid'?: string
}

export function AddablePropertyField({
  name,
  label,
  'aria-label': ariaLabel,
  value,
  onChange,
  onPreview,
  onClearPreview,
  modes = [],
  mode,
  onModeChange,
  numericMode,
  additions = [],
  onAdd,
  actions = [],
  unit = 'px',
  step,
  shiftStep,
  min,
  max,
  placeholder,
  disabled = false,
  fieldSize = 'sm',
  className,
  'data-testid': dataTestId,
}: AddablePropertyFieldProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Focus returns to the chevron once the menu has actually closed, not
  // synchronously inside the event that closes it. The chevron's own
  // `aria-expanded` suppresses its `Tooltip` wrapper while the menu is open
  // (see Button's docblock), so the SAME state flip that closes the menu also
  // swaps the trigger's DOM node (bare `<button>` while suppressed → a
  // `Tooltip`-cloned `<button>` once re-enabled) — an immediate `.focus()`
  // call would land on the outgoing node, not the one that survives the
  // commit. Running the refocus in an effect keyed on `menuOpen` guarantees
  // `triggerRef.current` is the settled, final node before it fires.
  const wasMenuOpenRef = useRef(false)
  useEffect(() => {
    if (wasMenuOpenRef.current && !menuOpen) triggerRef.current?.focus()
    wasMenuOpenRef.current = menuOpen
  }, [menuOpen])

  const activeModeOption = modes.find((candidate) => candidate.value === mode)
  const wordMode = activeModeOption?.word !== undefined
  const fieldValue = wordMode ? activeModeOption.word : value

  function closeMenu() {
    setMenuOpen(false)
  }

  function handleFieldChange(next: string) {
    // Typing over a mode word is how Figma lets you override Hug/Fill with
    // an explicit number — any commit that ISN'T the word itself means the
    // user typed a real value, so the field falls back to the numeric mode
    // before the value is forwarded.
    if (wordMode && numericMode !== undefined) {
      const stillTheWord = next.trim().toLowerCase() === (activeModeOption?.word ?? '').trim().toLowerCase()
      if (!stillTheWord) onModeChange?.(numericMode)
    }
    onChange(next)
  }

  const hasModes = modes.length > 0
  const hasAdditions = additions.length > 0
  const hasActions = actions.length > 0
  const chevronLabel = `${name} options`

  return (
    <div className={cn(styles.field, wordMode && styles.wordMode, className)} data-testid={dataTestId}>
      <ScrubInput
        value={fieldValue}
        onChange={handleFieldChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        label={label}
        aria-label={ariaLabel}
        unit={unit}
        step={step}
        shiftStep={shiftStep}
        min={min}
        max={max}
        placeholder={placeholder}
        disabled={disabled}
        fieldSize={fieldSize}
        className={styles.scrubWrapper}
        data-testid={dataTestId ? `${dataTestId}-scrub` : undefined}
      />
      <Button
        ref={triggerRef}
        variant="ghost"
        size="micro"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={chevronLabel}
        tooltip={chevronLabel}
        disabled={disabled}
        className={styles.chevron}
        onClick={() => setMenuOpen((open) => !open)}
        data-testid={dataTestId ? `${dataTestId}-chevron` : undefined}
      >
        <ChevronDownIcon size={10} color="currentColor" aria-hidden="true" />
      </Button>
      {menuOpen && (
        <ContextMenu
          ariaLabel={chevronLabel}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          onClose={closeMenu}
        >
          {hasModes &&
            modes.map((modeOption) => {
              const isActive = modeOption.value === mode
              const content = isActive && modeOption.activeLabel ? modeOption.activeLabel(value) : modeOption.label
              const unavailable = modeOption.disabledReason
              return (
                <ContextMenuItem
                  key={modeOption.value}
                  selected={isActive}
                  disabled={unavailable !== undefined}
                  tooltip={unavailable}
                  onClick={() => {
                    onModeChange?.(modeOption.value)
                    closeMenu()
                  }}
                >
                  {content}
                </ContextMenuItem>
              )
            })}
          {hasModes && (hasAdditions || hasActions) && <ContextMenuSeparator />}
          {hasAdditions &&
            additions.map((addition) => (
              <ContextMenuItem
                key={addition.key}
                onClick={() => {
                  onAdd?.(addition.key)
                  closeMenu()
                }}
              >
                {addition.icon}
                {addition.label}
              </ContextMenuItem>
            ))}
          {hasAdditions && hasActions && <ContextMenuSeparator />}
          {hasActions &&
            actions.map((action) => (
              <ContextMenuItem
                key={action.key}
                onClick={() => {
                  action.onSelect()
                  closeMenu()
                }}
              >
                {action.icon}
                {action.label}
              </ContextMenuItem>
            ))}
        </ContextMenu>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RevealedField — the companion row a Law-3 "Add …" reveals
// ---------------------------------------------------------------------------

export interface RevealedFieldProps {
  /** In-field leading mark (e.g. `MinWidthIcon`). */
  label: ReactNode
  ariaLabel: string
  /** `undefined` renders the field UNSET — pass a placeholder for the computed value. */
  value: string | Mixed | undefined
  onChange: (next: string) => void
  onPreview?: (next: string) => void
  onClearPreview?: () => void
  /**
   * Fired by the trailing "−". The caller is expected to both clear the
   * underlying CSS property AND stop rendering this row (returning its
   * `Add …` item to the field's menu) — bundling both in one prop is what
   * keeps that pair from drifting apart between call sites.
   */
  onRemove: () => void
  unit?: string
  step?: number
  shiftStep?: number
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
  fieldSize?: FieldSize
  className?: string
  'data-testid'?: string
}

export function RevealedField({
  label,
  ariaLabel,
  value,
  onChange,
  onPreview,
  onClearPreview,
  onRemove,
  unit = 'px',
  step,
  shiftStep,
  min,
  max,
  placeholder,
  disabled = false,
  fieldSize = 'sm',
  className,
  'data-testid': dataTestId,
}: RevealedFieldProps) {
  const isSet = isMixed(value) || (value !== undefined && value !== '')

  return (
    <div className={cn(styles.revealedCell, className)} data-testid={dataTestId}>
      <ScrubInput
        value={value}
        onChange={onChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        label={label}
        aria-label={ariaLabel}
        unit={unit}
        step={step}
        shiftStep={shiftStep}
        min={min}
        max={max}
        placeholder={placeholder}
        disabled={disabled}
        fieldSize={fieldSize}
        className={styles.revealedScrubWrapper}
        data-testid={dataTestId ? `${dataTestId}-scrub` : undefined}
      />
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        aria-label={`Remove ${ariaLabel.toLowerCase()}`}
        tooltip={`Remove ${ariaLabel.toLowerCase()}`}
        disabled={disabled}
        onClick={onRemove}
        className={styles.revealedRemoveBtn}
        data-testid={dataTestId ? `${dataTestId}-remove` : undefined}
        data-state={isSet ? 'set' : 'unset'}
      >
        <MinusIcon size={10} color="currentColor" aria-hidden="true" />
      </Button>
    </div>
  )
}
