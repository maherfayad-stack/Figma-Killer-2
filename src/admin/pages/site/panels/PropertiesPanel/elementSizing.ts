/**
 * elementSizing — the Fixed / Hug / Fill sizing-intent model behind
 * `SizeSection`'s width and height fields.
 *
 * STUDIO-INSPECTOR-DISCLOSURE-PLAN.md, G2 (F30/F31): Figma folds a sizing
 * INTENT into the same control that shows the number — `Fixed` (a literal
 * length), `Hug contents` (shrink-wrap to content), or `Fill container`
 * (stretch to the containing block). This module is the pure,
 * framework-agnostic half of that: given a property's OWN stored
 * declaration, which of the three intents is it expressing; and given a
 * chosen intent, what CSS value expresses it.
 *
 * `currentSizingMode` reads the STORED value only, never a computed/measured
 * one. A computed read (`currentStyles`, the frame's real `getComputedStyle`)
 * resolves `fit-content` down to a concrete pixel number the moment a frame
 * renders — checking that instead would make every Hug-contents box
 * misreport as Fixed the instant it had a real rendered size. The stored
 * declaration is the only place "the user asked for Hug" survives.
 *
 * A property with no stored declaration reads as `fixed` (unset, showing the
 * frame's measured value as a placeholder) rather than defaulting to Hug —
 * the plain "no auto-layout" case (F3: `W 266 / H 435`) is shown as plain
 * numbers, not mode words. A field only becomes Hug or Fill once the user
 * explicitly picks it from the field's own dropdown, which writes the
 * literal CSS keyword `sizingPatch` returns below.
 */
import { hasStyleValue } from './styleValueUtils'

export type SizingMode = 'fixed' | 'hug' | 'fill'

export interface SizingModeOption {
  value: SizingMode
  /** Plain menu label ("Hug contents"). `SizeSection` quotes the field's
   *  live value onto `fixed`'s own label via
   *  `AddablePropertyFieldMode.activeLabel` — this label is what every
   *  OTHER (non-active) mode shows. */
  label: string
  /** The word the field shows in place of a number while this mode is
   *  active (F4's "Hug"). Absent for `fixed` — its field shows a number. */
  word?: string
}

/** CSS this model writes for "Hug contents" — shrink-wraps the box to its
 *  content on either axis. */
const HUG_VALUE = 'fit-content'
/** CSS this model writes for "Fill container" — stretches to the element's
 *  containing block. */
const FILL_VALUE = '100%'

export const SIZING_OPTIONS: ReadonlyArray<SizingModeOption> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'hug', label: 'Hug contents', word: 'Hug' },
  { value: 'fill', label: 'Fill container', word: 'Fill' },
]

/**
 * Which sizing intent a property's OWN stored declaration expresses. Never
 * pass a computed/measured value here — see the module doc.
 */
export function currentSizingMode(storedValue: unknown): SizingMode {
  if (hasStyleValue(storedValue)) {
    const normalized = String(storedValue).trim().toLowerCase()
    if (normalized === FILL_VALUE) return 'fill'
    if (normalized === HUG_VALUE) return 'hug'
  }
  return 'fixed'
}

/**
 * The CSS value a mode switch writes. Switching TO `fixed` freezes
 * `measuredValue` (the frame's real, currently-rendered size — pass
 * `currentStyles[property]`) as a literal length, so leaving Hug/Fill for
 * Fixed keeps the box the size it was actually rendering at instead of
 * resetting it to `0`.
 */
export function sizingPatch(mode: SizingMode, measuredValue: unknown): string {
  if (mode === 'hug') return HUG_VALUE
  if (mode === 'fill') return FILL_VALUE
  if (typeof measuredValue === 'number') return `${measuredValue}px`
  if (typeof measuredValue === 'string' && measuredValue !== '') {
    return /^-?\d+(\.\d+)?$/.test(measuredValue) ? `${measuredValue}px` : measuredValue
  }
  return '0px'
}
