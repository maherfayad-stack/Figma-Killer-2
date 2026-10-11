/**
 * Whether a node can hold children, decided by the REAL element it renders as.
 *
 * `ModuleDefinition.canHaveChildren` is a property of the module, but one
 * module covers many tags: an `<input>` parses to `base.container` (which holds
 * children) with `tag: "custom"` and `customTag: "input"`. Asking the module
 * alone says yes, and a drop inside it writes `<input>...</input>`, which React
 * refuses to render. A void element (`input`, `img`, `br`, `hr`, ...) never has
 * children, so the tag is checked here, against the one void list the codemods
 * and the publisher already share.
 */
import { VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'
import { registry } from './registry'
import { resolveHtmlTagBadge } from './htmlTagBadge'

export function nodeAcceptsChildren(node: { moduleId: string; props?: unknown }): boolean {
  const definition = registry.get(node.moduleId)
  if (definition?.canHaveChildren !== true) return false
  const tag = resolveHtmlTagBadge(definition, (node.props ?? {}) as Record<string, unknown>)
  return tag === null || !VOID_HTML_ELEMENTS.has(tag)
}
