/**
 * elementSizing — the Fixed / Hug / Fill sizing-intent model behind
 * `SizeSection`'s width and height fields.
 *
 * docs/features/inspector-disclosure.md, G2 (F30/F31): Figma folds a sizing
 * INTENT into the same control that shows the number — `Fixed` (a literal
 * length), `Hug contents` (shrink-wrap to content), or `Fill container`
 * (stretch to the containing block). This module is the pure,
 * framework-agnostic half of that: given a property's OWN stored
 * declaration AND the layout of the element's real parent, which of the
 * three intents is it expressing; and given a chosen intent, what CSS
 * expresses it.
 *
 * ## Why the parent has to be an input (W8-4)
 *
 * The first version of this module wrote `fit-content` / `100%`
 * unconditionally, for every element, in every container. That is only
 * correct in ONE of the four cases:
 *
 *   - **Parent is a block container** — `width: 100%` really does fill it.
 *   - **Parent is flex, on the MAIN axis** — `100%` resolves against the
 *     container's content box and ignores both `gap` and its siblings, so a
 *     "Fill" item in a gapped row overflows the row by the width of the gaps
 *     and shoves every sibling out. The honest write is `flex: 1 1 0`, which
 *     is what "take the leftover space" means in flexbox.
 *   - **Parent is flex, on the CROSS axis** — the per-item stretch control is
 *     `align-self: stretch`, and it only applies while the cross size is
 *     `auto`, so Fill must also CLEAR the axis property rather than set it.
 *   - **Parent is grid** — same shape, but the per-item control is
 *     `justify-self` (inline axis) / `align-self` (block axis).
 *
 * `sizingAxisRole` is the one place that classification lives. Every other
 * function here takes its answer rather than re-deriving it.
 *
 * **Read-back is the exact mirror of the write.** `currentSizingMode` asks
 * the same role question and then looks for the same marker the writer would
 * have left, so the mode picker always reflects what is actually in the
 * source — never a guess. A `width: 100%` sitting on a flex child reads as
 * `Fixed` (it IS a literal length there, and a dishonest one), not as Fill.
 *
 * **No parent, no Hug/Fill.** When the parent's layout can't be read — the
 * element is the root of a cross-file component, nothing has rendered it on
 * the canvas yet, or it simply has no parent node — every mode except
 * `fixed` is unavailable and `sizingUnavailableReason` names why. This module
 * refuses to write a value it cannot justify; `sizingPatch` returns an empty
 * patch for Hug/Fill in that state even if a caller asks anyway.
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
 * numbers, not mode words.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { hasStyleValue } from './styleValueUtils'

export type SizingMode = 'fixed' | 'hug' | 'fill'

/** The two axes a size field can own. Matches the CSS property name. */
export type SizingAxis = 'width' | 'height'

/**
 * The selected element's REAL parent, as read off a live canvas frame
 * (`useSizingParentLayout`). Never a guess and never a stored declaration —
 * only `getComputedStyle` knows what a class, a cascade, and a media query
 * actually resolved `display` to.
 */
export interface SizingParentLayout {
  /** Computed `display` of the parent (`flex`, `inline-grid`, `block`, …). */
  display: string
  /** Computed `flex-direction` of the parent. Only consulted for flex parents. */
  flexDirection: string
}

/**
 * How ONE axis of a child relates to its parent's layout. This is the single
 * fact that decides which CSS Hug/Fill write is honest.
 */
export type SizingAxisRole = 'flex-main' | 'flex-cross' | 'grid' | 'block'

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

/**
 * A set of CSS writes expressing one mode switch. `undefined` means CLEAR
 * the property; a string means set it. Keys absent from the patch are left
 * exactly as they are — this model only ever touches the axis property and
 * the one companion property its own role owns, so it can never clobber an
 * unrelated declaration the user made by hand.
 */
