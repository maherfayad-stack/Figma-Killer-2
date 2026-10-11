/**
 * collectionIndexOptions - a list prop's entries as the choices of an "which
 * one is current" select: `TabBar.value` over `items`, `Navbar`'s
 * `segmentedControl.value` over its own `items`.
 */
/**
 * The sibling collection's entries as select options, labelled the way a person
 * would name them.
 *
 * A design system's list entries are objects (`{ icon, label }`) or bare strings
 * (`SegmentedControl`'s `items={['Flights', 'Stays']}`), so both are read. An
 * entry with no readable name still gets a row — dropping it would shift every
 * index after it and silently select the wrong tab.
 */
export function collectionIndexOptions(collection: unknown): { label: string; value: string }[] {
  if (!Array.isArray(collection)) return []
  return collection.map((item, index) => ({ label: collectionEntryLabel(item, index), value: String(index) }))
}

/** One entry's display name: its own label/title, the string it is, or its position. */
export function collectionEntryLabel(item: unknown, index: number): string {
  if (typeof item === 'string' && item.trim() !== '') return item
  if (typeof item === 'object' && item !== null) {
    for (const key of ['label', 'title', 'name', 'text']) {
      const value = (item as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return `Item ${index + 1}`
}
