# Track A handoff — agent fidelity loop (A1, A2, A3, A4, A6, A8)

All six items are complete. Working tree only — nothing committed, nothing staged.

Verification run at the end of this session:
- `bun test` on every file listed below: **160 pass / 0 fail**.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json`: **clean**.
- `bun test src/__tests__/architecture` (full sweep): 485 pass / 4 fail — all 4 pre-existing/other-agent
  (`codemirror-lazy-only`, `dispatcher-html-pipeline`, `error-boundary-coverage`, `keybindings-registry-single-source`),
  none touch any file I changed.
- Did NOT run `bun run build` / `bun run lint` per instructions.

---

## A1 — Page-scope chat-pasted references (the flagship bug)

**Files:** `server/handlers/studio/turnDesignReferences.ts:78-125`, `server/handlers/studio/turnDesignReferences.test.ts`,
`server/ai/handlers/chat.ts:302-324`, `server/ai/tools/studio/systemPrompt.ts:203-206`.

**Mechanism.** `registerTurnDesignReferences(dir, imageBytes, pageId?)` now takes an optional
third argument, passed straight to `registerDesignReference`'s `meta.pageId` (unchanged store
API — `designReferenceStore.ts` already accepted `pageId`, it was just never supplied by the
chat path).

**Where the page id comes from, exactly:** `chat.ts:319-323`. The turn's `snapshot` (the raw,
untyped HTTP body — the SAME value `buildStudioProjectSystemPrompt` parses a second time,
further down, for the rest of the live digest) is parsed with
`safeParseValue(StudioAgentSnapshotSchema, snapshot)` right where the registration call already
lived, and `parsedSnapshotForReferenceScope.value.activePageId` is passed through. This is the
browser's own live board state (`src/admin/pages/site/agent/studioAgentSnapshot.ts`'s
`buildStudioAgentSnapshot`) — not re-derived by any second path, per the work order's
instruction to "find it rather than re-deriving it."

**What happens when there isn't one:** if `snapshot` is absent/malformed, or no Studio project
is open, the parse fails and `activePageId` is `undefined` — the reference registers **unscoped**,
exactly the pre-fix behaviour (findable only by explicit id or "most recent project-wide" in
`resolveDesignReference`, `server/ai/mcp/tools/studio/referenceResolve.ts:34-59`). This is an
honest degradation, not a new failure mode: nothing regresses, the scoping simply doesn't apply
when the browser hasn't told the server which page is active. I deliberately did **not** log
this degradation (the later, real snapshot parse in `buildStudioProjectSystemPrompt` already
logs a malformed snapshot — logging twice for the same event would be noise).

**Consumer verified:** `chat.ts`'s `handleAiChat` → `prepared` block, the only call site of
`registerTurnDesignReferences` in the whole repo (confirmed via grep). Test:
`turnDesignReferences.test.ts` — added "scopes a pasted reference to the active page, so two
screens pasted in one conversation each resolve their own" (registers two references with two
different `pageId`s, then asserts `resolveDesignReference` for each page returns ITS OWN
reference, not the other one — this is the exact regression the plan asked for, and it fails
against pre-fix code since `resolveDesignReference`'s "this page's own" branch would never have
matched) plus a sibling test pinning the no-`pageId` degrade path.

**System prompt trap.** Added a new WRONG/RIGHT entry to "Common failures to avoid"
(`systemPrompt.ts`, right before the existing Figma-download-path entry) titled "PASTING A
SECOND SCREEN'S COMP WITHOUT SAYING WHICH PAGE IT IS" — covers the *ordinary paste* case
specifically (the existing entry only covered the Figma-connector download path, per the work
order). **Caught a real bug while writing it**: the prompt string is itself a backtick template
literal (`buildStaticPromptPrefix`'s `return \`# Role...\``), so a literal backtick anywhere in
the new prose (I'd written `` `studio_compare` `` / `` `pageId` `` markdown-style) terminates the
outer template early and is a **syntax error at module load**, not a runtime bug — `bun test`
on `systemPrompt.test.ts` caught it immediately (`error: Expected ";" but found "studio_compare"`).
Fixed by matching the existing entries' style (plain unquoted names, no backticks) — worth
flagging because it's an easy trap for any future edit to this file's static prefix.

---

## A2 — Exact-pixel diffing on tall screens

**Files:** `server/ai/mcp/tools/studio/frameDiffEngine.ts` (+test), `server/ai/mcp/tools/studio/compare.ts`,
`server/ai/mcp/tools/studio/diffFrames.ts`, `server/ai/mcp/tools/studio/exportFrames.ts`,
`server/ai/mcp/tools/studio/designReferenceTools.ts` (+test), `server/handlers/studio/boardGeometry.ts`,
`src/core/ai/toolSchemas.ts`.

**Did the short-term fix, not the region-scoped real fix** (per the work order's own scoping —
"implement it only if it falls out cleanly, otherwise specify it"). It did not fall out cleanly:
region-scoped compare needs the diff engine to crop BOTH images to a shared viewport-height
slice before scoring, which changes `computeFrameDiff`'s node-rect-to-region mapping contract in
a way that deserves its own review, not a bolt-on inside this pass. Specified below.

**What changed:**
1. `frameDiffEngine.ts`'s `ReferenceReconciliation` gained an optional `note` field, populated by
   a new `describeResampleReason()` whenever `reconcileReference` resamples. It names WHICH axis
   mismatched and, when the baseline's height lands at/near `AI_USER_IMAGE_MAX_EDGE` (1568px),
   says explicitly this is very likely the vision-safe capture cap, not a content difference —
   proactive disclosure instead of a bare `method: "resampled"`.
2. `compare.ts`'s output gained `capture.dimensionMatchNote` (surfaced whenever resampled) and its
   description now names the cap explicitly.
3. `diffFrames.ts`'s `dimensionReconciliation` gained the same `.note` field for its
   `referenceId` path.
4. `exportFrames.ts`'s tool description and `StudioExportFramesInputSchema.dpr`'s field
   description (`toolSchemas.ts`) now name the height clamp explicitly — previously only "no
   image edge exceeds the shared vision-safe limit" with no mention that HEIGHT (not just width)
   is the one that actually clamps on a tall mobile screen.
5. `studio_recommend_export_dpr` (`designReferenceTools.ts`) extended to the height axis: new
   `authoredFrameHeight()` in `boardGeometry.ts` (mirrors `authoredFrameWidth`, same fallback to
   `FRAME_HEIGHT`), and the tool now returns `heightLikelyClamped`/`heightNote` — a ONE-SIDED
   warning computed from the frame's NOMINAL authored height (a floor; scroll-unroll can only
   make the real capture taller, never shorter) × the recommended dpr, vs. the same vision-safe
   cap. This is genuinely new information the tool never surfaced before: it previously reasoned
   about width only.

