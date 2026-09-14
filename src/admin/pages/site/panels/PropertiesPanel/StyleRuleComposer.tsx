/**
 * StyleRuleComposer — CSS section content renderer for a single style rule
 * (any selector, not just a class) — the ambient/global-selector surface
 * `SelectorInspector.tsx` mounts, and the class half of `MultiSelectionStyleArea.tsx`'s
 * multi-select composer.
 *
 * P3 is complete (`STATE.md` `panel-25`, item 11 — Studio extras): every
 * curated CSS category this file used to render through
 * `StyleSectionsEditor.tsx` migrated to its own node-selection-scoped
 * `INSPECTOR_SECTIONS` manifest entry — but those sections all read through
 * `useSelectionModel()`, which requires a SELECTED NODE. This surface has
 * none (a class picked from the Selectors panel, or a shared class across a
 * multi-selection) — there is no single node's computed style / provenance
 * to hand them. So this file's only remaining job, now that
 * `StyleSectionsEditor.tsx` is deleted, is the one thing that never needed a
 * node: `CustomPropertiesSection`, rendered directly against this rule's own
 * stored bag. See `CustomPropertiesSection.tsx`'s own doc for the "three
 * call sites" framing.
 */

import { useEditorStore } from '@site/store/store'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { getActiveStyleTab } from './classStyleSections'
import { useEditorPreference } from '@site/preferences/editorPreferences'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleRuleComposerProps {
  classId: string
  cls: StyleRule
  mode?: 'contextual' | 'global'
}

// ---------------------------------------------------------------------------
// StyleRuleComposer
// ---------------------------------------------------------------------------

export function StyleRuleComposer({
  classId,
  cls,
  mode: _mode = 'contextual',
}: StyleRuleComposerProps) {
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  // The editing context is owned by the canvas toolbar's context switcher:
  // either the active viewport (base / breakpoint) or a custom condition. The
  // selector validates the active condition id against the registry and returns
  // a stable string | null, so a stale id (condition removed) falls back to
  // viewport editing without re-render churn.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const updateClassStyles = useEditorStore((s) => s.updateClassStyles)
  const setClassContextStyles = useEditorStore((s) => s.setClassContextStyles)
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  const onCondition = activeConditionId !== null

  const activeTab = getActiveStyleTab(activeBreakpointId)

  // The active context key: a condition id, a breakpoint id, or none (base).
  const activeContextId = onCondition
    ? activeConditionId
    : activeTab !== 'base'
      ? activeTab
      : null

  const storedStyles: Record<string, unknown> = activeContextId
    ? (cls.contextStyles[activeContextId] ?? {})
    : cls.styles

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) => {
    const patch = { [key]: value ?? null } as Partial<CSSPropertyBag>
    if (activeContextId) {
      setClassContextStyles(classId, activeContextId, patch)
    } else {
      updateClassStyles(classId, patch)
    }
  }

  const handleRemoveProperty = (key: keyof CSSPropertyBag) => {
    handleChange(key, undefined)
  }

  return (
    <CustomPropertiesSection
      storedStyles={storedStyles}
      defaultOpen={sectionsExpanded}
      onChange={handleChange}
      onRemove={handleRemoveProperty}
    />
  )
}
