# Server
> **Purpose:** the server in depth: boot, router, handlers, auth, database, publishing, plugin runtime, the single-operator posture · **Read when:** adding or changing an HTTP route or server subsystem · **Trust:** current · **Owner:** server-engineer · **Verified:** not yet

Deep dive on the server-side of Studio — the Bun process, the router, the handlers, the auth model, the DB adapter, and how a request becomes a response.

The server is a single OS process, `server/index.ts`, that boots the DB, runs migrations, activates installed plugins, then accepts HTTP requests and dispatches them through an ordered route table on the admin `Bun.serve` listener. There are no separate service processes or message queues. CPU-heavy image variants and plugin server code run in `Bun.Worker`s owned by this process.

That same process also starts a SECOND, independent `Bun.serve` listener — the live origin (`server/liveOrigin.ts`, on `LIVE_PORT`) — which proxies `/p/<projectKey>/*` (HTTP + WebSocket) to a Tier 2 project's own dev server. It is not a sub-router of the admin listener: no shared code path, no cookies in either direction, its own CSP. See "The live origin" below.

---

## TL;DR

- **Entrypoint:** `server/index.ts` (boots DB → migrations → role sync → plugin activation → `Bun.serve`).
- **Router:** `server/router.ts` — ordered route table, first-match wins. Each route is a `tryServeX(req, runtime, url, pathname)` function returning `Response | null`.
- **Studio's own server half** lives at `server/handlers/studio/` (~120 files: parse, filesystem writeback, git, trust tiers, capture) plus a handful of top-level `server/handlers/studio*.ts` entries, matched early via `tryServeStudio` (`/studio/*`). It is separate from the inherited CMS handlers below. The MCP server endpoint (`tryServeMcp`, `/_studio/mcp`) and headless agent capture (`tryServeAgentCaptureRoute`, `/admin/agent-capture` + `/admin/api/agent-capture/*`) are also matched early, each with its own non-session auth.
- **CMS API:** every `/admin/api/cms/*` request goes through `server/handlers/cms/index.ts`, which runs a CSRF origin check and dispatches to per-resource handler groups.
- **Auth:** session cookie (`SESSION_COOKIE_NAME`) → `findUserBySessionHash` → `requireCapability(req, db, 'site.read')`. Every state-changing CMS, AI, and plugin handler starts with one of these guards. The Studio namespace gates the same way but in one place rather than per handler — see "Per-request capability gating on the Studio routes".
- **DB:** one `DbClient` interface (`server/db/client.ts`) — tagged-template callable returning `{ rows, rowCount }`. Two adapters: `postgres.ts` (via `Bun.sql`) and `sqlite.ts` (via `bun:sqlite`). Selected by `DATABASE_URL`.
- **Repositories** (`server/repositories/`) hold all SQL. Handlers never write SQL directly.
- **Plugins:** `server/plugins/runtime.ts` activates installed plugins at boot. Server entrypoints run in per-plugin Bun workers that host QuickJS-WASM (`server/plugins/pluginWorker.ts`, `server/plugins/host/workerPool.ts`, `server/plugins/quickjs/vm.ts`); module packs use `server/plugins/modulePackVm.ts` for server-side evaluation.
- **Published pages and content rows** are served by `tryServePublicRoute`, which delegates resolution + render to `server/publish/publicRouter.ts`. A warm Layer B cache entry is served before any DB work; on a miss the live render reads the published `SiteDocument` from `site_snapshots` (stored once per publish, referenced by `data_row_versions.site_snapshot_id`, memoised per publish version). Uploads + admin SPA assets are served from disk by `tryServeUpload` and `tryServeStaticAsset`.

---

## Boot sequence

```text
server/index.ts
    │
    ├─→ readServerConfig()                   ← env vars: PORT, DATABASE_URL, UPLOADS_DIR, STATIC_DIR, PUBLIC_ORIGIN, TRUSTED_PROXY_CIDRS
    │
    ├─→ createDbClient(DATABASE_URL)         ← server/db/index.ts
    │     │
    │     ├─ DATABASE_URL=sqlite:... | file:... | *.db  → createSqliteClient
    │     └─ DATABASE_URL=postgres://...  | postgresql://...  → createPostgresClient
    │
    ├─→ runMigrations(db, migrations)        ← server/db/runMigrations.ts
    │     (selects migrations-pg.ts OR migrations-sqlite.ts based on dialect)
    │
    ├─→ syncSystemRoles(db)                  ← force-resets Owner capabilities every boot
    ├─→ mediaStorageRegistry.configureLocalDisk({ uploadsDir })   ← register local-disk media adapter
    ├─→ activateInstalledServerPlugins(db, uploadsDir)            ← run plugin lifecycle: activate
    │
    └─→ Bun.serve({ fetch: req => handleServerRequest(req, runtime) })
```

Boot is sequential and fail-fast. If migrations fail, the process exits. If a plugin's `activate` throws, the host logs `[plugin:<id>]` and continues — one bad plugin doesn't bring the server down.

---

## Routing

`server/router.ts` exposes one function:

```ts
export async function handleServerRequest(req: Request, runtime: ServerRuntime): Promise<Response>
```

It walks an ordered `routes` array of `RouteHandler` functions. Each handler returns `Response` (it owns the request) or `null` (try the next handler). The first non-null wins. Unknown paths fall through to a `404`.

### The route table

```ts
const routes: readonly RouteHandler[] = [
  tryServeHealth,                  // /health
  tryServeStudio,                  // /studio/*  → server/handlers/studio/ — Studio's own
                                    //   filesystem ⇄ .tsx writeback (parse, write, git, trust
                                    //   tiers, capture; ~120 files)
  tryServeDesignImport,             // /admin/api/design-import/*  → server/handlers/designImport.ts
                                    //   (design-token import from a GitHub repo / npm package)
  tryServeMcp,                     // MCP_ENDPOINT_PATH ('/_studio/mcp') → server/ai/mcp/ —
                                    //   external MCP clients (Claude Code, Codex, remote agents),
                                    //   per-connector bearer-token auth, matched before the
                                    //   admin-cookie-gated AI routes
  tryServeAgentCaptureRoute,       // /admin/agent-capture + /admin/api/agent-capture/*
                                    //   → server/ai/mcp/capture/captureRoute.ts — headless
                                    //   browser capture, single-purpose grant auth; matched
                                    //   before tryServeAdminApp so it isn't swallowed by the SPA
  tryServeAi,                      // /admin/api/ai/*         → server/ai/handlers/
  tryServeCmsApi,                  // /admin/api/cms/*        → handlers/cms/index.ts
  tryServeLoopRuntimeAsset,        // /_studio/loop-runtime.js (fixed CMS asset)
  tryServeLoop,                    // /_studio/loop/*       → handlers/cms/loop.ts
  tryServeHoleRuntimeAsset,        // /_studio/hole-runtime.js (fixed CMS asset)
  tryServeHole,                    // /_studio/hole/*       → handlers/cms/hole.ts
  tryServeModuleJsAsset,           // /_studio/module-js/*  → handlers/cms/moduleJs.ts
  tryServePublicForm,              // /_studio/form/*       → forms/handler.ts
  tryServeSharePublicRoute,        // /share/<token> + its data sub-paths → server/handlers/studio/sharePublic.ts —
                                    //   the only unauthenticated public Studio surface; token
                                    //   checked against `.studio/shares.json` on every request
  tryServeRuntimeAsset,            // /_studio/assets/*     → published runtime assets
  tryServeRuntimePackageNamespace, // /_studio/runtime/cache/<hash>/<...> → bun install workspace
  tryServeSiteCssNamespace,        // /_studio/css/*        → hashed CSS bundles
  tryServeMediaRedirect,           // /_studio/media/<adapterId>/<path> → 302 to signed read URL
  tryServeStaticAsset,             // /assets/* → dist/ (admin app)
  tryServeUpload,                  // /uploads/* → uploadsDir (with nosniff hardening)
  tryServeAdminApp,                // /admin/* → dist/index.html (SPA fallback)
  tryServePublicRoute,             // /<slug> OR /<route-base>/<row-slug>
                                   //   → server/publish/publicRouter.ts
                                   //   resolves to page snapshot OR data row + template,
                                   //   live-renders, runs publish.html pipeline
  trySetupRedirect,                // first-run redirect → /admin/setup
  tryServeNotFoundPage,            // fall-through GET → site's 404 page (notFound
                                   //   template; baked 404.html artefact, else live
                                   //   render) with status 404; null → JSON 404
]
```

Order matters. A few examples:

