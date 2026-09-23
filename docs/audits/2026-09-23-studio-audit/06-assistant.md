# Audit 06: the in-editor AI assistant (creative, tool-packed, reliable)

Auditor: mcp-tooling (read-only). Date: 2026-09-23. Repo: `C:\Users\Admin\Documents\GitHub\Figma Killer 2`, branch `fix/studio-load-memo-cold-on-every-load`.
Nothing in the repo was modified. The only thing executed was two read-only `bun -e` scripts that imported the tool registry to dump metadata.

---

## 0. The headline: the agent's best guidance does not reach the agent

A Studio turn runs down one of two paths. What each path actually receives is very different, and neither receives what the plans say it does.

| | **claudeCli path** (default; subscription) | **HTTP path** (Anthropic API key, OpenAI, OpenRouter, Ollama, Custom) |
|---|---|---|
| Loop owner | the `claude` subprocess (`claudeCli.ts`, warm pool) | `runToolLoop` (`server/ai/drivers/http/toolLoop.ts`) |
| File authoring | native `Read/Write/Edit/Glob/Grep/Task` (`claudeCliToolSurface.ts:106`) | **none**: `studioAgentTools` deliberately excludes every write/read-file tool (`agentToolNames.ts:17-24`), and HTTP drivers get no native tools |
| System prompt | Claude Code's own prompt, the generated `CLAUDE.md`, and **only the dynamic suffix** of Studio's prompt (`claudeCli.ts:86-118`, `:462`; `claudeCliArgv.ts:164-169`) | the full static prefix, the mode block, the policy block, and the suffix (`chat.ts:394-396`) |
| Receives `MODE_BLOCK` (creative/balanced/strict) and `DESIGN_POLICY_BLOCK` (follow/balanced/free) | **No** | Yes |
| Receives "Parallel work" (the `subagent_type: 'general-purpose'` safety contract) | **No**, even though this is the only path with `Task` | Yes, but it has no `Task` tool |
| Receives the step budget, the WRONG/RIGHT failure list, and the asset ladder | **No** (the generated `CLAUDE.md` carries a shorter subset) | Yes |

What this adds up to:

1. **A12 (follow/free design policy) and A13 (composition archetypes, creative) do almost nothing on the default path.** The only parts that reach the CLI agent are the server-side graders (`studio_quality_check` severities and the Stop gate). Worse, the generated `CLAUDE.md` tells the agent "Use `<ds>` — **always**" and "There is no third option" (`projectGuide.ts:174-182`), and "Never hardcode a colour…" (`:160`). Those lines contradict `free` outright.
2. **The HTTP path cannot edit a Studio project at all.** Its prompt says "You edit the repo with ordinary file tools. Read, Write, Edit, Glob and Grep…" (`systemPrompt.ts:124`), but none of those tools exist for it. Anyone using an Anthropic/OpenAI/OpenRouter API key has an assistant that can look, measure and resize frames, and cannot write a single line.
3. **The delegation safety contract** that `studio-agent-subagent-contract.test.ts` gates is only proven to be in a string that the `Task`-holding path never receives. The fabrication failure it exists to prevent (invented `subagent_type`, ten files reported, none written) is live again.

Everything below matters less than fixing these three (AI-1, AI-2, AI-3).

---

## 1. Tool inventory

Source: a live dump of `studioMcpTools` (55 tools) and `studioAgentTools` (35 offered to the in-canvas agent; `docs/features/agent.md` says 31, which is stale), plus `siteTools` (CMS, 35).
Key: **R/W** = `mutates`. **Agent** = offered to the in-canvas agent. **Exec**: `S` = server, `S/B` = server-with-bridge-fallback, `B` = bridge (needs an open tab). "Desc" is the description length in characters.

### 1a. Offered to the in-canvas agent (35)

