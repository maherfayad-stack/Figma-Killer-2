# Wave 7–10 train — closing status

Written 2026-09-07 when the user asked to finalize the train early. Companion to
[`STUDIO-WAVE7-PLAN.md`](STUDIO-WAVE7-PLAN.md) (the plan) and [`STATE.md`](STATE.md)
(per-task handoffs + dogfood checklists). Update the tables below as the last PRs land.

## Merged on `main`

| PR | Row | What shipped |
|---|---|---|
| #45 | W9 | Fidelity bench harness |
| #46 | W9-1d | All 31 agent tools documented; stale claims in `remoteAssetFetch.ts`, `systemPrompt.ts`, `agent.md` corrected (STATE `docs-06`) |
| #47 | W8-1 | Bare-number bug fixed via `resolveCommitValue`; one 1/10/0.1 nudge model; math expressions in fields; Enter keeps focus; Flip H/V; `color`→Fill, `textShadow`→Effects; §5 "The field model" doc (STATE `panel-13`) |
| #48 | W9-1a | `role` on design references, four-tier precedence, chat images as context, `mode`/`passScore`/`maxRegionCoverage`, ambiguity names both candidates (STATE `mcp-20`) |
| #49 | — | Stale `routePrototypeLinks` flow test removed |
| #50 | W9-6 | `studio_computed_styles`, `studio_set_frame_axes`, `studio_duplicate_frame_as_variant` run headless; new `studio_measure_element`; `studio_set_frames` resize bug fixed (STATE `mcp-20`) |
| #51 | W7-2 | `StudioProjectSummary` (platform/framework/trust/toolchains/editedAt), `lastOpenedAt`, inline rename, project duplicate endpoint, card context menu, ⌘K projects provider (STATE `panel-14`) |
| #52 | user bugs | Inspector: rail overlap at narrow width, no accordion on empty sections, W/H equal-width fields |
| #53 | W8-2 | One scrub engine — every numeric field scrubs, nudges, does math |
| #54 | W8-4 | Export section: PNG @1×/2×/3× (server crop via `captureFrames`), SVG (served only for real SVG, refused by name otherwise), Copy CSS from provenance, Copy JSX verbatim (STATE `panel-16`). Follow-up: no rail icon for Export; `server/handlers/studio.ts` is at the 700-line ceiling — next route needs a split |
| #55 | W8-4 | Fill section edits `background-image` as N layers (`backgroundLayers.ts`, byte-identical re-join or refuse by name), per-layer satellites + blend mode, solid fill pinned bottom-most, Content fit row for `objectFit`, 4 new bag props (STATE `panel-14` dogfood script). Cut: visibility eye, pointer drag-reorder, media-library image fill |
| #57 | W10 | Conversations scoped per (account, project): migration 022 `project_key`, `?dir=` list filter, 409-on-mismatch, realpath containment in `resolveProjectDir` + `rethrowProjectDirRefusal` in every route catch-all, per-user warm pool + agent cache dirs, bridge scope `site:<projectKey>`, "Not in this project" group in the UI (STATE `server-05`) |
| #58 | W7-3 | Project thumbnails via headless capture → `.studio/thumbnail.png`, serialised queue, ETag route, Figma-tile `ProjectCard`, `projectDirGuard.ts` shared by delete/duplicate/thumbnail (STATE `server-20`) |
| #59 | W7-5 | Fact-driven onboarding checklist + `LiquidProgressRing`, `GET /onboarding`, empty-canvas hint, `examples/studio-sample-project/` + `POST /sample`, "UI copy" rules in `docs/design.md` (STATE `panel-18`) |
| #60 | W7-4 | Drag-and-drop folder import, GitHub import as a polled job with progress, import summary + pagesDir picker, trash list/restore/purge + "Trash (N)" affordance (STATE `server-20`) |
| #56 | W8-3 ph.1 | Multi-select edits inline styles across N nodes in one undo step (`setNodesInlineStyles`, `multiSelectStyleBags.ts`), Mixed rendering in the primitives, target pinned to Element with reason, `isSelectorMultiSelect` ≥2 fix, doc §9. Cut: bespoke sections (Spacing/Layout/Position/Size/Typography/Appearance/Fill/Border) still show *unset* instead of Mixed — one-line wire-up each |

## Landing now

Nothing — every agent PR from the train is merged.

## Not started (plan rows left for a fresh session)

Plan line numbers refer to `STUDIO-WAVE7-PLAN.md`.

- **W9-2 fidelity modes** (334–361) — gated on W10; shares `chat.ts` + `liveDigest.ts`
- **W9-5 speed levers** (427–456) — after W10, touches `liveDigest.ts`
- **W9-3 pair** (362–396) — after W9-2
- **W9-4 Figma-link pixel pipeline** (397–426) — after W9-2
- **W8-2 look pass + measurement gate test** (229–245)
- **W8-4 hug/fill parent-aware `elementSizing.ts`** (272–279)
- **W8-4 constraints** (285–288)
- **W8-3 phases 2 and 3** (263–268)

Sequencing rule that still applies: rows sharing an owns-entry in the matrix
(plan 517–539) never run concurrently.

## Human dogfood owed

Nothing UI-facing in this train was browser-verified by an agent (per repo rule).
`STATE.md` → `## Pending dogfood` plus the per-PR checklists in `panel-13`,
`panel-14`, `mcp-20`, `docs-06`, and the entries from the seven landing PRs.
`mcp-20` needs `bunx playwright install chromium` first.

## Loose ends found along the way

- `docs/agent.md` is ~1370 lines against a ~600-line cap — split it (flagged in `docs-06`)
- MCP wire name is still `alm-figma-killer`
- Dockerfile labels point at the upstream fork
- Stray `pnpm-lock.yaml` (repo is Bun-only)
- 3 e2e specs still drive deleted CMS UI
- `bun run fallow:health` cannot complete
- Prototype plan §1/2/4 rationale not yet migrated into the feature doc
- `liveReloadPush.test.ts` breaks in any batch containing a suite that `mock.module('../../editorBridge')` (pre-existing; `compare.test.ts` does it on main)
- `generateStudioProjectGuide` is not read-only — `healMissingDesignSystem` seeds `package.json` + `node_modules/@alm-design` into any project without a manifest
- Parallel-agent builds: 10 worktrees → ~20 concurrent `tsc -b` processes thrash and time out. Fix candidates: per-worktree `tsBuildInfoFile`, or a fleet build lock.
- `no-circular-dependencies` gate fails as a 60s timeout, not a cycle — `madge` alone takes ~82s here; raise the budget
- `STUDIO-WAVE7-PLAN.md` is not valid UTF-8 — plain `grep` matches nothing in it; use `grep -a`
- Pre-existing red tests not owned by this train: icon-catalog `chevron-left`, canvas batch-isolation cluster (green per-file), headless-capture "No Chromium"
