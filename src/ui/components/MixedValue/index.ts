/**
 * MixedValue — the shared "multiple selected values disagree" sentinel.
 *
 * Figma's inspector shows an empty field with a "Mixed" placeholder when a
 * multi-selection's values for one property don't all agree, and typing a
 * new value replaces it on every selected item. That contract shows up
 * anywhere a control can be driven by more than one underlying value at
 * once — `ScrubInput` (WS-6.4), `FrameBulkInspector`'s width/height
 * (WS-7.2), and any future bulk node-property editor.
 *
 * `MIXED` is a `Symbol`, not a string sentinel like `'__mixed__'`, so it can
 * never collide with a real value a user typed or a CSS engine produced.
 */

/** Unique sentinel meaning "the selection's values for this field disagree". */
export const MIXED: unique symbol = Symbol('studio-mixed-value')

/** The type of the `MIXED` sentinel — use as `T | Mixed` in a control's value prop. */
export type Mixed = typeof MIXED

/** True when `value` is the `MIXED` sentinel. */
export function isMixed(value: unknown): value is Mixed {
  return value === MIXED
}

/**
 * Collapse a set of values from a multi-selection into either the single
 * shared value (when every item agrees) or `MIXED`. `undefined` items are
 * treated as a real, comparable value (e.g. "no override set") rather than
 * being skipped — callers that want to ignore missing values should filter
 * before calling this.
 */
export function collapseValues<T>(values: readonly T[]): T | Mixed | undefined {
  if (values.length === 0) return undefined
  const first = values[0] as T
  return values.every((v) => v === first) ? first : MIXED
}
