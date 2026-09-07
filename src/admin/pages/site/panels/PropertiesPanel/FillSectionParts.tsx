/**
 * FillSectionParts — the Fill section's swatches and popover bodies.
 *
 * Split out of `FillSection.tsx` when G9's text-fill row landed and that file
 * reached the repo's 700-line module ceiling
 * (`module-size-budgets.test.ts`). `FillSection.tsx` decides which ROWS
 * exist; this file draws what opens when one is activated. The pure value
 * models both share are `fillModel.ts` (colour channels, gradient transforms)
 * and `backgroundLayers.ts` (the `background-image` layer stack and its
 * per-layer satellites).
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
import { SelectControl } from '@site/property-controls/SelectControl'
import { TextControl } from '@site/property-controls/TextControl'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { ClassPropertyRow } from './ClassPropertyRow'
import { hasStyleValue } from './styleValueUtils'
import { getEnumOptions } from './cssControlTypes'
import {
  BACKGROUND_SATELLITE_LABELS,
  BACKGROUND_SATELLITE_PROPS,
  BACKGROUND_SATELLITE_INITIALS,
  backgroundLayerSatellite,
  setBackgroundLayerSatellite,
  setBackgroundLayerImage,
  type BackgroundModel,
  type BackgroundSatelliteProp,
} from './backgroundLayers'
import {
  CONTENT_FIT_PROPS,
  DEFAULT_GRADIENT_FILL,
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
// One background layer's popover — the paint itself, then its satellites
// ---------------------------------------------------------------------------

interface BackgroundLayerPopoverBodyProps {
  model: BackgroundModel
  index: number
  /** Applies a whole `background-*` patch at once (see `FillSection`'s `applyPatch`). */
  onModelChange: (next: BackgroundModel) => void
  /** Raw edit of a satellite this module refused to split per layer. */
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

type ImageFillMode = 'gradient' | 'image'

