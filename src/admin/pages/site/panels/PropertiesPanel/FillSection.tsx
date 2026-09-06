/**
 * FillSection — Figma's Fill list (docs/features/inspector-disclosure.md §4 G6,
 * F13/F14/F15), replacing the old always-on 6-entry `BackgroundSection` grid.
 *
 * THE CSS MODEL, AND WHERE IT DIVERGES FROM FIGMA'S
 * ---------------------------------------------------
 * Figma's Fill list is a stack of arbitrarily many paint layers. CSS gives
 * this element exactly two channels that can hold a "fill": `backgroundColor`
 * (one paint, below everything) and `backgroundImage` (one image/gradient
 * layer — `background-image` technically supports comma-separated layers,
 * but `gradientValue.ts` deliberately refuses multi-layer values rather than
 * build a stacked editor for a feature nobody asked for yet). So this section
 * shows AT MOST three rows:
 *
 *   1. **Solid fill** — `backgroundColor`, when set.
 *   2. **Image/gradient fill** — `backgroundImage`, when it holds something
 *      other than `none`, OR when its five satellite properties
 *      (`backgroundSize`/`backgroundRepeat`/`backgroundPosition`/`objectFit`/
 *      `objectPosition`) have been set even without an image (a bare `<img>`
 *      using `objectFit` on its own natural content). Those five live ONLY
 *      inside this entry's own popover — they are properties of the image
 *      fill, and drawing five rows for an element with no image was the
 *      exact defect this plan exists to remove.
 *   3. **The `background` shorthand escape hatch** — read-only, shown ONLY
 *      when the shorthand itself has a value. Decomposing an arbitrary
 *      shorthand into color/image/size/repeat/position safely is a much
 *      bigger, riskier parse than a single gradient function (multiple
 *      comma-separated layers, order-dependent slash syntax, etc.), so this
 *      row never attempts it — it stays whatever the user's source says,
 *      editable only as raw CSS via its own popover (see
 *      `ShorthandEscapeHatchBody` below). This mirrors the gradient
 *      parser's own refusal rule: an editor that LOOKS structured but
 *      quietly loses information is worse than an honest raw field.
 *
 * The `+`/eye-less list contract comes from `@ui/components/PropertyList` —
 * see that module's doc for Law 1 (empty ⇒ renders nothing) and why the
 * visibility eye is never passed here (CSS has no "disabled declaration";
 * plan §8 decision 1).
 *
 * `FillSectionActions` is this section's HEADER content — the "add solid
 * fill" / "add gradient fill" buttons that live in `Section`'s `actions`
 * slot (both in the Law-1 empty-header state and once the section has
 * content), exactly like `AppearanceSectionActions`. It is exported
 * separately because the header and the body are siblings rendered by
 * `StyleSectionsEditor`, not parent/child.
 *
 * OUT OF SCOPE FOR THIS PASS (see the work order and STATE.md)
 * ---------------------------------------------------------------
 *   - The real colour-picker primitive (saturation/hue/alpha square, model
 *     select, eyedropper, "on this page" recents) — another agent owns
 *     `ColorValueInput`'s internals concurrently. This section codes against
 *     `ColorValueInput`'s EXISTING call shape and inherits the upgrade.
 *   - Selection colours for a multi-node selection (plan §4 G6.4) — needs
 *     store-side multi-select style editing that doesn't exist yet.
 *   - Image fill via the media library. The image-mode editor here is a
 *     plain URL text field, not `MediaLibraryControl`'s picker/thumbnail
 *     grid — a deliberate scope cut given this work order's effort budget;
 *     follow-up noted in STATE.md.
 */
import { useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { cn } from '@ui/cn'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { ClassPropertyRow } from './ClassPropertyRow'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { readString, hasStyleValue } from './styleValueUtils'
import {
  parseGradient,
  serializeGradient,
  isUrlImageValue,
  extractUrlPayload,
  wrapUrlPayload,
  type ParsedGradient,
  type GradientStop,
} from './gradientValue'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './FillSection.module.css'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** `background-image: none` and `''` both mean "no image" — `hasStyleValue` alone can't tell, since `'none'` is itself a non-empty string. */
function isBackgroundImageSet(value: string | undefined): boolean {
  return hasStyleValue(value) && value!.trim().toLowerCase() !== 'none'
}

const IMAGE_SATELLITE_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'backgroundSize',
  'backgroundRepeat',
  'backgroundPosition',
  'objectFit',
  'objectPosition',
]

const DEFAULT_SOLID_FILL = '#000000'
const DEFAULT_GRADIENT_FILL = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)'

function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      className={styles.swatch}
      style={{ '--fill-swatch-color': color } as CSSProperties}
      aria-hidden="true"
    />
  )
}

