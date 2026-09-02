/**
 * Facts about intrinsic HTML element names, shared by every layer that has to
 * decide "is this a real tag, and is it safe to emit?".
 *
 * This lives in `@core/utils` rather than next to either consumer because it
 * has two of them pointing in different directions, and the module graph only
 * stays one-directional if the shared leaf sits below both:
 *
 *   - `src/modules/base/utils/htmlTag.ts` — the CMS module renderer's tag
 *     picker (`base.container`, `base.loop`, `base.text`), where the question
 *     is "what may an author choose to render as?"
 *   - `src/core/ast-codemods/insertJsxElement.ts` — the Studio codemod that
 *     writes a new element into the user's own `.tsx`, where the question is
 *     "what may an agent write into source?"
 *
 * Those are genuinely different callers with different vocabularies, but the
 * two things they must agree on — which names are well-formed, and which are
 * never safe to emit — are the same facts, and a second copy of either list is
 * a security bug waiting for one of them to be updated alone.
 */

/**
 * The complete set of HTML void elements (lowercase) — no closing tag, no
 * children. Consumers:
 *   - the publisher render path (`base.container`), where emitting
 *     `<br></br>` is a bug: the parser reinterprets the end tag as a second
 *     start tag, doubling the element.
 *   - the editor preview (`ContainerEditor`), where React throws if a void
 *     element is given children (or the empty-container placeholder).
 *   - `insertJsxElement`, which refuses to write children into one.
 *
 * One list, so canvas, published HTML, and written source can never disagree
 * about which tags are self-closing.
 */
export const VOID_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * HTML element names: ASCII letter, then letters/digits/hyphens, 1–32 chars.
 *
 * Matches the HTML5 element-name spec narrowed to a safe subset — it covers
 * every standard tag plus custom elements (`x-foo`, `my-widget`) while
 * permitting no character that could break out of the tag or attribute
 * context. Deliberately NOT an allowlist of known tags: HTML gains elements,
 * and refusing `<dialog>` because a hard-coded list predates it would be worse
 * than the risk a well-formed unknown name carries (none — an unknown element
 * renders as an inline box).
 */
export const HTML_TAG_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/i

/**
 * Elements that must never be emitted from a free-form, non-hand-written tag
 * name — they execute script, load external/plugin resources, or hijack the
 * document's base URL.
 *
 * Both consumers need this for the same reason, one step apart. For the CMS
 * modules, a dangerous tag would run in the published page AND in the admin
 * canvas (which renders those trusted modules directly, same-origin as
 * `/admin`). For `insertJsxElement`, the tag is written into the user's own
 * source, so it runs the moment they start their dev server — Studio's
 * "parse, never execute" invariant protects the CANVAS from what it reads, not
 * the user's project from what Studio writes into it.
 *
 * `base.video` emits its own trusted `<iframe>` via its module `htmlTag`, not
 * through either of these paths, so blocking `iframe` here does not affect
 * video embeds.
 */
export const UNSAFE_HTML_TAGS: ReadonlySet<string> = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'base', 'link', 'meta', 'style',
])

/**
 * True when `name` is a lowercase intrinsic tag that is well-formed and not in
 * {@link UNSAFE_HTML_TAGS}.
 *
 * The leading-lowercase check is load-bearing and is JSX semantics, not style:
 * React reads `<div>` as the string `"div"` and `<Div>` as the in-scope
 * identifier `Div`. A name that starts uppercase is therefore a COMPONENT
 * reference, and treating it as intrinsic would silently emit a reference to a
 * binding that does not exist.
 */
export function isSafeIntrinsicTagName(name: string): boolean {
  if (!HTML_TAG_NAME_PATTERN.test(name)) return false
  if (name[0] !== name[0]?.toLowerCase()) return false
  return !UNSAFE_HTML_TAGS.has(name.toLowerCase())
}
