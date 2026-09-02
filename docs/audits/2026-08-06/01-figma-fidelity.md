# Audit: How effective is the agent at producing a 1:1 copy of a Figma design?

Scope: `server/ai/mcp/tools/studio/*`, `server/handlers/studio/{referenceMeasure,colorMath,projectTokenIndex,turnDesignReferences,designReferenceStore,remoteAssetFetch}.ts`, `server/ai/tools/studio/{agentToolNames,systemPrompt}.ts`, `server/ai/drivers/{claudeCli,claudeCliToolSurface,claudeCliPermissionMode}.ts`, `server/handlers/studio/{projectGuide,designSystemGuide,designSystemDigest}.ts`, plus every module these import that bears on the fidelity loop (canvas capture path, editor bridge, capability gate).

Format: one finding per ID, with Severity / Evidence (file:line + snippet) / Root cause / Proposed fix / Effort + dependencies.

---

## F1 — `studio_render_reference` is advertised in the system prompt but unreachable for the normal (Admin) role

**Severity: MAJOR**

**Evidence:**

`server/auth/capabilities.ts:90-93`
```
// `studio.run.project` is deliberately NOT granted: that is Tier 2 —
// executing the open project's own code (dev server + Playwright) — and
// stays opt-in per its note in `src/core/capabilities.ts`.
'studio.write',
```
(the `adminCapabilities` array ends at `studio.write` — `studio.run.project` is never in it)

`server/ai/tools/studio/agentToolNames.ts:36-45`
```
export const STUDIO_AGENT_TOOL_NAMES: readonly string[] = [
  'studio_screenshot',
  'studio_compare',
  'studio_measure_reference',
  'studio_render_reference',
  ...
```

`server/ai/tools/studio/systemPrompt.ts:101`
```
const TOOL_NAMES_LINE = [...STUDIO_AGENT_TOOL_NAMES].sort().join(', ')
```
— built once from the static list, **never filtered by the caller's capabilities**.

`server/ai/mcp/registry.ts:97-99`
```
export function mcpToolsForStudioWorkspace(capabilities: readonly CoreCapability[]): AiTool[] {
  return studioAgentTools.filter((t) => toolAllowedForCapabilities(t, capabilities))
}
```
— this is the function that actually produces the connector's live `tools/list` (traced through `server/ai/drivers/claudeCliTurnConnector.ts:73`, `mint(options.db, options.userId, options.capabilities, ...)`, where `options.capabilities` = `req.toolContextBase.capabilities` = `user.capabilities` set in `server/ai/handlers/chat.ts:196`).

`server/ai/mcp/tools/studio/referenceRender.ts:286`
```
requiredCapabilities: ['studio.run.project'],
```

**Root cause:** The prompt's "Tools available" line is a static, unfiltered string built from `STUDIO_AGENT_TOOL_NAMES`, while the actual MCP surface the CLI subprocess discovers via `tools/list` is capability-filtered through `toolAllowedForCapabilities`. Since the Admin role — the role every real Studio operator has — never receives `studio.run.project` (a deliberate Tier-2 gate on executing the project's own dev server), `studio_render_reference` silently disappears from the live toolset while the prompt still claims it exists. This tool is the *only* one that renders the project's actually-executing app through a real browser (ground truth), as opposed to every other Studio tool, which reads the static AST-parsed canvas. Its absence means "done" is only ever validated against the static parse, never against the real running app — a gap the parse-never-execute architecture papers over silently for the common case.

**Proposed fix:** Either (a) grant `studio.run.project` to Admin as a deliberate risk decision in `server/auth/capabilities.ts`, or (b) make `TOOL_NAMES_LINE` in `server/ai/tools/studio/systemPrompt.ts` capability-aware (pass the resolved tool list, not the raw name array, from `server/ai/tools/studio/index.ts`) so the prompt never claims a tool the connector doesn't actually expose.

**Effort:** S (systemPrompt fix) or a product decision (capability grant). No dependency on other areas — pure `mcp-tooling`/`server-engineer` change.

---

## F2 — The 1568px vision-safe image edge cap silently degrades `studio_compare` to a resampled (non-exact) diff for any tall screen

