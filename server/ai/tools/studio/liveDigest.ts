/**
 * The Studio-project prompt's LIVE digest (WS-12 §2.1/§2.2) — turns the
 * browser's lean `StudioAgentSnapshot` (board/selection/axes ids only) into
 * the rich, bounded facts the dynamic suffix reports: board frame titles,
 * the active page's file + root, the selected node's editable-vs-locked
 * facts, a fidelity digest, install status, a capability digest (see
 * `StudioCapabilityDigest` below), and the staleness warning.
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
 *
 * **The capability digest adds no new caching story.** Every probe it runs
 * (`probeFigmaConnectorStatus`, `probeTypecheckAvailability`) is a handful of
 * synchronous, small-file disk reads (`.studio/meta.json`, an optional
 * `.mcp.json`, an `existsSync` check) — the same cost class `probeInstallStatus`
 * already pays fresh on every turn, uncached, a few lines above it. Nothing
 * here spawns a subprocess or makes a network call.
 */
import type { Page } from '@core/page-tree'
import { loadStudioPages } from '../../../handlers/studioPageLoad'
import { probeInstallStatus } from '../../../handlers/studio/installDeps'
import { listDesignReferences } from '../../../handlers/studio/designReferenceStore'
import { resolvePageSourceFile } from '../../../handlers/studio/pageSourceFile'
import { readStudioMeta } from '../../../handlers/studio/studioMeta'
import { resolveProjectTscPath } from '../../../handlers/studio/typecheck'
import { loopbackAssetFetchEnabled } from '../../../handlers/studio/remoteAssetFetch'
import { listProjectMcpServers } from '../../drivers/projectMcpServers'
import { listRegisteredMcpServers } from '../../drivers/registeredMcpServers'
import { existsSync } from 'node:fs'
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
  /**
   * The agent's own environment limits, stated as facts — see
   * `StudioCapabilityDigest`'s own doc comment for why this exists and the
   * asymmetric rendering it drives (`buildCapabilityDigestLines` in
   * `systemPrompt.ts`).
   */
  readonly capabilities: StudioCapabilityDigest
}

/**
 * Whether a figma-named MCP server is CONFIGURED (declared + approved) for
 * this turn — never whether it will actually respond. `'unknown'` is the
 * honest degrade when the cheap, synchronous probes below throw (they are
 * documented never to, but this field still never claims a status it did not
 * actually check — see the module's "Honest" design goal).
 */
export type FigmaConnectorStatus = 'configured' | 'not-configured' | 'unknown'

/**
 * Why `studio_typecheck` would refuse or fail before even running `tsc` —
 * mirrors (never duplicates) the SAME resolution `runProjectTypecheck`
 * (`handlers/studio/typecheck.ts`) and its caller (`mcp/tools/studio/
 * typecheck.ts`) already perform: `resolveProjectTscPath` is imported and
 * called directly, not reimplemented; the `trust`/`tsconfig.json` checks
 * mirror those two files' own one-line short-circuits exactly, because
 * running the actual `tsc --noEmit` here (up to `TYPECHECK_TIMEOUT_MS`, i.e.
 * up to two minutes) on every turn would violate the "cheap" and
 * "non-blocking" goals this digest exists to uphold — this reports whether
 * the CALL would even be attempted, never whether the code currently
 * compiles.
 */
export type TypecheckAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'trust-tier' | 'no-tsconfig' | 'typescript-not-installed' | 'unknown' }

/**
 * Environment limits the agent would otherwise only discover by calling a
 * tool and reading its failure — the same argument that justified
 * `designReferences` above, generalized (WS-9 mcp-tooling task). Two
 * capabilities, both cheap, synchronous, disk-only probes (no subprocess, no
 * network call, no `tsc` invocation):
 *
 *   - `figma`: is a `figma`-named MCP server configured for this project?
 *     Checked from BOTH sources that can put one in this turn's merged
 *     `--mcp-config` (`claudeCli.ts`'s `buildMcpConfig`): a project's own
 *     approved `.mcp.json` entry (`listProjectMcpServers`,
 *     `projectMcpServers.ts`) and Studio's self-approving loopback built-in
 *     (`listRegisteredMcpServers`, `registeredMcpServers.ts` — present by
 *     default unless the project explicitly disabled it). Reachability is
 *     deliberately NOT probed: `registeredMcpServers.ts`'s own doc comment
 *     states the built-in's URL is never checked ("probing on every turn
 *     would add latency to buy a guess that is stale the moment it is
 *     made") — this field reports CONFIGURATION, not a live connection, and
 *     the prompt's wording (`systemPrompt.ts`) says so rather than promising
 *     more than was checked.
 *   - `typecheck`: would `studio_typecheck` even run, before it runs `tsc`?
 *     See `TypecheckAvailability` above.
 *
 * Deliberately excluded because the digest already reports it elsewhere
 * (never duplicated): project trust tier is on the dynamic suffix's
 * `Project: ... trust: …` line (`studioPromptContextFromProfile`), and
 * dependency-install status is `StudioLiveDigest.install` above — this
 * struct only adds derived, ACTIONABLE facts those two don't already state.
 */
