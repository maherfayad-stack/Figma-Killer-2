/**
 * FillSectionParts — the Fill section's swatches and popover bodies.
 *
 * Split out of `FillSection.tsx` when G9's text-fill row landed and that file
 * reached the repo's 700-line module ceiling
 * (`module-size-budgets.test.ts`). `FillSection.tsx` decides which ROWS
 * exist; this file draws what opens when one is activated. The pure value
 * models both share are `fillModel.ts` (colour channels, gradient transforms)
 * and `backgroundLayers.ts` (the `background-image` layer stack and its
 * per-layer satellites) — both stay in `panels/PropertiesPanel/`, unchanged,
 * per `STATE.md` `panel-25`'s own instruction to reuse them verbatim; only
 * this file (the rendering) moved when Fill migrated to its own
 * `INSPECTOR_SECTIONS` manifest entry (P3 item 5).
 *
 * Components only — `react-refresh/only-export-components` is on for `src/`,
 * which is also why the transforms these editors call live in `fillModel.ts`
 * rather than beside them here. The Text/Solid-fill rows' OWN swatch and
 * inline chrome (`ColorFieldRow`, `ColorWriteRefusalBody`, `ColorSwatch`)
 * moved to `FillColorField.tsx` when panel-33 grew them enough to threaten
 * this file's own budget — see that file's doc for why they're not here.
 * `GradientEditor.tsx` left for the same reason when the Mixed contract
 * (`docs/features/inspector.md` §9.3) landed.
 */
import { type CSSProperties } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { cn } from '@ui/cn'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Select } from '@ui/components/Select'
import { ScrubInput } from '@ui/components/ScrubInput'
import { SelectControl } from '@site/property-controls/SelectControl'
import { TextControl } from '@site/property-controls/TextControl'
import { ClassPropertyRow } from '../../panels/PropertiesPanel/ClassPropertyRow'
import { hasStyleValue, pickMixedCell } from '../../panels/PropertiesPanel/styleValueUtils'
import { isMixed } from '@ui/components/MixedValue'
import { getEnumOptions } from '../../panels/PropertiesPanel/cssControlTypes'
import {
  BACKGROUND_SATELLITE_LABELS,
  BACKGROUND_SATELLITE_PROPS,
  BACKGROUND_SATELLITE_INITIALS,
  backgroundLayerSatellite,
  setBackgroundLayerSatellite,
  setBackgroundLayerImage,
  type BackgroundModel,
  type BackgroundSatelliteProp,
} from '../../panels/PropertiesPanel/backgroundLayers'
import {
  CONTENT_FIT_PROPS,
  DEFAULT_GRADIENT_FILL,
  parsePercentText,
} from '../../panels/PropertiesPanel/fillModel'
import {
  parseGradient,
  serializeGradient,
  isUrlImageValue,
  extractUrlPayload,
} from '../../panels/PropertiesPanel/gradientValue'
import { imageFillPreviewSrc, useProjectImageAssets } from '@site/studio/projectAssets'
import { formatColor, parseCssColor } from '@ui/components/ColorPickerPopover'
import { GradientEditor } from './GradientEditor'
import { ImageFillEditor } from './ImageFillEditorParts'
import styles from './FillSection.module.css'

// ---------------------------------------------------------------------------
// ColorOpacityField — the "% opacity" cell of the Fill row chrome
// (`02-measurements.md`'s "Color field chrome": swatch → hex → % opacity →
// remove, one 28px row). CSS has no separate "fill opacity" property the way
// Penpot's own object model does — the alpha channel already living INSIDE
// the colour value (`#rrggbbaa`, `rgba(...)`, `hsla(...)`) IS that number, so
// this field reads/writes it via `parseCssColor`/`formatColor`
// (`@ui/components/ColorPickerPopover`) rather than inventing a second,
// parallel opacity property. A value this module cannot parse — a
// `var(--token)` reference, `currentColor`, a colour function the parser
// doesn't cover — has no channel to read, so the field disables rather than
// guessing one (the same "never a guessed rewrite" rule this whole section
// already follows for the layer stack and the gradient parser).
// ---------------------------------------------------------------------------

