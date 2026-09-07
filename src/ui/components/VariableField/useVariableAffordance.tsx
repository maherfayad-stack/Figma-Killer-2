/**
 * useVariableAffordance — Figma's "Apply variable" affordance, as one hook a
 * field primitive drops into its existing markup.
 *
 * A hook rather than a wrapper component because the affordance is TWO
 * elements in two different places inside a field that already exists:
 *
 *   - `chip`    — the bound variable's name, a small rounded pill at the
 *                 field's LEADING edge, rendered where the field puts its
 *                 prefix (`Input`'s `leadingSlot`, or inline in
 *                 `ScrubInput`'s flex row).
 *   - `trigger` — the hover-revealed hexagon button at the field's TRAILING
 *                 edge, absolutely positioned inside the field's own
 *                 `position: relative` wrapper so it OVERLAYS the value
 *                 instead of reserving a column. That is what keeps this
 *                 change free of any height cost (`inspectorGeometryBudget`)
 *                 and free of any width cost on fields that are already
 *                 68px wide.
 *
 * Wrapping the field in a new element instead would have moved every
 * caller's layout `className` one level away from the box it was written
 * for, across ~40 call sites. Two slots into the existing box is the smaller
 * and more honest change.
 *
 * ## The states, and what each one writes
 *
 * | state            | field shows                  | commit                    |
 * |------------------|------------------------------|---------------------------|
 * | unbound          | its own value                | trigger → pick → `var(--x)` |
 * | bound, idle      | chip (name only) + empty rest| detach × → resolved literal |
 * | bound, editing   | empty input + open picker    | typed literal, OR `var(--y)` |
 * | mixed            | "Mixed", no chip             | pick → `var(--x)` to all    |
 *
 * "Bound, idle → editing" is the refinement that makes the chip not a dead
 * end: clicking it focuses the field's own (now empty) input AND opens the
 * picker, so the same gesture reaches both "type any literal" and "swap to
 * another variable". Escape closes the picker and leaves the binding alone —
 * nothing was written, because entering edit mode writes nothing.
 *
 * The chip deliberately shows the NAME ONLY, with the resolved value as its
 * tooltip. Figma does the same, and for the same reason: a chip that also
 * printed `#ef4550` would be wider than most inspector fields and would
 * re-render on every theme change while claiming to be the thing you edit.
 *
 * ## Scrubbing a bound field
 *
 * Nothing here disables it, because nothing has to: `useScrubDrag`'s
 * documented contract already refuses any value that is not a bare
 * `<number><unit>`, and `var(--x)` is not one. A bound numeric field is
 * therefore already un-scrubbable by the engine both fields share.
 */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { formatVarBinding, parseVarBinding, variableChipLabel } from './varBinding'
import { useVariableCatalog, useVariableOptions } from './VariableSourceContext'
import { VariablePickerPopover } from './VariablePickerPopover'
import type { VariableKind } from './variableKind'
import styles from './VariableField.module.css'

export interface UseVariableAffordanceOptions {
  /** The field's committed value. `var(--x)` here is what makes the field "bound". */
  value: string | undefined
  /** Which variable kinds this field can legally take. */
  accept: readonly VariableKind[]
  /**
   * Writes a new value through the FIELD'S OWN commit path — the same one a
   * typed value takes, so a variable pick is one honest, undoable write and
   * multi-selection fan-out keeps working with no extra code.
   */
  onCommit: (next: string) => void
  /** The field's accessible name. Used for the picker's sticky id and the button labels. */
  fieldLabel: string
  /** Multi-selection disagreement — no chip, but the picker still writes to everything. */
  mixed?: boolean
  disabled?: boolean
  /**
   * True while the field's own text input is focused. The chip hides so the
   * user can see (and replace) what they are typing.
   */
  editing?: boolean
  /**
   * Focus + select the field's own text input. Called when the chip is
   * clicked, which is how "bound, idle" becomes "bound, editing".
   */
  onEnterEdit?: () => void
}

