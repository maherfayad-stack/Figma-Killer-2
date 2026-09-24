/**
 * svgReferences — the one policy for what an SVG may point at.
 *
 * An inline SVG references other things two ways: an `href` (`<use
 * href="#icon">`, a gradient's `href="#base"`) and a CSS `url(…)`
 * (`fill="url(#grad)"`, `style="mask: url(#m)"`). Both are useful when they
 * point INSIDE the document at a fragment, and both are a hazard when they
 * point anywhere else:
 *
 *   - `href="javascript:…"` / `data:` on `<use>` is a script vector — the
 *     reason the sanitizer strips `href` outright (and DOMPurify refuses
 *     `<use>` by default);
 *   - `url(https://…)` is a remote fetch. Written into a user's `.tsx` by the
 *     SVG importer, it makes their app phone a third-party host on every
 *     render — a tracking beacon that arrived hidden inside an icon.
 *
 * So both checks here allow exactly one shape, a same-document fragment
 * (`#name`), and treat everything else — including anything they cannot
 * parse — as a reference to refuse. Pure string code: it runs in the browser
 * sanitizer hook, the importer, and tests alike.
 */

/**
 * A same-document fragment reference: `#` then one or more ASCII word
 * characters, dots or hyphens. Nothing that could be read as a scheme, a path
 * or a query survives this: no `:`, `/`, `?`, whitespace or escape.
 */
const FRAGMENT_REFERENCE = /^#[\w.-]+$/

/** Whether `value` is exactly a same-document fragment reference, as written (no surrounding whitespace). */
export function isSvgFragmentReference(value: string): boolean {
  return FRAGMENT_REFERENCE.test(value)
}

/**
 * CSS functions besides `url()` that load a resource by URL. A value using one
 * is refused whatever its argument, since none of them can reference a
 * fragment in a way an icon needs.
 */
const RESOURCE_FUNCTIONS = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|image|src|cross-fade)\s*\(/

/**
 * Resolves CSS escapes (`\75 rl(` is `url(`), the way the CSS tokenizer does
 * before it recognises a function name, so an escaped spelling cannot hide one.
 */
function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? ''
    const code = Number.parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : String.fromCharCode(0xfffd)
  })
}

/** Every `url(…)` argument in `css`, unquoted and trimmed, or `undefined` when one is unterminated. */
function urlArguments(css: string): string[] | undefined {
  const args: string[] = []
  const opener = /url\s*\(/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(css)) !== null) {
    let cursor = match.index + match[0].length
    while (cursor < css.length && /\s/.test(css[cursor]!)) cursor += 1
    const quote = css[cursor] === '"' || css[cursor] === "'" ? css[cursor]! : undefined
    if (quote) {
      const end = css.indexOf(quote, cursor + 1)
      if (end === -1) return undefined
      args.push(css.slice(cursor + 1, end))
      cursor = end + 1
      const close = css.indexOf(')', cursor)
      if (close === -1) return undefined
      opener.lastIndex = close + 1
    } else {
      const close = css.indexOf(')', cursor)
      if (close === -1) return undefined
      args.push(css.slice(cursor, close).trim())
      opener.lastIndex = close + 1
    }
  }
  return args
}

/**
 * An inline raster or vector IMAGE carried in the value itself. It loads
 * nothing (the bytes are right there), and a `url()` in CSS is always fetched
 * as an image, where an SVG cannot run script. Any other `data:` type
 * (`text/html`) is refused with the rest.
 */
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/

/**
 * Whether a CSS value (a presentation attribute such as `fill`, or one
 * declaration's value) would load anything from outside the document: a
 * `url(…)` that is neither a `#fragment` nor an inline `data:image/…`, or any
 * other resource-loading function. An unparseable `url(` counts as loading —
 * refusing a broken value costs a paint the browser would have dropped anyway.
 */
export function cssValueLoadsExternalResource(value: string): boolean {
  const css = unescapeCss(value).toLowerCase()
  if (RESOURCE_FUNCTIONS.test(css)) return true
  if (!css.includes('url')) return false
  const args = urlArguments(css)
  if (args === undefined) return true
  // `urlArguments` finds every `url(` the regex sees; a `url` that is not
  // followed by `(` (a class name, a word in a font family) is not a function.
  return args.some((arg) => !FRAGMENT_REFERENCE.test(arg) && !INLINE_IMAGE.test(arg))
}
