/**
 * Shared HTML-tag selection helpers used by modules that let the author pick
 * which semantic element they render as (currently `base.container` and
 * `base.loop`).
 *
 * Two pieces:
 *   - the canonical list of built-in tag choices (semantic layout + list tags)
 *   - a "custom" escape hatch so authors can type any valid HTML element name
 *     when the built-in list isn't enough (e.g. `aside`, `figure`, `dl`, …).
 *
 * Resolution always returns a safe lowercase HTML element name (or 'div' on
 * unknown / invalid input). Both the publisher render path and the editor
 * preview component share the same resolver so the canvas matches the
 * published HTML exactly.
 *
 * The tag FACTS this resolver enforces — the well-formed-name pattern and the
 * never-safe-to-emit set — live in `@core/utils/htmlTags`, because Studio's
 * `insertJsxElement` codemod has to enforce exactly the same two rules when it
 * writes an element into a user's source. See that module's doc for why the
 * shared leaf sits in core rather than here.
 */

import { HTML_TAG_NAME_PATTERN, UNSAFE_HTML_TAGS } from '@core/utils/htmlTags'
import type { PropertyControl } from '@core/module-engine'

const BUILTIN_HTML_TAGS = [
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
] as const

/** Sentinel select-value indicating "use the user-typed `customTag` instead". */
export const CUSTOM_HTML_TAG_VALUE = 'custom'

const BUILTIN_HTML_TAG_SET: ReadonlySet<string> = new Set(BUILTIN_HTML_TAGS)

/**
 * Resolve the tag a module should render given its `tag` + `customTag` props.
 *
 * Returns a safe lowercase tag name. Falls back to 'div' when:
 *   - `tag` is missing / not a string
 *   - `tag` is 'custom' but `customTag` is missing or fails the safe-name regex
 *   - `tag` is some non-built-in string we don't recognise
 */
export function resolveHtmlTag(tag: unknown, customTag: unknown): string {
  if (typeof tag !== 'string') return 'div'
  if (tag === CUSTOM_HTML_TAG_VALUE) {
    if (typeof customTag !== 'string') return 'div'
    const trimmed = customTag.trim()
    if (!HTML_TAG_NAME_PATTERN.test(trimmed)) return 'div'
    const lower = trimmed.toLowerCase()
    if (UNSAFE_HTML_TAGS.has(lower)) return 'div'
    return lower
  }
  if (BUILTIN_HTML_TAG_SET.has(tag)) return tag.toLowerCase()
  return 'div'
}

/**
 * The standard `select` control for picking from built-in tags + 'custom'.
 * Pair with `customHtmlTagControl()` (or a manual conditional renderer) to
 * surface the free-form text input when 'custom' is chosen.
 */
export function htmlTagControl(label: string = 'HTML tag'): PropertyControl {
  return {
    type: 'select',
    label,
    options: [
      ...BUILTIN_HTML_TAGS.map((t) => ({ label: t, value: t })),
      { label: 'Custom…', value: CUSTOM_HTML_TAG_VALUE },
    ],
  }
}

/**
 * The tags `base.text` can render as. Distinct from `BUILTIN_HTML_TAGS`: these
 * are text-carrying elements (headings, inline emphasis) and there is no
 * `custom` escape hatch, because `base.text` is a leaf — a tag it cannot
 * represent has to become a `base.container` instead.
 *
 * Lives here rather than inline in `base.text` so the Studio import pipeline
 * can check "can `base.text` actually render this tag?" against the same list
 * the control offers, instead of duplicating it.
 */
export const TEXT_HTML_TAGS = [
  'p', 'none', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'small', 'strong', 'em',
] as const

export const TEXT_HTML_TAG_SET: ReadonlySet<string> = new Set(TEXT_HTML_TAGS)

/** The `tag` select for `base.text`. `category: 'content'` — a copy editor changing a heading from h2 to h3 is editorial, not structural. */
export function textTagControl(label: string = 'Tag'): PropertyControl {
  const LABELS: Record<string, string> = {
    p: 'Paragraph', none: 'None', span: 'Span', div: 'Div',
    small: 'Small', strong: 'Strong', em: 'Emphasis',
  }
  return {
    type: 'select',
    label,
    category: 'content',
    options: TEXT_HTML_TAGS.map((t) => ({
      label: LABELS[t] ?? `Heading ${t.slice(1)}`,
      value: t,
    })),
  }
}

/**
 * The free-form text control shown only when `tag === 'custom'`.
 *
 * `field` defaults to `'tag'` to match the standard prop naming used by
 * Container + Loop; pass an alternate key if a module stores the tag select
 * under a different prop name.
 */
export function customHtmlTagControl(
  label: string = 'Custom tag',
  field: string = 'tag',
): PropertyControl {
  return {
    type: 'text',
    label,
    placeholder: 'e.g. aside, figure, my-widget',
    condition: { field, eq: CUSTOM_HTML_TAG_VALUE },
    // The tag is structural, not content — keep it under `site.structure.edit`
    // even though `text` controls default to 'content'.
    category: 'layout',
  }
}