**Tests:** `frameDiffEngine.test.ts` — two new cases pinning the `note` wording (one where the
resample looks vision-cap-caused, mentioning "vision-safe" + "height"; one plain axis mismatch
that must NOT mention "vision-safe"). `designReferenceTools.test.ts` — two new cases for
`heightLikelyClamped` true/false with explicit numbers.

**Consumer verified:** `compare.ts`'s `capture.dimensionMatchNote` and `diffFrames.ts`'s
`dimensionReconciliation.note` are both read directly off `reconcileReference`'s return value
(same object, no re-derivation) — confirmed by reading both call sites after the change.
`studio_recommend_export_dpr`'s new fields are computed in the same handler that already builds
`note`/`exactWidthMatchExpected`, added as siblings, not a parallel path.

**What's specified but not built — the real fix:** region-scoped compare. Crop the CAPTURED
baseline (never the reference) to the reference's own pixel height when the baseline is taller,
BEFORE `computeFrameDiff` runs, so a scroll-unrolled tall screen is still compared pixel-exact
over the region that matters (typically "above the fold" / the reference's own extent) instead
of falling into `reconcileReference`'s resample branch. This changes `computeFrameDiff`'s
`nodeRects` intersection semantics (rects would need to be filtered/clipped to the cropped
region too) and needs a decision on what "pass" means for content below the crop line — that's
a design call, not just an engine change, hence deferred.

---

## A3 — Reference-free quality signals

**New files:**
- `server/handlers/studio/qualityAudit.ts` (+ `.test.ts`, 9 tests) — pure, synchronous,
  no-execution static scan. Reuses `contrastRatio`/`parseHexColor`/`colorDifference` from
  `colorMath.ts` (no second contrast implementation) and `buildProjectTokenIndex`/
  `nearestSizeToken` from `projectTokenIndex.ts` (the same index `studio_measure_reference`
  already builds). Three finding codes: `raw-hex-color`, `raw-px-length`, `low-contrast-pair`
  (WCAG AA 4.5:1, single global threshold — documented caveat that a large/bold rule may still
  pass WCAG AA's looser 3:1 in practice since this can't see `font-size`/`font-weight`).
- `server/ai/mcp/tools/studio/qualityCheck.ts` (+ `.test.ts`, 4 tests) — the MCP tool
  `studio_quality_check`. `execution: 'server'`, headless, no `requiredCapabilities` (read-only,
  same posture as `studio_project_profile`/`studio_list_pages`). Resolves the page by name
  (`resolvePageByName`), its own source file (`resolvePageSourceFile`, new shared helper — see
  A6), then reuses `collectPageStylesheets` (`@core/studio-sync/collectPageStylesheets` — the
  SAME stylesheet-discovery walk `studioCss.ts` already uses to wire canvas styling, not a
  second implementation) to find which `.css`/`.module.css` files the page (and any inlined
  local component) actually imports, reads each, and runs `auditStylesheetQuality` over it.
  Bounded at `MAX_FINDINGS_RETURNED = 60`, reports `truncated`.

**Registered and reachable — the actual "shipped" test, not just written:**
1. `server/ai/mcp/tools/studio/index.ts` — added to `studioMcpTools` (right after
   `studioMeasureReferenceMcpTools`, before `studioExtractReferenceAssetMcpTools`).
2. `server/ai/tools/studio/agentToolNames.ts` — added `'studio_quality_check'` to
   `STUDIO_AGENT_TOOL_NAMES`, with a comment explaining why it exists alongside
   `studio_compare`/`studio_measure_reference`. `server/ai/tools/studio/index.ts`'s resolver map
   (`byName.get(name)` over `studioMcpTools`, throwing at module load if a name is unregistered)
   is what actually wires name → real `AiTool` — confirmed it does NOT throw:
   `agent-tool-surface.test.ts` (which imports `studioAgentTools`) passes.
3. `server/ai/tools/studio/systemPrompt.ts` — step 5 ("VERIFY") of the required workflow now
   tells the agent explicitly: when no reference is registered, `studio_compare` has nothing to
   measure against, but that's not an exemption from verifying — call `studio_quality_check`
   instead. Verified this actually renders: `systemPrompt.test.ts` still passes (7/7), and
   `studio_quality_check` appears in the auto-built "Tools available" line (it's built from
   `tools.map(t=>t.name).sort().join(', ')` over the same capability-filtered array
   `agent-tool-surface.test.ts` exercises).

**Real defect found and fixed along the way (not scope creep — same file, same responsibility):
`canonicalSummaryForFile`'s cross-file resolution was silently broken.** See A6 below — this
affects A3 only insofar as I built `qualityCheck.ts` reusing the SAME `createWorkspaceProject`/
`parsePageFile` pattern and could have inherited the same bug; I verified with a direct test
(`qualityCheck.test.ts`) that a real two-file project (page + its own `.module.css`) scans
correctly end to end.

**Consumer verified:** `qualityCheck.test.ts`'s handler tests call `tool('studio_quality_check').handler!(...)`
directly against a real temp project with a real `.tsx` importing a real `.module.css` containing
a deliberately low-contrast pair — asserts `findings` contains `low-contrast-pair`, every finding
carries `file`/`line > 0`, and the "no stylesheet imported" / "no screen matched" paths both
degrade honestly (empty findings + explanatory `note`, or `aiToolError` respectively).

---

## A4 — Payload economics

**File:** `server/ai/mcp/tools/studio/compare.ts`.

Added `includeImages?: boolean` to `studio_compare`'s input schema, default `true` (preserves
current behaviour exactly — verified nothing changes for a caller that omits it). When `false`,
the handler still CAPTURES and DECODES both images (the diff score needs the real pixels
regardless), it just skips building the `images: AiToolImage[]` array and omits the `images:
{0:...}` legend key from the returned data — `aiToolOk(data, images)` already treats an empty
array the same as `undefined` (`if (images && images.length > 0) out.images = images`), so no
change needed there.

