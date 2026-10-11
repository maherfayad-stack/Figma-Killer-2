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
 *      CSS paint order. Each layer's six positioning satellites
 *      (`background-size`, `-position`, `-repeat`, `-attachment`, `-origin`,
 *      `-clip`) are edited INSIDE that row's popover, per layer. The layer's
 *      `background-blend-mode` sits on the ROW itself instead, where Figma
 *      puts a fill's blend mode — see `LayerBlendSelect` for why that
 *      property, and not `mix-blend-mode`, is the honest per-fill target.
 *      Layers add, remove and reorder like Effects' shadow layers,
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
 * ONE CLICK TO THE REAL PICKER (`STATE.md` panel-33) — the Text/Solid-fill
 * rows' `summary` slot IS the hex/token field (`ColorFieldRow`,
 * `FillColorField.tsx`): its own swatch opens `ColorPickerPopover` on the
 * FIRST click, guarded so it never also fires `PropertyList`'s row
 * `onActivate`. `writeTarget.kind === 'none'` (`ColorWriteRefusalBody`) is
 * the one case still behind the row-activation popover below — a disabled
 * swatch can't open its own picker to explain itself, and that path was
 * already one click, never the reported 2-click defect.
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
 * (`docs/features/inspector.md`'s Law 1, matches Penpot's own
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
 * "Nothing set anywhere" above means nothing STORED. `STATE.md` panel-30:
 * this predicate used to read `storedStyles` exclusively, so a `body` whose
 * white background came from an ambient/global rule the parser captured but
 * never attached to this node — or a text node's ordinary inherited black
 * `color` — rendered a collapsed, empty Fill next to a canvas that plainly
 * showed the colour. `setAnywhere` now ALSO opens for `backgroundColor`/
 * `color` when `renderedNotStored.ts`'s `rendersUnstoredValue` says the frame
 * is genuinely painting something no stored source explains (gated by
 * `!computedValuesLoading` and, for `color`, `isTextNode` — see that
 * predicate's own call site below). The row it reveals is MUTED
 * (`PropertyListEntry.muted`), has no remove button
 * (`PropertyListEntry.removable: false` — nothing stored to remove), and its
 * "N set" bookkeeping is unaffected: Law 1's INDICATOR stays keyed to
 * `storedStyles` alone, only the disclosure/row-existence decision changed.
 * Stroke/Shadow/Blur get the identical treatment in their own follow-up PRs;
 * `rendersUnstoredValue` is the ONE shared predicate every section must
 * reuse, not reimplement.
 *
 * WHERE THE REST LIVES
 * ---------------------
 * This file owns which ROWS exist. `FillSectionParts.tsx` draws the opacity
 * field and the layer/gradient/content-fit popover bodies;
 * `FillEntryPopover.tsx` is the one switch that picks which of those a row
 * opens; `fillRowDescriptors.tsx` owns the row taxonomy (`FillEntryData`),
 * each kind's popover title, and how a background layer reads in the list.
 * `FillColorField.tsx`
 * owns the colour rows' own chrome; `buildColorFillEntry.tsx` builds the row
 * object itself; `colorWriteTargetNote.ts` is the shared note-string builder —
 * all split out purely for `module-size-budgets.test.ts`. `backgroundLayers.ts`,
 * `fillModel.ts`, `gradientValue.ts`, `imageFillValue.ts` stay in
 * `panels/PropertiesPanel/`, unchanged, per the P3 work order's own
 * instruction to reuse them verbatim.
 *
 * IMAGE FILL
 * ----------
 * "Add image fill" opens `ImageSourcePicker` — the project's own images, an
 * upload into the project, or a pasted URL — and only then inserts a layer,
 * so no `url('')` is ever written into the user's source speculatively.
 *
 * MULTI-SELECT
 * ------------
 * Mounts for N nodes as of S5: `useSelectionModel()` hands this section the
 * anchor wearing the selection's COLLAPSED inline bag, so every read and
 * every `useInspectorCommit` call below works unchanged, and a commit lands
 * on all N. `SelectionColorsSection` (`selectionColors`, directly under this
 * one in the manifest) is the multi-only companion that answers "what
 * colours is this selection made of" across properties.
 *
 * MIXED, ROW BY ROW (`docs/features/inspector.md` §9.3)
 * -----------------------------------------------------
 * The collapsed bag holds the `MIXED` Symbol wherever the selected layers
 * disagree, and `readString` returns `undefined` for a Symbol — so until this
 * was wired, a disagreeing fill rendered this section's ordinary UNSET state
 * and a row could vanish entirely. Nothing lied, but "nobody set a fill" and
 * "five layers set five different fills" looked identical, one keystroke from
 * flattening the second into the first. Every row now reads the RAW cell:
 *
 *   - **Text** / **Solid fill** — the row stays and its `ColorValueInput`
 *     reads "Mixed"; the `%` opacity cell is dropped (there is no single
 *     alpha to show). Typing or picking a colour writes it to all N.
 *   - **Content fit** — the row's trailing value reads "Mixed"; its popover's
 *     `ClassPropertyRow`s carry the sentinel through to their own controls.
 *   - **Background layers** — a disagreeing `background-image` has NO shared
 *     stack, so the per-layer rows collapse into ONE "Mixed" row whose
 *     popover writes each background declaration whole
 *     (`BackgroundDeclarationsBody`). The header's two layer-add buttons
 *     disable: "insert at index 0" would be a replace wearing an add's icon.
 *     A stack the layers AGREE on keeps its per-layer rows, and only the
 *     disagreeing satellite goes whole-declaration.
 *   - **Background shorthand** — the row stays and its raw field reads
 *     "Mixed".
 *
 * Removing any of those rows clears the property from every selected layer,
 * in one history entry (`setNodesInlineStyles`, §9.1).
 *
 * LOCKED (CODE-VALUED) PROPERTIES
 * --------------------------------
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * of `StyleSectionsComposer.tsx`'s top-level check every migrated section
 * reproduces (no composer aggregates the whole bag anymore).
 */
import { useState, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { Section } from '@ui/components/Section'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { readString, hasStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { isMixed, MIXED_PLACEHOLDER } from '@ui/components/MixedValue'
import { LayerBlendSelect } from './FillSectionParts'
import { buildColorFillEntry } from './buildColorFillEntry'
import { colorWriteTargetNote } from './colorWriteTargetNote'
import { FillSectionActions } from './FillSectionActions'
import { FillEntryPopover } from './FillEntryPopover'
import { describeLayer, mixedLayersEntry, type FillEntryData } from './fillRowDescriptors'
import { writeBackgroundModel } from './writeBackgroundModel'
import {
  BACKGROUND_SATELLITE_PROPS,
  moveBackgroundLayer,
  parseBackgroundLayers,
  removeBackgroundLayer,
  type BackgroundModel,
  type BackgroundSatelliteProp,
} from '../../panels/PropertiesPanel/backgroundLayers'
import { CONTENT_FIT_PROPS } from '../../panels/PropertiesPanel/fillModel'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { rendersUnstoredValue } from '../renderedNotStored'
import { isTextNode } from '../../panels/PropertiesPanel/styleSectionOrder'
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

export function FillSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const {
    selectedNodeId,
    selectedNode,
    assignedClassRules,
    activeContextId,
    computedValues,
    provenanceByProperty,
    computedValuesLoading,
  } = model

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

  // "Stored at the ACTIVE CONTEXT" — computed BEFORE `rendersUnstoredValue`
  // needs it (`panel-32`: the predicate must know whether THIS context's own
  // bag declares the property, not merely whether it exists somewhere in the
  // node's effective chain). Also feeds the two rows' own display below —
  // computed once, not twice.
  //
  // `hasStyleValue` is asked about the RAW cell, not `readString`'s output:
  // for a multi-selection that disagrees the cell is the `MIXED` Symbol,
  // which `readString` collapses to `undefined`. Reading "stored" off that
  // is what made a disagreeing colour row vanish (§9.3).
  const textMixed = isMixed(storedStyles.color)
  const textValue = readString(storedStyles, 'color')
  const textStored = hasStyleValue(storedStyles.color)
  const colorMixed = isMixed(storedStyles.backgroundColor)
  const colorValue = readString(storedStyles, 'backgroundColor')
  const colorStored = hasStyleValue(storedStyles.backgroundColor)

  // Law 1 (`docs/features/inspector.md` §4 G1): whether ANYTHING
  // Fill claims is set, on the active tab OR any other breakpoint/condition
  // — a value set only on an inactive tab is still the user's own work and
  // must not disappear behind the empty header. Mirrors
  // `StyleSectionsComposer.tsx`'s own `crossContextStyles` construction.
  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  // STATE.md panel-30/panel-32 — "the bg is white, I don't see that in the
  // fill", widened to "the colour is declared in my own CSS and still isn't
  // shown". A value the frame genuinely renders that the ACTIVE CONTEXT's own
  // bag does not declare must still open Fill — whether nothing declares it
  // ANYWHERE (panel-30) or something declares it elsewhere, e.g. at base
  // while a breakpoint/condition tab is active (panel-32) — see
  // `renderedNotStored.ts`. Gated on `!computedValuesLoading` so a Tier 2
  // bridge measurement still in flight (P5, `panel-26`) never flickers the
  // section open/closed off a stale or absent read — the OLD stored-only
  // disclosure applies until that measurement resolves. `color` is gated
  // additionally by `isTextNode` — an ordinary non-text container's inherited
  // black text colour is real but not the element's own paint the way a
  // body's white background is; opening Fill for every such container would
  // be the flood this guard exists to avoid.
  const backgroundColorRendersUnstored =
    !computedValuesLoading && rendersUnstoredValue(provenanceByProperty.get('backgroundColor'), colorStored)
  const textColorRendersUnstored =
    !computedValuesLoading &&
    isTextNode(selectedNode) &&
    rendersUnstoredValue(provenanceByProperty.get('color'), textStored)

  const setAnywhere =
    FILL_PROPERTIES.some(
      (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
    ) ||
    backgroundColorRendersUnstored ||
    textColorRendersUnstored

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

  // "Rendered, not stored" (`docs/features/inspector.md` §5.0's vocabulary,
  // generalized from a scalar field to a `PropertyList` row): the muted
  // fallback reads the SAME `currentStyles` bag every other popover body in
  // this file already threads through — no second value source. Computed
  // BEFORE the header actions / Law-1 empty check below, since both now need
  // to know whether the row is VISIBLE (stored or muted), not merely stored.
  const textMutedValue = !textStored && textColorRendersUnstored ? readString(currentStyles, 'color') : undefined
  const showTextEntry = textStored || textMutedValue !== undefined
  const textDisplayValue = (textStored ? textValue : textMutedValue) ?? ''
  // panel-32: is the muted value a REAL declaration elsewhere (base, or
  // another breakpoint/condition), as opposed to pure inheritance/UA
  // rendering with nothing declared anywhere? Drives the popover's
  // informational write-target note — never true while `textStored`.
  const textDeclaredElsewhere = !textStored && (provenanceByProperty.get('color')?.sources.length ?? 0) > 0

  const colorMutedValue =
    !colorStored && backgroundColorRendersUnstored ? readString(currentStyles, 'backgroundColor') : undefined
  const showColorEntry = colorStored || colorMutedValue !== undefined
  const colorDisplayValue = (colorStored ? colorValue : colorMutedValue) ?? ''
  const colorDeclaredElsewhere =
    !colorStored && (provenanceByProperty.get('backgroundColor')?.sources.length ?? 0) > 0

  // `STATE.md` panel-33: `writeTarget` decides refused vs. inline
  // (`ColorWriteRefusalBody` vs. `ColorFieldRow`); `computedValues` is the
  // frame's real `getComputedStyle` truth, the only honest paint for a
  // `var(--token)` value the admin's own document can't resolve
  // (`resolveSwatchColor` falls back to it only when nothing else parses);
  // `colorWriteTargetNote` is panel-32's "declared elsewhere" fact.
  const textWriteTarget = textStored ? null : model.writeTargetFor('color')
  const colorWriteTarget = colorStored ? null : model.writeTargetFor('backgroundColor')
  const textRefused = !textStored && textWriteTarget?.kind === 'none'
  const colorRefused = !colorStored && colorWriteTarget?.kind === 'none'
  const textResolvedColor = computedValues?.color
  const colorResolvedColor = computedValues?.backgroundColor
  const textNote = colorWriteTargetNote(textStored, textDeclaredElsewhere, textWriteTarget)
  const colorNote = colorWriteTargetNote(colorStored, colorDeclaredElsewhere, colorWriteTarget)

  // The background-layer stack, as the SELECTION sees it. A disagreeing
  // `background-image` has no shared stack at all; a disagreeing satellite
  // still sits on a stack everyone shares — see this file's MIXED doc.
  const layersMixed = isMixed(storedStyles.backgroundImage)
  const mixedSatellites = new Set<BackgroundSatelliteProp>(
    BACKGROUND_SATELLITE_PROPS.filter((prop) => isMixed(storedStyles[prop])),
  )

  const fillActions = (
    <FillSectionActions
      storedStyles={storedStyles}
      textVisible={showTextEntry}
      colorVisible={showColorEntry}
      layersMixed={layersMixed}
      onChange={onChange}
    />
  )

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
  // `layersMixed` owns the whole background block when it is true — the
  // satellites travel with it into that row's own popover, rather than
  // splitting the same disagreement across two rows.
  const orphanSatellites =
    !layersMixed &&
    parsedModel.spine.kind !== 'layers' &&
    (mixedSatellites.size > 0 ||
      BACKGROUND_SATELLITE_PROPS.some((prop) => parsedModel.satellites[prop].kind !== 'unset'))

  function write(next: BackgroundModel) {
    writeBackgroundModel(parsedModel, next, onChange)
  }

  const contentFitVisible = CONTENT_FIT_PROPS.some((prop) => hasStyleValue(storedStyles[prop]))
  const contentFitMixed = CONTENT_FIT_PROPS.some((prop) => isMixed(storedStyles[prop]))

  const shorthandMixed = isMixed(storedStyles.background)
  const shorthandValue = readString(storedStyles, 'background')
  const showShorthandEntry = hasStyleValue(storedStyles.background)

  // ---- entries ------------------------------------------------------------
  const entries: PropertyListEntry<FillEntryData>[] = []

  if (showTextEntry) {
    entries.push(
      buildColorFillEntry({
        id: 'fill-text', label: 'Text', property: 'color', data: { kind: 'text' },
        ariaLabel: 'Text colour', swatchLabel: 'Text colour swatch', opacityAriaLabel: 'Text colour opacity',
        displayValue: textDisplayValue, resolvedColor: textResolvedColor, refused: textRefused,
        mixed: textMixed, stored: textStored, mutedValue: textMutedValue, note: textNote,
        onCommit: onChange, onPreview: previewProperty, onClearPreview,
      }),
    )
  }

  if (contentFitVisible) {
    entries.push({
      id: 'fill-content-fit',
      label: 'Content fit',
      leading: <Image2SolidIcon size={14} aria-hidden="true" />,
      summary: 'Content fit',
      value: contentFitMixed ? MIXED_PLACEHOLDER : readString(storedStyles, 'objectFit'),
      data: { kind: 'contentFit' },
    })
  }

  // The layer block — its start index is what `handleReorder` clamps drags to.
  const layerStart = entries.length
  if (layersMixed) {
    entries.push(mixedLayersEntry())
  } else if (parsedModel.spine.kind === 'layers') {
    layers.forEach((image, index) => {
      const described = describeLayer(image, index, layers.length)
      entries.push({
        id: `fill-layer-${index}`,
        label: described.label,
        leading: described.leading,
        summary: described.summary,
        // Figma shows a fill's blend mode ON the fill row. `LayerBlendSelect`
        // explains why `background-blend-mode` is the only honest target.
        value: (
          <LayerBlendSelect
            model={parsedModel}
            index={index}
            mixed={mixedSatellites.has('backgroundBlendMode')}
            onModelChange={write}
          />
        ),
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
  // A mixed stack has no order to drag, so it contributes no reorderable rows.
  const layerCount = !layersMixed && parsedModel.spine.kind === 'layers' ? layers.length : 0

  if (showColorEntry) {
    entries.push(
      buildColorFillEntry({
        id: 'fill-color', label: 'Solid fill', property: 'backgroundColor', data: { kind: 'color' },
        ariaLabel: 'Solid fill colour', swatchLabel: 'Solid fill colour swatch', opacityAriaLabel: 'Solid fill opacity',
        displayValue: colorDisplayValue, resolvedColor: colorResolvedColor, refused: colorRefused,
        mixed: colorMixed, stored: colorStored, mutedValue: colorMutedValue, note: colorNote,
        onCommit: onChange, onPreview: previewProperty, onClearPreview,
      }),
    )
  }

  if (showShorthandEntry) {
    entries.push({
      id: 'fill-shorthand',
      label: 'Background shorthand',
      leading: <CodeIcon size={14} aria-hidden="true" />,
      summary: shorthandMixed ? MIXED_PLACEHOLDER : shorthandValue,
      data: { kind: 'shorthand' },
    })
  }

  function handleActivate(entry: PropertyListEntry<FillEntryData>, anchorRef: RefObject<HTMLElement | null>) {
    // `text`/`color` need this popover only when refused — a defensive
    // second layer behind `ColorFieldRow`'s own click guard.
    if (entry.data.kind === 'text' && !textRefused) return
    if (entry.data.kind === 'color' && !colorRefused) return
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
        // Defensive: `removable: false` already keeps `PropertyList` from
        // offering this button on a muted (not-stored) row — nothing to
        // remove, and a "remove" here must never fabricate an explicit
        // override the user never asked to store.
        if (textStored) onChange('color', undefined)
        break
      case 'color':
        if (colorStored) onChange('backgroundColor', undefined)
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
      case 'mixedLayers':
        // The whole background block travels with this row (its popover owns
        // the satellites too), so removing it clears the whole block from
        // every selected layer — one history entry, `setNodesInlineStyles`.
        clearSet(['backgroundImage', ...BACKGROUND_SATELLITE_PROPS])
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
          <FillEntryPopover
            entry={editingEntry}
            anchorRef={editing.anchorRef}
            onClose={() => setEditing(null)}
            parsedModel={parsedModel}
            mixedSatellites={mixedSatellites}
            shorthandMixed={shorthandMixed}
            textWriteTarget={textWriteTarget}
            colorWriteTarget={colorWriteTarget}
            textMutedValue={textMutedValue}
            colorMutedValue={colorMutedValue}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={contextKey}
            shorthandValue={shorthandValue}
            onModelChange={write}
            onChange={onChange}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
        )}
      </div>
    </Section>
  )
}