| Tool | R/W | Caps | Exec | Desc | Notes / gaps |
|---|---|---|---|---|---|
| studio_screenshot | **W** | studio.write | S/B | 1612 | **Marked `mutates` although it only observes** (`screenshot.ts:105`). As a result the HTTP loop runs screenshots serially and **dedupes a repeat identical call inside a turn**, so "write → screenshot → fix → screenshot" returns `duplicate-call` with the stale first result (AI-5). No `widths[]`/viewport override, so a responsive check is impossible without mutating the board (AI-16). The description cites `studio_diff_frames` and `studio_read_file`, which are not offered. |
| studio_compare | **W** | studio.write | S/B | 3282 | Same `mutates` problem (`compare.ts:262`); it has `forceRecapture` but the loop dedupe fires first. The description is excellent but 3.3 KB. Cites `studio_diff_frames`. |
| studio_measure_reference | R | — | S | 2170 | Good. |
| studio_computed_styles | R | — | S/B | 1323 | Cites `studio_find_nodes` (not offered). |
| studio_measure_element | **W** | studio.write | S | 1004 | Observer marked mutating (`measureElement.ts:45`). |
| studio_page_diagnostics | R | — | **B** | 829 | Needs an open tab. Fine in-canvas. |
| studio_render_reference | W | studio.run.project | S | 1191 | Tier-2 gate (A10). Cites `studio_export_frames`. |
| studio_quality_check | R | — | S | 3779 | This is the creative grader, and it is good. Missing: layout-craft findings (alignment edges, touch targets, line length, orphan headings). See AI-19. |
| studio_plan_variants | W | studio.write | S | 1482 | Strong idea. The archetype pool covers marketing sites only (hero/pricing/footer), while real Studio projects are **mobile app screens** (AI-12). The directive assumes a Task fan-out that the HTTP path cannot do. |
| studio_list_variant_sets | R | — | S | 530 | OK. |
| studio_typecheck | **W** | studio.write | S | 1265 | Observer marked mutating (`typecheck.ts:132`), so a re-check with the same `paths` after a fix is deduped on HTTP. Refuses at Tier 0. |
| studio_fidelity_report | R | — | S | 840 | OK. |
| studio_import_figma_frame | W | studio.write | S | 1645 | Good "one call" design. |
| studio_register/list/read_design_reference | W/R/R | | S | 1860/690/568 | Register/read cite `studio_recommend_export_dpr` and `studio_diff_frames` (not offered). |
| studio_ingest/list/read_design_variable(s/_set) | W/R/R | | S | | Ingest cites `studio_delete_design_variable_set` (not offered). |
| studio_set_frames | W | studio.write | S | 529 | **Sets width/height only, no x/y**. The creative block says "place them side by side on the board", but nothing can position a frame (AI-17). |
| studio_set_frame_axes / studio_duplicate_frame_as_variant | W | | S | | OK. |
| studio_list_comments / reply / resolve | R/W/W | | S | | Good. The anchor-drift refusal is the right shape. |
| studio_project_profile / studio_list_pages | R | | S | | `list_pages` cites `studio_find_nodes`. |
| **studio_list_tokens** | R | — | S | 384 | **Broken for every real project.** It reads `.studio/framework.json` (`frameworkTokenTools.ts:86-87`), which is Studio's *own* framework scale and explicitly *not* the project's design system (`projectTokenIndex.ts:32-35`). Every `framework.json` on this machine is `{"colors":{"tokens":[]}}`. The prompt nevertheless names it as the source of "every --type-* value" (`systemPrompt.ts:257`, `:313`) (AI-4). |
| studio_list_components / studio_find_component | R | | S | 3357/1257 | Good. Missing: a ready-to-paste usage snippet with the import path relative to the target file (AI-14). `list_components` cites `studio_apply_edits`. |
| studio_upload_asset | W | studio.write | **B** | 838 | Base64 bytes are awkward for any model. Cites `studio_apply_edits`. |
| studio_fetch_remote_asset | W | studio.write | S | 1075 | Good, and safe. |
| studio_extract_reference_asset | W | studio.write | S | 1080 | Good. |
| studio_install_deps / studio_install_status | W/R | | S | 549/96 | `install_status` has a 96-character description, too thin for a weak model. |

**Tool-definition weight:** 35 tools, **~81 K characters of description plus schema (about 20 K tokens)**, re-sent every round. It is cached on Anthropic, but a smaller model still has to reason over it. **Eight tools' descriptions name tools the agent is not offered.** This is the A11 failure class in descriptions rather than in the prompt, and `prompt-claims-match-tool-metadata.test.ts` does not scan descriptions.

### 1b. In the MCP registry but withheld from the in-canvas agent (20)

`studio_list_projects`, `studio_get_node_source`, `studio_find_nodes`, `studio_create_page`, `studio_read_file`, `studio_list_files`, `studio_apply_edits` (5.4 KB description), `studio_codemod`, `studio_export_frames`, `studio_diff_frames`, `studio_recommend_export_dpr`, `studio_delete_design_reference`, `studio_delete_design_variable_set`, `studio_list_component_bindings`, `studio_read_package_doc`, `studio_git_status/branch/commit/push/open_pr`.
The withholding is justified for the CLI path, where native tools replace them. **It is wrong for the HTTP path**, which gets nothing in their place (AI-2). `studio_get_node_source` is also what turns a selected node id into `file:line`, and no path offers it (AI-9).

