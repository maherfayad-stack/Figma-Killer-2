import type { ControlProps } from './shared'
import { Textarea } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'

interface TextareaControlProps extends ControlProps<string> {
  rows?: number
  placeholder?: string
}

export function TextareaControl({
  propKey,
  value,
  onChange,
  label,
  rows = 3,
  placeholder,
  isOverride,
  disabled,
  layout,
}: TextareaControlProps) {
  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      {/* `autoGrow` — an inspector row is as tall as its value, not as tall
          as the schema's `rows`, which becomes the ceiling. A module's own
          `text` prop holding one short line used to reserve four lines of
          the Design tab's height budget (`docs/features/inspector.md` §6). */}
      <Textarea
        id={`ctrl-${propKey}`}
        value={value ?? ''}
        rows={rows}
        autoGrow
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(propKey, e.target.value)}
      />
    </ControlRow>
  )
}
