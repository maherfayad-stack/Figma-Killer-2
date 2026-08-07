/**
 * setDeclaration / setDeclarationAtMedia — WS-6.3's CSS write-back, tier 1
 * (plain-CSS projects only — see this module's barrel doc for the full
 * tiering decision, `meta-03` decision 3).
 *
 * A CST round-trip via `postcss` (parse → mutate the AST → `.toString()`),
 * NOT a CSSOM read/rewrite (`cssToStyleRules` is deliberately not reused
 * here — that path is lossy: it can tell you a rule's resolved
 * property→value map, but re-serializing FROM that map would silently drop
 * the user's own formatting, comments, and any properties/rules this
 * evaluator doesn't understand). postcss's AST preserves every byte it
 * didn't touch — the `raws` on every untouched node round-trip verbatim —
 * so a one-property edit produces a one-line diff in the user's actual
 * source file, not a wholesale reformat.
 *
 * Scope, deliberately narrow for this pass:
 *   - Operates on a SINGLE stylesheet's text (the caller supplies which file
 *     — this module has no filesystem access, matching every other codemod
 *     in `@core/ast-codemods`, which are also pure text-in/text-out).
 *   - Matches a rule by an EXACT selector string (`.card`, not `.card, .alt`
 *     — a compound selector list is intentionally not split/matched
 *     partially, since `StyleRule.selector`/`styleRuleSelector()` already
 *     only ever produce a single selector per rule).
 *   - The FIRST rule in the file with a matching selector is the edit
 *     target — "the file the class was first defined in" reads as "the
 *     first place it's defined", not every duplicate declaration block a
 *     user might also have.
 *   - A rule that doesn't exist yet is created at the END of the file (or,
 *     for `setDeclarationAtMedia`, inside a matching `@media` block created
 *     at the end of the file if the block itself doesn't exist either).
 *
 * What this module does NOT do (honest gaps, not silently swallowed):
 *   - It does not decide WHICH file/selector to write to for a given
 *     `StyleRule.id` — that mapping (`StyleRule.id → (file, selector,
 *     position)`, sketched in `STUDIO-IMPORT-V2-PLAN.md` §6.3) is parser
 *     output, not wired by this work order (see `panel-01`'s STATE.md
 *     handoff for the honest gap). This module is the write primitive the
 *     future wiring calls, tested and correct in isolation.
 *   - It does not decide whether a file is EDITABLE (a `dist/style.css`,
 *     Tailwind's compiled output, or a `.module.css` compile all have no
 *     meaningful hand-editable source at this layer) — see
 *     `classifyStylesheetEditability.ts`, a separate, composable check the
 *     caller runs BEFORE calling this module.
 *   - It is not wired to any HTTP route or the studio save pipeline yet —
 *     `StyleTargetChip`'s class-target warning ("CSS edits are
 *     preview-only until CSS write-back lands") is still accurate after
 *     this module ships; only the write PRIMITIVE exists, not the
 *     end-to-end path from a canvas edit to a saved file.
 */
import postcss, { type Root, type Container, type Rule } from 'postcss'

export interface SetDeclarationResult {
  /** The rewritten stylesheet text — identical to the input when `changed` is `false`. */
  css: string
  /** `false` when the requested value was already in place (a pure no-op edit). */
  changed: boolean
}

/**
 * Match a direct-child rule of `container` whose selector equals `selector`,
 * trimmed. Exported for `insertRule.ts` (Track B1), which needs the exact
 * same "does this selector already have a rule in this scope" check before
 * deciding to merge into it instead of appending a duplicate — sharing the
 * function keeps the two codemods' notion of "the same rule" from drifting.
 */
export function findRule(container: Container, selector: string): Rule | undefined {
  const target = selector.trim()
  let found: Rule | undefined
  container.each((node) => {
    if (found) return false
    if (node.type === 'rule' && node.selector.trim() === target) {
      found = node
      return false
    }
    return undefined
  })
  return found
}

/**
 * Set (or insert) one declaration inside an existing rule node. Returns
 * whether it changed anything. Exported for `insertRule.ts` (Track B1) —
 * see `findRule`'s doc for why the two codemods share this rather than each
 * growing their own copy.
 */