### 1c. CMS `site_*` (35)

These are used only when no Studio project is open (the dormant CMS half). They are withheld from connectors bound to a Studio project (`mcp-25`). No action is needed beyond keeping them out of Studio turns. The empty-state hint in the panel ("Add a hero section with a heading and button", `AgentPanel.tsx:386`) is CMS vocabulary.

### 1d. Phantom tools named to the model

- `studio_design_system_guide` appears in the FOLLOW policy block (`promptSessionBlocks.ts:140`) and in a quality finding's fix text (`qualityAudit.ts:477`). **It does not exist.** (AI-6)
- `parityMatrix.ts:170-172` says "Task is not granted", but `claudeCliToolSurface.ts:106` grants it. This row is rendered into `agent.md`'s headless-only table, so the docs contradict the code. (AI-24)

---

## 2. System prompts

### 2a. What is wrong, quoted

**(i) The top rule assumes reproduction, even when the user asked for creation.** `systemPrompt.ts:130-132`:
> "NEVER CLAIM A MATCH YOU DID NOT MEASURE. Every other rule here is advice; this one is the job… A screen is DONE when studio_compare returns pass:true."

In creative mode with no reference, this is the first thing the model reads. The creative block that redefines DONE arrives about 9 KB later. The prompt states two different definitions of done and marks the wrong one as non-negotiable.

**(ii) It suppresses creativity in every mode.** `:207`:
> "Read the design as a specification, not an inspiration… That is never license to improvise something else entirely."

This is right for balanced and strict. It sits in the invariant prefix, so it also contradicts `MODE_BLOCK.creative`'s "Improving on it is the point".

**(iii) Every workflow step points at matching.** Steps 2 and 5 (`:142-154`) are about getting the design's values and comparing. There is no step for "decide the concept", "choose the type scale, palette and density", or "write real content". A from-scratch brief gets a workflow built for a job it was not given.

**(iv) Imagery is a dead end.** `:227-236` ends at "a plain neutral placeholder box, and SAY SO". That is correct as an anti-fabrication rule. But for a creative brief with no Figma, the only way out is a grey box, and every creative screen ships with holes. Nothing offers a legitimate path: a licensed stock search, an illustration set, generated imagery, or a gradient/pattern treatment explicitly allowed as *decoration* (not as a fake logo).

**(v) One project's facts are baked into every project's prompt.** `:257`: "in this project Button's size="default" resolves to --type-subtitle-size (16px)…". `:279`: "the primary call-to-action measures #ef4550 (coral)…". These are facts about one eSIM/ALM project. On any other project they are false. They bias the model and waste cached tokens.

**(vi) A wrong tool claim.** `:313`: "studio_list_tokens gives colours, type and spacing scales". It returns empty (see 1a).

**(vii) There is no craft vocabulary.** Nothing covers type craft (line length, leading, tracking on display and caps, weight contrast, tabular numerals), colour craft (surface tonal steps, one accent, state colours, dark-mode elevation), layout craft (edge alignment, grid, optical centring, 44 px touch targets, safe areas, thumb zone on mobile), content (realistic domain copy, no lorem, real numbers and names), or states (empty/loading/error). The creative block has five composition rules (`compositionAudit.ts:173-179`), and that is all.

**(viii) No self-critique step.** "LOOK… is the spacing right, is the hierarchy right" (`:150`) is one sentence. There is no rubric and no "one improvement pass before reporting".

**(ix) The reply format is too tight for creative work.** "Reply in 1-2 sentences" (`:317`) conflicts with "say in one line what each [variant] is for".

**(x) Path-blind vocabulary.** `:124` and `:311` ("You DO have Task") are true only on the CLI path, while the text itself reaches only the HTTP path.

### 2b. Proposed rewrite (one source, both paths)

**Structural fix (AI-1).** Make `buildStaticPromptPrefix` path-aware: `toolSurface: 'native-fs' | 'studio-fs'`, generated from tool metadata rather than prose. **Deliver it to the CLI** through `--append-system-prompt` (static prefix, mode block, policy block, then the dynamic suffix). Add `(fidelityMode, designPolicy, promptVersion)` to the warm-session reuse fingerprint (`claudeCliSessionPool.ts`), so a mode change respawns rather than running on stale guidance. The prefix is stable per (mode, policy), so the CLI's own prompt cache still holds.
**Shrink the generated `CLAUDE.md`** to project *facts* only (pages dir, styling, design-system import contract, decision map, icon import). Delete its policy statements ("always", "no third option", "never hardcode"), because policy belongs to the per-turn block.

