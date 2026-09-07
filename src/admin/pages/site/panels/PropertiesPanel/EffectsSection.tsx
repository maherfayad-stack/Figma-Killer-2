/**
 * EffectsSection — F13/F20/F21/F22's list-of-effects shape
 * (docs/features/inspector-disclosure.md §4 G8).
 *
 * Two exports:
 *
 *   - `EffectsSectionActions` — the section header's ⚙ (transform /
 *     transformOrigin, Law 2 — a transform is not an effect in Figma's
 *     sense and stays raw-text, edited by people who know the syntax, see
 *     this file's "SETTINGS POPOVER" doc below) and the "+"
 *     that opens F20's typed add menu. `StyleSectionsEditor` mounts this in
 *     `Section`'s `actions` slot, in BOTH the collapsed-empty header and the
 *     open-body header — unlike Appearance's header actions (which only
 *     exist once Appearance is open, because Appearance is never
 *     `collapsedWhenEmpty`), Effects needs its "+" reachable even at the
 *     one-line Law-1 rest state, since that's the ONLY way to add a first
 *     effect. `SectionStylesMenu` (F22) is unaffected — `StyleSectionsEditor`
 *     already renders it in the same `actions` slot; nothing here replaces it.
 *   - `EffectsSection` — the body: one `PropertyList` (`@ui/components/PropertyList`)
 *     whose rows are, in order, the `box-shadow` layers (each a drop or inner
 *     shadow), the `text-shadow` layers, a `filter: blur()` row ("Layer
 *     blur"), and a `backdrop-filter: blur()` row ("Background blur"). Renders nothing
 *     (Law 1) when the list is empty — `StyleSectionsEditor`'s existing Law-1
 *     machinery already skips mounting this component at all when NOTHING in
 *     the section is set; PropertyList's own empty-render covers the
 *     remaining case where e.g. `transform` is set but no shadow/blur is.
 *
 * SHADOW MODELLING (the core of this work order)
 * ------------------------------------------------
 * `box-shadow` is a comma-separated list; `boxShadowLayers.ts` parses it into
 * `BoxShadowLayer[]` and re-serialises byte-for-byte. When a stored value
 * parses AND round-trips, each layer becomes its own `PropertyList` row,
 * editable via `EffectEditorPopover`'s F21 fields. When it does NOT (an
 * unsupported shape, or one that would be reformatted), the WHOLE value
 * renders as one raw-text row instead of guessing at a split — never a
 * partial parse. Same treatment for `filter`/`backdropFilter`: a value that
 * is exactly `blur(<length>)` gets a structured radius row; anything else
 * (multiple filter functions, a non-blur function) stays raw text. Both are
 * real, editable rows — never dropped.
 *
 * `textShadow` rides the SAME parser through `TEXT_SHADOW_GRAMMAR`, which
 * narrows it to three lengths and no `inset` — a text shadow is a shadow, and
 * modelling it as a second, near-identical layer type would have been a copy
 * of the hard part (the round-trip refusal) for no gain. Its rows open the
 * same F21 popover in `variant: 'text'`, which omits Spread and Inset because
 * `text-shadow` has neither.
 *
 * SETTINGS POPOVER vs `RotationRow` (`PositionSection.tsx`) — coexistence
 * ------------------------------------------------------------------------
 * `RotationRow` writes the STANDALONE `rotate` property for the common case,
 * and falls back to a raw `transform` field only when `transform` already
 * contains a rotate-family function (so it never adds a second, silently
 * compounding rotation). This section's ⚙ ALSO exposes a raw `transform`
 * field (plus `transformOrigin`) unconditionally —
 * the two surfaces do not contradict each other because they write the exact
 * same `storedStyles.transform` through the exact same `onChange`: Position's
 * row is the typed front door for the 90% case (pure rotation, no other
 * transform function), and this section's ⚙ is the one raw-text escape hatch
 * for `transform` as a whole, for the case Position's row explicitly refuses
 * to touch. There is only ever one property being written to; there are two
 * doors into it, and the doc comments on both sides say so.
 *
 * `textShadow` moved here from `TypographySection.tsx` in W8-1, finishing G9's
 * target shape (`docs/features/inspector-disclosure.md` §4 G9). It is claimed
 * by this section in `classStyleSections.ts` — exactly one section owns a
 * property, because that array drives the "N set" count and the style search.
 */
