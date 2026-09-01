# Studio — CMS residue removal

**Status:** Tier 0 in progress · Tiers 1–3 blocked on one product decision
**Audit date:** 2026-09-01 · four read-only agents (reachability, server/DB, admin/UI, measurement)

---

## Read this first: the headline is not what you expect

**There is no "CMS half" left to delete.** The standalone Content / Data / Media /
Users workspaces were already removed from routing. `src/admin/router.tsx:51-81`
and `src/admin/workspace.ts:22-26` define exactly four sections: `dashboard`,
`site` (Studio), `pluginPage`, `account`. The router's own comment says so.

What remains is three different things, and conflating them is how this goes wrong:

1. **Genuinely dead code** — residue left behind by that earlier removal.
2. **Load-bearing infrastructure wearing CMS-shaped names** — auth, page-tree,
   module-engine, `@core/publisher`. Deleting these breaks Studio.
3. **One live entanglement** that needs a product decision.

**The bundle prize is ~3%, and most of Tier 0 is 0%.** Every dead cluster below is
already tree-shaken out of the build — the chunk table was grepped for each name
and returned zero matches. Deleting 5,291 lines that ship 0 bytes changes the
user download by 0 bytes. **Scope this work as maintenance, not performance.**

| Dimension | Total | Removable | Share |
|---|---|---|---|
| Shipped JS | 5,000 kB | ~130–150 kB | **~3%** |
| Source lines (src+server, excl. tests) | 319,907 | ~45,000 | ~14% |
| Test lines | 205,837 | ~30,000 | ~15% |
| `node_modules` | 830 MB | ~10.8 MB | ~1.3% |
| Dependencies | 144 | 12 | ~8% |

---

## Traps — read before touching anything

### 1. `@core/publisher` is NOT the publisher you want to delete

Two directories share the name and have **opposite** verdicts:

- **`src/core/publisher/` (3,980 lines) — LOAD-BEARING. Never delete.**
  Studio's AI executor imports `renderNode` (`executor.ts:75`); `PreviewOverlay.tsx:21`
  calls `publishPage` client-side; `ClassStyleInjector.tsx:65` imports
  `PUBLISHER_RESET_CSS`/`collectBackgroundImagePaths`; base image/video modules
  import from it. This is the "single class-CSS emission engine for publish and
  canvas."
- **`server/publish/**` (5,298 lines) — removable, with a caveat (Tier 2).**

`docs/agent-refs/path-index.md:246` files `src/core/publisher/` under "Not ours
(dormant CMS)". **That is wrong** and has already misled one audit. Fix it.

### 2. Bundled ≠ executed

`src/core/persistence/{cms,cmsData}.ts` are *imported* (so they are bundled) but
never *invoked* once `fsCodemodAdapter` is selected. `usePersistence.ts:43`
imports `cmsAdapter` as a default parameter; `PublishButton.tsx:3` imports
`getCmsPublishStatus` but the button is swapped out in Studio mode
(`AdminCanvasLayout.tsx:252-270`).

A deletion scoped by "is it imported?" keeps dead code. One scoped by "does it
run?" deletes live code. **Scope by neither alone — verify both.**

### 3. The migration floor

Committed migrations can never be deleted or rewritten, and the runner replays
full history on every boot. `data_tables`, `data_rows`, `media_assets`,
`installed_plugins` and ~20 others **exist forever on every install**, seeded,
whether or not any code reads them.

**This plan shrinks the codebase, not the schema.** If the goal was database
footprint, it cannot be met this way.

### 4. Studio is not DB-free

Its own state lives in `ai_conversations`, `ai_messages`,
`ai_provider_credentials`, `ai_defaults`, `ai_model_pricing`,
`ai_mcp_connectors`, plus shared `users`/`sessions`/`roles`. Not residue.

---

## Tier 0 — safe, no decision needed · IN PROGRESS

| Item | Lines | Bundle |
|---|---|---|
| Dashboard widget-grid (`DashboardGrid`, `BlockLibrary`, 9 widgets, hooks) | 5,291 | 0 (tree-shaken) |
| Media workspace browser (`MediaCanvas`, `MediaFolderPanel`, `MediaSidebar`, `MediaStoragePanel`, DnD utils) | 3,509 | 0 |
| `Widget` / `WidgetList` / `charts` primitives | 975 | 0 |
| `core/data/duplicateRow.ts` + test | 144 | 0 |
| **11 `@tiptap/*` packages** — 0 imports, 0 chunks | — | **7.6 MB `node_modules`** |

**Must stay** despite living in the same folders: `useMediaWorkspace.ts`,
`folderTree.ts`, `smartFolders.ts` (consumed by the live `MediaPickerModal`);
all of `src/admin/shared/media/` outside the listed browser UI.

**Out of scope deliberately:** `src/core/dashboard/registry.ts` and the
`dashboard.widgets.register` plugin capability. Retiring a documented SDK
capability is a separate product call, even though `CLAUDE.md` says the SDK
carries no backward-compat guarantee yet. Also `@core/dashboard`'s
`PixelArtIconComponent` type — two live Studio files import it.

