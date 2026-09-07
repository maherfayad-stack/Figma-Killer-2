/**
 * styleFieldDisplay — the ONE rule for what a style field shows.
 *
 * Before this, every section wrote its own copy of the same three-way
 * decision, and all of them landed on the same answer: a property the active
 * target does not declare rendered as an EMPTY field with the element's real
 * value greyed out behind it as a `placeholder`. That reads as "this element
 * has no width", which is never true — the element on the canvas is 320px
 * wide and the panel is showing an empty box. The user's report was exactly
 * that: "the panel should be prefilled already with the current values even
 * if inline styles".
 *
 * So the rule is now: **a field shows the value the element actually renders.**
 *
 *   1. the value STORED on the active target (this class rule / this node's
 *      `style=""`), when it has one — the thing an edit here would replace;
 *   2. otherwise the CURRENT value — the frame's real computed value, which
 *      already folds in whatever an inline `style={{}}` contributes (see
 *      `useFrameComputedStyleValues` and the `{ ...computedValues, ...stored }`
 *      fold both composers do). It is rendered MUTED and the row keeps its
 *      unset state, so "shown" never means "claimed to be set here";
 *   3. otherwise nothing — and only then does a `placeholder` (the spec
 *      default) act as a hint. A field with no stored value AND no frame
 *      truth has nothing honest to prefill with.
 *
 * ## What "set" still means
 *
 * `isSet` is unchanged and is NOT derived from what the field displays. It
 * stays "the active target declares this property", which is what drives the
 * row's `data-state`, its indicator dot, the "N set" section meta and the
 * remove button. Prefilling changes what a field READS as, never what the
 * panel CLAIMS about the source. `inherited` is the presentational half of
 * the same fact — the flag a control turns into a muted tone.
 *
 * ## Editing a prefilled value
 *
 * Committing over a prefilled value writes it for real. That is deliberate:
 * dragging Width from its rendered 320px to 340px should set `width: 340px`
 * on the target, which is what the user just asked for. Committing the SAME
 * value writes nothing — every field's commit path compares against what it
 * was displaying — so merely focusing and blurring a prefilled field can
 * never silently add a declaration to someone's stylesheet.
 */

import { isMixed, MIXED, type Mixed } from '@ui/components/MixedValue'
import { hasStyleValue } from './styleValueUtils'

export interface StyleFieldDisplay {
  /**
   * What the control renders: `MIXED` for a disagreeing multi-selection, the
   * stored value, the current (frame) value, or `undefined` when there is
   * neither.
   */
  value: string | Mixed | undefined
  /**
   * The hint for a field with nothing real to show (the spec default), or
   * `undefined`. Never the current value — that is `value` now.
   */
  placeholder: string | undefined
  /** Does the ACTIVE target declare this property? Drives the set indicator. */
  isSet: boolean
  /** `value` came from the frame, not from the target — render it muted. */
  inherited: boolean
}

export interface StyleFieldDisplayInput {
  /** The active target's own value for this property (class rule / inline bag). */
  storedValue: unknown
  /** The merged "what this element actually renders" value for the property. */
  currentValue: unknown
  /** Last-resort hint (a spec default) when neither of the above has a value. */
  fallback?: unknown
}

/**
 * Resolve one style field's display. See this module's doc for the rule.
 *
 * `hasStyleValue(MIXED)` is true, so the mixed sentinel is tested FIRST in
 * both bags — otherwise a multi-selection would stringify a Symbol into a
 * text field.
 */
export function resolveStyleFieldDisplay({
  storedValue,
  currentValue,
  fallback,
}: StyleFieldDisplayInput): StyleFieldDisplay {
  const mixed = isMixed(storedValue) || (!hasStyleValue(storedValue) && isMixed(currentValue))
  if (mixed) {
    return { value: MIXED, placeholder: undefined, isSet: false, inherited: false }
  }
  if (hasStyleValue(storedValue)) {
    return { value: String(storedValue), placeholder: undefined, isSet: true, inherited: false }
  }
  if (hasStyleValue(currentValue)) {
    return { value: String(currentValue), placeholder: undefined, isSet: false, inherited: true }
  }
  return {
    value: undefined,
    placeholder: hasStyleValue(fallback) ? String(fallback) : undefined,
    isSet: false,
    inherited: false,
  }
}
