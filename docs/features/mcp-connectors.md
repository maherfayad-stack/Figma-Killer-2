# MCP Connectors

MCP connectors let **external AI clients drive this Studio instance** over the [Model Context Protocol](https://modelcontextprotocol.io). Studio acts as an **MCP server**: a local client (Claude Code, Codex, Cursor) or a remote agent connects, lists the available tools, and operates the CMS — reading the site, editing page structure, and managing content — exactly the way the built-in AI panel does.

This is the mirror image of the **Providers** tab (`server/ai/credentials/`), which points Studio's *own* agent outward at LLM providers. MCP connectors point inward: they let outside agents reach in.

One provider on that outward-pointing side loops back to *this* server: WS-11's `claudeCli` driver (`server/ai/drivers/claudeCli.ts`) spawns a local `claude` subprocess as a chat provider — the CLI owns its own agent loop internally rather than going through Studio's `runToolLoop` (see `docs/features/agent.md`'s "loop-ownership fork"). Step 3 points the subprocess's own `--mcp-config` at `/_studio/mcp` — the exact endpoint this document describes — with a connector token minted and scoped to the single chat turn (`server/ai/mcp/sessionConnector.ts`), so a `claude` turn gets Studio's real toolset through the same connector-bridge machinery an external Claude Code connector uses, instead of duplicating tool routing a second time. Unlike a connector a human creates in the Connectors UI (long-lived until explicitly revoked, gated by `requireStepUp` on creation), a claudeCli session connector is server-minted, never asked for, and capped at the caller's own capabilities.

**Its lifetime depends on which spawn path served the turn** (W4-2B):

- **Warm session (the normal path).** A conversation keeps one `claude` subprocess alive across its turns, so the token is **conversation-scoped**: minted with the process, revoked when that session is disposed. It has to be — the CLI reads `--mcp-config` and authenticates its MCP clients *once*, at startup, so revoking after turn 1 would leave a running session holding a dead token and silently toolless for turn 2. Every path that ends a session revokes it: idle timeout (10 min), max lifetime (60 min), a changed reuse fingerprint, pool eviction, crash detection, conversation delete, and "Restart agent session". The `createConnector` 1-day TTL floor remains the backstop, as before.
- **Cold turn (crash recovery, and any turn no warm process can serve).** Unchanged: minted per chat message and revoked in a `finally` block the instant the turn ends.

The two in-memory registries keyed by the connector id — the permission gate and the workspace binding — are **re-bound on every turn regardless of path** (`bindConnectorRegistries`, `server/ai/drivers/claudeCliConnector.ts`). That is not an optimisation detail: `bridge` is the live browser connection that relays Allow/Deny cards and is a different object after a reload or a second tab, and `workspaceDir` changes the moment the user opens another project. Binding them once at spawn would relay a permission prompt down a dead socket and point the turn's writes at the previous project.

The server is implemented with the official `@modelcontextprotocol/sdk`. That package is banned everywhere else in the tree (the AI drivers hand-roll provider REST); it is allowed **only under `server/ai/mcp/`**, scoped by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Studio is an MCP server.** One Streamable-HTTP endpoint at `/_studio/mcp` serves both local and remote clients (local is just `localhost`).
- **Thin adapter over the existing tool engine.** No tool logic is duplicated. MCP is a new *caller* alongside the built-in agent and the plugin host; tool dispatch reuses `executeAiTool`.
- **Tool surface = the full catalog.** Server-resolved tools (`site_list_documents`, `site_read_styles`, and explicit `site_publish`) run headless — no editor needed. Every browser-execution tool the agent panel has is exposed too, **relayed to the open Site workspace** — the single source of truth for edits. If that workspace is not open, its tools return a clear error; headless tools still work.
- **Visual verification is headless.** `studio_screenshot`, `studio_export_frames`, `studio_compare`, `studio_computed_styles` and `studio_measure_element` render in a server-side browser against what is on disk — they need no Studio tab open and never disturb one that is. The live editor bridge is their fallback, and stays the deliberate choice for state only an open tab holds (the current selection, an unsaved in-progress edit). **`studio_upload_asset` is the one Studio tool that still requires an open tab**, because it posts as the signed-in user. See "Headless capture".
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
| `handlers/editorBridge.ts` | `GET /admin/api/ai/editor-bridge?scope=site&dir=<project>` — the capability-gated NDJSON stream the workspace holds open. The bridge registers under `site:${projectKey}` (W10), and the server derives that key from the VALIDATED `dir` — a client that could name its own key could name another project's. A missing or uncontained `dir` yields 400, never a bridge on a guessed project. |
| `capture/` | **Headless agent capture (W4-2A).** `captureFrames.ts` (headless-first / live-bridge-fallback routing), `headlessCapture.ts` (the driver), `browserPool.ts` (one warm Chromium, N pages — shared with `studio_render_reference`; `prewarmCaptureBrowser` launches it on project open, W9-5), `captureRoute.ts` + `capturePayload.ts` + `captureToken.ts` (the `/admin/agent-capture` surface and its single-purpose grant), `captureOrigin.ts` (which origin to navigate to). See "Headless capture" below. |
| `handlers/editorBridge.ts` | `GET /admin/api/ai/editor-bridge?scope=site` — the capability-gated NDJSON stream the workspace holds open. |
| `capture/` | **Headless agent capture (W4-2A, extended by W9-6).** `captureSession.ts` (open + settle + validate one capture page — the five steps both drivers share), `captureFrames.ts` (headless-first / live-bridge-fallback routing), `headlessCapture.ts` (the rasterising driver), `headlessFrameInspect.ts` (the QUESTION-asking driver behind `studio_computed_styles` / `studio_measure_element`), `browserPool.ts` (one warm Chromium, N pages — shared with `studio_render_reference`; `prewarmCaptureBrowser` launches it on project open, W9-5), `captureRoute.ts` + `capturePayload.ts` + `captureToken.ts` (the `/admin/agent-capture` surface and its single-purpose grant), `captureOrigin.ts` (which origin to navigate to). See "Headless capture" below. |
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
the shipped `@core/ast-codemods`, plus the WS-4 instance-model verbs
`detach`/`swap`/`extract-component`). `studio_create_page` (9.1, above) rounds
out the write surface with the one operation none of these three cover:
scaffolding a brand-new page file.

**Review comments** — `studio_list_comments` (read, ungated),
`studio_reply_comment` and `studio_resolve_comment` (both `studio.write`). These
let an agent close a human review thread end to end: read what is outstanding,
edit, reply in the thread, resolve. `studio_resolve_comment` carries an extra
gate none of the other write tools need — it re-resolves the comment's anchor
against the live source and REFUSES on `drifted`/`detached`, because a Studio
node id is a source position and an agent acting on a rotten one edits the wrong
element in the user's real file. See
[`studio-comments.md`](studio-comments.md#the-agent-loop).

**The live-reload bridge** (mcp-tooling) — the piece that makes these four
writes actually visible on an open canvas without a manual reload.
`studio_apply_edits`/`studio_codemod` map every file they touched back to a
page id (`server/ai/mcp/tools/studio/touchedPageIds.ts`, reusing
`assignPageIds`/`pageIdFromRelPath` from `studioPageLoad.ts` — never a second
id-derivation); `studio_create_page` already knows its own new page id;
`studio_set_frames` touches no page content, only `.studio/boards.json`. All
four report the result in their own JSON payload (`pageIds`) AND, best-effort,
push a `studio_live_reload` request down the caller's own open Site workspace
bridge (`liveReloadPush.ts` → the SAME `toolRequest`/`toolResult` transport
every browser tool rides, but never registered/discoverable as a real tool).
The browser handler (`src/admin/pages/site/agent/studioLiveReload.ts`) fetches
ONLY the named pages via the `?pageIds=` filtered `GET /admin/api/studio/load`
(server-16) and patches them into the store via `patchPages` (store-04) —
which never marks the store dirty, so this cannot re-enter as an autosave —
or, for `studio_set_frames`, re-fetches `.studio/boards.json` while preserving
the user's current board. No open workspace (the common case for a headless
connector) makes this a pure no-op: the disk write already succeeded either
way, and a stale canvas is the honest, expected outcome until the next reload.

**Asset tools, headless:** `studio_fetch_remote_asset({ dir?, url, targetDir? })` — `execution: 'server'`, requires `studio.write`. Fetches an `http(s)` URL server-side and lands the response as a new image file, the way an asset an external MCP tool already returned as a URL (a connected Figma MCP server's export/download tool, most concretely — see `docs/features/agent.md`'s "Figma asset workflow") reaches the repo WITHOUT its bytes ever transiting the calling model, unlike the browser-relayed `studio_upload_asset` (§ below), whose `imageBase64` input requires the caller to already hold the bytes. Untrusted-URL-safe by construction: `http:`/`https:` scheme only, no redirect ever followed, the response capped at 25 MB by streamed byte count, and the result written through the same magic-number-sniffed, SVG-sanitized, containment-checked pipeline (`server/handlers/studio/assetLanding.ts`) `studio_upload_asset` uses — one write path, two callers.

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

- `studio_export_frames` — `execution:'server'`, `mutates:true` + `studio.write`.
  Routes through `capture/captureFrames.ts`: **headless first**, the live
  editor bridge as fallback and as the deliberate choice for state only an open
  tab holds. `source` picks explicitly (`auto` | `headless` | `live`), and the
  result carries `capturedVia` saying which answered.
  - **Headless (default).** A server-side Chromium loads `/admin/agent-capture`
    and rasterises each frame. Needs no browser tab, and never scrolls, zooms
    or re-pages one that is open.
  - **Live.** The original path, unchanged: relay to the connector owner's open
    Site workspace, where `src/admin/pages/site/agent/studioExportFrames.ts`
    captures the REAL, already-mounted board frame — forcing zoom to 1, panning
    the page fully on screen, activating it, waiting for mount + settle, then
    reusing `site_render_snapshot`'s capture pipeline (`renderEvidence.ts`).
    Its side effect is why it is no longer the default: it takes over the live
    canvas's pan/zoom/active-page (clearing node selection) for the batch. It
    remains the ONLY way to see the user's current selection, an in-progress
    edit not yet saved to disk, or an unpersisted board re-frame.

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
  Y," not "the images look different." `studio_diff_frames` also accepts a
  `referenceId` instead of a second base64 PNG — see "Design references"
  below — in which case a dimension mismatch is RECONCILED (dpr-matched or
  labelled-resampled) rather than refused; the plain two-PNG `reference` path
  keeps its original strict behavior unchanged.

**Design references** — a durable, per-project, addressable-by-id store
(`server/handlers/studio/designReferenceStore.ts`) for a ground-truth design
comp (typically a Figma export) an agent measures a Studio frame against,
closing the gap where a design pasted into chat was only ever a transient,
re-encoded attachment with no handle a tool could address on a later turn.
Stored under `.studio/references/` — deliberately NOT `.studio/cache/`
(disposable, regenerable build output; a design reference is user-supplied
intent that cannot be regenerated) and not the project's own `src/assets`
(never an `<img>` import target). `.gitignore` excludes the directory anyway: a multi-megabyte
PNG is a real, ongoing cost to keep in a git-tracked project, so durability
here means "survives across chat turns/restarts on the running server's
disk," not "survives a git clone." The store is addressable by id and a
project may hold many references (one per page, scoped by `pageId`); `POST
/admin/api/studio/reference-upload` (the chat panel's own attachment
control) is a thin HTTP projection over the SAME store for the simpler
"currently attached reference" model a human uses — one write path, two
callers.

- `studio_import_figma_frame({ dir?, pageId, url?, exportPath?, node?, variables?, mode?, label? })` — `execution:'server'`, requires `studio.write`. The Figma-link pipeline as ONE call (W9-4): registers `exportPath` as a `role:'spec'` reference at **`mode:'strict'` by default**, ingests `variables` scoped to that reference, and sets `pageId`'s board frame from `node.absoluteBoundingBox` — the step that makes a later `studio_compare` exact rather than silently resampled. **Studio fetches nothing and holds no Figma credential**: `url` is provenance text, parsed into `{ fileKey, nodeId }` and echoed back for the caller's own connector. `node` accepts Figma's raw metadata unedited (`additionalProperties: true`, traversal capped at 5000 nodes); `visible:false` subtrees are counted and named back, never descended into. A SECTION of sibling screen-sized frames resizes nothing and enumerates the screens instead — pages are never auto-created. Each leg reports its own status code (`frame.status`, `reference.status`, `variables.status`, `screenDetection`) so one failing leg does not fail the import. Full code table: [`agent.md`](agent.md).
- `studio_register_design_reference({ dir?, url?, path?, imageBase64?, pageId?, label?, source?, role?, mode?, passScore?, maxRegionCoverage? })` — `execution:'server'`, requires `studio.write`. Exactly one of `url` (fetched server-side via `fetchRemoteBytes`, the same SSRF-hardened primitive `studio_fetch_remote_asset` uses — bytes never transit the caller), `path` (a file already on disk inside the project), or `imageBase64`. Stores the ORIGINAL bytes verbatim — re-encoding a measurement baseline would defeat the point of keeping one. Raster only (PNG/JPEG/GIF/WEBP/AVIF); SVG is refused (no fixed intrinsic pixel size to diff against). `role` defaults to `'spec'` here: reaching this tool is the deliberate act. `mode`/`passScore`/`maxRegionCoverage` are recorded per reference for the fidelity-modes work and are not read by any tool yet.
- `studio_list_design_references({ dir?, pageId?, limit? })` / `studio_read_design_reference({ dir?, referenceId, includeImage? })` / `studio_delete_design_reference({ dir?, referenceId })` — headless reads plus an idempotent delete (removing an unknown id is `{ ok:true, removed:false }`, never an error). `includeImage:true` returns the original bytes as an MCP image block; omitted, only metadata (id, dimensions, content hash, `pageId`/`label`/`source`/`role`) comes back. `role` is always present on a listed entry even when the manifest row predates the field — the two readers project `designReferenceRole`'s derivation rather than showing a gap.

**Variant planning — `studio_plan_variants` / `studio_list_variant_sets`.** Both server-resolved. `studio_plan_variants({ dir?, baseName, brief, count?, rngSeed? })` requires `studio.write` (it persists `.studio/variants.json`) and returns N style seeds for one brief — type contrast, spacing density, corner family, accent, every value a token the project already declares — plus a self-contained `directive` per variant and the page name it owns (`Home` → `HomeA`/`HomeB`/`HomeC`). It deliberately **does not** create the pages or place them on the board: page creation and board geometry belong to the orchestrator, and a `dir` is the only path input (there is no caller-supplied output directory anywhere in this family). A `baseName` that is not a bare PascalCase identifier is refused by name, because it becomes a real `.tsx` file name. `studio_list_variant_sets({ dir?, setId? })` is a plain read of the recorded sets, newest first, capped at 10; an unknown `setId` is refused with the ids that do exist. Design and rationale: [`agent.md`](agent.md) → "Fidelity modes".

**Which reference a tool call means — roles and precedence.** `resolveDesignReference` (`server/ai/mcp/tools/studio/referenceResolve.ts`) is the one implementation `studio_compare`, `studio_measure_reference`, `studio_extract_reference_asset`, and the page-write verification gate all share. Every reference carries a **role**: `spec` (a design to match — an explicit register call, or a file picked through the composer's DESIGN REFERENCE control) or `context` (an image that arrived in the conversation; `registerTurnDesignReferences` registers every chat attachment this way). The precedence, when no `referenceId` is passed, is role first and page scope second:

1. `spec` scoped to this page
2. `spec` with no page scope
3. `context` scoped to this page
4. `context` with no page scope

The first non-empty tier decides. If it holds **more than one** candidate the call is REFUSED by name — the ids, dimensions and labels, plus the `referenceId` argument that ends it — because there is no honest tie-break: "newest" is precisely the rule that let a pasted "why does this look wrong?" screenshot become a page's comparison spec, and "oldest" fails the user who registers a corrected export. A reference scoped to a **different** page is never a candidate at all, and that case gets its own refusal rather than the generic "nothing is registered" one. A single `context` image still resolves, so paste-a-comp-and-build is unchanged.

Manifest rows written before `role` existed carry none; `designReferenceRole` derives one from `source` (`chat-attachment` → `context`, anything else → `spec`), which is the same conclusion a human reading the file would reach. No rewrite pass runs — a row gains an explicit `role` only when it is next written.

**Under `strict` fidelity, tier 2 is refused.** A `spec` with no page scope standing in for a screen that has none of its own is a guess — fine for `balanced`, and the wrong thing to build a 99%-similarity verdict on. `studio_compare` turns that into a named per-page refusal that says to register the screen's own design or pass `referenceId`, and says explicitly that lowering `fidelityMode` is not the fix. A reference's own `mode` is also tier 2 of the fidelity precedence chain — see [`agent.md`](agent.md) → "Fidelity modes".
- `studio_recommend_export_dpr({ dir?, pageId, referenceId })` — computes the `studio_export_frames` `dpr` that lands its capture on the reference's own pixel WIDTH, using the frame's AUTHORED width from `.studio/boards.json` (before any capture happens). This is the primary path: resampling a registered reference to match a capture is the WORSE option (interpolation artifacts show up as diff noise in exactly the regions being measured, and it degrades a baseline kept lossless on purpose) — matching the export resolution to the reference up front makes an exact, non-resampled `studio_diff_frames` comparison the common case. Height is content-driven (scroll-unroll can make the real capture taller than the frame's nominal height) and is not predicted by this tool.

**Runtime diagnostics — `studio_page_diagnostics({ dir?, pages?, limit? })`.** `execution: 'server'`, relayed to the open board (the same split `studio_screenshot` uses: the server half resolves screen NAMES to page ids and owns the "no board connected" message, the browser half does the read). A pure READ — no `mutates`, no `requiredCapabilities` — and deliberately NOT a board sync: placing a frame would be a mutation, and "this page has no frame" is a real answer this tool reports rather than papers over.

The gap it closes: a frame whose component throws renders as a blank rectangle, `studio_screenshot` returns that rectangle with no error, and every other tool agrees with it — `studio_compare` reports ~100% different, `studio_quality_check` reads a stylesheet that never ran. So the loop after a blank frame was screenshot → edit CSS → screenshot, against a page that never executed, while the one fact that ends it in a step sat unread in the frame's own console.

Collection is a canvas injector (`src/admin/pages/site/canvas/CanvasDiagnosticsInjector.tsx`, mounted by `IframeFrameSurface` in every frame) writing into a per-frame buffer keyed by the iframe's own `Window` (`canvasDiagnosticsBuffer.ts`) — so a re-mount or a closed board drops its buffer automatically and a stale finding can never outlive the document that produced it. The injector inserts **no DOM** into the frame (canvas rule: no wrapper elements), and identical occurrences aggregate onto one finding with a `count` rather than filling a ring buffer — a React render loop emits the same error hundreds of times, and the first error is usually the cause.

Each finding carries a stable `code`, its documented `fix`, a `count`, and — when the failure happened on an element with a `data-node-id` — the `file`/`line`/`col` that node id decodes to (`decodeSourceNodeId`), so a 404'd asset comes back as a source line rather than a symptom. Findings are capped per page (default 25) with the overflow reported as a number. Each requested page comes back with one of three statuses, kept distinct on purpose: `ok`, `no-frame` (nothing was watched — **not** a clean result), `no-collector` (frame still mounting).

The code vocabulary — frozen once shipped, same contract as `fidelityCodes.ts`, defined in `src/core/ai/pageDiagnostics.ts` and gated against this table by `pageDiagnostics.test.ts`:

| Code | Meaning |
|---|---|
| `runtime-uncaught-error` | An exception escaped to the frame's `window.onerror`. |
| `runtime-unhandled-rejection` | A promise rejected with no handler. |
| `runtime-console-error` | The frame called `console.error` — React's failed-render, invalid-hook and hydration reports arrive here. |
| `asset-load-failed` | An `<img>`/`<link>`/media element failed to load its `src`/`href`. |
| `module-resolution-failed` | An ES module specifier failed to resolve or fetch — an uninstalled dependency or a wrong path. |
| `network-request-failed` | A `fetch()` from inside the frame rejected or answered 4xx/5xx. |

Not covered, stated rather than implied: `XMLHttpRequest` and `WebSocket` are not wrapped, and anything the authored code catches itself is invisible here by definition.

**Browser-relayed (via the live workspace bridge) — require the Site workspace to be open:**
- `studio_upload_asset` — the ONLY Studio tool left in this class (W9-6). It posts real `FormData` to `/admin/api/studio/asset-upload` as the signed-in user, and that endpoint's authority is the operator's session, which a server-side tool has no honest way to hold. `studio_fetch_remote_asset` is the headless alternative when the bytes are already at an `http(s)` URL. Everything else that used to be here — `studio_computed_styles`, `studio_set_frame_axes`, `studio_duplicate_frame_as_variant` — now runs server-side; see "Headless frame reads" and "Board writes are file writes" below.
- Structure editing — `site_insert_html`, `site_replace_node_html`, `site_delete_node`, `site_move_node`, `site_duplicate_node`, `site_rename_node`, `site_update_node_props`.
- HTML/CSS authoring (`site_apply_css`, `site_assign_class`, `site_remove_class`), page lifecycle (`site_add_page`, …), design tokens (`site_set_color_tokens`, …), code assets, structure reads (`site_read_document`), and live-DOM reads (`site_render_snapshot`, `site_get_node_html`).
- These have no server implementation — their logic runs in the browser against the live workspace state, routed to `SitePage`. Image attachments (e.g. `site_render_snapshot`'s PNG) come back as MCP image content blocks. No workspace connected → a clear error asking the operator to open the Site editor.

## Live editor bridge

`server/ai/mcp/editorBridge.ts` keeps one bridge per user (newest connection wins). A connector can only reach **its own owner's** Site workspace.

```
MCP browser-tool call            Site workspace (open in a browser)
   │ executeAiTool(browser)         │ useMcpWorkspaceBridge(agentProjectDir, dispatcher)
   ▼                                ▼
buildMcpServer → getEditorBridgeForUser(userId, editorBridgeScope(boundWorkspace))
   │ bridge.callBrowser(tool, input) → emits toolRequest ─────────────▶ SitePage dispatcher
   │                                                                        │ (live workspace)
   ◀───────────── POST /admin/api/ai/tool-result ◀── postToolResult ◀───────┘
```

- Browser side: `useMcpWorkspaceBridge` opens the NDJSON stream, runs each `toolRequest` through the SAME dispatcher as the built-in agent panel, and POSTs the result back. It reconnects with backoff. `SitePage` flushes pending draft changes before reporting a successful tool result, so a follow-up headless read or `site_publish` sees the persisted edit immediately; a failed save makes the MCP tool fail instead of silently publishing stale data.
- Server side: reuses the chat bridge machinery wholesale — `createBridge` issues the `AiBrowserBridge`, `resolveBridgeToolResult` settles it from the existing `/admin/api/ai/tool-result` endpoint.
- **Waiting for a reconnect.** A tool that needs the bridge asks `awaitEditorBridgeForUser`, which does not fail the instant the registry is empty: the registry is in-memory and every stream is capped at `STREAM_LEASE_MS` (120s), so a healthy session drops and re-registers on its own schedule. It waits up to two ~4s windows for the browser's 3s reconnect — or **one** window when a bridge for that `(userId, scope)` was live within the last 60s, which is exactly the reconnect case one window already covers. The full patience is reserved for a workspace nothing is known to have opened, where a cold tab genuinely takes longer.

This is why an open editor (yours, or one the agent opens) unlocks the full editing surface without reimplementing any tool.

---

## Headless capture

**W4-2A.** Visual verification used to be hostage to the user's open tab. Every
`studio_screenshot`, `studio_export_frames` and `studio_compare` relayed to the
live editor, which meant: nothing could be verified with the tab closed; each
frame cost a canvas pan + mount + settle wait; the viewport of whoever was
editing visibly jumped; and a wedged tab burned the full bridge timeout before
failing with "No Studio board is connected" — the same message for every
possible cause.

All three now try a **server-side headless browser first** and keep the bridge
as the fallback.

```
studio_screenshot / studio_export_frames / studio_compare
        │
        ▼  capture/captureFrames.ts
   ┌────────────────────────────────────────────────┐
   │ 1. headless  → mint grant → warm Chromium      │
   │                → /admin/agent-capture?token=…  │
   │                → settle → screenshot each frame│
   │ 2. live tab  → editorBridge → studio_export_…  │   (fallback, or source:'live')
   │ 3. neither   → capture-unavailable, BOTH reasons│
   └────────────────────────────────────────────────┘
```

### The capture route

`/admin/agent-capture?token=…` is a **second Vite HTML entry**
(`agent-capture.html` → `src/admin/agentCapture/`), not a route inside the
admin SPA. A separate entry makes "no editor shell" structural rather than a
promise: the bundle contains the base modules, the editor store, the canvas and
the capture app — no router, no boot probe, no toast provider, no plugin
runtime, no panels, no persistence, no autosave.

It renders with the SAME code the canvas renders with: `IframeFrameSurface` in
`interaction="capture"` mode wrapping `CanvasComposedTree`, one frame per
requested page under its own `CanvasPageContext` (the same mechanism
`BoardFrameView` uses to render several pages at once). Every design-frame
injector therefore applies — authored CSS, class CSS, project CSS, the
animation freeze, the scroll-unroll — and readiness uses `AgentSnapshotFrame`'s
own settle loop (preview data idle → DOM quiet → fonts ready → DOM quiet
again). The page publishes a validated report on
`window.__studioAgentCapture`; the driver polls one expression, then reads it
in a single `evaluate` and validates it against `AgentCaptureReportSchema`.

The wire contract for both hops lives in `@core/studio-capture` — the payload
(server → page) and the report (page → server), TypeBox on both sides.

### Why no `studio.run.project` gate

`studio_render_reference` is Tier 2 and gated because it boots the PROJECT'S
OWN dev server: `scripts.dev` runs and every dependency it imports executes.
That gate is unchanged.

Headless capture executes none of that. It renders Studio's own parse output —
the `Page` trees the bounded static evaluator produced by READING the AST —
through Studio's own module renderers. No project component is invoked, no hook
is called, no project module is evaluated; the only project-authored bytes
involved are CSS text and image files, both inert. Parse-never-execute holds
here exactly as it holds in the live canvas, so this path needs exactly the
capability the live-tab path already needs (`studio.write`) and no more. Gating
it higher would make the SAFE path harder to reach than the live path that
renders the identical DOM.

### The capture grant

Authentication is a **single-purpose capture token**, never the admin session
cookie — handing a screenshot job the operator's whole admin authority is not
something taking a picture needs. It follows `sessionConnector.ts`'s turn-token
pattern, one notch tighter:

- **No capabilities.** A grant is not a principal. It authorises exactly two
  reads — the capture payload for its own `pageIds`, and the local image assets
  those pages reference — both scoped to the ONE project directory recorded in
  the grant. `dir` never comes from the request, so there is no traversal
  surface; parsed asset URLs are re-pointed at
  `/admin/api/agent-capture/asset?token=…` server-side.
- **Minutes, not days.** 5-minute TTL, in-process registry.
- **Revoked in a `finally`** the moment the capture ends. The TTL is the net,
  not the boundary.

Any request to the namespace without a live grant — and any non-GET — gets a
bare 404.

### Resolution

`dpr` is applied as Chromium's `deviceScaleFactor`, so a frame is RENDERED at
that density rather than rasterised at 1x and scaled up. The cap that applies
is the shared one in `@core/ai`'s `captureScale.ts` (`effectiveCaptureRatio`),
which the live `renderEvidence.ts` path now also calls — so a `studio_compare`
verdict does not depend on which rasteriser produced the bytes. It is computed
first from the authored frame geometry the driver already knows, then
re-checked against the real captured bytes (a scroll-unrolled page can exceed
its authored height), with `imageScale` derived from the actual pixel width
either way.

### Headless frame reads (W9-6)

A capture page that has settled can answer QUESTIONS about a frame, not only be
photographed. Two tools do exactly that, over a second wire contract
(`@core/studio-capture`'s `frameInspectWire.ts`) and one shared driver
(`server/ai/mcp/capture/headlessFrameInspect.ts`):

| Tool | Question | Bridge fallback |
|---|---|---|
| `studio_computed_styles` | What did the CSS actually resolve to, per node — real px, real weight, real colour, and the family the text is genuinely SET IN. | **Yes.** The live tab is authoritative for an unsaved in-progress edit, and is what an install with no Chromium degrades to. `readVia` says which answered. |
| `studio_measure_element` | What did the layout actually produce — each element's box, its padding/margin/border, and the measured gap to its neighbours, beside the parent's DECLARED `row-gap`/`column-gap`. | **No.** It measures a screen the agent just wrote; the tab would only be a slower read of the same file. |

The page exposes ONE function, `window.__studioAgentCaptureInspect(requestJson)
-> responseJson`, installed at module load next to `window.__studioAgentCapture`
and called only after the readiness report flips (an inspect of a mid-layout
frame would report fonts that had not loaded and boxes about to move). Both
directions are TypeBox-validated: the page validates the request, the driver
validates the response.

**One reader, two documents.** The measurement itself is
`@core/studio-capture`'s `inspectFrameDocument`, and the LIVE tab runs the same
function against its own board-frame iframe
(`src/admin/pages/site/agent/studioComputedStyles.ts`). If the two paths had
their own readers, the number `studio_computed_styles` reports would depend on
which one answered — and a fidelity loop whose measurement moves is not a
measurement.

`headlessCapture.ts` and `headlessFrameInspect.ts` share the five steps that
open, settle and validate a capture page (`capture/captureSession.ts`), so the
grant, the ready expression and the failure vocabulary have exactly one owner.

### Board writes are file writes (W9-6)

`studio_set_frame_axes` and `studio_duplicate_frame_as_variant` were browser
tools wrapping `EditorStore.setFrameAxes`/`duplicateFrameAsVariant`, because
that is where the toolbar calls them from. But the result does not live in the
store: a frame's axes override and a variant frame are `.studio/boards.json`,
which the store is holding a copy of and POSTs back when `boardsDirty` flushes.
So the browser path was a round trip through a mutable copy in order to write a
file the server already owns — at the cost of ~8s of bridge timeout and then a
refusal whenever no tab was open.

Both are now `execution: 'server'`
(`server/ai/mcp/tools/studio/frameAxesTools.ts`). They write through
`boardFrames.ts`'s `readBoardsFile`/`writeBoardsFile` — the module whose stated
reason to exist is that every server-side write to the board's frame list has
one owner — and then `pushStudioLiveReload({ boardsChanged: true })`, so an open
board re-reads the file and the user sees the frame flip exactly as before.
Addressing is by `pageId`, with an optional `frameId`; the server has no notion
of an "active board", so the rule is the first board carrying a frame for that
page, else the first board.

### Failure honesty

A headless failure is named (`headless-browser-unavailable`,
`headless-navigation-failed`, `headless-not-ready`, `headless-page-error`,
`headless-invalid-report`, `headless-inspect-failed`) and falls back to the
bridge. When BOTH paths fail
the error is `capture-unavailable` and it states both reasons — including how
to fix the headless one (`bunx playwright install chromium`). A host with no
Chromium is a supported configuration: the first failed launch is remembered
for 60s so the fallback is immediate rather than paying a failed launch on
every call.

### Where it runs from

The driver navigates to `/admin/agent-capture` on this server when a build
exists on disk (`dist/index.html`), and to Vite's own `agent-capture.html` on
5173 in a `bun run dev` session — Vite's SPA fallback would otherwise answer
the canonical route with the main entry. `STUDIO_CAPTURE_ORIGIN` overrides the
origin for a deployment this process cannot guess.

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

## Project MCP servers (the OTHER outward-pointing direction)

`server/ai/drivers/projectMcpServers.ts` already lets a project's own `.mcp.json` reach the agent, approved by name. That covers a server the REPO declares. It does not cover a server that needs a SECRET (a Figma/GitHub token, a bearer header) — a `.mcp.json` entry is passed through verbatim, so the secret would have to live in the git-tracked file itself, which Studio must never push a user toward.

`server/ai/drivers/registeredMcpServers.ts` closes that gap: a user can register an MCP server directly in Studio, for a project, without touching `.mcp.json` at all.

- **Definition, no secret** — name/transport/command·args·url/non-secret env·headers, plus the NAMES of any secret field — lives in `.studio/meta.json`'s `registeredMcpServers`, the same "Studio's state, not the project's" home `approvedMcpServers` already uses.
- **Secret VALUES** live encrypted (AES-256-GCM, the same master key `ai_provider_credentials`/`plugin_secrets` use) as JSON files under `.data/mcp-server-secrets/<userId>/<projectKey>/<serverName>.json` (`server/ai/credentials/mcpServerSecretStore.ts`) — outside `studio-workspace/**` entirely, and `.data/` is git-ignored. A dedicated DB table would be the more conventional home for a reversible secret, but this repo's own architecture note is explicit that *Studio* state belongs on disk, not the database, and a new table needs a migration this feature didn't ship with; the disk-based store reuses the exact same encryption primitives, so nothing about "how a secret is protected" differs from the DB-backed credential stores.
- **Consent is a SEPARATE opt-in list**, `approvedRegisteredMcpServers` in `.studio/meta.json`, so a project-declared and a Studio-registered server can never share approval by sharing a name. Redefining an already-approved registered server's definition revokes its approval automatically — a changed command/URL is a new consent surface, not an update to trust already granted.
- **Merge order in `buildMcpConfig`** (`claudeCliArgv.ts`): project-declared servers, then registered servers, then Studio's own `studio` key LAST — so Studio's entry always wins any name collision from either source. Both `listProjectMcpServers` and `addRegisteredMcpServer` independently refuse the literal name `studio`. The merged config (including every resolved secret) is written to a private 0600 temp file by `writeMcpConfigFile` (`claudeCliMcpConfigFile.ts`) and passed as `--mcp-config <path>` — never as inline JSON on the command line, which `ps -eo command` would print in full to any local process.
- **Settings → AI → MCP Servers** (`src/admin/modals/Settings/sections/McpServersSection.tsx`) lists both sources with transport, command line/URL, approval state, and an Approve/Revoke control that spells out the consequence ("Studio will run this command") before granting it. For an http/sse server that supports OAuth, it renders a real "Sign in" button — a full browser OAuth flow (discovery, Dynamic Client Registration, PKCE) implemented in `server/ai/credentials/mcpOAuth.ts` / `mcpOAuthStore.ts` and `server/ai/mcp/handlers/oauth.ts`, superseding an earlier "Check for sign-in link" probe (`authProbe.ts`, deleted) that only surfaced a bare, unusable discovery URL. When the server's registration endpoint is closed to third-party clients (Figma, at present), the row instead prints the equivalent `claude mcp add`/sign-in commands for the user to run against Studio's own per-user CLI config dir. See [docs/features/agent.md](agent.md)'s "Project-declared MCP servers reach the agent only by explicit approval" section for the full OAuth/registration-closed story, including why the Claude CLI's own credential cache needed a separate fix.
- **Agent-facing tools** (`server/ai/mcp/tools/mcpServerTool.ts`, exposed like every other MCP tool via `registry.ts`): `mcp_list_project_servers` (read-only) and `mcp_propose_server`, which can register an unapproved definition and NOTHING ELSE — it cannot approve/enable a server or supply a secret value (there is no such parameter, and the module never imports the approve/revoke/secret-setting functions at all). Approval and secrets stay a human action in the Settings UI; an agent that could approve its own servers would defeat the entire consent model above.
- **A connector bound to a Studio project sees only the Studio agent toolset.** `mcpToolsForStudioWorkspace` (`server/ai/mcp/registry.ts`) — the connector `claudeCli.ts` mints for the in-canvas agent is workspace-bound (`connectorWorkspace.ts`), and that agent holds native file tools, so it is served the deliberate `studioAgentTools` subset rather than the full registry plus the CMS `site_*` set. An UNBOUND connector — a plain external MCP client, Claude Code in a terminal, a remote agent — still sees everything, including the AST edit tools it genuinely needs because it has no filesystem access to the project. Same tool objects, two compositions. Approved external servers are unaffected either way: they reach the agent through `--mcp-config`, not through Studio's own registry.

---

## The warm CLI session (W4-2B) — why a turn no longer re-handshakes every MCP server

Every `claudeCli` turn used to cold-spawn `claude`, which meant every turn re-ran `initialize` against **every** MCP server in the merged config above — Studio's own, plus each approved project and registered server. That is the largest fixed cost in a turn, and it was paid identically for "change this padding" and "rebuild the checkout screen".

WS-11 deferred the fix on an explicit, honest note: `--input-format stream-json` exists, but its stdin message shape "was never verified". W4-2B verified it by hand-driving the installed binary outside the repo. The findings are recorded in full in `server/ai/drivers/claudeCliStdinProtocol.ts` — that module doc is the source of truth, not this section — and the load-bearing ones are:

- **The envelope.** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"parent_tool_use_id":null}`, one line, `\n`-terminated. A `session_id` may be sent and is ignored.
- **Turn boundary.** Writing that line starts a turn; the single `result` line ends it. The process then accepts the next turn on the same stdin, with full context carried in memory.
- **MCP servers initialize ONCE.** A probe MCP server wired into the spike logged exactly one spawn, one `initialize`, and one `tools/list` across three turns. This is the entire prize.
- **Malformed stdin is fatal.** One non-JSON line kills the process (`SyntaxError`, exit 1) mid-conversation. Everything Studio writes goes through `encodeStdinLine`, which refuses to emit a frame containing a newline. An unrecognised *control request*, by contrast, is answered with an error and the process survives.
- **`interrupt` cancels the TURN, not the session.** Sent mid-generation it answered in ~1 ms, the running turn closed with a normal `result` (`subtype: "error_during_execution"`), and the next message on the same stdin was answered normally. Aborting is now cheap.
- **There is no `set_effort`.** Probed directly; the binary answered "Unsupported control request subtype". `--effort` is argv-only, so a turn routed to a different effort (`server/ai/routing/turnRouting.ts` picks `low` for a plain question, `medium` otherwise) **respawns**. `set_model` and `set_permission_mode` *do* exist, but both stay in the respawn key deliberately — see `claudeCliSessionPool.ts`.

Measured on a real spawn, three stdio MCP servers attached, turn 2 of a conversation, time to first stream-json line:

| | turn-2 time-to-first-line |
|---|---|
| cold spawn (`--resume`) | 840 ms / 856 ms |
| warm session | 4 ms / 4 ms |

**The cold path remains, and is not a shim.** It is the crash-recovery mechanism: a turn whose warm process is dead, or which dies before producing any output, silently re-runs cold and the user sees a normal (slightly slower) reply rather than an error about a subprocess they never asked for. Once a turn has streamed text, a death degrades to the same honest terminal error the cold path has always produced — never a silent retry that would duplicate the reply.

Module map: `claudeCliStdinProtocol.ts` (the wire format) → `claudeCliWarmSession.ts` (one live process: turns, abort, death detection) → `claudeCliSessionPool.ts` (which conversation gets which process, reuse key, idle/lifetime/pool caps) → `claudeCliWarmTurn.ts` (serving one turn: the connector, the registries, the board-state carry) → `claudeCli.ts` (try warm, else cold).

Two consequences worth knowing when reading the driver:

- **The dynamic system-prompt suffix** (board state, per-page write/verify status) rides `--append-system-prompt` at spawn, which a warm process cannot be given again. A later turn carries it **inside the user message**, and only when it has actually changed — re-sending an unchanged board digest every turn would stack a copy into the conversation's permanent history.
- **`CLAUDE.md` is read once, at startup.** `generateStudioProjectGuide` is manifest-gated and returns an empty `written` list on the common turn where nothing changed, which makes "the guide was actually rewritten" a free, exact signal that the warm session is stale — and that turn respawns.

---

## Tests

- `server/ai/drivers/claudeCliStdinProtocol.test.ts` — the stdin envelope and control frames, pinned byte-for-byte to what the spike observed the real binary accept.
- `server/ai/drivers/claudeCliWarmSession.test.ts` — turn boundaries on one stdin, abort-by-interrupt leaving the session usable, and the crash cases that must fall back rather than error.
- `server/ai/drivers/claudeCliSessionPool.test.ts` — reuse, respawn on a changed fingerprint, idle/pool-cap eviction, and the guarantee that a mid-turn session is never evicted or handed out twice.
- `server/ai/drivers/claudeCli.test.ts` (`describe('streamClaudeCli — the warm session (W4-2B)')`) — turn 2 spawning no process, respawn on effort/model change, the cold-spawn fallback with no user-visible error, and the board-state carry.
- `server/ai/credentials/mcpServerSecretStore.test.ts` — encryption round trip, path-safety, master-key rotation detection.
- `server/ai/drivers/registeredMcpServers.test.ts` — registry CRUD, approval semantics, secret resolution/merge shaping.
- `server/ai/mcp/tools/mcpServerTool.test.ts` — the propose-only consent boundary, behaviourally and structurally.
- `server/ai/credentials/mcpOAuth.test.ts`, `server/ai/credentials/mcpOAuthStore.test.ts` — the OAuth discovery/DCR/PKCE chain, token storage/refresh, and fail-closed defaults (registration-closed handling included).
- `server/ai/mcp/handlers/registeredServers.test.ts` — HTTP routing + the `ai.providers.manage` gate on every route.
- `server/ai/drivers/claudeCli.test.ts` (`describe('streamClaudeCli — Studio-registered MCP servers')`) — end-to-end merge, secret decryption at spawn time, and the collision-with-`studio` guarantee.
- `server/ai/mcp/connectors/{token,store}.test.ts` — token hashing, expiry, and store CRUD.
- `server/ai/mcp/{registry,auth,server,transports/http}.test.ts` and `server/ai/mcp/tools/documentTools.test.ts` — capability filtering, headless document listing, bearer auth + 401, scoped workspace relay, full MCP round-trip, HTTP handshake.
- `server/ai/mcp/publishTool.test.ts` — explicit MCP publish rebuilds and swaps the real static CSS/HTML slot and records connector audit metadata.
- `server/ai/mcp/tools/studioImportTool.test.ts` — capability gating, the `dir`-stripping input schema, the imported-pages summary helper, and an end-to-end handler run against a stubbed global `fetch` (no real network calls); `server/handlers/__tests__/studioGithubImport.test.ts` covers the underlying import engine itself.
- `server/ai/mcp/tools/studio/{projectTools,editTools,fidelityReport}.test.ts` — orientation/edit/fidelity tool handlers against temp fixture projects; `fidelityCodes.test.ts` — doc ⇄ code parity gate against `docs/features/studio-import.md`'s table.
- `server/ai/mcp/resources.test.ts` — `studio://guidelines` resource listing/read.
- `server/ai/mcp/capture/captureToken.test.ts` — grant scoping (project + page set), immediate revocation, expiry, and that a caller cannot widen a grant after minting it.
- `server/ai/mcp/capture/captureFrames.test.ts` — the routing decision: headless first, bridge fallback, `source:'live'`/`'headless'` overrides, and that a both-paths failure names BOTH reasons instead of blaming a missing board.
- `server/ai/mcp/capture/headlessFrameInspect.test.ts` — the frame-inspect driver: that the readiness poll happens BEFORE the inspect call, that the request crosses as a JSON string literal the page can parse back, that the grant is revoked however the call ends, and that an unvalidatable response is refused rather than trusted. Chromium is faked; the token, the settle session and both validations are real.
- `src/core/studio-capture/frameInspector.test.ts` — the shared reader, against a real document: which nodes a `textOnly` sweep skips (and that an explicitly-named node is reported anyway), that a node's OWN text excludes its descendants', selector/nodeIds unioning, and the string boundary's refusals (bad JSON, bad schema, no settled frame).
- `server/ai/mcp/tools/studio/computedStyles.test.ts` — the routing decision only: headless answers with no bridge touched, a dead browser falls back to the tab and says why, and a both-paths failure names BOTH reasons.
- `server/ai/mcp/tools/studio/measureElement.test.ts` — the ritual on a real fixture project (board reconciliation, then measure — and, since W9-5, an assertion that NO live-reload round trip is taken) plus screen-name resolution.
- `server/ai/mcp/tools/studio/frameAxesTools.test.ts` — `studio_set_frame_axes` / `studio_duplicate_frame_as_variant` against a REAL `.studio/boards.json`, re-read through `parseBoardsFile` after every write. No browser anywhere, which is the regression it pins.
- `server/ai/mcp/capture/headlessCapture.test.ts` — headless capture end to end against a real fixture workspace, including **W4-2A's definition of done: `studio_compare` across five pages with no editor bridge connected**. Everything server-side is real (the capture route handler, token minting/resolution/revocation, the payload builder running the real `loadStudioPages` parse, the driver, the resolution clamp, and the whole of `studio_compare` including pixelmatch diffing and the verdict cache). Only Chromium is faked — CI has no browser binary — and the fake still calls the real route with the token out of the navigation URL and validates the payload against the shared schema, so a broken route or a rejected grant fails the test. What it stands in for is rasterisation alone.
- `server/handlers/studio/designReferenceStore.test.ts` — register/list/get/read/remove against real sharp-encoded PNG/JPEG bytes, containment, idempotent delete, and graceful degradation when a registered file is missing from disk.
- `server/handlers/studio/referenceUpload.test.ts` — the chat panel's `POST/GET/DELETE /admin/api/studio/reference-upload` HTTP contract end to end.
- `server/ai/mcp/tools/studio/designReferenceTools.test.ts` — the five design-reference MCP tools' shapes and handlers, including the dpr-recommendation math.
- `server/ai/mcp/tools/studio/diffFrames.test.ts` — the pre-existing generic two-PNG contract plus the new `referenceId` path's exact/resampled/aspect-ratio-refusal cases, against real registered references.
- `src/__tests__/ai/mcpConnectorsHandler.test.ts` — CRUD, step-up, privilege floor, capability gating.
- `src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts` — token never serialized.


## Sessions are per (account, project) — W10

An agent conversation belongs to one account **and** one project. Four things changed:

- **`ai_conversations.project_key`** (migration 022, both dialects, nullable, no backfill) is `registeredMcpServerProjectKey(dir)` — the same key MCP OAuth sessions and registered-server secrets already use. `null` means "not project-scoped": every thread that predates the column, and every thread started with no project open. The list route (`?dir=`) returns this project's threads plus the null ones; `chat.ts` refuses a turn whose project disagrees with a stamped key (409) and adopts a null one on first use, conditionally in SQL so two tabs cannot double-stamp.
- **The editor bridge scope is `site:${projectKey}`**, so two tabs on two projects are two independently addressable bridges. Before, one slot per user meant last-registered won and a tool call could be relayed into the wrong project's tab with nothing reporting a mismatch. An **unbound** connector — an external MCP client with no editor tab — keeps the old "whatever this user has open" routing (`getMostRecentEditorBridgeForUser`), because it has no project to name.
- **The warm CLI pool is keyed `(userId, conversationId)`**, `userId` is in the reuse fingerprint, there is a per-user cap of 2 under the global 8, and the attachment staging root hashes both ids.
- **`resolveProjectDir` containment-checks every client-supplied `dir`** against `projectsRootDir()`, realpaths resolved on both sides. It throws `ProjectDirOutsideWorkspaceError`; `server/router.ts` answers a flat 404 once for every route, and any route-local `catch` that turns errors into responses calls `rethrowProjectDirRefusal(err)` first so the refusal is not flattened into thirty different answers. A **workspace-bound** connector may name only its own project — an explicit `dir` for a different one raises `ProjectDirMismatchError`.