- `tryServeMcp` and `tryServeAgentCaptureRoute` are matched early, before both the admin-cookie-gated CMS/AI routes and `tryServeAdminApp`, because they authenticate with their own bearer-token / capture-grant schemes rather than the admin session — the SPA fallback would otherwise answer their URLs with the ordinary admin app.
- `tryServeSharePublicRoute` sits among the other unauthenticated `/_studio/*`-adjacent namespaces, before the static-asset and public-page routes, so a share URL is never answered by a later fallback.
- `tryServeAi` is matched **before** `tryServeCmsApi` so the AI endpoints (`/admin/api/ai/*`) aren't swallowed by the broader CMS dispatcher (`/admin/api/cms/*`).
- `tryServeUpload` is matched **before** `tryServeAdminApp` because `/uploads/...` is a sub-tree the SPA fallback would otherwise consume.

Adding a new endpoint is a one-line edit to `routes` plus a focused `tryServeX` function.

### Exclusive namespaces

Several handlers own an entire prefix and 404 internally rather than falling through:

- `/_studio/runtime/cache/*` — never falls through to the public-slug renderer
- `/_studio/css/*` — never falls through
- `/_studio/media/*` — never falls through

This prevents an unknown path under a known namespace from accidentally matching a later handler.

### Cross-cutting middleware

`Bun.serve.fetch` in `server/index.ts` wraps every request with:

1. **CORS preflight** — `OPTIONS` returns 204 immediately with `corsHeaders(origin)`. ACAO is only set when the request's `Origin` is in `DEV_ORIGIN_ALLOWLIST` (production is same-origin behind Caddy, so no ACAO is needed).
2. **Socket IP stamping** — `stampSocketIp(req, ...)` writes the actual socket peer address onto the request so downstream `clientIp(req)` can ignore spoofed forwarding headers on direct requests. `X-Forwarded-For` is used only when the socket peer matches `TRUSTED_PROXY_CIDRS`; the chain is walked from right to left and the nearest untrusted IP becomes the client IP.
3. **Top-level error catch** — any error that escapes `handleServerRequest` is logged with `console.error('[server] Unhandled request error:', err)` and responded to with a generic `500 Internal server error`. The raw error message is **never** echoed to the client (it can leak SQL fragments, absolute paths, etc.).

`idleTimeout: 0` is set explicitly: the agent endpoint streams NDJSON over Claude's thinking gaps, which can easily exceed Bun's 10s default.

---

## CMS handlers

`/admin/api/cms/*` is handled by `server/handlers/cms/index.ts`. The flow:

