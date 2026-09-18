/**
 * The capability every `/admin/api/studio/*` route requires — declared once,
 * as data, so the gate in `routeGate.ts` can answer for a route the sub-router
 * that owns it has never been asked about.
 *
 * ## Why a table and not a `requireCapability` call per handler
 *
 * `sec-05` finding 2 (STATE.md) counted the Studio surface: of ~50 routes,
 * three called an auth helper. Every new sub-router matched the precedent of
 * its neighbours, and the precedent was "no gate". The CMS half avoided that
 * by convention plus `cms-handlers-capability-gated.test.ts`, but a convention
 * that lives in every file is a convention that drifts in every file.
 *
 * So the decision is not "remember to gate" but "a route that is not in this
 * table does not exist": `resolveStudioRouteCapability` returns `null` for an
 * undeclared path, and the gate turns that into a 404 BEFORE any sub-router
 * runs. Adding a route without adding a line here therefore produces a dead
 * route, not an open one — and `studio-routes-capability-declared.test.ts`
 * fails the build rather than waiting for someone to notice.
 *
 * ## read vs. mutate
 *
 * Each entry names two capabilities, chosen by method class rather than by
 * path: `read` answers for GET/HEAD/OPTIONS, `mutate` for POST/PUT/PATCH/
 * DELETE (`isStateChangingMethod`). `null` on either side means the route has
 * no method of that class at all — the gate answers 404, which is what the
 * sub-router would have done by falling through, only sooner and without
 * reaching the filesystem.
 *
 * Two routes carry `mutate: 'site.read'`, and that is not a typo: `node-png`/
 * `node-jsx` and `reload-scope` are POSTs that compute an answer from a node
 * id set too large for a query string and write nothing. The capability
 * describes the effect, not the verb.
 *
 * ## The four write capabilities, and why they are different
 *
 *   - `studio.write`       — edits the project's files: save, create/rename/
 *                            delete a project or page, install dependencies,
 *                            import, upload an asset, extract a component.
 *   - `studio.run.project` — makes Studio execute somebody's code, or grants
 *                            the permission to: promoting a trust tier, the
 *                            Tier-1 style-compile consent, the dev server,
 *                            a deploy. Trust promotion sits here deliberately
 *                            — handing out the right to run code is the same
 *                            decision as running it.
 *   - `site.structure.edit`— git: commit, push, clone, branch, conflict
 *                            resolution, and the GitHub credential that makes
 *                            the network verbs possible.
 *   - `site.content.edit`  — comments and share links. Collaboration about a
 *                            design, not a change to it; the Client role has
 *                            this and is meant to.
 *
 * ## Why git is NOT `studio.git.write`
 *
 * Because `studio.git.write` answers a different question. `capabilities.ts`
 * states the split in as many words: that capability exists to gate the AGENT
 * tool `studio_git_commit`, is deliberately withheld from the Admin role, and
 * "a human in the Version control panel is unaffected — that surface is gated
 * by `site.structure.edit` like every other editing panel".
 *
 * The distinction is real and worth keeping. A human clicking Commit performs
 * their own act under their own identity; an agent committing is a DELEGATION
 * of that identity, which is the thing W4-3 refused to grant by default.
 * Gating these routes on `studio.git.write` would fuse the two: every Admin
 * would lose the Version control panel, and the only way to give it back
 * would be to grant the role the capability that also hands its agent
 * `studio_git_commit` — weakening the agent gate to fix a human one.
 *
 * So the routes take the human capability, and `studio.git.write` keeps
 * meaning exactly what it meant before this table existed.
 *
 * Reads are uniformly `site.read`. A Studio project's source is the document,
 * and `site.read` is the capability that means "may see the document".
 *
 * ## Namespaces
 *
 * `subPaths: true` makes an entry answer for `${path}/<anything>` as well as
 * `${path}` itself. It is used only where the path is genuinely dynamic (a
 * deploy or install job id) or where several sub-routers share one action
 * namespace (`git/`, `github/`). The effect is that a NEW action under a
 * declared namespace inherits that namespace's capability instead of being
 * unreachable — fail-closed in the direction that matters, since the
 * namespace's capability is the stricter one.
 */
import type { CoreCapability } from '../../auth/capabilities'

/** Every path this table governs starts here. Nothing outside it is Studio's. */
export const STUDIO_ROUTE_PREFIX = '/admin/api/studio/'

export interface StudioRouteDeclaration {
  /** Exact pathname, or — with `subPaths` — the root of an owned namespace. */
  path: string
  /** Also answers for `${path}/<anything>`. Only for dynamic ids and shared action namespaces. */
  subPaths?: true
  /** Capability a GET/HEAD/OPTIONS needs; `null` when the route has no such method. */
  read: CoreCapability | null
  /** Capability a POST/PUT/PATCH/DELETE needs; `null` when the route has no such method. */
  mutate: CoreCapability | null
}

/**
 * The declarations, grouped the way the sub-routers are. Order is not
 * load-bearing — `resolveStudioRouteCapability` prefers an exact match and
 * then the longest namespace, so a more specific entry always wins.
 */
