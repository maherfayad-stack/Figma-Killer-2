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
 * ## Every entry is an EXACT path. There are no namespaces.
 *
 * `sec-14` shipped this table with six `subPaths: true` namespaces (`git/`,
 * `github/`, `install/`, `deploy/`, `dev-server/`, `prototype/`), on the
 * premise that inheriting a namespace's capability is "fail-closed in the
 * direction that matters, since the namespace capability is the stricter one."
 * `sec-16` showed that premise is **false for a GET**: an undeclared sub-path
 * inherits `read`, which for all six namespaces was `site.read` — the
 * capability the **Client** role holds. A future `GET dev-server/restart` or
 * `GET deploy/run` would therefore have let a read-only reviewer spawn a dev
 * server or a build on a project already at the `run-project` tier, with no
 * table edit for anyone to review.
 *
 * `sec-18` removed the mechanism rather than pinning it. Every reachable path
 * is named here, per verb class, and nothing else resolves. The one shape an
 * exact path cannot express — a job id in the path — is declared explicitly
 * (see {@link StudioRouteDeclaration.jobId}) and matched only against the
 * UUID shape this server mints, so `deploy/run` is undeclared even though
 * `deploy/<uuid>` is served.
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
 * Three routes carry `mutate: 'site.read'`, and that is not a typo: `node-png`/
 * `node-jsx` and `reload-scope` are POSTs that compute an answer from a node
 * id set too large for a query string and write nothing. The capability
 * describes the effect, not the verb.
 *
 * One route carries the mirror image — `github/device/poll` is a GET that
 * takes `site.structure.edit`, because completing a device flow STORES a
 * GitHub credential. See its entry.
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
 * Reads are otherwise uniformly `site.read`. A Studio project's source is the
 * document, and `site.read` is the capability that means "may see the
 * document". One of those reads runs the project's own toolchain in a capped
 * subprocess once the project is off Tier 0 — see
 * `docs/reference/capabilities.md`'s "Two reads that spawn" for why the
 * boundary there is a CAPABILITY (a `studio.run.project` holder put this
 * project on that tier) and deliberately not a human consent: every project
 * starts at `run-project` by default (`DEFAULT_TRUST_TIER` — owner decision,
 * 2026-09-20), so claiming consent would be false for every project, not a
 * narrow subset of them.
 */
import type { CoreCapability } from '../../auth/capabilities'

/** Every path this table governs starts here. Nothing outside it is Studio's. */
export const STUDIO_ROUTE_PREFIX = '/admin/api/studio/'

/** What a method class needs on one path. `null` means "there is no method of this class here". */
export interface StudioRouteCapabilities {
  /** Capability a GET/HEAD/OPTIONS needs; `null` when the route has no such method. */
  read: CoreCapability | null
  /** Capability a POST/PUT/PATCH/DELETE needs; `null` when the route has no such method. */
  mutate: CoreCapability | null
}

export interface StudioRouteDeclaration extends StudioRouteCapabilities {
  /** Exact pathname. Never a prefix: `${path}/anything` does NOT resolve to this entry. */
  path: string
  /**
   * `${path}/<job-id>` is served too, with these capabilities.
   *
   * Only `install` and `deploy` have one, and only because a job id genuinely
   * sits in the path there (`GET /install/<id>`, `GET /deploy/<id>`). Both ids
   * are `crypto.randomUUID()`, so the match is against {@link JOB_ID} and
   * nothing else — a future `GET deploy/run` is an undeclared path and 404s,
   * which is the whole difference between this and the namespace it replaced.
   */
  jobId?: StudioRouteCapabilities
}

/**
 * The shape `crypto.randomUUID()` produces, which is what both job registries
 * mint (`deployJobs.ts`, `installDeps.ts`). Anchored, so a segment that merely
 * starts with a UUID is not one.
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The declarations, grouped the way the sub-routers are. Order is not
 * load-bearing — every lookup is an exact-path map hit, plus one job-id
 * fallback for the two entries that declare one.
 */
