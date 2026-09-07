/**
 * FillSection — Figma's Fill list (docs/features/inspector-disclosure.md §4 G6,
 * F13/F14/F15), replacing the old always-on 6-entry `BackgroundSection` grid.
 *
 * THE CSS MODEL, AND WHERE IT DIVERGES FROM FIGMA'S
 * ---------------------------------------------------
 * Figma's Fill list is a stack of arbitrarily many paint layers. So is CSS's,
 * and G6.5 finally models it that way: `background-image` is a comma-separated
 * LIST whose first entry paints TOPMOST, parsed by `backgroundLayers.ts` into
 * one row per layer and re-joined byte-for-byte (or refused, in full, with a
 * reason — never a guessed rewrite). The rows, top of the paint stack down:
 *
 *   1. **Text** — `color`. Figma shows a text node's colour in Fill, because
 *      that is what it is; G9's target shape moved it out of Typography once
 *      this section existed to receive it. It sits first because it is the
 *      topmost paint: text renders over the box's own background.
 *   2. **Content fit** — `objectFit` / `objectPosition`, when set. These size
 *      the element's OWN replaced content (an `<img>`'s picture), which paints
 *      above the background entirely. They used to ride along with the image
 *      fill's satellites; that conflated two unrelated things.
 *   3. **Background layer 1…N** — one row per `background-image` layer, in CSS
 *      paint order. Each layer's six satellites (`background-size`,
 *      `-position`, `-repeat`, `-attachment`, `-origin`, `-clip`) plus its
 *      `background-blend-mode` are edited INSIDE that row's popover, per
 *      layer — drawing them as top-level rows for an element with no image was
 *      the exact defect this plan exists to remove. Layers add, remove and
 *      reorder like Effects' shadow layers, over the same `PropertyList`
 *      gestures (click to edit, `−` to remove, `Alt+↑/↓` to reorder).
 *   4. **Solid fill** — `backgroundColor`, when set. Pinned BOTTOM-most among
 *      the paints, because that is where CSS paints it: below every image
 *      layer. It is deliberately not "layer N+1" — it is a single paint with
 *      no per-layer satellites of its own.
 *   5. **The `background` shorthand escape hatch** — shown ONLY when the
 *      shorthand itself has a value. Decomposing an arbitrary shorthand into
 *      colour/image/size/repeat/position safely is a much bigger, riskier
 *      parse than a layer list (order-dependent slash syntax, a colour that
 *      may appear in any layer's position), so this row never attempts it — it
 *      stays whatever the user's source says, editable only as raw CSS via its
 *      own popover (`ShorthandEscapeHatchBody`).
 *
 * When the layer list cannot be split (a top-level `var()`, unbalanced
 * parens, a value that would be reformatted) the whole `background-image`
 * becomes ONE raw-text row with its reason — the same refusal rule the
 * gradient and box-shadow parsers use. And when a satellite is set with no
 * image layer to apply to, it gets its own "Background sizing" row rather than
 * disappearing from the inspector.
 *
 * NO VISIBILITY EYE, STILL
 * ------------------------
 * `PropertyList`'s eye is opt-in and stays off here. §8 decision 1 settled it:
 * CSS has no "disabled declaration", and the two ways to fake one (UI-only
 * state lost on reload, or commenting out the user's CSS) are both worse than
 * omitting it. Hiding a layer here means removing it; the honest undo is the
 * editor's own history, not a fake eye. The layer LIST is what changed in
 * G6.5, not that decision.
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
 * and the popover bodies; `backgroundLayers.ts` is the pure layer-stack model
 * (parse / serialise / refuse / add / remove / reorder); `fillModel.ts` holds
 * the colour-channel defaults and the gradient transforms.
 *
 * OUT OF SCOPE FOR THIS PASS (see the work order and STATE.md)
 * ---------------------------------------------------------------
 *   - Selection colours for a multi-node selection (plan §4 G6.4) — needs
 *     store-side multi-select style editing that doesn't exist yet.
 *   - Image fill via the media library. The image-mode editor here is a
 *     plain URL text field, not `MediaLibraryControl`'s picker/thumbnail
 *     grid — a deliberate scope cut; follow-up noted in STATE.md.
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
  BackgroundImageRawBody,
  BackgroundLayerPopoverBody,
  ColorSwatch,
  ContentFitPopoverBody,
  ImageSwatch,
  OrphanSatellitesBody,
  ShorthandEscapeHatchBody,
} from './FillSectionParts'
import {
  BACKGROUND_SATELLITE_PROPS,
  backgroundModelPatch,
  insertBackgroundLayer,
  moveBackgroundLayer,
  parseBackgroundLayers,
  removeBackgroundLayer,
  type BackgroundModel,
} from './backgroundLayers'
import {
  CONTENT_FIT_PROPS,
  DEFAULT_GRADIENT_FILL,
  DEFAULT_SOLID_FILL,
  DEFAULT_TEXT_FILL,
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
  const model = parseBackgroundLayers(storedStyles)
  // A refused layer list has no known layer count, so there is no honest index
  // to insert at. The button stays visible and says why rather than silently
  // doing nothing.
  const layersRefused = model.spine.kind === 'raw'

  function addLayer() {
    writeBackgroundModel(model, insertBackgroundLayer(model, 0, DEFAULT_GRADIENT_FILL), onChange)
  }

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
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Add gradient fill"
        tooltip={
          layersRefused
            ? 'This background-image is edited as raw text, so a layer cannot be added here'
            : 'Add gradient fill'
        }
        disabled={layersRefused}
        data-testid="fill-section-add-image"
        onClick={addLayer}
      >
        <Image2SolidIcon size={12} aria-hidden="true" />
      </Button>
    </>
  )
}

/**
 * Writes a new layer model as the SMALLEST set of `onChange` calls that
 * expresses the difference. `onChange` is one store mutation (and one AST
 * writeback) per call, so re-emitting all eight `background-*` properties on
 * every gradient keystroke would put seven no-op writes in the user's undo
 * history. Both patches come from the same serialiser, so comparing them is an
 * exact "did this declaration change" test.
 */
