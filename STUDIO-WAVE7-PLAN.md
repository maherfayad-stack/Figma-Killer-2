# Waves 7–10 — launcher & onboarding, the Figma-exact inspector, agent fidelity & speed, per-user sessions

Written 2026-09-06 from three dedicated audits of the post-wave-6 tree (main at
`db25597`). This file is the work-order document for the next wave train, in the
same shape as the retired `STUDIO-WAVE4-PLAN.md`: one agent per numbered task,
each section detailed enough to implement from alone. `STUDIO-FIGMA-PARITY-PLAN.md`
§0a remains the single status ledger — tick items there as they land.

**The user's asks, verbatim, that this plan answers:**
1. "enhance the look, and functionality of the home screen where I choose/create
   a project, and how we can onboard the users a bit" — **W7**. "I wanna see
   preview and better project card design." Onboarding should take after
   Instatic's dismissible fact-driven checklist (this repo's ancestor — see W7-5).
2. "enhance the properties panel, I want it to function and look like figma
   exactly" — **W8**.
3. "make [the agent] faster, more creative if it didn't give it any reference,
   strictly follow the reference if I told it to, or be in between also if I
   told it to. If I gave it a figma link it should follow to the pixel with no
   mistakes in the fastest possible way" — **W9**.
4. "I want the agent sessions to be per project, and per account, not all shared
   across everything" — **W10**.

---

## Global rules for every agent in this train

- Branch from fresh `origin/main`; `<type>/<kebab>` names; draft PRs; Conventional
  Commit titles; body says what/why/impact/verification. Never `git stash`
  (repo-global, races across worktrees — `cp` to `.tmp/` instead). Unique
  scratchpad filenames. Never touch `studio-workspace/` (user data).
- Repo gates that bite this train: `css-token-policy`, `css-token-vocabulary`
  (the real vocabulary is `--bg-surface-*`, `--accent-1..10`, `--danger*`,
  `--radius*`/`--card-radius`/`--panel-radius`, `--inspector-*` — the `--editor-*`
  and `--rail-tint-*` families are BANNED), `no-css-var-fallbacks`,
  `button-primitive-usage` (§8 allowlist), `no-third-party-icons` +
  `direct-icon-imports` (run `bun run icons:sync` after adding an icon),
  `boundary-validation` (every new parser/route body is a TypeBox boundary),
  `no-full-site-scan-in-selectors` + `per-node-selector-budget`,
  `module-size-budgets` (700-line ceiling — several inspector files are already
  near it; extract, don't grow), `emptySectionLaw`.
- React Compiler is on: no manual `useMemo`/`useCallback`/`memo` outside the
  three documented exceptions. UI primitives from `src/ui`. TypeBox at
  boundaries; no `any`; no `zod`.
- DB schema changes (W10 only): additive migrations in BOTH `migrations-pg.ts`
  and `migrations-sqlite.ts`, same ID, same semantics. Never destructive.
- Docs track code in the same PR. Inspector PRs must keep
  `docs/features/inspector-disclosure.md`'s §-numbering stable (~50 source files
  cite it by number). Append a `STATE.md` handoff per the protocol.
- UI changes are NOT validated by e2e — ship with gates green and a
  "needs human dogfood" note in the STATE handoff.
- Verify once at the end: `bun run build`, `bun test`, `bun run lint`.
  Pre-existing failures (icon-catalog `chevron-left`, canvas batch-isolation
  cluster — passes per-file, headless-capture browser tests) are not yours.

---

# W7 — Launcher & onboarding (~5 agent-tasks, mostly parallel)

The launcher is `src/admin/pages/dashboard/DashboardPage.tsx` (289 lines) +
`NewProjectDialog.tsx`, `DeleteProjectDialog.tsx`, `hooks/useStudioProjects.ts`.
Data: `GET /admin/api/studio/projects` → `{ dir, name, pageCount }` only
(`server/handlers/studioProjects.ts:169-176`). It is bundle-isolated from the
editor store — nothing here may import `@site/store`.

## W7-1 Launcher polish + correctness (S, one PR)

- **Sort bug**: `listStudioProjects` sorts by folder slug but displays
  `displayName` from `.studio/meta.json` — rename a project and it sorts wrong
  forever. Sort by `displayName` (`studioProjects.ts:329`).
