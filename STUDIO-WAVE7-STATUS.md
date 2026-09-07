# Wave 7–10 train — closing status

Written 2026-09-07. The train is **finished**: every plan row has a merged PR.
Companion to [`STUDIO-WAVE7-PLAN.md`](STUDIO-WAVE7-PLAN.md) (the plan) and
[`STATE.md`](STATE.md) (per-task handoffs + dogfood checklists).

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
| #56 | W8-3 ph.1 | Multi-select edits inline styles across N nodes in one undo step (`setNodesInlineStyles`, `multiSelectStyleBags.ts`), Mixed rendering in the primitives, target pinned to Element with reason, `isSelectorMultiSelect` ≥2 fix, doc §9 |
| #57 | W10 | Per-project + per-account agent sessions; `resolveProjectDir` realpath containment; `EditorBridgeScope` = `site:<projectDir>` |
| #58 | W7-3 | Launcher project thumbnails (STATE `server-20`) |
| #59 | W7-5 | Onboarding checklist, empty-canvas hint, sample project (STATE `panel-18`) |
| #60 | W7-4 | Drag-and-drop import, import progress, trash restore/purge (`projectDirGuard.ts`, `projectTrash.ts`) (STATE `server-20`) |
| #61 | — | This status doc |
| #62 | user bug | Inspector ⚙ popovers clamp to the viewport and scroll internally (`floatingViewportFit.ts`) (STATE `panel-19`) |
| #63 | W8-4 | Parent-aware Hug/Fill: `sizingAxisRole` → `flex: 1 1 0` / `align-self: stretch` / grid stretch / `100%` only under block; disabled-with-reason when the parent is unresolvable (STATE `panel-19`). Cut: a mode switch that writes two properties files two undo entries |
| #64 | W8-4 | Constraints crosshair over honest mappings (`constraintMapping.ts`): Center → `left: 50%` + standalone `translate`, refused when translate is taken; Scale → `%` insets; stretch → both insets; gated on positioned context (STATE `inspector-w8-4-constraints`). Cut: drag inside the diagram, no Scale for `position: fixed` |
| #65 | W8-2 | Look pass: panel default 290px, eight fixed-px `--inspector-space-*` tokens across 38 modules, inspector `Button`/`Select` skins, 11 in-field glyphs, `inspectorGeometryBudget.test.tsx` gate (STATE `look-pass`). Substitution: happy-dom cannot measure `scrollHeight`, so the gate budgets tokens + caption rows instead |
| #66 | W9-5 | Speed levers 1–3: whole-load memo (`studioLoadMemo.ts`, 27.5 → 2.5 ms repeat load), no live-reload wait on headless captures, Chromium prewarm on project open (STATE `perf-04`). Cut: PostToolUse live-reload nudge (auth surface), effort pin, DS guide cache, on-disk parse cache for the Stop hook |
| #67 | W9-2 | Fidelity modes creative/balanced/strict: `resolveFidelityMode` precedence, mode blocks in the static prompt prefix, per-mode thresholds + strict region floor, composer picker persisted per project and account, `compare.ts` split into `compareGrading.ts` + `compareCapture.ts` (STATE `fidelity-modes`). Cut: creative/balanced halves of the mode-aware Stop gate (only strict is real); creative's 80 / 12% is chosen, not measured |
| #68 | W8-3 ph.2–3 | Mixed in all eight bespoke sections (`pickMixedString`), three-state `StyleWriteLockContext` with per-property reach counts, class-target bulk behind an "N other elements" gate, Selection colors via `setNodesInlineStylesPerNode` (STATE `store-06`). Cut: indeterminate state for `AlignGrid` and Clip content |
| #69 | W9-4 | Figma-link pipeline: `figmaUrl.ts` leaf parser run on every chat message, `studio_import_figma_frame` (strict reference + variables + board frame from `absoluteBoundingBox`, SECTION → screens enumerated) (STATE `figma-pipeline`). Cut: connector-state UI in the Agent Panel (server computes `figma.status`, no transport/UI yet) |
| #70 | W9-3 creative | `design-system-coverage-low`, `auditCompositionQuality` (off-scale spacing / type size, flat hierarchy), `studio_plan_variants` + `.studio/variants.json` seeds (STATE `creative-substance`). Cut: the variant fan-out itself (plans, does not create `HomeA/B/C`) |
| #71 | W9-3 strict | `method: 'cropped-to-reference'` band compare, `font-not-available` finding (`fontAvailability.ts`), `colorExplanation` on failing regions naming design variables (STATE `strict-teeth`). Cut: `studio_ingest_design_text` — strict still says nothing about text fidelity and does not refuse to claim it |

