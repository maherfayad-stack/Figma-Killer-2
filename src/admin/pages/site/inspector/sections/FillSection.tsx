/**
 * FillSection — Penpot's Fill section (`STATE.md` `panel-25`, item 5 of the
 * P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3). Migrated out of the
 * legacy `StyleSectionsEditor`/`classStyleSections.ts` registry onto its own
 * `INSPECTOR_SECTIONS` manifest entry, the same pattern Layer/Align/Measures/
 * Layout (items 1-4) already established: reads/writes exclusively through
 * `useSelectionModel()`/`useInspectorCommit(model)`, takes no props, and
 * renders `null` on no selection.
 *
 * THE CSS MODEL, AND WHERE IT DIVERGES FROM FIGMA'S/PENPOT'S
 * ---------------------------------------------------
 * Figma's (and Penpot's) Fill list is a stack of arbitrarily many paint
 * layers. So is CSS's, and `background-image` is a comma-separated LIST
 * whose first entry paints TOPMOST, parsed by `backgroundLayers.ts` into one
 * row per layer and re-joined byte-for-byte (or refused, in full, with a
 * reason — never a guessed rewrite). The rows, top of the paint stack down:
 *
 *   1. **Text** — `color`. A text node's colour IS its fill, so it sits
 *      first: it is the topmost paint, since text renders over the box's own
 *      background.
 *   2. **Content fit** — `objectFit` / `objectPosition`, when set. These size
 *      the element's OWN replaced content (an `<img>`'s picture), which
 *      paints above the background entirely.
 *   3. **Background layer 1…N** — one row per `background-image` layer, in
 *      CSS paint order. Each layer's six satellites (`background-size`,
 *      `-position`, `-repeat`, `-attachment`, `-origin`, `-clip`) plus its
 *      `background-blend-mode` are edited INSIDE that row's popover, per
 *      layer. Layers add, remove and reorder like Effects' shadow layers,
 *      over the same `PropertyList` gestures (click to edit, `−` to remove,
 *      `Alt+↑/↓` to reorder).
 *   4. **Solid fill** — `backgroundColor`, when set. Pinned BOTTOM-most among
 *      the paints, because that is where CSS paints it: below every image
 *      layer.
 *   5. **The `background` shorthand escape hatch** — shown ONLY when the
 *      shorthand itself has a value, editable only as raw CSS via its own
 *      popover (`ShorthandEscapeHatchBody`).
 *
 * ## The Color field chrome (`02-measurements.md`'s key finding for this
 * section)
 *
 * Penpot's own fill/stroke row is one compact inline chrome: swatch → hex →
 * `%` opacity → remove. `PropertyList`'s row anatomy already gives
 * swatch(`leading`)/hex(`summary`)/remove for free; the ONE genuinely missing
 * piece was the `%` opacity field, which this section adds into `entry.value`
 * — `PropertyList`'s own doc comment already names that slot "an opacity %".
 * `ColorOpacityField` (`FillSectionParts.tsx`) reads/writes it as the colour
 * value's own alpha channel (`parseCssColor`/`formatColor`,
 * `@ui/components/ColorPickerPopover`) — CSS has no separate "fill opacity"
 * property the way Penpot's own object model does, so the alpha channel
 * already inside `#rrggbbaa`/`rgba(...)`/`hsla(...)` IS that number. Only the
 * Text and Solid-fill rows get it (a single, unambiguous colour each); a
 * gradient layer's per-stop colours each carry their own alpha inside
 * `GradientEditor` already, and an image layer has no colour at all.
 *
 * This section deliberately does NOT go further and make the hex text itself
 * directly editable inline (still a click-to-open popover, `PropertyList`'s
 * existing row-activation model, unchanged from Stroke/Effects) — `PropertyList`
 * is a SHARED primitive across all three list sections, and rewriting its
 * interaction model for Fill alone would silently change Stroke/Effects too,
 * well outside this section's own scope.
 *
 * NO VISIBILITY EYE, STILL
 * ------------------------
 * `PropertyList`'s eye is opt-in and stays off here. CSS has no "disabled
 * declaration", and the two ways to fake one (UI-only state lost on reload,
 * or commenting out the user's CSS) are both worse than omitting it. Hiding a
 * layer here means removing it; the honest undo is the editor's own history.
 *
 * LAW 1 — EMPTY vs. POPULATED, RULE 2 COMPLIANCE
 * ------------------------------------------------
 * Nothing set anywhere (base or any breakpoint/condition) renders `Section`'s
 * `empty` state — title + the header's own add buttons, no chevron, no body
 * (`docs/features/inspector-disclosure.md`'s Law 1, matches Penpot's own
 * measured "collapsed-empty: Title + trailing +, no chevron"). The moment
 * anything IS set, this section passes `forceOpen` instead — no manual
 * collapse of a populated section (`STATE.md` `panel-25`'s Rule-2 gap, the
 * same posture every migrated section takes). Every add button here writes a
 * REAL value immediately (`onChange('color', DEFAULT_TEXT_FILL)`, etc.), so
 * there is no separate "revealed" local-UI state to track the way the old
 * `StyleSectionsEditor`'s generic reveal-then-add sections needed — the
 * write itself is what flips `Section` from empty to populated on the next
 * render.
 *
 * WHERE THE REST LIVES
 * ---------------------
 * This file owns which ROWS exist. `FillSectionParts.tsx` draws the swatches,
 * the opacity field, and the popover bodies; `backgroundLayers.ts` is the
 * pure layer-stack model (parse / serialise / refuse / add / remove /
 * reorder); `fillModel.ts` holds the colour-channel defaults and the
 * gradient transforms; `gradientValue.ts` parses/serialises one gradient
 * value; `imageFillValue.ts` maps an image fill's URL payload. All four stay
 * in `panels/PropertiesPanel/`, unchanged, per this work order's own
 * instruction to reuse them verbatim — only the RENDERING moved.
 *
 * IMAGE FILL
 * ----------
 * "Add image fill" opens `ImageSourcePicker` — the project's own images, an
 * upload into the project, or a pasted URL — and only then inserts a layer,
 * so no `url('')` is ever written into the user's source speculatively.
 *
 * MULTI-SELECT
 * ------------
 * Out of scope, structurally: `PropertiesPanelBody.tsx` early-returns
 * `<MultiSelectionInspector>` before `StyleSurface`/`INSPECTOR_SECTIONS` ever
 * mount when `isMultiSelect` is true (the same fact `AlignSection`'s own doc
 * already established) — this section never renders during a multi-select,
 * so it drops the old `FillSection.tsx`'s `isMixed`/`MIXED_PLACEHOLDER`
 * handling entirely rather than porting dead code.
 *
 * LOCKED (CODE-VALUED) PROPERTIES
 * --------------------------------
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * of `StyleSectionsComposer.tsx`'s top-level check every migrated section
 * reproduces (no composer aggregates the whole bag anymore).
 */
