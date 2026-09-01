/**
 * `base.svg`'s host-element resolver.
 *
 * A `base.svg` node arrives from one of two sources that look identical once
 * the markup is on the `svg` prop, but are NOT the same element:
 *
 *   1. A literal `<svg>` in the user's source. The element the module renders
 *      IS the graphic — there is no wrapper, and any wrapper Studio mounts to
 *      carry selection wiring is Studio's own invention, which must not
 *      generate a box of its own.
 *   2. `<span className={styles.icon} dangerouslySetInnerHTML={{__html: icon}}/>`
 *      — how real repos inline a `?raw` icon. Here the span is REAL: the
 *      author wrote it, and its class is what sizes and colours the icon
 *      (`.icon { width: 24px }` + `.icon svg { width: 100% }` is the standard
 *      pairing). `parsePageFile` says as much where it builds the node: "the
 *      element keeps its own tag, classes, and inline styles (they size and
 *      colour the icon)."
 *
 * `parsedPageToSitePage` synthesizes `props.tag` for case 2 only — the same
 * "keep rendering as its real host tag" convention `base.container` and
 * `base.text` already use — and this resolves it back to a tag safe to emit.
 *
 * Collapsing case 2 into case 1 is what made every `?raw` icon render at the
 * width of its flex container instead of 24px: `display: contents` on the host
 * removes the author's box (so `width`/`height` on the class stop applying)
 * while leaving the element in the DOM tree, so the descendant rule
 * `.icon svg { width: 100% }` still matches and resolves against the
 * GRANDPARENT instead. The icon is real and correct; only its box was gone.
 */
import { isSafeIntrinsicTagName, VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'

/**
 * The authored host element wrapping this node's markup, or `undefined` when
 * the node has none and the module should mount its own box-less host.
 *
 * `svg` returns `undefined` — that is case 1, where the tag names the graphic
 * itself rather than a wrapper around it. A void element does too: it can
 * carry no markup, so it cannot be the wrapper the source claims it is.
 */
export function resolveSvgHostTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  const trimmed = tag.trim()
  if (!trimmed || trimmed === 'svg') return undefined
  // Not lowercased on the way in: a name that is not ALREADY lowercase never
  // came from `parsedPageToSitePage` (which lowercases the element's own tag),
  // and in JSX an uppercase name is a component reference, not an intrinsic
  // element. Down-casing it here would silently reinterpret one as the other.
  if (trimmed !== trimmed.toLowerCase()) return undefined
  if (!isSafeIntrinsicTagName(trimmed)) return undefined
  if (VOID_HTML_ELEMENTS.has(trimmed)) return undefined
  return trimmed
}
