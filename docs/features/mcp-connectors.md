# MCP Connectors

MCP connectors let **external AI clients drive this Instatic instance** over the [Model Context Protocol](https://modelcontextprotocol.io). Instatic acts as an **MCP server**: a local client (Claude Code, Codex, Cursor) or a remote agent connects, lists the available tools, and operates the CMS — reading the site, editing page structure, and managing content — exactly the way the built-in AI panel does.

This is the mirror image of the **Providers** tab (`server/ai/credentials/`), which points Instatic's *own* agent outward at LLM providers. MCP connectors point inward: they let outside agents reach in.

The server is implemented with the official `@modelcontextprotocol/sdk`. That package is banned everywhere else in the tree (the AI drivers hand-roll provider REST); it is allowed **only under `server/ai/mcp/`**, scoped by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Instatic is an MCP server.** One Streamable-HTTP endpoint at `/_instatic/mcp` serves both local and remote clients (local is just `localhost`).
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
server/router.ts  →  /_instatic/mcp   (tryServeMcp)
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
claude mcp add instatic --transport http http://localhost:3000/_instatic/mcp \
  --header "Authorization: Bearer imcp_…"
```

**Remote:** point the client at `https://<your-host>/_instatic/mcp` and send the token as an `Authorization: Bearer` header.

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
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` — CRUD, step-up, privilege floor, capability gating.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` — token never serialized.