import { useState, type ReactNode, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Section } from '@ui/components/Section'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { readString, hasStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import {
  BackgroundImageRawBody,
  BackgroundLayerPopoverBody,
  ColorOpacityField,
  ColorSwatch,
  ContentFitPopoverBody,
  ImageSwatch,
  OrphanSatellitesBody,
  ShorthandEscapeHatchBody,
} from './FillSectionParts'
import { FillSectionActions } from './FillSectionActions'
import { writeBackgroundModel } from './writeBackgroundModel'
import {
  BACKGROUND_SATELLITE_PROPS,
  moveBackgroundLayer,
  parseBackgroundLayers,
  removeBackgroundLayer,
  type BackgroundModel,
} from '../../panels/PropertiesPanel/backgroundLayers'
import { CONTENT_FIT_PROPS } from '../../panels/PropertiesPanel/fillModel'
import { parseGradient, isUrlImageValue, extractUrlPayload } from '../../panels/PropertiesPanel/gradientValue'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import styles from './FillSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

/** Every property this section renders a control for. */
const FILL_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'color',
  'backgroundColor',
  'background',
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundAttachment',
  'backgroundOrigin',
  'backgroundClip',
  'backgroundBlendMode',
  'objectFit',
  'objectPosition',
]

// ---------------------------------------------------------------------------
// FillSection — the manifest section
// ---------------------------------------------------------------------------

