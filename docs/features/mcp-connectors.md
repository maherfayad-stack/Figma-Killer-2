# MCP Connectors

MCP connectors let **external AI clients drive this Studio instance** over the [Model Context Protocol](https://modelcontextprotocol.io). Studio acts as an **MCP server**: a local client (Claude Code, Codex, Cursor) or a remote agent connects, lists the available tools, and operates the CMS — reading the site, editing page structure, and managing content — exactly the way the built-in AI panel does.

This is the mirror image of the **Providers** tab (`server/ai/credentials/`), which points Studio's *own* agent outward at LLM providers. MCP connectors point inward: they let outside agents reach in.

One provider on that outward-pointing side is worth calling out here because it will eventually loop back to *this* server: WS-11's `claudeCli` driver (`server/ai/drivers/claudeCli.ts`) spawns a local `claude` subprocess as a chat provider — the CLI owns its own agent loop internally rather than going through Studio's `runToolLoop` (see `docs/features/agent.md`'s "loop-ownership fork"). Step 1 ships that subprocess with zero tools. WS-11 step 3 (not yet built) is planned to point the subprocess's own `--mcp-config` at `/_studio/mcp` — the exact endpoint this document describes — with a scoped connector token minted per chat session, so a `claude` turn gets Studio's real toolset through the same connector-bridge machinery an external Claude Code connector uses today, instead of duplicating tool routing a second time.

The server is implemented with the official `@modelcontextprotocol/sdk`. That package is banned everywhere else in the tree (the AI drivers hand-roll provider REST); it is allowed **only under `server/ai/mcp/`**, scoped by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Studio is an MCP server.** One Streamable-HTTP endpoint at `/_studio/mcp` serves both local and remote clients (local is just `localhost`).
- **Thin adapter over the existing tool engine.** No tool logic is duplicated. MCP is a new *caller* alongside the built-in agent and the plugin host; tool dispatch reuses `executeAiTool`.
- **Tool surface = the full catalog.** Server-resolved tools (`site_list_documents`, `site_read_styles`, and explicit `site_publish`) run headless — no editor needed. Every browser-execution tool the agent panel has is exposed too, **relayed to the open Site workspace** — the single source of truth for edits. If that workspace is not open, its tools return a clear error; headless tools still work.
- **Draft, then publish.** Browser writes save the draft and never leak intermediate work to visitors. A connector with `ai.tools.write` + `pages.publish` calls `site_publish` once after its edit sequence; that server-side tool runs the canonical full-site pipeline and atomically swaps the rebuilt static slot.
- **Bearer-token auth, one secret per connector.** The token is shown once on creation and stored only as a SHA-256 hash. New tokens expire after 90 days by default; admins can choose a custom TTL or explicitly create a non-expiring token. Revocable.
- **Capability-gated.** A connector carries a granted capability subset; the same gate the built-in agent uses (`toolAllowedForCapabilities`) filters the toolset. An MCP caller can never invoke a tool the granting capabilities couldn't authorize over HTTP.
- **Privilege floor.** An admin can only grant capabilities they themselves hold.
- **Managed from the admin UI:** AI workspace → **MCP** tab. Minting a long-lived connector secret is step-up authenticated.

---

## Architecture

```
MCP client (Claude Code / Codex / remote agent)
        │  JSON-RPC over Streamable HTTP
        ▼
server/router.ts  →  /_studio/mcp   (tryServeMcp)
        │
server/ai/mcp/transports/http.ts      WebStandardStreamableHTTPServerTransport (Web Request/Response)
        │
server/ai/mcp/auth.ts                 Bearer token → connector → capability set (401 + WWW-Authenticate otherwise)
        │
server/ai/mcp/server.ts               low-level SDK Server; tools filtered by capabilities
        │
server/ai/mcp/registry.ts             AiTool registry → MCP tools (TypeBox inputSchema sent verbatim as JSON Schema)
        │
executeAiTool(...) / live editor bridge
        ▼
repositories (headless reads) / live editor store (browser tools)
```

### Module layout — `server/ai/mcp/`

| File | Responsibility |
|---|---|
| `transports/http.ts` | Mounts the SDK's Web-standard Streamable-HTTP transport; stateless per request (`enableJsonResponse`). |
| `auth.ts` | Bearer resolution → `{ connectorId, userId, capabilities }`; spec-correct 401 with an RFC 9728 `resource_metadata` pointer. |
| `server.ts` | Builds a capability-scoped low-level `Server` (`ListTools` / `CallTool` handlers). Uses the low-level `Server`, not `McpServer.registerTool`, because the latter needs Zod (banned) — this lets the TypeBox `inputSchema` pass through verbatim. |
| `registry.ts` | Headless reads plus the browser-relayed site catalog, deduped by name and filtered by `toolAllowedForCapabilities`. |
| `tools/documentTools.ts` | `site_list_documents` — pages, templates, and visual components, headless from the DB. |
| `tools/styleTools.ts` | `site_read_styles` — the design system as a CSS stylesheet, headless from the DB. |
| `tools/publishTool.ts` | `site_publish` — explicit server-side full-site publish through `publishDraftSite`, including the Layer-A static slot and MCP audit metadata. |
| `tools/studioImportTool.ts` | `studio_import_project` — thin adapter over the Phase 7B GitHub import engine (`server/handlers/studioGithubImport.ts`); fetches a repo into its own `studio-workspace/<owner>-<repo>` project folder and summarizes the discovered pages. |
| `tools/studio/` | WS-9 Studio tool family — project/board orientation, bulk edits, codemods, and the fidelity report. See "Studio tools (WS-9)" below. |
| `resources.ts` | Static MCP **resources** (not tools) — `studio://guidelines`. |
| `editorBridge.ts` | Per-user live workspace bridge registry + `createEditorBridgeStream`; browser tools route to the owner's open Site workspace. |
| `handlers/editorBridge.ts` | `GET /admin/api/ai/editor-bridge?scope=site` — the capability-gated NDJSON stream the workspace holds open. |
| `connectors/` | `types.ts` (server-only record), `token.ts` (generate + SHA-256 hash), `store.ts` (CRUD + `toConnectorView`). |
| `handlers/connectors.ts` | `/admin/api/ai/mcp/connectors` CRUD, gated by `ai.providers.manage`. |

---

## Tool surface

MCP exposes the **full tool catalog** (deduped by name), capability-filtered. Tools fall in two execution classes:

**Single source of truth.** All page *editing* goes through the **live editor store** (browser tools, relayed to the open editor). There is deliberately **no** headless DB-mutating page-tree tool: an earlier `read_page_tree`/`mutate_page_tree` pair edited the DB directly, creating a second copy of each page with identical node ids that desynced from the open editor and got clobbered by its autosave (data loss). They were removed — structure editing uses the editor's browser tools, which the existing save-flush persists.

**Server-resolved — work with no workspace open:**
- `get_context({ entryId? })` — orientation in one call: whether the Site workspace bridge is connected, which "everywhere"/post-type templates wrap pages, and the site name. Call it first if a browser tool returns an "open the workspace" error.
- `site_list_documents` — editable pages, templates, and visual components with document references, root node ids, template metadata, and summaries. Nothing is marked active/current because headless calls have no editor focus.
- `site_read_styles({ format?, className?, includeTokens? })` — the design system as a **CSS stylesheet**: design tokens (CSS custom properties) + every class/ambient rule, read straight from the DB via the publisher's emitters. `format:"summary"` returns a compact class catalog (selector + referenced token vars, no declarations) to scan first. Symmetric with reading pages as HTML / writing CSS via `site_apply_css`. Replaces the old snapshot-dependent `list_tokens`.
- `site_list_breakpoints` — configured viewport ids/labels/widths (the first is the base), so `site_render_snapshot` can target one deliberately. Headless version replaces the snapshot-dependent one.
- `site_publish` — deploys the **saved** draft. It requires `ai.tools.write` + `pages.publish`, calls `publishDraftSite` with the server's real uploads directory, rebuilds HTML/CSS/runtime assets into the inactive static slot, swaps it atomically, bumps the publish cache version, and records `source: "mcp"` plus the connector id in the publish audit event.
- `studio_import_project({ url, ref?, subdir?, token? })` — imports a GitHub React app into a studio workspace. A thin adapter: it calls the same `runGithubImport` engine behind the admin "Import from GitHub" dialog (Phase 7B), reshaping its `{ dir, files, skipped }` result with a `pageCount` and a short list of discovered `pages/*.tsx` paths (a directory listing via the Phase 7A `discoverPageFiles` walk, not a second parse). Requires `ai.tools.write` + `site.structure.edit`. **Security:** the import target is always derived server-side as `studio-workspace/<owner>-<repo>` (its own project folder, never the root) — the tool's input schema has no `dir` field, and the handler passes `url`/`ref`/`subdir`/`token` to `runGithubImport` explicitly (never spread), because `runGithubImport` clears its target directory before repopulating it and a caller-supplied target would be an arbitrary recursive-delete primitive. `token`, when supplied, is forwarded to GitHub as a Bearer credential only — never logged, echoed back, or persisted. Writes to disk only: it never publishes and never touches the live page-tree editor's DB — open the resulting workspace through the Studio UI to edit it live, the same load path every other studio workspace uses.

Site writes deliberately do **not** call `site_publish` automatically. A multi-step agent edit can involve many tool calls; publishing each intermediate call would expose incomplete work, bypass the user's explicit deployment intent, and repeatedly run the expensive full-site pipeline. The client should finish and verify its draft changes, then call `site_publish` once when publication was requested.

### Studio tools (WS-9) — let an agent audit and restructure a Studio project's board

`server/ai/mcp/tools/studio/` — a separate tool family for **Studio** projects
(a real React repo under `studio-workspace/<project>/`, imported as a board of
frames), distinct from the CMS `site` document family above. All headless
(`execution: 'server'`), because a Studio project's state is filesystem state
— its source `.tsx`/`.jsx` files and its `.studio/boards.json` frame geometry
— read/written through the exact same plain GET/POST round trip the Studio UI
itself uses. There is no live-editor-store autosave for either to desync from
(unlike the CMS `site` page tree, which is why THAT stays browser-relayed
only) — concurrent last-write-wins is the ordinary risk any two editors of the
same files already have, not a new failure mode.

**9.1 — project + board orientation** (read-only, no `requiredCapabilities`):
`studio_list_projects`, `studio_project_profile` (the cached/fresh
`ProjectProfile` + probe warnings), `studio_list_pages`, `studio_get_node_source`
(node id → `{ file, line, col, snippet }`, decoding `@core/page-tree`'s
`sourceNodeId` grammar), `studio_find_nodes` (query by moduleId/tag/class/text/
lock state/codeProps presence).

**9.1 — mutating:** `studio_install_deps` + `studio_install_status` (the WS-1.4
polled install job). Requires `studio.write`.

**9.3 — bulk edit + structural**, all requiring `studio.write`:
`studio_apply_edits` (a batch of `StudioEdit`s through `applyStudioEditBatch` —
the SAME engine `POST /admin/api/studio/save` runs, extracted into
`server/handlers/studioWriteback.ts` so there is exactly one ordering/dedup/
shift-detection implementation), `studio_set_frames` (bulk `.studio/boards.json`
geometry), `studio_codemod` (dispatches `rename-tag`/`set-import-specifier` to
the shipped `@core/ast-codemods`; `detach`/`swap`/`extract-component` are WS-4,
not built yet, and return `{ ok:false, code:'not-yet-available', message }`
rather than a silent no-op).

**9.4 — `studio_fidelity_report(dir, pageId?)`** — the flagship tool. Per page:
a `score` (`nodes`/`resolved`/`locked`/`codeValued`) and `findings[]`, each
`{ code, nodeId, file, line, message, fix, impact }`. Every finding code is
either reused verbatim from `ProjectProfile.warnings[].code`
(`server/handlers/studio/projectProfileSchema.ts`) for project-level issues, or
minted in `server/ai/mcp/tools/studio/fidelityCodes.ts` for node-level issues
detected from a loaded page's `lockReason`/`resolution`/`codeProps` fields.
`docs/features/studio-import.md`'s "What still does not import" section is the
same vocabulary as a doc table — `fidelityCodes.test.ts` gates that every
registered code appears in the doc and vice versa.

**9.5 — `studio://guidelines`** — an MCP **resource** (not a tool): the
distilled "how to write React that Studio imports cleanly" rules (module-scope
consts over hooks, literal `className`s, one `return` per component, `?raw`
icon imports, providers in one place). Read once, not capability-gated (it's
documentation, not a data source).

**9.2 — the visual-audit trio** (`mcp-02`), requirement 10 ("audit the frames
visually by exporting them as images and comparing them to the live one"):

- `studio_export_frames` — **browser-relayed** (`execution:'browser'`,
  `scope:'site'`, `mutates:true` + `studio.write`), the one 9.x tool that is
  NOT headless: a Studio board frame does not exist offscreen the way a CMS
  breakpoint does (every board frame shares one synthetic `'studio'`
  breakpoint id at its OWN authored width, with no `Breakpoint` object in
  `site.breakpoints` a transient mount could target without touching
  `CanvasRoot.tsx`, which a concurrent work order owned at ship time). Instead
  it captures the REAL, already-mounted board frame: forces zoom to 1 and
  pans the requested page fully on screen (so the capture is width-accurate
  regardless of the user's current zoom), activates it, waits for mount +
  settle, then reuses `site_render_snapshot`'s own capture pipeline
  (`renderEvidence.ts`, extended with a `pageId` filter). Because it captures
  the real live DOM, the design-canvas freeze (`CanvasAnimationInjector`) and
  scroll-unroll (`CanvasScrollUnrollInjector`) injectors apply automatically.
  Side effect, by design: temporarily takes over the live canvas's pan/zoom/
  active-page (clearing node selection) for the batch, restored afterward —
  documented in the tool description since a user editing in the same session
  will see their view jump.
- `studio_render_reference` — **Tier 2**, `execution:'server'`, `mutates:true`
  + `studio.run.project` (never granted by default, never implicit — this is
  the only Studio tool that EXECUTES the project's own code). Boots the
  project's own `dev`/`start` script via the detected package manager
  (`server/handlers/studio/installDeps.ts`'s `detectPackageManager`, reused),
  parses the URL it prints (no forced port — frameworks disagree on how to
  request one, and some auto-increment past a taken port anyway), drives
  `playwright-core` to `route` at the given viewport, screenshots. `route` is
  caller-supplied, not derived from a Studio page id: a parsed Studio page
  (one screen file) does not always correspond to an addressable dev-server
  URL — confirmed against the real eSIM corpus, whose `App.jsx` exposes only
  3 of its 15 screens via a `?page=` query param, the rest reachable only by
  simulating in-app interaction this tool does not drive. The dev server is
  reused across calls for the same project and torn down after
  `idleTimeoutMs` of inactivity (default 2 min). A boot failure returns
  `ok:false` with the captured stdout/stderr tail, never a synthetic result.
- `studio_diff_frames` — headless, `execution:'server'`, no
  `requiredCapabilities` (a pure read/compute over two caller-supplied PNGs).
  Deliberately generic (two base64 PNGs in, not coupled to the other two
  tools' output shape): `pixelmatch` computes the overall score + diff PNG; an
  independent grid + flood-fill pass over the two ORIGINAL images (not
  pixelmatch's diff-image encoding) finds the top N differing rectangles,
  each intersected against caller-supplied `nodeRects` (the exact shape
  `studio_export_frames` already returns per frame) to report the node ids a
  differing region overlaps — "the hero section is 78% different, nodes X and
  Y," not "the images look different."

**Browser-relayed (via the live workspace bridge) — require the Site workspace to be open:**
- Structure editing — `site_insert_html`, `site_replace_node_html`, `site_delete_node`, `site_move_node`, `site_duplicate_node`, `site_rename_node`, `site_update_node_props`.
- HTML/CSS authoring (`site_apply_css`, `site_assign_class`, `site_remove_class`), page lifecycle (`site_add_page`, …), design tokens (`site_set_color_tokens`, …), code assets, structure reads (`site_read_document`), and live-DOM reads (`site_render_snapshot`, `site_get_node_html`).
- These have no server implementation — their logic runs in the browser against the live workspace state, routed to `SitePage`. Image attachments (e.g. `site_render_snapshot`'s PNG) come back as MCP image content blocks. No workspace connected → a clear error asking the operator to open the Site editor.

## Live editor bridge

`server/ai/mcp/editorBridge.ts` keeps one bridge per user (newest connection wins). A connector can only reach **its own owner's** Site workspace.

```
MCP browser-tool call            Site workspace (open in a browser)
   │ executeAiTool(browser)         │ useMcpWorkspaceBridge('site', dispatcher)
   ▼                                ▼
buildMcpServer → getEditorBridgeForUser(userId, 'site')
   │ bridge.callBrowser(tool, input) → emits toolRequest ─────────────▶ SitePage dispatcher
   │                                                                        │ (live workspace)
   ◀───────────── POST /admin/api/ai/tool-result ◀── postToolResult ◀───────┘
```

- Browser side: `useMcpWorkspaceBridge` opens the NDJSON stream, runs each `toolRequest` through the SAME dispatcher as the built-in agent panel, and POSTs the result back. It reconnects with backoff. `SitePage` flushes pending draft changes before reporting a successful tool result, so a follow-up headless read or `site_publish` sees the persisted edit immediately; a failed save makes the MCP tool fail instead of silently publishing stale data.
- Server side: reuses the chat bridge machinery wholesale — `createBridge` issues the `AiBrowserBridge`, `resolveBridgeToolResult` settles it from the existing `/admin/api/ai/tool-result` endpoint.

This is why an open editor (yours, or one the agent opens) unlocks the full editing surface without reimplementing any tool.

---

## Authentication

Each connector has a bearer secret (`imcp_…`). The client sends `Authorization: Bearer <token>`. The server hashes the presented token and looks up a non-revoked, non-expired connector, yielding its capability set. Missing/invalid/expired tokens get a `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.

Works today with Claude Code, Cursor, Claude.ai custom connectors, and custom remote agents.

Managed connector UIs that require an OAuth flow are not compatible with the current bearer-token implementation.

---

## Connecting a client

Create a connector in **AI → MCP**, complete the step-up prompt if the session is not already fresh, choose its type and capabilities, then copy the token (shown once).

**Local (Claude Code / Codex / Cursor):**

```sh
claude mcp add studio --transport http http://localhost:3000/_studio/mcp \
  --header "Authorization: Bearer imcp_…"
```

**Remote:** point the client at `https://<your-host>/_studio/mcp` and send the token as an `Authorization: Bearer` header.

---

## Data model

`ai_mcp_connectors` (migration `018` plus additive expiry migration `019`, PG + SQLite parity):

| column | notes |
|---|---|
| `id`, `user_id`, `label` | owner + display name |
| `type` | `local` \| `remote` |
| `auth_mode` | `bearer` for every connector created by the current UI/API. The schema also accepts `oauth` as a reserved storage value, but no OAuth flow creates or authenticates those rows today. |
| `token_hash` | SHA-256 of the secret; never the plaintext. Unique. |
| `capabilities_json` | granted capability subset |
| `created_at`, `last_used_at`, `revoked_at` | lifecycle; revoked tokens fail auth |
| `expires_at` | token expiry; new tokens default to 90 days, `NULL` means explicitly non-expiring or grandfathered |

The wire-safe `McpConnectorView` (the only HTTP-returned shape) includes `expiresAt` but never includes the hash — gated by `ai-mcp-connectors-never-leak.test.ts`. Create and revoke are audited (`ai.mcp_connector.created` / `ai.mcp_connector.revoked`).

---

## Capabilities

Connector management is gated by `ai.providers.manage` (the AI-integrations admin surface), and connector creation additionally requires a fresh step-up window because it mints a long-lived delegated secret. A connector's granted capabilities flow straight into the existing tool gate:

- mutating tools require `ai.tools.write`;
- page-tree edits require any of `site.structure.edit` / `site.content.edit` / `site.style.edit` / `pages.edit`;
- full-site deployment additionally requires `pages.publish`;
- reads require any site read grant.

An admin cannot grant a capability they do not hold (enforced in `handlers/connectors.ts`).

---

## Tests

- `server/ai/mcp/connectors/{token,store}.test.ts` — token hashing, expiry, and store CRUD.
- `server/ai/mcp/{registry,auth,server,transports/http}.test.ts` and `server/ai/mcp/tools/documentTools.test.ts` — capability filtering, headless document listing, bearer auth + 401, scoped workspace relay, full MCP round-trip, HTTP handshake.
- `server/ai/mcp/publishTool.test.ts` — explicit MCP publish rebuilds and swaps the real static CSS/HTML slot and records connector audit metadata.
- `server/ai/mcp/tools/studioImportTool.test.ts` — capability gating, the `dir`-stripping input schema, the imported-pages summary helper, and an end-to-end handler run against a stubbed global `fetch` (no real network calls); `server/handlers/__tests__/studioGithubImport.test.ts` covers the underlying import engine itself.
- `server/ai/mcp/tools/studio/{projectTools,editTools,fidelityReport}.test.ts` — orientation/edit/fidelity tool handlers against temp fixture projects; `fidelityCodes.test.ts` — doc ⇄ code parity gate against `docs/features/studio-import.md`'s table.
- `server/ai/mcp/resources.test.ts` — `studio://guidelines` resource listing/read.
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` — CRUD, step-up, privilege floor, capability gating.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` — token never serialized.