**Severity: MAJOR**

**Evidence:**

`src/admin/pages/site/agent/renderEvidence.ts:19-23`
```
// Anthropic rejects any image dimension > 8000px outright (400), and internally
// downsizes the long edge to ~1568px before the model ever sees it. So we cap
// the long edge of the capture here...
const MAX_IMAGE_EDGE = 1568
```

`src/admin/pages/site/agent/renderEvidence.ts:412-421`
```
// Cap BOTH dimensions at MAX_IMAGE_EDGE (never upscale past 1:1, even when
// a caller asks for a higher `pixelRatioOverride` ...)
const requestedRatio = pixelRatioOverride && pixelRatioOverride > 0 ? pixelRatioOverride : 1
const pixelRatio = Math.min(
  requestedRatio,
  MAX_IMAGE_EDGE / Math.max(1, captureRegion.width),
  MAX_IMAGE_EDGE / Math.max(1, captureRegion.height),
)
```

`server/ai/mcp/tools/studio/designReferenceTools.ts:264` (`studio_recommend_export_dpr` description) — warns only about the *width*-side vision cap ("`exactWidthMatchExpected` is false when either that clamp OR the shared vision-safe edge cap will keep the capture narrower than the reference"), never mentions the height-side clamp.

`server/ai/mcp/tools/studio/frameDiffEngine.ts:105-137` (`reconcileReference`) — falls back to `method: 'resampled'` (sharp `.resize(..., { fit: 'fill' })`) whenever captured dimensions don't exactly match the reference, which is the case whenever the height clamp kicks in.

**Root cause:** `pixelRatio` is clamped by *both* width and height against the same 1568px ceiling. For any board frame whose CSS content height exceeds roughly `1568 / desiredDpr` (e.g. ~784 CSS px at a 2x-matching dpr — true of most real scrolling mobile screens), the height-driven clamp reduces the achieved dpr below what `studio_recommend_export_dpr` calculated from width alone. The capture then lands at a size that doesn't match the reference's pixel width, `reconcileReference` falls into the `resampled` branch, and the comparison is diffed through nearest/bilinear-interpolated pixels instead of exact ones — introducing interpolation noise into the exact rectangles the tool exists to measure precisely. This is disclosed honestly via `capture.dimensionMatch` in the result but never flagged proactively, and the recommend-dpr tool's own docs don't warn about it.

**Proposed fix:** Extend `studio_recommend_export_dpr`'s description/output in `server/ai/mcp/tools/studio/designReferenceTools.ts` to name the height-side clamp explicitly. Longer-term, consider a node/region-scoped compare (crop the comparison to a viewport-height slice) for tall frames so exact-pixel diffing survives scroll-unrolled content — would touch `frameDiffEngine.ts` + `compare.ts`.

**Effort:** S (doc fix) / M (region-scoped compare). No cross-area dependency for the doc fix; the region-scoped version touches `canvas-engineer` territory (scroll-unroll geometry).

---

## F3 — Chat-pasted design references are never page-scoped, so `studio_compare` silently drifts to the wrong screen mid-conversation

**Severity: MAJOR**

**Evidence:**

`server/handlers/studio/turnDesignReferences.ts:78-97`
```
export async function registerTurnDesignReferences(
  dir: string,
  imageBytes: readonly Uint8Array[],
): Promise<DesignReference[]> {
  ...
      const result = await registerDesignReference(dir, bytes, {
        label: imageBytes.length > 1 ? `Attached in chat (${index + 1})` : 'Attached in chat',
        source: CHAT_ATTACHMENT_REFERENCE_SOURCE,
      })
```
— no `pageId` is ever passed.

`server/ai/handlers/chat.ts:306-308`
```
if (validatedWorkspaceDir && preflight.imageBytes.length > 0) {
  await registerTurnDesignReferences(validatedWorkspaceDir, preflight.imageBytes)
}
```
— confirmed by grep: this is the only call site, and it never threads a page id through.

