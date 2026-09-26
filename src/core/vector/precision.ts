/**
 * precision — how many decimals a re-emitted path coordinate gets.
 *
 * The rule (audit `08-svg.md` §5.3): enough decimals that the rounding error
 * is at most a tenth of a CSS pixel at 1× zoom, never fewer than the source
 * segment already used, trailing zeros stripped, a leading `0.` kept. An icon
 * drawn in a 24-unit viewBox shown at 24 px needs one decimal; the same icon
 * shown at 240 px needs two; a 1000-unit illustration shown at 100 px needs
 * none.
 */

/** Decimals are clamped here unless the source itself used more. */
const MIN_DECIMALS = 0
const MAX_DECIMALS = 3

/**
 * Decimals for a re-emitted coordinate.
 *
 * @param userUnitsPerCssPx how many of the path's user units one CSS pixel
 *   spans at 1× zoom (the inverse of the part's CTM scale). `0.5` for a
 *   24-unit viewBox drawn at 48 px.
 * @param sourceDecimals the decimals the source segment was written with.
 */
export function decimalsForScale(userUnitsPerCssPx: number, sourceDecimals = 0): number {
  let decimals = MAX_DECIMALS
  if (Number.isFinite(userUnitsPerCssPx) && userUnitsPerCssPx > 0) {
    // Smallest n with 10^-n ≤ unitsPerPx / 10.
    const needed = Math.ceil(1 - Math.log10(userUnitsPerCssPx) - 1e-9)
    decimals = Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, needed))
  }
  return Math.max(decimals, sourceDecimals)
}

/**
 * `value` rounded to `decimals`, with trailing zeros and a bare trailing `.`
 * stripped, and `-0` written as `0`.
 */
export function formatPathNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(Math.max(0, Math.min(20, decimals)))
  const trimmed = fixed.includes('.') && !fixed.includes('e') ? fixed.replace(/\.?0+$/, '') : fixed
  return trimmed === '-0' ? '0' : trimmed
}