import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import {
  appendBoxShadowLayer,
  createDefaultBoxShadowLayer,
  createDefaultTextShadowLayer,
  parseShadowValue,
  removeBoxShadowLayer,
  reorderBoxShadowLayers,
  serializeBoxShadowLayer,
  serializeBoxShadowLayers,
  updateBoxShadowLayer,
  TEXT_SHADOW_GRAMMAR,
  type BoxShadowLayer,
} from './boxShadowLayers'
import { EffectEditorPopover, type EffectEditorTarget } from './EffectEditorPopover'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import { hasStyleValue, readString } from './styleValueUtils'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './EffectsSection.module.css'

// ---------------------------------------------------------------------------
// filter / backdrop-filter — accept ONLY a lone `blur(<length>)`. Anything
// else (a second filter function, a non-blur function) is real CSS this
// module refuses to restructure — same honest-refusal posture as box-shadow.
// ---------------------------------------------------------------------------

const BLUR_FN_RE = /^blur\(\s*(.+?)\s*\)$/i

function parseBlurRadius(value: string): string | undefined {
  const match = BLUR_FN_RE.exec(value.trim())
  return match ? match[1] : undefined
}

// ---------------------------------------------------------------------------
// EffectsSectionActions — header ⚙ + "+" (see module doc)
// ---------------------------------------------------------------------------

// `transition`/`animation` left for the Animations section (W5-5), which
// gives both a typed surface instead of a raw text field. A property may be
// claimed by exactly one section — the registry's `properties` array drives
// the "N set" count and the style search, so listing motion here as well
// would count it twice and show it twice.
const ADVANCED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'transform',
  'transformOrigin',
]

const ADVANCED_SPEC: ReadonlyArray<StackedGridEntry> = [['transform', 'transformOrigin']]

