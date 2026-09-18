/**
 * BlurSection — Penpot's Blur section (`STATE.md` `panel-25`, item 8 of the
 * P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3). The second half of
 * the legacy `panels/PropertiesPanel/EffectsSection.tsx` split — Shadow
 * (item 7, `ShadowSection.tsx`) claims `boxShadow`/`textShadow`; this section
 * claims `filter`/`backdropFilter`. Both migrated in the SAME PR because
 * `EffectsSection.tsx` is only deleted once both have landed (`STATE.md`
 * `panel-25`'s own mapping-table note for items 7-8).
 *
 * Reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`, the same pattern every migrated section
 * already established: takes no props, renders `null` on no selection.
 *
 * ## BLUR MODELLING — unchanged from the pre-migration file
 *
 * `filter`/`backdrop-filter` model at most ONE structured blur entry each: a
 * stored value that is EXACTLY `blur(<length>)` gets a structured radius row
 * (editable in a popover, the same `EffectEditorPopover`-style shell every
 * other migrated section's own per-entry editor uses); anything else (a
 * second filter function, a non-blur function, unusual whitespace) is real
 * CSS this module refuses to restructure and renders as one raw-text row
 * instead — never a guessed rewrite (`CLAUDE.md` §"Studio-specific"). "Layer
 * blur" is Penpot's own name for `filter: blur()`; "Background blur" is its
 * name for `backdrop-filter: blur()`.
 *
 * ## LAW 1 / RULE 2 — the "+" writes a real value immediately, same as Shadow
 *
 * Penpot's own BLUR header renders as a single `32px` collapsed-empty row
 * (title + trailing "+", no chevron — `screenshots/f1-rectangle/dark/
 * design.png`, confirmed directly). `03-operating-behaviors.md`'s own
 * "Add-property writes a real value" note names Blur explicitly. Like
 * Shadow, a blur row IS a value (a radius) — there is no resident body to
 * reveal without writing one, so this section keeps the pre-migration
 * file's own behaviour unchanged: the typed "+" menu (Layer blur /
 * Background blur) writes `blur(4px)` immediately, same posture
 * `ShadowSection.tsx`/`FillSection.tsx` already established for their own
 * typed "+" menus. Each menu item disables itself once its OWN property is
 * already set (structured or raw) — adding a second blur onto a property
 * that already has one would either silently overwrite it or need a second
 * blur-stacking model CSS `filter`/`backdrop-filter` don't have (both accept
 * MULTIPLE filter functions space-joined, but this module only ever writes a
 * single one — see the module doc's own "at most ONE structured blur entry
 * each" above).
 *
 * The "+" stays reachable in BOTH the empty header and the populated body's
 * OWN header (`Section`'s `actions` slot) — Layer blur and Background blur
 * are two INDEPENDENT properties, so once one is set the other can still be
 * added from the same trigger (unlike Stroke, where `border` has no stack
 * concept at all).
 *
 * ## Locked (code-valued) properties
 *
 * `filter`/`backdropFilter` are filtered through `selectedNode.codeProps`'s
 * `style:<prop>` keys, the same per-section slice of `StyleSectionsComposer.
 * tsx`'s top-level check every migrated section reproduces. The write is
 * silently refused — same posture every other migrated section already took.
 *
 * ## MULTI-SELECT
 *
 * Supported, with no code of its own (S5). `useSelectionModel()` describes
 * N nodes now — it hands this section the anchor wearing the selection's
 * COLLAPSED inline bag, `MIXED` wherever the layers disagree — so this file
 * renders and commits for a multi-selection through exactly the same reads
 * and `useInspectorCommit` calls it uses for one. See `selectionModel.ts`'s
 * own "Multi-select" doc.
 *
 * With ONE exception this file does own: `readString` collapses the `MIXED`
 * Symbol to `undefined`, so a disagreeing `filter` produced NO row at all
 * under a `Section` that Law 1 had already forced open — a populated section
 * with an empty body, and an "Add layer blur" item still enabled beside it.
 * Both properties now test the raw cell and draw one row reading "Mixed",
 * whose popover writes the whole declaration to every selected layer
 * (`docs/features/inspector.md` §9.3).
 */
import { useRef, useState, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ControlRow } from '@ui/components/ControlRow'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ClassPropertyRow } from '../../panels/PropertiesPanel/ClassPropertyRow'
import { hasStyleValue, readString } from '../../panels/PropertiesPanel/styleValueUtils'
import { isMixed, MIXED, MIXED_PLACEHOLDER } from '@ui/components/MixedValue'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import styles from './BlurSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

const BLUR_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['filter', 'backdropFilter']

// `filter`/`backdrop-filter` — accept ONLY a lone `blur(<length>)`. Anything
// else is real CSS this module refuses to restructure — same honest-refusal
// posture as box-shadow (`boxShadowLayers.ts`'s own module doc).
const BLUR_FN_RE = /^blur\(\s*(.+?)\s*\)$/i

function parseBlurRadius(value: string): string | undefined {
  const match = BLUR_FN_RE.exec(value.trim())
  return match ? match[1] : undefined
}

type BlurEntryData =
  | { kind: 'layerBlur'; radius: string }
  | { kind: 'layerBlurRaw'; raw: string }
  | { kind: 'backgroundBlur'; radius: string }
  | { kind: 'backgroundBlurRaw'; raw: string }
  /** A multi-selection whose members disagree on this filter — see §9.3. */
  | { kind: 'blurMixed'; property: 'filter' | 'backdropFilter' }