- **Infinite-skeleton dead end**: `useStudioProjects` uses `swallowErrors: true`,
  so a failed fetch renders six skeletons forever. Drop it; render an
  `EmptyState` with a retry button on error; reduce skeletons to 3.
- **Contrast failure**: `.cardMeta` uses `--text-disabled` (≈2.3:1 on
  `--bg-surface-2`) for the card's only metadata. Use `--text-subtle`.
- **Type scale**: `.cardName` at `--text-m` reads like panel chrome. Move to
  `--text-l`/`--text-xl`, widen the grid to `minmax(240px, 1fr)`, increase tile
  padding. The home surface gets a calmer, larger scale than the tool chrome.
- Hover affordance is nearly invisible (`surface-2`→`surface-3` only) — add a
  subtle lift per the documented borderless-card rule. Add `aria-live="polite"`
  to the grid so create/delete announce.
- **Refetch handle** on `useStudioProjects`; delete the hand-rolled
  `created[]`/`removed[]` optimistic reconciliation in `DashboardPage.tsx:87-100`.

## W7-2 Card data + project verbs (M, one PR, after W7-1)

- `listStudioProjects` already reads `.studio/meta.json` per entry and throws
  the data away. Extend `StudioProjectSummary` with `platform` (mobile/web),
  `profile.framework`, `trust` tier, and one `statSync` mtime → "Edited 2 days
  ago". Render as small badges. (A Tier-0 Tailwind project renders unstyled —
  badge it *before* the user opens it and wonders.)
- **Rename from the launcher**: `renameStudioProject` already exists in
  `useStudioProjects.ts:90` with zero launcher callers. Wire it.
- **Duplicate project**: `POST /admin/api/studio/duplicate` — `cpSync` skipping
  `node_modules`, suffix the display name, regenerate the guide.
- **Card context menu** (`src/ui/components/ContextMenu`): Open / Rename /
  Duplicate / Reveal in Finder? no — keep to in-app verbs / Delete. Move delete
  off the hover-only ghost button into the menu (keep a hover affordance for
  discoverability).
- **⌘K**: add "Open project …" commands to `src/admin/spotlight/`.

## W7-3 Project preview thumbnails (L — the highest look-impact item)

