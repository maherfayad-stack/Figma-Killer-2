/**
 * designVariableNormalize — turns an authored design-variable value into a
 * comparable unit, or admits it can't.
 *
 * A design tool's variable table hands back values as authored strings (or,
 * for a FLOAT variable forwarded verbatim from JSON, a bare number) — never
 * pre-normalised. `#EF4550`, `#ef4550`, and `rgb(239, 69, 80)` are the same
 * colour; `16`, `16px`, and `1rem` may or may not be the same length. This
 * module is the ONE place that decides, so `designVariableStore.ts` and the
 * three-way mapping in `referenceMeasure.ts` agree.
 *
 * ## Colour
 *
 * Delegates to `@core/design-tokens`'s `cssColorToRgb` — the exact parser
 * `projectTokenIndex.ts` scans project CSS with — so a design variable and a
 * project token are normalised by the same code and can be compared without
 * a second implementation drifting from the first.
 *
 * ## Size — "where the source unit is knowable"
 *
 * An explicit `px`/`rem`/`em`/`pt` suffix is unambiguous: the unit IS
 * knowable, so it converts to CSS px exactly (via `toPx`, the same helper
 * `projectTokenIndex.ts` uses, at a 16px root — a design variable table
 * carries no project root-font-size of its own to resolve `rem` against).
 *
 * A bare number is a real ambiguity a design tool's own JSON does not
 * resolve: Figma's FLOAT variable type covers spacing and radii (which its
 * own coordinate space treats as px-equivalent) but ALSO opacity, a
 * line-height multiplier, and a font-weight — none of which are a length at
 * all. There is no honest way to tell these apart from the value alone.
 * This module resolves the ambiguity the same direction Figma's own FLOAT
 * convention does for the common case (treat it as px) but marks the
 * assumption explicitly (`unitAssumed: true`) rather than reporting it with
 * the same confidence as an authored unit — so a caller that wants only
 * unit-certain matches can filter on that flag, and nothing here silently
 * claims more certainty than the input supports.
 *
 * ## What this deliberately does NOT do
 *
 * It never discards the original string — callers keep `raw` themselves
 * (this module only returns the DERIVED `kind`/`hex`/`px`), and it never
 * throws: an unrecognisable value is `{ kind: 'other' }`, not an error, so a
 * hostile or merely unexpected entry degrades to "not comparable" rather
 * than failing the whole ingest.
 */
import { cssColorToRgb, rgbToHex } from '@core/design-tokens'
import { toPx } from './tokenExtractCssScan'
import type { DesignVariableKind } from './designVariableSchema'

export interface NormalizedDesignVariableValue {
  readonly kind: DesignVariableKind
  /** Canonical lowercase 6-digit hex. Present only when `kind === 'color'`. */
  readonly hex?: string
  /** Canonical CSS px. Present only when `kind === 'size'`. */
  readonly px?: number
  /** See module doc — true when `px` came from treating a unit-less number as px rather than from an authored unit suffix. Always absent when `kind !== 'size'`. */
  readonly unitAssumed?: boolean
}

/** A bare integer or decimal, no unit, no leading `+`, no exponent — Figma's own FLOAT JSON representation and the plainest "someone stringified a number" case. Deliberately narrow: `1e10`, `Infinity`, `NaN`-as-text, and anything with surrounding text are NOT bare numbers and fall through to `'other'`. */
const BARE_NUMBER_RE = /^-?\d*\.?\d+$/
/** Absolute magnitude ceiling on a bare-number/unit-suffixed size read as px. Far above any real design token (an authored value in the thousands is already implausible for a UI length) — bounds a hostile "1e300"-shaped decimal string from producing a value that corrupts downstream nearest-match arithmetic. */
const MAX_PLAUSIBLE_PX = 100_000

export function normalizeDesignVariableValue(raw: string): NormalizedDesignVariableValue {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: 'other' }

  const rgb = cssColorToRgb(trimmed)
  if (rgb) return { kind: 'color', hex: rgbToHex(rgb) }

  const suffixedPx = toPx(trimmed, 16)
  if (suffixedPx !== null && Number.isFinite(suffixedPx) && Math.abs(suffixedPx) <= MAX_PLAUSIBLE_PX) {
    return { kind: 'size', px: suffixedPx }
  }

  if (BARE_NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n) && Math.abs(n) <= MAX_PLAUSIBLE_PX) {
      return { kind: 'size', px: n, unitAssumed: true }
    }
  }

  return { kind: 'other' }
}
