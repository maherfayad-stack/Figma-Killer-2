/**
 * styleWriteReach — "this edit lands on 3 of the 5 things you selected, and
 * here is what the other 2 are" (W8-3 phase 2).
 *
 * ## Why a count, and not a boolean
 *
 * `StyleWriteLockContext` used to answer one question — *can* a declaration
 * typed into the enclosing style target reach disk, yes or no — because a
 * single-node surface only ever has one target and one answer. A
 * multi-selection breaks that in half: `setNodesInlineStyles` skips
 * INDIVIDUAL nodes whose source refuses the property
 * (`isStylePatchWritableToSource`) and writes the rest, deliberately, so one
 * code-valued `style` entry can't cost the other four layers their edit.
 *
 * That leaves a state the boolean cannot say: **the write partly lands.**
 * Rendering it as "unlocked" is the panel claiming an edit reached five
 * elements when it reached three; rendering it as "locked" would disable a
 * control that works for the majority of the selection. Neither is true, so
 * the context grows a third state that carries the numbers and lets the row
 * stay editable.
 *
 * ## The reach is per PROPERTY, not per selection
 *
 * A node whose `width` comes from an expression takes a `color` edit
 * perfectly well. A selection-wide "2 of these are locked" would therefore
 * be false on every property but `width` — precise enough to look
 * authoritative and wrong often enough to teach the user to ignore it. So
 * the reach is a map keyed by property, built once per render of the bulk
 * composer, and each row asks about ITS OWN property in O(1).
 *
 * ## Vocabulary
 *
 * `reason` is the noun phrase completing "N are …" — "set from an expression
 * in code" for the inline target here, "compiled" for the class target
 * phase 3 introduces. Kept as data rather than hardcoded so the two callers
 * can differ without this module growing a mode flag.
 */

/** The `codeProps` prefix that marks an inline style entry, e.g. `style:width`. */
const STYLE_PROP_PREFIX = 'style:'

export interface StyleWriteReach {
  /** How many targets the bulk editor is writing to (the selection size). */
  total: number
  /**
   * property -> how many targets REFUSE it. Only refused properties appear;
   * an absent key means the write reaches all `total` targets.
   */
  blockedByProperty: ReadonlyMap<string, number>
  /** Noun phrase completing "N are …". See this module's Vocabulary note. */
  reason: string
}

/** Every property any target refuses, in first-seen order. */
export function blockedProperties(reach: StyleWriteReach): string[] {
  return [...reach.blockedByProperty.keys()]
}

/**
 * The inline-target reach for a multi-selection: a node refuses `style:<prop>`
 * exactly when its `codeProps` names it, which is the same fact
 * `isStylePatchWritableToSource` consults inside the mutation. Read here, not
 * re-derived: the list is the parser's, and this only counts it.
 */
export function buildInlineStyleWriteReach(
  nodes: ReadonlyArray<{ codeProps?: ReadonlyArray<string> }>,
  reason: string,
): StyleWriteReach {
  const blockedByProperty = new Map<string, number>()
  for (const node of nodes) {
    for (const name of node.codeProps ?? []) {
      if (!name.startsWith(STYLE_PROP_PREFIX)) continue
      const property = name.slice(STYLE_PROP_PREFIX.length)
      blockedByProperty.set(property, (blockedByProperty.get(property) ?? 0) + 1)
    }
  }
  return { total: nodes.length, blockedByProperty, reason }
}

/**
 * How far a write to `property` actually reaches. `blocked` is 0 for the
 * overwhelmingly common property, which is what makes this cheap enough to
 * call from every row on every render.
 */
export function reachForProperty(
  reach: StyleWriteReach,
  property: string,
): { writable: number; total: number; blocked: number } {
  const blocked = reach.blockedByProperty.get(property) ?? 0
  return { writable: reach.total - blocked, total: reach.total, blocked }
}

/**
 * The sentence a partially-reaching row shows, or `null` when the write
 * reaches every target (the normal case — a row with nothing to disclose
 * must disclose nothing, or the panel cries wolf on every property).
 *
 * Reads "Writes to 3 of 5 selected layers — 2 are set from an expression in
 * code." The zero-writable case is a genuine refusal and says so instead of
 * counting to zero.
 */
export function describeReach(reach: StyleWriteReach, property: string): string | null {
  const { writable, total, blocked } = reachForProperty(reach, property)
  if (blocked === 0 || total === 0) return null
  const layers = total === 1 ? 'selected layer' : 'selected layers'
  if (writable === 0) {
    return `No selected layer takes this edit — ${blocked === 1 ? 'it is' : 'all are'} ${reach.reason}.`
  }
  return `Writes to ${writable} of ${total} ${layers} — ${blocked} ${blocked === 1 ? 'is' : 'are'} ${reach.reason}.`
}
