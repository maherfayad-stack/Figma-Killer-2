/**
 * findReplacementNodeId — after a `detach`/`extract` codemod lands and a full
 * board reload re-parses everything (`store-10`'s recon: both codemods rewrite
 * imports or mint a file, so `requestCmsSiteReload()` always fires), the
 * refused node's OWN id is gone or has changed shape. This finds whatever node
 * now sits at the SAME call site so `RefusalDialog` can re-issue the gesture
 * against it.
 *
 * Keyed on `matchesCallSitePosition`, not `decodeSourceNodeId`'s tail — see
 * `callSitePosition`'s own doc in `@core/page-tree/sourceNodeId.ts` for why the
 * call site's `rel:line:col` is the one thing detach/extract both leave alone.
 *
 * Scans every page's flat node map and every Visual Component's tree — a call
 * site position is a `rel:line:col` in a real file, so a page and a VC
 * definition colliding on the exact same position is not a real ambiguity
 * this needs to resolve; scanning both unconditionally (rather than gating on
 * which document happens to be active) is simpler and strictly safer than
 * missing a hit because the user's active document changed while the dialog
 * was waiting.
 */
import type { SiteDocument } from '@core/page-tree'
import { matchesCallSitePosition } from '@core/page-tree'

export function findReplacementNodeId(site: SiteDocument, position: string): string | undefined {
  for (const page of site.pages) {
    for (const id of Object.keys(page.nodes)) {
      if (matchesCallSitePosition(id, position)) return id
    }
  }
  for (const vc of site.visualComponents) {
    for (const id of Object.keys(vc.tree.nodes)) {
      if (matchesCallSitePosition(id, position)) return id
    }
  }
  return undefined
}
