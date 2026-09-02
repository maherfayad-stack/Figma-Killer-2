/**
 * pageSourceFile — the ONE way a server-side Studio tool turns an already-
 * loaded `Page` (from `loadStudioPages`) into the project-relative source
 * file it was parsed from.
 *
 * Extracted from `server/ai/tools/studio/liveDigest.ts`'s local
 * `resolvePageFile` so a second caller — `studio_screenshot`
 * (`server/ai/mcp/tools/studio/screenshot.ts`, A6 in
 * STUDIO-FIGMA-PARITY-PLAN.md) — can resolve the same fact without growing a
 * second, possibly-drifting copy of the same node-id decoding.
 */
import { decodeSourceNodeId, type Page } from '@core/page-tree'

/**
 * `Page.rootNodeId` is a SYNTHETIC `base.body` wrapper the page-tree
 * conversion adds (e.g. `home:body`) — it never decodes as a real source
 * location (`pageScaffold.ts`'s own `scaffoldedPageRootNodeId` reads the
 * page-PARSER's root instead for exactly this reason). The real top-level
 * JSX element is the synthetic root's first child, which DOES carry a real
 * `rel:line:col` id (`@core/page-tree/sourceNodeId`). Falls back to scanning
 * every node for the first decodable id (bounded — one page's nodes, never
 * more) if the first child itself is somehow also synthetic; `null` only when
 * nothing on the page decodes at all (a from-scratch scaffold with no source
 * yet, or a parse that produced zero writable nodes).
 */
export function resolvePageSourceFile(page: Page): string | null {
  const direct = decodeSourceNodeId(page.rootNodeId)
  if (direct) return direct.rel
  const firstChildId = page.nodes[page.rootNodeId]?.children[0]
  const fromFirstChild = firstChildId ? decodeSourceNodeId(firstChildId) : null
  if (fromFirstChild) return fromFirstChild.rel
  for (const nodeId of Object.keys(page.nodes)) {
    const loc = decodeSourceNodeId(nodeId)
    if (loc) return loc.rel
  }
  return null
}