export function ColorOpacityField({
  value,
  ariaLabel,
  onChange,
}: {
  value: string
  ariaLabel: string
  onChange: (next: string) => void
}) {
  const parsed = value.trim() === '' ? null : parseCssColor(value)
  const percent = parsed ? Math.round(parsed.rgba.a * 100) : undefined

  function commit(text: string) {
    if (!parsed) return
    const next = parsePercentText(text)
    if (next === undefined) return
    const alpha = Math.max(0, Math.min(100, next)) / 100
    onChange(formatColor({ ...parsed.rgba, a: alpha }, parsed.model))
  }

  return (
    // Stops the click from bubbling to `PropertyList`'s row `onActivate` —
    // this field commits without opening the row's popover, exactly like the
    // remove button beside it.
    <span
      className={styles.opacityFieldGuard}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <ScrubInput
        fieldSize="sm"
        label={<span aria-hidden="true">%</span>}
        aria-label={ariaLabel}
        value={percent !== undefined ? String(percent) : undefined}
        unit="%"
        min={0}
        max={100}
        disabled={parsed === null}
        onChange={commit}
        className={styles.opacityField}
      />
    </span>
  )
}

/**
 * The leading glyph for one background layer. A gradient paints itself. A
 * `url()` does NOT: the admin is a different origin from the user's dev
 * server, so the written URL (`/hero.png`) would 404 here even though it is
 * exactly right in their repo. `imageFillPreviewSrc` maps it back to the file
 * on disk and previews it through the authenticated read endpoint; when it
 * maps to nothing (a remote host that is down, a path not in this project)
 * the swatch stays an empty well rather than a broken-image glyph.
 */