**Gates to update in the same PR:** `media-storage-panel.test.ts` (guards a route
that no longer exists), `mediaWorkspaceFolders.test.tsx`,
`single-drag-mechanism.test.ts` allowlists.

### Also in Tier 0: the one real perf item

`AdminCanvasLayout.tsx:204` calls `useInstalledEditorPlugins` **unconditionally** —
no `studioMode` gate, though the same file computes `studioMode` at line ~186.
It chains to `listCmsPlugins` → `apiRequest('/admin/api/cms/plugins')` →
repository → **a database round trip on every Studio mount**, and pulls ~95 kB of
plugin-runtime chunks Studio never uses.

Constraint: Settings → Plugins is reachable *from inside* a Studio session, so the
gate must be lazy/on-demand rather than absolute if activation is a precondition
for that UI.

---

## Tier 1 — safe, larger, needs gate + doc work

**The plugin subsystem, ~20,265 lines:** `server/plugins/` (9,560) +
`src/core/plugins/` (2,836) + `src/core/plugin-sdk/` (5,964) + QuickJS bootstrap
(1,905), plus the `quickjs-emscripten` dependency (2.4 MB).

Zero references from Studio canvas (`src/admin/pages/site/`) or Studio handlers
(`server/handlers/studio/`) — verified, 0 grep hits.

Cost: **18 architecture gates** deleted or rewritten, ~136 test files, 14 docs.

---

## Tier 2 — blocked on a product decision

### `server/publish/**` (5,298 lines)

Clean of Studio's own tree, **but reachable from the external MCP connector
surface**: `server/ai/mcp/tools/publishTool.ts:14` imports `publishDraftSite`,
and `server/ai/content/treeService.ts:23` imports `publish/contentEvents`.
Studio's in-canvas agent has no publish tool (0 hits in
`STUDIO_AGENT_TOOL_NAMES`), so this is purely about whether external MCP clients
keep `site_publish`.

**Decision needed:** do external MCP clients still need to publish?

### CMS bundle import/export (~105 kB lazy)

`SiteImportModal` mixes a **live Studio feature** (drag in a folder of HTML/CSS,
committing via `mutateAllPagesAndSite`) with a dormant CMS bundle importer in one
component tree. Needs a surgical split, not a delete:

- Keep: `DropStep`, `AnalyzeStep`, `ConflictsStep`, `@core/siteImport`.
- Remove: `CmsBundleAnalyzeStep`, `CmsBundleConflictsStep`, `cmsBundleFlow.ts`,
  `useCmsBundleImport.ts`, all of `SiteExportModal`/`ExportDialog`, the
  "Export Site" Spotlight command, `core/data/{bundleArchive,bundleSchema,bundleSelection}.ts`,
  `cmsTransfer.ts`, `server/handlers/cms/{export,import*}.ts`.

**Decision needed:** is portable full-site export/import between installations
still a product requirement?

---

## Tier 3 — do not touch

`server/auth/` (1,572 lines — Studio has no independent login; every Studio
route, the MCP endpoint and every AI handler gate through it) ·
`src/core/page-tree/` (177 Studio import sites) · `src/core/module-engine/` (53) ·
`src/core/publisher/` (see Trap 1) · `src/modules/**` (all 17 base modules map to
real Studio features; no leftover CMS-only block module exists).

---

## The decision that unlocks the rest

**Do live CMS installations still matter for this fork?**

- **Yes** → stop at Tier 1. Gate rather than delete. Keep the migrations, keep
  the adapter switch.
- **No** → Tiers 2–3 open up, and the `?studio` flag in `AdminCanvasLayout` can
  collapse entirely — one mode, one adapter, one code path. **That is the real
  simplification, worth more than any line count in this document.**

---

## Verification notes for whoever picks this up

- Deletion PRs fail through *missing* imports, so `tsc -b` (`bun run build`) is the
  primary safety net. Treat any new TS error as evidence you deleted something live.
- Attribute failures against a **detached `git worktree` baseline at HEAD**, not
  against agent self-reports. Known pre-existing and not yours:
  `projectMcpApprovals.test.ts` (missing `./agentRosterMcpTools`),
  `binding-compatibility-coverage.test.ts`, `admin-spacing-token-policy.test.ts`,
  and canvas batch-run isolation flakes.
- **Do not run `git stash` in this working directory** — it is shared with parallel
  sessions and has already surfaced foreign conflicts. Use `git worktree add --detach`.
- `knip`/`fallow`/`madge` all produce false positives here: barrel files whose
  consumers import the concrete component (e.g. `BoardCommentsLayer/index.ts`),
  and `server/plugins/quickjs/bootstrap/src/*.ts` which is bundled to committed
  string artifacts via `bootstrap:sync`. Run `madge` with `--ts-config tsconfig.json`
  or it flags every aliased barrel as an orphan (1,261 false orphans → 22 real).
