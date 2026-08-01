/**
 * The Studio-project prompt's LIVE digest (WS-12 §2.1/§2.2) — turns the
 * browser's lean `StudioAgentSnapshot` (board/selection/axes ids only) into
 * the rich, bounded facts the dynamic suffix reports: board frame titles,
 * the active page's file + root, the selected node's editable-vs-locked
 * facts, a fidelity digest, install status, and the staleness warning.
 *
 * **Cost discipline (trap #11 — never walk every page's nodes):**
 * `loadStudioPages(dir)` is called exactly ONCE per turn, and IS mtime-cache-
 * backed (`pageParseCache.ts`) — a turn against an unchanged project is a
 * cache hit, not a re-parse. From that one result:
 *   - board frame titles read `page.title` for pages that have a frame on
 *     the CURRENT board only (bounded by frame count, never board count ×
 *     page count).
 *   - the fidelity digest and the selected-node lookup walk the ACTIVE
 *     PAGE's nodes only — one page, never the whole project.
 * No other page's node map is ever touched.
 */
import { decodeSourceNodeId, type Page } from '@core/page-tree'
import { loadStudioPages } from '../../../handlers/studioPageLoad'
import { probeInstallStatus } from '../../../handlers/studio/installDeps'
import { join } from 'node:path'
import { studioSnapshotStaleness, STALE_NODE_IDS_WARNING, type StalenessTracker } from './staleness'
import type { StudioAgentSnapshot } from './snapshot'

export interface StudioLiveDigest {
  readonly board: { readonly activeBoardId: string | null; readonly frames: ReadonlyArray<{ pageId: string; title: string; x: number; y: number; width?: number; height?: number }> }
  readonly activePage: { readonly id: string; readonly file: string | null; readonly rootNodeId: string } | null
  readonly selection: { readonly nodeId: string; readonly tag: string | null; readonly moduleId: string; readonly writableProps: string[]; readonly lockedReason: string | null } | null
  readonly fidelity: { readonly locked: number; readonly codeValued: number } | null
  readonly install: { readonly hasPackageJson: boolean; readonly hasNodeModules: boolean; readonly dependencyCount: number }
  readonly axes: StudioAgentSnapshot['axes']
  /** Set when the active page's source file changed since this conversation's last turn — see `staleness.ts`. */
  readonly staleWarning: string | null
}

export interface BuildStudioLiveDigestOptions {
  /** Test seam — defaults to the shared production tracker. */
  readonly staleness?: StalenessTracker
}

/**
 * Never throws: any resolution failure (page not found, file unreadable)
 * degrades that ONE field to its honest-absence value rather than aborting
 * the whole digest — a partial digest is still useful; a crashed prompt
 * build is not.
 */
export async function buildStudioLiveDigest(
  dir: string,
  snapshot: StudioAgentSnapshot,
  conversationId: string,
  options: BuildStudioLiveDigestOptions = {},
): Promise<StudioLiveDigest> {
  const staleness = options.staleness ?? studioSnapshotStaleness
  const { pages } = await loadStudioPages(dir)
  const pageById = new Map<string, Page>(pages.map((p) => [p.id, p]))

  const frames = snapshot.frames.map((f) => ({
    pageId: f.pageId,
    title: pageById.get(f.pageId)?.title ?? f.pageId,
    x: f.x,
    y: f.y,
    ...(f.width !== undefined ? { width: f.width } : {}),
    ...(f.height !== undefined ? { height: f.height } : {}),
  }))

  const activePage = snapshot.activePageId ? (pageById.get(snapshot.activePageId) ?? null) : null
  const activePageFile = activePage ? resolvePageFile(activePage) : null

  let selection: StudioLiveDigest['selection'] = null
  if (activePage && snapshot.selectedNodeId) {
    const node = activePage.nodes[snapshot.selectedNodeId]
    if (node) {
      const propsKeys = node.props ? Object.keys(node.props) : []
      const codeProps = new Set(node.codeProps ?? [])
      selection = {
        nodeId: snapshot.selectedNodeId,
        tag: typeof node.props?.tag === 'string' ? node.props.tag : null,
        moduleId: node.moduleId,
        writableProps: propsKeys.filter((k) => !codeProps.has(k)),
        lockedReason: node.lockReason ?? null,
      }
    }
  }

  let fidelity: StudioLiveDigest['fidelity'] = null
  if (activePage) {
    let locked = 0
    let codeValued = 0
    for (const node of Object.values(activePage.nodes)) {
      if (node.lockReason) locked += 1
      if (node.codeProps && node.codeProps.length > 0) codeValued += 1
    }
    fidelity = { locked, codeValued }
  }

  const install = probeInstallStatus(dir)

  // Node ids are relative to the PROJECT dir, same convention
  // `studio_get_node_source`'s own handler uses (`join(dir, ...loc.rel...)`)
  // — not the app root, which can differ for a monorepo project.
  let staleWarning: string | null = null
  if (activePageFile) {
    const absFile = join(dir, ...activePageFile.split('/'))
    if (staleness.checkAndRecord(conversationId, absFile)) staleWarning = STALE_NODE_IDS_WARNING
  }

  return {
    board: { activeBoardId: snapshot.activeBoardId, frames },
    activePage: activePage ? { id: activePage.id, file: activePageFile, rootNodeId: activePage.rootNodeId } : null,
    selection,
    fidelity,
    install: {
      hasPackageJson: install.hasPackageJson,
      hasNodeModules: install.hasNodeModules,
      dependencyCount: install.dependencyCount,
    },
    axes: snapshot.axes,
    staleWarning,
  }
}

/**
 * `Page.rootNodeId` is a SYNTHETIC `base.body` wrapper the page-tree
 * conversion adds (e.g. `home:body`) — it never decodes as a real source
 * location (`pageScaffold.ts`'s own `scaffoldedPageRootNodeId` reads the
 * page-PARSER's root instead for exactly this reason). The real top-level
 * JSX element is the synthetic root's first child, which DOES carry a real
 * `rel:line:col` id. Falls back to scanning every node for the first
 * decodable id (bounded — one page's nodes, never more) if the first child
 * itself is somehow also synthetic; `null` only when nothing on the page
 * decodes at all.
 */
function resolvePageFile(page: Page): string | null {
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