## Not started — the follow-ups the cuts above left

Plan line numbers refer to `STUDIO-WAVE7-PLAN.md`.

- **W9-3** `studio_ingest_design_text` + text diffing (386–389); strict should refuse to claim text fidelity until it exists
- **W9-2** creative and balanced halves of the mode-aware Stop gate (355–361); creative thresholds need measuring
- **W9-4** connector-state UI in the Agent Panel (416–421) — needs a route + schema + panel affordance
- **W9-3** variant fan-out: `studio_plan_variants` plans; nothing creates the three pages on the board
- **W9-5** levers 4–6 (441–453) and the on-disk parse cache for the Stop hook (~509 ms cold)
- **W8-2** a real `scrollHeight <= clientHeight` measurement gate once a layout-capable test runtime exists
- **W8-4** single-undo-step for Hug/Fill mode switches and crosshair clicks (both write 2–3 entries today)
- **W8-3** indeterminate affordance for `AlignGrid` / Clip content under multi-select

## Human dogfood owed

Nothing UI-facing in this train was browser-verified by an agent (per repo rule).
`STATE.md` → `## Pending dogfood` plus the per-PR checklists in `panel-13`,
`panel-14`, `panel-18`, `panel-19` (×2 — the id is duplicated between the popover
and Hug/Fill entries), `look-pass`, `store-06`, `inspector-w8-4-constraints`,
`server-20`, `perf-04`, `fidelity-modes`, `figma-pipeline`, `creative-substance`,
`strict-teeth`, `mcp-20`, `docs-06`. `mcp-20` needs `bunx playwright install chromium`
first. Start with `/admin/site` → select a text element → confirm the panel is
290px, empty Border/Effects/Animations headers are static rows with only a "+",
and a Typography ⚙ opened near the bottom of the window stays fully on screen.

## Loose ends found along the way

- `docs/agent.md` is ~1370 lines against a ~600-line cap — split it (flagged in `docs-06`)
- MCP wire name is still `alm-figma-killer`
- Dockerfile labels point at the upstream fork
- Stray `pnpm-lock.yaml` (repo is Bun-only)
- 3 e2e specs still drive deleted CMS UI
- `bun run fallow:health` cannot complete
- Prototype plan §1/2/4 rationale not yet migrated into the feature doc
- `pageWriteVerification.test.ts` (3 cases) still calls the pre-W10 arity of `computePageWriteVerification` — dead since #57
- `liveReloadPush.test.ts` breaks in any batch containing a suite that `mock.module('../../editorBridge')` (pre-existing; `compare.test.ts` does it on main)
- `generateStudioProjectGuide` is not read-only — `healMissingDesignSystem` seeds `package.json` + `node_modules/@alm-design` into any project without a manifest
- Parallel-agent builds: 10 worktrees → ~20 concurrent `tsc -b` processes thrash and time out. Fix candidates: per-worktree `tsBuildInfoFile`, or a fleet build lock.
- `no-circular-dependencies` gate fails as a 60s timeout, not a cycle — `madge` alone takes ~82s here; raise the budget
- `STUDIO-WAVE7-PLAN.md` is not valid UTF-8 — plain `grep` matches nothing in it; use `grep -a`
- Pre-existing red tests not owned by this train: icon-catalog `chevron-left`, canvas batch-isolation cluster (green per-file), headless-capture "No Chromium"
