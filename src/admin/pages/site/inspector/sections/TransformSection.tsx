/**
 * TransformSection — Studio's own "Transform" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras). No pre-migration equivalent: the
 * `transform`/`transformOrigin` pair only ever rendered through
 * `StyleSectionsEditor`'s generic per-property fallback (`ClassPropertyRow`
 * in `stacked` layout, parked in `classStyleSections.ts`'s now-empty
 * `transform` entry — see that file's own doc for the relocation history).
 * Neither property has a Penpot section to land in (Figma's own equivalent
 * lives in prototyping, not the style panel), so this is one of the five
 * Studio-only concerns item 11 folds into the manifest.
 *
 * Reads/writes exclusively through `useSelectionModel()`/
 * `useInspectorCommit(model)`, the same pattern every migrated section
 * already established: takes no props, renders `null` on no selection.
 *
 * ## LAW 1 — EMPTY vs. POPULATED
 *
 * Neither property set anywhere (base or any breakpoint/condition) renders
 * `Section`'s `empty` state — title + a single "+", no chevron, no body —
 * the same convention every other migrated section's own Law-1 disclosure
 * uses. Clicking "+" only REVEALS the two resident rows (Law 3 — no value is
 * written from a bare reveal click); once anything is set (or once
 * revealed), the section passes `forceOpen`.
 *
 * ## Locked (code-valued) properties
 *
 * Both properties are filtered through `selectedNode.codeProps`'s
 * `style:<prop>` keys, the same per-section slice of the old
 * `StyleSectionsComposer.tsx`'s top-level check every migrated section
 * reproduces.
 *
 * ## MULTI-SELECT
 *
 * Out of scope, structurally: `PropertiesPanelBody.tsx` early-returns
 * `<MultiSelectionInspector>` before `StyleSurface`/`INSPECTOR_SECTIONS`
 * ever mount when `isMultiSelect` is true — this section never renders
 * during a multi-select.
 */
import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { ClassPropertyRow } from '../../panels/PropertiesPanel/ClassPropertyRow'
import { hasStyleValue, isMixedStyleValue } from '../../panels/PropertiesPanel/styleValueUtils'
import { resolveStylePlaceholder } from '../../panels/PropertiesPanel/stylePlaceholder'
import { MIXED } from '@ui/components/MixedValue'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ArrowsScaleIcon } from 'pixel-art-icons/icons/arrows-scale'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

const TRANSFORM_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['transform', 'transformOrigin']

export function TransformSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues, provenanceByProperty } = model

  // Law 1's "+" reveal is per-NODE — see StrokeSection.tsx's own doc for why
  // this can't rely on unmount/remount the way a pre-P4 caller could.
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
  const { storedStyles } = buildCollapsedStoredStyles(TRANSFORM_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = TRANSFORM_PROPERTIES.some(
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

  function onPreview(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyleMany({ [property]: value ?? null } as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      preview: true,
    })
  }

  const onClearPreview = commit.clearStylePreview

  // Law 1's empty header — nothing set anywhere and the user hasn't clicked
  // "+" yet for this node.
  if (!setAnywhere && !revealed) {
    return (
      <Section
        title="Transform"
        empty
        flush
        icon={ArrowsScaleIcon}
        actions={
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Add transform"
            tooltip="Add transform"
            onClick={() => setRevealedFor(selectedNodeId)}
            data-testid="transform-section-add"
          >
            <PlusIcon size={12} aria-hidden="true" />
          </Button>
        }
      />
    )
  }

  function renderRow(property: keyof CSSPropertyBag) {
    const storedValue = storedStyles[property]
    const mixed = isMixedStyleValue(storedStyles, currentStyles, String(property))
    const isSet = !mixed && hasStyleValue(storedValue)
    const provenance = provenanceByProperty?.get(String(property))
    return (
      <ClassPropertyRow
        key={`${contextKey}-${String(property)}`}
        property={property}
        value={mixed ? MIXED : isSet ? (storedValue as string | number) : undefined}
        placeholder={
          mixed || isSet
            ? undefined
            : resolveStylePlaceholder({ property, provenance, currentValue: currentStyles[property] })
        }
        isSet={isSet}
        layout="stacked"
        onChange={onChange}
        onRemove={onRemove}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        provenance={provenance}
      />
    )
  }

  return (
    <Section title="Transform" icon={ArrowsScaleIcon} forceOpen flush>
      <div data-testid="inspector-transform-section" key={contextKey}>
        {renderRow('transform')}
        {renderRow('transformOrigin')}
      </div>
    </Section>
  )
}