export function applyDeclaration(rule: Rule, property: string, value: string): boolean {
  const propLower = property.toLowerCase()
  let existing: Rule['nodes'][number] | undefined
  rule.walkDecls((decl) => {
    if (decl.prop.toLowerCase() === propLower) {
      existing = decl
      return false
    }
    return undefined
  })
  if (existing && existing.type === 'decl') {
    if (existing.value === value) return false
    existing.value = value
    return true
  }
  rule.append({ prop: property, value })
  return true
}

/**
 * Build a fresh, well-formed rule node by parsing a literal CSS fragment
 * (rather than hand-assembling postcss nodes and guessing at `raws`) — the
 * only reliable way to get a correct trailing semicolon and indentation
 * with no sibling declarations to infer formatting from. `indent` is the
 * whitespace prefix for the selector line itself (`''` at the top level of
 * a file, `'  '` one level inside an `@media` block); the declaration line
 * is indented one step further.
 */
function buildRule(selector: string, property: string, value: string, indent = ''): Rule {
  const fragment = postcss.parse(`${indent}${selector} {\n${indent}  ${property}: ${value};\n${indent}}`)
  const rule = fragment.first
  if (!rule || rule.type !== 'rule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield a rule node')
  }
  return rule
}

/**
 * Set a plain (non-media) declaration on a selector's rule, creating the
 * rule at the end of the file if it doesn't exist.
 */
export function setDeclaration(cssText: string, selector: string, property: string, value: string): SetDeclarationResult {
  const root: Root = postcss.parse(cssText)
  const existingRule = findRule(root, selector)

  if (existingRule) {
    const changed = applyDeclaration(existingRule, property, value)
    return { css: changed ? root.toString() : cssText, changed }
  }

  const rule = buildRule(selector, property, value)
  if (root.nodes.length > 0) rule.raws.before = '\n\n'
  root.append(rule)
  return { css: root.toString(), changed: true }
}

/**
 * Set a declaration on a selector's rule nested inside `@media <mediaQuery>`,
 * creating the media block (and/or the rule inside it) at the end of the
 * file if either doesn't exist yet. `mediaQuery` is matched against the
 * at-rule's `params`, trimmed — the same "exact string, no normalization"
 * posture as the plain-selector match above.
 */
export function setDeclarationAtMedia(
  cssText: string,
  selector: string,
  mediaQuery: string,
  property: string,
  value: string,
): SetDeclarationResult {
  const root: Root = postcss.parse(cssText)
  const query = mediaQuery.trim()

  let mediaAtRule: Root['nodes'][number] | undefined
  root.each((node) => {
    if (node.type === 'atrule' && node.name === 'media' && node.params.trim() === query) {
      mediaAtRule = node
      return false
    }
    return undefined
  })

  if (mediaAtRule && mediaAtRule.type === 'atrule') {
    const existingRule = findRule(mediaAtRule, selector)
    if (existingRule) {
      const changed = applyDeclaration(existingRule, property, value)
      return { css: changed ? root.toString() : cssText, changed }
    }
    const rule = buildRule(selector, property, value, '  ')
    mediaAtRule.append(rule)
    return { css: root.toString(), changed: true }
  }

  // Neither the @media block nor the rule exists — create both as one literal
  // fragment (not by re-serializing a separately-built rule node and
  // re-embedding the string — `Node#toString()` does not include that node's
  // own `raws.before`, which silently ate the nested rule's indentation the
  // first time this was written; parsing one fragment sidesteps the issue
  // entirely).
  const newMediaFragment = postcss.parse(
    `@media ${query} {\n  ${selector} {\n    ${property}: ${value};\n  }\n}`,
  )
  const newMedia = newMediaFragment.first
  if (!newMedia || newMedia.type !== 'atrule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield an at-rule node')
  }
  if (root.nodes.length > 0) newMedia.raws.before = '\n\n'
  root.append(newMedia)
  return { css: root.toString(), changed: true }
}
