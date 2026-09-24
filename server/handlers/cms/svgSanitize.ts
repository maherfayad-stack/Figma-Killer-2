/**
 * Server-side SVG sanitizer (string-based).
 *
 * SVG is allowed through the media-library upload path so users can import
 * iconography, logos, and decorative assets from static-site bundles. But SVG
 * is XML with a script surface — anything stored in the media library is
 * served as `image/svg+xml` and can be embedded inline (`<img src=…>` or
 * directly) in published pages, so a malicious payload would execute in the
 * publisher's origin. The known active vectors:
 *
 *   1. `<script>…</script>` — direct JS execution.
 *   2. `<foreignObject>` — can embed arbitrary HTML (incl. <script>, iframes).
 *   3. `on*` event-handler attributes (`onload`, `onclick`, …).
 *   4. `javascript:` URLs inside `href` / `xlink:href`.
 *   5. `<a>` elements pointing at `javascript:` URLs.
 *
 * Why string-based rather than DOMPurify: the server runs on Bun with
 * happy-dom as its DOM. happy-dom does NOT parse SVG element trees the way
 * DOMPurify's SVG profile expects — DOMPurify drops EVERY SVG child element
 * (rect/circle/path/…), leaving only an empty `<svg></svg>` wrapper. That
 * gutting makes DOMPurify unusable for SVG in this runtime. SVG's dangerous
 * surface is small and well-defined, so a targeted string sanitizer is the
 * correct, predictable, dependency-free choice here. (Richtext HTML still
 * uses DOMPurify — happy-dom handles HTML fine; only SVG is broken.)
 *
 * Defence in depth, not the boundary: the sanitised bytes are what hit disk
 * AND what the browser receives, with no out-of-band cleaning step. The
 * boundary is the response header: every route that serves a user or
 * project SVG on Studio's origin sends `INERT_FILE_CSP` (`server/static.ts`,
 * `default-src 'none'; sandbox`), because a regex over XML cannot promise to
 * see every spelling of a script (security review of #248).
 */

// Each pattern targets one vector. The `gi` flags + `[\s\S]` (rather than `.`)
// make every pattern span newlines and match case-insensitively.

// Close-tag matcher: the HTML parser ends an element at the first `>` after the
// tag name, so `</script bar>`, `</script\t\n>`, and `</script/>` all close a
// `<script>`. `(?:[\s/][^>]*)?` after the name accepts any whitespace/junk run
// up to that `>` while `\b`-anchoring rejects `</scriptfoo>`. A bare `<\/x\s*>`
// (the previous form) missed these and is what CodeQL's bad-tag-filter flagged.
//
// Security review of #248 (finding 1) showed four more spellings getting
// through, each handled below. None of this is the boundary: every Studio
// route that serves a user or project SVG sends `INERT_FILE_CSP`
// (`server/static.ts`), which stops script whatever this misses. This is
// defence in depth on top of it.
//
//   - A namespace PREFIX on the element (`<x:script xmlns:x="…svg">`): in an
//     XML document that is a real script element. Every element pattern
//     accepts an optional `prefix:` before its local name.
//   - An entity-encoded or whitespace-split scheme (`jav&#x61;script:`,
//     `java<TAB>script:`): the XML parser decodes the entity and the URL
//     parser drops the tab AFTER a regex has looked. URL-bearing attribute
//     values are decoded and stripped of whitespace/control characters before
//     their scheme is judged.
//   - SMIL (`<animate attributeName="href" values="javascript:…">`,
//     `<set attributeName="onmouseover" to="…">`): an animation that targets
//     a link or an event handler is removed whole. Animations of geometry and
//     colour stay.
//   - An attribute separated by `/` instead of whitespace (`<a/onmouseover=…>`),
//     which an HTML parser accepts when the SVG is inlined into a page.

