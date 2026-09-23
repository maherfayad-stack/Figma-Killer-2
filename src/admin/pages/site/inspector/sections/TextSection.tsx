/**
 * TextSection — Penpot's Text section (`STATE.md` `panel-25`, item 9 of the
 * P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3). Migrated out of the
 * legacy `StyleSectionsEditor`/`classStyleSections.ts` registry onto its own
 * `INSPECTOR_SECTIONS` manifest entry, the same pattern Layer/Align/Measures/
 * Layout/Fill/Stroke/Shadow/Blur (items 1-8) already established: reads/
 * writes exclusively through `useSelectionModel()`/`useInspectorCommit(model)`,
 * takes no props, renders `null` on no selection — and, new for this item,
 * gates its very existence on a real predicate beyond "a node is selected"
 * (`sections/index.ts`'s `appliesTo`, reusing `styleSectionOrder.ts`'s
 * existing `isTextNode` — not duplicated).
 *
 * The pre-migration file (`panels/PropertiesPanel/TypographySection.tsx`)
 * was already close to Penpot's own measured F23 shape (see its own header
 * doc) — this pass is mostly a plumbing port, the same posture Stroke's own
 * PR took, onto the same four rows: family; weight+size; line-height+
 * letter-spacing; text-align + vertical-align + a settings ⚙
 * (`TextSettingsPopover.tsx`, renamed and relocated alongside this file —
 * its only caller).
 *
 * ## Confirmed against the real screenshot, not just the summary table
 *
 * `docs/audits/penpot-inspector-baseline/screenshots/f2-text/dark/design.png`
 * (a real text layer, Source Sans Pro 24/400) shows TEXT rendered ALWAYS
 * OPEN with real values — never collapsed to a one-line "+" header the way
 * FILL/STROKE/SHADOW/BLUR are when nothing is set. That tracks: a text
 * LAYER, by definition, always has a font family/size/weight to show (the
 * browser's own default when nothing is explicitly declared), so there is no
 * genuinely empty state for this section the way there is for an optional
 * fill or shadow. This design therefore drops the pre-migration file's
 * `collapsedWhenEmpty: true` posture (inherited generically from every
 * `classStyleSections.ts` entry, not a deliberate Text-specific choice) and
 * makes Text an ALWAYS-RESIDENT section instead — the same posture Measures/
 * Layout/Align (items 2-4) already took for element-intrinsic facts, per
 * `classStyleSections.ts`'s own doc ("none of the eight has a
 * `collapsedWhenEmpty` concept of its own here anymore"). `forceOpen` on
 * `Section`, no `empty` state, no header "+", no "N set" indicator.
 *
 * The screenshot's own TEXT header ALSO shows a trailing "+" even though the
 * section is populated (Penpot's own generic list-section convention, same
 * as FILL). This design does NOT reproduce that "+": CSS typography is not a
 * stack a user can add another layer to (unlike `box-shadow` or
 * `background-image`), so a persistent "add" control here would be exactly
 * the "control that lies about a distinction Studio's CSS model does not
 * have" `StrokeSection.tsx`'s own doc already refuses for `border`.
 *
 * ## What this claims
 *
 * `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`,
 * `letterSpacing`, `textAlign`, `textDecoration`, `textTransform`,
 * `whiteSpace`, `textOverflow`, `textIndent`, `marginBlock`,
 * `fontVariantNumeric`, `fontFeatureSettings`, `hangingPunctuation`,
 * `fontKerning`, `fontVariationSettings` — every property the old
 * `typography` entry in `classStyleSections.ts` claimed, unioned into
 * `MIGRATED_SECTION_PROPERTIES` in one step, same pattern every migrated
 * section established. `color`/`textShadow` stay claimed by Fill/Shadow
 * (G9.4, finished in W8-1 — a text node's colour is its fill, a text shadow
 * is a shadow); this section does not touch either.
 *
 * `alignItems` is a SECOND, honest write onto a property Layout (item 4)
 * already claims for search/"N set" purposes — this section's vertical-align
 * group is a convenience surface onto the SAME `align-items` a flex
 * CONTAINER uses for its children's cross-axis alignment, aimed at the (very
 * common) case of a text node made `display: flex` purely to center its own
 * text vertically (`verticalAlignWrite.ts`'s own doc, unchanged). This dual
 * surface on the same node already existed before this migration (the old
 * `TypographySection.tsx`'s vertical-align group and the old
 * `LayoutSection.tsx`'s own `alignItems` row could both render for the same
 * `display:flex` text node). `alignItems` is NOT added to this section's
 * `MIGRATED_SECTION_PROPERTIES` claim — Layout keeps sole "N set"/search
 * ownership; this section only reads/writes it through the same
 * `commit.commitStyle('alignItems', ...)` single honest target Layout uses.
 * `display`/`flexDirection` are read (never written) the same way, purely to
 * decide `resolveVerticalAlignAvailability` — the node's own actual rendered
 * box state, not a value this section owns.
 *
 * ## Search is gone
 *
 * P1 deleted the sticky search bar from the single-node surface
 * (`StyleSurface.tsx`) — the pre-migration file's "SEARCH REACHABILITY"
 * concern (`visibleProperties` narrowing which of row 4's controls survive a
 * query) no longer applies to this manifest entry: row 4 (the align groups
 * plus the settings ⚙) always renders in full, same simplification every
 * migrated section made once search left the single-node path (`STATE.md`
 * `panel-23`'s own P1 note).
 *
 * ## Locked (code-valued) properties
 *
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * of `StyleSectionsComposer.tsx`'s top-level check every migrated section
 * reproduces — the write is silently refused (`commitApi.ts`'s own gate), no
 * visible per-field disable UI beyond what `StackedPropertyGrid`'s own
 * `provenanceByProperty`-driven lock icon already provides, same posture
 * Stroke's own PR took. The vertical-align group additionally disables
 * client-side with a reason when `alignItems` itself is code-locked — the
 * same per-field (never per-row) posture `LayerSection.tsx`/
 * `AlignSection.tsx` established.
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
import { useRef, useState } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { isMixed, MIXED } from '@ui/components/MixedValue'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { AlignStartVerticalSolidIcon } from 'pixel-art-icons/icons/align-start-vertical-solid'
import { AlignCenterVerticalSolidIcon } from 'pixel-art-icons/icons/align-center-vertical-solid'
import { AlignEndVerticalSolidIcon } from 'pixel-art-icons/icons/align-end-vertical-solid'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { StackedPropertyGrid, type StackedGridEntry } from '../../panels/PropertiesPanel/StackedPropertyGrid'
import { getIconEnumOptions } from '../../panels/PropertiesPanel/cssPropertyIcons'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { useFontVariationAxes } from '../../panels/PropertiesPanel/useFontVariationAxes'
import {
  resolveVerticalAlignAvailability,
  verticalAlignEdgeValue,
  verticalAlignFromAlignItems,
  type VerticalAlign,
} from '../../panels/PropertiesPanel/verticalAlignWrite'
import { TextSettingsPopover } from './TextSettingsPopover'
import styles from './TextSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

/** Every property this section claims in `classStyleSections.ts`'s `MIGRATED_SECTION_PROPERTIES` — see this file's "What this claims" doc. */
const TEXT_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textDecoration',
  'textTransform',
  'whiteSpace',
  'textOverflow',
  'textIndent',
  'marginBlock',
  'fontVariantNumeric',
  'fontFeatureSettings',
  'hangingPunctuation',
  'fontKerning',
  'fontVariationSettings',
]

