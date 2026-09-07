/**
 * FillSectionParts — the Fill section's swatches and popover bodies.
 *
 * Split out of `FillSection.tsx` when G9's text-fill row landed and that file
 * reached the repo's 700-line module ceiling
 * (`module-size-budgets.test.ts`). `FillSection.tsx` decides which ROWS
 * exist; this file draws what opens when one is activated. The pure value
 * model both share is `fillModel.ts`.
 *
 * Components only — `react-refresh/only-export-components` is on for `src/`,
 * which is also why the transforms these editors call live in `fillModel.ts`
 * rather than beside them here.
 */
import { type CSSProperties } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { ClassPropertyRow } from './ClassPropertyRow'
import { hasStyleValue } from './styleValueUtils'
import {
  DEFAULT_GRADIENT_FILL,
  IMAGE_SATELLITE_PROPS,
  angleFieldValue,
  parsePercentText,
  withAddedStop,
  withAngleText,
  withKind,
  withRemovedStop,
  withStop,
} from './fillModel'
import {
  parseGradient,
  serializeGradient,
  isUrlImageValue,
  extractUrlPayload,
  wrapUrlPayload,
  type ParsedGradient,
} from './gradientValue'
import styles from './FillSection.module.css'

// ---------------------------------------------------------------------------
// Swatches
// ---------------------------------------------------------------------------

export function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      className={styles.swatch}
      style={{ '--fill-swatch-color': color } as CSSProperties}
      aria-hidden="true"
    />
  )
}

export function ImageSwatch({ image }: { image: string }) {
  return (
    <span
      className={cn(styles.swatch, styles.swatchImage)}
      style={{ '--fill-swatch-image': image } as CSSProperties}
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------------------
// Image fill popover body — mode toggle + gradient/URL editor + sizing rows
// ---------------------------------------------------------------------------

interface ImageFillPopoverBodyProps {
  imageValue: string | undefined
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

type ImageFillMode = 'gradient' | 'image'

export function ImageFillPopoverBody({
  imageValue,
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: ImageFillPopoverBodyProps) {
  const value = imageValue ?? ''
  const isUrl = isUrlImageValue(value)
  const parsed = !isUrl && value ? parseGradient(value) : null

  const mode: ImageFillMode | undefined = isUrl ? 'image' : parsed?.ok ? 'gradient' : undefined

  function handleModeChange(next: ImageFillMode) {
    if (next === mode) return
    onChange('backgroundImage', next === 'gradient' ? DEFAULT_GRADIENT_FILL : '')
  }

  return (
    <div className={styles.popoverBody}>
      {mode !== undefined && (
        <SegmentedControl<ImageFillMode>
          value={mode}
          options={[
            { value: 'gradient', label: 'Gradient' },
            { value: 'image', label: 'Image URL' },
          ]}
          onChange={handleModeChange}
          fullWidth
          size="sm"
          aria-label="Image fill type"
        />
      )}

      {mode === 'gradient' && parsed?.ok && (
        <GradientEditor gradient={parsed.gradient} onChange={(next) => onChange('backgroundImage', serializeGradient(next))} />
      )}

      {mode === 'image' && (
        <Input
          fieldSize="sm"
          value={extractUrlPayload(value)}
          placeholder="/images/hero.png"
          aria-label="Image URL"
          onChange={(e) => onChange('backgroundImage', wrapUrlPayload(e.target.value))}
        />
      )}

      {mode === undefined && value !== '' && (
        <div className={styles.refusalNote}>
          <p className={styles.refusalText}>
            {isUrl
              ? "This isn't a plain image URL."
              : (parseGradient(value) as { ok: false; reason: string }).reason}{' '}
            Shown as raw CSS below so nothing about it gets rewritten.
          </p>
          <Input
            fieldSize="sm"
            monospace
            value={value}
            aria-label="Background image, raw CSS"
            onChange={(e) => onChange('backgroundImage', e.target.value)}
          />
        </div>
      )}

      {mode === undefined && value === '' && (
        <p className={styles.refusalText}>
          Object fit applies to this element&rsquo;s own content (an <code>&lt;img&gt;</code>&rsquo;s
          picture) — it has no image fill of its own.
        </p>
      )}

      <div className={styles.sizingGroup}>
        <p className={styles.sizingHeading}>Sizing</p>
        {IMAGE_SATELLITE_PROPS.map((prop) => {
          const storedValue = storedStyles[prop]
          const isSet = hasStyleValue(storedValue)
          return (
            <ClassPropertyRow
              key={`${activeTab}-${String(prop)}`}
              property={prop}
              value={isSet ? (storedValue as string | number) : undefined}
              placeholder={isSet ? undefined : (currentStyles[prop] as string | undefined)}
              isSet={isSet}
              layout="stacked"
              onChange={onChange}
              onRemove={(property) => onChange(property, undefined)}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gradient editor — type + direction/shape + stops list (F15)
// ---------------------------------------------------------------------------

interface GradientEditorProps {
  gradient: ParsedGradient
  onChange: (next: ParsedGradient) => void
}

function GradientEditor({ gradient, onChange }: GradientEditorProps) {
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

// ---------------------------------------------------------------------------
// Shorthand escape hatch — read-only row, honestly-editable popover
// ---------------------------------------------------------------------------

interface ShorthandEscapeHatchBodyProps {
  value: string | undefined
  onChange: (value: string) => void
}

export function ShorthandEscapeHatchBody({ value, onChange }: ShorthandEscapeHatchBodyProps) {
  return (
    <div className={styles.refusalNote}>
      <p className={styles.refusalText}>
        This element uses the <code>background</code> shorthand, which can combine colour, image,
        position, size and repeat in one declaration. Splitting it into separate Fill rows risks
        silently dropping part of it, so it stays here as raw CSS instead of a lookalike editor.
      </p>
      <Input
        fieldSize="sm"
        monospace
        value={value ?? ''}
        aria-label="background, raw CSS"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
