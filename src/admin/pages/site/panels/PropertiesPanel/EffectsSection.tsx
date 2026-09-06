/**
 * EffectsSection — compact editor for the `effects` section.
 *
 * Seven full-width captioned rows became four: the two filters pair, the two
 * transform properties pair, and the two timing properties pair. `boxShadow`
 * stays full width because its value is a comma-separated list that is
 * unreadable in half a panel. `opacity` moved to the `appearance` section
 * (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G5, F10) — it sits beside corner
 * radius now, not among the effects.
 *
 * Layout spec over StackedPropertyGrid — what each cell draws is decided by
 * `ClassPropertyRow`, not here.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import type { PropertyProvenance } from './stylePropertyProvenance'

const EFFECTS_SPEC: ReadonlyArray<StackedGridEntry> = [
  'boxShadow',
  ['filter', 'backdropFilter'],
  ['transform', 'transformOrigin'],
  ['transition', 'animation'],
]

interface EffectsSectionProps {
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

export function EffectsSection(props: EffectsSectionProps) {
  return <StackedPropertyGrid spec={EFFECTS_SPEC} {...props} />
}