**Consumer verified:** the system prompt's "Tool use" section (`systemPrompt.ts`, right after
the batching paragraph) now tells the agent explicitly to pass `includeImages:false` on a
later-loop call where it already knows roughly what's wrong, and to leave it `true` (default) on
the first call and any confusing result. `systemPrompt.test.ts` still passes.

---

## A6 — Re-arm the orphaned self-check

**Chosen mechanism: `studio_screenshot` precondition/attachment, not a post-Write/Edit hook —
because no post-Write/Edit hook exists in this architecture to attach to.** The in-canvas
agent's `Write`/`Edit` calls are native Claude Code CLI tools, executed by the CLI subprocess
directly against the filesystem (`claudeCliToolSurface.ts`'s `resolveNativeToolAllowlist` —
`Read/Write/Edit/Glob/Grep` are a `--tools` availability list handed to the `claude` binary, not
calls that round-trip through Studio's own `AiTool` dispatch). There is no per-call interception
point server-side for a native file write; the ONLY guaranteed-to-run-after-a-write path is
`studio_screenshot`, which the agent's own prescribed workflow already calls after every edit
("LOOK. studio_screenshot after writing, every time").

**Files:**
- **New:** `server/handlers/studio/canonicalPageCheck.ts` (+ `.test.ts`, 3 tests) —
  `canonicalSummaryForFile(resolved, dir, relPath, project?)`, extracted from `projectTools.ts`'s
  local (now-deleted) `canonicalSummaryFor`.
- **New:** `server/handlers/studio/pageSourceFile.ts` (+ `.test.ts`, 2 tests) —
  `resolvePageSourceFile(page: Page)`, extracted from `server/ai/tools/studio/liveDigest.ts`'s
  local (now-deleted) `resolvePageFile` — identical logic, now shared by `liveDigest.ts` (its
  original caller, updated to import it) and `screenshot.ts` (the new one).
- `server/ai/mcp/tools/studio/projectTools.ts` — `studio_read_file`'s canonical check now calls
  the shared helper instead of its own local copy (behavior-preserving refactor; its own test,
  `projectTools.test.ts`, still passes unchanged).
- `server/ai/mcp/tools/studio/screenshot.ts` — after a successful capture, for every `ok:true`
  frame whose page resolves to a `.tsx`/`.jsx` source file, runs `canonicalSummaryForFile` and
  attaches `canonical: { isCanonical, violations, advisories }` to that frame's result. A single
  `createWorkspaceProject(dir)` is built ONCE for the whole batch (up to `MAX_FRAMES = 20`) and
  reused across frames — not re-scanned per page.
- `server/ai/tools/studio/liveDigest.ts` — updated to import the extracted
  `resolvePageSourceFile` instead of its own local copy; behavior-preserving (`liveDigest.test.ts`
  still passes, 24/24 combined with `projectTools.test.ts`).

**A real, pre-existing accuracy bug found and fixed while extracting this (not scope creep — same
function, same responsibility, and it directly affects whether re-arming this check onto a new
consumer is even honest to do):** `canonicalSummaryForFile`'s predecessor
(`projectTools.ts`'s original `canonicalSummaryFor`) called `parsePageFile(resolved, dir)` with
NO explicit `project`/`evalOptions` — which defaults to a brand-new, single-file `ts-morph`
`Project` and no `workspaceRoot`. Confirmed by direct testing against this repo's own committed
`studio-workspace/__canonical-fixture/src/screens/CanonicalScreen.tsx` (a screen the fixture's
own docs call "the canonical example," i.e. it is SUPPOSED to score zero violations): parsed
that way, it comes back `isCanonical: false` — a false `const-array-map` violation, because
`CanonicalScreen.tsx`'s `PLANS.map(...)` imports `PLANS` from a SIBLING file
(`../data/plans`), and a single-file `Project` with no `workspaceRoot` cannot resolve that
cross-file const. This means **`studio_read_file`'s `canonical` field has been silently wrong,
in the false-negative direction, for any real screen that imports its `.map` data from another
file** — arguably the most common real shape, not an edge case — since WS-13 shipped. Fixed by
having `canonicalSummaryForFile` build (or accept) a real `createWorkspaceProject(dir)` AND pass
`{ workspaceRoot: dir }` as `StaticEvalOptions` — both were required; the `Project` alone did not
fix it (confirmed by testing that combination in isolation first, and it still failed). Verified
against the fixture: `canonicalPageCheck.test.ts`'s two tests (canonical → 0 violations,
non-canonical → violations > 0) now both pass; before the `workspaceRoot` fix, the canonical one
failed.

**Consumer verified:** `screenshot.ts`'s handler is the actual consumer — verified by reading the
full updated file and confirming the `canonical` field is attached per-frame in the returned
`data.frames[]` before it's sent back as the tool result. No dedicated handler test exists for
`studio_screenshot` (it requires a live editor bridge/browser connection I did not attempt to
mock — same reason `compare.ts` has no handler test either); the pure pieces it depends on
(`resolvePageSourceFile`, `canonicalSummaryForFile`) are each independently tested against the
real fixture, and `projectTools.ts`'s unchanged behavior confirms the shared extraction didn't
regress the ORIGINAL consumer.

**Honest caveat surfaced in the tool description (a plan misdiagnosis worth flagging):** the
work order's A6 text implies `checkCanonicalJsx` catches "inline styles, hardcoded colours, or
fixed widths" reintroduced by the agent. It does not — none of its ten rules
(`docs/reference/canonical-jsx.md` §2) check for a literal inline `style={{...}}` object, a raw
hex colour, or a fixed pixel width; those are prompt-level rules (`systemPrompt.ts`'s "Building
screens" section) with no programmatic check anywhere in the repo. `checkCanonicalJsx` checks
structural EDITABILITY (non-literal props/text/className, spread props, unbounded `.map`, wrong
styling mechanism import, unresolvable SVG, untraceable component import, likely wrapper
elements) — a different, real, and valuable signal, just not the one the plan's prose describes.
I said so explicitly in `studio_screenshot`'s tool description ("It does NOT catch a hardcoded
colour, a fixed pixel width, or a literal inline style object..."). A3's new
`studio_quality_check` (`raw-hex-color`/`raw-px-length`) partially closes the ACTUAL gap the plan
was gesturing at (colours/lengths, at the stylesheet level) — not inline-style-object detection
specifically, which remains genuinely unchecked and would need a real AST scan of JSX
`style={{...}}` literals, out of scope here.

---

## A8 — Font-size measurement caveat

**Files:** `server/handlers/studio/referenceMeasure.ts` (+ `.test.ts`), `server/ai/mcp/tools/studio/measureReference.ts`.

`MeasuredRegion.fontSizePx` gained a required `caveat: string` field, always populated (never
conditional — per the work order, "surface a caveat... rather than returning a bare confident
range," and explicitly "do not attempt per-script calibration tables"). The constant
`FONT_SIZE_RANGE_CAVEAT` states plainly that `CAP_HEIGHT_RATIO`/`ASCENDER_SPAN_RATIO` assume a
Latin UI sans face, and that the range is a coarse estimate — not a calibrated measurement — for
a serif/display face and for a non-Latin script, naming Arabic explicitly (Studio's own RTL
preview axis). Tool description (`measureReference.ts`) and the `units` string in its output
both mention the field so an agent reading either the description or a live result learns it
exists.

**Consumer verified:** `studio_measure_reference` is the only place `MeasuredRegion` is
constructed and returned (`measureReference.ts`'s handler spreads `result.regions` straight into
the tool output) — confirmed by reading the full call chain. Test:
`referenceMeasure.test.ts` — new case asserting the caveat is present, non-empty, and mentions
both "Latin" and "non-Latin" on a real measured region (not just checking the type compiles).

---

## Handoff notes for whoever picks this up next

- **A2's real fix (region-scoped compare)** is specified above under A2, not built. Whoever picks
  it up should start from `frameDiffEngine.ts`'s `computeFrameDiff`/`reconcileReference` and
  decide the "pass" semantics for content below the crop line before touching code.
- **A6's inline-style/hardcoded-value gap** is still open in the form the plan originally
  described (literal `style={{...}}` objects, raw values inside JSX rather than CSS) — A3's
  `studio_quality_check` covers the CSS-level version of "hardcoded colours" and "one-off
  lengths," but not a literal inline style object inside the `.tsx` itself. A real fix would be a
  new `checkCanonicalJsx`-style rule or a small JSX-literal scan, not a CSS-text regex.
- **`studio_screenshot`'s per-batch `createWorkspaceProject(dir)` call is a real, accepted cost**:
  `studio_screenshot` already calls `loadStudioPages(dir)` (which builds and discards its OWN
  internal workspace-aware `ts-morph` `Project` — that internal project is never exposed in
  `StudioLoadResult`), so the canonical-check pass now performs a SECOND full-workspace scan in
  the same call. Bounded (once per `studio_screenshot` call, not per frame) and not pathological
  for a real project, but a cleaner fix would extend `StudioLoadResult` to expose its internal
  `Project` for reuse — a larger, separately-scoped refactor of `studioPageLoad.ts`, which is
  currently being touched by another concurrent agent (do not start it without checking who owns
  that file now).
- I did **not** touch `src/admin/pages/site/store/**`, `panels/**`, or `canvas/**` at any point.

## Files touched (all new-file paths are absolute-path-safe from repo root)

New:
- `server/handlers/studio/qualityAudit.ts`, `qualityAudit.test.ts`
- `server/ai/mcp/tools/studio/qualityCheck.ts`, `qualityCheck.test.ts`
- `server/handlers/studio/canonicalPageCheck.ts`, `canonicalPageCheck.test.ts`
- `server/handlers/studio/pageSourceFile.ts`, `pageSourceFile.test.ts`
- `server/ai/chatSystemPrompt.ts` (module-size-budget split, see below)

Modified:
- `server/handlers/studio/turnDesignReferences.ts`, `.test.ts` (A1)
- `server/ai/handlers/chat.ts` (A1 threading + module-size-budget split)
- `server/ai/tools/studio/systemPrompt.ts`, `.test.ts` (A1 trap, A3 mention, A4 mention)
- `server/ai/mcp/tools/studio/frameDiffEngine.ts`, `.test.ts` (A2)
- `server/ai/mcp/tools/studio/compare.ts` (A2, A4)
- `server/ai/mcp/tools/studio/diffFrames.ts` (A2)
- `server/ai/mcp/tools/studio/exportFrames.ts` (A2)
- `server/ai/mcp/tools/studio/designReferenceTools.ts`, `.test.ts` (A2)
- `server/handlers/studio/boardGeometry.ts` (A2)
- `src/core/ai/toolSchemas.ts` (A2)
- `server/ai/mcp/tools/studio/index.ts` (A3 — registered `studio_quality_check`)
- `server/ai/tools/studio/agentToolNames.ts` (A3 — added `studio_quality_check`)
- `server/ai/mcp/tools/studio/projectTools.ts` (A6 — use shared `canonicalSummaryForFile`)
- `server/ai/mcp/tools/studio/screenshot.ts` (A6 — re-arm canonical check)
- `server/ai/tools/studio/liveDigest.ts` (A6 — use shared `resolvePageSourceFile`)
- `server/handlers/studio/referenceMeasure.ts`, `.test.ts` (A8)
- `server/ai/mcp/tools/studio/measureReference.ts` (A8)

## Module-size-budget fix (not one of A1-A8, requested mid-task by the coordinator)

`server/ai/handlers/chat.ts` was 721 lines (over the 700-line ceiling; grown from 698 by my own
A1 threading). Split `buildCmsSiteSystemPrompt`/`buildStudioProjectSystemPrompt`/
`emptySiteAgentSnapshot` out into `server/ai/chatSystemPrompt.ts` — NOT `server/ai/handlers/
chatSystemPrompt.ts`, because every other file directly under `server/ai/handlers/` is scanned by
`ai-handlers-capability-gated.test.ts` (a flat, non-recursive `readdirSync`) and required to call
`requireCapability`; this module never touches a `Request` (it runs after `chat.ts`'s own gate),
so it was moved a level up to `server/ai/` — a sibling of the existing `contextTokens.ts`/
`inputImages.ts` helpers, not inside `handlers/`. `chat.ts` re-exports both functions from the new
location so `server/ai/handlers/chat` stays their public import path (unchanged for
`src/__tests__/agent/studioProjectSystemPrompt.test.ts` and `chatSnapshotValidation.test.ts`,
both of which import from that exact path and both still pass). Final sizes: `chat.ts` 616 lines,
`chatSystemPrompt.ts` 133 lines. `module-size-budgets.test.ts` and
`ai-handlers-capability-gated.test.ts` both pass; the other 3 modules the coordinator flagged
(`cssToStyleRules.ts`, `server/handlers/studio.ts`, `studioWriteback.ts`) belong to other agents
and were already back under the ceiling by the time I re-ran the gate — I did not touch any of
the three.