`server/ai/mcp/tools/studio/referenceResolve.ts:34-59` (`resolveDesignReference`)
```
const scoped = listDesignReferences(dir, pageId, undefined)
const forPage = scoped.references[scoped.references.length - 1]
if (forPage) return { ok: true, reference: forPage, implicit: true }

const all = listDesignReferences(dir, undefined, undefined)
const mostRecent = all.references[all.references.length - 1]
if (mostRecent) return { ok: true, reference: mostRecent, implicit: true }
```

**Root cause:** Every image a user pastes into chat is armed automatically and unconditionally with no `pageId` (the turn has no way to know which screen the image is *for* before the model has even run). `resolveDesignReference`'s fallback chain is "explicit id → this page's own → most recently registered, project-wide." Since a chat-pasted reference is never scoped, it can never win the "this page's own" branch for ANY page, so as soon as a second Figma frame is pasted later in the same conversation (for screen 2, 3, …), every subsequent implicit `studio_compare`/`studio_measure_reference` call for screen 1 will silently pick up screen 2's (or the newest) reference instead of its own — exactly the flagship "paste several Figma frames across a conversation and build several screens" workflow. The live prompt digest (`systemPrompt.ts:289-297`) does show `pageId` when set, so a careful agent COULD notice an unscoped reference, but nothing in the prompt instructs it to re-scope one for the ordinary "plain paste" case — the only WRONG/RIGHT example in the prompt (`systemPrompt.ts:194-197`) covers the Figma-connector-download path, not this one.

**Proposed fix:** Thread the turn's live active-page id (already available via the digest snapshot built earlier in the same request) into `registerTurnDesignReferences` in `server/handlers/studio/turnDesignReferences.ts` (add an optional `pageId` param) and its call site in `server/ai/handlers/chat.ts:306-308`. Additionally add an explicit trap entry to the "Common failures to avoid" section of `server/ai/tools/studio/systemPrompt.ts` warning that an unscoped reference resolves to "most recent project-wide" and must be re-registered with `pageId` before building a second screen in the same conversation.

**Effort:** M — touches `server/handlers/studio/turnDesignReferences.ts`, its test, `server/ai/handlers/chat.ts`, and the prompt. No dependency on parser/canvas/store; pure `mcp-tooling`/`server-engineer`.

---

## F4 — The real Figma Dev Mode integration path (exact tokens, vector assets) is opt-in and effectively invisible by default

**Severity: MAJOR**

**Evidence:**

`server/ai/drivers/projectMcpServers.ts:26-36`
```
// So: keep the flag, and merge in project servers the user has EXPLICITLY
// approved by name (`.studio/meta.json`'s `approvedMcpServers`).
...
//   - nothing is approved by default, and an absent list means none;
```