export type SizingPatch = Readonly<Partial<Record<keyof CSSPropertyBag, string | undefined>>>

/** CSS this model writes for "Hug contents" on the axis property itself. */
const HUG_VALUE = 'fit-content'
/** "Fill container" on a BLOCK parent — the only container where it's right. */
const BLOCK_FILL_VALUE = '100%'
/** "Fill container" on a flex MAIN axis: take the leftover space, gap-aware. */
const FLEX_MAIN_FILL_VALUE = '1 1 0'
/** "Hug contents" on a flex MAIN axis: size to content and refuse to shrink. */
const FLEX_MAIN_HUG_VALUE = '0 0 auto'
/** "Fill container" on a flex CROSS axis or either grid axis. */
const STRETCH_VALUE = 'stretch'

/**
 * Every `flex` shorthand this model treats as its own "Fill" marker on
 * read-back. `1` is included because it is the canonical CSS shorthand for
 * `1 1 0%` and a user (or a formatter) may well have written it that way.
 */
const FILL_FLEX_VALUES: ReadonlySet<string> = new Set(['1', '1 1 0', '1 1 0%', '1 1 0px'])

export const SIZING_OPTIONS: ReadonlyArray<SizingModeOption> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'hug', label: 'Hug contents', word: 'Hug' },
  { value: 'fill', label: 'Fill container', word: 'Fill' },
]

