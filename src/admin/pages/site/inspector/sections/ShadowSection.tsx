/**
 * ShadowSection — Penpot's Shadow section (`STATE.md` `panel-25`, item 7 of
 * the P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3). Split out of the
 * legacy `panels/PropertiesPanel/EffectsSection.tsx`, which used to render
 * `box-shadow` + `text-shadow` + `filter: blur()` + `backdrop-filter: blur()`
 * as one combined `PropertyList` — this section claims ONLY the two shadow
 * properties; `filter`/`backdropFilter` moved to `BlurSection.tsx` (item 8),
 * migrated in the SAME PR because both split out of the one old file and
 * `EffectsSection.tsx` is only deleted once both have landed (`STATE.md`
 * `panel-25`'s own mapping-table note for items 7-8).
 *
 * Reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`, the same pattern every migrated section
 * (Layer/Align/Measures/Layout/Fill/Stroke) already established: takes no
 * props, renders `null` on no selection.
 *
 * ## SHADOW MODELLING — unchanged from the pre-migration file
 *
 * `box-shadow` is a comma-separated list; `boxShadowLayers.ts` (moved here
 * verbatim — its only caller moved with it, same precedent `AlignSection.tsx`
 * set for `resolveAlignWrite.ts`) parses it into `BoxShadowLayer[]` and
 * re-serialises byte-for-byte. When a stored value parses AND round-trips,
 * each layer becomes its own `PropertyList` row, editable via this file's own
 * `ShadowEditorPopover` (F21 fields: X, Y, Blur, Spread, Colour, inset). When
 * it does NOT (an unsupported shape, or one that would be reformatted), the
 * WHOLE value renders as one raw-text row instead of guessing at a split —
 * never a partial parse (the "never a guessed rewrite" rule this whole panel
 * follows, see `CLAUDE.md` §"Studio-specific").
 *
 * `textShadow` rides the SAME parser through `TEXT_SHADOW_GRAMMAR`, which
 * narrows it to three lengths and no `inset` — a text shadow is a shadow, and
 * modelling it as a second, near-identical layer type would have been a copy
 * of the hard part (the round-trip refusal) for no gain. Its rows open the
 * same popover in `variant: 'text'`, which omits Spread and Inset because
 * `text-shadow` has neither.
 *
 * ## LAW 1 / RULE 2 — the "+" writes a real value immediately, same as Fill
 *
 * Penpot's own SHADOW header renders as a single `32px` collapsed-empty row
 * (title + trailing "+", no chevron — `screenshots/f1-rectangle/dark/
 * design.png`, confirmed directly: SHADOW and BLUR both render this way on a
 * fixture with fill/stroke/radius set but no shadow/blur). `03-operating-
 * behaviors.md`'s own "Add-property writes a real value" note names Shadow
 * explicitly as one of the sections where clicking Penpot's own "+" both
 * reveals AND writes a working default immediately — and recommends Studio
 * NOT copy that for sections with a RESIDENT body to reveal without writing
 * (Stroke's own Law-3 divergence, `StrokeSection.tsx`). Shadow has no such
 * resident body: a shadow row IS a value (X/Y/Blur/Spread/Colour), so there
 * is nothing to reveal without writing one. This section keeps the
 * pre-migration file's own behaviour unchanged — the typed "+" menu writes a
 * real default layer immediately — the same posture `FillSection.tsx`
 * already established for its own typed "+" menu. `Section`'s `empty`→
 * `forceOpen` flip happens on the very next render once the write lands.
 *
 * The "+" stays reachable in BOTH the empty header and the populated body's
 * OWN header (`Section`'s `actions` slot, unchanged from the pre-migration
 * file's own `EffectsSectionActions` mounting) — unlike Stroke, `box-shadow`
 * genuinely supports a STACK of layers, so a persistent "add another" is
 * honest here, not a control for a distinction CSS doesn't have.
 *
 * ## Locked (code-valued) properties
 *
 * `boxShadow`/`textShadow` are filtered through `selectedNode.codeProps`'s
 * `style:<prop>` keys, the same per-section slice of `StyleSectionsComposer.
 * tsx`'s top-level check every migrated section reproduces. The write is
 * silently refused — same posture `FillSection.tsx`/`StrokeSection.tsx`
 * already took for their own popover-gated properties.
 *
 * ## MULTI-SELECT
 *
 * Supported, with no code of its own (S5). `useSelectionModel()` describes
 * N nodes now — it hands this section the anchor wearing the selection's
 * COLLAPSED inline bag, `MIXED` wherever the layers disagree — so this file
 * renders and commits for a multi-selection through exactly the same reads
 * and `useInspectorCommit` calls it uses for one. See `selectionModel.ts`'s
 * own "Multi-select" doc.
 */
