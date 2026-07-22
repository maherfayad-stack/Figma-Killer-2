/**
 * Converts a `ParsedPage` (from `../page-parser` — a flat element/instance
 * tree extracted from a real .tsx page file) into an Instatic `Page` (from
 * `../page-tree`) so the parsed source can be loaded into the editor's
 * document model.
 *
 * CRITICAL Instatic rule: `rootNodeId` must point at a `base.body` node, so
 * this converter synthesises one and hangs the parsed root nodes under it.
 */
import type { ParsedPage, ParsedNode } from '../page-parser'
import type { Page, PageNode } from '../page-tree'

export interface ParsedPageToSitePageOptions {
  pageId: string
  slug: string
  title: string
  /** Maps a parsed node to an Instatic moduleId. Pure/injected so this converter
   *  stays decoupled from the design-system list. e.g. component "Button" -> "alm.Button",
   *  element "div" -> "base.container". */
  resolveModuleId: (node: Pick<ParsedNode, 'kind' | 'name'>) => string
}

export function parsedPageToSitePage(parsed: ParsedPage, opts: ParsedPageToSitePageOptions): Page {
  const bodyId = `${opts.pageId}:body`

  const bodyNode: PageNode = {
    id: bodyId,
    moduleId: 'base.body',
    props: {},
    children: [...parsed.rootIds],
    classIds: [],
    breakpointOverrides: {},
  }

  const nodes: Record<string, PageNode> = { [bodyId]: bodyNode }
  for (const [id, node] of Object.entries(parsed.nodes)) {
    nodes[id] = {
      id,
      moduleId: opts.resolveModuleId({ kind: node.kind, name: node.name }),
      props: { ...node.props },
      children: [...node.children],
      classIds: [],
      breakpointOverrides: {},
      // Propagate the page-parser's source/dynamic lock (`.map`/ternary/`&&`/
      // spread subtree detection) onto the built PageNode so the editor's
      // edit-guard checks (nodeActions, inlineEditSlice) can refuse to mutate
      // these nodes. Distinct from the manual "layer lock" the editor itself
      // toggles — see `lockReason`'s doc comment in `page-tree/baseNode.ts`.
      ...(node.locked ? { locked: true } : {}),
      ...(node.lockReason ? { lockReason: node.lockReason } : {}),
    }
  }

  return {
    id: opts.pageId,
    slug: opts.slug,
    title: opts.title,
    rootNodeId: bodyId,
    nodes,
  }
}