`server/handlers/studio/remoteAssetFetch.ts:207-238` (`loopbackAssetFetchEnabled` / `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH`)
```
* The concrete case is the Figma Dev Mode MCP server: it is the ONLY Figma
* server a Studio agent gets (`BUILT_IN_MCP_SERVERS`, `127.0.0.1:3845`), and
* every asset it exposes ... is served from
* `http://localhost:3845/assets/...`. The SSRF guard blocked that origin, so
* "the agent cannot download images or SVGs" was a true statement about the
* product, not a model failure.
```

`server/ai/tools/studio/systemPrompt.ts:127` — "If a Figma connector is available, its VARIABLE-DEFINITIONS tool is the best source that exists... Exact, not estimated."

**Root cause:** The prompt's own best-case fidelity path (exact design tokens + real vector/image assets via a Figma Dev Mode MCP connector) requires three separate, non-default setup steps to all be true simultaneously: (1) the project must declare the server in its own `.mcp.json`, (2) the user must explicitly approve that server BY NAME in Studio (`approvedMcpServers`), and (3) because the Dev Mode server binds to loopback, the operator must set `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH=1` or the SSRF guard blocks every asset URL it returns. None of this ships or is nudged by default. Until all three are done, "paste a Figma frame" silently degrades to the raster-only fallback (`studio_measure_reference` pixel measurement + `studio_extract_reference_asset` cropping), which is measurably less accurate (ranged font sizes, no true vectors) but produces no error telling the user they're on the fallback path.

**Proposed fix:** Not a code bug in the security sense — the gating is deliberate and correct. The gap is discoverability: add an onboarding nudge (e.g. in Settings → AI → MCP, or a first-time banner in the Studio chat panel) that detects "no Figma MCP server approved" and walks the user through approving one, so the accuracy gap is visible instead of silent.

**Effort:** M (UI nudge) — `panel-designer` territory, not `mcp-tooling`. No parser/canvas dependency.

---

## F5 — `studio_fidelity_report`, "the single most useful tool in the studio MCP family," is missing from the in-canvas agent's toolset

**Severity: MAJOR**

**Evidence:**

`server/ai/mcp/tools/studio/fidelityReport.ts:11-12`
```
* Walks every loaded page's node tree and turns `PageNode.lockReason` /
* `PageNode.resolution` / `PageNode.codeProps` into stable finding codes
* ... This is the single most useful tool in the studio MCP family
```

`server/ai/tools/studio/agentToolNames.ts:36-69` — the full `STUDIO_AGENT_TOOL_NAMES` array; `studio_fidelity_report` is absent. Every OTHER deliberate exclusion in this file (`studio_read_file`, `studio_diff_frames`, `studio_recommend_export_dpr`, etc.) is named and justified in the file's own doc comment (lines 17-34); `studio_fidelity_report` appears in neither the list nor the exclusion rationale.

**Root cause:** The agent has no way to learn, at the parser level, WHY a region a `studio_compare` diff flags is wrong — whether it's an unresolved `.map` (`DYNAMIC_CONTENT_UNRESOLVED`), a dynamically-built SVG, a heuristically auto-selected conditional branch, or a genuinely wrong CSS value it authored. Without this tool the agent can only guess from pixels + prose every time, even though a structural, actionable diagnosis (with a suggested source restructure) is one call away. Given the absence has no documented rationale (unlike every sibling exclusion), this reads as an oversight from WS-9.4 shipping after the WS-12 tool curation rather than a deliberate simplification.

**Proposed fix:** Add `'studio_fidelity_report'` to `STUDIO_AGENT_TOOL_NAMES` in `server/ai/tools/studio/agentToolNames.ts`. Optionally add one line to the "Required workflow" section of `server/ai/tools/studio/systemPrompt.ts` suggesting it be called when a `studio_compare` region can't be explained by an obvious CSS error.

**Effort:** S — one array entry + prompt line. No dependency on other areas.

---

## F6 — Measured font-size range assumes Latin UI-sans metrics; no caveat for other scripts/fonts

**Severity: MINOR**

**Evidence:**

`server/handlers/studio/referenceMeasure.ts:120-123`
```
/** Cap-height as a share of em for common UI sans faces (Open Sans 0.714, Inter 0.727, SF 0.70). */
const CAP_HEIGHT_RATIO = 0.72
/** Ascender-to-descender ink span as a share of em, the other end of the range. */
const ASCENDER_SPAN_RATIO = 0.95
```

**Root cause:** These ratios are calibrated for common Latin UI sans faces and are silently wrong for serif/display fonts and for non-Latin scripts — notably Arabic, which Studio explicitly supports via its RTL preview axis (`docs/agent-refs` RTL work, `RTL_PHYSICAL_PROPERTY` finding code). The tool returns a confident-looking range with no signal that the underlying assumption may not hold for the measured glyphs.

**Proposed fix:** Add a coarse script-detection heuristic (ratio of non-Latin Unicode codepoints, if any text-layer hint is ever available, or simply a min/max-ink-row-width heterogeneity check) in `measureReference`/`measureOne` (`server/handlers/studio/referenceMeasure.ts`) and surface a `caveat` string on `MeasuredRegion.fontSizePx` when the region looks atypical, rather than a bare unqualified range.

**Effort:** S/M — self-contained in `referenceMeasure.ts`. No cross-area dependency.

---

## F7 — `studio_compare`'s three-image payload repeats on every iteration of the required fix loop, with no way to shrink it

**Severity: MINOR**

**Evidence:**

`server/ai/mcp/tools/studio/compare.ts:238-242`
```
const images: AiToolImage[] = [
  { mimeType: 'image/png', data: capturedImage.data },
  { mimeType: reference.mimeType, data: Buffer.from(referenceBytes).toString('base64') },
  { mimeType: 'image/png', data: diff.diffPngBuffer.toString('base64') },
]
```

`server/ai/tools/studio/systemPrompt.ts:135` — step 5 of the required workflow: "VERIFY. studio_compare after every pass ... A failing result is a work list: fix the largest region first, measure again, repeat."

**Root cause:** The prescribed loop calls for `studio_compare` after every fix pass, and every call unconditionally returns three full images (the capture, the reference, and the diff visualization), each up to the 1568px vision-safe edge. There is no flag to suppress the images once the agent already trusts the numeric verdict (`similarityScore`, `regions[]`), and no iteration cap/early-exit heuristic — a stuck agent making many passes on a stubborn region pays the full three-image cost every single time.

**Proposed fix:** Add an optional `includeImages` boolean (default `true`) to `studio_compare`'s input schema in `server/ai/mcp/tools/studio/compare.ts`, so a later-loop call can request the numeric verdict + regions only.

**Effort:** S — self-contained in `compare.ts` + its TypeBox schema. No cross-area dependency.

---

## F8 — Reparent/duplicate/wrap still refuse for an already-imported screen (documented, structural, not fixed by native file authoring)

**Severity: BLOCKER (pre-existing, architectural — not new, but a real cap on what the flagship loop can express)**

**Evidence:**

`PROJECT-BRIEF.md` §"What does NOT work today" — "**reparent / duplicate / wrap** (all still refuse)"

`src/core/page-tree/sourceStructure.ts` — `refuseStructuralEdit`, the structural gate every canvas-driven tree mutation goes through (per `docs/agent-refs/path-index.md`: "Can this node's PLACE be written back?").

**Root cause:** The classic AST-writeback limitation — composing an existing node tree into a new arrangement, or structurally duplicating a pattern via canvas operations — still refuses out loud rather than silently corrupting the source. This is now largely bypassed for BRAND NEW screens, since the agent authors those with native `Write`/`Edit` on the whole file (`claudeCliToolSurface.ts`) rather than through the AST edit engine. It remains a hard, real blocker whenever the task is "restructure what's already there" on an imported/existing screen — e.g. wrapping an existing node in a new container, or structurally duplicating a list-item pattern via canvas gesture rather than rewriting the file by hand.

**Proposed fix:** No quick fix; tracked on the parser/store roadmap (the WS-9 family in `STUDIO-IMPORT-V2-PLAN.md`). Out of `mcp-tooling`'s scope — depends on `parser-surgeon` (AST codemod support for reparent/wrap) and `store-engineer` (tree-mutation API surface).

**Effort:** L — cross-cutting, depends on `parser-surgeon` + `store-engineer`, not addressable from the MCP tool layer alone.

---

## TOP 5 THINGS THAT MOST HURT 1:1 FIDELITY

1. **F3 — Unscoped chat-pasted design references drift to the wrong screen.** This is the single most damaging bug for the literal flagship workflow (paste several Figma frames across one conversation, build several screens): from the second pasted design onward, earlier screens silently measure against the wrong reference and nothing tells the agent or the user.
2. **F1 — `studio_render_reference` is promised but absent for the normal role.** The only tool that validates against the real, executing app (as opposed to the static parse) is invisible to essentially every real Studio user, so "done" is only ever proven against Studio's own render, never against ground truth.
3. **F4 — The high-fidelity Figma path is invisible by default.** Exact token values and real vector/image assets require three non-default setup steps a typical user will never discover; most sessions silently run on the lower-accuracy raster-measurement fallback without ever being told so.
4. **F5 — The parser-level diagnostic tool is withheld from the agent.** Without `studio_fidelity_report`, every pixel discrepancy must be debugged by eye/guess even when a structural, actionable cause (unresolved dynamic content, spread props, auto-selected branch) is one call away.
5. **F2 — The vision-safe image cap silently degrades exactness on tall screens.** Most real mobile screens are taller than the effective threshold, so the "exact-pixel" comparison the whole measurement pipeline is built around quietly becomes a resampled, noisier one for the majority of realistic content.

