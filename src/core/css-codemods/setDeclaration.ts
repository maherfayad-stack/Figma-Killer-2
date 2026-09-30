/**
 * setDeclaration — WS-6.3's CSS write-back: one declaration of one class,
 * written where the CASCADE reads it (P3-C, WB-16), optionally inside a
 * conditional block (`@media`, `@container`, `@supports` — WB-31).
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
 * ## Which line: the one taking effect
 *
 * The cascade honours the LAST declaration of a property among equals, and an
 * `!important` one over every plain one. This writer used to rewrite the FIRST
 * matching rule, and `analyzeDeclarationTarget` refused the three ordinary
 * shapes where that is not the line on screen — a selector declared twice, a
 * property twice in one block, a covering shorthand after the longhand. In
 * each of them the declaration the canvas shows IS a real line in the file:
 * one honest target. So the writer finds it:
 *
 *   - the property set in a later block, or twice in one block — the last
 *     one (the one taking effect) is rewritten, the earlier ones left alone;
 *   - a covering shorthand is the last word — the longhand is inserted right
 *     AFTER it in its block, where it wins, and the shorthand's other sides
 *     are untouched;
 *   - nothing sets the property yet — it is appended at the end of the first
 *     matching rule (a fresh rule at the end of the scope when none exists),
 *     where nothing can follow it.
 *
 * What still refuses is the one shape with no honest single write:
 * `important-override`, a covering shorthand carrying `!important`, which
 * beats a plain longhand from any position — making the longhand `!important`
 * or editing the shorthand are both a different edit than the one asked for.
 * Unparseable CSS refuses `css-syntax`, a malformed scope `invalid-at-rule`.
 *
 * `analyzeDeclarationTarget` keeps the old verdicts for the one caller that
 * still writes the first match — a styled-component template
 * (`setStyledDeclaration`), whose spans are not rules this module can splice.
 *
 * Scope, deliberately narrow:
 *   - A SINGLE stylesheet's text; the caller supplies which file — pure
 *     text-in/text-out, like every other codemod in this family.
 *   - A rule is matched by an EXACT selector string (`.card`, not
 *     `.card, .alt`) — `StyleRule.selector` is always one selector.
 *   - It does not decide whether a file is EDITABLE (`dist/`, `.min.css`) —
 *     `classifyStylesheetEditability` is the caller's separate check.
 */
import postcss, { type AtRule, type Container, type Declaration, type Root, type Rule } from 'postcss'
import { preservingLineEndings } from './preserveLineEndings'
import { shorthandCovers } from './analyzeDeclarationTarget'
import { findAtRuleBlocks, parseAtRuleScope, type AtRuleScope } from './cssAtRuleScope'

/** A named, user-readable reason a declaration write declined. `message` is shown verbatim. */
export interface DeclarationWriteRefusal {
  reason: 'important-override' | 'css-syntax' | 'invalid-at-rule'
  message: string
}

export type DeclarationWriteResult =
  | {
      ok: true
      /** The rewritten stylesheet text — identical to the input when `changed` is `false`. */
      css: string
      /** `false` when the requested state was already the state in the file (a pure no-op edit). */
      changed: boolean
    }
  | { ok: false; refusal: DeclarationWriteRefusal }

