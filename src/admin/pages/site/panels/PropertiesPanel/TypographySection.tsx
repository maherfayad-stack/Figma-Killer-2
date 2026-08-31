/**
 * TypographySection — Figma-style compact editor for the `typography` section.
 *
 * Font family spans the full width; weight/size, line-height/letter-spacing,
 * alignment/style, and decoration/transform pair into two columns each.
 * Colour, white-space, and text-shadow keep full-width rows — they read
 * better wide. All of it is just a layout spec over StackedPropertyGrid, so
 * the dispatch / token / preview / font-weight logic is shared with every
 * other property row.
 *
 * What each cell actually draws is NOT decided here. `ClassPropertyRow`
 * resolves it per property: the four alignment/style/decoration/transform
 * enums render as icon toggle groups with no words at all, line-height and
 * letter-spacing carry a caption plus a glyph inside the field, and family /
 * weight / size are captionless because their own values name them. This
 * file only says what sits beside what.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import type { PropertyProvenance } from './stylePropertyProvenance'

const TYPOGRAPHY_SPEC: ReadonlyArray<StackedGridEntry> = [
  'fontFamily',
  // Weight before size: Figma's order, and the one that reads correctly —
  // the family and its weight are one choice, the size is a separate one.
  ['fontWeight', 'fontSize'],
  ['lineHeight', 'letterSpacing'],
  ['textAlign', 'fontStyle'],
  ['textDecoration', 'textTransform'],
  'color',
  'whiteSpace',
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
  /** Track F1 — see `StackedPropertyGrid`'s doc. */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function TypographySection(props: TypographySectionProps) {
  return <StackedPropertyGrid spec={TYPOGRAPHY_SPEC} {...props} />
}