/**
 * The scope of THIS component's own `storedStyles`/`currentStyles` bag —
 * Text's own claim above PLUS the three properties it reads/writes but does
 * not "claim" for search/"N set" purposes: `alignItems` (the vertical-align
 * convenience write, owned by Layout) and `display`/`flexDirection` (read
 * only, to decide vertical-align's availability). See this file's "What this
 * claims" doc for why these are deliberately NOT in `TEXT_PROPERTIES` above.
 */
const BAG_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  ...TEXT_PROPERTIES,
  'display',
  'flexDirection',
  'alignItems',
]

const TOP_SPEC: ReadonlyArray<StackedGridEntry> = [
  'fontFamily',
  // Weight before size: Figma's order, and the one that reads correctly —
  // the family and its weight are one choice, the size is a separate one.
  ['fontWeight', 'fontSize'],
  ['lineHeight', 'letterSpacing'],
]

const VERTICAL_ALIGN_EDGES: ReadonlyArray<{ edge: VerticalAlign; icon: IconComponent; label: string }> = [
  { edge: 'top', icon: AlignStartVerticalSolidIcon, label: 'Align top' },
  { edge: 'middle', icon: AlignCenterVerticalSolidIcon, label: 'Align middle' },
  { edge: 'bottom', icon: AlignEndVerticalSolidIcon, label: 'Align bottom' },
]

