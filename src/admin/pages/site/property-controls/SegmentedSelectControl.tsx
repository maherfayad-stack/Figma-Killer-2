import type { ControlProps } from './shared'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ControlRow } from '@ui/components/ControlRow'

interface SegmentedOption {
  label: string
  value: unknown
}

interface SegmentedSelectControlProps extends ControlProps<unknown> {
  options: SegmentedOption[]
}

/**
 * A `select` control with `display: 'segmented'` — a component's variant axis
 * of a few members, drawn as one connected button group instead of a dropdown.
 * Same value contract as `SelectControl` (the matched option's own value is
 * written back), so the two are interchangeable behind `PropertyControlRenderer`.
 *
 * `SegmentedControl` keys segments by string; the option's original value is
 * recovered by matching on `String(value)`, exactly as `SelectControl` does for
 * its native `<option>`s.
 */
export function SegmentedSelectControl({
  propKey,
  value,
  onChange,
  label,
  options,
  isOverride,
  disabled,
  layout,
}: SegmentedSelectControlProps) {
  const current = value === undefined || value === null || value === '' ? undefined : String(value)
  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled={disabled}>
      <SegmentedControl
        aria-label={label ?? propKey}
        data-testid={`segmented-${propKey}`}
        value={current}
        options={options.map((option) => ({ value: String(option.value), label: option.label }))}
        disabled={disabled}
        fullWidth
        onChange={(next) => {
          const matched = options.find((option) => String(option.value) === next)
          onChange(propKey, matched !== undefined ? matched.value : next)
        }}
      />
    </ControlRow>
  )
}
