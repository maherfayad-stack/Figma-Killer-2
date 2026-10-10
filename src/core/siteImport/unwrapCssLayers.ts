/**
 * unwrapCssLayers — the `@layer` pre-pass for `cssToStyleRules.ts`.
 *
 * `CSSStyleSheet.replaceSync()` (the CSSOM engine `cssToStyleRules` parses
 * with, in both browsers and the happy-dom test environment) silently drops
 * every rule nested inside an `@layer` block — no `dropped-at-rule` signal,
 * no warning, nothing. Tailwind v4's default build output wraps its entire
 * stylesheet in `@layer theme, base, components, utilities { ... }`, so an
 * unpatched import of a Tailwind v4 project silently imported ZERO rules.
 *
 * This module flattens every `@layer` form out of the CSS text before it
 * ever reaches `replaceSync`, preserving source order — see
 * `unwrapCssLayers`'s own doc comment below for exactly which forms it
 * handles and the cascade-order caveat that flattening carries.
 *
 * Postcss-free on purpose: this runs in the BROWSER (the HTML-import modal and
 * the agent's `insertHtml` both call `cssToStyleRules`), and postcss would drag
 * its `path`/`fs`/`url`/`source-map-js` shims — one console warning per access —
 * into the editor. The pre-pass only has to find `@layer` at-rules and splice
 * their braces out, which a small comment/string/paren-aware scan does; every
 * byte it does not splice survives verbatim. Gate:
 * `postcss-not-in-admin-bundle.test.ts`.
 *
 * Split out of `cssToStyleRules.ts` as its own module: the transform is a
 * self-contained text → text pre-pass with no dependency on the CSSOM
 * rule-walking `cssToStyleRules` does afterward, and is independently
 * testable in isolation.
 */

import type { ImportWarning } from './cssImportTypes'
import { truncate } from './truncate'

/**
 * Split a `@layer <name>#;` statement's comma-separated name list, trimming
 * each. `@layer theme, base, components, utilities;` → the 4 names in order.
 */
function splitLayerStatementNames(params: string): string[] {
  return params.split(',').map((n) => n.trim()).filter(Boolean)
}

/** Thrown by the scan when braces do not balance — the text cannot be safely rewritten. */
class LayerScanError extends Error {}

/** `@layer` followed by something that ends the identifier (so `@layers` is not matched). */
const LAYER_AT_RULE_RE = /@layer(?![\w-])/iy

interface LayerScan {
  /** The CSS with every `@layer` wrapper and statement removed. */
  css: string
  /** Names from bare `@layer a, b;` statements, first-appearance order. */
  declaredOrder: string[]
  /** Names of `@layer name { … }` blocks, first-appearance order. */
  sourceOrder: string[]
  /** Whether any `@layer` construct was found at all. */
  found: boolean
}

/** Index just past the block comment / string starting at `i`, or `i` when neither starts there. */
function skipOpaque(src: string, i: number): number {
  const ch = src[i]
  if (ch === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2)
    return end === -1 ? src.length : end + 2
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1
    while (j < src.length) {
      if (src[j] === '\\') j += 2
      else if (src[j] === ch) return j + 1
      else j += 1
    }
    return src.length
  }
  return i
}

/**
 * One pass over `css`. Statement starts (after `;`, `{`, `}` or the start of
 * input) are where an `@layer` at-rule can begin; comments, strings and
 * `( … )` groups are skipped whole so a `{` inside `url(a{b)` or `content: "}"`
 * never moves the brace count. A layer block's opening and closing brace are
 * dropped (its children stay where they were), tracked on a stack so
 * `@layer a { @layer b { … } }`, `@media { @layer … }` and `@layer { @media … }`
 * all unwrap at their own position.
 */
function scanLayers(css: string): LayerScan {
  const declaredOrder: string[] = []
  const sourceOrder: string[] = []
  const stack: Array<'layer' | 'other'> = []
  let out = ''
  let found = false
  let atStatementStart = true
  let parenDepth = 0
  let i = 0

  while (i < css.length) {
    const opaqueEnd = skipOpaque(css, i)
    if (opaqueEnd !== i) {
      out += css.slice(i, opaqueEnd)
      i = opaqueEnd
      continue
    }
    const ch = css[i]!
    if (parenDepth === 0 && atStatementStart && ch === '@') {
      LAYER_AT_RULE_RE.lastIndex = i
      if (LAYER_AT_RULE_RE.test(css)) {
        // Read the prelude up to the `;` or `{` that ends it (comments dropped).
        let j = i + '@layer'.length
        let prelude = ''
        while (j < css.length && css[j] !== ';' && css[j] !== '{') {
          const skip = skipOpaque(css, j)
          if (skip !== j) {
            if (css[j] !== '/') prelude += css.slice(j, skip)
            j = skip
            continue
          }
          prelude += css[j]
          j += 1
        }
        if (j >= css.length) throw new LayerScanError('unterminated @layer rule')
        found = true
        if (css[j] === ';') {
          for (const name of splitLayerStatementNames(prelude)) {
            if (!declaredOrder.includes(name)) declaredOrder.push(name)
          }
        } else {
          const name = prelude.trim()
          if (name && !sourceOrder.includes(name)) sourceOrder.push(name)
          stack.push('layer')
        }
        i = j + 1
        // What follows a removed wrapper is, again, the start of a statement.
        atStatementStart = true
        continue
      }
    }
    if (ch === '(') {
      parenDepth += 1
      atStatementStart = false
    } else if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1
    } else if (parenDepth === 0) {
      if (ch === '{') {
        stack.push('other')
        atStatementStart = true
      } else if (ch === '}') {
        const top = stack.pop()
        if (top === undefined) throw new LayerScanError('unexpected }')
        atStatementStart = true
        if (top === 'layer') {
          i += 1
          continue
        }
      } else if (ch === ';') {
        atStatementStart = true
      } else if (!/\s/.test(ch)) {
        atStatementStart = false
      }
    }
    out += ch
    i += 1
  }

  if (stack.length > 0) throw new LayerScanError('unclosed block')
  return { css: out, declaredOrder, sourceOrder, found }
}

