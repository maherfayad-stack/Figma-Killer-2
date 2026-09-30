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

import { HTML_TAG_NAME_PATTERN, UNSAFE_HTML_TAGS, VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'
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
 * The tags `base.text`'s select offers by name. Distinct from
 * `BUILTIN_HTML_TAGS`: these are text-carrying elements (headings, inline
 * emphasis). Any other element that can hold text is reached through the same
 * `custom` escape hatch `base.container` has (`isTextHostTag`) — an imported
 * `<li>Item</li>` is text in an `<li>`, and it has to stay both (P3-B, WB-3).
 */
export const TEXT_HTML_TAGS = [
  'p', 'none', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'small', 'strong', 'em',
] as const

export const TEXT_HTML_TAG_SET: ReadonlySet<string> = new Set(TEXT_HTML_TAGS)

/**
 * Elements whose text children are not rendered as the element's visible
 * content — a form value (`<textarea>`, `<option>`), document metadata
 * (`<title>`), or inert markup (`<template>`, `<noscript>`). `base.text` writes
 * its text as the element's content, so none of these may be one.
 */
const NON_CONTENT_TEXT_TAGS: ReadonlySet<string> = new Set(['textarea', 'option', 'title', 'template', 'noscript'])

/**
 * Can `base.text` render its text inside `<tag>`? Any well-formed, safe,
 * non-void element whose text children are its visible content — the one rule
 * both the Studio import pipeline (`moduleMapping.ts`: is this text-only
 * element a text node?) and `base.text`'s own renderer (`resolveTextTag`) ask,
 * so what the import maps and what the canvas draws cannot disagree.
 */
export function isTextHostTag(tag: string): boolean {
  if (!HTML_TAG_NAME_PATTERN.test(tag)) return false
  const lower = tag.toLowerCase()
  if (lower !== tag) return false
  return !UNSAFE_HTML_TAGS.has(lower) && !VOID_HTML_ELEMENTS.has(lower) && !NON_CONTENT_TEXT_TAGS.has(lower)
}

/**
 * The element `base.text` renders for its `tag` + `customTag` props: one of
 * its named tags (`'none'` included), or — for `tag: 'custom'` — `customTag`
 * when `isTextHostTag` accepts it. Anything else falls back to `'p'`, the
 * module's default, never to an element the name did not ask for.
 */
export function resolveTextTag(tag: unknown, customTag: unknown): string {
  if (tag === CUSTOM_HTML_TAG_VALUE) {
    const custom = typeof customTag === 'string' ? customTag.trim().toLowerCase() : ''
    return isTextHostTag(custom) ? custom : 'p'
  }
  const named = String(tag || 'p').toLowerCase()
  return TEXT_HTML_TAG_SET.has(named) ? named : 'p'
}

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
    options: [
      ...TEXT_HTML_TAGS.map((t) => ({
        label: LABELS[t] ?? `Heading ${t.slice(1)}`,
        value: t,
      })),
      { label: 'Custom…', value: CUSTOM_HTML_TAG_VALUE },
    ],
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
