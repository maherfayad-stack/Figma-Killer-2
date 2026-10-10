/**
 * ruleScan — the brace-matching walk over ONE level of a stylesheet, shared by
 * every reader of custom-property declarations (the token catalog's gated scan
 * here, and the root-scope scan in `server/handlers/studio/tokenExtractCssScan.ts`).
 *
 * Hand-rolled rather than postcss because the readers run in the browser
 * (framework scales) as well as on the server, and the browser must not load
 * postcss (`postcss-not-in-admin-bundle.test.ts`). Comment-aware; never throws.
 */

export interface CssRule {
  selector: string
  body: string
  /** Offset of `body`'s first character within the text this level scanned — so a declaration can be traced back to its line. */
  bodyOffset: number
}

/**
 * Every rule at ONE level of `{ }` nesting in `css`, comment-aware — used both
 * for the outermost scan and, recursively, for the body of every at-rule
 * (`@media`/`@layer`/`@supports`) found at that level. An at-rule's own
 * selector is the raw prelude text (e.g. `@media (prefers-color-scheme:dark)`),
 * always starting with `@`, and its body is the untouched nested text — this
 * function does not know or care whether a rule is an at-rule.
 */
export function scanRulesAtOneLevel(css: string): CssRule[] {
  const rules: CssRule[] = []
  let buffer = ''
  let parens = 0
  let quote: string | null = null
  let i = 0
  const n = css.length
  while (i < n) {
    if (quote !== null) {
      // Inside a string in a prelude (`@import "a;b"`): nothing ends here.
      if (css[i] === '\\') {
        buffer += css[i]! + (css[i + 1] ?? '')
        i += 2
        continue
      }
      if (css[i] === quote) quote = null
      buffer += css[i]
      i++
      continue
    }
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      buffer = ''
      continue
    }
    const ch = css[i]
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      i++
      continue
    }
    if (ch === '(') parens++
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (ch === ';' && parens === 0) {
      // A statement at-rule (`@import`, `@charset`, `@layer a, b;`, `@plugin`)
      // has no body: it ends here, and must not glue itself onto the NEXT
      // rule's prelude (an `@import` followed by `@theme` is two at-rules).
      buffer = ''
      i++
      continue
    }
    if (ch === '{') {
      const selector = buffer.trim()
      buffer = ''
      parens = 0
      i++
      const bodyStart = i
      let depth = 1
      while (i < n && depth > 0) {
        if (css[i] === '/' && css[i + 1] === '*') {
          const end = css.indexOf('*/', i + 2)
          i = end === -1 ? n : end + 2
          continue
        }
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        if (depth > 0) i++
      }
      const body = css.slice(bodyStart, i)
      i++ // consume the matching close brace
      if (selector.length > 0) rules.push({ selector, body, bodyOffset: bodyStart })
      continue
    }
    if (ch === '}') {
      // A stray/unmatched close — resync rather than corrupting the rest of
      // the scan (or, one level down inside an at-rule body, the close of
      // that at-rule itself once its own scan of the body runs dry).
      buffer = ''
      i++
      continue
    }
    buffer += ch
    i++
  }
  return rules
}
