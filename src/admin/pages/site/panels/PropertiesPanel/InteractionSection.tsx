/**
 * InteractionSection — compact editor for the `interaction` section.
 *
 * All four properties are short enum selects, so they pair cleanly into two
 * two-column rows. Layout spec over StackedPropertyGrid.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import type { PropertyProvenance } from './stylePropertyProvenance'

const INTERACTION_SPEC: ReadonlyArray<StackedGridEntry> = [
  ['cursor', 'pointerEvents'],
  ['userSelect', 'scrollBehavior'],
]

interface InteractionSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Track F1 — see `StackedPropertyGrid`'s doc. */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function InteractionSection(props: InteractionSectionProps) {
  return <StackedPropertyGrid spec={INTERACTION_SPEC} {...props} />
}
