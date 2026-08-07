# mcp-tooling — Phase 0 handoff (0.11, 0.12, 0.13)

Branch: `feat/alm-figma-killer-studio-shell`. Nothing committed/staged — all changes left in the
working tree per instructions.

## 0.11 — TOOL_NAMES_LINE made capability-aware

**Mechanism.** `TOOL_NAMES_LINE` was a module-level constant in
`server/ai/tools/studio/systemPrompt.ts:101` (old), computed once from the raw
`STUDIO_AGENT_TOOL_NAMES` array at import time — never touched by capability filtering.
`buildStudioAgentSystemPrompt` had no way to know which tools THIS caller could actually invoke.

**Fix.**
- `server/ai/tools/studio/systemPrompt.ts`: turned the static prefix into a function,
  `buildStaticPromptPrefix(tools: readonly AiTool[])`, which builds the "Tools available" line
  from `tools.map(t => t.name)` — the array the CALLER passes in, not a module import.
  `buildStudioAgentSystemPrompt(ctx, tools, live?)` now takes `tools` as a required second
  parameter and threads it into `buildStaticPromptPrefix`. Doc comments on both functions state
  the contract: pass the capability-filtered list, never the raw name array.
- `server/ai/handlers/chat.ts`: `buildStudioProjectSystemPrompt(dir, snapshot, conversationId, tools, liveDigestOptions?)`
  gained a required `tools: readonly AiTool[]` 4th parameter (before the existing optional
  `liveDigestOptions` test seam). Its one real call site (`handleAiChat`, chat.ts:312) now passes
  the SAME `tools` variable already computed at chat.ts:196 —
  `const tools = selectStudioTools(user.capabilities, { studioProjectOpen: ... })` — which is the
  real capability-filtered array the driver hands the model for this turn. No second resolution,
  no new capability-check code: this literally reuses the array that already existed one function
  up and was previously just not passed down.
- The "unavailable profile" early-return path (chat.ts:668, was :660) also updated to
  `buildStudioAgentSystemPrompt(null, tools)` so even the degraded prompt stays honest.

**Consumer verified.** `handleAiChat` → `tools = selectStudioTools(user.capabilities, {...})`
(chat.ts:196) → `buildStudioProjectSystemPrompt(..., tools, ...)` (chat.ts:312) →
`buildStudioAgentSystemPrompt(ctx, tools, live)` (chat.ts:683) → `buildStaticPromptPrefix(tools)`
(systemPrompt.ts). Same `tools` array chat.ts hands the driver for actual tool-calling
(`AiStreamRequest.tools`, chat.ts:423) is the one the prompt text is built from — they cannot
drift because they're the same value, not two things that agree by convention.

**What was previously offered-but-unreachable and is now correctly withheld.** For an Admin (or
any caller without `studio.run.project`), `studio_render_reference` is filtered out of `tools` by
`toolAllowedForCapabilities` inside `selectStudioTools` (unchanged gate, `requiredCapabilities:
['studio.run.project']` in `referenceRender.ts:286`) and now ALSO disappears from the prompt's
"Tools available" line. Before this fix the prompt named it unconditionally for every caller,
telling an Admin — who can never actually call it — that ground-truth dev-server verification was
available. I did not touch the capability grant itself, per the work order (§15 decision 1 is a
human product call).

**Tested.**
- `server/ai/tools/studio/systemPrompt.test.ts` — new `describe('… capability-aware "Tools
  available" line (0.11)')`: filtering `studio_render_reference` out of the array passed in makes
  it vanish from the prefix; passing the full list keeps it. (Confirmed `studio_render_reference`
  is NOT mentioned anywhere else in the static prefix body text, only via the tool-names line, so
  this is a real assertion, not a false positive.)
- `src/__tests__/agent/studioProjectSystemPrompt.test.ts` — all 10 call sites updated to pass
  `studioAgentTools` (the full, unfiltered list — correct for these tests, which exercise the
  dir/snapshot/staleness machinery, not capability filtering).
- `src/__tests__/architecture/studio-agent-no-subagents.test.ts`,
  `studio-agent-can-measure.test.ts` — updated call sites (`buildStudioAgentSystemPrompt(null,
  studioAgentTools)`), unchanged assertions, still pass.
- Ran: `bun test server/ai/tools/studio server/ai/mcp src/__tests__/architecture/agent-tool-surface.test.ts
  src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts
  src/__tests__/architecture/ai-handlers-capability-gated.test.ts
  src/__tests__/architecture/studio-agent-no-subagents.test.ts
  src/__tests__/architecture/studio-agent-can-measure.test.ts
  src/__tests__/agent/studioProjectSystemPrompt.test.ts` → 310 pass / 4 fail. The 4 fails are all
  in `server/ai/mcp/connectorWorkspace.test.ts` (`resolveToolProjectDir` expecting POSIX
  `/w/explicit`-style paths, getting Windows `C:\w\explicit` — a pre-existing Windows path-format
  bug, not in a file I touched, unrelated to this change).