export function BlurSection() {
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
  const { storedStyles } = buildCollapsedStoredStyles(BLUR_PROPERTIES, contextOnlyClassChain, inlineStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = BLUR_PROPERTIES.some(
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

  // `hasStyleValue` on the RAW cell, not `readString`: for a multi-selection
  // that disagrees the cell is the `MIXED` Symbol, which `readString`
  // collapses to `undefined` — so "Add layer blur" used to stay enabled and
  // would have replaced every selected layer's own filter
  // (`docs/features/inspector.md` §9.3).
  const filterMixed = isMixed(storedStyles.filter)
  const backdropMixed = isMixed(storedStyles.backdropFilter)
  const layerBlurDisabled = hasStyleValue(storedStyles.filter)
  const backgroundBlurDisabled = hasStyleValue(storedStyles.backdropFilter)

  function addLayerBlur() {
    onChange('filter', 'blur(4px)')
    setAddMenuOpen(false)
  }

  function addBackgroundBlur() {
    onChange('backdropFilter', 'blur(4px)')
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
        aria-label="Add blur"
        tooltip="Add blur"
        data-testid="blur-section-add"
        onClick={() => setAddMenuOpen((open) => !open)}
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {addMenuOpen && (
        <ContextMenu
          ariaLabel="Add blur"
          anchorRef={addTriggerRef}
          triggerRef={addTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          onClose={() => setAddMenuOpen(false)}
        >
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

  // Law 1's empty header — nothing set anywhere.
  if (!setAnywhere) {
    return <Section title="Blur" empty flush actions={addMenu} />
  }

  const filterRaw = readString(storedStyles, 'filter')
  const filterBlurRadius = filterRaw != null ? parseBlurRadius(filterRaw) : undefined

  const backdropRaw = readString(storedStyles, 'backdropFilter')
  const backdropBlurRadius = backdropRaw != null ? parseBlurRadius(backdropRaw) : undefined

  const entries: PropertyListEntry<BlurEntryData>[] = []

  if (filterMixed) {
    entries.push({
      id: 'filter-mixed',
      label: 'Filter',
      summary: 'Filter',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'blurMixed', property: 'filter' },
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

  if (backdropMixed) {
    entries.push({
      id: 'backdrop-mixed',
      label: 'Backdrop filter',
      summary: 'Backdrop filter',
      value: MIXED_PLACEHOLDER,
      data: { kind: 'blurMixed', property: 'backdropFilter' },
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

  function handleActivate(entry: PropertyListEntry<BlurEntryData>, anchorRef: RefObject<HTMLElement | null>) {
    setEditing({ id: entry.id, anchorRef })
  }

  function handleRemove(entry: PropertyListEntry<BlurEntryData>) {
    const { data } = entry
    if (data.kind === 'blurMixed') {
      // Clears the property from every selected layer, one history entry.
      onRemove(data.property)
      return
    }
    if (data.kind === 'layerBlur' || data.kind === 'layerBlurRaw') {
      onRemove('filter')
      return
    }
    onRemove('backdropFilter')
  }

  const editingEntry = editing ? entries.find((entry) => entry.id === editing.id) : undefined

  return (
    <Section title="Blur" forceOpen flush actions={addMenu}>
      <div data-testid="inspector-blur-section" key={contextKey}>
        <PropertyList
          listLabel="Blur"
          entries={entries}
          onActivate={handleActivate}
          onRemove={handleRemove}
          addTriggerRef={addTriggerRef}
        />
      </div>
      {editingEntry && editing && (
        <BlurEditorPopover
          id={`blur-${editing.id}`}
          anchorRef={editing.anchorRef}
          onClose={() => setEditing(null)}
          entry={editingEntry}
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
// BlurEditorPopover — a single radius field, plus the raw-text refusal row
// ---------------------------------------------------------------------------

interface BlurEditorPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  entry: PropertyListEntry<BlurEntryData>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

function BlurEditorPopover({
  id,
  anchorRef,
  onClose,
  entry,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: BlurEditorPopoverProps) {
  const { data, label } = entry

  if (data.kind === 'layerBlur' || data.kind === 'backgroundBlur') {
    const property: keyof CSSPropertyBag = data.kind === 'layerBlur' ? 'filter' : 'backdropFilter'
    return (
      <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
        <ControlRow propKey="blur-radius" label="Radius" layout="caption">
          <ScrubInput
            aria-label={`${label} radius`}
            label="B"
            value={data.radius}
            unit="px"
            min={0}
            onChange={(next) => onChange(property, `blur(${next})`)}
            onPreview={(next) => onPreview({ [property]: `blur(${next})` } as Partial<CSSPropertyBag>)}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
      </InspectorPopover>
    )
  }

  // `layerBlurRaw` / `backgroundBlurRaw` / `blurMixed` — the same honest
  // shape: the whole declaration as one field, with the reason above it.
  // `ClassPropertyRow` turns the `MIXED` sentinel into its control's own
  // "Mixed" placeholder, so nothing ever stringifies the Symbol.
  const property: keyof CSSPropertyBag =
    data.kind === 'blurMixed' ? data.property : data.kind === 'layerBlurRaw' ? 'filter' : 'backdropFilter'
  const reason =
    data.kind === 'blurMixed'
      ? 'The selected layers set different values here. Typing one writes it to every selected layer.'
      : data.kind === 'layerBlurRaw'
        ? 'This filter is more than a single blur(), so it stays as text.'
        : 'This backdrop-filter is more than a single blur(), so it stays as text.'
  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
      <div className={styles.rawEditor}>
        <p className={styles.rawEditorReason}>{reason}</p>
        <ClassPropertyRow
          property={property}
          value={data.kind === 'blurMixed' ? MIXED : data.raw}
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
