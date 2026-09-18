/**
 * GradientEditor — a gradient layer's type, direction and stop list (F15).
 *
 * Split out of `FillSectionParts.tsx` for `module-size-budgets.test.ts` when
 * the Mixed contract (`docs/features/inspector.md` §9.3) pushed that file
 * past 700 lines. It is a leaf: it edits a `ParsedGradient` and hands the next
 * one back, and every transform it calls lives in `fillModel.ts` — nothing
 * here knows about the background-layer stack it is being edited inside.
 */
import { Button } from '@ui/components/Button'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import {
  angleFieldValue,
  parsePercentText,
  withAddedStop,
  withAngleText,
  withKind,
  withRemovedStop,
  withStop,
} from '../../panels/PropertiesPanel/fillModel'
import type { ParsedGradient } from '../../panels/PropertiesPanel/gradientValue'
import styles from './FillSection.module.css'

export function GradientEditor({
  gradient,
  onChange,
}: {
  gradient: ParsedGradient
  onChange: (next: ParsedGradient) => void
}) {
  return (
    <div className={styles.gradientEditor}>
      <SegmentedControl<'linear' | 'radial'>
        value={gradient.kind}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Radial' },
        ]}
        onChange={(kind) => onChange(withKind(gradient, kind))}
        fullWidth
        size="sm"
        aria-label="Gradient type"
      />

      {gradient.kind === 'linear' && (
        <ScrubInput
          aria-label="Gradient angle"
          label={<span aria-hidden="true">°</span>}
          value={angleFieldValue(gradient)}
          unit="deg"
          onChange={(next) => onChange(withAngleText(gradient, next))}
        />
      )}

      <div className={styles.stopsList}>
        {gradient.stops.map((stop, index) => (
          <div key={index} className={styles.stopRow}>
            <ColorValueInput
              value={stop.color}
              ariaLabel={`Stop ${index + 1} colour`}
              swatchLabel={`Stop ${index + 1} colour swatch`}
              onChange={(next) => onChange(withStop(gradient, index, { color: next }))}
            />
            <ScrubInput
              aria-label={`Stop ${index + 1} position`}
              label={<span aria-hidden="true">%</span>}
              value={stop.position != null ? `${stop.position}%` : undefined}
              placeholder="Auto"
              unit="%"
              className={styles.stopPosition}
              onChange={(next) => onChange(withStop(gradient, index, { position: parsePercentText(next) }))}
            />
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              tone="danger"
              aria-label={`Remove stop ${index + 1}`}
              tooltip="Remove stop"
              disabled={gradient.stops.length <= 2}
              onClick={() => onChange(withRemovedStop(gradient, index))}
            >
              <MinusIcon size={12} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>

      <Button variant="secondary" size="xs" onClick={() => onChange(withAddedStop(gradient))}>
        <PlusIcon size={12} aria-hidden="true" />
        Add stop
      </Button>
    </div>
  )
}
