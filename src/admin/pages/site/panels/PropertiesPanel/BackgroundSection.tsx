/**
 * BackgroundSection — compact editor for the `background` section.
 *
 * Colour, the `background` shorthand, and the multi-mode background-image
 * control read better full width; the size/repeat and object-fit/position
 * pairs collapse into two columns. Layout spec over StackedPropertyGrid.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'

const BACKGROUND_SPEC: ReadonlyArray<StackedGridEntry> = [
  'backgroundColor',
  'background',
  'backgroundImage',
  ['backgroundSize', 'backgroundRepeat'],
  'backgroundPosition',
  ['objectFit', 'objectPosition'],
]

interface BackgroundSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function BackgroundSection(props: BackgroundSectionProps) {
  return <StackedPropertyGrid spec={BACKGROUND_SPEC} {...props} />
}
