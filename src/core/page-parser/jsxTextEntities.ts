/**
 * HTML entity decoding for JSX text children.
 *
 * A `JsxText` node's source is exactly what the author typed, so
 * `<p>it&apos;s ready</p>` reads out of the AST as the eleven characters
 * `it&apos;s`. React decodes entities when it renders, so leaving them encoded
 * put the literal text "it&apos;s ready" on the canvas — observed in a real
 * project screen.
 *
 * This is a decode, not an unescape-everything: it handles the five XML
 * predefined entities, the handful of typographic ones people actually type in
 * copy, and numeric character references (`&#39;`, `&#x27;`). An unknown entity
 * is left exactly as written rather than guessed at — `&foo;` is far more
 * likely to be literal text than a typo for something we should invent.
 *
 * Ordering matters: `&amp;` is decoded LAST via the shared regex pass, so
 * `&amp;lt;` decodes to the literal `&lt;` and never continues on to `<`.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
}

/** Above this, a numeric reference is not a character anyone typed on purpose. */
const MAX_CODE_POINT = 0x10ffff

const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

/**
 * Decode the HTML entities in a JSX text child. A single regex pass, so each
 * entity is decoded exactly once and a decoded `&` can never be re-read as the
 * start of another entity.
 */
export function decodeJsxTextEntities(text: string): string {
  if (!text.includes('&')) return text

  return text.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        // Lone surrogates and other unpaired values throw — leave as authored.
        return match
      }
    }
    // Named entities are case-sensitive in HTML; `&AMP;` is not `&amp;`.
    return NAMED_ENTITIES[body] ?? match
  })
}