**Proposed prefix skeleton** (replaces `# Role` through `# Required workflow`; the verified failure list is kept but generalized):

```
# Role
You are a senior product designer who ships in code. You work inside Studio: the
user's REAL React repo, shown as live frames on an infinite canvas. You change the
design by changing files; the frame re-renders instantly. The user judges a
picture, not your code.

# What "done" means depends on the brief. Read the mode block below FIRST.
- Matching a design (balanced/strict): never claim a match you did not measure.
- Creating (creative): never claim quality you did not check. Done = it typechecks,
  studio_quality_check is clean, and you did one critique pass on the screenshot.
In every mode: an unverified screen is reported as UNVERIFIED, with what you could
not check.

# Workflow
1. Orient from what you already have (CLAUDE.md, live digest, selection, refs).
2. Decide before you draw. One line each: the screen's job, the primary action,
   the band sequence, the type scale (3+ steps), the accent (one), the density,
   the radius family. With a reference, these come FROM the reference; without
   one, they are YOUR decisions, and they are the design.
3. Write real content: domain-true copy, plausible names/prices/dates, no lorem.
4. Build the whole screen in one write per file.
5. Look (studio_screenshot), then critique against the rubric below. Fix the worst
   two issues. Look again.
6. Verify per the mode block (compare / quality_check / typecheck).
7. Report: what you made, the decisions, anything you could not verify.

# Craft rubric (use it when you critique your own screenshot)
Hierarchy: one clear entry point; the top two type sizes differ by >= 1.2x.
Rhythm: gaps inside a group < gaps between groups; every value on the spacing scale.
Alignment: every element sits on a shared edge; nothing is "almost" aligned.
Type: body line length 45-75ch; leading 1.4-1.6 for body, tighter for display;
  tracking reduced on large display, added on small caps/labels; numbers tabular.
Colour: surfaces step tonally; one accent spent on the primary action; AA contrast;
  dark mode is tonal elevation, not inverted colours.
Touch/mobile: targets >= 44px, primary action in thumb reach, safe-area insets.
States: think about empty, loading, error, and long-string cases even if not drawn.
Imagery: real assets first; decoration (gradients, patterns, shapes) is allowed as
  DECORATION only, never as a fake logo, icon, or photo.
```

**Proposed creative block additions** (on top of the existing `MODE_BLOCK.creative`):

```
Take initiative. The brief is a floor, not a ceiling: add the one thing a senior
designer would add (a meaningful empty state, a stronger hero, a real data
visualisation) and say so in one line.
Vary on purpose. Across variants, change STRUCTURE (band sequence, layout
archetype, density), TYPE PERSONALITY (pairing, weight contrast), and COLOUR
STRATEGY (tonal vs. high-contrast vs. accent-led), not only the accent.
Imagery: use studio_find_image (licensed stock) or studio_find_icon before you
fall back to a placeholder. A placeholder in creative mode is a named gap, and
the reply says what should go there.
Reply: one line per variant (its idea and who it is for), then what was verified.
```

**Mobile-app archetypes for `LAYOUT_ARCHETYPES` (AI-12):** app header + content; list/detail row; settings/grouped list; form step/onboarding; card stack/feed; dashboard stats + chart; checkout/summary; empty state; bottom sheet; tab bar. Tag each archetype `web | app | both`, and let seeds pick from the pool that matches the project's frame widths.

---

## 3. Missing tools a top-tier design agent needs

(Each has an AI-n row in section 6.)

