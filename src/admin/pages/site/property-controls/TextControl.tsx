/**
 * TextControl — a one-line text prop or style value.
 *
 * Draft, then commit (P2-G, UX-16): typing edits a local draft and writes
 * nothing; blur or Enter commits it once; Escape restores the value the field
 * held before and writes nothing. It used to write on every keystroke — for a
 * component prop, one source edit to the call site per character — and Escape
 * had nothing to go back to. `textFieldDraft.ts` holds the commit rule and
 * its reasons.
 */
import type { ReactNode } from 'react'
import type { ControlProps } from './shared'
import type { TextControlNormalize } from '@core/module-engine'
import { normalizeIdentifierInput, normalizeIdentifierValue } from '@core/utils/identifier'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { resolveCommitValue } from '@ui/components/ScrubInput'
import { useVariableAffordance, type VariableKind } from '@ui/components/VariableField'
import { handleNudgeKeydown } from './numericNudge'
import { useTextFieldDraft } from './textFieldDraft'
import styles from './TextControl.module.css'

/** A field that declares no variable kinds gets no variable affordance at all. */
const NO_VARIABLE_KINDS: readonly VariableKind[] = []

interface TextControlProps extends ControlProps<string> {
  placeholder?: string
  normalize?: TextControlNormalize
  /**
   * Marks the field as holding a SINGLE NUMBER in this unit — the §5 field
   * model, minus the drag gesture (this control draws no mark to drag).
   * Setting it turns on both halves at once:
   *
   *   - arrow-key nudging (±1 / ±10 Shift / ±0.1 Alt), with an empty field
   *     starting from `0` in this unit;
   *   - commit coercion: a bare number is given this unit and arithmetic is
   *     evaluated, through the same `resolveCommitValue` every other numeric
   *     field uses. Without it, typing `100/2` into a border-width row wrote
   *     the literal `100/2` and typing `50` wrote the invalid declaration
   *     `border-width: 50`.
   *
   * Pass `''` for a genuinely unitless number (`opacity`, `zIndex`) so a bare
   * number stays bare. Omit for non-numeric text props (the default), which
   * leaves arrow keys as plain caret movement and commits the literal.
   */
  numericUnit?: string
  /**
   * Mark rendered inside the field's leading edge, standing in for the label
   * — the inspector's way of naming a value without spending a row on it.
   * When set, the caller is expected to pass `layout="bare"` so the label is
   * not drawn twice; the label text still reaches assistive tech through the
   * input's `aria-label`.
   */
  prefix?: ReactNode
  /**
   * The kinds of project variable this field can take. Setting it adds the
   * "Apply variable" / "Create variable from this value" affordance (the
   * trailing hexagon button); omitted, the field is a plain text box. The
   * field keeps showing a bound value as its `var(--x)` text - the button is
   * where a binding is changed or detached.
   */
  variableKinds?: readonly VariableKind[]
}

export function TextControl({
  propKey,
  value,
  onChange,
  label,
  placeholder,
  normalize,
  numericUnit,
  prefix,
  variableKinds,
  isOverride,
  disabled,
  layout,
  mixed = false,
}: TextControlProps) {
  function resolve(raw: string): string {
    if (normalize === 'identifier') return normalizeIdentifierValue(raw)
    if (numericUnit !== undefined) return resolveCommitValue(raw, numericUnit)
    return raw
  }

  const field = useTextFieldDraft({
    value: value ?? '',
    mixed,
    resolve,
    normalizeInput: normalize === 'identifier' ? normalizeIdentifierInput : undefined,
    onCommit: (next) => onChange(propKey, next),
  })

  const variable = useVariableAffordance({
    value: variableKinds ? value : undefined,
    accept: variableKinds ?? NO_VARIABLE_KINDS,
    onCommit: (next) => onChange(propKey, next),
    fieldLabel: label ?? propKey,
    mixed,
    disabled,
  })

  const input = (
    <Input
      id={`ctrl-${propKey}`}
      type="text"
      value={field.draft}
      placeholder={placeholder}
      mixed={mixed}
      disabled={disabled}
      prefix={prefix}
      aria-label={label ?? propKey}
      fieldSize="sm"
      autoCapitalize={normalize === 'identifier' ? 'none' : undefined}
      spellCheck={normalize === 'identifier' ? false : undefined}
      onChange={(e) => field.onChange(e.target.value)}
      onBlur={(e) => field.onBlur(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Figma: Enter commits and KEEPS focus, re-selecting the value so
          // the next keystroke replaces it (§5.4).
          e.preventDefault()
          const input = e.currentTarget
          field.commit(input.value)
          requestAnimationFrame(() => input.select())
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          field.revert()
          e.currentTarget.blur()
          return
        }
        if (numericUnit !== undefined) {
          handleNudgeKeydown(e, field.draft, field.applyImmediately, { emptyUnit: numericUnit })
        }
      }}
    />
  )

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      {variableKinds ? (
        <div className={styles.variableHost} data-variable-host="">
          {input}
          {variable.trigger}
        </div>
      ) : (
        input
      )}
    </ControlRow>
  )
}
