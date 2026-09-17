/**
 * assetPreviewCss — rewrites the design system's global stylesheet so it can
 * be adopted by a shadow root instead of the document.
 *
 * The design system declares its whole token set on `:root`, gates dark mode
 * on `:root[data-theme="dark"]`, and resets the page with `body { margin: 0 }`.
 * All three are statements about a DOCUMENT. An asset card is not a document:
 * it is a 100px box in a panel, and if that stylesheet ever reached the admin
 * document it would restyle every button in the editor.
 *
 * So the sheet is adopted into a shadow root instead, with three edits:
 *
 *   1. `:root` → `:host`, carrying any compound suffix into the functional
 *      form: `:root[data-theme="dark"]` → `:host([data-theme="dark"])`,
 *      `:root:not([data-theme=light])` → `:host(:not([data-theme=light]))`.
 *      The host element carries `data-theme`, so the board's colour scheme
 *      selects the same token set it selects in a canvas frame.
 *   2. Bare `body` / `html` rules are dropped. They style a page — margin,
 *      background, min-height — and inside a preview they would either do
 *      nothing (no `<body>` in a shadow root) or, worse, be rewritten onto
 *      something that is not a page.
 *   3. Everything else is kept verbatim, including `@media`, `@supports`,
 *      `@layer`, `@keyframes` and `@font-face`.
 *
 * Pure string work, no DOM, no CSS parser: the input is one bundled
 * stylesheet read at build time, and the transform runs once per session.
 */

/** Selectors that describe a PAGE, not a component — dropped entirely. */
const PAGE_SELECTORS = new Set(['body', 'html', 'html body', ':root body'])

/**
 * `:root` plus any number of compound parts that are legal inside `:host(…)`
 * — attribute selectors, classes, ids and `:not(…)`.
 */
const ROOT_WITH_SUFFIX = /:root((?:\[[^\]]*\]|\.[\w-]+|#[\w-]+|:not\([^)]*\))*)/g

/** At-rules whose block contains nested rules that must be transformed too. */
const NESTING_AT_RULES = /^@(media|supports|layer|container|scope|document)\b/i

/**
 * Rewrites one design-system stylesheet for `adoptedStyleSheets` on a shadow
 * root. See the module doc for the three edits.
 */
export function transformDesignSystemCssForShadow(css: string): string {
  return transformBlock(stripComments(css))
}

/**
 * Comments are removed up front so the brace scanner below cannot be fooled by
 * a `{` inside one. Safe for a bundled stylesheet — the only other place `/*`
 * could appear is inside a string or `url()`, which no real stylesheet does.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Transforms every rule at one nesting level, recursing into group at-rules. */
function transformBlock(css: string): string {
  const out: string[] = []
  let prelude = ''
  let index = 0

  while (index < css.length) {
    const char = css[index]

    if (char === '{') {
      const body = readBlock(css, index)
      const name = prelude.trim()
      if (name.startsWith('@')) {
        const inner = NESTING_AT_RULES.test(name) ? transformBlock(body.content) : body.content
        out.push(`${name} {${inner}}`)
      } else {
        const selector = transformSelectorList(name)
        if (selector) out.push(`${selector} {${body.content}}`)
      }
      prelude = ''
      index = body.end
      continue
    }

    if (char === ';' && prelude.trim().startsWith('@')) {
      // A block-less at-rule (`@import`, `@charset`, `@layer a, b;`).
      out.push(`${prelude.trim()};`)
      prelude = ''
      index += 1
      continue
    }

    prelude += char
    index += 1
  }

  return out.join('\n')
}

/** Reads the balanced `{ … }` starting at `open`; returns its content and the index after `}`. */
function readBlock(css: string, open: number): { content: string; end: number } {
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return { content: css.slice(open + 1, i), end: i + 1 }
    }
  }
  // Unbalanced input: take the rest, rather than dropping the tail silently.
  return { content: css.slice(open + 1), end: css.length }
}

/**
 * Rewrites a comma-separated selector list, dropping page selectors. Returns
 * `''` when nothing survives, which drops the rule.
 */
function transformSelectorList(list: string): string {
  const kept = list
    .split(',')
    .map((selector) => selector.trim().replace(/\s+/g, ' '))
    .filter((selector) => selector.length > 0 && !PAGE_SELECTORS.has(selector.toLowerCase()))
    .map(transformSelector)
  return kept.join(', ')
}

/** `:root…` → `:host(…)` for one selector. */
function transformSelector(selector: string): string {
  return selector.replace(ROOT_WITH_SUFFIX, (_match, suffix: string) =>
    suffix ? `:host(${suffix})` : ':host',
  )
}
