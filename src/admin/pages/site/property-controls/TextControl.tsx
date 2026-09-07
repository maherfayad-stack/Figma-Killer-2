import type { ReactNode } from 'react'
import type { ControlProps } from './shared'
import type { TextControlNormalize } from '@core/module-engine'
import { normalizeIdentifierInput, normalizeIdentifierValue } from '@core/utils/identifier'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { resolveCommitValue } from '@ui/components/ScrubInput'
import { handleNudgeKeydown } from './numericNudge'

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
   *   - commit coercion on blur: a bare number is given this unit and
   *     arithmetic is evaluated, through the same `resolveCommitValue` every
   *     other numeric field uses. Without it, typing `100/2` into a
   *     border-width row wrote the literal `100/2` and typing `50` wrote the
   *     invalid declaration `border-width: 50`.
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
  isOverride,
  disabled,
  layout,
  mixed,
}: TextControlProps) {
  function handleChange(nextValue: string) {
    onChange(propKey, normalize === 'identifier' ? normalizeIdentifierInput(nextValue) : nextValue)
  }

  function handleBlur(nextValue: string) {
    if (normalize === 'identifier') {
      const normalized = normalizeIdentifierValue(nextValue)
      if (normalized !== value) onChange(propKey, normalized)
      return
    }
    if (numericUnit === undefined) return
    const resolved = resolveCommitValue(nextValue, numericUnit)
    if (resolved !== nextValue) onChange(propKey, resolved)
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <Input
        id={`ctrl-${propKey}`}
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        mixed={mixed}
        disabled={disabled}
        prefix={prefix}
        aria-label={label ?? propKey}
        fieldSize="sm"
        autoCapitalize={normalize === 'identifier' ? 'none' : undefined}
        spellCheck={normalize === 'identifier' ? false : undefined}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={(e) => handleBlur(e.target.value)}
        onKeyDown={
          numericUnit !== undefined
            ? (e) => {
                if (e.key === 'Enter') {
                  // Figma: Enter commits and KEEPS focus, re-selecting the
                  // value so the next keystroke replaces it (§5.4).
                  e.preventDefault()
                  const input = e.currentTarget
                  handleBlur(input.value)
                  requestAnimationFrame(() => input.select())
                  return
                }
                handleNudgeKeydown(e, value ?? '', (next) => onChange(propKey, next), {
                  emptyUnit: numericUnit,
                })
              }
            : undefined
        }
      />
    </ControlRow>
  )
}