The user explicitly wants previews. Mechanism exists end-to-end: PR #28's
headless capture (`server/ai/mcp/capture/{headlessCapture,captureFrames}.ts` +
the `agent-capture.html` Vite entry) renders board frames in a warm server-side
Chromium with **no editor tab open**, and its module doc argues it needs no
trust gate (it renders Studio's own parse output, executes nothing). Build:

1. `captureProjectThumbnail(dir)`: capture the first board frame (or the page
   marked home) at a small `purpose: 'thumbnail'` scale, composite to a 4:3
   ~480px-wide PNG, write `.studio/thumbnail.png` (Studio state on disk).
2. Serve route `GET /admin/api/studio/thumbnail?dir=` with mtime-based caching
   headers; extend `StudioProjectSummary` with `hasThumbnail`.
3. Triggers: debounced on save (piggyback where the save pipeline completes), and
   lazily on launcher render when a project has none (fire-and-forget, the card
   shows the folder-glyph placeholder until it lands, then swaps).
4. Card redesign around the preview: image area on top, name + badges below —
   the Figma-file-tile shape. Do this AFTER W7-1/W7-2 settle the card's layout.

Bound the lazy backfill: serialise captures (the browser pool is one Chromium),
skip projects whose capture fails, never block the list response on capture.

## W7-4 Import & trash UX (M, one PR)

- **Drag-and-drop import** onto the launcher grid: a drop zone overlay;
  `DataTransferItem.webkitGetAsEntry()` walks dropped folders; route into the
  existing `uploadProjectArchive({ kind: 'zip' | 'directory' })`. This is the
  product's core entry path and currently needs three clicks through a dialog.
- **GitHub import feedback**: today the button says "Importing…" and nothing
  else. Add progress (polled or SSE) and a post-import summary step —
  framework, pagesDir, N pages found — surfacing `pagesDirCandidates`
  (`projectProfileSchema.ts:252`, built for exactly this and never surfaced)
  as a picker when the probe is ambiguous, BEFORE navigating to the board.
- **Trash UI**: the delete dialog currently tells users to run a terminal
  command to restore. Add `GET /admin/api/studio/trash`, `POST .../restore`
  (inverse `renameSync`), `POST .../purge`; a "Trash (N)" affordance on the
  launcher listing trashed projects with restore/purge per row.

## W7-5 Onboarding (M, one PR — the Instatic pattern, not coach-marks)

The ancestor repo (github.com/CoreBunch/Instatic,
`src/admin/pages/dashboard/components/OnboardingPanel.tsx` + `LiquidProgressRing`
+ `hooks/useOnboardingState.ts`) shipped the pattern the user wants: a
**dismissible, fact-driven checklist** above the grid — five steps whose
done/active/todo state derives from live lookups of real system state, each CTA
performing the real action, a big liquid progress ring, dismissal persisted.
Steps tick themselves as the user genuinely does the thing, in any order. Port
the pattern (and the `LiquidProgressRing` component) with Studio steps:

1. **Create or import a project** — done when ≥1 project exists.
2. **Open it on the board** — done when any project's `.studio/meta.json` has a
   `lastOpenedAt` (add the timestamp in W7-2's summary work or here).
3. **Edit an element's style** — done when git status for any project shows a
   change, or any `.studio/cache/pageVerification.json` exists; pick the
   cheapest honest fact available and document the choice.
4. **Set up the AI assistant** — done when an AI credential exists for the user
   (the server knows) or a conversation exists.
5. **Try prototype mode** — done when any `.studio/prototype.json` has a link.

Facts fetched concurrently, each soft-failing to 'todo' (Instatic's
`Promise.allSettled` posture). Dismissal: per-user (localStorage is what
Instatic used; `userPreferences` is fine) — NOT the CMS DB.

Plus two in-editor pieces from the audit:
- **Empty-canvas hint**: a new project shows one blank frame and no guidance.
  `EmptyState variant="centered"` pointing at the insert affordance (there is
  currently zero `EmptyState` usage under `canvas/`).
- **Sample project**, offered (never auto-created) as a third path in the
  no-projects empty state: a small real React repo checked into the seed area,
  copied on demand (`projectSeed.ts` posture: copy-not-install, Tier-0 safe,
  offline), marked in its meta so it can be trashed without ceremony.

**Voice**: before writing any string, read the shipped exemplars —
`StyleCompileConsentBanner` ("Run the project's compiler", name the mechanism),
`DeleteProjectDialog` (say where files go). No marketing adjectives, sentence
case, product name is "Studio" flat. First task of this PR: write the UI-copy
rules down as a short section in `docs/design.md` — they currently exist only
by example.

**W7 sequencing**: W7-1 → W7-2 → {W7-3, W7-4, W7-5 in parallel}. A template
gallery (real starter repos in the create dialog) was audited and deferred —
largest genuinely-new surface, do it as a follow-up wave if wanted.

---

# W8 — The Figma-exact inspector (~4 agent-tasks)

Audit verdict: the panel is structurally much closer to Figma than assumed —
the section order, disclosure laws, popover band, and the geometry tokens
(`--inspector-row-h: 24px` etc., `globals.css:225-242`) already match UI3. The
gap is four-fold: field ergonomics are inconsistent, the panel is ~50% too wide
with caption-heavy rows, multi-select edits nothing, and a few mappings write
dishonest CSS. Registry: `classStyleSections.ts`; sections under
`src/admin/pages/site/panels/PropertiesPanel/`.

## W8-1 Field ergonomics (S×6, ONE combined PR)

1. **Bare-number bug (correctness, do first)**: `ScrubInput.commit()`
   (`src/ui/components/ScrubInput/ScrubInput.tsx:178-183`) writes raw text —
   typing `50` into Width emits invalid `width: 50`. Route the commit through
   the same px-coercion `tokenUtils.ts:131` applies.
2. **One nudge model**: three implementations disagree (Shift = ±10 in
   `ScrubInput`, ±8 in `numericNudge.ts:17-21` and `FrameSizePanel.tsx:164-173`).
   Figma is 1/10/0.1 — make that the single set everywhere. Add `opacity` and
   `zIndex` to `isLengthNudgeProp` (`cssControlTypes.ts:188-205`) — they
   currently have neither scrub nor nudge.
3. **Math expressions**: `100/2`, `100+8`, `100*2` evaluate on commit — one
   shared evaluator consumed by `scrubMath.ts:23` and `numericNudge.ts:41`
   (both currently reject anything but a plain number). TypeBox-validate; on
   parse failure keep the literal (current behavior).
4. **Enter keeps focus** (Figma behavior); today all three field kinds blur
   (`ScrubInput.tsx:249`, `TokenAwareInput.tsx:281`, `FrameSizePanel.tsx:161`).
5. **Flip H/V**: two icon buttons on the rotation row writing the standalone
   `scale` property (`scale: -1 1` / `1 -1`), with `RotationRow`'s existing
   refusal when `transform` already carries a scale-family function.
6. **Finish G9**: move `color` to Fill and `textShadow` to Effects (both
   destinations exist now); update `classStyleSections.ts` conditions.

## W8-2 One scrub + the look pass (M+M, two parallel PRs, then the gate)

**Scrub unification**: `ScrubTokenField` (padding/margin only; no rAF
coalescing, no min/max/MIXED) becomes a thin token-aware wrapper over
`ScrubInput`, then wire scrubbing into every unscrubbed numeric: TRBL insets
(`PositionSection.tsx:331`), constraint offsets, `gap` (`GapInput.tsx:31`),
all five radius fields (`AppearanceSection.tsx:234,255`), `opacity`, `zIndex`,
`fontSize`/`lineHeight`/`letterSpacing` (`ClassPropertyRow.tsx:311`), grid
tracks. Every numeric in the panel scrubs, nudges, and does math identically.

**Look pass** (pure CSS/structure — this is what makes it *look* like Figma):
- Panel default width 360 → **290** (`uiSlice.ts:23`, `workspaceLayout.ts:12-13`).
  The ~161px two-up cells vs Figma's ~104 are the loudest visual delta.
- `Button` gains an inspector skin (`data-field-skin="inspector"`: 24×24,
  radius 5, `--overlay-5` hover) — today's 22×26 `size="xs"` buttons beside
  24px fields are what makes section headers look off.
- `Select` inspector skin sets `font-size` to match `Input` (one line).
- Freeze inspector-internal spacing to fixed px (`--inspector-*` additions) —
  the panel currently breathes with viewport width via `clamp()` tokens.
- Extend `PROPERTY_FIELD_GLYPHS` (`cssPropertyIcons.ts:119-127`, currently 5
  properties) so in-field glyphs replace caption-above-field as the default row
  form — Figma's rows carry almost no captions; each caption costs ~19px.
- Persistent chevron for collapsed `collapsedWhenEmpty` sections (disclosure
  state is currently invisible at rest — hover-only cross-fade).
- THEN: a **measurement gate test** — `scrollHeight <= clientHeight` for a text
  node's panel at 900px viewport + per-section height budgets, so W8's geometry
  can't silently regress.

## W8-3 Multi-select (L — the engine spine, serialise: phase 1 → 2 → 3)

Today `MultiSelectionInspector` renders an action bar and zero style controls;
Figma renders shared sections with **Mixed** values writing to all N. The
`MIXED` primitive + `collapseValues` reducer already exist
(`src/ui/components/MixedValue`) with one runtime consumer; the save layer is
already N-safe (whole-document diffs); `mutateTreesForNodeIds` already groups
N nodes into one undo step.

- **Phase 1 — inline-only bulk edit** (dodges the shared-class blast radius
  entirely): `setNodesInlineStyles(nodeIds[], patch)` over
  `mutateTreesForNodeIds`; force the target chip to "Element" with a stated
  reason; mount `StyleSectionsEditor` fed by a `collapseValues` bag over the N
  nodes' effective values; add `MIXED` rendering to `SegmentedControl`,
  `Select`, `ColorValueInput`, `TokenAwareInput`, and Appearance's plain inputs.
  Fix `MultiSelectorInspector` triggering at ≥1 selector (should be ≥2).
- **Phase 2 — mixed writability**: `StyleWriteLockContext` grows a third state
  carrying a count ("writes to 3 of 5 — 2 are compiled") instead of a boolean.
- **Phase 3 — class-target bulk + Selection colors (G6.4)**: class edits behind
  an explicit "this class is used by N other elements — continue?" gate;
  aggregate distinct colors across the selection into a Selection colors
  section that rewrites all of them.

## W8-4 Honest mappings (M×4, parallel after W8-1)

- **Hug/Fill is dishonest today**: `elementSizing.ts` writes `fit-content`/
  `100%` unconditionally; `100%` overflows a gapped flex row. Make
  `sizingPatch`/`currentSizingMode` parent-aware: flex main axis → `flex: 1 1 0`,
  cross axis → `align-self: stretch`, grid → `justify-self/align-self: stretch`,
  block → `100%` (only case today's value is right). Read back the same way.
  Parent unresolvable (cross-file component) → keep Fixed, disable Hug/Fill
  with a named reason. Memoise the parent-layout selector in the same change
  (`per-node-selector-budget` gate).
- **Fill as N layers**: apply the proven `boxShadowLayers.ts` pattern to
  `background-image` (comma-list parse → rows → byte-identical re-join or
  refuse); `backgroundColor` pinned bottom-most; satellites become per-layer;
  per-layer `background-blend-mode` in each row's popover. Extract a
  `backgroundLayers.ts`; `FillSection.tsx` is near the 700-line ceiling.
- **Constraints**: keep the honest side-pickers, add Figma's crosshair diagram
  as presentation; Center → `left: 50% + translate` (refuse when translate is
  taken), Scale → `%` insets, L+R stretch → both insets. Gate the cluster on
  positioned context, disabled-with-reason otherwise.
- **Export section**: `collapsedWhenEmpty`, typed `+` menu — PNG @1×/2×/3× and
  SVG of the selected node via the existing capture pipeline (nodeRects already
  come back per capture), plus **Copy CSS** / **Copy JSX** rows (the
  differentiator; `stylePropertyProvenance` already computes the effective bag).

Deferred (recorded, not scheduled): layout-grid canvas overlay, pointer-lock
scrub, unit-cycle trailing control, `PropertyList` pointer drag-reorder
(blocked on the dnd-kit migration).

---

# W9 — Agent: faster, fidelity modes, the Figma-link pipeline

Audit found three findings that outrank everything; W9-1 fixes them first.

## W9-1 Critical fixes (S×4, ONE wave of parallel small PRs, before all else)

1. **Reference drift — the flagship loop is measuring the wrong image.**
   `resolveDesignReference` picks the *most recently registered* reference
   (`server/ai/mcp/tools/studio/referenceResolve.ts:47-49`) while
   `registerTurnDesignReferences` (`server/handlers/studio/turnDesignReferences.ts`,
   called from `chat.ts:308`) registers **every chat-attached image** as a
   durable reference. A pasted "why does this look wrong?" screenshot silently
   becomes the spec (live in test4: `sms` page's Figma frame is shadowed by a
   943×294 chat crop, so compare refuses on aspect and the Stop gate can never
   pass). Fix: labelled/explicit references win over chat attachments; refuse
   an ambiguous page (>1 candidate, no explicit id); a chat image registers as
   *context*, becoming the spec only by explicit gesture (tool arg or a
   "use as design reference" action). Add `mode`/`passScore`/`maxRegionCoverage`
   optionals to `DesignReferenceSchema` + `@core/ai`'s mirror + the register
   tool schema + the upload route in the same change (W9-2 consumes them).
2. **`studio_computed_styles` has returned zero rows since it shipped** — it
   queries the frame host, but nodes live in the iframe's `contentDocument`.
   The system prompt makes it load-bearing ("close visual differences by
   arithmetic"). Fix the executor; make its test mount a real iframe.
3. **Benchmark harness**: extend `bench:agent-turn` (corpus has drifted) to
   measure warm-vs-cold turn, capture latency, 5-page compare, and per-turn
   MCP round-trip count; record baselines in STATE. Three shipped optimisations
   currently have no after-number.
4. **Docs/hygiene**: 19 of 31 agent tools have no prose in
   `docs/features/agent.md` (list in the audit — grep each name); fix
   `projectMcpApprovals.test.ts`'s dangling imports (broken on main); correct
   `remoteAssetFetch.ts:210`'s stale claim; verify `systemPrompt.ts:274`'s
   disconnected-board paragraph matches current retry behavior.

## W9-2 Fidelity modes: creative / balanced / strict (M — the core ask)

Resolution precedence (borrow `turnRouting`'s "explicit is never overridden"):
tool arg > per-reference `mode` > per-turn `fidelityMode` > per-project default
(`.studio/meta.json` `agentSession.fidelityMode`) > derived (reference armed →
balanced; none → creative). No DB anywhere — all disk JSON.

- Wire: `fidelityMode?: 'creative'|'balanced'|'strict'` on `AiStreamRequest` +
  `AiChatRequestBodySchema`, ignored by non-claudeCli drivers like
  `effort`/`permissionMode`.
- UI: third `ContextMenu` trigger in `AgentSessionControls.tsx` next to
  permission mode; persisted via the existing `GET/POST /admin/api/ai/studio-session`
  route (built for exactly this shape). Persisting is safe here — reset
  direction (strict) is the safe direction, unlike Bypass.
- Prompt: three mode blocks folded into the **static prefix** (prefix =
  `base + MODE_BLOCK[mode]`) so each mode is its own stable cache partition.
- Thresholds in `compare.ts`: balanced 92 / 6%; strict 99 / 0.5% **plus**
  `maxRegionPixels` (~400 px² at 1×, scaled) — region coverage is a % of frame
  today, so a wrong 24×24 icon passes on any tall page. Strict also refuses
  the project-wide reference fallback and ambiguous pages.
- Stop gate becomes mode-aware (`stopGateCheck.ts`, `pageWriteVerification.ts`):
  creative = passing `quality_check` since last write; balanced = compare RUN +
  deviations named; strict = compare PASS at strict thresholds.
- DONE criteria per mode written into the prompt blocks: creative = N variants
  each typechecking + passing quality; balanced = verdict reported verbatim,
  every region fixed or named as deliberate; strict = pass, text clean, fonts
  resolved, nothing else.

## W9-3 Strict-mode teeth + creative substance (M+M, parallel after W9-2)

**Strict teeth** (what "no mistakes" actually needs beyond thresholds):
- `maxRegionPixels` in `frameDiffEngine.ts`/`compare.ts` (if not fully landed
  in W9-2).
- `method: 'cropped-to-reference'`: when aspect differs only because the capture
  is scroll-unrolled, compare the top `referenceHeight × scale` band instead of
  refusing — that is what "match this artboard" means. Third value in
  `ReferenceReconciliation`.
- Font-availability in `studio_quality_check`: a `font-family` whose first
  family has no `@font-face`/project file is a named finding (a fallback font's
  x-height reads as a size bug and every size edit makes it worse).
- `studio_ingest_design_text` (sibling of `studio_ingest_design_variables`,
  same manifest posture) + text diffing in compare against captured `nodeRects`
  strings; without a connector, strict *refuses to claim* text fidelity.
- Design-variable awareness in compare's region explanations ("this fill is
  `coral/100 #EF4550`, you wrote `--color-primary`") via the existing
  `designVariableIndex`.

**Creative substance** (compliance-only feedback is what produces template-y
output):
- **N=3 variants as three real pages** side-by-side on the board (`HomeA/B/C`),
  one subagent each (Task fan-out is under contract), same brief, different
  **style seed** — constrained randomisation over the project's own token
  space: type-scale ratio, spacing base, radius family, density, accent token.
  Seed recorded in `.studio/variants.json` so "make B but tighter" is an edit,
  not a re-roll. Optionally a `studio_build_variants` tool to make it a verb.
- Component-coverage threshold in `quality_check` (a shipped screen once used
  2 of 42 available components): from-scratch screens must import ≥K distinct
  design-system components; the finding names what the decision table offered.
- Composition audit in `auditStylesheetQuality` (reuses `buildProjectTokenIndex`,
  costs nothing new): off-scale spacing values, off-scale type sizes, and a
  hierarchy ratio check (largest type / body < ~1.6 = flat). Do NOT resurrect
  the class-name/word-overlap check — prototyped and rejected as noise.

## W9-4 The Figma-link pipeline (M–L — the flagship path)

Today the only thing a pasted Figma URL does is add one prompt sentence.
Target flow: paste link → parse key+node → agent fetches metadata + variables +
exact-size export via the project's Figma MCP connector → auto-register as a
strict reference → board frame at the Figma frame's own size → build →
strict compare loop → pass.

1. Extract the URL parser from `figmaCodeConnect.ts:90-117` into a shared leaf;
   run it on the chat message in `liveDigest.ts`; put `{ fileKey, nodeId }` in
   the digest.
2. **`studio_import_figma_frame({ url | exportPath, pageId })`** — collapses
   the 6-step ritual into one tool (same reasoning that produced
   `studio_screenshot`): registers the export as reference with `mode: strict`
   + the source URL, ingests variables, sets the board frame from
   `absoluteBoundingBox` (kills the resample class — test4's 800-tall refs vs
   788-808-tall frames), drops `visible: false` nodes.
3. Section→N pages: a FRAME/SECTION containing sibling screen-sized FRAMEs
   enumerates children as pages (mechanical once metadata is in hand; today
   it's prompt-only).
4. **Connector discoverability** (most sessions silently run the raster
   fallback): surface the four connector states the capability digest already
   computes in the Agent Panel, with a one-click path to Settings → MCP
   servers. (OAuth quirks are known and documented: Figma's DCR is a closed
   allowlist; the CLI sign-in command is the path; the needs-auth cache is
   already pruned per spawn.)
5. Principle for "fastest possible": **fetch design as data, not pixels** —
   every lookup (variables, text, bounding boxes, visibility) that replaces a
   measurement removes an entire fix-verify round trip.

## W9-5 Speed levers (M, one PR, after W9-1's benchmarks exist)

In measured-impact order:
1. **One `loadStudioPages` per turn** — the full ts-morph parse currently runs
   in the live digest, again in `studio_compare`, again in quality/fidelity
   tools, and a fourth time in the Stop-hook subprocess. In-process memo keyed
   on the mtime set `compareVerdictCache` already tracks + a small on-disk
   parse cache for the hook.
2. **Skip `awaitStudioLiveReload` for headless captures** (`compare.ts:428`,
   `screenshot.ts:131`) — the headless path re-parses from disk and doesn't
   need the bridge wait (or its timeout when no tab is open).
3. **Pre-warm Chromium on project open** (~300-600ms off first compare;
   `browserPool` currently lazy + 5-min idle teardown).
4. **Live-reload nudge from the PostToolUse hook** — native `Write`/`Edit` have
   no server hook, so the canvas updates at turn end; `recordToolWrite.ts`
   already fires per write and knows the path — add a loopback POST with a
   per-turn token so screens appear as they land.
5. **Warm-session effort pin** — effort is in the respawn fingerprint, so
   question↔build alternation respawns (850ms each). Pin effort per
   conversation after first classification, or add `set_effort` upstream when
   available.
6. Cross-project design-system guide cache keyed `(packageName, version)` —
   and fix `DS_FILE_MAX_BYTES` truncating the real ALM docs to nothing.
NOT doing: speculative capture (burns the serialised browser slot the
fix-verify loop needs).

Deferred: model routing (route questions to a cheap model) — blocked on
recording chosen-vs-defaulted model on the conversation (additive column);
fold into W10's migration if convenient, route later.

## W9-6 Bridge-bound tools go headless (M, anytime after W9-1)

`studio_computed_styles`, `studio_set_frame_axes`,
`studio_duplicate_frame_as_variant` still require an open editor tab (~8s
timeout when none). Capture went headless in PR #28; move these three onto the
same substrate. (`studio_upload_asset` stays browser-side — it's about the
user's session.) Also add `studio_measure_element` (S): expose the built
screen's rendered boxes/gaps from the `nodeRects` every capture already
returns — nothing today reports actual rendered geometry.

---

# W10 — Sessions per (account, project) (M, one agent, one PR + one migration)

The user's requirement. Audit verdict: per-USER isolation is already correct
server-side (every conversation query carries `user_id`; `CLAUDE_CONFIG_DIR`
is per-user, 0700). Per-PROJECT isolation does not exist, and two adjacent
holes need closing.

1. **DB**: one additive migration, both dialects, same ID:
   `alter table ai_conversations add column project_key text` (nullable, NO
   backfill — null means "not project-scoped", stays visible everywhere) + index
   `(user_id, project_key, updated_at desc)`. Key derivation:
   `registeredMcpServerProjectKey(dir)` (`registeredMcpServers.ts:73-87`) so
   conversations, OAuth sessions, and secrets agree on what "this project" is.
2. **Server**: `listConversationsForUser(db, userId, projectKey?)` filters
   `project_key = ? or project_key is null`; the list route accepts `?dir=`,
   validates, derives. `createConversationForUser` stamps the key from the
   already-validated `workspaceDir`. **`chat.ts` refuses a mismatch** (409)
   when a conversation's non-null key differs from the turn's project — the
   one-honest-target invariant applied to conversations; null adopts on first
   use.
3. **Close the `dir` escape (security-adjacent, do not skip)**:
   `resolveProjectDir` does a bare `resolve(requested)` with no containment
   check against `projectsRootDir()` — an agent in project A can pass `dir` to
   read/write project B or any absolute path. Add realpath containment; for a
   *workspace-bound* connector, refuse an explicit `dir` differing from
   `ctx.workspaceDir` (unbound external MCP clients keep the permissive
   behavior). Extend `studio-tool-project-dir.test.ts`.
4. **Warm pool**: key `${userId} ${conversationId}` (the editorBridge
   idiom); add `userId` to the fingerprint; per-user pool cap (2) under the
   global 8 so one busy user can't evict everyone; attachment root becomes
   `sha256(userId + '\0' + conversationId)`.
5. **Per-user project cache**: `.studio/cache/agent/<userIdHash>/{turnWrites,pageVerification}.json`
   (both documented as disposable derived caches — no migration; missing file
   reads as empty). Pass the user hash to the Stop-hook subprocess via env or
   embedded in the generated hook command. Fixes the real bug where user A's
   writes satisfy/block user B's Stop gate. `agentSession` effort/fidelity
   become a per-user map (`{ byUser: { <hash>: {...} } }`) via the existing
   route. Design references and variables STAY project-shared (they describe
   the design, not a session).
6. **Editor bridge**: widen the scope literal `'site'` →
   `site:${projectKey}` so two tabs on two projects are two independently
   addressable bridges (today: last-registered wins).
7. **UI**: `ConversationHistory` passes the open project's dir; shows that
   project's threads + a collapsed "Other projects" group for null/foreign rows
   (nothing disappears). "New chat" stamps the current project.

---

## Sequencing & conflict matrix

| Order | Item | Blocks on | Owns (conflict-relevant) |
|---|---|---|---|
| 1 | W7-1 launcher polish | — | DashboardPage, useStudioProjects, studioProjects.ts |
| 1 | W8-1 field ergonomics | — | ScrubInput, numericNudge, RotationRow, TypographySection |
| 1 | W9-1 critical fixes (×4 parallel) | — | referenceResolve/turnDesignReferences; computed-styles executor; bench; agent.md |
| 1 | W10 session scoping | — | conversations/*, chat.ts, sessionPool, editorBridge, ConversationHistory |
| 2 | W7-2 card data + verbs | W7-1 | same launcher files + projectRoutes |
| 2 | W8-2 scrub unification ∥ look pass | W8-1 | ScrubTokenField+sections ∥ uiSlice, Button/Select css, ControlRow |
| 2 | W9-2 fidelity modes | W9-1(1) | chat.ts†, systemPrompt, compare, stopGate, AgentSessionControls |
| 3 | W7-3 thumbnails ∥ W7-4 import/trash ∥ W7-5 onboarding | W7-2 | capture+card ∥ ImportProjectDialog+trash ∥ OnboardingPanel(new) |
| 3 | W8-3 multi-select phase 1→2→3 | W8-1 | store slices, MultiSelectionInspector, ui MIXED consumers |
| 3 | W9-3 strict teeth ∥ creative | W9-2 | frameDiffEngine/qualityCheck (split files between the two) |
| 3 | W9-5 speed levers | W9-1(3) | liveDigest, compare/screenshot, browserPool, hooks |
| 4 | W8-4 honest mappings (×4 parallel) | W8-1 | elementSizing ∥ FillSection ∥ PositionConstraints ∥ ExportSection(new) |
| 4 | W9-4 Figma pipeline | W9-1(1), W9-2 | new tool, liveDigest†, boardFrames, AgentPanel |
| 4 | W9-6 headless bridge tools | W9-1(2) | browserBridgeTools, capture/ |

† `chat.ts` and `liveDigest.ts` are shared between W9-2/W9-4 and W10 — those
three do not run concurrently; order: W10 → W9-2 → W9-4 (or resolve at merge).

Rows sharing an owns-entry never run concurrently. Total: ~18 agent-tasks.