import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ControlRow } from '@ui/components/ControlRow'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Section } from '@ui/components/Section'
import { Switch } from '@ui/components/Switch'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { ClassPropertyRow } from '../../panels/PropertiesPanel/ClassPropertyRow'
import { hasStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedStoredStyles } from '../collapsedStyleBag'
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
  type BoxShadowParseResult,
} from './boxShadowLayers'
import styles from './ShadowSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

const SHADOW_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['boxShadow', 'textShadow']

type ShadowEntryData =
  | { kind: 'shadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'boxShadowRaw'; raw: string; reason: string }
  | { kind: 'textShadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'textShadowRaw'; raw: string; reason: string }

function ShadowSwatch({ layer }: { layer: BoxShadowLayer }) {
  const style = { '--effect-swatch-color': layer.color || 'var(--overlay-30)' } as CSSProperties
  return <span className={layer.inset ? styles.swatchInset : styles.swatch} style={style} aria-hidden="true" />
}

export function ShadowSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId } = model

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addTriggerRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<{ id: string; anchorRef: RefObject<HTMLElement | null> } | null>(null)

  if (!selectedNodeId || !selectedNode) return null

  const contextKey = activeContextId ?? 'base'

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  // `PropertyList` rows have no "inherited from base" placeholder the way a
  // plain field does (`EffectsSectionProps`'s own doc already established
  // this for the pre-migration file — ported unchanged) — no `currentStyles`
  // bag is built here.
  const { storedStyles } = buildCollapsedStoredStyles(SHADOW_PROPERTIES, contextOnlyClassChain, inlineStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = SHADOW_PROPERTIES.some(
    (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
  )

  function onChange(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null)
  }

  function onRemove(property: keyof CSSPropertyBag) {
    onChange(property, undefined)
  }

  function onPreview(patch: Partial<CSSPropertyBag>) {
    const filtered: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (lockedProperties.has(key)) continue
      filtered[key] = (value as string | number | null | undefined) ?? null
    }
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      preview: true,
    })
  }

  const onClearPreview = commit.clearStylePreview

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

  const addMenu = (
    <>
      <Button
        ref={addTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={addMenuOpen}
        aria-label="Add shadow"
        tooltip="Add shadow"
        data-testid="shadow-section-add"
        onClick={() => setAddMenuOpen((open) => !open)}
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {addMenuOpen && (
        <ContextMenu
          ariaLabel="Add shadow"
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
        </ContextMenu>
      )}
    </>
  )

  // Law 1's empty header — nothing set anywhere.
  if (!setAnywhere) {
    return <Section title="Shadow" empty flush actions={addMenu} />
  }

  const boxShadowResult = parseShadowValue(storedStyles.boxShadow as string | number | undefined)
  const textShadowResult = parseShadowValue(
    storedStyles.textShadow as string | number | undefined,
    TEXT_SHADOW_GRAMMAR,
  )

  const entries: PropertyListEntry<ShadowEntryData>[] = []

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

  function handleActivate(entry: PropertyListEntry<ShadowEntryData>, anchorRef: RefObject<HTMLElement | null>) {
    setEditing({ id: entry.id, anchorRef })
  }

  function handleRemove(entry: PropertyListEntry<ShadowEntryData>) {
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
    onRemove('textShadow')
  }

  function handleReorder(fromIndex: number, toIndex: number) {
    // `entries` is built in blocks: box-shadow layers first, then text-shadow
    // layers. Only a drag whose BOTH endpoints sit inside one block means
    // anything — layer order is paint order within one property, and a text
    // shadow can never be dragged above a box shadow (two declarations).
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

  return (
    <Section title="Shadow" forceOpen flush actions={addMenu}>
      <div data-testid="inspector-shadow-section" key={contextKey}>
        <PropertyList
          listLabel="Shadow"
          entries={entries}
          onActivate={handleActivate}
          onRemove={handleRemove}
          onReorder={handleReorder}
          addTriggerRef={addTriggerRef}
        />
      </div>
      {editingEntry && editing && (
        <ShadowEditorPopover
          id={`shadow-${editing.id}`}
          anchorRef={editing.anchorRef}
          onClose={() => setEditing(null)}
          entry={editingEntry}
          boxShadowResult={boxShadowResult}
          textShadowResult={textShadowResult}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// ShadowEditorPopover — F21's per-layer editor, plus the raw-text refusal row
// ---------------------------------------------------------------------------

interface ShadowEditorPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  entry: PropertyListEntry<ShadowEntryData>
  boxShadowResult: BoxShadowParseResult
  textShadowResult: BoxShadowParseResult
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

function ShadowEditorPopover({
  id,
  anchorRef,
  onClose,
  entry,
  boxShadowResult,
  textShadowResult,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: ShadowEditorPopoverProps) {
  const { data, label } = entry

  if (data.kind === 'shadowLayer' || data.kind === 'textShadowLayer') {
    const isText = data.kind === 'textShadowLayer'
    const result = isText ? textShadowResult : boxShadowResult
    if (result.kind !== 'layers') return null
    const index = data.index

    function save(nextLayer: BoxShadowLayer) {
      if (result.kind !== 'layers') return
      const next = updateBoxShadowLayer(result.layers, index, nextLayer)
      onChange(isText ? 'textShadow' : 'boxShadow', serializeBoxShadowLayers(next))
    }

    function preview(nextLayer: BoxShadowLayer) {
      if (result.kind !== 'layers') return
      const next = updateBoxShadowLayer(result.layers, index, nextLayer)
      onPreview({ [isText ? 'textShadow' : 'boxShadow']: serializeBoxShadowLayers(next) } as Partial<CSSPropertyBag>)
    }

    return (
      <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
        <ShadowLayerFields
          layer={data.layer}
          variant={isText ? 'text' : 'box'}
          onSave={save}
          onPreview={preview}
          onClearPreview={onClearPreview}
        />
      </InspectorPopover>
    )
  }

  // `boxShadowRaw` / `textShadowRaw` — honest refusal, reuses `ClassPropertyRow`.
  const property: keyof CSSPropertyBag = data.kind === 'boxShadowRaw' ? 'boxShadow' : 'textShadow'
  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
      <div className={styles.rawEditor}>
        <p className={styles.rawEditorReason}>{data.reason}</p>
        <ClassPropertyRow
          property={property}
          value={data.raw}
          isSet
          layout="stacked"
          onChange={onChange}
          onRemove={onRemove}
          onPreview={(prop, value) => onPreview({ [prop]: value ?? null } as Partial<CSSPropertyBag>)}
          onClearPreview={onClearPreview}
        />
      </div>
    </InspectorPopover>
  )
}

function ShadowLayerFields({
  layer,
  variant,
  onSave,
  onPreview,
  onClearPreview,
}: {
  layer: BoxShadowLayer
  variant: 'box' | 'text'
  onSave: (layer: BoxShadowLayer) => void
  onPreview: (layer: BoxShadowLayer) => void
  onClearPreview: () => void
}) {
  function patch(next: Partial<BoxShadowLayer>) {
    onSave({ ...layer, ...next })
  }

  function previewPatch(next: Partial<BoxShadowLayer>) {
    onPreview({ ...layer, ...next })
  }

  function setInset(checked: boolean) {
    patch({ inset: checked, insetPosition: checked ? 'leading' : 'none' })
  }

  function setColor(value: string) {
    patch({
      color: value,
      colorPosition: value === '' ? 'none' : layer.colorPosition === 'leading' ? 'leading' : 'trailing',
    })
  }

  return (
    <div className={styles.shadowFields}>
      {variant === 'box' && (
        <label className={styles.insetRow}>
          <Switch checked={layer.inset} onCheckedChange={setInset} switchSize="sm" />
          <span>Inset</span>
        </label>
      )}
      <div className={styles.shadowGrid}>
        <ControlRow propKey="shadow-x" label="X" layout="caption">
          <ScrubInput
            aria-label="Shadow X offset"
            label="X"
            value={layer.offsetX}
            unit="px"
            onChange={(next) => patch({ offsetX: next })}
            onPreview={(next) => previewPatch({ offsetX: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        <ControlRow propKey="shadow-y" label="Y" layout="caption">
          <ScrubInput
            aria-label="Shadow Y offset"
            label="Y"
            value={layer.offsetY}
            unit="px"
            onChange={(next) => patch({ offsetY: next })}
            onPreview={(next) => previewPatch({ offsetY: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        <ControlRow propKey="shadow-blur" label="Blur" layout="caption">
          <ScrubInput
            aria-label="Shadow blur radius"
            label="B"
            value={layer.blurRadius}
            unit="px"
            min={0}
            onChange={(next) => patch({ blurRadius: next })}
            onPreview={(next) => previewPatch({ blurRadius: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        {variant === 'box' && (
          <ControlRow propKey="shadow-spread" label="Spread" layout="caption">
            <ScrubInput
              aria-label="Shadow spread radius"
              label="S"
              value={layer.spreadRadius}
              unit="px"
              onChange={(next) => patch({ spreadRadius: next })}
              onPreview={(next) => previewPatch({ spreadRadius: next })}
              onClearPreview={onClearPreview}
            />
          </ControlRow>
        )}
      </div>
      <ControlRow propKey="shadow-color" label="Colour" layout="caption">
        <ColorValueInput
          value={layer.color}
          ariaLabel="Shadow colour"
          swatchLabel="Shadow colour swatch"
          onChange={setColor}
          onPreview={(value) => previewPatch({ color: value })}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    </div>
  )
}
