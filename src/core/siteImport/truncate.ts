/**
 * truncate — shorten a CSS source string for use in warning messages.
 *
 * Split out of `cssToStyleRules.ts` into its own leaf module because both
 * that file and `unwrapCssLayers.ts` need it: putting it in either one and
 * having the other import it back would be a needless inter-file dependency
 * for a four-line pure function.
 */

/** Truncate `text` to `maxLen`, appending `…` when the string is cut. */
export function truncate(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}
