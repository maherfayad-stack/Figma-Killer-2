/**
 * InteractionSection — Studio's own "Interaction" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras). Ported (not kept) from
 * `panels/PropertiesPanel/InteractionSection.tsx` (deleted — it was only
 * ever reachable through `StyleSectionGroup`'s hardcoded `section.id ===
 * 'interaction'` branch, itself deleted with `StyleSectionsEditor.tsx`) onto
 * its own `INSPECTOR_SECTIONS` manifest entry. Figma has no CSS-cursor/
 * pointer-events concept in its style panel — this is one of the five
 * Studio-only concerns item 11 folds into the manifest.
 *
 * Reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`, the same pattern every migrated section
 * already established: takes no props, renders `null` on no selection.
 * `StackedPropertyGrid` (unchanged, reused — the same primitive Text/the old
 * Interaction both already used) renders the compact two-column grid.
 *
 * ## LAW 1 — EMPTY vs. POPULATED
 *
 * Nothing set anywhere renders `Section`'s `empty` state — the same
 * convention every other migrated section's own Law-1 disclosure uses.
 * Clicking "+" only REVEALS the resident grid (Law 3); once anything is set
 * (or once revealed), the section passes `forceOpen`.
 *
 * ## Locked (code-valued) properties
 *
 * All four properties are filtered through `selectedNode.codeProps`'s
 * `style:<prop>` keys, the same per-section slice every migrated section
 * reproduces — `StackedPropertyGrid`'s own `provenanceByProperty`-driven
 * lock icon is the only visible per-field indicator, same as before.
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
import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { PointerSolidIcon } from 'pixel-art-icons/icons/pointer-solid'
import { StackedPropertyGrid, type StackedGridEntry } from '../../panels/PropertiesPanel/StackedPropertyGrid'
import { hasStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

const INTERACTION_SPEC: ReadonlyArray<StackedGridEntry> = [
  ['cursor', 'pointerEvents'],
  ['userSelect', 'scrollBehavior'],
]

const INTERACTION_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'cursor',
  'pointerEvents',
  'userSelect',
  'scrollBehavior',
]

export function InteractionSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues, provenanceByProperty } = model

  const [revealedFor, setRevealedFor] = useState<string | null>(null)

  if (!selectedNodeId || !selectedNode) return null

  const contextKey = activeContextId ?? 'base'

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(INTERACTION_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = INTERACTION_PROPERTIES.some(
    (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
  )

  const revealed = revealedFor === selectedNodeId

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

  if (!setAnywhere && !revealed) {
    return (
      <Section
        title="Interaction"
        empty
        flush
        icon={PointerSolidIcon}
        actions={
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Add interaction"
            tooltip="Add interaction"
            onClick={() => setRevealedFor(selectedNodeId)}
            data-testid="interaction-section-add"
          >
            <PlusIcon size={12} aria-hidden="true" />
          </Button>
        }
      />
    )
  }

  return (
    <Section title="Interaction" icon={PointerSolidIcon} forceOpen flush>
      <div data-testid="inspector-interaction-section" key={contextKey}>
        <StackedPropertyGrid
          spec={INTERACTION_SPEC}
          visibleProperties={INTERACTION_PROPERTIES}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          activeTab={contextKey}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          provenanceByProperty={provenanceByProperty}
        />
      </div>
    </Section>
  )
}
