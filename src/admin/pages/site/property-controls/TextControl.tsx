import type { ControlProps } from './shared'
import type { TextControlNormalize } from '@core/module-engine'
import { normalizeIdentifierInput, normalizeIdentifierValue } from '@core/utils/identifier'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { handleNudgeKeydown } from './numericNudge'

interface TextControlProps extends ControlProps<string> {
  placeholder?: string
  normalize?: TextControlNormalize
  /**
   * When set, the field supports arrow-key nudging of its numeric value
   * (±1 / ±8 Shift / ±0.1 Alt), and an empty field starts from `0` with
   * this unit (e.g. `'px'`). Omit for non-numeric text props (the default),
   * which leaves arrow keys as plain caret movement.
   */
  nudgeEmptyUnit?: string
}

export function TextControl({
  propKey,
  value,
  onChange,
  label,
  placeholder,
  normalize,
  nudgeEmptyUnit,
  isOverride,
  disabled,
  layout,
}: TextControlProps) {
  function handleChange(nextValue: string) {
    onChange(propKey, normalize === 'identifier' ? normalizeIdentifierInput(nextValue) : nextValue)
  }

  function handleBlur(nextValue: string) {
    if (normalize !== 'identifier') return
    const normalized = normalizeIdentifierValue(nextValue)
    if (normalized !== value) onChange(propKey, normalized)
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
        disabled={disabled}
        fieldSize="sm"
        autoCapitalize={normalize === 'identifier' ? 'none' : undefined}
        spellCheck={normalize === 'identifier' ? false : undefined}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={(e) => handleBlur(e.target.value)}
        onKeyDown={
          nudgeEmptyUnit !== undefined
            ? (e) => handleNudgeKeydown(e, value ?? '', (next) => onChange(propKey, next), { emptyUnit: nudgeEmptyUnit })
            : undefined
        }
      />
    </ControlRow>
  )
}
