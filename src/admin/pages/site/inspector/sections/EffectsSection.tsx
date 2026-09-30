/**
 * EffectsSection — Figma's single Effects section: shadows and blurs, one
 * header, one `+`, one list (P2-F, owner decision OD-4; the WS-6.1 diagram's
 * `Effects  shadow / blur  + −`).
 *
 * It claims four declarations — `box-shadow`, `text-shadow`, `filter`,
 * `backdrop-filter` — which P3 had split into a Shadow section (item 7) and
 * a Blur section (item 8), following Penpot, which keeps them apart
 * (`shapes/frame.cljs`). Figma merges them, and the owner's bar is Figma. The
 * merge is also what pays for the panel's 12px section gap: two collapsed
 * one-row sections cost a 33px header plus a gap on EVERY selection, for two
 * facts that are one idea to a designer ("does this have an effect?").
 *
 * Reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`: takes no props, renders `null` on no
 * selection — the pattern every manifest section follows.
 *
 * ## The models — unchanged by the merge
 *
 * - **Shadows.** `box-shadow` is a comma-separated list, parsed into
 *   `BoxShadowLayer[]` by `boxShadowLayers.ts` and re-serialised
 *   byte-for-byte; each layer is its own row. A value that does not parse OR
 *   would not round-trip renders as ONE raw-text row instead — never a partial
 *   parse. `text-shadow` rides the same parser under `TEXT_SHADOW_GRAMMAR`
 *   (three lengths, no `inset`).
 * - **Blurs.** `filter` / `backdrop-filter` each model at most ONE structured
 *   entry: a value that is exactly `blur(<length>)` gets a radius row ("Layer
 *   blur" / "Background blur", Penpot's names); anything else is one raw-text
 *   row. Each property is independent, so each can be added while the other
 *   is set — but not twice, because this module only ever writes one blur
 *   function per property.
 *
 * Rows are built in blocks — box shadows, text shadows, layer blur,
 * background blur — which is paint order within each property and the order
 * Figma lists effects in. `Alt+Arrow` reorder only means something inside one
 * shadow block (layer order is paint order within one declaration); a drag
 * that crosses a block boundary, or lands on a blur row, is ignored.
 *
 * ## LAW 1 — the `+` writes a real value immediately
 *
 * Nothing set anywhere → the empty header (title + `+`, no chevron). Every
 * menu item writes a working default at once (a drop shadow layer,
 * `blur(4px)`), because an effect row IS a value: there is no resident body
 * to reveal without writing one (`03-operating-behaviors.md`'s "Add-property
 * writes a real value" names Shadow and Blur). `Section`'s `empty` →
 * `forceOpen` flip happens on the render after the write lands.
 *
 * ## Locked (code-valued) properties
 *
 * Each of the four is filtered through `selectedNode.codeProps`'s
 * `style:<prop>` keys; a write to a locked one is silently refused, the same
 * posture every section takes for its popover-gated properties.
 *
 * ## Multi-select (`docs/features/inspector.md` §9.3)
 *
 * The model hands this section the selection's COLLAPSED inline bag, with
 * `MIXED` wherever the layers disagree. A disagreeing declaration has no
 * shared layer stack to draw rows for, so it draws ONE row reading "Mixed"
 * whose popover writes the whole declaration to every selected layer; the
 * add items for that property disable (appending to a list that does not
 * exist is a replace wearing an add's icon), each with a tooltip saying why.
 */
import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { hasStyleValue, pickMixedCell, readString } from '../../panels/PropertiesPanel/styleValueUtils'
import { isMixed, MIXED_PLACEHOLDER } from '@ui/components/MixedValue'
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
  TEXT_SHADOW_GRAMMAR,
  type BoxShadowLayer,
} from './boxShadowLayers'
import { EffectEditorPopover, type EffectEntryData, type EffectProperty } from './EffectEditorPopover'
import styles from './EffectsSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

const EFFECT_PROPERTIES: ReadonlyArray<EffectProperty> = ['boxShadow', 'textShadow', 'filter', 'backdropFilter']

// `filter`/`backdrop-filter` — accept ONLY a lone `blur(<length>)`. Anything
// else is real CSS this module refuses to restructure — the same honest
// refusal `boxShadowLayers.ts` makes for a shadow it cannot round-trip.
const BLUR_FN_RE = /^blur\(\s*(.+?)\s*\)$/i

