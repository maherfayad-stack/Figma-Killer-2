/**
 * tokenPreviewCss - the CSS that shows a token's value on the canvas while the
 * Variables panel is still being typed into, before anything is written
 * (CT-3). Pure text, so the rules can be tested without a document.
 *
 * ## It must beat the real declaration without replacing it
 *
 * The project's own stylesheet declares the token under some gate: `:root`,
 * `[data-theme="dark"]`, `.dark`, or inside `@media (...)`. The preview
 * restates ONE declaration under that SAME gate, with the selector doubled
 * (`:is(sel):is(sel)`) so it wins on specificity even where the author's
 * stylesheet is loaded later, and nothing under any other gate changes - a
 * dark-mode value edited on screen only repaints dark-mode frames. Only
 * conditional at-rules are kept (`@media`, `@supports`, `@container`);
 * `@layer` and Tailwind's `@theme` are how the author organised the file, not
 * a condition the value depends on. The `prefers-color-scheme` rewrite the
 * canvas applies to the project's stylesheets is applied to this CSS too
 * (`UserStylesheetInjector`), so a preview of a media-gated dark value fires
 * under the same board control as the real one.
 */

export interface TokenPreview {
  readonly name: string
  readonly value: string
  /** The rule's selector, or `null` for a declaration straight inside `@theme`. */
  readonly selector: string | null
  /** Enclosing at-rules, outermost first, as `@name params`. */
  readonly atRules: readonly string[]
}

const CONDITIONAL_AT_RULE_RE = /^@(?:media|supports|container)\b/i

/** The preview stylesheet, or `''` when the value could not stand alone as one declaration. */
export function buildTokenPreviewCss(preview: TokenPreview | null): string {
  if (!preview) return ''
  const value = preview.value.trim()
  // The same rule the write enforces: one value, no `;`, `{` or `}`.
  if (value.length === 0 || /[;{}\r\n]/.test(value)) return ''
  const selector = preview.selector ?? ':root'
  let css = `:is(${selector}):is(${selector}) { ${preview.name}: ${value}; }`
  const conditions = preview.atRules.filter((rule) => CONDITIONAL_AT_RULE_RE.test(rule))
  for (let index = conditions.length - 1; index >= 0; index--) css = `${conditions[index]} { ${css} }`
  return css
}
