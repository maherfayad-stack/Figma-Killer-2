/**
 * EffectsSection — compact editor for the `effects` section.
 *
 * Eight full-width captioned rows became five: `opacity` carries its own
 * half-filled-square mark and needs no caption, the two filters pair, the two
 * transform properties pair, and the two timing properties pair. `boxShadow`
 * stays full width because its value is a comma-separated list that is
 * unreadable in half a panel.
 *
 * Layout spec over StackedPropertyGrid — what each cell draws is decided by
 * `ClassPropertyRow`, not here.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'

const EFFECTS_SPEC: ReadonlyArray<StackedGridEntry> = [
  'opacity',
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
}

export function EffectsSection(props: EffectsSectionProps) {
  return <StackedPropertyGrid spec={EFFECTS_SPEC} {...props} />
}