function ImageSwatch({ image }: { image: string }) {
  return (
    <span
      className={cn(styles.swatch, styles.swatchImage)}
      style={{ '--fill-swatch-image': image } as CSSProperties}
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------------------
// FillSectionActions — the header's "+" buttons (Law 1 empty state AND the
// populated-section header — see module doc). Mirrors AppearanceSectionActions.
// ---------------------------------------------------------------------------

interface FillSectionActionsProps {
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function FillSectionActions({ storedStyles, onChange }: FillSectionActionsProps) {
  const colorSet = hasStyleValue(readString(storedStyles, 'backgroundColor'))
  const imageValue = readString(storedStyles, 'backgroundImage')
  const imageSet = isBackgroundImageSet(imageValue)

  // Unlike Figma, CSS gives this element exactly one solid-fill channel and
  // one image-fill channel — once both are in use there is nothing left to
  // add (see the module doc's "THE CSS MODEL" section).
  if (colorSet && imageSet) return null

  return (
    <>
      {!colorSet && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add solid color fill"
          tooltip="Add solid color fill"
          data-testid="fill-section-add-color"
          onClick={() => onChange('backgroundColor', DEFAULT_SOLID_FILL)}
        >
          <PlusIcon size={12} aria-hidden="true" />
        </Button>
      )}
      {!imageSet && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add gradient fill"
          tooltip="Add gradient fill"
          data-testid="fill-section-add-image"
          onClick={() => onChange('backgroundImage', DEFAULT_GRADIENT_FILL)}
        >
          <Image2SolidIcon size={12} aria-hidden="true" />
        </Button>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// FillSection — the body
// ---------------------------------------------------------------------------

type FillEntryKind = 'color' | 'image' | 'shorthand'
interface FillEntryData {
  kind: FillEntryKind
}

interface FillSectionProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /**
   * Accepted for call-site compatibility with the temporary `BackgroundSection`
   * re-export (see that file) and every other curated section's shape — not
   * consumed here. `PropertyList`'s "remove" clears via `onChange(prop,
   * undefined)` uniformly (the image entry clears six properties in one
   * gesture, which `onRemove`'s single-property signature can't express), so
   * this section never needs the separate clear-one-property callback.
   */
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /**
   * Accepted for call-site compatibility with the temporary `BackgroundSection`
   * re-export (see that file) — not consumed here. `ClassPropertyRow`'s F1
   * provenance strip has no natural home in a `PropertyList` row (a struck-
   * through "shadowed declaration" list needs its own space this compact row
   * doesn't have); it stays available to the Sizing sub-rows' fallback, which
   * don't receive it either today, matching every other `PropertyList`-based
   * section planned after this one.
   */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

type OpenPopover = { kind: FillEntryKind; anchorRef: RefObject<HTMLElement | null> } | null

export function FillSection({
  storedStyles,
  currentStyles,
  visibleProperties,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: FillSectionProps) {
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null)
  const visible = new Set(visibleProperties)

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  // ---- entry presence -------------------------------------------------
  const colorValue = readString(storedStyles, 'backgroundColor')
  const showColorEntry = visible.has('backgroundColor') && hasStyleValue(colorValue)

  const imageValue = readString(storedStyles, 'backgroundImage')
  const imageIsSet = isBackgroundImageSet(imageValue)
  const satelliteIsSet = IMAGE_SATELLITE_PROPS.some((prop) => hasStyleValue(storedStyles[prop]))
  const imageEntryVisible =
    visible.has('backgroundImage') || IMAGE_SATELLITE_PROPS.some((prop) => visible.has(prop))
  const showImageEntry = imageEntryVisible && (imageIsSet || satelliteIsSet)

  const shorthandValue = readString(storedStyles, 'background')
  const showShorthandEntry = visible.has('background') && hasStyleValue(shorthandValue)

  // ---- entries ----------------------------------------------------------
  const entries: PropertyListEntry<FillEntryData>[] = []

  if (showColorEntry) {
    entries.push({
      id: 'fill-color',
      label: 'Solid fill',
      leading: <ColorSwatch color={colorValue!} />,
      summary: colorValue,
      data: { kind: 'color' },
    })
  }

  if (showImageEntry) {
    const described = describeImageEntry(imageValue, imageIsSet)
    entries.push({
      id: 'fill-image',
      label: described.label,
      leading: described.leading,
      summary: described.summary,
      value: described.value,
      data: { kind: 'image' },
    })
  }

  if (showShorthandEntry) {
    entries.push({
      id: 'fill-shorthand',
      label: 'Background shorthand',
      leading: <CodeIcon size={14} aria-hidden="true" />,
      summary: shorthandValue,
      data: { kind: 'shorthand' },
    })
  }

  function handleActivate(entry: PropertyListEntry<FillEntryData>, anchorRef: RefObject<HTMLElement | null>) {
    setOpenPopover({ kind: entry.data.kind, anchorRef })
  }

  function handleRemove(entry: PropertyListEntry<FillEntryData>) {
    if (entry.data.kind === 'color') {
      onChange('backgroundColor', undefined)
    } else if (entry.data.kind === 'image') {
      // The row represents the WHOLE image-fill configuration — clearing
      // only `backgroundImage` while leaving `objectFit` set would leave the
      // entry's own presence condition true and the row would refuse to
      // disappear after "removing" it.
      onChange('backgroundImage', undefined)
      for (const prop of IMAGE_SATELLITE_PROPS) onChange(prop, undefined)
    } else {
      onChange('background', undefined)
    }
    if (openPopover?.kind === entry.data.kind) setOpenPopover(null)
  }

  function closePopover() {
    setOpenPopover(null)
  }

  return (
    <div className={styles.fillSection}>
      <PropertyList
        listLabel="Fill"
        entries={entries}
        onActivate={handleActivate}
        onRemove={handleRemove}
      />

      {openPopover?.kind === 'color' && (
        <InspectorPopover id="fill-color" anchorRef={openPopover.anchorRef} onClose={closePopover} title="Solid fill">
          <ColorValueInput
            value={colorValue ?? ''}
            ariaLabel="Solid fill colour"
            swatchLabel="Solid fill colour swatch"
            onChange={(next) => onChange('backgroundColor', next || undefined)}
            onPreview={previewProperty ? (next) => previewProperty('backgroundColor', next) : undefined}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}

      {openPopover?.kind === 'image' && (
        <InspectorPopover id="fill-image" anchorRef={openPopover.anchorRef} onClose={closePopover} title="Image fill" width={264}>
          <ImageFillPopoverBody
            imageValue={imageValue}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}

      {openPopover?.kind === 'shorthand' && (
        <InspectorPopover
          id="fill-shorthand"
          anchorRef={openPopover.anchorRef}
          onClose={closePopover}
          title="Background (raw CSS)"
        >
          <ShorthandEscapeHatchBody
            value={shorthandValue}
            onChange={(next) => onChange('background', next || undefined)}
          />
        </InspectorPopover>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image-entry summary
// ---------------------------------------------------------------------------

function describeImageEntry(
  imageValue: string | undefined,
  imageIsSet: boolean,
): { label: string; summary: ReactNode; value?: ReactNode; leading: ReactNode } {
  if (!imageIsSet) {
    return {
      label: 'Object fit',
      summary: 'Object fit',
      leading: <Image2SolidIcon size={14} aria-hidden="true" />,
    }
  }

  if (isUrlImageValue(imageValue!)) {
    return {
      label: 'Image fill',
      summary: extractUrlPayload(imageValue!) || 'Image',
      leading: <ImageSwatch image={imageValue!} />,
    }
  }

  const parsed = parseGradient(imageValue!)
  if (parsed.ok) {
    const kindLabel = parsed.gradient.kind === 'linear' ? 'Linear gradient' : 'Radial gradient'
    return {
      label: `${kindLabel} fill`,
      summary: kindLabel,
      value: `${parsed.gradient.stops.length} stops`,
      leading: <ImageSwatch image={imageValue!} />,
    }
  }

  return {
    label: 'Image fill',
    summary: 'Custom (raw CSS)',
    leading: <CodeIcon size={14} aria-hidden="true" />,
  }
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

function ImageFillPopoverBody({
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

const DIRECTION_DEGREES: ReadonlyMap<string, number> = new Map([
  ['to top', 0],
  ['to top right', 45],
  ['to right', 90],
  ['to bottom right', 135],
  ['to bottom', 180],
  ['to bottom left', 225],
  ['to left', 270],
  ['to top left', 315],
])

const ANGLE_TEXT_RE = /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)?$/i

function angleFieldValue(gradient: ParsedGradient): string {
  if (gradient.direction?.kind === 'angle') return gradient.direction.raw
  if (gradient.direction?.kind === 'keyword') return `${DIRECTION_DEGREES.get(gradient.direction.keyword) ?? 180}deg`
  return '180deg'
}

function withAngleText(gradient: ParsedGradient, text: string): ParsedGradient {
  const match = ANGLE_TEXT_RE.exec(text.trim())
  if (!match) return gradient
  const unit = (match[2]?.toLowerCase() ?? 'deg') as 'deg' | 'grad' | 'rad' | 'turn'
  const raw = match[2] ? text.trim() : `${match[1]}deg`
  return { ...gradient, direction: { kind: 'angle', raw, value: Number(match[1]), unit } }
}

function withKind(gradient: ParsedGradient, kind: 'linear' | 'radial'): ParsedGradient {
  if (kind === gradient.kind) return gradient
  if (kind === 'radial') return { kind: 'radial', stops: gradient.stops }
  return { kind: 'linear', stops: gradient.stops }
}

function withStop(gradient: ParsedGradient, index: number, patch: Partial<GradientStop>): ParsedGradient {
  const stops = gradient.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop))
  return { ...gradient, stops }
}

function withAddedStop(gradient: ParsedGradient): ParsedGradient {
  const last = gradient.stops[gradient.stops.length - 1]
  return { ...gradient, stops: [...gradient.stops, { color: last?.color ?? '#ffffff', position: undefined }] }
}

function withRemovedStop(gradient: ParsedGradient, index: number): ParsedGradient {
  return { ...gradient, stops: gradient.stops.filter((_, i) => i !== index) }
}

function parsePercentText(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(-?\d+(?:\.\d+)?)%?$/.exec(trimmed)
  return match ? Number(match[1]) : undefined
}

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
          step={1}
          shiftStep={15}
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
              step={1}
              shiftStep={10}
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

function ShorthandEscapeHatchBody({ value, onChange }: ShorthandEscapeHatchBodyProps) {
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