interface EffectsSectionActionsProps {
  activeTab: string
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function EffectsSectionActions({
  activeTab,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: EffectsSectionActionsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addTriggerRef = useRef<HTMLButtonElement>(null)

  const advancedSetCount = ADVANCED_PROPERTIES.filter((prop) => hasStyleValue(storedStyles[prop])).length
  // `filter`/`backdrop-filter` model at most ONE structured blur entry each
  // (see `EffectsSection`'s module doc) — once either is set (structured or
  // raw), the corresponding "add" menu item is disabled rather than silently
  // overwriting or space-joining onto whatever the user already has there.
  const layerBlurDisabled = readString(storedStyles, 'filter') != null
  const backgroundBlurDisabled = readString(storedStyles, 'backdropFilter') != null

  function addShadow(inset: boolean) {
    const layerCss = serializeBoxShadowLayer(createDefaultBoxShadowLayer(inset))
    onChange('boxShadow', appendBoxShadowLayer(storedStyles.boxShadow as string | number | undefined, layerCss))
    setAddMenuOpen(false)
  }

  function addTextShadow() {
    const layerCss = serializeBoxShadowLayer(createDefaultTextShadowLayer())
    onChange('textShadow', appendBoxShadowLayer(storedStyles.textShadow as string | number | undefined, layerCss))
    setAddMenuOpen(false)
  }

  function addLayerBlur() {
    onChange('filter', 'blur(4px)')
    setAddMenuOpen(false)
  }

  function addBackgroundBlur() {
    onChange('backdropFilter', 'blur(4px)')
    setAddMenuOpen(false)
  }

  return (
    <>
      <Button
        ref={settingsTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        pressed={advancedSetCount > 0}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        aria-label="Effects settings"
        tooltip="Transform & transform origin"
        data-testid="effects-settings-trigger"
        onClick={() => setSettingsOpen((open) => !open)}
      >
        <SlidersHorizontalIcon size={14} aria-hidden="true" />
      </Button>
      {advancedSetCount > 0 && (
        <span className={styles.settingsBadge} data-testid="effects-settings-badge">
          {advancedSetCount}
        </span>
      )}
      {settingsOpen && (
        <InspectorPopover
          id="effects-settings"
          anchorRef={settingsTriggerRef}
          onClose={() => setSettingsOpen(false)}
          title="Effects settings"
          width={248}
        >
          <StackedPropertyGrid
            spec={ADVANCED_SPEC}
            visibleProperties={ADVANCED_PROPERTIES}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}
      <Button
        ref={addTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={addMenuOpen}
        aria-label="Add effects"
        tooltip="Add effect"
        data-testid="class-style-section-add-effects"
        onClick={() => setAddMenuOpen((open) => !open)}
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {addMenuOpen && (
        <ContextMenu
          ariaLabel="Add effect"
          anchorRef={addTriggerRef}
          triggerRef={addTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          onClose={() => setAddMenuOpen(false)}
        >
          <ContextMenuItem onClick={() => addShadow(false)}>Drop shadow</ContextMenuItem>
          <ContextMenuItem onClick={() => addShadow(true)}>Inner shadow</ContextMenuItem>
          <ContextMenuItem onClick={addTextShadow}>Text shadow</ContextMenuItem>
          <ContextMenuItem disabled={layerBlurDisabled} onClick={addLayerBlur}>
            Layer blur
          </ContextMenuItem>
          <ContextMenuItem disabled={backgroundBlurDisabled} onClick={addBackgroundBlur}>
            Background blur
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// EffectsSection body
// ---------------------------------------------------------------------------

type EffectEntryData =
  | { kind: 'shadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'boxShadowRaw'; raw: string; reason: string }
  | { kind: 'textShadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'textShadowRaw'; raw: string; reason: string }
  | { kind: 'layerBlur'; radius: string }
  | { kind: 'layerBlurRaw'; raw: string }
  | { kind: 'backgroundBlur'; radius: string }
  | { kind: 'backgroundBlurRaw'; raw: string }

interface EffectsSectionProps {
  /**
   * Kept in the prop shape for parity with every other curated section
   * `StyleSectionsEditor` mounts identically — NOT read here. Fill/stroke/
   * effect LIST rows are additive items with no meaningful "inherited from
   * base" placeholder the way a plain property field has, so there is
   * nothing for `currentStyles` to resolve for this section's rows. Same
   * reasoning covers `activeTab`: the caller already remounts this whole
   * component on tab change via `key={activeTab}`, so nothing inside needs
   * it for its own remount-on-tab-switch keying.
   */
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Track F1 — threaded into each row's `EffectEditorPopover` (structured rows get it via the raw fallback's reused `ClassPropertyRow`; see `resolveEditorTarget`). */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

function ShadowSwatch({ layer }: { layer: BoxShadowLayer }) {
  const style = { '--effect-swatch-color': layer.color || 'var(--overlay-30)' } as CSSProperties
  return <span className={layer.inset ? styles.swatchInset : styles.swatch} style={style} aria-hidden="true" />
}

export function EffectsSection({
  storedStyles,
  visibleProperties,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  provenanceByProperty,
}: EffectsSectionProps) {
  const visible = new Set(visibleProperties)
  // The anchor ref comes from `PropertyList`'s `onActivate` and is stored as
  // plain STATE (not a `useRef` map read during render) — React Compiler's
  // ref-during-render rule forbids dereferencing a ref's `.current` while
  // rendering, and reading a `Map` out of a `useRef` to look up an entry's
  // anchor would be exactly that. Storing the `RefObject` itself as a state
  // value sidesteps it: nothing here ever reads `.current`, it's just handed
  // down to `EffectEditorPopover`, which dereferences it in its own effects.
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(
    null,
  )

  const boxShadowResult = parseShadowValue(
    visible.has('boxShadow') ? (storedStyles.boxShadow as string | number | undefined) : undefined,
  )

  const textShadowResult = parseShadowValue(
    visible.has('textShadow') ? (storedStyles.textShadow as string | number | undefined) : undefined,
    TEXT_SHADOW_GRAMMAR,
  )

  const filterRaw = visible.has('filter') ? readString(storedStyles, 'filter') : undefined
  const filterBlurRadius = filterRaw != null ? parseBlurRadius(filterRaw) : undefined

  const backdropRaw = visible.has('backdropFilter') ? readString(storedStyles, 'backdropFilter') : undefined
  const backdropBlurRadius = backdropRaw != null ? parseBlurRadius(backdropRaw) : undefined

  const entries: PropertyListEntry<EffectEntryData>[] = []

  if (boxShadowResult.kind === 'layers') {
    boxShadowResult.layers.forEach((layer, index) => {
      const kindLabel = layer.inset ? 'Inner shadow' : 'Drop shadow'
      entries.push({
        id: `shadow-${index}`,
        label: `${kindLabel} ${index + 1}`,
        leading: <ShadowSwatch layer={layer} />,
        summary: kindLabel,
        value: layer.color || undefined,
        data: { kind: 'shadowLayer', index, layer },
      })
    })
  } else if (boxShadowResult.kind === 'raw') {
    entries.push({
      id: 'shadow-raw',
      label: 'Box shadow',
      summary: 'Box shadow',
      value: boxShadowResult.raw,
      data: { kind: 'boxShadowRaw', raw: boxShadowResult.raw, reason: boxShadowResult.reason },
    })
  }

  if (textShadowResult.kind === 'layers') {
    textShadowResult.layers.forEach((layer, index) => {
      entries.push({
        id: `text-shadow-${index}`,
        label: `Text shadow ${index + 1}`,
        leading: <ShadowSwatch layer={layer} />,
        summary: 'Text shadow',
        value: layer.color || undefined,
        data: { kind: 'textShadowLayer', index, layer },
      })
    })
  } else if (textShadowResult.kind === 'raw') {
    entries.push({
      id: 'text-shadow-raw',
      label: 'Text shadow',
      summary: 'Text shadow',
      value: textShadowResult.raw,
      data: { kind: 'textShadowRaw', raw: textShadowResult.raw, reason: textShadowResult.reason },
    })
  }

  if (filterBlurRadius !== undefined) {
    entries.push({
      id: 'layer-blur',
      label: 'Layer blur',
      summary: 'Layer blur',
      value: filterBlurRadius,
      data: { kind: 'layerBlur', radius: filterBlurRadius },
    })
  } else if (filterRaw != null) {
    entries.push({
      id: 'filter-raw',
      label: 'Filter',
      summary: 'Filter',
      value: filterRaw,
      data: { kind: 'layerBlurRaw', raw: filterRaw },
    })
  }

  if (backdropBlurRadius !== undefined) {
    entries.push({
      id: 'background-blur',
      label: 'Background blur',
      summary: 'Background blur',
      value: backdropBlurRadius,
      data: { kind: 'backgroundBlur', radius: backdropBlurRadius },
    })
  } else if (backdropRaw != null) {
    entries.push({
      id: 'backdrop-raw',
      label: 'Backdrop filter',
      summary: 'Backdrop filter',
      value: backdropRaw,
      data: { kind: 'backgroundBlurRaw', raw: backdropRaw },
    })
  }

  function handleActivate(entry: PropertyListEntry<EffectEntryData>, anchorRef: RefObject<HTMLElement | null>) {
    setEditing({ id: entry.id, anchorRef })
  }

  function handleRemove(entry: PropertyListEntry<EffectEntryData>) {
    const { data } = entry
    if (data.kind === 'shadowLayer') {
      if (boxShadowResult.kind !== 'layers') return
      const next = removeBoxShadowLayer(boxShadowResult.layers, data.index)
      if (next.length === 0) onRemove('boxShadow')
      else onChange('boxShadow', serializeBoxShadowLayers(next))
      return
    }
    if (data.kind === 'boxShadowRaw') {
      onRemove('boxShadow')
      return
    }
    if (data.kind === 'textShadowLayer') {
      if (textShadowResult.kind !== 'layers') return
      const next = removeBoxShadowLayer(textShadowResult.layers, data.index)
      if (next.length === 0) onRemove('textShadow')
      else onChange('textShadow', serializeBoxShadowLayers(next))
      return
    }
    if (data.kind === 'textShadowRaw') {
      onRemove('textShadow')
      return
    }
    if (data.kind === 'layerBlur' || data.kind === 'layerBlurRaw') {
      onRemove('filter')
      return
    }
    onRemove('backdropFilter')
  }

  function handleReorder(fromIndex: number, toIndex: number) {
    // `entries` is built in blocks: the `box-shadow` layers first, then the
    // `text-shadow` layers, then the blur rows. Only a drag whose BOTH
    // endpoints sit inside one layer block means anything — layer order is
    // paint order within a single property, and there is no sense in which a
    // text shadow can be dragged above a box shadow (they are two separate
    // declarations). Everything else, including the blur rows (at most one of
    // each, no order semantics), is a no-op.
    const boxCount = boxShadowResult.kind === 'layers' ? boxShadowResult.layers.length : 0
    const textCount = textShadowResult.kind === 'layers' ? textShadowResult.layers.length : 0

    if (boxShadowResult.kind === 'layers' && fromIndex < boxCount && toIndex < boxCount) {
      if (fromIndex < 0 || toIndex < 0) return
      onChange('boxShadow', serializeBoxShadowLayers(reorderBoxShadowLayers(boxShadowResult.layers, fromIndex, toIndex)))
      return
    }

    const textStart = boxCount
    const textEnd = boxCount + textCount
    if (
      textShadowResult.kind === 'layers' &&
      fromIndex >= textStart &&
      fromIndex < textEnd &&
      toIndex >= textStart &&
      toIndex < textEnd
    ) {
      const next = reorderBoxShadowLayers(textShadowResult.layers, fromIndex - textStart, toIndex - textStart)
      onChange('textShadow', serializeBoxShadowLayers(next))
    }
  }

  const editingEntry = editing ? entries.find((entry) => entry.id === editing.id) : undefined
  const editorTarget = editingEntry ? resolveEditorTarget(editingEntry.data, editingEntry.label) : null

  function resolveEditorTarget(data: EffectEntryData, label: string): EffectEditorTarget {
    switch (data.kind) {
      case 'shadowLayer':
        return {
          kind: 'shadow',
          label,
          layer: data.layer,
          onSave: (nextLayer) => {
            if (boxShadowResult.kind !== 'layers') return
            const next = updateBoxShadowLayer(boxShadowResult.layers, data.index, nextLayer)
            onChange('boxShadow', serializeBoxShadowLayers(next))
          },
          onPreview: onPreview
            ? (previewLayer) => {
                if (boxShadowResult.kind !== 'layers') return
                const next = updateBoxShadowLayer(boxShadowResult.layers, data.index, previewLayer)
                onPreview({ boxShadow: serializeBoxShadowLayers(next) })
              }
            : undefined,
          onClearPreview,
        }
      case 'layerBlur':
        return {
          kind: 'blur',
          label: 'Layer blur',
          radius: data.radius,
          onSave: (radius) => onChange('filter', `blur(${radius})`),
          onPreview: onPreview ? (radius) => onPreview({ filter: `blur(${radius})` }) : undefined,
          onClearPreview,
        }
      case 'backgroundBlur':
        return {
          kind: 'blur',
          label: 'Background blur',
          radius: data.radius,
          onSave: (radius) => onChange('backdropFilter', `blur(${radius})`),
          onPreview: onPreview ? (radius) => onPreview({ backdropFilter: `blur(${radius})` }) : undefined,
          onClearPreview,
        }
      case 'textShadowLayer':
        return {
          kind: 'shadow',
          label,
          // `text-shadow` has no spread and no inset — the editor must not
          // offer two fields whose writes CSS would discard.
          variant: 'text',
          layer: data.layer,
          onSave: (nextLayer) => {
            if (textShadowResult.kind !== 'layers') return
            const next = updateBoxShadowLayer(textShadowResult.layers, data.index, nextLayer)
            onChange('textShadow', serializeBoxShadowLayers(next))
          },
          onPreview: onPreview
            ? (previewLayer) => {
                if (textShadowResult.kind !== 'layers') return
                const next = updateBoxShadowLayer(textShadowResult.layers, data.index, previewLayer)
                onPreview({ textShadow: serializeBoxShadowLayers(next) })
              }
            : undefined,
          onClearPreview,
        }
      case 'textShadowRaw':
        return {
          kind: 'raw',
          label: 'Text shadow',
          property: 'textShadow',
          value: data.raw,
          reason: data.reason,
          onChange,
          onRemove,
          onPreview: onPreview
            ? (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
            : undefined,
          onClearPreview,
          provenance: provenanceByProperty?.get('textShadow'),
        }
      case 'boxShadowRaw':
        return {
          kind: 'raw',
          label: 'Box shadow',
          property: 'boxShadow',
          value: data.raw,
          reason: data.reason,
          onChange,
          onRemove,
          onPreview: onPreview
            ? (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
            : undefined,
          onClearPreview,
          provenance: provenanceByProperty?.get('boxShadow'),
        }
      case 'layerBlurRaw':
        return {
          kind: 'raw',
          label: 'Filter',
          property: 'filter',
          value: data.raw,
          reason: 'This filter is more than a single blur(), so it stays as text.',
          onChange,
          onRemove,
          onPreview: onPreview
            ? (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
            : undefined,
          onClearPreview,
          provenance: provenanceByProperty?.get('filter'),
        }
      case 'backgroundBlurRaw':
        return {
          kind: 'raw',
          label: 'Backdrop filter',
          property: 'backdropFilter',
          value: data.raw,
          reason: 'This backdrop-filter is more than a single blur(), so it stays as text.',
          onChange,
          onRemove,
          onPreview: onPreview
            ? (property, value) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
            : undefined,
          onClearPreview,
          provenance: provenanceByProperty?.get('backdropFilter'),
        }
    }
  }

  return (
    <>
      <PropertyList
        listLabel="Effects"
        entries={entries}
        onActivate={handleActivate}
        onRemove={handleRemove}
        onReorder={handleReorder}
      />
      {editorTarget && editing && (
        <EffectEditorPopover
          id={`effect-${editing.id}`}
          anchorRef={editing.anchorRef}
          onClose={() => setEditing(null)}
          target={editorTarget}
        />
      )}
    </>
  )
}