export const STUDIO_ROUTE_CAPABILITIES: readonly StudioRouteDeclaration[] = [
  // --- studio.ts's own route table -----------------------------------------
  { path: '/admin/api/studio/load', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/asset', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/download', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/save', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/boards', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/frame-defaults', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/framework', read: 'site.read', mutate: 'studio.write' },

  // --- project lifecycle (projectRoutes.ts, trashRoutes.ts) ----------------
  { path: '/admin/api/studio/projects', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/onboarding', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/thumbnail', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/create', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/rename', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/duplicate', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/delete', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/sample', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/pages-dir', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/page', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/trash', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/trash/restore', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/trash/purge', read: null, mutate: 'studio.write' },

  // --- import + install ----------------------------------------------------
  { path: '/admin/api/studio/probe', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/import-upload', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/import-github', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/import-github/status', read: 'site.read', mutate: null },
  // `install/status` and `install/<jobId>` are GETs under the same root.
  { path: '/admin/api/studio/install', subPaths: true, read: 'site.read', mutate: 'studio.write' },

  // --- editor reads + project-scoped writes --------------------------------
  { path: '/admin/api/studio/components', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/icons', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/project-assets', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/localized-page', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/live-origin', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/component-bundle', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/preview-axes', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/tokens', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/translations', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/stories', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/design-system/migrate', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/prototype', subPaths: true, read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/asset-upload', read: null, mutate: 'studio.write' },
  // `asset-drop` (D2 G15) writes caller-supplied BYTES into the user's
  // repository, so it is a write like `/delete` and `/duplicate`, not a read
  // like `/probe`. Declared here rather than checked inside the sub-router:
  // `sec-17` shipped it with an inline `originAllowed` + `requireCapability`
  // pair against a base that had no table, and the two would have been two
  // policies the moment one of them moved.
  { path: '/admin/api/studio/asset-drop', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/reference-upload', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/extract-component', read: null, mutate: 'studio.write' },
  { path: '/admin/api/studio/i18n-setup', read: null, mutate: 'studio.write' },
  // POST-shaped reads — see the module doc.
  { path: '/admin/api/studio/reload-scope', read: null, mutate: 'site.read' },
  { path: '/admin/api/studio/node-png', read: null, mutate: 'site.read' },
  { path: '/admin/api/studio/node-jsx', read: null, mutate: 'site.read' },

  // --- collaboration -------------------------------------------------------
  { path: '/admin/api/studio/comments', read: 'site.read', mutate: 'site.content.edit' },
  { path: '/admin/api/studio/shares', read: 'site.read', mutate: 'site.content.edit' },

  // --- executing the project's own code ------------------------------------
  { path: '/admin/api/studio/trust-tier', read: 'site.read', mutate: 'studio.run.project' },
  { path: '/admin/api/studio/style-compile-consent', read: 'site.read', mutate: 'studio.run.project' },
  { path: '/admin/api/studio/dev-server', subPaths: true, read: 'site.read', mutate: 'studio.run.project' },
  // `deploy/<jobId>` is a GET on a dynamic id.
  { path: '/admin/api/studio/deploy', subPaths: true, read: 'site.read', mutate: 'studio.run.project' },

  // --- git history + the credential behind it ------------------------------
  { path: '/admin/api/studio/git', subPaths: true, read: 'site.read', mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/github', subPaths: true, read: 'site.read', mutate: 'site.structure.edit' },
]

/** Exact-path lookup, built once. */
const EXACT: ReadonlyMap<string, StudioRouteDeclaration> = new Map(
  STUDIO_ROUTE_CAPABILITIES.filter((entry) => !entry.subPaths).map((entry) => [entry.path, entry]),
)

/** Namespace entries, longest path first so the most specific one wins. */
const NAMESPACES: readonly StudioRouteDeclaration[] = STUDIO_ROUTE_CAPABILITIES
  .filter((entry) => entry.subPaths === true)
  .slice()
  .sort((a, b) => b.path.length - a.path.length)

/**
 * The declaration governing `pathname`, or `null` when the path is not a
 * declared Studio route. A `null` here is the gate's cue to answer 404 — an
 * undeclared path under `/admin/api/studio/` is not a route yet.
 */
export function resolveStudioRouteCapability(pathname: string): StudioRouteDeclaration | null {
  const exact = EXACT.get(pathname)
  if (exact) return exact
  for (const entry of NAMESPACES) {
    if (pathname === entry.path || pathname.startsWith(`${entry.path}/`)) return entry
  }
  return null
}

/**
 * The capability `method` needs on `declaration`, or `null` when the route has
 * no method of that class. Split out so the gate and the tests agree on the
 * read/mutate boundary without re-deriving it.
 */
export function studioRouteCapabilityFor(
  declaration: StudioRouteDeclaration,
  stateChanging: boolean,
): CoreCapability | null {
  return stateChanging ? declaration.mutate : declaration.read
}
