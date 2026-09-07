/**
 * FillSection — Figma's Fill list (docs/features/inspector-disclosure.md §4 G6,
 * F13/F14/F15), replacing the old always-on 6-entry `BackgroundSection` grid.
 *
 * THE CSS MODEL, AND WHERE IT DIVERGES FROM FIGMA'S
 * ---------------------------------------------------
 * Figma's Fill list is a stack of arbitrarily many paint layers. CSS gives
 * this element three channels that can hold a "fill": `color` (the text
 * paint), `backgroundColor` (one paint, below everything) and
 * `backgroundImage` (one image/gradient layer — `background-image`
 * technically supports comma-separated layers, but `gradientValue.ts`
 * deliberately refuses multi-layer values rather than build a stacked editor
 * for a feature nobody asked for yet). So this section shows AT MOST four
 * rows:
 *
 *   1. **Text** — `color`. Figma shows a text node's colour in Fill, because
 *      that is what it is; G9's target shape moved it out of Typography once
 *      this section existed to receive it. It sits first because it is the
 *      topmost paint: text renders over the box's own background.
 *   2. **Solid fill** — `backgroundColor`, when set.
 *   3. **Image/gradient fill** — `backgroundImage`, when it holds something
 *      other than `none`, OR when its five satellite properties
 *      (`backgroundSize`/`backgroundRepeat`/`backgroundPosition`/`objectFit`/
 *      `objectPosition`) have been set even without an image (a bare `<img>`
 *      using `objectFit` on its own natural content). Those five live ONLY
 *      inside this entry's own popover — they are properties of the image
 *      fill, and drawing five rows for an element with no image was the
 *      exact defect this plan exists to remove.
 *   4. **The `background` shorthand escape hatch** — read-only, shown ONLY
 *      when the shorthand itself has a value. Decomposing an arbitrary
 *      shorthand into color/image/size/repeat/position safely is a much
 *      bigger, riskier parse than a single gradient function (multiple
 *      comma-separated layers, order-dependent slash syntax, etc.), so this
 *      row never attempts it — it stays whatever the user's source says,
 *      editable only as raw CSS via its own popover (see
 *      `ShorthandEscapeHatchBody` in `FillSectionParts.tsx`). This mirrors
 *      the gradient parser's own refusal rule: an editor that LOOKS
 *      structured but quietly loses information is worse than an honest raw
 *      field.
 *
 * The `+`/eye-less list contract comes from `@ui/components/PropertyList` —
 * see that module's doc for Law 1 (empty ⇒ renders nothing) and why the
 * visibility eye is never passed here (CSS has no "disabled declaration";
 * plan §8 decision 1).
 *
 * `FillSectionActions` is this section's HEADER content — the "add text
 * colour" / "add solid fill" / "add gradient fill" buttons that live in
 * `Section`'s `actions` slot (both in the Law-1 empty-header state and once
 * the section has content), exactly like `AppearanceSectionActions`. It is
 * exported separately because the header and the body are siblings rendered
 * by `StyleSectionsEditor`, not parent/child.
 *
 * WHERE THE REST LIVES
 * ---------------------
 * This file owns which ROWS exist. `FillSectionParts.tsx` draws the swatches
 * and the popover bodies; `fillModel.ts` holds the pure value model (channel
 * membership, defaults, gradient transforms). The split landed when G9's
 * text-fill row pushed this file to the 700-line module ceiling.
 *
 * OUT OF SCOPE FOR THIS PASS (see the work order and STATE.md)
 * ---------------------------------------------------------------
 *   - Selection colours for a multi-node selection (plan §4 G6.4) — needs
 *     store-side multi-select style editing that doesn't exist yet.
 *   - Image fill via the media library. The image-mode editor here is a
 *     plain URL text field, not `MediaLibraryControl`'s picker/thumbnail
 *     grid — a deliberate scope cut given this work order's effort budget;
 *     follow-up noted in STATE.md.
 */
import { useState, type ReactNode, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Button } from '@ui/components/Button'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { readString, hasStyleValue } from './styleValueUtils'
import {
  ColorSwatch,
  ImageFillPopoverBody,
  ImageSwatch,
  ShorthandEscapeHatchBody,
} from './FillSectionParts'
import {
  DEFAULT_GRADIENT_FILL,
  DEFAULT_SOLID_FILL,
  DEFAULT_TEXT_FILL,
  IMAGE_SATELLITE_PROPS,
  isBackgroundImageSet,
} from './fillModel'
import { parseGradient, isUrlImageValue, extractUrlPayload } from './gradientValue'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './FillSection.module.css'

// ---------------------------------------------------------------------------
// FillSectionActions — the header's "+" buttons (Law 1 empty state AND the
// populated-section header — see module doc). Mirrors AppearanceSectionActions.
// ---------------------------------------------------------------------------

interface FillSectionActionsProps {
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function FillSectionActions({ storedStyles, onChange }: FillSectionActionsProps) {
  const textSet = hasStyleValue(readString(storedStyles, 'color'))
  const colorSet = hasStyleValue(readString(storedStyles, 'backgroundColor'))
  const imageValue = readString(storedStyles, 'backgroundImage')
  const imageSet = isBackgroundImageSet(imageValue)

  // Unlike Figma, CSS gives this element exactly one text-fill channel, one
  // solid-fill channel and one image-fill channel — once all three are in use
  // there is nothing left to add (see the module doc's "THE CSS MODEL").
  if (textSet && colorSet && imageSet) return null

  return (
    <>
      {!textSet && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add text colour"
          tooltip="Add text colour"
          data-testid="fill-section-add-text"
          onClick={() => onChange('color', DEFAULT_TEXT_FILL)}
        >
          <TextStartTIcon size={12} aria-hidden="true" />
        </Button>
      )}
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

type FillEntryKind = 'text' | 'color' | 'image' | 'shorthand'
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
   * Accepted for call-site compatibility with every other curated section's
   * shape — not consumed here. `PropertyList`'s "remove" clears via
   * `onChange(prop, undefined)` uniformly (the image entry clears six
   * properties in one gesture, which `onRemove`'s single-property signature
   * can't express), so this section never needs the separate
   * clear-one-property callback.
   */
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /**
   * Accepted for call-site compatibility — not consumed here.
   * `ClassPropertyRow`'s F1 provenance strip has no natural home in a
   * `PropertyList` row (a struck-through "shadowed declaration" list needs
   * its own space this compact row doesn't have); it stays available to the
   * Sizing sub-rows' fallback, which don't receive it either today, matching
   * every other `PropertyList`-based section.
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
  const textValue = readString(storedStyles, 'color')
  const showTextEntry = visible.has('color') && hasStyleValue(textValue)

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

  if (showTextEntry) {
    entries.push({
      id: 'fill-text',
      label: 'Text',
      leading: <ColorSwatch color={textValue!} />,
      summary: textValue,
      data: { kind: 'text' },
    })
  }

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
    if (entry.data.kind === 'text') {
      onChange('color', undefined)
    } else if (entry.data.kind === 'color') {
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

      {openPopover?.kind === 'text' && (
        <InspectorPopover id="fill-text" anchorRef={openPopover.anchorRef} onClose={closePopover} title="Text colour">
          <ColorValueInput
            value={textValue ?? ''}
            ariaLabel="Text colour"
            swatchLabel="Text colour swatch"
            onChange={(next) => onChange('color', next || undefined)}
            onPreview={previewProperty ? (next) => previewProperty('color', next) : undefined}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}

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