/**
 * Unwrap every `@layer` construct out of `cssText` before it reaches the
 * CSSOM `replaceSync` parser (see this module's doc comment for why this
 * exists).
 *
 * A scanner (`scanLayers`) rather than a CST, because the only thing needed
 * is to find `@layer` at-rules and splice their braces out — and because a CST
 * library would put its Node shims in the browser bundle (see this module's
 * doc comment). `@layer` still nests arbitrarily and interacts with
 * `@media`/`@supports`/`@container` in both directions, which the brace stack
 * handles.
 *
 * Handles all three `@layer` syntactic forms:
 *   - a bare statement (`@layer a, b, c;`) — declares order, has no body;
 *     the statement is simply removed (nothing to splice).
 *   - a named block (`@layer base { ... }`) — its children stay in its
 *     parent, in place, at the block's own source position.
 *   - an anonymous block (`@layer { ... }`) — same splice, no name recorded.
 * `@layer` inside `@media`/`@supports`/`@container` and the reverse both
 * unwrap correctly, because every splice happens at that block's own
 * position; other at-rules are left completely untouched.
 * Nested `@layer` (`@layer a { @layer b { ... } }`) unwraps because each
 * wrapper's brace is tracked on the stack independently of its parent's.
 *
 * ## Cascade-order caveat — NOT always faithful
 *
 * Flattening replaces layer PRIORITY (order established by first
 * appearance — via an explicit `@layer a, b, c;` statement or a block —
 * which is independent of where each block's text sits) with plain SOURCE
 * order. For Tailwind v4's canonical output — a `@layer theme, base,
 * components, utilities;` statement followed by blocks in that exact
 * sequence — source order already equals declared order, so flattening is
 * faithful; that is the common case this fix exists for.
 *
 * It is genuinely NOT faithful when a stylesheet declares order via a
 * `@layer a, b, c;` statement and then writes the named blocks in a
 * DIFFERENT order than the statement — the browser cascades by the
 * statement's declared order regardless of source position; this flattening
 * cascades by source position instead, so a later-declared-but-earlier-
 * written layer will win when it should have lost. Rather than silently
 * producing a cascade-incorrect import, that case is detected (declared
 * statement order vs. the order named blocks first appear in source) and
 * surfaced as one `layer-order-flattened` warning.
 */
export function unwrapCssLayers(cssText: string, warnings: ImportWarning[]): string {
  // Fast path: no "@layer" substring at all — skip the scan entirely so
  // ordinary (non-Tailwind) CSS is byte-for-byte unaffected.
  if (!/@layer\b/i.test(cssText)) return cssText

  let scan: LayerScan
  try {
    scan = scanLayers(cssText)
  } catch (err) {
    if (!(err instanceof LayerScanError)) throw err
    // Unbalanced braces: we can't safely rewrite this text. Warn (rather than
    // silently falling through to replaceSync's own silent @layer drop) and
    // hand the original text on — `cssToStyleRules`'s own replaceSync
    // try/catch still produces its own invalid-rule warning for genuinely
    // malformed CSS.
    warnings.push({
      kind: 'invalid-rule',
      message: `Could not parse CSS to unwrap @layer blocks (${err.message}); @layer content may be dropped.`,
      source: truncate(cssText),
    })
    return cssText
  }
  if (!scan.found) return cssText

  const { declaredOrder, sourceOrder } = scan
  if (declaredOrder.length > 0) {
    const expected = declaredOrder.filter((name) => sourceOrder.includes(name))
    const orderIsFaithful =
      expected.length === sourceOrder.length
      && expected.every((name, i) => name === sourceOrder[i])
    if (!orderIsFaithful) {
      warnings.push({
        kind: 'layer-order-flattened',
        message:
          `@layer blocks appear in a different order than declared `
          + `(declared: ${declaredOrder.join(', ')}; source: ${sourceOrder.join(', ')}). `
          + `Import flattens @layer to source order, so this stylesheet's cascade `
          + `may not exactly match the original.`,
        source: truncate(cssText),
      })
    }
  }

  return scan.css
}