export function TextSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues, provenanceByProperty } =
    model
  const fonts = useEditorStore((state) => state.site?.settings.fonts ?? null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)

  // Every derived value below runs unconditionally, same order every render,
  // with safe empty fallbacks pre-selection — `useFontVariationAxes` is a
  // hook and must run before the early return (same discipline
  // `AlignSection.tsx` already established for its own pre-selection hooks).
  const inlineStyles = selectedNode?.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(BAG_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)
  const variationAxes = useFontVariationAxes(currentStyles.fontFamily, fonts)

  if (!selectedNodeId || !selectedNode) return null

  // Ported verbatim from every other migrated section's own per-section
  // code-lock check — this section's own slice of
  // `StyleSectionsComposer.tsx`'s top-level banner.
  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
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

  const textAlignOptions = getIconEnumOptions('textAlign') ?? []
  const storedTextAlign = storedStyles.textAlign
  const verticalAvailability = resolveVerticalAlignAvailability(currentStyles)
  const alignItemsLocked = lockedProperties.has('alignItems')
  const verticalAlignDisabled = !verticalAvailability.available || alignItemsLocked
  const verticalAlignReason = !verticalAvailability.available
    ? verticalAvailability.reason
    : alignItemsLocked
      ? 'alignItems is set from an expression in code'
      : undefined

  // W8-3 — both alignment groups are driven by a raw cell that can be the
  // multi-selection MIXED sentinel; `SegmentedControl` takes it directly and
  // renders indeterminate rather than pressing one member's value. (This
  // section never mounts during multi-select — see this file's own doc — but
  // `SegmentedControl`'s contract is unchanged from the pre-migration file,
  // so this stays defensive rather than assuming a single-value cell.)
  const textAlignMixed = isMixed(storedTextAlign)
  const verticalAlignMixed = isMixed(storedStyles.alignItems)
  const currentVerticalEdge = verticalAlignMixed
    ? undefined
    : verticalAlignFromAlignItems(storedStyles.alignItems)

  return (
    <Section title="Text" forceOpen flush>
      <div className={styles.section}>
        <StackedPropertyGrid
          spec={TOP_SPEC}
          visibleProperties={TEXT_PROPERTIES}
          currentStyles={currentStyles}
          storedStyles={storedStyles}
          activeTab={activeContextId ?? 'base'}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          provenanceByProperty={provenanceByProperty}
          rhythm="within-group"
        />

        <div className={styles.alignRow}>
          <div className={styles.alignGroups}>
            <SegmentedControl
              aria-label="Text align"
              data-testid="text-align"
              value={
                textAlignMixed
                  ? MIXED
                  : typeof storedTextAlign === 'string' && storedTextAlign !== ''
                    ? storedTextAlign
                    : undefined
              }
              options={textAlignOptions.map((option) => ({
                value: option.value,
                icon: option.icon ? <option.icon size={14} aria-hidden="true" /> : undefined,
                ariaLabel: `Text align: ${option.tooltip}`,
                tooltip: option.tooltip,
              }))}
              onChange={(next) => onChange('textAlign', next)}
              onClear={() => onRemove('textAlign')}
            />
            <SegmentedControl
              aria-label="Vertical align"
              data-testid="text-vertical-align"
              disabled={verticalAlignDisabled}
              value={verticalAlignMixed ? MIXED : currentVerticalEdge}
              options={VERTICAL_ALIGN_EDGES.map(({ edge, icon: EdgeIcon, label }) => ({
                value: edge,
                icon: <EdgeIcon size={14} aria-hidden="true" />,
                ariaLabel: label,
                tooltip: verticalAlignDisabled ? verticalAlignReason : label,
              }))}
              onChange={(edge) => onChange('alignItems', verticalAlignEdgeValue(edge))}
              onClear={() => onRemove('alignItems')}
            />
          </div>
          <Button
            ref={settingsTriggerRef}
            variant="ghost"
            size="xs"
            iconOnly
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="Text settings"
            tooltip="Text settings"
            data-testid="text-settings-trigger"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SlidersHorizontalIcon size={14} aria-hidden="true" />
          </Button>
        </div>

        {settingsOpen && (
          <TextSettingsPopover
            id="text-settings"
            anchorRef={settingsTriggerRef}
            onClose={() => setSettingsOpen(false)}
            storedStyles={storedStyles}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            variationAxes={variationAxes}
          />
        )}
      </div>
    </Section>
  )
}