export interface DeclarationWriteOptions {
  /**
   * The conditional block the declaration lives in, as `name params`:
   * `"media (max-width: 768px)"`, `"container card (min-width: 400px)"`,
   * `"supports (display: grid)"` — see `cssAtRuleScope.ts`. Omit for the
   * rule's unconditional declarations.
   */
  atRule?: string
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
 * a brand-new rule's merge into an exact-selector match is the one place a
 * "first declaration of this property in THIS rule" write is right.
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

/** Every direct-child rule of `containers` whose selector matches exactly, trimmed, in source order. */
function matchingRules(containers: readonly Container[], selector: string): Rule[] {
  const target = selector.trim()
  const rules: Rule[] = []
  for (const container of containers) {
    container.each((node) => {
      if (node.type === 'rule' && node.selector.trim() === target) rules.push(node)
    })
  }
  return rules
}

/** Every declaration of `property`, or of a shorthand covering it, across `rules`, in source order. */
function relevantDeclarations(rules: readonly Rule[], property: string): Declaration[] {
  const prop = property.toLowerCase()
  const decls: Declaration[] = []
  for (const rule of rules) {
    rule.each((node) => {
      if (node.type !== 'decl') return
      const declProp = node.prop.toLowerCase()
      if (declProp === prop || shorthandCovers(declProp, prop)) decls.push(node)
    })
  }
  return decls
}

/**
 * The parse and the scope, or the refusal either one ends in. Shared with
 * `removeDeclaration.ts` so the two answer "which blocks" identically.
 */
export function readDeclarationScope(
  source: string,
  options: DeclarationWriteOptions,
): { root: Root; scope: AtRuleScope | null; containers: Container[] } | { refusal: DeclarationWriteRefusal } {
  let root: Root
  try {
    root = postcss.parse(source)
  } catch {
    return {
      refusal: {
        reason: 'css-syntax',
        message: 'Studio could not parse this stylesheet, so it did not edit it. Fix the CSS syntax and try again.',
      },
    }
  }
  if (options.atRule === undefined) return { root, scope: null, containers: [root] }
  const scope = parseAtRuleScope(options.atRule)
  if (!scope) {
    return {
      refusal: {
        reason: 'invalid-at-rule',
        message: `"${options.atRule}" is not a @media, @container or @supports condition Studio can write into.`,
      },
    }
  }
  return { root, scope, containers: findAtRuleBlocks(root, scope) }
}

/** A fresh rule node parsed from a literal fragment — the reliable way to get its semicolon and indentation. */
function buildRule(selector: string, property: string, value: string, indent: string): Rule {
  const rule = postcss.parse(`${indent}${selector} {\n${indent}  ${property}: ${value};\n${indent}}`).first
  if (!rule || rule.type !== 'rule') throw new Error('[css-codemods] unreachable: fragment did not yield a rule')
  return rule
}

/**
 * Appends a fresh rule for `selector` LAST in its scope — at the end of the
 * file, inside the last matching block, or inside a new block at the end of
 * the file (parsed as one fragment: `Node#toString()` drops a nested rule's own
 * `raws.before`, which is how its indentation went missing the first time).
 */
function appendRule(root: Root, scope: AtRuleScope | null, blocks: readonly Container[], selector: string, property: string, value: string): void {
  if (!scope) {
    const rule = buildRule(selector, property, value, '')
    if (root.nodes.length > 0) rule.raws.before = '\n\n'
    root.append(rule)
    return
  }
  const lastBlock = blocks[blocks.length - 1] as AtRule | undefined
  if (lastBlock) {
    lastBlock.append(buildRule(selector, property, value, '  '))
    return
  }
  const block = postcss.parse(`@${scope.name} ${scope.params.trim()} {\n  ${selector} {\n    ${property}: ${value};\n  }\n}`).first
  if (!block || block.type !== 'atrule') throw new Error('[css-codemods] unreachable: fragment did not yield an at-rule')
  if (root.nodes.length > 0) block.raws.before = '\n\n'
  root.append(block)
}

/** See this module's doc: the declaration the cascade reads is the one written. */
export function setDeclaration(
  cssText: string,
  selector: string,
  property: string,
  value: string,
  options: DeclarationWriteOptions = {},
): DeclarationWriteResult {
  let refusal: DeclarationWriteRefusal | null = null
  const rewrite = preservingLineEndings(cssText, (source) => {
    const read = readDeclarationScope(source, options)
    if ('refusal' in read) {
      refusal = read.refusal
      return { css: source, changed: false }
    }
    const { root, scope, containers } = read
    const rules = matchingRules(containers, selector)
    if (rules.length === 0) {
      appendRule(root, scope, containers, selector, property, value)
      return { css: root.toString(), changed: true }
    }

    const relevant = relevantDeclarations(rules, property)
    // `!important` beats a plain declaration from any position; among equals
    // the later one wins.
    const important = relevant.filter((decl) => decl.important)
    const winner = important[important.length - 1] ?? relevant[relevant.length - 1]
    const prop = property.toLowerCase()

    if (!winner) {
      rules[0]!.append({ prop: property, value })
      return { css: root.toString(), changed: true }
    }
    if (winner.prop.toLowerCase() === prop) {
      if (winner.value === value) return { css: source, changed: false }
      winner.value = value
      return { css: root.toString(), changed: true }
    }
    if (winner.important) {
      refusal = {
        reason: 'important-override',
        message:
          `“${selector.trim()}” sets “${winner.prop}: … !important”, which overrides “${prop}” however it is ` +
          `written. Edit “${winner.prop}” instead, or drop the !important.`,
      }
      return { css: source, changed: false }
    }
    // A covering shorthand has the last word: the longhand goes right after it.
    winner.after({ prop: property, value })
    return { css: root.toString(), changed: true }
  })
  return refusal ? { ok: false, refusal } : { ok: true, ...rewrite }
}
