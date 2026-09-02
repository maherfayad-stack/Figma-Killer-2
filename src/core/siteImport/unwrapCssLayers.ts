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
 * Split out of `cssToStyleRules.ts` as its own module: the transform is a
 * self-contained text → text pre-pass with no dependency on the CSSOM
 * rule-walking `cssToStyleRules` does afterward, and is independently
 * testable in isolation.
 */

import postcss, { type AtRule } from 'postcss'
import type { ImportWarning } from './cssImportTypes'
import { truncate } from './truncate'

/**
 * Split a `@layer <name>#;` statement's comma-separated name list, trimming
 * each. `@layer theme, base, components, utilities;` → the 4 names in order.
 */
function splitLayerStatementNames(params: string): string[] {
  return params.split(',').map((n) => n.trim()).filter(Boolean)
}

/**
 * Unwrap every `@layer` construct out of `cssText` before it reaches the
 * CSSOM `replaceSync` parser (see this module's doc comment for why this
 * exists).
 *
 * Uses `postcss` (already a repo dependency, used the same way by
 * `src/core/css-codemods/`) rather than a hand-rolled brace scanner, because
 * `@layer` nests arbitrarily and interacts with `@media`/`@supports`/
 * `@container` in both directions.
 *
 * Handles all three `@layer` syntactic forms:
 *   - a bare statement (`@layer a, b, c;`) — declares order, has no body;
 *     the statement node is simply removed (nothing to splice).
 *   - a named block (`@layer base { ... }`) — its children are spliced into
 *     its parent in place, at the block's own source position.
 *   - an anonymous block (`@layer { ... }`) — same splice, no name recorded.
 * `@layer` inside `@media`/`@supports`/`@container` and the reverse both
 * unwrap correctly, because every splice happens at that node's own
 * position in the tree; other at-rules are left completely untouched.
 * Nested `@layer` (`@layer a { @layer b { ... } }`) unwraps by processing
 * every `@layer` node found in the pristine tree (collected up front, before
 * any mutation) — each splice hoists its children to its parent, and the
 * nested node — still the same object reference — gets its own turn.
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
  // Fast path: no "@layer" substring at all — skip the postcss round-trip
  // entirely so ordinary (non-Tailwind) CSS is byte-for-byte unaffected.
  if (!/@layer\b/i.test(cssText)) return cssText

  let root: ReturnType<typeof postcss.parse>
  try {
    root = postcss.parse(cssText)
  } catch (err) {
    // Sheet-level parse error: we can't safely rewrite this text. Warn
    // (rather than silently falling through to replaceSync's own silent
    // @layer drop) and hand the original text on — `cssToStyleRules`'s own
    // replaceSync try/catch still produces its own invalid-rule warning for
    // genuinely malformed CSS.
    warnings.push({
      kind: 'invalid-rule',
      message: `Could not parse CSS to unwrap @layer blocks (${err instanceof Error ? err.message : String(err)}); @layer content may be dropped.`,
      source: truncate(cssText),
    })
    return cssText
  }

  const layerRules: AtRule[] = []
  root.walkAtRules('layer', (rule) => { layerRules.push(rule) })
  if (layerRules.length === 0) return cssText

  const declaredOrder: string[] = []
  const sourceOrder: string[] = []

  for (const atRule of layerRules) {
    if (!atRule.nodes) {
      // Bare statement form: declares order, nothing to splice.
      for (const name of splitLayerStatementNames(atRule.params)) {
        if (!declaredOrder.includes(name)) declaredOrder.push(name)
      }
      atRule.remove()
      continue
    }
    const name = atRule.params.trim()
    if (name && !sourceOrder.includes(name)) sourceOrder.push(name)
    atRule.replaceWith(atRule.nodes)
  }

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

  return root.toString()
}