export interface VariableAffordance {
  /** True when `value` is a lone `var()` reference. */
  bound: boolean
  /**
   * What the field should DISPLAY in its text input. Empty while a binding is
   * shown as a chip, so the raw `var(--x)` never competes with the chip and
   * the first keystroke in edit mode replaces the binding outright.
   */
  displayValue: string | undefined
  /** Leading-edge chip. `null` when unbound, mixed, or actively editing. */
  chip: ReactNode
  /** Trailing-edge hover-revealed button + its popover. `null` when there is nothing to offer. */
  trigger: ReactNode
}

export function useVariableAffordance({
  value,
  accept,
  onCommit,
  fieldLabel,
  mixed = false,
  disabled = false,
  editing = false,
  onEnterEdit,
}: UseVariableAffordanceOptions): VariableAffordance {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const options = useVariableOptions(accept)
  const catalog = useVariableCatalog()

  const binding = mixed ? null : parseVarBinding(value)
  const bound = binding !== null
  // The chip's tooltip and the detach write both need the CURRENT value of
  // the bound variable. Read it from the full catalog, not the kind-filtered
  // one: a field can legitimately end up bound to a variable outside its own
  // accepted kinds (hand-written source, or a token whose value changed
  // kind), and refusing to name it there would show a chip that knows
  // nothing about what it is bound to.
  const boundOption = binding ? catalog.find((entry) => entry.name === binding.name) : undefined
  // Fall back to the binding's own `var(--x, FALLBACK)` argument when the
  // catalog has no entry — that fallback is, literally, the author's stated
  // value for the case where the variable is not defined.
  const resolvedBoundValue = boundOption?.resolvedValue ?? binding?.fallback

  const showChip = bound && !editing && binding !== null

  const chip = showChip ? (
    <span
      className={styles.chip}
      // A span, not a button: it lives inside `Input`'s leading slot and the
      // whole field is already the click target that enters edit mode. The
      // real, focusable controls are the trigger and the detach button.
      onMouseDown={(event) => {
        event.preventDefault()
        onEnterEdit?.()
        setOpen(true)
      }}
      title={resolvedBoundValue ?? binding.name}
      data-testid="variable-chip"
    >
      {boundOption?.kind === 'color' && resolvedBoundValue ? (
        <span
          className={styles.chipSwatch}
          style={{ '--variable-swatch': resolvedBoundValue } as CSSProperties}
          aria-hidden="true"
        />
      ) : null}
      <span className={styles.chipName}>{variableChipLabel(binding.name)}</span>
      {!disabled && resolvedBoundValue ? (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={styles.chipDetach}
          aria-label={`Detach variable ${variableChipLabel(binding.name)}`}
          tooltip="Detach variable"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => onCommit(resolvedBoundValue)}
        >
          <CloseIcon size={9} aria-hidden="true" />
        </Button>
      ) : null}
    </span>
  ) : null

  // Nothing to offer and nothing bound → render no affordance at all. An icon
  // that opens an empty list is exactly the control-that-lies this panel
  // refuses; a project with no custom properties simply has no variables.
  const hasAffordance = !disabled && (options.length > 0 || bound)

  const trigger = hasAffordance ? (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        className={styles.trigger}
        data-open={open ? 'true' : undefined}
        aria-label={bound ? `Change variable for ${fieldLabel}` : `Apply variable to ${fieldLabel}`}
        tooltip={bound ? 'Change variable' : 'Apply variable'}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="apply-variable-trigger"
      >
        <BracesIcon size={11} aria-hidden="true" />
      </Button>
      {open ? (
        <VariablePickerPopover
          anchorRef={triggerRef}
          id={fieldLabel}
          options={options}
          boundName={binding?.name}
          onPick={(option) => {
            setOpen(false)
            onCommit(formatVarBinding(option.name))
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  ) : null

  return {
    bound,
    displayValue: showChip ? '' : value,
    chip,
    trigger,
  }
}