type FillEntryData =
  | { kind: 'text' }
  | { kind: 'contentFit' }
  | { kind: 'layer'; index: number }
  | { kind: 'layersRaw'; raw: string; reason: string }
  | { kind: 'orphanSatellites' }
  | { kind: 'color' }
  | { kind: 'shorthand' }

export function FillSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues } = model

  // The anchor ref comes from `PropertyList`'s `onActivate` and is stored as
  // plain STATE (not a `useRef` map read during render) — same posture
  // `EffectsSection`'s own note establishes for the React Compiler's
  // ref-during-render rule.
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(null)

  if (!selectedNodeId || !selectedNode) return null

  const contextKey = activeContextId ?? 'base'

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  // The same collapsed-bag pair every migrated section builds
  // (`collapsedStyleBag.ts`), scoped to Fill's own claimed properties.
  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(FILL_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  // Law 1 (`docs/features/inspector-disclosure.md` §4 G1): whether ANYTHING
  // Fill claims is set, on the active tab OR any other breakpoint/condition
  // — a value set only on an inactive tab is still the user's own work and
  // must not disappear behind the empty header. Mirrors
  // `StyleSectionsComposer.tsx`'s own `crossContextStyles` construction.
  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = FILL_PROPERTIES.some(
    (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
  )

  // -------------------------------------------------------------------------
  // Adapters — the old `StyleSectionsEditor`-shaped callback pair, mapped
  // onto `commitApi`'s `commitStyle`/`commitStyleMany`.
  // -------------------------------------------------------------------------

  function onChange(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null)
  }

  function previewProperty(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null, { preview: true })
  }

  const onClearPreview = commit.clearStylePreview

  const fillActions = <FillSectionActions storedStyles={storedStyles} onChange={onChange} />

  // Law 1's empty state: nothing set anywhere. One static header line, the
  // add buttons, no body, no chevron — matches Penpot's own measured
  // collapsed-empty convention exactly.
  if (!setAnywhere) {
    return (
      <Section title="Fill" icon={PaintBucketSolidIcon} empty flush actions={fillActions} />
    )
  }

  const parsedModel = parseBackgroundLayers(storedStyles)
  const layers = parsedModel.spine.kind === 'layers' ? parsedModel.spine.layers : []
  const orphanSatellites =
    parsedModel.spine.kind !== 'layers' &&
    BACKGROUND_SATELLITE_PROPS.some((prop) => parsedModel.satellites[prop].kind !== 'unset')

  function write(next: BackgroundModel) {
    writeBackgroundModel(parsedModel, next, onChange)
  }

  const textValue = readString(storedStyles, 'color')
  const showTextEntry = hasStyleValue(textValue)

  const contentFitVisible = CONTENT_FIT_PROPS.some((prop) => hasStyleValue(storedStyles[prop]))

  const colorValue = readString(storedStyles, 'backgroundColor')
  const showColorEntry = hasStyleValue(colorValue)

  const shorthandValue = readString(storedStyles, 'background')
  const showShorthandEntry = hasStyleValue(shorthandValue)

  // ---- entries ------------------------------------------------------------
  const entries: PropertyListEntry<FillEntryData>[] = []

  if (showTextEntry) {
    entries.push({
      id: 'fill-text',
      label: 'Text',
      leading: <ColorSwatch color={textValue!} />,
      summary: textValue,
      value: <ColorOpacityField value={textValue!} ariaLabel="Text colour opacity" onChange={(next) => onChange('color', next)} />,
      data: { kind: 'text' },
    })
  }

  if (contentFitVisible) {
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
  if (parsedModel.spine.kind === 'layers') {
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
  } else if (parsedModel.spine.kind === 'raw') {
    entries.push({
      id: 'fill-layers-raw',
      label: 'Background image',
      leading: <CodeIcon size={14} aria-hidden="true" />,
      summary: 'Custom (raw CSS)',
      value: parsedModel.spine.raw,
      data: { kind: 'layersRaw', raw: parsedModel.spine.raw, reason: parsedModel.spine.reason },
    })
  }

  if (orphanSatellites) {
    entries.push({
      id: 'fill-orphan-satellites',
      label: 'Background sizing',
      leading: <Image2SolidIcon size={14} aria-hidden="true" />,
      summary: 'Background sizing',
      value: parsedModel.spine.kind === 'raw' ? 'Raw layer list' : 'No image layer',
      data: { kind: 'orphanSatellites' },
    })
  }
  const layerCount = parsedModel.spine.kind === 'layers' ? layers.length : 0

  if (showColorEntry) {
    entries.push({
      id: 'fill-color',
      label: 'Solid fill',
      leading: <ColorSwatch color={colorValue!} />,
      summary: colorValue,
      value: (
        <ColorOpacityField value={colorValue!} ariaLabel="Solid fill opacity" onChange={(next) => onChange('backgroundColor', next)} />
      ),
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
        write(removeBackgroundLayer(parsedModel, data.index))
        break
      case 'layersRaw':
        onChange('backgroundImage', undefined)
        break
      case 'orphanSatellites':
        // ONLY the satellites. `background-image` has its own row (a raw
        // one, or a layer list), and removing "Background sizing" must not
        // delete a paint the user can still see.
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
   * means anything — layer order IS paint order within one declaration.
   */
  function handleReorder(fromIndex: number, toIndex: number) {
    const from = fromIndex - layerStart
    const to = toIndex - layerStart
    if (from < 0 || to < 0 || from >= layerCount || to >= layerCount) return
    write(moveBackgroundLayer(parsedModel, from, to))
  }

  const editingEntry = editing ? entries.find((entry) => entry.id === editing.id) : undefined

  return (
    <Section title="Fill" icon={PaintBucketSolidIcon} forceOpen flush actions={fillActions}>
      <div className={styles.fillSection} key={contextKey}>
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
                onPreview={(next) => previewProperty('color', next)}
                onClearPreview={onClearPreview}
              />
            )}

            {editingEntry.data.kind === 'color' && (
              <ColorValueInput
                value={colorValue ?? ''}
                ariaLabel="Solid fill colour"
                swatchLabel="Solid fill colour swatch"
                onChange={(next) => onChange('backgroundColor', next || undefined)}
                onPreview={(next) => previewProperty('backgroundColor', next)}
                onClearPreview={onClearPreview}
              />
            )}

            {editingEntry.data.kind === 'layer' && (
              <BackgroundLayerPopoverBody
                model={parsedModel}
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
                hasRefusedLayers={parsedModel.spine.kind === 'raw'}
                storedStyles={storedStyles}
                currentStyles={currentStyles}
                activeTab={contextKey}
                onChange={onChange}
                onPreview={previewProperty}
                onClearPreview={onClearPreview}
              />
            )}

            {editingEntry.data.kind === 'contentFit' && (
              <ContentFitPopoverBody
                storedStyles={storedStyles}
                currentStyles={currentStyles}
                activeTab={contextKey}
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
    </Section>
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
 * How one `background-image` layer reads in the list. The layer NUMBER is
 * only drawn when there is more than one — a single-layer background is just
 * "the" fill, and numbering it invents a stack the user does not have.
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