export const STUDIO_ROUTE_CAPABILITIES: readonly StudioRouteDeclaration[] = [
  // --- studio.ts's own route table -----------------------------------------
  // `load` runs the Tier-1 style compiler in a capped subprocess once the
  // project is off Tier 0, and writes two Studio-owned sidecars
  // (`recordProjectOpened`, `syncStoryBoardFrames`). The tier is the boundary
  // and only a `studio.run.project` holder can move it; see
  // `docs/reference/capabilities.md` → "Two reads that spawn".
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
  // `install` is `studio.write`, not `studio.run.project`: `installDeps.ts`
  // always passes `--ignore-scripts`, so no postinstall of the project's runs.
  { path: '/admin/api/studio/install', read: null, mutate: 'studio.write', jobId: { read: 'site.read', mutate: null } },
  { path: '/admin/api/studio/install/status', read: 'site.read', mutate: null },

  // --- editor reads + project-scoped writes --------------------------------
  { path: '/admin/api/studio/components', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/icons', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/project-assets', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/localized-page', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/live-origin', read: 'site.read', mutate: null },
  // The GET serves an already-built `.studio/cache/bundle-<hash>.js`; the
  // POST is the half that spawns `Bun.build` in a subprocess, and it is a
  // `studio.write` — `sec-16`'s note that this route spawns at `site.read`
  // was one verb off, which is exactly the kind of thing per-verb entries
  // make legible.
  { path: '/admin/api/studio/component-bundle', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/preview-axes', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/tokens', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/translations', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/stories', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/design-system/migrate', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/prototype', read: 'site.read', mutate: 'studio.write' },
  { path: '/admin/api/studio/prototype/flow', read: 'site.read', mutate: null },
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
  { path: '/admin/api/studio/dev-server/status', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/dev-server/start', read: null, mutate: 'studio.run.project' },
  { path: '/admin/api/studio/dev-server/stop', read: null, mutate: 'studio.run.project' },
  { path: '/admin/api/studio/deploy', read: null, mutate: 'studio.run.project', jobId: { read: 'site.read', mutate: null } },
  { path: '/admin/api/studio/deploy/status', read: 'site.read', mutate: null },

  // --- git history (git.ts, gitSyncRoutes.ts, gitRemoteRoutes.ts) ----------
  { path: '/admin/api/studio/git/status', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/diff', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/log', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/branch', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/commit', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/push', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/init', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/restore', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/branches', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/commit-and-switch', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/fetch', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/pull', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/conflicts', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/conflict/resolve', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/conflict/continue', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/conflict/abort', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/pull-request/context', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/pull-request', read: null, mutate: 'site.structure.edit' },
  // `readRemotes` redacts userinfo before the URLs leave the server
  // (`gitOperations.ts`), so this read cannot surface a credential a repo
  // cloned outside Studio carries in `.git/config`.
  { path: '/admin/api/studio/git/remotes', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/git/remote', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/clone', read: null, mutate: 'site.structure.edit' },
  { path: '/admin/api/studio/git/clone/status', read: 'site.read', mutate: null },

  // --- the GitHub credential behind the network verbs ----------------------
  { path: '/admin/api/studio/github/device/start', read: null, mutate: 'site.structure.edit' },
  // A GET that WRITES: on `status === 'authorized'` this calls `storeToken`
  // and persists the GitHub credential. It takes the same capability as the
  // `device/start` that must precede it, because completing the flow and
  // starting it are one decision. Declaring it `site.read` — which is what
  // the `github/` namespace handed it before `sec-18` — would have meant the
  // read-only role could finish a credential write.
  { path: '/admin/api/studio/github/device/poll', read: 'site.structure.edit', mutate: null },
  { path: '/admin/api/studio/github/token', read: null, mutate: 'site.structure.edit' },
  // Account-scoped reads of the CALLER'S OWN credential metadata — never the
  // token. A role that cannot store a credential has none to read, so these
  // answer "not signed in" for it; `site.read` keeps the Version control
  // panel openable for a reviewer instead of 403ing on panel mount.
  { path: '/admin/api/studio/github/account', read: 'site.read', mutate: null },
  { path: '/admin/api/studio/github/repos', read: 'site.read', mutate: null },
]

/** Exact-path lookup, built once. */
const EXACT: ReadonlyMap<string, StudioRouteDeclaration> = new Map(
  STUDIO_ROUTE_CAPABILITIES.map((entry) => [entry.path, entry]),
)

/** The `jobId`-declaring entries, keyed by their parent path. */
const JOB_PARENTS: ReadonlyMap<string, StudioRouteCapabilities> = new Map(
  STUDIO_ROUTE_CAPABILITIES.flatMap((entry) => (entry.jobId ? [[entry.path, entry.jobId] as const] : [])),
)

/**
 * The capabilities governing `pathname`, or `null` when the path is not a
 * declared Studio route. A `null` here is the gate's cue to answer 404 — an
 * undeclared path under `/admin/api/studio/` is not a route yet.
 */
export function resolveStudioRouteCapability(pathname: string): StudioRouteCapabilities | null {
  const exact = EXACT.get(pathname)
  if (exact) return exact

  const lastSlash = pathname.lastIndexOf('/')
  if (lastSlash <= 0) return null
  const jobId = JOB_PARENTS.get(pathname.slice(0, lastSlash))
  if (!jobId) return null
  return JOB_ID.test(pathname.slice(lastSlash + 1)) ? jobId : null
}

/**
 * The capability `method` needs on `capabilities`, or `null` when the route
 * has no method of that class. Split out so the gate and the tests agree on
 * the read/mutate boundary without re-deriving it.
 */
export function studioRouteCapabilityFor(
  capabilities: StudioRouteCapabilities,
  stateChanging: boolean,
): CoreCapability | null {
  return stateChanging ? capabilities.mutate : capabilities.read
}
