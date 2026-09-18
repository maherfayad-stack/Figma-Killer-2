/**
 * Shared "is this CSS property set?" helpers used across PropertiesPanel
 * sections. Single source of truth for the trio of treatments we apply to
 * raw style cells — "set" means a non-empty string or any number, anything
 * else (undefined, null, empty string) is treated as unset.
 */

import { isMixed, MIXED, type Mixed } from '@ui/components/MixedValue'

/**
 * Read a property from a styles bag, returning the value only if it is a
 * non-empty string. Numbers, undefined, null, and empty strings collapse to
 * `undefined` so callers can keep their conditionals concise.
 */
export function readString(styles: Record<string, unknown>, key: string): string | undefined {
  const v = styles[key]
  if (typeof v === 'string' && v !== '') return v
  return undefined
}

/**
 * Narrow check: returns true when the given value would render as a real CSS
 * value (a non-empty string or any number). Empty string is treated as unset
 * so we mirror the storage model used by `removeClassStyleProperty`.
 */
export function hasStyleValue(value: unknown): value is string | number {
  return value !== undefined && value !== null && value !== ''
}

/**
 * W8-3 — the same read, but preserving the multi-selection `MIXED` sentinel.
 *
 * `readString` / `pickString` answer "what string does this cell hold?", and
 * `MIXED` is a Symbol, so both collapse it to "nothing" — which is how the
 * bespoke sections came to render their ordinary *unset* state (a blank
 * field, no pressed segment) for a selection whose members genuinely
 * disagree. Every control in the panel already knows how to say "Mixed";
 * they were simply never told. These two helpers are what tells them.
 */
export function pickMixedString(value: unknown): string | Mixed {
  if (isMixed(value)) return MIXED
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

/**
 * The raw cell, typed exactly as `ClassPropertyRow`'s `value` prop wants it
 * and PRESERVING the `MIXED` sentinel.
 *
 * `pickMixedString` is the sibling for a control that only speaks strings; it
 * stringifies a number as `${n}px`, which is wrong for a row that hands the
 * number straight to a numeric control. Callers used to reach for
 * `styles[prop] as string | number`, which type-launders a Symbol into a
 * value the row would then have to stringify — the exact cast §9.3 calls the
 * other half of the Mixed bug.
 */
export function pickMixedCell(value: unknown): string | number | Mixed | undefined {
  if (isMixed(value)) return MIXED
  if (typeof value === 'string' || typeof value === 'number') return value
  return undefined
}

/** `MIXED` narrowed away — for the call sites that need a plain string. */
export function plainString(value: string | Mixed | undefined): string {
  return value === undefined || isMixed(value) ? '' : value
}

/**
 * Is the field for `key` driven by a selection that disagrees?
 *
 * True when the EDITING TARGET's own cell is `MIXED`, and also when the
 * target holds nothing but the members' EFFECTIVE values differ — the second
 * case is the placeholder layer, where "Mixed" is the honest hint and the
 * computed value of an arbitrary member is not. Under a single selection
 * both bags hold plain values and this is always false.
 */
export function isMixedStyleValue(
  storedStyles: Record<string, unknown>,
  currentStyles: Record<string, unknown>,
  key: string,
): boolean {
  if (isMixed(storedStyles[key])) return true
  return !hasStyleValue(storedStyles[key]) && isMixed(currentStyles[key])
}