function writeBackgroundModel(
  previous: BackgroundModel,
  next: BackgroundModel,
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void,
) {
  const before = backgroundModelPatch(previous)
  const after = backgroundModelPatch(next)
  for (const [property, value] of Object.entries(after)) {
    if (before[property as keyof CSSPropertyBag] === value) continue
    onChange(property as keyof CSSPropertyBag, value)
  }
}

// ---------------------------------------------------------------------------
// FillSection — the body
// ---------------------------------------------------------------------------

type FillEntryData =
  | { kind: 'text' }
  | { kind: 'contentFit' }
  | { kind: 'layer'; index: number }
  | { kind: 'layersRaw'; raw: string; reason: string }
  | { kind: 'orphanSatellites' }
  | { kind: 'color' }
  | { kind: 'shorthand' }

interface FillSectionProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /**
   * Accepted for call-site compatibility with every other curated section's
   * shape — not consumed here. `PropertyList`'s "remove" clears via
   * `onChange(prop, undefined)` uniformly (a layer row clears several
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

export function FillSection({
  storedStyles,
  currentStyles,
  visibleProperties,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: FillSectionProps) {
  // The anchor ref comes from `PropertyList`'s `onActivate` and is stored as
  // plain STATE (not a `useRef` map read during render) — see EffectsSection's
  // note on React Compiler's ref-during-render rule.
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(null)
  const visible = new Set(visibleProperties)

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  // ---- entry presence -------------------------------------------------
  const textValue = readString(storedStyles, 'color')
  const showTextEntry = visible.has('color') && hasStyleValue(textValue)

  const contentFitVisible = CONTENT_FIT_PROPS.some((prop) => visible.has(prop))
  const showContentFitEntry =
    contentFitVisible && CONTENT_FIT_PROPS.some((prop) => hasStyleValue(storedStyles[prop]))

  const layersVisible =
    visible.has('backgroundImage') || BACKGROUND_SATELLITE_PROPS.some((prop) => visible.has(prop))
  const model = parseBackgroundLayers(storedStyles)
  const layers = model.spine.kind === 'layers' ? model.spine.layers : []
  const orphanSatellites =
    model.spine.kind !== 'layers' && BACKGROUND_SATELLITE_PROPS.some((prop) => model.satellites[prop].kind !== 'unset')

  function write(next: BackgroundModel) {
    writeBackgroundModel(model, next, onChange)
  }

  const colorValue = readString(storedStyles, 'backgroundColor')
  const showColorEntry = visible.has('backgroundColor') && hasStyleValue(colorValue)

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

  if (showContentFitEntry) {
    entries.push({
      id: 'fill-content-fit',
      label: 'Content fit',
      leading: <Image2SolidIcon size={14} aria-hidden="true" />,
      summary: 'Content fit',
      value: readString(storedStyles, 'objectFit'),
      data: { kind: 'contentFit' },
    })
  }

  // The layer block — its start index is what `handleReorder` clamps drags to.
  const layerStart = entries.length
  if (layersVisible) {
    if (model.spine.kind === 'layers') {
      layers.forEach((image, index) => {
        const described = describeLayer(image, index, layers.length)
        entries.push({
          id: `fill-layer-${index}`,
          label: described.label,
          leading: described.leading,
          summary: described.summary,
          value: described.value,
          data: { kind: 'layer', index },
        })
      })
    } else if (model.spine.kind === 'raw') {
      entries.push({
        id: 'fill-layers-raw',
        label: 'Background image',
        leading: <CodeIcon size={14} aria-hidden="true" />,
        summary: 'Custom (raw CSS)',
        value: model.spine.raw,
        data: { kind: 'layersRaw', raw: model.spine.raw, reason: model.spine.reason },
      })
    }

    if (orphanSatellites) {
      entries.push({
        id: 'fill-orphan-satellites',
        label: 'Background sizing',
        leading: <Image2SolidIcon size={14} aria-hidden="true" />,
        summary: 'Background sizing',
        value: model.spine.kind === 'raw' ? 'Raw layer list' : 'No image layer',
        data: { kind: 'orphanSatellites' },
      })
    }
  }
  const layerCount = model.spine.kind === 'layers' ? layers.length : 0

  if (showColorEntry) {
    entries.push({
      id: 'fill-color',
      label: 'Solid fill',
      leading: <ColorSwatch color={colorValue!} />,
      summary: colorValue,
      data: { kind: 'color' },
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
    setEditing({ id: entry.id, anchorRef })
  }

  /** Clears each of `props` that is actually set — no write for an already-unset one. */
  function clearSet(props: ReadonlyArray<keyof CSSPropertyBag>) {
    for (const prop of props) {
      if (hasStyleValue(storedStyles[prop])) onChange(prop, undefined)
    }
  }

  function handleRemove(entry: PropertyListEntry<FillEntryData>) {
    const { data } = entry
    switch (data.kind) {
      case 'text':
        onChange('color', undefined)
        break
      case 'color':
        onChange('backgroundColor', undefined)
        break
      case 'contentFit':
        clearSet(CONTENT_FIT_PROPS)
        break
      case 'layer':
        write(removeBackgroundLayer(model, data.index))
        break
      case 'layersRaw':
        onChange('backgroundImage', undefined)
        break
      case 'orphanSatellites':
        // ONLY the satellites. `background-image` has its own row (a raw one,
        // or a layer list), and removing "Background sizing" must not delete a
        // paint the user can still see.
        clearSet(BACKGROUND_SATELLITE_PROPS)
        break
      case 'shorthand':
        onChange('background', undefined)
        break
    }

    if (editing?.id === entry.id) setEditing(null)
  }

  /**
   * Only a drag whose BOTH endpoints sit inside the background-layer block
   * means anything — layer order IS paint order within one declaration, and
   * there is no sense in which the text colour can be dragged below a
   * gradient (they are separate properties). Everything else is a no-op.
   */
  function handleReorder(fromIndex: number, toIndex: number) {
    const from = fromIndex - layerStart
    const to = toIndex - layerStart
    if (from < 0 || to < 0 || from >= layerCount || to >= layerCount) return
    write(moveBackgroundLayer(model, from, to))
  }

  const editingEntry = editing ? entries.find((entry) => entry.id === editing.id) : undefined

  return (
    <div className={styles.fillSection}>
      <PropertyList
        listLabel="Fill"
        entries={entries}
        onActivate={handleActivate}
        onRemove={handleRemove}
        onReorder={layerCount > 1 ? handleReorder : undefined}
      />

      {editing && editingEntry && (
        <InspectorPopover
          id={editing.id}
          anchorRef={editing.anchorRef}
          onClose={() => setEditing(null)}
          title={popoverTitle(editingEntry)}
          width={editingEntry.data.kind === 'layer' ? 264 : undefined}
        >
          {editingEntry.data.kind === 'text' && (
            <ColorValueInput
              value={textValue ?? ''}
              ariaLabel="Text colour"
              swatchLabel="Text colour swatch"
              onChange={(next) => onChange('color', next || undefined)}
              onPreview={previewProperty ? (next) => previewProperty('color', next) : undefined}
              onClearPreview={onClearPreview}
            />
          )}

          {editingEntry.data.kind === 'color' && (
            <ColorValueInput
              value={colorValue ?? ''}
              ariaLabel="Solid fill colour"
              swatchLabel="Solid fill colour swatch"
              onChange={(next) => onChange('backgroundColor', next || undefined)}
              onPreview={previewProperty ? (next) => previewProperty('backgroundColor', next) : undefined}
              onClearPreview={onClearPreview}
            />
          )}

          {editingEntry.data.kind === 'layer' && (
            <BackgroundLayerPopoverBody
              model={model}
              index={editingEntry.data.index}
              onModelChange={write}
              onChange={onChange}
            />
          )}

          {editingEntry.data.kind === 'layersRaw' && (
            <BackgroundImageRawBody
              value={editingEntry.data.raw}
              reason={editingEntry.data.reason}
              onChange={(next) => onChange('backgroundImage', next || undefined)}
            />
          )}

          {editingEntry.data.kind === 'orphanSatellites' && (
            <OrphanSatellitesBody
              hasRefusedLayers={model.spine.kind === 'raw'}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              activeTab={activeTab}
              onChange={onChange}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
          )}

          {editingEntry.data.kind === 'contentFit' && (
            <ContentFitPopoverBody
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              activeTab={activeTab}
              onChange={onChange}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
          )}

          {editingEntry.data.kind === 'shorthand' && (
            <ShorthandEscapeHatchBody
              value={shorthandValue}
              onChange={(next) => onChange('background', next || undefined)}
            />
          )}
        </InspectorPopover>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row summaries
// ---------------------------------------------------------------------------

const POPOVER_TITLES: Record<FillEntryData['kind'], string> = {
  text: 'Text colour',
  contentFit: 'Content fit',
  layer: 'Background layer',
  layersRaw: 'Background image (raw CSS)',
  orphanSatellites: 'Background sizing',
  color: 'Solid fill',
  shorthand: 'Background (raw CSS)',
}

function popoverTitle(entry: PropertyListEntry<FillEntryData>): string {
  return entry.data.kind === 'layer' ? entry.label : POPOVER_TITLES[entry.data.kind]
}

/**
 * How one `background-image` layer reads in the list. The layer NUMBER is only
 * drawn when there is more than one — a single-layer background is just "the"
 * fill, and numbering it invents a stack the user does not have.
 */
function describeLayer(
  image: string,
  index: number,
  total: number,
): { label: string; summary: ReactNode; value?: ReactNode; leading: ReactNode } {
  const suffix = total > 1 ? ` ${index + 1}` : ''

  if (image.trim().toLowerCase() === 'none') {
    return {
      label: `Empty layer${suffix}`,
      summary: 'Empty layer',
      leading: <CodeIcon size={14} aria-hidden="true" />,
    }
  }

  if (isUrlImageValue(image)) {
    return {
      label: `Image fill${suffix}`,
      summary: extractUrlPayload(image) || 'Image',
      leading: <ImageSwatch image={image} />,
    }
  }

  const parsed = parseGradient(image)
  if (parsed.ok) {
    const kindLabel = parsed.gradient.kind === 'linear' ? 'Linear gradient' : 'Radial gradient'
    return {
      label: `${kindLabel} fill${suffix}`,
      summary: kindLabel,
      value: `${parsed.gradient.stops.length} stops`,
      leading: <ImageSwatch image={image} />,
    }
  }

  return {
    label: `Image fill${suffix}`,
    summary: 'Custom (raw CSS)',
    leading: <CodeIcon size={14} aria-hidden="true" />,
  }
}
