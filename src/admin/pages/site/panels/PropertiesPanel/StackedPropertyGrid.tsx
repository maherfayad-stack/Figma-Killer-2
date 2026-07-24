/**
 * StackedPropertyGrid — renders a curated CSS section as compact, Figma-style
 * stacked cells from a declarative layout spec.
 *
 * The `spec` is an ordered list where each entry is either a single property
 * (rendered full-width) or a `[left, right]` tuple (rendered as two columns).
 * Every cell is a `ClassPropertyRow` in `stacked` layout (small label above a
 * full-width control), so this reuses the exact dispatch / token / preview /
 * font-weight logic of the inline rows — only the arrangement changes.
 *
 * `visibleProperties` gates rendering so an active style search narrows the
 * grid: a paired entry with only one visible side degrades to a full-width
 * single, and an entry with nothing visible is dropped (no empty grid gaps).
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from './ClassPropertyRow'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import styles from './StackedPropertyGrid.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One row of the grid: a single full-width property, or a paired tuple. */
export type StackedGridEntry =
  | keyof CSSPropertyBag
  | readonly [keyof CSSPropertyBag, keyof CSSPropertyBag]

interface StackedPropertyGridProps {
  /** Ordered layout: singles render full-width, tuples render as two columns. */
  spec: ReadonlyArray<StackedGridEntry>
  /**
   * Properties allowed to render (post style-search filter). With no query
   * this is the section's full property list; a query narrows it.
   */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — keys rows so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /** Patch-shaped hover / as-you-type preview channel. */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

// ---------------------------------------------------------------------------
// StackedPropertyGrid
// ---------------------------------------------------------------------------

export function StackedPropertyGrid({
  spec,
  visibleProperties,
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: StackedPropertyGridProps) {
  const visible = new Set(visibleProperties)

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  const renderRow = (property: keyof CSSPropertyBag) => {
    const storedValue = storedStyles[property]
    const isSet = hasStyleValue(storedValue)
    const currentValue = currentStyles[property]
    const fallbackValue = hasStyleValue(currentValue)
      ? currentValue
      : getCSSPropertyDefaultValue(property)

    return (
      <ClassPropertyRow
        key={`${activeTab}-${String(property)}`}
        property={property}
        value={isSet ? (storedValue as string | number) : undefined}
        placeholder={!isSet ? fallbackValue : undefined}
        fontFamilyValue={currentStyles.fontFamily}
        isSet={isSet}
        layout="stacked"
        onChange={onChange}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
    )
  }

  return (
    <div className={styles.grid}>
      {spec.map((entry) => {
        if (!Array.isArray(entry)) {
          const prop = entry as keyof CSSPropertyBag
          return visible.has(prop) ? renderRow(prop) : null
        }

        const [a, b] = entry
        const aVisible = visible.has(a)
        const bVisible = visible.has(b)
        if (!aVisible && !bVisible) return null
        // Only one side survived the search filter — render it full width so
        // there's no dangling half-empty pair row.
        if (aVisible !== bVisible) return renderRow(aVisible ? a : b)
        return (
          <div key={`${activeTab}-${String(a)}-${String(b)}`} className={styles.pairGrid}>
            {renderRow(a)}
            {renderRow(b)}
          </div>
        )
      })}
    </div>
  )
}