export function BackgroundLayerPopoverBody({
  model,
  index,
  onModelChange,
  onChange,
}: BackgroundLayerPopoverBodyProps) {
  const value = model.spine.kind === 'layers' ? (model.spine.layers[index] ?? '') : ''
  const isUrl = isUrlImageValue(value)
  const parsed = !isUrl && value ? parseGradient(value) : null
  const mode: ImageFillMode | undefined = isUrl ? 'image' : parsed?.ok ? 'gradient' : undefined

  function setImage(next: string) {
    onModelChange(setBackgroundLayerImage(model, index, next))
  }

  function handleModeChange(next: ImageFillMode) {
    if (next === mode) return
    setImage(next === 'gradient' ? DEFAULT_GRADIENT_FILL : "url('')")
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
        <GradientEditor gradient={parsed.gradient} onChange={(next) => setImage(serializeGradient(next))} />
      )}

      {mode === 'image' && (
        <Input
          fieldSize="sm"
          value={extractUrlPayload(value)}
          placeholder="/images/hero.png"
          aria-label="Image URL"
          onChange={(e) => setImage(wrapUrlPayload(e.target.value))}
        />
      )}

      {mode === undefined && (
        <div className={styles.refusalNote}>
          <p className={styles.refusalText}>
            {isUrl
              ? "This isn't a plain image URL."
              : value === ''
                ? 'This layer is empty.'
                : (parseGradient(value) as { ok: false; reason: string }).reason}{' '}
            Shown as raw CSS below so nothing about it gets rewritten.
          </p>
          <Input
            fieldSize="sm"
            monospace
            value={value}
            aria-label="Background layer, raw CSS"
            onChange={(e) => setImage(e.target.value)}
          />
        </div>
      )}

      <div className={styles.sizingGroup}>
        <p className={styles.sizingHeading}>Layer</p>
        {BACKGROUND_SATELLITE_PROPS.map((prop) => (
          <LayerSatelliteRow
            key={prop}
            model={model}
            index={index}
            prop={prop}
            onModelChange={onModelChange}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One satellite for one layer. Three shapes, decided by
 * `backgroundLayerSatellite`:
 *
 *   - a normal per-layer control (select for the closed keyword sets, text for
 *     `size`/`position`, whose values are open-ended lengths);
 *   - the same control with a placeholder when the property is unset — the
 *     placeholder is the CSS initial, so the field never lies about what the
 *     browser is currently doing;
 *   - a WHOLE-property raw field when the stored value could not be split per
 *     layer (`backgroundLayers.ts`'s refusals), with the reason above it.
 *     Offering a per-layer control there would write a value that silently
 *     deletes part of the user's declaration.
 */
function LayerSatelliteRow({
  model,
  index,
  prop,
  onModelChange,
  onChange,
}: {
  model: BackgroundModel
  index: number
  prop: BackgroundSatelliteProp
  onModelChange: (next: BackgroundModel) => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}) {
  const view = backgroundLayerSatellite(model, prop, index)
  const name = BACKGROUND_SATELLITE_LABELS[prop]
  const propKey = `bg-layer-${index}-${prop}`

  if (view.kind === 'raw') {
    return (
      <div className={styles.refusalNote}>
        <p className={styles.refusalText}>
          {name}: {view.reason}
        </p>
        <Input
          fieldSize="sm"
          monospace
          value={view.raw}
          aria-label={`${name}, raw CSS`}
          onChange={(e) => onChange(prop, e.target.value || undefined)}
        />
      </div>
    )
  }

  // The declared list is shorter than the layer count, so CSS is repeating it —
  // this value is not this layer's alone, and editing it splits the list. Say
  // so in the label rather than letting the edit surprise the user.
  const label = view.kind === 'value' && view.shared ? `${name} (all layers)` : name
  const current = view.kind === 'value' ? view.value : ''
  // One keyword list per property, shared with the generic fallback row and
  // the style search. `backgroundSize`/`backgroundPosition` have none on
  // purpose — both take open-ended lengths (`cover`, `50% auto`, `12px 40%`),
  // so a select could only offer a fraction of what CSS accepts.
  const keywords = getEnumOptions(prop)

  function write(next: string) {
    onModelChange(setBackgroundLayerSatellite(model, prop, index, next || undefined))
  }

  if (keywords) {
    return (
      <SelectControl
        propKey={propKey}
        label={label}
        layout="inline"
        value={current}
        placeholder={BACKGROUND_SATELLITE_INITIALS[prop]}
        options={[
          { label: '—', value: '' },
          ...keywords.map((keyword) => ({ label: keyword, value: keyword })),
        ]}
        onChange={(_key, next) => write(String(next ?? ''))}
      />
    )
  }

  return (
    <TextControl
      propKey={propKey}
      label={label}
      layout="inline"
      value={current}
      placeholder={BACKGROUND_SATELLITE_INITIALS[prop]}
      onChange={(_key, next) => write(next)}
    />
  )
}

// ---------------------------------------------------------------------------
// Orphan satellites — set, but with no `background-image` layer to apply to
// ---------------------------------------------------------------------------

/**
 * The per-layer satellites with no layer ROW to live in — either the element
 * has no `background-image` at all (`background-size: cover` on its own is
 * inert CSS, but it IS in the user's file and must never become invisible in
 * the inspector), or the layer list itself was refused and there is no index
 * to hang them off. Either way each one edits as its own whole declaration,
 * which is the only write this module can make honestly here.
 */
export function OrphanSatellitesBody({
  hasRefusedLayers,
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: {
  hasRefusedLayers: boolean
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}) {
  return (
    <div className={styles.popoverBody}>
      <p className={styles.refusalText}>
        {hasRefusedLayers
          ? 'The background-image above is edited as raw text, so these cannot be split per layer. Each one edits as a whole declaration.'
          : 'These size and place a background image, but this element has none — CSS ignores them until a background-image layer exists.'}
      </p>
      {BACKGROUND_SATELLITE_PROPS.filter((prop) => hasStyleValue(storedStyles[prop])).map((prop) => (
        <ClassPropertyRow
          key={`${activeTab}-${prop}`}
          property={prop}
          value={storedStyles[prop] as string | number}
          isSet
          layout="stacked"
          onChange={onChange}
          onRemove={(property) => onChange(property, undefined)}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          placeholder={currentStyles[prop] as string | undefined}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content fit — the element's OWN replaced content, not a background layer
// ---------------------------------------------------------------------------

export function ContentFitPopoverBody({
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}) {
  return (
    <div className={styles.popoverBody}>
      <p className={styles.refusalText}>
        How this element&rsquo;s own content (an <code>&lt;img&gt;</code>&rsquo;s picture, a{' '}
        <code>&lt;video&gt;</code>&rsquo;s frame) fills its box. Nothing to do with the background
        layers above.
      </p>
      {CONTENT_FIT_PROPS.map((prop) => {
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
// Raw escape hatches — the `background` shorthand, and a refused layer list
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

/**
 * The `background-image` list itself refused a per-layer split. The whole
 * declaration stays as one text field with the reason above it — never a
 * partial parse, never a guessed layer count.
 */
export function BackgroundImageRawBody({
  value,
  reason,
  onChange,
}: {
  value: string
  reason: string
  onChange: (value: string) => void
}) {
  return (
    <div className={styles.refusalNote}>
      <p className={styles.refusalText}>{reason}</p>
      <Input
        fieldSize="sm"
        monospace
        value={value}
        aria-label="background-image, raw CSS"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
