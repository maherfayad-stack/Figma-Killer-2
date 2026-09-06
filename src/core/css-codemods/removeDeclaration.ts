/**
 * removeDeclaration — the missing half of `setDeclaration`.
 *
 * ## Why it exists (`style-03`)
 *
 * The save diff only ever iterated the properties a rule has NOW, and
 * `setDeclaration` only ever sets a value. Clearing a declaration in the
 * inspector therefore produced no edit at all: the canvas updated, autosave
 * ran, the file was untouched, and the property came straight back on the next
 * reload — with nothing said. That is the same silent-loss shape the `unmapped`
 * refusal exists to prevent, one level down: not "we cannot write this", but
 * "we did not even look".
 *
 * A CST round-trip via `postcss`, exactly like its sibling: parse, remove one
 * declaration node, `.toString()`. Every byte this codemod did not touch
 * round-trips verbatim through postcss's `raws`, so clearing one property
 * produces a one-line diff in the user's real stylesheet.
 *
 * ## What it cleans up, and what it does not
 *
 * A rule left with NO nodes at all is removed too — `.card {}` is dead text
 * that says nothing, and leaving it behind would make "clear every property"
 * accumulate empty blocks over a session. A rule still holding a comment keeps
 * its block, because a comment is a node and the user wrote it. Emptying the
 * last rule inside an `@media` block removes the block for the same reason.
 *
 * It does NOT decide whether the removal is HONEST — whether the declaration
 * this file removes is the one the cascade was actually honouring. That is
 * `analyzeDeclarationTarget`'s job, which the caller runs first on the same
 * text, exactly as it already does before `setDeclaration`. A property that is
 * simply absent is `changed: false`, never an error: re-sending an
 * already-applied removal on a later autosave tick must be a no-op.
 */
import postcss, { type AtRule, type Container, type Root } from 'postcss'
import { findRule } from './setDeclaration'

export interface RemoveDeclarationResult {
  /** The rewritten stylesheet text — identical to the input when `changed` is `false`. */
  css: string
  /** `false` when the declaration was already absent (a pure no-op edit). */
  changed: boolean
}

/** The `@media` at-rule in `root` whose params match `query`, trimmed — the same exact-string match `setDeclarationAtMedia` uses. */
function findMediaAtRule(root: Root, query: string): AtRule | undefined {
  const target = query.trim()
  let found: AtRule | undefined
  root.each((node) => {
    if (found) return false
    if (node.type === 'atrule' && node.name === 'media' && node.params.trim() === target) {
      found = node
      return false
    }
    return undefined
  })
  return found
}

/**
 * Remove one declaration from a selector's rule, optionally inside an
 * `@media` block. See this module's doc for the empty-block cleanup and for
 * what this deliberately leaves to `analyzeDeclarationTarget`.
 */
export function removeDeclaration(
  cssText: string,
  selector: string,
  property: string,
  options: { atMedia?: string } = {},
): RemoveDeclarationResult {
  const root: Root = postcss.parse(cssText)

  let container: Container = root
  let mediaAtRule: AtRule | undefined
  if (options.atMedia) {
    mediaAtRule = findMediaAtRule(root, options.atMedia)
    if (!mediaAtRule) return { css: cssText, changed: false } // no such block — nothing to remove
    container = mediaAtRule
  }

  const rule = findRule(container, selector)
  if (!rule) return { css: cssText, changed: false }

  const propLower = property.toLowerCase()
  let removed = false
  rule.each((node) => {
    if (node.type === 'decl' && node.prop.toLowerCase() === propLower) {
      node.remove()
      removed = true
      return false
    }
    return undefined
  })
  if (!removed) return { css: cssText, changed: false }

  if (rule.nodes.length === 0) {
    rule.remove()
    if (mediaAtRule && (mediaAtRule.nodes?.length ?? 0) === 0) mediaAtRule.remove()
  }

  return { css: root.toString(), changed: true }
}
