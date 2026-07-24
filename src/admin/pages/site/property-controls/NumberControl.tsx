import type { ControlProps } from './shared'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'
import { nudgeNumber } from './numericNudge'

interface NumberControlProps extends ControlProps<number> {
  min?: number
  max?: number
  step?: number
  unit?: string
}

export function NumberControl({
  propKey,
  value,
  onChange,
  label,
  min,
  max,
  step = 1,
  unit,
  isOverride,
  disabled,
  layout,
}: NumberControlProps) {
  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={unit ? <span className={controlRowStyles.labelUnit}>{unit}</span> : undefined}
    >
      <Input
        id={`ctrl-${propKey}`}
        type="number"
        value={value ?? 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        fieldSize="sm"
        onChange={(e) => {
          const v = e.target.valueAsNumber
          if (!isNaN(v)) onChange(propKey, v)
        }}
        onKeyDown={(e) => {
          // Keyboard nudge, scaled to the field's own step so fractional
          // controls (e.g. opacity, step 0.1) stay sane: plain = step,
          // Shift = step×8 (the big nudge), Alt = step×0.1 (fine). For the
          // canonical step-1 length field this is exactly 1 / 8 / 0.1.
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          const mult = e.altKey ? 0.1 : e.shiftKey ? 8 : 1
          const next = nudgeNumber(value ?? 0, e.key === 'ArrowUp' ? 'up' : 'down', step * mult, {
            min,
            max,
          })
          onChange(propKey, next)
        }}
      />
    </ControlRow>
  )
}