/** An optional XML namespace prefix before an element's local name. */
const PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`

/** An element name matcher: `<(prefix:)?name` followed by a boundary. */
function elementClose(name: string): string {
  return String.raw`<\/${PREFIX}${name}(?:[\s/][^>]*)?>`
}

const scriptClose = elementClose('script')
const foreignObjectClose = elementClose('foreignObject')
const styleClose = elementClose('style')
const handlerClose = elementClose('handler')

/** `<script …>…</script>` including any attributes / whitespace / newlines, with or without a namespace prefix. */
const SCRIPT_BLOCK_RE = new RegExp(String.raw`<${PREFIX}script\b[\s\S]*?${scriptClose}`, 'gi')
/** A self-closing or unclosed `<script …/>` / `<script …>` with no close tag. */
const SCRIPT_OPEN_RE = new RegExp(String.raw`<${PREFIX}script\b[^>]*\/?>`, 'gi')
/** A dangling `</script …>` close tag left after its opener was stripped. */
const SCRIPT_CLOSE_RE = new RegExp(scriptClose, 'gi')
/** SVG Tiny's `<handler>` element carries script too. */
const HANDLER_BLOCK_RE = new RegExp(String.raw`<${PREFIX}handler\b[\s\S]*?${handlerClose}`, 'gi')
const HANDLER_OPEN_RE = new RegExp(String.raw`<${PREFIX}handler\b[^>]*\/?>`, 'gi')
/** `<foreignObject …>…</foreignObject>` — can carry arbitrary HTML. */
const FOREIGN_OBJECT_RE = new RegExp(String.raw`<${PREFIX}foreignObject\b[\s\S]*?${foreignObjectClose}`, 'gi')
const FOREIGN_OBJECT_OPEN_RE = new RegExp(String.raw`<${PREFIX}foreignObject\b[^>]*\/?>`, 'gi')
/**
 * `on*="…"` / `on*='…'` / `on*=value` event-handler attributes, after
 * whitespace, a `/` (`<a/onclick=…>`) or a closing quote (`x="1"onclick=…`).
 */
const EVENT_HANDLER_RE = /([\s/"'])on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
/**
 * An attribute that carries a URL or an animated value, with its value — the
 * candidates whose scheme is judged after decoding (`unsafeUrlValue`).
 */
const URL_ATTR_RE =
  /([\s/"'])((?:[A-Za-z_][\w.-]*:)?(?:href|src|action|formaction|values|to|from|by))\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
/** A SMIL animation element, self-closing or paired. */
const ANIMATION_ELEMENT_RE = new RegExp(
  String.raw`<(${PREFIX}(?:set|animate|animateMotion|animateTransform|animateColor))\b([^>]*?)(?:\/>|>[\s\S]*?<\/\1\s*>)`,
  'gi',
)
/** `<style>…</style>` blocks — CSS can carry `@import url(javascript:…)`. */
const STYLE_BLOCK_RE = new RegExp(String.raw`<${PREFIX}style\b[\s\S]*?${styleClose}`, 'gi')

const NAMED_ENTITIES: Readonly<Record<string, string>> = { colon: ':', tab: '\t', newline: '\n', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode the character references an XML parser would, so a scheme cannot hide behind one. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole
  })
}

/** `value` without any C0 control character, space or DEL — what a URL parser drops from a scheme. */
function withoutControlAndSpace(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code > 0x20 && code !== 0x7f) out += char
  }
  return out
}

/** Whether an attribute value, once decoded and stripped the way a URL parser strips it, names a script-running scheme. */
function unsafeUrlValue(raw: string): boolean {
  const unquoted = raw.replace(/^["']|["']$/g, '')
  // Every control character and whitespace, including the tab and newline a
  // URL parser silently drops from the middle of a scheme.
  const normalized = withoutControlAndSpace(decodeEntities(unquoted)).toLowerCase()
  return /(?:javascript|vbscript|livescript):/.test(normalized) || /(?:^|;)data:(?:text\/html|application\/xhtml|image\/svg)/.test(normalized)
}

/** A SMIL element that animates a link or an event handler, judged on its decoded `attributeName`. */
function dangerousAnimation(attributes: string): boolean {
  const target = /attributeName\s*=\s*("[^"]*"|'[^']*'|[^\s>/]+)/i.exec(attributes)
  if (!target) return false
  const name = withoutControlAndSpace(decodeEntities(target[1]!.replace(/^["']|["']$/g, ''))).toLowerCase()
  const local = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
  return local === 'href' || local === 'src' || local.startsWith('on')
}

function stripVectorsOnce(svg: string): string {
  return svg
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_OPEN_RE, '')
    .replace(SCRIPT_CLOSE_RE, '')
    .replace(HANDLER_BLOCK_RE, '')
    .replace(HANDLER_OPEN_RE, '')
    .replace(FOREIGN_OBJECT_RE, '')
    .replace(FOREIGN_OBJECT_OPEN_RE, '')
    .replace(STYLE_BLOCK_RE, '')
    .replace(ANIMATION_ELEMENT_RE, (whole, _name: string, attributes: string) => (dangerousAnimation(attributes) ? '' : whole))
    .replace(EVENT_HANDLER_RE, '$1')
    .replace(URL_ATTR_RE, (whole, lead: string, _name: string, value: string) => (unsafeUrlValue(value) ? lead : whole))
}

/**
 * Strip every vector, then keep stripping until the string stops changing.
 * Removing one wrapper can reveal a nested vector (`<scr<script>ipt>` collapses
 * to `<script>`; `<scr<script>ipt>alert()</scr</script>ipt>` needs several
 * passes), so a fixed pass count can leave a payload behind — which is exactly
 * what CodeQL's incomplete-multi-character-sanitization flagged. Iterating to a
 * fixpoint removes that class of bypass entirely. The input is bounded and each
 * pass only ever shrinks it, so this always terminates.
 */
function stripVectors(svg: string): string {
  let current = svg
  // Bound iterations defensively; a shrinking string converges well before this.
  for (let i = 0; i < 100; i++) {
    const next = stripVectorsOnce(current)
    if (next === current) return current
    current = next
  }
  return current
}

/**
 * Sanitize an SVG byte buffer and return the re-encoded clean bytes.
 *
 * Decoding policy: UTF-8, BOM-tolerant, never throws on malformed input.
 * Re-encoding policy: UTF-8 without BOM.
 *
 * Idempotent: `stripVectors` iterates to a fixpoint, so re-running removes
 * nothing — split-tag obfuscation (`<scr<script>ipt>`) is already collapsed
 * away inside that loop.
 *
 * Returns empty bytes only when the input decodes to an empty / whitespace
 * string — the caller treats that as "invalid SVG" and rejects the upload.
 */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const original = decoder.decode(bytes)
  if (original.trim().length === 0) return new Uint8Array(0)

  const cleaned = stripVectors(original)

  if (cleaned.trim().length === 0) return new Uint8Array(0)
  return new TextEncoder().encode(cleaned)
}