function normalize(value: unknown): string {
  return hasStyleValue(value) ? String(value).trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

/**
 * Classify one axis against the parent's computed layout. `null` when the
 * parent is unknown — the caller must then offer `fixed` only.
 */
export function sizingAxisRole(
  axis: SizingAxis,
  parent: SizingParentLayout | null,
): SizingAxisRole | null {
  if (!parent) return null
  const display = normalize(parent.display)
  if (display === 'grid' || display === 'inline-grid') return 'grid'
  if (display === 'flex' || display === 'inline-flex') {
    const mainAxis: SizingAxis = normalize(parent.flexDirection).startsWith('column')
      ? 'height'
      : 'width'
    return axis === mainAxis ? 'flex-main' : 'flex-cross'
  }
  return 'block'
}

/**
 * The per-item stretch property for a role, or `null` for roles that express
 * Fill through the axis property (`block`) or the `flex` shorthand
 * (`flex-main`).
 */
function selfProperty(role: SizingAxisRole, axis: SizingAxis): keyof CSSPropertyBag | null {
  if (role === 'flex-cross') return 'alignSelf'
  if (role === 'grid') return axis === 'width' ? 'justifySelf' : 'alignSelf'
  return null
}

/**
 * Which sizing intent an element's stored declarations express for one axis,
 * given its parent's layout. Reads back exactly what `sizingPatch` writes —
 * see the module doc. Never pass computed/measured values here.
 */
export function currentSizingMode(
  axis: SizingAxis,
  parent: SizingParentLayout | null,
  stored: Record<string, unknown>,
): SizingMode {
  const role = sizingAxisRole(axis, parent)
  // Unknown parent: Hug/Fill are not offered, so nothing can be reading as
  // one. Whatever is on the axis is shown for what it literally is.
  if (!role) return 'fixed'

  const own = normalize(stored[axis])

  if (role === 'block') {
    if (own === BLOCK_FILL_VALUE) return 'fill'
    if (own === HUG_VALUE) return 'hug'
    return 'fixed'
  }

  if (role === 'flex-main') {
    if (FILL_FLEX_VALUES.has(normalize(stored.flex))) return 'fill'
    if (own === HUG_VALUE) return 'hug'
    return 'fixed'
  }

  const self = selfProperty(role, axis)
  if (self && normalize(stored[self]) === STRETCH_VALUE) return 'fill'
  if (own === HUG_VALUE) return 'hug'
  return 'fixed'
}

/** Freeze a measured size into a literal length for the `fixed` write. */
function frozenLength(measuredValue: unknown): string {
  if (typeof measuredValue === 'number') return `${measuredValue}px`
  if (typeof measuredValue === 'string' && measuredValue !== '') {
    return /^-?\d+(\.\d+)?$/.test(measuredValue) ? `${measuredValue}px` : measuredValue
  }
  return '0px'
}

/**
 * The CSS a mode switch writes for one axis, resolved against the parent's
 * real layout.
 *
 * Switching TO `fixed` freezes `measuredValue` (the frame's real, currently
 * rendered size — pass `currentStyles[axis]`) as a literal length, so leaving
 * Hug/Fill for Fixed keeps the box the size it was actually rendering at
 * instead of resetting it to `0`. It also drops whichever companion
 * declaration THIS model wrote (and only that one — a hand-authored
 * `align-self: center` is left alone, because it is not a marker this model
 * ever writes).
 *
 * With an unknown parent, `hug`/`fill` return an EMPTY patch: there is no
 * honest write, and this module does not guess. The UI disables those modes
 * (`sizingUnavailableReason`) so that path is not normally reachable.
 */
export function sizingPatch(
  mode: SizingMode,
  axis: SizingAxis,
  parent: SizingParentLayout | null,
  stored: Record<string, unknown>,
  measuredValue: unknown,
): SizingPatch {
  const role = sizingAxisRole(axis, parent)
  const patch: Partial<Record<keyof CSSPropertyBag, string | undefined>> = {}

  if (mode === 'fixed') {
    patch[axis] = frozenLength(measuredValue)
    if (role === 'flex-main' && FILL_FLEX_VALUES.has(normalize(stored.flex))) {
      patch.flex = undefined
    }
    if (role === 'flex-main' && normalize(stored.flex) === FLEX_MAIN_HUG_VALUE) {
      patch.flex = undefined
    }
    if (role) {
      const self = selfProperty(role, axis)
      if (self && normalize(stored[self]) === STRETCH_VALUE) patch[self] = undefined
    }
    return patch
  }

  if (!role) return patch

  if (mode === 'hug') {
    patch[axis] = HUG_VALUE
    if (role === 'flex-main') {
      // Content-sized AND non-shrinking: `flex-basis: auto` defers to the
      // `fit-content` above, and `flex-shrink: 0` keeps a crowded row from
      // squeezing the box below the content it was told to hug.
      patch.flex = FLEX_MAIN_HUG_VALUE
    } else {
      // Cross-axis flex and both grid axes stretch by DEFAULT; `fit-content`
      // on the axis is itself enough to stop that (stretch only applies to an
      // `auto` size), so hug only has to drop a previous Fill's marker.
      const self = selfProperty(role, axis)
      if (self && normalize(stored[self]) === STRETCH_VALUE) patch[self] = undefined
    }
    return patch
  }

  // mode === 'fill'
  if (role === 'block') {
    patch[axis] = BLOCK_FILL_VALUE
    return patch
  }
  // Every non-block Fill expresses itself through a companion property, and
  // every one of them requires the axis size to be `auto` to take effect —
  // so the axis declaration must go, not be overwritten.
  if (hasStyleValue(stored[axis])) patch[axis] = undefined
  if (role === 'flex-main') {
    patch.flex = FLEX_MAIN_FILL_VALUE
    return patch
  }
  const self = selfProperty(role, axis)
  if (self) patch[self] = STRETCH_VALUE
  return patch
}

/**
 * Why Hug and Fill are unavailable, or `undefined` when they are available.
 * One sentence, shown as the disabled menu item's tooltip — the same
 * disabled-with-a-named-reason shape `AlignBar`'s `alignDisabledReasons`
 * uses in `PositionSection`.
 */
export function sizingUnavailableReason(parent: SizingParentLayout | null): string | undefined {
  if (parent) return undefined
  return "Hug and Fill need to know how the parent lays this element out, and no parent layout could be read."
}