| Need | Today | Proposal |
|---|---|---|
| Author files on the HTTP path | nothing | `studio_write_file`, `studio_edit_file` (unique `old_string` replacement, like `Edit`), plus the existing `studio_read_file`/`studio_list_files` and a `studio_grep`. Containment through `appRoot`; the same `agentWriteScope` deny for `.studio/.claude/.git`; an `expectedHash` stale-source guard; every write recorded in `turnWriteLog` and captured as a pre-image checkpoint; live-reload push. (AI-2) |
| Batch/atomic multi-edit | `studio_apply_edits` (AST, MCP-only) | `studio_edit_files({ edits:[{path, old, new}], atomic:true })`: all-or-nothing, one live-reload, one checkpoint. (AI-2) |
| Undo the agent's own turn | withheld (`parityMatrix.ts:151-153`) | Turn checkpoints: a PreToolUse hook (CLI) or the write tool (HTTP) snapshots each file's pre-image to `.studio/agent-checkpoints/<turnId>/`. The **user** reverts from the panel; per file, the revert is refused if the file changed after the agent's write (honest target). An agent-side `studio_revert_turn_file` may only touch files this turn wrote, and only while their hash is still the agent's. (AI-7) |
| Responsive check | none | `studio_screenshot({ widths:[375,768,1280] })`, rendered headless at each width without touching `boards.json`. (AI-16) |
| Arrange the board | `set_frames` = size only | `studio_arrange_frames({ pageIds, layout:'row'|'grid', gap, origin })` plus x/y. Label/section frames with variant rationale (sticky-note parity). (AI-17) |
| Design tokens: read | broken (`list_tokens`) | Back `studio_list_tokens` with `projectTokenIndex` (the CSS the canvas loads): name, value, dark value, family (colour/type/space/radius/shadow), source file:line. (AI-4) |
| Design tokens: write | none (native Edit only) | `studio_set_tokens({ set:[{name,value,scheme?}] })`: a postcss CST codemod on the file that declares the token (one honest target); refused when a token is declared in two places. (AI-15) |
| Insert a design-system component | `find_component` (props only) | `studio_component_snippet({ name, props?, forFile })` returns the exact import (relative or package, via `buildImportContract`) and a JSX usage with valid enum values. (AI-14) |
| Icons | DS `?raw` catalogs via the `.claude/` file | `studio_find_icon({ query, limit })`: fuzzy search across the DS icon catalogs; returns import and usage. When the DS has none, it says so and suggests a trust-gated package install. (AI-13) |
| Images | fetch URL, upload bytes, extract from reference | `studio_find_image({ query, orientation })` against a licensed source (Openverse/Unsplash with attribution) landing through `assetLanding.ts`. Optional `studio_generate_image` behind a new `ai.images.generate` capability and a configured provider credential; never on by default. (AI-13) |
| Explain / anchor the selection | digest has `nodeId`, tag, writable props | Add `file:line`, a 3-line source excerpt, and the computed box to the `Selected:` digest line. Support multi-select (`selectedNodeIds`). Offer `studio_get_node_source` to the HTTP path. (AI-9) |
| Fonts/assets inventory | `font-not-available` finding only | `studio_list_fonts` (loaded `@font-face`, DS fonts, what is actually downloadable); `studio_list_assets` for the HTTP path. (AI-20) |
| Lint | none | `studio_lint`: Tier-2 gated, project's own ESLint, bounded like `typecheck`. P2. (AI-21) |
| Plan then execute | CLI `plan` permission mode | Surface the plan as a card with Approve/Edit and execute the approved plan. On HTTP, a `studio_propose_plan` tool that ends the round awaiting approval. (AI-22) |
| Parallel screens on HTTP | none | A server-side `studio_delegate` that runs a bounded child `runToolLoop` per page with the same ownership rule. L effort. (AI-23) |

---

## 4. Loop quality