function parseBlurRadius(value: string): string | undefined {
  const match = BLUR_FN_RE.exec(value.trim())
  return match ? match[1] : undefined
}

const MIXED_SHADOW_ADD_TOOLTIP = 'The selected layers have different shadows — add one with a single layer selected'
const MIXED_FILTER_ADD_TOOLTIP = 'The selected layers have different values here — add one with a single layer selected'

function ShadowSwatch({ layer }: { layer: BoxShadowLayer }) {
  const style = { '--effect-swatch-color': layer.color || 'var(--overlay-30)' } as CSSProperties
  return <span className={layer.inset ? styles.swatchInset : styles.swatch} style={style} aria-hidden="true" />
}

export function EffectsSection() {
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
  // plain field does, so no `currentStyles` bag is built here.
  const { storedStyles } = buildCollapsedStoredStyles(EFFECT_PROPERTIES, contextOnlyClassChain, inlineStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = EFFECT_PROPERTIES.some(
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

  // Parsed once, here: the add menu and the rows below both ask.
  const boxShadowResult = parseShadowValue(pickMixedCell(storedStyles.boxShadow))
  const textShadowResult = parseShadowValue(pickMixedCell(storedStyles.textShadow), TEXT_SHADOW_GRAMMAR)
  const boxShadowMixed = boxShadowResult.kind === 'mixed'
  const textShadowMixed = textShadowResult.kind === 'mixed'
  // `isMixed` on the RAW cell, not `readString`, which collapses the `MIXED`
  // Symbol to `undefined` and so would read a disagreeing filter as unset.
  const filterMixed = isMixed(storedStyles.filter)
  const backdropMixed = isMixed(storedStyles.backdropFilter)
  const filterSet = hasStyleValue(storedStyles.filter)
  const backdropSet = hasStyleValue(storedStyles.backdropFilter)

  function addShadow(inset: boolean) {
    if (boxShadowMixed) return
    const layerCss = serializeBoxShadowLayer(createDefaultBoxShadowLayer(inset))
    onChange('boxShadow', appendBoxShadowLayer(storedStyles.boxShadow as string | number | undefined, layerCss))
    setAddMenuOpen(false)
  }

  function addTextShadow() {
    if (textShadowMixed) return
    const layerCss = serializeBoxShadowLayer(createDefaultTextShadowLayer())
    onChange('textShadow', appendBoxShadowLayer(storedStyles.textShadow as string | number | undefined, layerCss))
    setAddMenuOpen(false)
  }

  function addBlur(property: 'filter' | 'backdropFilter') {
    if (property === 'filter' ? filterSet : backdropSet) return
    onChange(property, 'blur(4px)')
    setAddMenuOpen(false)
  }

  function blurAddTooltip(mixed: boolean, set: boolean, name: string): string | undefined {
    if (mixed) return MIXED_FILTER_ADD_TOOLTIP
    if (set) return `This layer already has a ${name} — edit its row`
    return undefined
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
        aria-label="Add effect"
        tooltip="Add effect"
        data-testid="effects-section-add"
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
          <ContextMenuItem
            disabled={boxShadowMixed}
            tooltip={boxShadowMixed ? MIXED_SHADOW_ADD_TOOLTIP : undefined}
            onClick={() => addShadow(false)}
          >
            Drop shadow
          </ContextMenuItem>
          <ContextMenuItem
            disabled={boxShadowMixed}
            tooltip={boxShadowMixed ? MIXED_SHADOW_ADD_TOOLTIP : undefined}
            onClick={() => addShadow(true)}
          >
            Inner shadow
          </ContextMenuItem>
          <ContextMenuItem
            disabled={textShadowMixed}
            tooltip={textShadowMixed ? MIXED_SHADOW_ADD_TOOLTIP : undefined}
            onClick={addTextShadow}
          >
            Text shadow
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={filterSet}
            tooltip={blurAddTooltip(filterMixed, filterSet, 'filter')}
            onClick={() => addBlur('filter')}
          >
            Layer blur
          </ContextMenuItem>
          <ContextMenuItem
            disabled={backdropSet}
            tooltip={blurAddTooltip(backdropMixed, backdropSet, 'backdrop filter')}
            onClick={() => addBlur('backdropFilter')}
          >
            Background blur
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )

  // Law 1's empty header — nothing set anywhere.
  if (!setAnywhere) {
    return <Section title="Effects" empty flush actions={addMenu} />
  }

  const entries: PropertyListEntry<EffectEntryData>[] = []

  // ── Box shadows ──
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
  } else if (boxShadowMixed) {
    entries.push({
      id: 'shadow-mixed',
      label: 'Box shadow',
      summary: 'Box shadow',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'mixed', property: 'boxShadow' },
    })
  }

  // Where the text-shadow block starts — the box block contributes one row
  // per layer, or exactly one for `raw`/`mixed`.
  const boxRowCount = entries.length

  // ── Text shadows ──
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
  } else if (textShadowMixed) {
    entries.push({
      id: 'text-shadow-mixed',
      label: 'Text shadow',
      summary: 'Text shadow',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'mixed', property: 'textShadow' },
    })
  }

  // ── Layer blur (`filter`) ──
  const filterRaw = readString(storedStyles, 'filter')
  const filterBlurRadius = filterRaw != null ? parseBlurRadius(filterRaw) : undefined
  if (filterMixed) {
    entries.push({
      id: 'filter-mixed',
      label: 'Filter',
      summary: 'Filter',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'mixed', property: 'filter' },
    })
  } else if (filterBlurRadius !== undefined) {
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

  // ── Background blur (`backdrop-filter`) ──
  const backdropRaw = readString(storedStyles, 'backdropFilter')
  const backdropBlurRadius = backdropRaw != null ? parseBlurRadius(backdropRaw) : undefined
  if (backdropMixed) {
    entries.push({
      id: 'backdrop-mixed',
      label: 'Backdrop filter',
      summary: 'Backdrop filter',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'mixed', property: 'backdropFilter' },
    })
  } else if (backdropBlurRadius !== undefined) {
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
    switch (data.kind) {
      case 'shadowLayer': {
        if (boxShadowResult.kind !== 'layers') return
        const next = removeBoxShadowLayer(boxShadowResult.layers, data.index)
        if (next.length === 0) onRemove('boxShadow')
        else onChange('boxShadow', serializeBoxShadowLayers(next))
        return
      }
      case 'textShadowLayer': {
        if (textShadowResult.kind !== 'layers') return
        const next = removeBoxShadowLayer(textShadowResult.layers, data.index)
        if (next.length === 0) onRemove('textShadow')
        else onChange('textShadow', serializeBoxShadowLayers(next))
        return
      }
      // A Mixed row clears the property from every selected layer, in one
      // history entry.
      case 'mixed':
        onRemove(data.property)
        return
      case 'boxShadowRaw':
        onRemove('boxShadow')
        return
      case 'textShadowRaw':
        onRemove('textShadow')
        return
      case 'layerBlur':
      case 'layerBlurRaw':
        onRemove('filter')
        return
      case 'backgroundBlur':
      case 'backgroundBlurRaw':
        onRemove('backdropFilter')
        return
    }
  }

  function handleReorder(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || toIndex < 0) return
    // Only a move whose BOTH endpoints sit inside one shadow block means
    // anything — layer order is paint order within one declaration. A text
    // shadow can never be dragged above a box shadow (two declarations), and
    // the blur rows after both blocks are one-per-property.
    const boxCount = boxShadowResult.kind === 'layers' ? boxShadowResult.layers.length : 0
    if (boxShadowResult.kind === 'layers' && fromIndex < boxCount && toIndex < boxCount) {
      onChange('boxShadow', serializeBoxShadowLayers(reorderBoxShadowLayers(boxShadowResult.layers, fromIndex, toIndex)))
      return
    }

    // `boxRowCount`, not `boxCount`: a `raw`/`mixed` box shadow contributes
    // ONE row that is not a layer, and offsetting by the layer count would
    // silently drop every text-shadow move under it.
    const textCount = textShadowResult.kind === 'layers' ? textShadowResult.layers.length : 0
    const textStart = boxRowCount
    const textEnd = boxRowCount + textCount
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
    <Section title="Effects" forceOpen flush actions={addMenu}>
      <div data-testid="inspector-effects-section" key={contextKey}>
        <PropertyList
          listLabel="Effects"
          entries={entries}
          onActivate={handleActivate}
          onRemove={handleRemove}
          onReorder={handleReorder}
          addTriggerRef={addTriggerRef}
        />
      </div>
      {editingEntry && editing && (
        <EffectEditorPopover
          id={`effect-${editing.id}`}
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
