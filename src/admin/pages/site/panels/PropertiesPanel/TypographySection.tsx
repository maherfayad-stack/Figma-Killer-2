/**
 * TypographySection — Figma-style compact editor for the `typography` section.
 *
 * Font family spans the full width; size/weight, line-height/letter-spacing,
 * alignment/style, and decoration/transform pair into two columns each.
 * Colour, white-space, and text-shadow keep full-width rows — they read
 * better wide. All of it is just a layout spec over StackedPropertyGrid, so
 * the dispatch / token / preview / font-weight logic is shared with every
 * other property row.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'

const TYPOGRAPHY_SPEC: ReadonlyArray<StackedGridEntry> = [
  'fontFamily',
  ['fontSize', 'fontWeight'],
  ['lineHeight', 'letterSpacing'],
  ['textAlign', 'fontStyle'],
  ['textDecoration', 'textTransform'],
  'whiteSpace',
  'color',
  'textShadow',
]

interface TypographySectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Properties that survived the active style search. */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  /** Active breakpoint tab id. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function TypographySection(props: TypographySectionProps) {
  return <StackedPropertyGrid spec={TYPOGRAPHY_SPEC} {...props} />
}
