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
import type { Page } from '@core/page-tree'
import { loadStudioPages } from '../../../handlers/studioPageLoad'
import { probeInstallStatus } from '../../../handlers/studio/installDeps'
import { listDesignReferences } from '../../../handlers/studio/designReferenceStore'
import { resolvePageSourceFile } from '../../../handlers/studio/pageSourceFile'
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
  /**
   * The design references registered for this project — what `studio_compare`
   * can measure against RIGHT NOW.
   *
   * Reported because the prompt states a passing `studio_compare` as the
   * definition of done, and the agent otherwise had no way to know whether
   * that was even reachable: with nothing registered, the tool answers "there
   * is no design reference registered for this project" and an agent that
   * has already written the screen reads that as permission to judge by eye.
   * Naming the armed references makes the difference between "measure it" and
   * "there is nothing to measure against" a fact in the prompt rather than a
   * discovery one failed tool call later.
   *
   * Empty when none are registered, which is itself the honest signal: no
   * design was supplied, so "does it match" genuinely has no answer.
   */
  readonly designReferences: ReadonlyArray<{
    readonly id: string
    readonly width: number
    readonly height: number
    readonly pageId?: string
    readonly label?: string
  }>
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
  const activePageFile = activePage ? resolvePageSourceFile(activePage) : null

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
    designReferences: listDesignReferences(dir, undefined, undefined).references.map((r) => ({
      id: r.id,
      width: r.width,
      height: r.height,
      ...(r.pageId ? { pageId: r.pageId } : {}),
      ...(r.label ? { label: r.label } : {}),
    })),
    staleWarning,
  }
}