export function ImageSwatch({ image }: { image: string }) {
  const assets = useProjectImageAssets()
  const isUrl = isUrlImageValue(image)
  const previewSrc = isUrl ? imageFillPreviewSrc(extractUrlPayload(image), assets) : undefined
  const cssImage = isUrl ? (previewSrc ? `url(${JSON.stringify(previewSrc)})` : 'none') : image

  return (
    <span
      className={cn(styles.swatch, styles.swatchImage)}
      style={{ '--fill-swatch-image': cssImage } as CSSProperties}
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
  /**
   * The satellites whose STORED cell is the multi-selection `MIXED` sentinel
   * — see `LayerSatelliteRow`'s own doc for why a mixed satellite cannot be
   * spliced per layer. Empty for a single selection.
   */
  mixedSatellites: ReadonlySet<BackgroundSatelliteProp>
  /** Applies a whole `background-*` patch at once (see `FillSection`'s `applyPatch`). */
  onModelChange: (next: BackgroundModel) => void
  /** Raw edit of a satellite this module refused to split per layer. */
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

type ImageFillMode = 'gradient' | 'image'

export function BackgroundLayerPopoverBody({
  model,
  index,
  mixedSatellites,
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
        <ImageFillEditor model={model} index={index} value={value} onModelChange={onModelChange} onImageChange={setImage} />
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
        {popoverSatelliteProps(model, index, mixedSatellites).map((prop) => (
          <LayerSatelliteRow
            key={prop}
            model={model}
            index={index}
            prop={prop}
            mixed={mixedSatellites.has(prop)}
            onModelChange={onModelChange}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Which satellites the layer popover still draws. `background-blend-mode` is
 * NOT one of them: it moved out to the layer's own row (`LayerBlendSelect`),
 * where Figma puts a fill's blend mode — visible without opening anything,
 * beside the fill it composites. It comes BACK here only when the declaration
 * could not be split per layer, because the row's per-layer select would then
 * have nothing honest to write and the raw text field is the only edit left.
 * A MIXED blend mode comes back here for exactly the same reason.
 */
function popoverSatelliteProps(
  model: BackgroundModel,
  index: number,
  mixedSatellites: ReadonlySet<BackgroundSatelliteProp>,
): ReadonlyArray<BackgroundSatelliteProp> {
  return BACKGROUND_SATELLITE_PROPS.filter(
    (prop) =>
      prop !== 'backgroundBlendMode' ||
      mixedSatellites.has(prop) ||
      backgroundLayerSatellite(model, prop, index).kind === 'raw',
  )
}

/**
 * One fill layer's blend mode, on the layer's own row.
 *
 * `mix-blend-mode` is the ELEMENT's blend against what is behind it and lives
 * in the Layer section; there is no CSS property that blends one fill of an
 * element against another fill of the same element in general. What CSS does
 * have — and what Figma's per-fill Blend really maps onto here — is
 * `background-blend-mode`: a per-layer list composited within the element's
 * own background stack. So this control appears on `background-image` layer
 * rows only, and the Text / Content-fit / Solid-fill rows deliberately have no
 * blend control at all rather than a decorative one that writes the
 * element-level property behind the user's back.
 *
 * Writing one layer's blend emits the whole list — CSS has no "leave the other
 * layers alone" syntax, so the untouched layers are written with the initial
 * the browser was already using (`setBackgroundLayerSatellite`). When the
 * declared list is shorter than the layer count CSS repeats it cyclically,
 * which means the value is not this layer's alone; the select says so in its
 * title rather than letting the edit surprise the user.
 */
export function LayerBlendSelect({
  model,
  index,
  mixed = false,
  onModelChange,
}: {
  model: BackgroundModel
  index: number
  /**
   * The selection disagrees on `background-blend-mode`. There is no shared
   * list to splice one layer of, so the row's select states "Mixed" and
   * disables; the whole declaration is editable in the layer's popover, the
   * same route a refused (`raw`) list already takes.
   */
  mixed?: boolean
  onModelChange: (next: BackgroundModel) => void
}) {
  const view = backgroundLayerSatellite(model, 'backgroundBlendMode', index)
  const keywords = getEnumOptions('backgroundBlendMode') ?? []
  const shared = view.kind === 'value' && view.shared
  const refused = view.kind === 'raw' ? view.reason : undefined
  const blockedReason = mixed
    ? 'The selected layers set different background-blend-mode values — open this layer to write one to all of them.'
    : refused

  return (
    // The row itself is clickable (`PropertyList` opens the layer popover), so
    // the select is guarded the same way `ColorFieldRow`'s own input is.
    <span
      className={styles.layerBlendGuard}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
    <Select
      fieldSize="xs"
      aria-label={`Blend mode, layer ${index + 1}`}
      mixed={mixed}
      title={
        blockedReason ??
        (shared ? 'This background-blend-mode is shared by every layer — editing it splits the list.' : undefined)
      }
      disabled={blockedReason != null}
      value={view.kind === 'value' ? view.value : ''}
      options={[
        { value: '', label: BACKGROUND_SATELLITE_INITIALS.backgroundBlendMode },
        ...keywords.map((keyword) => ({ value: keyword, label: keyword })),
      ]}
      className={styles.layerBlendSelect}
      data-testid={`fill-layer-${index}-blend`}
      onChange={(e) =>
        onModelChange(setBackgroundLayerSatellite(model, 'backgroundBlendMode', index, e.target.value || undefined))
      }
    />
    </span>
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
 *
 * A MIXED satellite takes the third shape for the same reason, one level up:
 * the selected nodes declare different lists, so the model this row was
 * parsed from holds none of them. Splicing index N of a list that does not
 * exist would write the CSS initial into every other layer of every selected
 * node — the "one keystroke flattens a disagreement" bug class
 * (`docs/features/inspector.md` §9.3). So the field writes the WHOLE
 * declaration to every selected node instead, and says "Mixed" until it does.
 */
function LayerSatelliteRow({
  model,
  index,
  prop,
  mixed,
  onModelChange,
  onChange,
}: {
  model: BackgroundModel
  index: number
  prop: BackgroundSatelliteProp
  mixed: boolean
  onModelChange: (next: BackgroundModel) => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}) {
  const view = backgroundLayerSatellite(model, prop, index)
  const name = BACKGROUND_SATELLITE_LABELS[prop]
  const propKey = `bg-layer-${index}-${prop}`

  if (mixed) {
    return (
      <div className={styles.refusalNote}>
        <p className={styles.refusalText}>
          {name}: the selected layers disagree. Typing here writes one value to every selected
          layer.
        </p>
        <Input
          fieldSize="sm"
          monospace
          mixed
          value=""
          aria-label={`${name}, every selected layer`}
          onChange={(e) => onChange(prop, e.target.value || undefined)}
        />
      </div>
    )
  }

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
// Background declarations edited WHOLE — no layer index to splice into
// ---------------------------------------------------------------------------

/** Why this body is being shown instead of a per-layer control. */
export type BackgroundWholeReason = 'refused-layers' | 'no-layer' | 'mixed-layers'

const BACKGROUND_WHOLE_NOTES: Record<BackgroundWholeReason, string> = {
  'refused-layers':
    'The background-image above is edited as raw text, so these cannot be split per layer. Each one edits as a whole declaration.',
  'no-layer':
    'These size and place a background image, but this element has none — CSS ignores them until a background-image layer exists.',
  'mixed-layers':
    'The selected layers set different background images, so there is no shared layer stack to edit. Each declaration below writes one value to every selected layer.',
}

/**
 * The background declarations with no layer ROW to live in. Three reasons,
 * one shape, because the honest write is identical in all three — the whole
 * declaration, never a per-layer splice:
 *
 *   - `no-layer` — the element has no `background-image` at all
 *     (`background-size: cover` on its own is inert CSS, but it IS in the
 *     user's file and must never become invisible in the inspector);
 *   - `refused-layers` — the layer list itself was refused
 *     (`backgroundLayers.ts`), so there is no index to hang them off;
 *   - `mixed-layers` — a multi-selection whose members declare different
 *     lists (`docs/features/inspector.md` §9.3). `ClassPropertyRow` renders
 *     the `MIXED` sentinel as an empty field with a "Mixed" placeholder, so
 *     the disagreement is stated rather than flattened.
 *
 * `properties` is the caller's, because the mixed case also offers
 * `background-image` itself while the other two draw it as their own row.
 */
export function BackgroundDeclarationsBody({
  reason,
  properties,
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onPreview,
  onClearPreview,
}: {
  reason: BackgroundWholeReason
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}) {
  return (
    <div className={styles.popoverBody}>
      <p className={styles.refusalText}>{BACKGROUND_WHOLE_NOTES[reason]}</p>
      {properties
        .filter((prop) => hasStyleValue(storedStyles[prop]))
        .map((prop) => (
          <ClassPropertyRow
            key={`${activeTab}-${String(prop)}`}
            property={prop}
            value={pickMixedCell(storedStyles[prop])}
            isSet
            layout="stacked"
            onChange={onChange}
            onRemove={(property) => onChange(property, undefined)}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            placeholder={isMixed(currentStyles[prop]) ? undefined : (currentStyles[prop] as string | undefined)}
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
        // `pickMixedCell` rather than a cast: for a multi-selection that
        // disagrees the cell IS the `MIXED` Symbol, and `ClassPropertyRow`
        // normalizes it into its controls' `mixed` flag.
        const placeholder = currentStyles[prop]
        return (
          <ClassPropertyRow
            key={`${activeTab}-${String(prop)}`}
            property={prop}
            value={isSet ? pickMixedCell(storedValue) : undefined}
            placeholder={isSet || isMixed(placeholder) ? undefined : (placeholder as string | undefined)}
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
// Raw escape hatches — the `background` shorthand, and a refused layer list
// ---------------------------------------------------------------------------

interface ShorthandEscapeHatchBodyProps {
  value: string | undefined
  /** The selection disagrees on `background` — empty field, "Mixed" placeholder. */
  mixed?: boolean
  onChange: (value: string) => void
}

export function ShorthandEscapeHatchBody({ value, mixed = false, onChange }: ShorthandEscapeHatchBodyProps) {
  return (
    <div className={styles.refusalNote}>
      <p className={styles.refusalText}>
        This element uses the <code>background</code> shorthand, which can combine colour, image,
        position, size and repeat in one declaration. Splitting it into separate Fill rows risks
        silently dropping part of it, so it stays here as raw CSS instead of a lookalike editor.
        {mixed ? ' The selected layers disagree — typing here writes one value to all of them.' : ''}
      </p>
      <Input
        fieldSize="sm"
        monospace
        mixed={mixed}
        value={mixed ? '' : (value ?? '')}
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