| Area | Finding | Evidence |
|---|---|---|
| Turn limit | HTTP: 40 rounds, then a terminal `error` event, "stopped" (`toolLoop.ts:221-228`). No wind-down warning, no final summary round. CLI: a 20-minute wall cap (`claudeCliSpawn.ts:162`), no round cap. | AI-10 |
| Transient provider errors | **No retry at all.** 429/500/503/529 and mid-stream `overloaded_error` end the turn with a red banner (`toolLoop.ts:253-268`, `errors.ts:54-71`, `anthropic.ts:560-568`). | AI-8 |
| Dedupe | Fingerprints every `mutates:true` call per turn. Observers marked `mutates` get stale results (AI-5). The fingerprint ignores intervening writes. | `toolLoop.ts:474-486` |
| Parallel calls | Reads run concurrently. Screenshot, compare, measure and typecheck are serialized because of the `mutates` flag. | `toolLoop.ts:434-454` |
| Output budget | `max_tokens: 8192` (`anthropic.ts:59`). A `max_tokens` stop reads as a normal stop (`anthropic.ts:591`), so a truncated tool call is **silently dropped**. Once AI-2 lands, a whole-screen `Write` will exceed 8 K. | AI-11 |
| Reasoning | `req.effort` is ignored by every HTTP driver: no Anthropic extended thinking, no OpenAI `reasoning.effort`. Thinking blocks would also need a persisted `thinking` content kind (with signature) in `AiContentBlock` to survive history replay. | AI-11 |
| Effort routing | `build` and `smallEdit` both route to `medium` (`turnRouting.ts:154-162`). Explicitly never routes up "without a measurement". The A9 `agent-turns.jsonl` telemetry now exists to supply one. | AI-25 |
| Context management | HTTP replays the full history every turn. The only overflow remedy is one retry that elides historical user images, then "start a new conversation". No compaction or summarization. Heavy-evidence elision keys on tool **name**, so a screenshot of page A is elided by a later screenshot of page B. | AI-18 |
| Streaming | Text deltas stream. Tool-argument deltas are not surfaced, so a long `Write` (CLI) or future `studio_write_file` shows nothing for tens of seconds. CLI streams partials (`--include-partial-messages`). | AI-26 |
| Caching | Anthropic: four breakpoints used well (system prefix, tools, two rolling anchors). OpenAI family: `prompt_cache_key`. CLI: the static prefix is not sent at all (AI-1). When fixed, it must stay stable per (mode, policy). | good |
| Error recovery | Tool refusals are structured (`[code=… retryable=…]`), and bridge death terminates the turn cleanly. Schema-validation failures return the raw TypeBox message (`execTool.ts` `parseValue` catch) with no expected-shape hint. | AI-27 |
| Cancellation | Good: immediate lock release (`chat.ts:647-677`), a queued message, Stop. | — |
| Model defaults | Anthropic API: auto-default = newest Opus (`credentials.ts:163-200`), which today resolves to `claude-opus-5-5`, good for quality. CLI: static aliases, no auto-default. Recommended: `claude-opus-5-5` for the orchestrator/build turn; `claude-sonnet-5` for fan-out subagents and quick edits (once model routing records "defaulted vs chosen", which is `turnRouting.ts`'s stated blocker); `claude-haiku-4-5-20251001` for utility calls (conversation titles, turn classification, compaction summaries, commit messages). `claude-fable-5-1` has not been evaluated here; include it in the A9 bench before assigning it a role. | AI-25 |

---

## 5. Assistant panel UX

| Gap | Where | Proposal |
|---|---|---|
| 320×480 floating box | `AgentPanel.tsx:49-50` | Default to docked, full height; the floating mode stays available. |
| Empty state is CMS copy with no suggestions | `AgentPanel.tsx:381-387` | Context-aware suggestion chips: "Make 3 directions for {activePage}", "Tighten spacing on selection", "Check dark mode + RTL", "Address {n} open comments", "Match the attached design". Built from the live digest. |
| Selection is invisible | the snapshot sends `selectedNodeId` silently | A context chip above the composer ("Button · Checkout.tsx:42", removable), multi-select aware, and `@page` / `@node` mentions. |
| No per-turn changes list, diff, or revert | n/a | Under each assistant turn: "Changed 3 files" → per-file diff (CodeMirror merge view), "Revert turn", and per-file revert (AI-7). |
| Failed-but-recovered tools render red | `ToolCallRow.tsx:54` | Owner bar is "no visible errors". A refusal the agent recovered from renders muted ("adjusted"). Red only if the turn ended with the failure unresolved. Round-cap and transient errors become a quiet "Continue" affordance, not an alert. |
| Variant results are just text | n/a | A variants card: thumbnails from `studio_screenshot`, "Keep A / Tighten B / Discard C" actions feeding `studio_list_variant_sets`. |
| Screenshot attach | image attach exists; the design reference is separate | Add "Attach current frame/selection" (captures via the same headless path; no second capture mechanism). |
| Plan mode | exists as a permission mode | Render the plan as an approvable checklist (AI-22). |

---

## 6. Findings

Priority: P0 = the assistant is broken or lying today. P1 = large quality or creativity gain. P2 = polish.
Effort: S ≤ 1 day, M ≤ 1 week, L > 1 week.
Plan coverage refers to `STUDIO-FIGMA-FEEL-PLAN.md` (FF) Track A.

| ID | Pri | File:line | Proposal | Effort | Owner | Plan coverage |
|---|---|---|---|---|---|---|
| AI-1 | **P0** | `server/ai/drivers/claudeCli.ts:86-118,462`; `claudeCliArgv.ts:164-169`; `projectGuide.ts:112-356` | Deliver the static prefix, `MODE_BLOCK` and `DESIGN_POLICY_BLOCK` to the CLI via `--append-system-prompt`. Add mode/policy/prompt version to the warm-session fingerprint. Strip policy statements from the generated `CLAUDE.md` (keep facts). Add a gate: `cli-receives-mode-and-policy.test.ts` asserts that `buildClaudeCliArgv` output contains the policy heading for each policy. | M | mcp-tooling + server-engineer | **Not covered.** A12/A13 were declared done (`mcp-22`) but never reach this path. |
| AI-2 | **P0** | `server/ai/tools/index.ts:60`; `chat.ts:257`; `agentToolNames.ts:17-24`; `systemPrompt.ts:124` | Give the HTTP path file authoring: `studio_write_file` / `studio_edit_file` / `studio_edit_files` (atomic) plus the existing read/list, a grep, and `get_node_source`, selected when `driver !== claudeCli`. Same containment, the `agentWriteScope` deny, stale-hash guard, `turnWriteLog`, checkpoint and live-reload. Generate the prompt's tool vocabulary from the surface. Needs a security-guard review. | M | mcp-tooling + security-guard | Not covered |
| AI-3 | **P0** | `systemPrompt.ts:166-183`; `studio-agent-subagent-contract.test.ts` | Falls out of AI-1. Move the gate so it asserts the text the **CLI argv** carries, not a string only the HTTP path sees. | S | test-engineer | Not covered |
| AI-4 | **P0** | `frameworkTokenTools.ts:77-128`; `systemPrompt.ts:257,313` | Back `studio_list_tokens` with `projectTokenIndex` (the CSS the canvas loads), grouped by family, with source file:line. Retire the `framework.json` read. | S | mcp-tooling | Not covered |
| AI-5 | **P0** | `screenshot.ts:105`, `compare.ts:262`, `measureElement.ts:45`, `typecheck.ts:132`, `exportFrames`; `toolLoop.ts:434-486` | Split `mutates` into `requiresWrite` (the capability gate) and `sideEffects: 'none'|'cache'|'write'` (loop grouping and dedupe). Observers run concurrently and are never deduped. Include a per-turn "write epoch" in the dedupe fingerprint so a repeated write after an intervening write executes. | S-M | mcp-tooling | Not covered (Z3 introduced the dedupe) |
| AI-6 | **P0** | `promptSessionBlocks.ts:140`; `qualityAudit.ts:477` | Remove the phantom `studio_design_system_guide` (point to CLAUDE.md, `studio_list_components`, and `studio_find_icon` once AI-13 lands). Extend the A11 gate to scan mode/policy blocks **and every tool description and finding fix text** for `studio_*` names not in the offered set. That catches the 8 description cross-references in 1a. | S | test-engineer + mcp-tooling | A11 partially (prefix only) |
| AI-7 | P1 | new: `server/handlers/studio/agentCheckpoints.ts`; hook in `projectGuide.ts:391-409` | Per-turn pre-image checkpoints, "Revert turn" and per-file revert in the panel (honest-target refusal if the file was edited since). Changed-files list and diff per turn. | M | server-engineer + panel-designer | Not covered |
| AI-8 | P1 | `toolLoop.ts:253-268`; `errors.ts:54-71`; `anthropic.ts:560-568` | Bounded retry (3×, exponential, honours `retry-after`) for 408/429/500/502/503/504/529 and a mid-stream `overloaded_error` before any output. Show a quiet "retrying" status, not an error. | S | server-engineer | Not covered |
| AI-9 | P1 | `studioAgentSnapshot.ts:37-44`; `liveDigest.ts:53,414-425` | Add the selection's `file:line`, a source excerpt and the computed box to the digest. `selectedNodeIds[]` for multi-select. Composer context chip. | S-M | mcp-tooling + panel-designer | Not covered |
| AI-10 | P1 | `toolLoop.ts:212-228`; `toolLoopBounds.ts:241-247` | At N−3 rounds, inject a system note ("3 rounds left: finish, verify, report"). At the cap, run one tools-disabled round for a summary instead of an error event. | S | mcp-tooling | A9 (budget visible, but hard stop) |
| AI-11 | P1 | `anthropic.ts:59,245-257,591` | `max_tokens` per model (≥32 K for current Claude). Treat `stop_reason:'max_tokens'` with an open `tool_use` as a continuation, never a silent stop. Map `effort` to extended thinking / OpenAI `reasoning.effort`. Persist thinking blocks (new `AiContentBlock` kind) for multi-round interleaving. | M | server-engineer | Not covered |
| AI-12 | P1 | `compositionAudit.ts:131-179`; `variantSeeds.ts` | App-screen archetypes (list, form step, dashboard, checkout, empty state, bottom sheet, tab bar), tagged web/app and chosen by frame width. Seeds add type personality and colour strategy axes. | M | mcp-tooling | A13 (web-only) |
| AI-13 | P1 | new tools | `studio_find_icon` (DS catalogs, fuzzy). `studio_find_image` (licensed stock through `assetLanding.ts`, attribution recorded). Optional `studio_generate_image` behind a new capability and credential. Update the asset ladder in the prompt. | M | mcp-tooling + security-guard | Not covered |
| AI-14 | P1 | `componentCatalogTools.ts` | `studio_component_snippet`: import relative to the target file, JSX with valid enum values. | S | mcp-tooling | Not covered |
| AI-15 | P1 | new (`@core/css-codemods`) | `studio_set_tokens`: CST edit at the declaring file, refused on an ambiguous declaration. | M | parser-surgeon + mcp-tooling | Not covered |
| AI-16 | P1 | `screenshot.ts` (schema) | `widths[]` headless override (no board mutation), reusing the existing capture path. | S-M | mcp-tooling + canvas-engineer | Not covered |
| AI-17 | P1 | `editTools.ts:124-200` | `studio_arrange_frames` (x/y, row/grid layout), plus frame labels/notes for variant rationale. | S | mcp-tooling | Not covered (the creative block assumes it) |
| AI-18 | P1 | `toolLoop.ts:189,525-583`; `history.ts` | HTTP compaction: summarize turns older than K with `claude-haiku-4-5-20251001` into a pinned summary once over ~60% of the window. Elide heavy results per (tool, page), not per tool. | M | server-engineer | Not covered |
| AI-19 | P1 | `systemPrompt.ts:118-317`; `promptSessionBlocks.ts:57-76` | Rewrite per section 2b: mode-first definition of done, decide-before-draw, craft rubric, critique pass, realistic content, initiative. Remove project-specific facts (`:257`, `:279`) into that project's guide. Add `quality_check` findings for edge misalignment, touch targets < 44 px, and line length. | M | mcp-tooling | A13 partially |
| AI-20 | P2 | new | `studio_list_fonts`, `studio_list_assets`. | S | mcp-tooling | Not covered |
| AI-21 | P2 | new | `studio_lint` (Tier-2, project ESLint, bounded). | S | mcp-tooling + security-guard | Not covered |
| AI-22 | P2 | `AgentSessionControls.tsx:78-82` | Plan mode as an approvable checklist card; HTTP `studio_propose_plan`. | M | panel-designer + mcp-tooling | Not covered |
| AI-23 | P2 | new | `studio_delegate`: a bounded child tool loop per page for HTTP drivers (ownership rule enforced by path). | L | mcp-tooling | Not covered |
| AI-24 | P2 | `parityMatrix.ts:170-172`; `docs/features/agent.md` ("31 tools") | Fix the stale Task row and the tool count. | S | studio-scribe | — |
| AI-25 | P2 | `turnRouting.ts:29-41,154-162` | Record "defaulted vs chosen" model (migration, additive). Route by measured `agent-turns.jsonl` data: Opus for builds and creative work, Sonnet for small edits and subagents, Haiku for utility calls. | M | server-engineer | A9 telemetry exists |
| AI-26 | P2 | `anthropic.ts:532-535`; `streamEvents.ts` | Surface tool-argument progress ("writing Checkout.tsx · 3.2 KB"). | S | panel-designer + server-engineer | A9 partially |
| AI-27 | P2 | `execTool.ts` (`parseValue` catch) | On schema failure, return the failing path, the expected type, and a minimal valid example. | S | mcp-tooling | A14 adjacent |
| AI-28 | P1 | `AgentPanel.tsx:49-50,381-387`; `ToolCallRow.tsx:54` | Docked full-height default, suggestion chips, recovered failures shown muted, variants card. | M | panel-designer | Not covered |
| AI-29 | P2 | tool descriptions (~81 K characters) | Trim descriptions to when-to-use / returns / failure codes (≤ 900 characters each); move the rationale to `agent.md`. Gate the description length. | M | mcp-tooling | Not covered |

---

## 7. Suggested order

1. **Wave 1 (P0, about a week):** AI-4, AI-6 and AI-5 (all small, and they unblock correct verification), then AI-1 + AI-3 together (the prompt finally reaches the default path), then AI-2 with a security review.
2. **Wave 2 (the creativity step):** AI-19 (prompt rewrite, landing *after* AI-1 so it reaches both paths), AI-12, AI-13, AI-14, AI-16, AI-17.
3. **Wave 3 (trust and UX):** AI-7 (checkpoints and revert), AI-28 (panel), AI-8, AI-10, AI-11, AI-9.
4. Measure with `bench:agent-turn` before AI-25 (model routing).

Repo rules respected throughout: TypeBox schemas only; no provider SDK (retries and thinking go in the hand-rolled drivers); every new tool declares `requiredCapabilities` and passes `toolAllowedForCapabilities`; no caller-supplied directory on clear/overwrite paths; any new HTTP route is declared in `routeCapabilities.ts`; checkpoints live on disk (`.studio/`), not in the DB.