export interface StudioCapabilityDigest {
  readonly figma: {
    readonly status: FigmaConnectorStatus
    /**
     * Only meaningful when `status === 'configured'`: whether
     * `studio_fetch_remote_asset`/registering a reference by URL from that
     * connector would be blocked because it resolves to a loopback address
     * (`registeredMcpServers.ts`'s built-in always does; a project-declared
     * `.mcp.json` entry might) and `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH`
     * (`remoteAssetFetch.ts`) is not set. Always `false` when `status` is
     * not `'configured'` — there is no connector to fetch assets from at
     * all in that case, which the `figma` line's own wording already covers.
     */
    readonly loopbackAssetFetchBlocked: boolean
  }
  readonly typecheck: TypecheckAvailability
}

/** `true` for a URL whose hostname resolves to loopback ONLY — used here purely to word the digest line correctly, never as a security boundary (that check lives in `remoteAssetFetch.ts`/`ssrfGuard.ts` and is unaffected by anything in this file). */
function isLoopbackUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Never throws (wrapped defensively even though every function it calls is
 * separately documented never to) — a probe failure degrades to `'unknown'`
 * rather than aborting the digest or the turn.
 */
function probeFigmaConnectorStatus(dir: string): StudioCapabilityDigest['figma'] {
  try {
    const projectDeclared = listProjectMcpServers(dir).find((s) => s.name === 'figma')
    const registered = listRegisteredMcpServers(dir).find((s) => s.name === 'figma')
    // Registered (built-in or a user override of the same name) wins on a
    // collision — the same precedence `buildMcpConfig` applies when merging
    // the two into one `--mcp-config` (project servers spread first,
    // registered servers spread after, so registered overwrites on a name
    // collision).
    const approved = registered?.approved ? registered : projectDeclared?.approved ? projectDeclared : null
    if (!approved) return { status: 'not-configured', loopbackAssetFetchBlocked: false }
    const url = 'url' in approved.definition ? approved.definition.url : null
    const loopback = url !== null && isLoopbackUrl(url)
    return { status: 'configured', loopbackAssetFetchBlocked: loopback && !loopbackAssetFetchEnabled() }
  } catch (err) {
    console.error('[ai/liveDigest] figma connector probe failed — degrading to unknown:', err)
    return { status: 'unknown', loopbackAssetFetchBlocked: false }
  }
}

/**
 * Never throws. Mirrors `runProjectTypecheck`'s own short-circuits
 * (`no-tsconfig`, `typescript-not-installed`) plus the trust-tier refusal
 * `mcp/tools/studio/typecheck.ts` applies BEFORE calling it — see
 * `TypecheckAvailability`'s doc comment for why this never actually spawns
 * `tsc`.
 */
function probeTypecheckAvailability(dir: string): TypecheckAvailability {
  try {
    const trust = readStudioMeta(dir).trust ?? 'static'
    if (trust === 'static') return { available: false, reason: 'trust-tier' }
    if (!existsSync(join(dir, 'tsconfig.json'))) return { available: false, reason: 'no-tsconfig' }
    if (!resolveProjectTscPath(dir)) return { available: false, reason: 'typescript-not-installed' }
    return { available: true }
  } catch (err) {
    console.error('[ai/liveDigest] typecheck availability probe failed — degrading to unknown:', err)
    return { available: false, reason: 'unknown' }
  }
}

/**
 * Both capability probes together — exported on its own (not just inlined
 * into `buildStudioLiveDigest`) so it is independently testable without
 * depending on `loadStudioPages` succeeding first: `buildStudioLiveDigest`
 * calls `loadStudioPages(dir)` BEFORE this, and that call resolves the
 * project's pages directory through the SAME `readStudioMeta(dir)` these
 * probes read — a fixture built to make `readStudioMeta` throw (to exercise
 * the 'unknown' degrade below) would otherwise never reach this function at
 * all under the full pipeline.
 */
export function buildStudioCapabilityDigest(dir: string): StudioCapabilityDigest {
  return {
    figma: probeFigmaConnectorStatus(dir),
    typecheck: probeTypecheckAvailability(dir),
  }
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
    capabilities: buildStudioCapabilityDigest(dir),
  }
}

