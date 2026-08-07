/**
 * insertRule — Track B1's CST insert for a selector that has NO existing
 * declaration block in this stylesheet yet: a brand-new class the user just
 * created on the canvas, a new `@keyframes` step, a rule this project never
 * had before. Companion to `setDeclaration` (which matches an EXISTING
 * selector, or — for a missing one — creates a bare rule holding exactly ONE
 * declaration): `insertRule` accepts the FULL declaration set a new rule
 * needs in one CST mutation, and is formatting-preserving in exactly the
 * same way — only the appended bytes are new; every untouched node's `raws`
 * round-trip verbatim through postcss, so an insert produces a clean diff in
 * the user's actual source file, never a wholesale reformat.
 *
 * ## Insert vs. merge
 *
 * If a rule with the EXACT selector already exists in the target scope (top
 * level, or inside the matching `@media` block when `atMedia` is given),
 * this does NOT create a second, cascade-shadowing block. CLAUDE.md's "one
 * honest target" invariant applies just as much to inserting as to editing —
 * two `.card { }` blocks in one file is precisely the hazard
 * `analyzeDeclarationTarget` exists to catch on the read side. Each supplied
 * declaration is instead SET on the existing rule (via `applyDeclaration`,
 * shared verbatim with `setDeclaration` so the two codemods' notion of "the
 * same rule" cannot drift), so calling `insertRule` twice with the same
 * selector converges rather than duplicating.
 *
 * ## Formatting
 *
 * A brand-new rule is built by parsing a literal CSS fragment (the same
 * technique `setDeclaration`'s `buildRule` uses) — the only reliable way to
 * get correct semicolons/indentation with no sibling declaration to infer
 * formatting from, rather than hand-assembling postcss nodes and guessing at
 * `raws`.
 *
 * ## Scope, matching `setDeclaration`'s
 *
 *   - Operates on a SINGLE stylesheet's text; no filesystem access.
 *   - Matches a rule by an EXACT selector string, same as `setDeclaration`.
 *   - `atMedia`, when given, matches an existing `@media` block by its exact
 *     `params` string (trimmed) — same rule `setDeclarationAtMedia` uses —
 *     creating the block at the end of the file when it doesn't exist yet.
 */
import postcss, { type Root, type Rule } from 'postcss'
import { findRule, applyDeclaration } from './setDeclaration'

export interface InsertRuleResult {
  /** The rewritten stylesheet text — identical to the input when `changed` is `false`. */
  css: string
  /** `false` when every supplied declaration already matched the existing rule (a pure no-op). */
  changed: boolean
}

export interface InsertRuleOptions {
  /**
   * Wrap the new rule in `@media <atMedia>`, matching (or creating) the
   * block the same way `setDeclarationAtMedia` does. Omit for a plain,
   * top-level rule.
   */
  atMedia?: string
}

/** Build a fresh rule node holding every declaration, via a literal-fragment parse — see this module's "Formatting" doc. */
function buildRuleWithDeclarations(
  selector: string,
  declarations: Readonly<Record<string, string>>,
  indent = '',
): Rule {
  const body = Object.entries(declarations)
    .map(([property, value]) => `${indent}  ${property}: ${value};`)
    .join('\n')
  const fragment = postcss.parse(`${indent}${selector} {\n${body}\n${indent}}`)
  const rule = fragment.first
  if (!rule || rule.type !== 'rule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield a rule node')
  }
  return rule
}

/** Apply every declaration to an existing rule via `applyDeclaration`, returning whether anything actually changed. */
function applyDeclarations(rule: Rule, declarations: Readonly<Record<string, string>>): boolean {
  let changed = false
  for (const [property, value] of Object.entries(declarations)) {
    if (applyDeclaration(rule, property, value)) changed = true
  }
  return changed
}

/**
 * Insert (or, for an already-existing exact selector, merge into) a rule
 * holding `declarations`. See this module's doc for the insert-vs-merge
 * decision and the formatting discipline.
 */
export function insertRule(
  cssText: string,
  selector: string,
  declarations: Readonly<Record<string, string>>,
  options: InsertRuleOptions = {},
): InsertRuleResult {
  const root: Root = postcss.parse(cssText)
  const { atMedia } = options

  if (atMedia === undefined) {
    const existing = findRule(root, selector)
    if (existing) {
      const changed = applyDeclarations(existing, declarations)
      return { css: changed ? root.toString() : cssText, changed }
    }
    const rule = buildRuleWithDeclarations(selector, declarations)
    if (root.nodes.length > 0) rule.raws.before = '\n\n'
    root.append(rule)
    return { css: root.toString(), changed: true }
  }

  const query = atMedia.trim()
  let mediaAtRule: Root['nodes'][number] | undefined
  root.each((node) => {
    if (node.type === 'atrule' && node.name === 'media' && node.params.trim() === query) {
      mediaAtRule = node
      return false
    }
    return undefined
  })

  if (mediaAtRule && mediaAtRule.type === 'atrule') {
    const existing = findRule(mediaAtRule, selector)
    if (existing) {
      const changed = applyDeclarations(existing, declarations)
      return { css: changed ? root.toString() : cssText, changed }
    }
    const rule = buildRuleWithDeclarations(selector, declarations, '  ')
    mediaAtRule.append(rule)
    return { css: root.toString(), changed: true }
  }

  // Neither the @media block nor the rule exists — create both as one
  // literal fragment (not by re-serializing a separately-built rule node and
  // re-embedding the string — see `setDeclarationAtMedia`'s identical note on
  // why `Node#toString()` alone silently drops the nested rule's own
  // indentation).
  const bodyLines = Object.entries(declarations)
    .map(([property, value]) => `    ${property}: ${value};`)
    .join('\n')
  const newMediaFragment = postcss.parse(`@media ${query} {\n  ${selector} {\n${bodyLines}\n  }\n}`)
  const newMedia = newMediaFragment.first
  if (!newMedia || newMedia.type !== 'atrule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield an at-rule node')
  }
  if (root.nodes.length > 0) newMedia.raws.before = '\n\n'
  root.append(newMedia)
  return { css: root.toString(), changed: true }
}