1. **CSRF defense in depth.** State-changing methods (`POST/PUT/PATCH/DELETE`) must come from an `Origin` matching a configured public origin (`PUBLIC_ORIGIN`, auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN`), or a dev allowlist entry. With nothing configured the check falls back to the inbound `Host` header. Forwarded headers (`X-Forwarded-Host` / `X-Forwarded-Proto`) are never consulted, so `TRUSTED_PROXY_CIDRS` has no bearing on CSRF. `SameSite=Lax` already covers most CSRF; this catches the same-site-different-subdomain edge.

2. **Group dispatch.** The handler walks an ordered chain of route-group handlers, each owning a resource:

```ts
const response =
  (await handleSetupRoutes(req, db))
  ?? (await handleAuthRoutes(req, db))
  ?? (await handleMeRoutes(req, db, options))
  ?? (await handleUserPreferencesRoutes(req, db))
  ?? (await handleUsersRoutes(req, db))
  ?? (await handleRolesRoutes(req, db))
  ?? (await handleAuditRoutes(req, db))
  ?? (await handleSiteRoutes(req, db))
  ?? (await handlePagesRoutes(req, db))
  ?? (await handleComponentsRoutes(req, db))
  ?? (await handleRuntimeRoutes(req, db))
  ?? (await handleMediaFolderRoutes(req, db))           // before /media/:id
  ?? (await handleMediaStorageAdminRoutes(req, db, …))  // before /media/:id
  ?? (await handleMediaRoutes(req, db, …))
  ?? (await handlePluginsRoutes(req, db, …))
  ?? (await handleDataRoutes(req, db))
  ?? (await handleDashboardRoutes(req, db))
  ?? (await handleFontsRoutes(req, db, …))
  ?? (await handlePublishRoutes(req, db))
  ?? (await handleExportRoute(req, db, options))
  ?? (await handleImportPreviewRoute(req, db))          // before /import (longer path)
  ?? (await handleImportRoute(req, db, options))
```

Each group module owns its URL matching and returns `Response | null`. The first non-null wins. Order matters — handler order comments in `index.ts` document the load-bearing precedence (e.g. media folder/storage routes must run before `/media/:id` because that pattern would otherwise eat them).

### Route dispatch — `routeTable.ts`

Every handler group uses the shared `runRouteTable` dispatcher from `server/handlers/cms/routeTable.ts` rather than hand-rolling its own `(method, path)` matching. Each group declares a flat `Route[]` table and hands it to `runRouteTable`:

```ts
const PAGES_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/pages`, handler: handleListPages },
  { method: 'PUT', pattern: `${CMS_API_PREFIX}/pages`, handler: handleUpdatePages },
]

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, PAGES_ROUTES)
}
```

`runRouteTable` implements the one correct 404-vs-405 rule in a single place:

- Path matches some route, but no route has the right method → **405 Method Not Allowed**
- No route's pattern matches the path → **`null`**, so the CMS entry point tries the next group and ultimately 404s.

Parameterised routes use a `RegExp` with **named capture groups** (`(?<id>[^/]+)`). The dispatcher decodes each captured value once via `decodeURIComponent`, so handlers receive already-decoded params and never call `decodeURIComponent` themselves.

Handler groups that need per-request context beyond `(req, db)` (e.g. `CmsHandlerOptions`) pass it as a variadic `...extra` argument through both the route table and the individual handlers:

```ts
// Handler signature — three fixed args, then the typed extra
async function handleInstallFont(
  req: Request,
  db: DbClient,
  _params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> { … }

// Route table — typed with the extra tuple
const FONTS_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'POST', pattern: `${CMS_API_PREFIX}/fonts/install`, handler: handleInstallFont },
]

export async function handleFontsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  return runRouteTable(req, db, FONTS_ROUTES, options)
}
```

### Handler shape

Every per-route handler in `server/handlers/cms/` follows the same skeleton:

```ts
async function handleListPages(req: Request, db: DbClient, _params: RouteParams): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user      // 401 / 403 — return early

  const rows = await listDataRows(db, 'pages')
  return jsonResponse({ rows })
}

async function handleUpdatePages(
  req: Request,
  db: DbClient,
  _params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'site.structure.edit')
  if (user instanceof Response) return user

  const BodySchema = Type.Object({ pages: Type.Array(Type.Unknown()), /* … */ })
  const body = await readValidatedBody(req, BodySchema)
  if (!body) return badRequest('Invalid request body')
  // … mutate via repository, return jsonResponse(…)
}
```

Conventions:

- **Require capability first**, return early on auth failure.
- **Validate body second** via TypeBox.
- **Talk to repositories third.** Handlers don't write SQL.
- **Return `jsonResponse({ … })` or an error envelope last.**
- Path matching and 404/405 discrimination are handled entirely by `runRouteTable` — individual handlers never check `req.method` or `url.pathname`.

---

## HTTP helpers

`server/http.ts` owns the small set of cross-handler helpers:

| Helper                           | Purpose                                                              |
|----------------------------------|----------------------------------------------------------------------|
| `jsonResponse(body, init?)`      | Returns a `Response` with `content-type: application/json`           |
| `readValidatedBody(req, schema)` | Parses the request body and validates it against a TypeBox schema. Returns the typed value on success, `null` on JSON parse failure or schema mismatch. Callers return `badRequest(msg)` on null. |
| `methodNotAllowed()`             | `405` with `{ error: 'Method not allowed' }`                         |
| `badRequest(message)`            | `400` with `{ error: message }`                                      |
| `setCookieHeader(res, value)`    | Appends a `Set-Cookie` header                                        |

`readValidatedBody` is the canonical body parser: it parses JSON and validates the shape against a TypeBox schema in one step, so handlers receive a fully typed value or return `badRequest` immediately.

### Binary helpers (`server/binary.ts`)

`server/binary.ts` provides two helpers for safely handing `Uint8Array` bytes to `Response` bodies and worker `postMessage` transfers:

| Helper                             | Purpose                                                              |
|------------------------------------|----------------------------------------------------------------------|
| `toArrayBuffer(bytes: Uint8Array)` | Copies the view's logical range into a fresh, exactly-sized `ArrayBuffer`. Required because a `Uint8Array` is only a view — its `.buffer` may be larger (pooled or sliced backing store) and resolves to `ArrayBuffer \| SharedArrayBuffer` which transfer/body slots reject. |
| `binaryResponse(bytes, init?)`     | Convenience wrapper: calls `toArrayBuffer` then wraps the result in a `new Response(...)`. Use for every "serve raw bytes" response in route handlers. |

Use `binaryResponse` whenever a route handler returns binary content (runtime assets, CSS bundles, images). Use `toArrayBuffer` when bytes must cross a worker `postMessage` boundary as a transferable.

**Error envelope.** Every CMS handler error returns `{ error: string }` and is validated client-side by `ErrorEnvelopeSchema` in `src/core/http/apiClient.ts` (re-exported from `responseSchemas.ts`). The canonical client `apiRequest` (and `readEnvelope`) extract the message via `responseErrorMessage(res, fallback)` and throw an `ApiError` carrying the HTTP status.

---

## Auth and capabilities

`server/auth/` owns the entire authentication surface.

| File              | Owns                                                                       |
|-------------------|----------------------------------------------------------------------------|
| `tokens.ts`       | Session cookie name, token hashing                                         |
| `sessions.ts`     | Session lookup, MFA gate, step-up timer                                    |
| `authz.ts`        | `requireAuthenticatedUser`, `requireCapability`, `requireAnyCapability`    |
| `capabilities.ts` | `CoreCapability` enum and per-capability membership rules                  |
| `lockout.ts`      | Failed-login lockout policy                                                |
| `mfa.ts`          | TOTP enrollment, verification                                              |
| `rateLimit.ts`    | Token-bucket rate limiters                                                 |
| `security.ts`     | `isStateChangingMethod`, `originAllowed`, `configurePublicOrigins`, `DEV_ORIGIN_ALLOWLIST`, IP stamp |
| `deviceLabel.ts`  | Device-fingerprint label for the sessions panel                            |

### The session flow

```text
Cookie: studio_admin_session=<token>
    │
    ▼
hashSessionToken(token)
    │
    ▼
findUserBySessionHash(db, hash)
    │
    ├─→ no row              → 401 Unauthorized
    ├─→ row but MFA needed  → 401 { error: 'mfa_required' }
    └─→ row OK              → AuthUser { id, email, capabilities, ... }
```

`findUserBySessionHash` hydrates the `AuthUser` with a single `from sessions …
join users …` SELECT (the column list lives once in `USER_JOINED_COLUMNS`,
shared with the `users` repository). It then touches `sessions.last_seen_at`,
but that write is **debounced** to at most once per session per ~30s via an
in-memory tracker — the idle timeout is 30 days, so up-to-30s staleness is
irrelevant, and the hot per-request write (WAL-serialized on SQLite, a hot-row
lock on Postgres) is gone.

**Resolve the session once per request.** A handler calls exactly one of
`requireAuthenticatedUser` / `requireCapability` / `requireAnyCapability` to get
its `AuthUser`, then reuses that value for any further checks. Additional
capability checks in the same handler use the pure `userHasCapability(user, …)`
predicate rather than calling another guard, and the step-up gate takes the
already-resolved user (see below). No handler should hydrate the session twice.

### The capability gate

```ts
const user = await requireCapability(req, db, 'site.read')
if (user instanceof Response) return user   // 401 or 403 already encoded
// ... user is now AuthUser
```

`requireCapability` and `requireAnyCapability` are the only auth surfaces a handler should call. Capabilities are strings like `site.read`, `site.structure.edit`, `media.write`, `plugins.install`, `users.manage`, etc. Owner accounts get all `CORE_CAPABILITIES` automatically. The full list is in `src/core/capabilities.ts` (`@core/capabilities`); `docs/reference/capabilities.md` catalogs every one.

### Step-up auth

Sensitive actions (delete user, revoke another device, sign out all devices) gate on `requireStepUp(req, db, user, options?)`. It takes the **already-resolved `AuthUser`** — it does NOT re-authenticate — and returns `Response | null`: a 401 `{ error: 'step_up_required' }` when the window is stale, or `null` to proceed. The canonical pattern is therefore:

```ts
const user = await requireCapability(req, db, 'users.manage')
if (user instanceof Response) return user
const stepUp = await requireStepUp(req, db, user)
if (stepUp) return stepUp
// ... re-authenticated, proceed with `user`
```

This is what keeps a capability-gated sensitive write to one session lookup: the capability guard hydrates the session once, and `requireStepUp` only reads `step_up_expires_at` for that session. (Handlers with no preceding capability guard — e.g. the `/me/*` security routes — call `requireAuthenticatedUser` first to obtain `user`.)

Step-up is required by default with a 15-minute window, can be configured per user from Account -> Security, and can be disabled per user. The expiry lives on the session row as `step_up_expires_at` and is refreshed by `POST /admin/api/cms/auth/step-up`.

### Per-request capability gating on the Studio routes

**Every `/admin/api/studio/*` request passes one gate before any sub-router sees it.** That gate is `gateStudioRequest` in `server/handlers/studio/routeGate.ts`, called as the first statement of `tryServeStudio`. It answers four questions, in this order:

1. **Is this a Studio path?** No → `null`, and the router continues down its table exactly as before.
2. **Is the route declared?** `server/handlers/studio/routeCapabilities.ts` is the only place a Studio route exists. An undeclared path under `/admin/api/studio/` answers **404** here — before a sub-router runs, before `resolveProjectDir` touches the filesystem.
3. **CSRF.** A state-changing method must carry an acceptable `Origin` (`originAllowed`), the same check `handleCmsRequest` and the AI dispatcher run. It runs **before** the session lookup, so a forged cross-origin POST costs a header comparison rather than a database round trip.
4. **Capability.** `requireCapability` with the capability the declaration names for this method class.

The `AuthUser` the gate resolves is handed to `STUDIO_SESSION_SUB_ROUTERS` in `StudioSessionRuntime`. **No Studio sub-router calls an auth helper of its own** — one policy, one place. A second `requireCapability` inside a handler is a second policy, and two policies drift.

`tryServeStudio` also ends in a 404 rather than `null`: the gate has already proved the path is a declared Studio route, so falling through means no sub-router claimed that exact (path, method) pair, and letting an API path continue down the router table ends at `tryServeAdminApp` handing an API caller the admin SPA's HTML.

#### The capability table

`STUDIO_ROUTE_CAPABILITIES` declares two capabilities per route, chosen by method class rather than by path: `read` answers for GET/HEAD/OPTIONS, `mutate` for POST/PUT/PATCH/DELETE. `null` on either side means the route has no method of that class — the gate answers 404, which is what the sub-router would have done by falling through, only sooner.

| Capability | Routes | Why |
|---|---|---|
| `site.read` | every read; plus `reload-scope` and the two `node-{png,jsx}` exports, which are POST-shaped reads | A Studio project's source is the document, and `site.read` means "may see the document" |
| `studio.write` | `save`, `boards`, `framework`, `frame-defaults`, project create/rename/duplicate/delete/sample, `page`, `pages-dir`, trash restore/purge, `install`, both imports, the uploads, `extract-component`, `i18n-setup`, `translations`, `tokens`, `stories`, `prototype`, `design-system/migrate`, `preview-axes`, `component-bundle` | Changes the project's files |
| `studio.run.project` | `dev-server/{start,stop}`, `deploy` (the POST that starts one), `trust-tier`, `style-compile-consent` | Makes Studio execute somebody's code — or hands out the right to. Trust promotion sits here deliberately |
| `site.structure.edit` | every mutating `git/<action>`, plus `github/device/start`, `github/token`, and the GET `github/device/poll` | Rewriting the repository's history, and the GitHub credential the network verbs need |
| `site.content.edit` | `comments`, `shares` | Collaboration about a design rather than a change to it — the **Client** role holds this and is meant to |

##### Every entry is an exact path

There are no namespace entries. `sec-14` shipped six (`git/`, `github/`, `install/`, `deploy/`, `dev-server/`, `prototype/`) on the premise that inheriting a namespace's capability fails closed, since the namespace's capability is the stricter one. `sec-16` showed that is **false for a GET**: an undeclared sub-path inherited `read`, which for all six was `site.read` — the capability the **Client** role holds. A future `GET dev-server/restart` or `GET deploy/run` would have let a read-only reviewer spawn a dev server or a build on a project already at the `run-project` tier, with no table edit for anyone to review. `sec-18` removed the mechanism: every reachable path is named, per verb class, and `/admin/api/studio/git/brand-new-verb` now 404s.

The one shape an exact path cannot express is a job id, and it is declared explicitly. `jobId: { read, mutate }` on the `install` and `deploy` entries answers for `${path}/<id>` — matched **only** against the `crypto.randomUUID()` shape both registries mint, so `deploy/<uuid>` resolves and `deploy/run` does not.

##### Two reads that spawn, and one GET that writes

- `GET /admin/api/studio/load` runs the project's own style toolchain in a capped subprocess at Tier 1 (`styleCompileTier1.ts`), and writes two Studio-owned sidecars (`recordProjectOpened`, `syncStoryBoardFrames`). The boundary is a capability — a `studio.run.project` holder made this operator able to run project code at all — and **not** a human consent, because every project starts off Tier 0 by default (`DEFAULT_TRUST_TIER`, owner decision 2026-09-20). See `docs/reference/capabilities.md` → "Two reads that spawn" for the full reasoning and what it deliberately does not claim.
- `GET /admin/api/studio/component-bundle` does **not** spawn: it serves an already-built `.studio/cache/bundle-<hash>.js`. The `Bun.build` subprocess is on the **POST**, which is `studio.write`. (`sec-16` recorded this route as spawning at `site.read`; per-verb entries showed it was one verb off.)
- `GET /admin/api/studio/github/device/poll` **writes a credential** — on `status === 'authorized'` it calls `storeToken`. It therefore declares `read: 'site.structure.edit'`, the same capability as the `device/start` that must precede it. Under the old `github/` namespace it took `site.read`.

**Git is deliberately not gated on `studio.git.write`.** That capability gates the AGENT tool `studio_git_commit` and is withheld from the Admin role on purpose (see `docs/reference/capabilities.md`): a human clicking Commit performs their own act, while an agent committing is a *delegation* of that identity. Gating these routes on it would fuse the two — every Admin would lose the Version control panel, and the only way to give it back would be to grant the role the capability that also hands its agent commit rights.

#### Adding a route

Add the line to `STUDIO_ROUTE_CAPABILITIES`. There is nothing else to remember, and forgetting is not silent:

- at runtime, an undeclared path 404s — the route is dead, not open;
- at build time, `src/__tests__/architecture/studio-routes-capability-declared.test.ts` fails, naming the path and the dispatch site. It scans route MATCHES, not just path literals — `pathname === '<literal>'`, `pathname === CONST`, `` pathname === `${CONST}/suffix` ``, `action === '<literal>'` against the file's own prefix constant, and the job-id `` pathname.startsWith(`${CONST}/`) `` — because `gitSyncRoutes.ts` dispatches on `action === 'conflict/resolve'` and no `/admin/api/studio/…` literal for that path exists anywhere. It also fails on a declaration no handler serves, on a `jobId` marker with no matching dispatch, and on a **method class** the tree dispatches on that the table declares `null`.

`server/handlers/__tests__/studioRouteGate.test.ts` then walks the real table and asserts, for every declared route, that an unauthenticated caller gets 401, an under-privileged session gets 403 `{ error: 'Forbidden' }`, and a cross-origin `text/plain` form POST gets 403 `{ error: 'Forbidden: invalid origin' }`. A new route is covered the moment its declaration lands.

#### The posture is still single-operator

Closing `sec-05` finding 2 was not the addition of a login flow. The **Owner** role holds every capability in the table — asserted by a test — so a default installation behaves exactly as it did. What changed is that an unauthenticated request no longer reaches the filesystem, and a cross-origin form POST no longer reaches a Studio write.

Two things still protect a route below the gate, and both still matter:

| Protection | Where | What it stops |
|---|---|---|
| Path containment | `resolveProjectDir` → `isRealpathContainedAllowingMissing` (`server/handlers/studioProjects.ts`); `ProjectDirOutsideWorkspaceError` becomes one 404 in the router's top-level catch (`server/router.ts`) | Reading or writing any path outside `studio-workspace/` |
| Trust tier | `requireTrustTier` (`server/handlers/studio/trustGate.ts`), called by `deploy.ts` and `devServer.ts`; `checkTrustTier` is its transport-free half, used by `deploy.ts`'s status route and by `studio_render_reference` | Running the user's project below `trust === 'run-project'` — a 409, not a 401. The capability answers "may this operator run project code"; the tier answers "may THIS project be run". Neither is sufficient alone |

**The trust tier is read off the PROJECT directory, always.** `.studio/` is a
project-directory sidecar — it is created where `resolveProjectDir` lands, it
is in `EXCLUDED_WORKSPACE_DIR_NAMES`, and all ~60 `readStudioMeta` call sites
key on it. A monorepo import whose real `package.json` sits at
`<project>/apps/web` has `resolveAppRoot(dir) !== dir`, and
`<project>/apps/web/.studio/meta.json` does not exist — so a gate keyed on the
app root answers Tier 0 forever and the project can never be deployed. That was
a live defect in `deploy.ts` (`sec-12`), fixed by giving `checkTrustTier` /
`requireTrustTier` a `projectDir` parameter and moving `deployJobs.ts`'s
`lastDeploy` record back to the project directory. The app root remains correct
for everything that touches the project's **code** — the install cwd,
`node_modules`, `vercel.json`/`netlify.toml` detection, the provider CLI's
working directory — and is never correct for Studio's own sidecar.

One related weakness is **not** closed by this work: `studio_render_reference` (`server/ai/mcp/tools/studio/referenceRender.ts`) reaches the dev server through the MCP tool surface, which has its own connector-capability model rather than this gate.

---

## Repositories

All SQL lives in `server/repositories/`. Each file owns one resource:

| File                       | Owns                                              |
|----------------------------|---------------------------------------------------|
| `audit.ts`                 | Audit log writes and queries                      |
| `data/`                    | `data_tables` + `data_rows` (the universal store) |
| `fonts.ts`                 | Font assets                                       |
| `loginAttempts.ts`         | Failed-login records for lockout                  |
| `media.ts`                 | Media assets                                      |
| `mediaFolders.ts`          | Folder tree for media                             |
| `mediaMigration.ts`        | Migration of media between storage adapters      |
| `mediaStorageAdapters.ts`  | Registered storage backends                       |
| `pluginSchedules.ts`       | Plugin-registered scheduled jobs                  |
| `plugins.ts`               | Installed plugins + lifecycle state               |
| `publish.ts`               | Published-page roster: snapshot getters + the transactional publish write (orchestration lives in `server/publish/publishSite.ts`) |
| `roles.ts`                 | System and custom roles                           |
| `runtimeAsset.ts`          | Published runtime assets (JS, CSS, fonts)         |
| `sessions.ts`              | User sessions                                     |
| `setup.ts`                 | Setup wizard state (`isSetup`, first-run owner)   |
| `site.ts`                  | The single site shell row                         |
| `syncSequence.ts`          | Site-global sync sequence counter (multi-admin sync substrate — stamped on every row the site-document save writes or deletes) |
| `userPreferences.ts`       | Per-user editor preferences                       |
| `users.ts`                 | Users + auth fields                               |

### Repository rules

1. **Repositories are dialect-naive.** They use ANSI-standard SQL only. The five Postgres-isms (`now()` in DML, `::int`, `::jsonb`, `any($N::...)`, `distinct on`) are banned in any file that imports `DbClient`. Gated by `db-postgres-isms.test.ts`.

2. **JSON columns end in `_json`.** The SQLite adapter auto-parses `*_json` strings on read and auto-stringifies plain objects on write — so repository code does the same `${jsObject}` interpolation regardless of dialect. Gated by `db-json-column-naming.test.ts`. See [docs/reference/database-dialects.md](reference/database-dialects.md).

3. **Repositories return typed rows.** Use `Row` generics on `db<Row>` calls so handlers don't `as Foo` results.

4. **Repositories validate persisted JSON.** Anything read from a `*_json` column passes through a TypeBox schema (e.g. `validateSite` for the site shell). The DB is not a trusted source — a previous migration or external tool may have written garbage.

5. **Transactions.** `db.transaction(async (tx) => { ... })` wraps a callback in a transaction. The callback receives a `DbClient` that scopes its queries to the transaction. Use it whenever a single request mutates multiple rows that must be consistent (e.g. batch upsert of pages).

---

## The `DbClient` interface

`server/db/client.ts`:

```ts
export type Dialect = 'postgres' | 'sqlite'

export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>
  unsafe<Row>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  readonly dialect: Dialect
}

export interface DbResult<Row> {
  rows: Row[]
  rowCount: number
}
```

`DbClient` is callable as a tagged template:

```ts
const { rows } = await db<{ id: string }>`select id from users where email = ${email}`
```

Interpolations are bound as parameters in both dialects (`$1, $2, …` on PG; `?` on SQLite). The SQLite adapter additionally converts plain objects and arrays to JSON strings at bind time, so:

```ts
await db`insert into site (id, settings_json) values (${id}, ${settings})`
//                                                             ▲
//                                            JS object becomes JSON in SQLite, JSONB in PG
```

Same code, both engines.

### The two adapters

- **`server/db/postgres.ts`** wraps `Bun.sql` (native Bun Postgres client). `rowCount` is read from `result.count` (Bun's CommandComplete affected-row count) rather than `result.length`, which is always 0 for non-RETURNING writes.
- **`server/db/sqlite.ts`** wraps `bun:sqlite`, with four custom behaviors:
  1. `toBindable(value)` converts JS values (objects, dates, booleans, `Uint8Array`) to SQLite-bindable types.
  2. On read, any column ending in `_json` whose value is a non-empty string is auto-`JSON.parse`d.
  3. On boot, PRAGMAs are set: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, `busy_timeout = 5000`.
  4. Transaction serialization: concurrent `db.transaction()` calls are queued via a promise chain so `BEGIN` is never issued while another transaction is open on the single shared connection. This prevents "cannot start a transaction within a transaction" errors when transaction callbacks `await` async work.

Both adapters return the same `DbResult<Row>` shape, so callers never branch on dialect.

### Migrations

`server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` hold the per-dialect migration list. Each migration is `{ id, label, statements: string[] }`. The two lists must have **identical IDs in the same order** — gated by `migration-parity.test.ts`. The PG version uses `jsonb`, `timestamptz`, `bigint`, `boolean`, `distinct on`; the SQLite version uses `text`, `text`, `integer`, `integer`, and window-function rewrites.

`server/db/runMigrations.ts` runs the migrations idempotently at boot, tracking applied IDs in a `_migrations` table.

See [docs/reference/database-dialects.md](reference/database-dialects.md) for the full rules.

### HA leader election

`server/db/advisoryLock.ts` owns the shared Postgres advisory-lock primitive used by every recurring tick loop:

```ts
await withSchedulerLeaderLock(db, LOCK_KEY, '[my-scheduler]', async () => {
  // Only one instance runs this body per tick.
})
```

`withSchedulerLeaderLock` issues `pg_try_advisory_lock(lockKey)` — returning the lock immediately or not at all. If this instance wins, it runs `fn` and releases the lock in a `finally` block. If another instance holds the lock, it returns `undefined` and the body is skipped.

Each tick loop passes its own distinct `lockKey` so the plugin scheduler and the publish scheduler don't contend with each other. On SQLite (single-instance by definition) the module catches the "no such function" error and returns a no-op sentinel — the body always runs.

The lock is **released between ticks**, so a crashed leader hands off naturally at the next interval. Tested by `server/db/__tests__/advisoryLock.test.ts` (unit, with a fake DbClient) and `server/__tests__/schedulers-advisory-lock.test.ts` (integration, against a real SQLite client).

---

## Publishing pipeline

Three-layer model: **static-by-default, dynamic-by-auto-detection**.

- **Layer A — static-to-disk.** **Every** page is baked at publish time. A fully-static page (no dynamic modules, no request-dependent bindings/loop sources, no VC refs to dynamic VCs) bakes a complete document; a page with dynamic nodes bakes its static **shell** with `<studio-hole>` placeholders (the dynamic nodes are Layer C holes). HTML is written to `uploads/published/current/<route>.html`, and the CSS bundles (`/_studio/css/…`) and runtime JS (`/_studio/assets/…`) are baked into the same slot. The visitor router reads all of these directly off disk (`readArtefact` / `readStaticAsset`) — **a published page never touches the DB for HTML, CSS, or JS.** TTFB ≤ 1.5 ms.
- **Layer B — in-memory LRU.** Requests with real loop-pagination query params (`loop_<nodeId>_page`) bypass the disk fast-path and render live, memoised by `(urlPath, canonicalQuery)`. Junk params collapse to the empty canonical query and still hit Layer A. Single-flight. Every publish bumps `publishVersion` so the entire cache evicts lazily. The version is captured at render start — if a publish lands before the factory resolves, the result is returned to the caller but not stored; the next request re-renders against the fresh snapshot.
- **Layer C — server islands ("holes").** When `findDynamicNodeIds(...)` classifies a node as dynamic (module flagged `dynamic: true`, or its bindings/loop source declare `requestDependent: true` / `perVisitor: true`, or it's a VC ref to a dynamic VC), the publisher emits a `<studio-hole>` placeholder with an optional `staticPlaceholder(props)` skeleton. A ~1.1 KB `IntersectionObserver` runtime fetches `/_studio/hole/<nodeId>?v=<publishVersion>&u=<page-url>` lazily as the placeholder enters the viewport, forwarding the originating page path/query into the fragment render. **The hole fragment is the only request that reads the DB for an otherwise-static page.** Shared hole responses are cached via Layer B's LRU; per-visitor holes bypass it with `Cache-Control: no-store`.

Authors don't toggle anything. `src/core/publisher/dynamicDetection.ts:findDynamicNodeIds` is backed by the single walker that powers Layer A's shell-vs-complete bake and Layer C's placeholder emission. The rules live in exactly one file.

```text
                            on publish
                                ↓
            publishDraftSite / publishDataRow
                                │
              ├── write SiteDocument once → site_snapshots
              │     (page versions reference it via site_snapshot_id)
              ├── for each page (complete doc, or static shell with <studio-hole>):
              │     publishPage + applyPublishedHtmlPipeline
              │     writeArtefact(inactiveSlot, urlPath, html)
              ├── bake every published data-row route into the same slot
              │     (bakeDataRows.ts — entry-template render, same pipeline)
              ├── bake CSS bundles + runtime JS → writeStaticAsset(inactiveSlot)
              ├── swapSlot — atomic symlink rename of uploads/published/current
              └── bumpPublishVersion() — Layer B cache evicts lazily

                          on visitor request
                                ↓
            server/router.ts → tryServePublicRoute
                                ↓
                  renderPublicResolution(db, url, uploadsDir)
                                │
       ┌────────────────────────┼────────────────────────────┐
       ▼                        ▼                            ▼
  Layer A disk           resolvePublicRoute             (page contains holes)
  readArtefact            page / row / redirect          /_studio/hole/<id>?v=<ver>&u=<url>
  (only if no ?           / not-found                    handled by
  query string)                  │                       server/handlers/cms/hole.ts
       │                  ┌──────┴───────┐                     │
   hit → stream    redirect → 301  page/row → Layer B          ▼
                                          getOrRender         render one node
                                          (LRU + single-      cached in Layer B
                                           flight + version)
```

Server-side publishing helpers live in `server/publish/`:

| File                              | Role                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `publicRouter.ts`                 | Visitor URL → resolution → Response. Composes Layer A disk-read + Layer B cache. Single entry for every visitor HTML request. |
| `staticArtefact.ts`               | Layer A. Two-slot symlink swap (`current → slot-{a,b}`), atomic per-file `tmp + rename`, slot-aware read/write/purge. |
| `renderCache.ts`                  | Layer B. Bounded LRU keyed by `(urlPath, canonicalQuery)`, entries versioned. Single-flight on cache miss. `bumpPublishVersion()` invalidates lazily; version captured at render start so mid-flight publishes discard without caching stale HTML. |
| `holeRuntime.ts`                  | Layer C client-side runtime (~1.1 KB). Exports `runStudioHoleRuntime` (TS source) and `HOLE_RUNTIME_JS` (IIFE-serialized for browser delivery). |
| `publishSite.ts`                  | Full-site publish orchestrator (`publishDraftSite`): phase-1 builds, the short `persistSitePublish` transaction, Layer A bake + slot swap, Layer B bump. |
| `publishRow.ts`                   | Per-row publish orchestrator (`publishDataRow`) + `removeDataRowArtefact`: persist via the data repository, in-place artefact update, Layer B bump. |
| `publicRenderer.ts`               | `renderPublishedSnapshot`, `renderPublishedDataRowTemplate` — snapshot-aware wrappers around `publishPage`. |
| `publishedHtmlPipeline.ts`        | Plugin frontend-asset injection + `publish.html` filter chain. Runs at publish time for every baked page (complete doc or hole shell); also runs in the Layer B factory for query-string / live renders (cached). |
| `siteCssBundle.ts`                | Per-site reset / framework / style CSS bundles (hashed filenames).  |
| `republish.ts`                    | Bulk re-publish (after a settings change touches all pages).        |
| `publishScheduler.ts`             | Scheduled publish jobs.                                             |
| `frontendInjections.ts`           | Plugin-contributed frontend scripts injected into published HTML.   |
| `mediaPresentation.ts`            | `<picture>` / `<img srcset>` materialization at publish time.       |
| `mediaPrefetch.ts`, `loopPrefetch.ts` | Pre-warm caches needed by published pages.                      |
| `runtime/packageServer.ts`        | Serve per-site `bun install` workspace under `/_studio/runtime/cache/`. |

Plus the hole endpoint at `server/handlers/cms/hole.ts` — registered in the router BEFORE `tryServePublicRoute` so `/_studio/hole/*` requests never fall through to slug resolution.

Published pages are HTML plus up to four hashed CSS bundles (`reset`, `framework`, `style`, `userStyles`). The ONLY first-party client script for ordinary static pages is the Layer C hole runtime, and it's injected ONLY on pages that contain at least one `<studio-hole>`. Fully-static pages ship zero first-party JS from us. Plugins and modules can inject explicit frontend assets through the documented runtime channels.

For the full design including invariants, atomic-publish protocol, and the auto-detection rules, see [docs/features/publisher.md](features/publisher.md).

---

## Plugin runtime

Plugins ship as zip packages with a `plugin.json` manifest. The host:

1. **Installs** the package (unzips into `uploads/plugins/<id>/<version>/`) — `server/plugins/package.ts`.
2. **Validates** the manifest and scans the bundled JS for forbidden sandbox-incompatible patterns — `assertSandboxSafe` in `package.ts` + `parsePluginManifest` in `src/core/plugins/manifest.ts`.
3. **Activates** the plugin at boot or on user action — `server/plugins/runtime.ts`. Activation asks the per-plugin worker pool (`server/plugins/host/workerPool.ts`) to load the server entrypoint into a QuickJS-WASM VM (`server/plugins/pluginWorker.ts`, `server/plugins/quickjs/vm.ts`) and runs its `activate(api)` lifecycle hook.
4. **Routes** plugin-registered HTTP routes through `/admin/api/cms/plugins/<id>/runtime/…` (handled by `handleRuntimeRoutes`).
5. **Brokers** the SDK boundary — `api.cms.routes.*`, `api.cms.storage.*`, `api.cms.hooks.*`, `api.cms.loops.*`, `api.cms.settings.*`, `api.cms.schedule.*`. The SDK shape is defined in `src/core/plugin-sdk/`.

The sandbox has **no host access** — no Node, no Bun, no file system, no env vars, no network unless `network.outbound` permission + `networkAllowedHosts` allowlist is granted.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`. Module-pack VMs (server-side evaluation of plugin canvas modules) run in `modulePackVm.ts`; the browser editor loads the same module bundle as ESM.

See [docs/features/plugin-system.md](features/plugin-system.md) for the full feature doc.

---

## Static serving

Three static handlers, in order:

| Handler                | Owns                                                                  |
|------------------------|-----------------------------------------------------------------------|
| `tryServeStaticAsset`  | `/assets/*` from `dist/` (Vite-built admin SPA assets)                |
| `tryServeUpload`       | `/uploads/*` from `uploadsDir` with `hardenUploadResponse` (nosniff, attachment for non-inert MIMEs, CORS for plugin bundles) |
| `tryServeAdminApp`     | `/admin/*` — serves the admin shell from `dist/index.html` with path-specific injections (see below) |

`server/static.ts` owns all three. Key behaviors:

- **Range requests** are honored for media (`Range: bytes=...`).
- **Conditional GET** via `If-None-Match` / `If-Modified-Since` is honored.
- **MIME-type allowlist** (`INERT_UPLOAD_MIMES`) — non-allowlisted uploads get `Content-Disposition: attachment` so they can't be top-level navigated and rendered as HTML on the admin origin.
- **Plugin bundles** (`/uploads/plugins/*`) get `Access-Control-Allow-Origin: *` because the editor preview iframe loads them from an opaque origin (`sandbox="allow-scripts"` without `allow-same-origin`).
- **Admin shell path-specific serving** (`serveAdminApp`): the two visitor paths inject different content into the shell HTML to minimize perceived load time:
  - **Unauthenticated** (no session cookie): injects a styled login skeleton into `<div id="root">` and a `BOOT_API_KICKOFF` inline script that fires `setupStatus`, `/me`, and `publicSite` fetches at HTML-parse time. FCP shifts from ~400 ms (React mount) to ~DCL (~50 ms), and `useAdminBoot` finds pre-resolved promises instead of waiting for `useEffect`.
  - **Authenticated**: keeps the existing spinner shell, but injects `BOOT_API_KICKOFF`, an `__studioAuthed = 1` flag (lets `main.tsx` skip the post-Suspense concurrent re-render delay), and `<link rel="modulepreload">` hints for the authenticated shell chunk (`AuthenticatedAdmin-*.js`). Only the shell chunk is preloaded here; workspace-page pre-warming is handled in `AuthenticatedAdmin` via `requestIdleCallback` after first paint.

---

## The live origin

`server/liveOrigin.ts` is a SECOND, independent `Bun.serve` listener, started from `server/index.ts` right after the admin listener boots (`startLiveOriginServer(config)`, on `LIVE_PORT`/`config.livePort`). It proxies `/p/<projectKey>/*` (HTTP + WebSocket) to a Tier 2 project's own dev server so a live-running project can be framed on the canvas without ever exposing the admin session to that project's code.

It is deliberately **not** a route on the admin `Bun.serve` — a same-origin proxy would attach the admin session cookie to every request the user's own dependencies make. The live origin is a different TCP socket with its own header policy:

- `Cookie` is stripped from every inbound request before it reaches the upstream dev server; `Set-Cookie` is stripped from every upstream response before it reaches the client. Unconditional, not upstream-behavior-dependent — `stripHopByHopAndCookies` / `stripSetCookie`.
- `Host` is rewritten to the upstream dev server's own authority (never the client's `Host`), because Vite 7 rejects a Host it doesn't recognize.
- Every response carries `Content-Security-Policy: frame-ancestors <liveFrameAncestors>; frame-src 'none'` and `X-Content-Type-Options: nosniff`. `ServerConfig.liveFrameAncestors` (`resolveLiveFrameAncestors`) is exactly the set the CSRF Origin check accepts as the editor: the configured public origins, `DEV_ORIGIN_ALLOWLIST` (Vite's :5173/:5174 + `VITE_ALLOWED_ORIGIN`), and the admin server's own `localhost`/`127.0.0.1` on its port — so a local install with no `PUBLIC_ORIGIN` can frame its own live frames (it used to answer `'none'`, which blocked every live frame on every local install). No `X-Frame-Options` (no multi-origin form).
- `projectKey` is looked up against `server/handlers/studio/devServer.ts`'s `getDevServerStatus(projectKey)` (a per-process registry L1 owns — see that file — backed since `live-11` by one record per ready server in `.tmp/dev-servers/`, so a dev server outlives a `bun --watch` restart of this process and is adopted back on the next lookup instead of being orphaned and respawned). An unknown key is a `404 { code: 'unknown-project' }`; a project whose dev server isn't `phase: 'ready'` is a `503 { code: 'not-ready', phase }`, checked on every proxied request (and re-checked immediately before a WebSocket upgrade) — not once per page load. Trust-tier gating (`trust === 'run-project'`) happens in L1's `ensureDevServer`; the live origin trusts a `ready` phase as sufficient authorization and does not re-read `.studio/meta.json` itself. A dev server that exits after it was `ready` flips the entry to `'failed'` (with the exit in its log), so the proxy stops forwarding to a dead port and the board falls back. The live-origin listener runs with `idleTimeout: 0`, like the admin listener — Bun's 10 s default cut off any proxied request Vite held longer than that (a module request during a dependency re-optimization) and handed the frame half a module (`live-16`).
- **What the dev-server manager will run: `vite`, and nothing else.** `server/handlers/studio/liveCapability.ts` decides `capable` on the one thing that would execute — the project's `dev` (else `start`) script must be a `vite` invocation (`vite`, `vite dev --port …`, `npx vite`, `bunx vite`, `pnpm exec vite`, `yarn vite`). `devServer.ts` refuses to spawn anything else, at any tier; the Live pill says "Live needs Vite". Not the probed `framework` and not "has a `vite.config`" — Studio's own shell scaffold writes a `vite.config.js` into every project, and a cached profile can lag. With every project at Tier 2 by default and the canvas prewarming on mount, this is the line between "Studio runs your Vite app for you" and "Studio runs whatever script an imported repo names" (`sec-20`).
- **The frame's side of the handshake.** The spawned dev server gets `STUDIO_PARENT_ORIGINS` = `liveFrameAncestors` (comma-separated) and the generated `main.jsx` resolves which of them actually framed it from `document.referrer` (`resolveParentOrigin`, `@core/studio-runtime`); the runtime then accepts commands from and posts events to that one origin only. One list serves both the CSP and the handshake, so a document that may frame a live frame is exactly a document the frame will talk to. Before this the frame needed `PUBLIC_ORIGIN` alone, which no local install sets — the bridge never booted, and the CSP blocked the frame anyway: Live had never worked locally.
- **IPv4, on both ends.** The generated `vite.config.js` pins `server.host: '127.0.0.1'` and the manager rewrites a printed `localhost` URL to `127.0.0.1`. With Vite's default host, Node binds only the first address `localhost` resolves to (::1 on modern macOS/Linux), so a port another server holds on 127.0.0.1 — Studio's own Vite, say — looks free, the project's Vite takes it on IPv6, and the proxy (resolving `localhost` to 127.0.0.1) then talks to the wrong server. `server.open` is also off when Studio spawns the process, so opening a board never opens a browser tab.
- WebSocket/HMR traffic is terminated and bridged, not tunneled: Bun can't forward a WS handshake through `fetch`, so the live origin calls `server.upgrade` on the browser's socket and opens its own outbound `WebSocket` to the upstream, relaying messages both ways. **The browser's `Sec-WebSocket-Protocol` rides both legs** (`live-11`): Vite's HMR listener upgrades only a socket offering `vite-hmr` (or `vite-ping`) and silently leaves any other upgrade hanging, and a browser that offered a subprotocol and hears none back fails the handshake itself. Without both, Vite's client saw "server connection lost" and reloaded every live frame on the board in a loop — the "canvas keeps reloading, then nothing selects" symptom.

`GET /admin/api/studio/live-origin` (`server/handlers/studio/liveOriginInfo.ts`, admin-origin, no project param) returns `{ liveOrigin: string | null }` — the origin the client should target for the frame `src` / postMessage checks, `null` if the listener failed to bind at boot.

Architecture gate: `src/__tests__/architecture/live-origin-isolation.test.ts` asserts `server/liveOrigin.ts` never imports `server/router.ts` or `server/auth/security.ts`, never writes `Set-Cookie`, and that `startLiveOriginServer` has exactly one production call site.

Env vars: `LIVE_PORT` (default `port + 1`) and `LIVE_ORIGIN` (default `http://localhost:${LIVE_PORT}`; self-hosted/tunneled deployments must set it explicitly, exactly like `PUBLIC_ORIGIN` — see `docs/deployment/README.md`).

---

## The project's design-system folder

Studio's design system is **not an npm dependency of the user's project**. Every DS-backed project carries a Studio-written `<project>/design-system/` folder, and its pages import it relatively (`import { Button } from '../design-system'`). That is what makes "Download the code" honest: `node_modules/` never ships, so a synthesized `package.json` naming a design-system package produced a zip that could not `bun install`. With the folder, the export builds with `react`, `react-dom`, `vite` and `@vitejs/plugin-react` and nothing else.

- `server/handlers/studio/builtinDesignSystem.ts` — the three shared declarations: `BUILTIN_DESIGN_SYSTEM_DIR` (Studio's own vendored copy at `vendor/alm-design-system/`), `PROJECT_DESIGN_SYSTEM_DIR` (`'design-system'`), and `isDesignSystemBacked(dir)` — the READ-side check every consumer uses (the folder has an `index.js`).
- `server/handlers/studio/designSystemFiles.ts` — `ensureDesignSystemFiles(dir)`, called from `loadStudioPages` beside `ensurePrototypeShell` and from `buildStudioDownloadResponse`. Writes the vendored `src/` into the folder, including **only** the `icons/**/*.svg` a component or `LineIcons.jsx` actually imports (≈20 of 568, read statically with a regex — nothing is executed at any trust tier). Idempotent by a SHA-256 of the whole source set recorded in `.studio/design-system.json` (`{ version, hash, files }`); a matching hash writes nothing, a differing one rewrites in place and removes the files that left the source set. Nothing outside `<project>/design-system/` and that one sidecar is ever touched, the delete list is the manifest's own `files` array, and every read and write is containment-checked on its **real** path. Never throws.
- The WRITE-side authority is `.studio/meta.json`'s `designSystem: 'alm'` — set by `POST /admin/api/studio/create` (via `projectSeed.ts`) and by the migration route, never by a GitHub import. An imported repository does not get 600 KB of someone else's `.jsx` because it was opened.

### `GET/POST /admin/api/studio/design-system/migrate`

`server/handlers/studio/designSystemMigrate.ts` — moving a project that still imports the retired `@alm-design/design-system` npm.

| | |
|---|---|
| `GET ?dir=<abs>` | `{ declaresDependency, hasInstalledCopy, importsRetiredPackage, designSystemBacked }`. Two cheap reads (the manifest, one `existsSync`) because the board asks on every open — deliberately not a walk of every source file. |
| `POST { dir? }` | `{ filesRewritten, importsRewritten, removedDependency }`. Marks the meta → writes the folder → rewrites every import with `rewriteImportSpecifier` (formatting-preserving ts-morph) → drops the dependency from `package.json` keeping its formatting and every other key → deletes `node_modules/@alm-design/design-system` and its now-empty scope directory. |

The delete is the one in this feature, and its guard is stated where it happens: the path is derived server-side, must pass `isRealpathContained(target, dir)` (containment after every symlink in the chain resolves), and a target that is itself a symlink is refused rather than followed. Failures use the `{ error }` envelope; a `dir` outside `studio-workspace/` is the router's 404 via `resolveProjectDir`.

**POST never runs on load.** The board offers it through `DesignSystemMigrateBanner` and the user clicks — a rewrite of someone's source is a user action, the same rule trust promotion follows.

---

## Landing an image the user dropped on the canvas

`POST /admin/api/studio/asset-drop` (`server/handlers/studio/assetDrop.ts`) —
D2 G15's write. It is the second of two routes that put an image byte buffer
into a project, and the difference between them is worth stating precisely
because it is NOT a security difference:

| | `asset-upload` (WS-8.3) | `asset-drop` (D2 G15) |
|---|---|---|
| Who says where the file goes | the caller, via `targetDir` | the SERVER, always `public/` |
| What reads it afterwards | an `import heroImg from '…'` the caller is about to repoint | a literal `<img src="/photo.png">` Studio is about to write |
| Traversal surface | a client string, guarded by `resolveAssetWriteDir` | none — the directory is a constant |

Everything else is one shared pipeline and is not duplicated: the body is
capped by **streamed byte count** (`readFormDataWithLimit`, so a spoofed
`content-length` cannot bypass it), the **bytes** decide the format and the
written extension (`sniffImageExtension` — never the filename or the declared
MIME), SVG is sanitised before it touches disk, the filename is derived rather
than trusted, a collision gets a numeric suffix rather than clobbering, and
containment is checked on the **real** path of the nearest existing ancestor.
All of it lives in `assetLanding.ts`.

**Why `public/` is the only answer.** It is the one directory every framework
the probe recognises (Vite, CRA, both Next routers, Remix, Astro) serves
verbatim from the site root, so the file is reachable at `/<name>` in dev and
in a production build alike — one literal, one honest target, no import.
`src/assets/` cannot be used here: under every one of those bundlers a file
there is only reachable through an `import` the bundler rewrites to a hashed
URL, so a literal path works in `vite dev` and 404s in production, and
`<img src={photo}>` would be TWO edits in two places. A missing `public/` is
created only for a project whose framework declares the convention; for
`framework: 'unknown'` the route answers **409** with the remedy
("create a public/ folder") rather than guessing.

Response: `{ ok: true, relPath, src }` — `relPath` is workspace-relative
(`public/photo.png`, or `apps/web/public/photo.png` in a monorepo) and `src` is
the literal the `<img>` gets (`/photo.png` in both cases: the app root is where
the app lives on disk and the browser never sees it).

**Who may ask** (`sec-17`, `sec-14`). One line in `routeCapabilities.ts` —
`{ path: '/admin/api/studio/asset-drop', read: null, mutate: 'studio.write' }`
— and nothing in the handler. `gateStudioRequest` therefore answers both
questions **before the body is read**, which is the point: an unauthorised
caller must not cost 25 MB of server memory, and a forged request must not
reach the filesystem at all.

- **CSRF.** A multipart POST is a shape a plain cross-origin `<form>` can send
  with no JavaScript and no preflight, so without it any page the user has open
  in another tab could land a file of its choosing in the project they are
  editing. A bare **403** that names nothing on disk.
- **`studio.write`** — the capability `/delete`, `/duplicate` and the trash
  writes carry. **401** with no session, **403** without the capability.

`sec-17` found this route unauthenticated and added an inline `originAllowed` +
`requireCapability` pair, because the base it reviewed had no table to declare
into; integration replaced that pair with the declaration and moved the
sub-router back onto the plain `STUDIO_SUB_ROUTERS` list, since it no longer
needs the `DbClient`. `asset-upload` and `/save` are declarations in the same
table now, so the asymmetry `sec-17` recorded is gone.

---

## Adding a new endpoint

1. **Pick the right layer.**
   - CMS resource (e.g. `/admin/api/cms/feature`) → new handler file such as `server/handlers/cms/<feature>.ts`, register in `server/handlers/cms/index.ts`.
   - Top-level (e.g. `/_studio/something`) → new `tryServeX` in `server/router.ts`, add to the `routes` array in the right order.

2. **Write the handler.** Require capability → validate body → call repository → return `jsonResponse`. One function per route. Add a `Route` entry to the group's `ROUTES` table; path matching and 404/405 discrimination are handled by `runRouteTable` — do not hand-roll `if (url.pathname !== ...)` or `return methodNotAllowed()` in the handler itself. Parameterised paths use a `RegExp` with named capture groups; the dispatcher decodes each captured value once.

3. **If new SQL is needed,** add the function to the matching `server/repositories/<resource>.ts`. Do not write SQL inside the handler.

4. **If new persisted shape is involved,** add the migration to both `migrations-pg.ts` and `migrations-sqlite.ts` with the same ID. JSON columns end in `_json`. Run `bun test src/__tests__/architecture/migration-parity.test.ts` and `db-json-column-naming.test.ts` to confirm.

5. **If client-side calls the endpoint,** add a TypeBox response schema (in `src/core/persistence/responseSchemas.ts` for CMS endpoints, or alongside the caller) and fetch via the canonical `apiRequest(path, { schema })` from `@core/http`. Persistence-layer functions that inject their own `fetch` validate via `readEnvelope`.

---

## Adding a new repository

1. Create `server/repositories/<resource>.ts`. Export typed functions: `listX`, `getX(id)`, `createX(...)`, `updateX(id, patch)`, `deleteX(id)`.
2. Use ANSI-standard SQL only. No Postgres-isms.
3. JSON columns must end in `_json`. Interpolate plain JS objects via `${obj}` — both adapters handle the conversion.
4. Use `db.transaction(async (tx) => ...)` for multi-row writes that must be atomic.
5. Validate any JSON read from disk with a TypeBox schema before returning it.

---

## Error handling

- **Server logs** use the prefix `console.error('[<module>]', err)` — e.g. `'[router] adapter "<id>" getReadUrl failed:'`, `'[server] Unhandled request error:'`.
- **Domain errors** are typed `Error` subclasses with a `path` (or similar) field — e.g. `SiteValidationError`, `VisualComponentNameError`. Add a typed class when callers need to distinguish causes.
- **Generic `throw new Error(...)`** is fine for "this should never happen" invariants.
- **Never echo raw error messages to the client.** The top-level catch in `server/index.ts` returns a generic 500. Handlers return `{ error: <safe message> }`.
- **`catch (err)` → client error string:** use `getErrorMessage(err, 'fallback message')` from `src/core/utils/errorMessage.ts`. The hand-rolled `err instanceof Error ? err.message : 'fallback'` pattern is forbidden because it surfaces a blank string for `new Error('')` — `getErrorMessage` falls back when the message is empty or whitespace-only.

See [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) for boundary validation patterns.

---

## Line endings — subprocess output

Studio runs other people's command-line tools on the user's machine: `git`,
`bun`/`npm`/`pnpm`, `tsc`, `vercel`, `netlify`, the project's own dev server,
the `claude` CLI. **On Windows those tools print CRLF.** A `text.split('\n')`
leaves a `\r` glued to the end of every line, and the damage lands on whatever
the LAST field of that line happens to be — which is silent: no throw, no log,
just a value that compares unequal to the one it should equal.

Three real instances, all fixed:

| Read | What the `\r` did |
|---|---|
| `for-each-ref` `%(HEAD)` (`parseGitBranchRefs`) | `head === '*'` false for every branch → the panel reports no current branch |
| `log --format=…%x1e` (`parseGitLogRecords`) | the record separator's own newline is `\r\n`, `/^\n/` misses it, every sha after the first is 41 characters |
| `tsc --pretty false` (`parseTscDiagnostics`) | the header pattern ends `(.*)$`, and `.` does not match `\r` |

**The rule:** any file under `server/` that reads captured subprocess output
cuts it with `splitLines` — or normalises it with `toLf` before an `/m`-anchored
regex — from `@core/utils/lineEndings`, the same pure-string leaf the parser
uses for the user's source files. Never a bare `'\n'` split, and never a
hand-rolled `.replace(/\r$/, '')` at one call site. Gated by
`src/__tests__/architecture/subprocess-output-line-endings.test.ts`, which
scans every file that imports a subprocess runner plus the named pure parsers
(`gitOutputParse.ts`, `tscDiagnostics.ts`, `deployProviders.ts`).

Two things the rule deliberately does not cover:

- **Incremental NDJSON framing over a live stream** (`claudeCliSpawn.ts`,
  `claudeCliWarmSession.ts`, which frame on `buffer.indexOf('\n')`). You cannot
  `splitLines` a stream that has not finished arriving, and both hand each
  framed line to `JSON.parse`, for which a trailing `\r` is legal whitespace.
- **`devServer.ts`'s URL discovery**, which matches `URL_PATTERN` against raw
  CHUNKS rather than lines. Its tail is `[^\s"'<>]*` and `\r` is `\s`, so the
  carriage return can never be swallowed into the host. Asserted by a CRLF
  transcript test rather than assumed.

Writing `'\n'` is untouched — Studio emits LF, always. Only reads are
constrained. Line endings inside the USER's own source files are a different
(and larger) contract: see
[docs/features/studio-import.md](features/studio-import.md).

---

## Related

- [docs/architecture.md](architecture.md) — system overview
- [docs/editor.md](editor.md) — what the admin / editor frontends do
- [docs/features/plugin-system.md](features/plugin-system.md) — plugin runtime details
- [docs/reference/database-dialects.md](reference/database-dialects.md) — PG vs SQLite rules
- [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `server/index.ts` — entrypoint and boot
  - `server/router.ts` — request dispatch
  - `server/handlers/studio/` — Studio's own server half (parse, writeback, git, trust tiers, capture)
  - `server/handlers/studio/trustTier.ts` — reads/writes `.studio/meta.json`'s `trust` field (`static` | `render-packages` | `run-project`)
  - `server/handlers/studio/designSystemFiles.ts` — writes `<project>/design-system/` from Studio's vendored copy; `designSystemMigrate.ts` — `GET/POST /admin/api/studio/design-system/migrate`
  - `server/handlers/studio/devServer.ts` — Tier-2-gated, vite-only dev-server process manager (`/admin/api/studio/dev-server/{status,start,stop}`), one reused idle-timed subprocess per project, shared by the MCP `studio_render_reference` tool and the client prewarm hook (Track L, `live-01`); the vite rule is `liveCapability.ts`. A ready server is recorded in `.tmp/dev-servers/` by `devServerRecords.ts` (`STUDIO_DEV_SERVER_STATE_DIR` relocates it) and adopted back after a process restart if its pid is alive and its origin answers (`live-11`; since `live-14` a pid of `0` or a zombie counts as dead, and no studio-authored log line ever carries a URL, because the "Local:" URL scan falls back to the whole log). The child's stdout and stderr go to a FILE next to that record (`<hash>.log`), never to a pipe: a piped child dies of EPIPE on its first log line after the process that spawned it restarts, which is what made every adopted server die on its next HMR update (`live-16`). The manager tails the file for the "Local:" URL and the capped status log, an adopted entry tails the same file, and the file is deleted with the record
  - `server/ai/mcp/capture/captureRoute.ts` — headless agent capture (`/admin/agent-capture`, `/admin/api/agent-capture/*`)
  - `server/ai/mcp/` — the `/_studio/mcp` MCP server endpoint for external AI clients
  - `server/http.ts` — JSON / error HTTP helpers
  - `server/binary.ts` — binary response helpers (`toArrayBuffer`, `binaryResponse`)
  - `src/core/utils/errorMessage.ts` — `getErrorMessage(err, fallback)` canonical catch-block extractor
  - `server/handlers/cms/index.ts` — CMS dispatcher
  - `server/handlers/cms/routeTable.ts` — shared `runRouteTable` dispatcher (404-vs-405 rule, named param decoding)
  - `server/auth/authz.ts` — `requireCapability` and friends
  - `server/db/client.ts` — `DbClient` interface
  - `server/db/index.ts` — adapter selection
  - `server/db/postgres.ts`, `server/db/sqlite.ts` — adapters
  - `server/db/migrations-pg.ts`, `server/db/migrations-sqlite.ts` — schemas
- Gate tests:
  - `src/__tests__/architecture/db-postgres-isms.test.ts`
  - `src/__tests__/architecture/db-json-column-naming.test.ts`
  - `src/__tests__/architecture/migration-parity.test.ts`
  - `src/__tests__/architecture/cms-handlers-capability-gated.test.ts` — every file under `server/handlers/cms/` calls an auth guard; allowlist entries carry explicit justifications
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/server/routeTable.test.ts` — unit coverage of `runRouteTable`: dispatch, named params, 405 vs null, extra context forwarding, real-world patterns (data rows, plugins)
