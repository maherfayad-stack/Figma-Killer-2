/**
 * cssAtRuleScope — the conditional block a declaration is written inside:
 * `@media`, `@container` or `@supports` (P3-C, WB-31).
 *
 * A breakpoint override is written into its own `@media` block (`style-03`).
 * A `container` or `supports` condition used to be REFUSED — "cannot yet write
 * @container or @supports … will be lost on reload" — because the writers
 * only knew `@media`. postcss is indifferent to which at-rule wraps a rule:
 * the block is found by name and params, created at the end of the file when
 * it is missing, and the rule inside it is written exactly as a media one is.
 * So the scope is one value naming both: `"media (max-width: 768px)"`,
 * `"container card (min-width: 400px)"`, `"supports (display: grid)"`.
 *
 * Matching is exact on the trimmed params — the same "exact string, no
 * normalisation" posture the selector match takes. Two spellings of one query
 * are two blocks; merging them is the user's call, not a write's.
 */
import type { AtRule, ChildNode, Container } from 'postcss'

/** The at-rules a declaration may be written inside. */
export const WRITABLE_AT_RULE_NAMES = ['media', 'container', 'supports'] as const
export type WritableAtRuleName = (typeof WRITABLE_AT_RULE_NAMES)[number]

/** One conditional block: its at-rule name and its params, as written after the name. */
export interface AtRuleScope {
  name: WritableAtRuleName
  params: string
}

/** The wire/regex form of a scope: the at-rule name, whitespace, then its params. */
export const AT_RULE_SCOPE_PATTERN = '^(media|container|supports)\\s+\\S'

/** `"media (max-width: 768px)"` → `{ name: 'media', params: '(max-width: 768px)' }`; `null` for anything else. */
export function parseAtRuleScope(atRule: string): AtRuleScope | null {
  const match = /^\s*(media|container|supports)\s+(\S[\s\S]*?)\s*$/.exec(atRule)
  if (!match) return null
  return { name: match[1] as WritableAtRuleName, params: match[2]! }
}

/** The scope written back as `name params` — what `parseAtRuleScope` reads. */
export function formatAtRuleScope(scope: AtRuleScope): string {
  return `${scope.name} ${scope.params.trim()}`
}

/** True when `node` is the at-rule `scope` names. */
export function isAtRuleScope(node: ChildNode, scope: AtRuleScope): node is AtRule {
  return node.type === 'atrule' && node.name === scope.name && node.params.trim() === scope.params.trim()
}

/** Every direct child of `container` that is the at-rule `scope` names, in source order. */
export function findAtRuleBlocks(container: Container, scope: AtRuleScope): AtRule[] {
  const blocks: AtRule[] = []
  container.each((node) => {
    if (isAtRuleScope(node, scope)) blocks.push(node)
  })
  return blocks
}