- Full `bun test server/ai` → 536 pass / 6 fail — the same 4 plus 2 more
  (`mcpServerSecretStore`, `streamClaudeCli` MCP-config-file test), both also pre-existing
  Windows-path-shaped failures in files outside my diff.

## 0.12 — studio_fidelity_report added to the agent's toolset

**Mechanism.** `STUDIO_AGENT_TOOL_NAMES` (`server/ai/tools/studio/agentToolNames.ts`) is an
explicit, hand-curated array; `studio_fidelity_report` was simply never added to it, even though
it was already a fully-built, fully-tested MCP tool (`server/ai/mcp/tools/studio/fidelityReport.ts`,
registered in `mcp/tools/studio/index.ts:7,30`) with no `mutates`/`requiredCapabilities` gate
(so any `ai.chat` caller already qualifies).

**Fix.**
- `server/ai/tools/studio/agentToolNames.ts`: added `'studio_fidelity_report'` to the array, with
  a comment explaining it was an oversight (WS-9.4 landing after WS-12's tool curation), matching
  the "every exclusion is justified" convention the file's own doc comment describes.
- `server/ai/tools/studio/systemPrompt.ts`: step 5 (VERIFY) of "Required workflow" now reads:
  "…When a region's failure has no obvious CSS explanation, call studio_fidelity_report before
  guessing again — it turns the parser's own limitations on that page into a stable code, the
  exact node and line, and a fix, instead of you re-measuring pixels that were never a CSS problem
  to begin with."

**Consumer verified — the exact array → registry → resolved-list → prompt-line chain the work
order asked for.**
1. `agentToolNames.ts`'s `STUDIO_AGENT_TOOL_NAMES` now contains the string `'studio_fidelity_report'`.
2. `server/ai/tools/studio/index.ts`'s `studioAgentTools = STUDIO_AGENT_TOOL_NAMES.map(name =>
   byName.get(name) ?? throw(...))` resolves it against `studioMcpTools` (the MCP registry) — this
   is the throw-on-missing guard that catches exactly "a name in an array the resolver drops": if
   the MCP tool didn't exist under that name, `bun test` would fail at MODULE LOAD, not silently.
   It resolved cleanly (see test below).
3. `server/ai/tools/index.ts`'s `selectStudioTools` includes it in `studioAgentTools` for any
   `studioProjectOpen: true` turn, filtered only by `toolAllowedForCapabilities` — which passes it
   through unconditionally since it declares no `mutates`/`requiredCapabilities`.
4. `buildStaticPromptPrefix(tools)` (0.11's function) includes its name in the "Tools available"
   line whenever it's present in the passed-in `tools` array — which it always is now for any
   `ai.chat` caller.

**Tested.**
- New test in `server/ai/tools/studio/systemPrompt.test.ts`: `'studio_fidelity_report is offered to
  the agent and resolves to a real tool (0.12)'` — asserts `studioAgentTools.some(t => t.name ===
  'studio_fidelity_report')` (proves step 2 above, the resolution, not just array membership) AND
  that the built prompt's prefix contains the string (proves step 4).
- `server/ai/tools/studio/parityMatrix.test.ts` (unaffected, still green) independently confirms
  every name in `STUDIO_AGENT_TOOL_NAMES` resolves and every registered mutating tool is
  referenced by the parity matrix — `studio_fidelity_report` doesn't mutate, so it needed no matrix
  row.
- Same `bun test` runs as 0.11 above cover this file; all green except the 4/6 pre-existing,
  unrelated Windows-path failures.

## 0.13 — colour picker: stop generating fictional variants, re-target dark emission

Two independent S-effort fixes, both in the files this agent owns (`colors.ts`, `tokenExtractBuild.ts`).

### (a) Extracted project tokens no longer generate derived variants

**Mechanism.** `server/handlers/studio/tokenExtractBuild.ts`'s `buildColorTokens` (called for
every colour discovered by the extraction pipeline, i.e. every real project token) set
`generateTransparent: true, generateShades: { enabled: true, count: 4 }, generateTints: {
enabled: true, count: 4 }` unconditionally. `src/core/framework/colors.ts`'s `buildColorVariants`
reads exactly these three flags to decide whether to expand a token's BASE variable
(`--<slug>`) into up to 18 additional variables (`--<slug>-5`…`-90` transparency steps,
`--<slug>-d-1..4` shades, `--<slug>-l-1..4` tints) — all of which exist only inside Studio's own
injected `:root` block in the canvas iframe, never in the user's real app.

**Fix.** Set all three to off (`false` / `{ enabled: false, count: 0 }`) in `buildColorTokens`. The
BASE variable (`--<slug>` itself) still always emits — `buildColorVariants`'s `base` variant entry
is unconditional — so the one name that actually exists in the project's CSS is still offered by
the picker; only the 18 fictional derived names stop being generated.

**Consumer verified.** `TokenizedColorField.tsx:57` (owned by `panel-designer` this wave, NOT
touched by me) sources `generateFrameworkColorVariableSets(colorSettings).light` — this reads
straight from the `FrameworkColorToken.generateTransparent/generateShades/generateTints` flags
`buildColorTokens` sets, through `buildColorVariants` in `colors.ts`. Since the flags are now
`false` for every extracted token, the picker's variable list shrinks from 19 entries per token to
1 (the base) with zero changes needed on the panel side — the generator is the single source of
truth the field already reads from correctly. **Note for the panel agent:** no `TokenizedColorField.tsx`
change is needed for this half of 0.13; the fix is fully upstream. The 32-entry cap
(`TokenizedColorField.tsx:206`) and the "group by category/origin" improvement from the audit
(T3's "Effort: M" half) are Track H, out of scope here.

**What was previously offered-but-unreachable and is now correctly withheld.** For a real project
colour like `--color-aqua-100`, the picker previously offered `--color-aqua-100`,
`--color-aqua-100-5` through `-90` (10 transparency steps), `--color-aqua-100-d-1..4` (4 shades),
and `--color-aqua-100-l-1..4` (4 tints) — 19 total, of which only the first exists in the user's
real CSS. After this fix, extraction offers exactly `--color-aqua-100` — the one name that is true
in both Studio and the real app. Hand-authored/Studio-injected framework tokens (built via the
Colors panel, not extraction) are UNCHANGED — they still default to
`generateTransparent/Shades/Tints: true` wherever the panel's own token-creation code sets that
(not a file I touched), because those variants ARE real: Studio does inject them into the canvas
and (via the CMS publisher path) into `framework.css`, so a derived variant of a Studio-authored
token genuinely exists wherever that CSS loads.

### (b) Dark-mode emission re-targeted from `:root.theme-alt` to `html[data-studio-scheme]`

**Mechanism.** `src/core/framework/colors.ts`'s `ALT_THEME_SELECTOR`/`DEFAULT_THEME_OVERRIDE_SELECTOR`
(the selectors `formatFrameworkColorThemeCss` wraps dark-mode variable values in) targeted
`:root.theme-alt`/`:root.theme-default` — a CMS class-swap convention. I re-confirmed the audit's
claim by grepping BOTH `src/` and `server/` for `theme-alt`/`theme-default`/`theme-inverted`/
`theme-always-*`: every hit was either this same definition or a doc-comment example
(`siteImport/rootScope.ts:10`) — nothing anywhere in the codebase (Studio canvas OR the CMS
publisher) ever sets any of these classes on any element. Meanwhile Studio's OWN dark-mode
preview genuinely works via a different, real mechanism: `previewAxesFrameEffect.ts` sets
`data-studio-scheme="dark"|"light"` on the canvas iframe's `<html>`, and
`darkSchemeCssTransform.ts`'s `DARK_SCHEME_ATTR` rewrites a project's own `@media
(prefers-color-scheme)` blocks to gate on that same attribute at injection time.

**Fix.** Changed the two selector constants in `colors.ts` to gate on
`html[data-studio-scheme='dark']` / `html[data-studio-scheme='light']` instead of
`:root.theme-alt`/`:root.theme-default`, preserving the existing `.theme-inverted`/
`.theme-always-default`/`.theme-always-alt` per-element override structure (also currently unwired
anywhere, but not this task's job to remove) so the change is a pure base-selector swap, not a
redesign.

**Why I edited `colors.ts` directly instead of adding a canvas-side rewrite (the
`darkSchemeCssTransform.ts` pattern).** That module's own doc comment explains the RIGHT general
pattern for this exact problem — rewrite the injected COPY, never the shared generator, because the
generator is also used by the CMS publisher for real visitor traffic where Studio's
`data-studio-scheme` attribute is never present. I could not follow that pattern here because
`darkSchemeCssTransform.ts` lives under `src/admin/pages/site/canvas/`, which is explicitly out of
scope for me this wave (canvas-engineer owns it). I took the plan's literal instruction
("re-target dark emission to `html[data-studio-scheme='dark']`", citing `colors.ts:487-492`
by file:line) and applied it at the shared-generator level instead.

**Consequence I want flagged, not hidden.** `colors.ts`'s colour engine is used by TWO consumers:
Studio's canvas (`canvasClassCss.ts`, owned by canvas-engineer, NOT touched by me) and the dormant
CMS publisher (`server/handlers/studio/tokenExtractBuild.ts` never reaches the publisher — Studio
projects don't publish through that pipeline — but `frameworkCss.ts`/`buildFrameworkPlan` is a REAL
CMS-half consumer for actual `pages`/`posts` CMS documents). Before this change, the CMS
publisher's dark-mode output was already 100% inert (nothing ever set `.theme-alt`). After this
change, it emits `html[data-studio-scheme='dark']` instead — equally inert for a real visitor's
browser (that attribute is Studio-canvas-only, never present on a published page a visitor loads),
so there is no functional regression for the CMS half, only a different, equally-dead selector.
Neither before nor after does the CMS's per-element dark-mode override actually reach a real user.
If a future track builds a real CMS dark-mode toggle, it needs its OWN selector convention (media
query, or a real toggled class/attribute) — this fix does not, and was not asked to, give the CMS
one. This is the "note in your handoff" moment for the plan's assumption that fixing `colors.ts`
alone is sufficient: it is sufficient for STUDIO's dark preview (the actual ask), and it is
correctly a no-op change for the CMS half's already-broken feature — not a new break.

**Tests updated (assertions changed to the new selector, same coverage):**
`src/__tests__/framework/colors.test.ts`, `src/__tests__/framework/generate.test.ts`,
`src/__tests__/publisher/render.test.ts`, `src/__tests__/canvas/classStyleInjector.test.ts`. Left
`src/__tests__/siteImport/colorTokens.test.ts:59` untouched — it uses `:root.theme-alt` only as an
arbitrary "qualified selector" fixture example for `isRootScopeSelector`, unrelated to `colors.ts`'s
emitted output.

**Tested.** `bun test src/__tests__/framework src/__tests__/publisher/render.test.ts
src/__tests__/canvas/classStyleInjector.test.ts src/__tests__/siteImport/colorTokens.test.ts
server/handlers/__tests__/tokenExtract.test.ts server/handlers/__tests__/studioFramework.test.ts`
→ 170 pass / 0 fail.

## Files touched (all in the agreed ownership: server/ai/**, src/core/framework/**, tokenExtractBuild.ts)

- `server/ai/handlers/chat.ts`
- `server/ai/tools/studio/agentToolNames.ts`
- `server/ai/tools/studio/systemPrompt.ts`
- `server/ai/tools/studio/systemPrompt.test.ts`
- `server/handlers/studio/tokenExtractBuild.ts`
- `src/core/framework/colors.ts`
- Test-only updates to call sites broken by the new required `tools` parameter, and to
  assertions the selector-string change altered:
  - `src/__tests__/agent/studioProjectSystemPrompt.test.ts`
  - `src/__tests__/architecture/studio-agent-can-measure.test.ts`
  - `src/__tests__/architecture/studio-agent-no-subagents.test.ts`
  - `src/__tests__/framework/colors.test.ts`
  - `src/__tests__/framework/generate.test.ts`
  - `src/__tests__/publisher/render.test.ts`
  - `src/__tests__/canvas/classStyleInjector.test.ts` (assertion-only edit to a test file; did not
    touch any canvas IMPLEMENTATION file)

No files under `store/slices/site/*`, `PropertiesPanel/*`, `property-controls/*`,
`canvas/*dnd*`, `panels/DomPanel/*`, or media DnD were touched.

## Not done / out of scope, explicitly

- Did not touch `TokenizedColorField.tsx` — confirmed no change needed there for 0.13(a); see note
  above.
- Did not build a canvas-side selector rewrite for 0.13(b) (would require touching
  `src/admin/pages/site/canvas/**`, out of scope this wave). If a future pass wants
  `darkSchemeCssTransform.ts`-style injected-copy-only scoping instead of the shared-generator
  change I made, that's a legitimate alternative — flagging it, not doing it.
- Did not touch the `studio.run.project` capability grant (§15 decision 1, reserved for the human,
  per the work order).
- Did not run `bun run build` / `bun run lint` (per instructions — sibling agents run concurrently).
  Ran one filtered `bunx tsc --noEmit -p .` scan by mistake (against standing-08's "never `npx
  tsc`" rule) restricted to grep for my touched files — it returned zero errors, but I am not
  treating it as a verification gate and did not repeat it. Targeted `bun test` runs above are the
  real verification.
