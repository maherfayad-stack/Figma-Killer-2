/**
 * `nodeHtmlTag` — "what intrinsic HTML element is this node?", answered from
 * the module registry.
 *
 * `struct-11` needs it so ⌘G can refuse a container that would be invalid
 * where it lands (a `<div>` inside a `<p>`, any wrapper inside a `<ul>`)
 * BEFORE the round trip, with a dialog and a way forward, rather than after it
 * as a toast. `previewStructuralGroup` takes it as an injected resolver for
 * the reason `parsedPageToSitePage` takes its resolvers that way:
 * `@core/page-tree` must not depend on `@core/module-engine`.
 *
 * `ModuleDefinition.sourceIntrinsic` is the right question and the only one
 * asked here — it is defined as "how this module is spelled in a user's React
 * source when it is an intrinsic element", which is exactly the tag whose
 * content model decides what may sit inside it. It is NOT the canvas
 * `htmlTag`: that one answers what a module RENDERS AS, which for a component
 * instance is a wrapper the user's source does not contain.
 *
 * Everything else answers `null`, which every consumer reads as "no opinion".
 * Two `base.*` modules implement `sourceIntrinsic` today — `base.container`
 * (every non-text element Studio imports, carrying its real tag in
 * `props.tag`/`props.customTag`) and `base.text` — so `<a>`, `<img>`,
 * `<button>` and every design-system component come back unknown. That is the
 * safe direction: an unknown tag never produces a refusal, and the AST-side
 * check in `wrapJsxElements` still sees the real name.
 */
import { registry } from '@core/module-engine'
import type { PageNode } from '@core/page-tree'

export function nodeHtmlTag(node: PageNode): string | null {
  const intrinsic = registry.get(node.moduleId)?.sourceIntrinsic?.(node.props)
  const tag = intrinsic?.tag
  return typeof tag === 'string' && tag.length > 0 ? tag.toLowerCase() : null
}
