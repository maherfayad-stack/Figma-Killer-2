/**
 * svgPartStamps — how an inline SVG's inner elements carry the place a write
 * lands (P5-D, SVG-3).
 *
 * A literal `<svg>` is ONE page-tree node (`base.svg`); its `<path>`s,
 * `<circle>`s and `<g>`s are drawing instructions, not page structure, so they
 * never become nodes. Editing one still needs two facts per inner element:
 * WHERE it is written (the write target) and WHICH of its attributes are
 * literals (the rest came from code and must not be overwritten). The parser
 * (`inlineSvg.ts`) stamps both onto the markup it serialises:
 *
 *   - `data-studio-svg-part="<line>:<col>"` — the element's own JSX location
 *     (the tag-name start, the node-id convention), in the SAME file as its
 *     host `<svg>`'s id tail;
 *   - `data-studio-svg-code="d,fill"` — present only when non-empty: the JSX
 *     names of attributes that came from an expression. `*` means the element
 *     carries a spread, so none of its attributes is known to be literal.
 *
 * Stamps rather than an index array: the sanitizer REMOVES elements
 * (`script`, `foreignObject`), and an array keyed by pre-order position would
 * silently shift onto the wrong element. A stamp cannot drift, and the canvas
 * DOM needs it anyway — `target.closest('[data-studio-svg-part]')` is the hit
 * test.
 *
 * Stamps are Studio's bookkeeping, so they never leave Studio: the default
 * `sanitizeSvg` profile (publish, export, the property control) FORBIDS both
 * attributes, removing them on the DOM; only the canvas render asks to keep
 * them. There is deliberately no string strip — a regex over serialized
 * markup deleted across a tag boundary and made sanitized markup live
 * (review #269 B1). Gated by `svg-part-stamps-stripped.test.ts`. The root
 * `<svg>` is never stamped: its location is its node id, and a part of `''`
 * names it.
 */

export const SVG_PART_ATTRIBUTE = 'data-studio-svg-part'
export const SVG_CODE_ATTRIBUTE = 'data-studio-svg-code'

/** The `data-studio-svg-code` value of an element whose attributes a spread may override. */
export const SVG_SPREAD_CODE = '*'

/** Whether an attribute name is one of the stamps (a user may not author them: they would collide). */
export function isSvgPartStampAttribute(name: string): boolean {
  return name === SVG_PART_ATTRIBUTE || name === SVG_CODE_ATTRIBUTE
}

/** A part location as stamped. */
export function formatSvgPartLocation(line: number, col: number): string {
  return `${line}:${col}`
}

/** A stamped part location, or `null` when `value` is not one. */
export function parseSvgPartLocation(value: string): { line: number; col: number } | null {
  const match = /^(\d{1,7}):(\d{1,7})$/.exec(value)
  if (!match) return null
  const line = Number(match[1])
  const col = Number(match[2])
  return line >= 1 && col >= 1 ? { line, col } : null
}

/** The JSX attribute names a `data-studio-svg-code` value lists (`*` for a spread). */
export function parseSvgCodeAttributes(value: string | null | undefined): ReadonlySet<string> {
  if (!value) return new Set()
  return new Set(value.split(',').filter((name) => name.length > 0))
}
