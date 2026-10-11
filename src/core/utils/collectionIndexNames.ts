/**
 * collectionIndexNames - which number prop of a component is "the current
 * entry of that list", decided by NAME.
 *
 * One rule for both readers: the component-spec extractor
 * (`componentSpecExtract.ts`, a local component's `value` next to its `items`)
 * and the inspector's nested editor (`Navbar`'s `segmentedControl = { items,
 * value }`). The built-in design system's manifest records the same fact
 * explicitly (`PropSpec.indexesCollection`); this is the reading for source
 * that carries no such record.
 */

/** Number props that, by name, say "which entry is current" - `value`, `activeIndex`, `selectedTab`. */
export const INDEX_PROP_NAME_RE = /^(?:value|index|(?:selected|active|current)(?:Index|Tab|Item|Step|Segment)?|tabIndex|step)$/

/** A list prop named like what it holds, preferred when a component has several. */
const COLLECTION_NAME_RE = /^(?:items|tabs|options|segments|steps|pages|slides|choices|chips)$/

/**
 * The one list an index prop points into: the only list there is, or else the
 * one named like a list of choices. `undefined` when neither holds - a number
 * next to several unrelated lists stays a number.
 */
export function pickIndexedCollection(listNames: readonly string[]): string | undefined {
  if (listNames.length === 1) return listNames[0]
  return listNames.find((name) => COLLECTION_NAME_RE.test(name))
}
