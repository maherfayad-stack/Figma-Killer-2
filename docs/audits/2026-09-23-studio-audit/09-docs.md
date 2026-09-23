# Audit 09: docs, plans, STATE.md

Auditor: studio-scribe (read-only). Worktree: `fix/studio-load-memo-cold-on-every-load` @ `560ddb0e`, 16 commits ahead of `origin/main` (`51b19940`, PR #191, the three Figma-feel waves).
Nothing in the repo was modified.

Supporting files in this folder:
- `planrefs.txt`: every reference to a root plan file, one per line (315 lines, not counting STATE.md or the state archive)
- `planrefs-compact.txt`: the same list grouped as file:line by plan
- `inspector-disclosure-refs.txt`: 52 references to a doc that no longer exists
- `state-ids.txt`: every STATE.md entry id with its line number, grouped by zone
- `links.ts`, `dangling.txt`: the markdown-link checker and what it found

---

## 0. Read this first: five facts that change the plan

1. **This worktree is not the newest doc state.** 17 open draft PRs exist, and several carry newer `STATE.md`, `CLAUDE.md` and `PROJECT-BRIEF.md` text:
   - `fix/live-dev-server-survives-api-restart` (#204) diffs 17 md files against HEAD. That includes STATE.md (+1360/-…), PROJECT-BRIEF.md (112 lines), CLAUDE.md, canvas-internals.md (+89) and capabilities.md. It also **deletes `docs/e2e/COLD-SUITE-TRIAGE.md`**.
   - `feat/trust-tier-default-run-project` sets `DEFAULT_TRUST_TIER = 'run-project'` (`server/handlers/studio/studioMeta.ts:76` on that branch; STATE entries `sec-19`, `sec-20`, `sec-21`). CLAUDE.md invariant 1 on HEAD still calls `static` "the never-auto-promoted default", and that branch rewrites it.
   - `docs/studio-speed-plan` (#205) adds an **11th root plan, `STUDIO-SPEED-PLAN.md`**.
   - Open PRs: #192, #195, #198–#210, plus #99 and #86 (both stale, from July/September).

   **Do the STATE.md restructure and the plan archive on the integration head, after those branches land or rebase.** Every in-flight branch prepends entries to the top of STATE.md. A restructure done on this worktree will conflict with all of them.
2. **Deleting the plans breaks about 250 citations in code, tests and agent files.** 315 references point at the ten plan files. 199 are in `src/`, `server/`, `tests/` and `scripts/`, and they cite plan sections as design rationale (for example "STUDIO-FIGMA-PARITY-PLAN.md 0.11" or "§E2.4"). **None of them are in shipped runtime strings.** I checked every non-comment hit: they are test `describe` names, 3 gate assertion messages (`single-drag-mechanism.test.ts:159,200`, `toast-dedupe-default.test.ts:89`) and 1 CSS comment.

   Recommendation: **ARCHIVE the code-cited plans with their filenames unchanged**, in `docs/archive/plans/`. A bare-filename citation then still resolves when an agent searches for the name. Only the path-sensitive markdown links (about 30), the 3 assertion messages and the routing references in agent and rule files need editing. DELETE only plans with zero code citations whose unique content has been harvested.
3. **A dangling doc path is cited 52 times.** `docs/features/inspector-disclosure.md` was renamed to `docs/features/inspector.md` in P6 (`5bfea473`). 52 references outside STATE still name the old path: 47 in `src/`, `tests/` and `docs/audits`, 4 in plans and 1 in json. The `§` numbering was kept deliberately (`inspector.md:10-16`), so each fix is a mechanical path swap. The list is in `inspector-disclosure-refs.txt`.
4. **STATE.md is 18,013 lines and 2.2 MB, and it no longer follows its own protocol.**
   - 15 entries sit above `## Now`, outside every section.
   - `## Now` holds 137 entries, almost all of them `done`.
   - `## Recently landed` holds 23 entries (the cap is about 10).
   - A stray `## e2e-1` section is appended after `## Archive`.
   - 3 of the 10 standing notes are stale.

   Details are in §2.
5. **Three architecture gates and one release script read doc paths.** Renaming or moving these fails `bun test`:
   - `css-token-vocabulary.test.ts:23-25` reads `docs/design.md`, `docs/reference/design-tokens.md` and `docs/reference/ui-primitives.md`.
   - `no-alm-npm-specifier.test.ts:88-95` scans `docs/agent-refs/`, `docs/features/`, `docs/reference/`, `PROJECT-BRIEF.md` and `CLAUDE.md`. Its doc comment (L49-52) says it excludes `STATE.md`, `docs/state-archive/`, `docs/audits/` and `STUDIO-*-PLAN.md` as written records. **Archived plans in `docs/archive/` are outside its scan targets, so that is fine as long as `docs/archive/` is never placed under `docs/features|reference|agent-refs`.** Update the comment to name `docs/archive/`.
   - `studio-tool-refusals-are-coded.test.ts:32` reads `docs/features/agent.md`, including its refusal-table markers. Do not split that table out.
   - `scripts/build-release-bundle.ts:23-29` ships `docs/deployment/*.md` by path.
   - `vendor/alm-design-system/{CLAUDE.md,design.md,README.md}` are **data**, parsed by `vendorDocs.ts` heading regexes into the design-system manifest. Never apply the header convention or any restyle to them.

---

## 1. Every doc: purpose, status, references, disposition

Status vocabulary: `current` · `partly-stale` · `stale` · `superseded` · `completed-plan` · `CMS-only` (accurate, but for the dormant half) · `historical` (dated record) · `data` (parsed by code).

### 1a. Repo root

| Path | Lines | Purpose | Status | Referenced by | Disposition | Reason |
|---|---|---|---|---|---|---|
| `AGENTS.md` | 3 | Pointer for non-Claude agents (Codex) → CLAUDE.md, BRIEF, STATE | current | none | **KEEP** | Retarget to the new reading order (§3). |
| `CLAUDE.md` | 403 | Rule book, auto-loaded into every session | partly-stale | everything | **REWRITE (trim)** | L12-L15 call IMPORT-V2 "the roadmap". L59-L121 duplicates the BRIEF's product narrative and architecture.md's stack and layout. The invariant-1 parenthetical (L66) is a 15-line feature description that the in-flight trust-default branch is rewriting again. Trim to rules with gates, and link everything else. |
| `PROJECT-BRIEF.md` | 699 | Orientation, what works and what doesn't, traps, routing | partly-stale; over the 600-line ceiling | CLAUDE, README, agents, 3 code comments, no-alm gate | **REWRITE §3-§4** | See contradictions C1-C6 (§3d). Replace the §3 plan table with one ROADMAP pointer. |
| `README.md` | 141 | Human product README + quick start | partly-stale | none | **KEEP (edit L114)** | L114 lists IMPORT-V2/PARITY as the roadmap. Point it at ROADMAP.md and docs/README.md. |
| `STATE.md` | 18,013 | Live coordination | broken structure | every agent file, protocol | **REWRITE** | §2. |
| `STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md` | 296 | DS-1…DS-9 | completed-plan (DS-4b open) | 0 code; BRIEF:131,208 · PARITY:87 · IMPORT-V2:347 · docs/README:208 | **DELETE** after harvest | §0's three owner decisions go to `docs/decisions.md`. DS-4b goes to ROADMAP. The shipped design goes to the new `docs/features/design-system.md`. |
| `STUDIO-CMS-REMOVAL-PLAN.md` | 201 | Dead vs load-bearing CMS residue, tiers 0-3 | partly-stale (L3 "Tier 0 in progress" as of 2026-09-01; unverified since) | 0 code; docs/README:8,209 · path-index:402 · plugin-system:3 · publisher:7 · site-import:7 · NEXT-WS:1777 | **MERGE-INTO** `docs/architecture.md` "The dormant CMS half" (its four traps, L37-81) + ROADMAP (tiers 1-3 + "the decision", L121-185), then **DELETE** | The traps are durable architecture facts, not plan content. No code cites the file. |
| `STUDIO-FIGMA-FEEL-PLAN.md` | 835 | Tracks Z/S/K/P/A/G/V, waves 1-3 | completed-plan. **Its L3 header "proposed, nothing started" is false**; L117 says "the owner called the plan closed". | 19 code (3 arch gates, 5 e2e specs) · CLAUDE:67 · BRIEF:105,129,183 · `.gitignore:147` · `.gitattributes:6` · 9 doc refs | **ARCHIVE** | §6 decisions (L648-684) go to `docs/decisions.md`. "What is still open after three waves" (L779-810) and the one unmet §8 DoD line (cold e2e) go to ROADMAP. |
| `STUDIO-FIGMA-PARITY-PLAN.md` | 1587 | Defect/parity analysis + "§0a single status ledger" | completed-plan / superseded ledger | **107 code refs** (most cited) + 2 gate assertion messages | **ARCHIVE** | Move the D2 "target architecture" into `docs/reference/canvas-dnd.md`, because the gate's failure message sends agents to it. §0a's open rows go to ROADMAP: D2 G6/G7/G8 + `@dnd-kit` removal, A7, the unverified E2.5 panel surfaces. The §15 decisions go to decisions.md or ROADMAP: L59 says "six open decisions unanswered"; FEEL §6.1 answered one, and the rest are unverified. |
| `STUDIO-IMPORT-V2-PLAN.md` | 1226 | WS-1…WS-9 roadmap; the trust-model argument | completed-plan (its own L10-19: 9 of 10 sections shipped) | 21 code · CLAUDE:12 · BRIEF:127,459 · README:114 · handoff-protocol:135 · 8 agent files (§1j) · standing-03 | **ARCHIVE** | §0's trust argument goes to the new `docs/features/trust-tiers.md`. §1's ten requirements in the owner's words go to ROADMAP "Product bar". Open items WS-4.4, WS-8.1 and WS-5.6 go to ROADMAP. **The WS-n vocabulary stays resolvable** because the archived file keeps it. Agent files must stop sending new work to "find your WS here". |
| `STUDIO-LIVE-CANVAS-PLAN.md` | 655 | Tracks L (live frames), R (refusals), P (Penpot inspector) | completed-plan (L9 open). L13-15 "no project ever promoted past static" is stale. | 36 code · BRIEF:130 · inspector.md · penpot baseline | **ARCHIVE** | Track L's architecture goes to the new `docs/features/live-canvas.md`: the Tier-2 runtime, `server/liveOrigin.ts`, `devServer.ts`, the `@core/studio-runtime` bridge. No feature doc covers Tier 2 today; it is scattered over server.md, glossary and canvas-internals. L9 goes to ROADMAP. |
| `STUDIO-NEXT-WORKSTREAMS.md` | 1814 | WS-10…WS-14 + decisions D1-D5 | completed-plan. **L3 "in progress (2026-08-01)" is stale.** D1 "main is not the trunk" is stale. WS-14 L1800 "CLAUDE.md lists seven barrels" is stale (CLAUDE.md now lists 12). | 1 code · inspector.md:57,2124 · PARITY:29 | **ARCHIVE** | D1-D5 go to decisions.md. Open items go to ROADMAP: WS-14.1 (Emotion object styles), 14.3 (story args writeback), 14.4 (selection colours), 14.7 (dead-code sweep). |
| `STUDIO-PROTOTYPE-PLAN.md` | 220 | Prototype mode | completed-plan (1 open item: `back`-shaped derived flows) | 8 code · studio-prototype.md:565 | **ARCHIVE** | §1-§4 rationale goes to `docs/features/studio-prototype.md`: "a link is a design layer, never source", `.studio/prototype.json` storage, why `(pageId,nodeId)` is not enough. The open item goes to ROADMAP. |
| `STUDIO-WAVE7-PLAN.md` | 546 | Waves 7-10 work orders | completed-plan (WAVE7-STATUS L3: "finished") | 7 code · still names `inspector-disclosure.md` at L47,249 | **ARCHIVE** | Kept only because code cites W-numbers. |
| `STUDIO-WAVE7-STATUS.md` | 83 | Waves 7-10 closing status | completed; rows #57-#60 duplicated | 0 code · docs/README:210 | **DELETE** | Pure status; git history keeps it. |
| `STUDIO-SPEED-PLAN.md` (only on branch `docs/studio-speed-plan`, PR #205) | n/a | Live-canvas speed plan, nine work orders | in flight | n/a | **MERGE-INTO `ROADMAP.md`** when #205 lands | This is the plan actually executing. Do not let it become the 11th root plan. |
| `agent-capture.html`, `share.html` | n/a | Vite HTML entry points (`vite.config.ts:199-209`) | code, not docs | vite config | **KEEP, out of scope** | Not stray: removing them breaks the build. |

### 1b. `docs/` top level

| Path | Lines | Purpose | Status | Disposition | Reason |
|---|---|---|---|---|---|
| `docs/README.md` | 280 | Doc index | partly-stale | **REWRITE** as the doc map (§3) | L8 says "Nothing in that half has been deleted", but workspace routes (PR #18), CMS explorer panels (panel-11) and MCP `site_*` writes (mcp-25) were all deleted. L202 calls FIGMA-FEEL "the plan currently being executed". L198-211 is the plans table. |
| `docs/CONVENTIONS.md` | 267 | How docs are written | partly-stale | **REWRITE (small)** | L67 lists `features/media.md`, which does not exist. It has no header convention and no "plan" or "archive" doc types. The file says to change it first, before other docs. |
| `docs/architecture.md` | 474 | System overview | current, partly CMS | **KEEP**, absorb CMS-REMOVAL traps | |
| `docs/design.md` | 965 | Visual design system | current; over 600 | **KEEP, path frozen** (css-token-vocabulary gate) | |
| `docs/editor.md` | 840 | Admin + editor deep dive | current, but carries deletion-history prose (L92, L143-146, L180, L642) | **KEEP**, trim the history | CONVENTIONS forbids history. |
| `docs/server.md` | 889 | Server deep dive | current | **KEEP** | |

### 1c. `docs/agent-refs/` (all KEEP; the no-alm gate scans this folder)

| Path | Lines | Status | Fix |
|---|---|---|---|
| `canvas-internals.md` | 1349 | current, but not "compressed": 2x the ceiling, and +89 lines are in flight | Split §Perf later. Check §Perf (L1031+) against the stale standing-03. |
| `conventions-quickref.md` | 245 | current | **Add** the `mock.module` rule (gated by `mock-module-must-restore.test.ts`). Today it exists only inside STATE `standing-01`. |
| `editor-store.md` | 528 | current | none |
| `glossary.md` | 237 | current | L200 cites FIGMA-FEEL. Retarget to decisions.md. |
| `handoff-protocol.md` | 138 | partly-stale: L135 says "IMPORT-V2 = what we intend to build", and the rules it states are not followed | **REWRITE** (§2.4) |
| `path-index.md` | 444 | current | L402 links CMS-REMOVAL. Retarget to architecture.md. |
| `studio-pipeline.md` | 551 | partly-stale: L5 "(578 lines)" | Drop the count. docs-03 decided counts drift and should be replaced by a pointer. |

### 1d. `docs/features/`

| Path | Lines | Status | Disposition / note |
|---|---|---|---|
| `agent.md` | 1831 | current; 3x ceiling | KEEP, path frozen by `studio-tool-refusals-are-coded.test.ts` |
| `auth-and-access.md` | 494 | CMS-shaped, load-bearing for Studio auth | KEEP, trust `shared` |
| `board-annotations.md` | 330 | current | KEEP |
| `canvas-iframe-per-frame.md` | 417 | current | KEEP |
| `canvas-rulers-and-guides.md` | 180 | current | KEEP |
| `editor-preferences.md` | 379 | shared | KEEP |
| `html-import.md` | 254 | CMS-shared | KEEP (label) |
| `inspector.md` | 2125 | current; 3.5x ceiling; "History" block at L18-35 | KEEP; retarget plan links at L22, L57, L2122, L2124 |
| `mcp-connectors.md` | 781 | current | KEEP |
| `modules.md` | 564 | shared | KEEP |
| `plugin-system.md` | 1186 | CMS-only | KEEP (label); L3 cites CMS-REMOVAL |
| `prototype-export.md` | 280 | current | KEEP |
| `publisher.md` | 573 | mostly CMS-only (`src/core/publisher/` is load-bearing) | KEEP; **L172 links `docs/features/loops.md`, which does not exist** |
| `site-import.md` | 382 | mixed; L7 cites CMS-REMOVAL | KEEP (label) |
| `site-shell.md` | 577 | CMS-only (the DB `site` row) | KEEP (label) |
| `spotlight.md` | 526 | shared | KEEP |
| `studio-comments.md` | 469 | current | KEEP |
| `studio-deploy.md` | 221 | current; L3 status "needs human dogfooding" | KEEP; the dogfood status belongs in the STATE Pending list |
| `studio-git.md` | 701 | current | KEEP |
| `studio-import.md` | 1625 | current; 2.7x ceiling | KEEP |
| `studio-prototype.md` | 568 | current | KEEP + absorb PROTOTYPE-PLAN §1-§4 |
| `studio-share.md` | 185 | current | KEEP |
| `visual-components.md` | 463 | CMS-shared | KEEP (label) |
| **NEW** `live-canvas.md` | n/a | gap | CREATE from LIVE-CANVAS Track L + `server.md` liveOrigin + canvas-internals |
| **NEW** `trust-tiers.md` | n/a | gap | CREATE from IMPORT-V2 §0 + CLAUDE.md L66 parenthetical + glossary. CLAUDE.md then shrinks to one rule + one link, and the in-flight default change lands in one place. |
| **NEW** `design-system.md` | n/a | gap | CREATE from BUILTIN plan §2+: vendored DS, per-project `design-system/`, Assets panel, Add page |

### 1e. `docs/reference/` (all KEEP; the no-alm gate scans this folder)

| Path | Lines | Status | Fix |
|---|---|---|---|
| `admin-router.md` | 377 | current | none |
| `architecture-tests.md` | 384 | partly-stale | **L216 "See docs/features/media.md" does not exist.** L261 admits `site-transfer.md` was never written. L134 cites PARITY. |
| `canonical-jsx.md` | 356 | current | none |
| `canvas-dnd.md` | 966 | partly-stale | L103, 175-182, 824-835 and 863 describe "the Media workspace" as a live DnD topology. The workspace was deleted; `useMediaDnd.ts` survives inside the media picker. L6 and L897 cite PARITY. **This doc receives the D2 target architecture.** |
| `capabilities.md` | 421 | partly-stale | L58-76 "Data workspace" and "Open the Media workspace" describe UIs that no longer exist; the capabilities themselves remain. L144 and L191 cite FIGMA-FEEL. |
| `css-class-registry.md` | 424 | CMS-shaped, shared | label |
| `database-dialects.md` | 388 | CMS-only, load-bearing | label |
| `design-tokens.md` / `ui-primitives.md` | 558 / 670 | current; paths frozen by gate | none |
| `editor-history.md` | 468 | current (+100 lines in flight) | none |
| `error-boundaries.md` | 394 | current | L48 cites FIGMA-FEEL |
| `module-engine.md` 438 · `page-tree.md` 346 · `persistence-keys.md` 215 · `react-compiler.md` 47 · `typebox-patterns.md` 346 · `use-async-resource.md` 167 | | current | none |

### 1f. `docs/deployment/` (8 files, KEEP; paths frozen by `scripts/build-release-bundle.ts:23-29`)

`README.md` 121 · `backup-restore.md` 195 · `docker-image.md` 173 · `railway.md` 163 · `release-workflow.md` 150 · `render.md` 133 · `tls-caddy.md` 171 · `vps.md` 242.

Status: **partly-stale (CMS-era)**. **Not one of the 8 files mentions `studio-workspace/`** (grep count 0 in each). `backup-restore.md` backs up "the database and the uploaded media", which leaves out Studio's actual user data. Flag it for REWRITE by server-engineer. This is a real operational gap.

### 1g. `docs/e2e/`

| Path | Lines | Status | Disposition |
|---|---|---|---|
| `README.md` | 764 | partly-stale. e2e-1 fact 5: about 56 CMS-half tests drive UIs that no longer exist. L294-298 cite FEEL. | KEEP; receives e2e-1's five durable facts (STATE L17986-18008) |
| `protocol.md` | 186 | partly-stale. L59 names the missing `feature-matrix.md` and the deleted `core-owner-lifecycle.e2e.ts`. | KEEP, fix |
| `run-log-template.md` | 83 | current. It targets `docs/e2e/runs/`, which does not exist. | KEEP |
| `COLD-SUITE-TRIAGE.md` | 138 | historical (2026-09-19); 1 code ref | **ARCHIVE**. PR #204 deletes it; reconcile. |
| `agent-upgrade-dogfood.md` | 280 | completed-plan (2026-08-03 dogfood script; 0 refs) | **ARCHIVE**, or DELETE once the owner confirms it was run |

### 1h. `docs/audits/` (historical; **KEEP IN PLACE**. Code cites these paths: `2026-08-06/` from 11 files, `penpot-inspector-baseline/` from 12.)

Add to every file: `> Trust: historical, dated <folder date>. Paths may be wrong. Never act on it.` `docs/README.md` already says this, but an agent landing from a grep never reads the index.

| Path | Lines | Status | Disposition |
|---|---|---|---|
| `2026-08-06/01-figma-fidelity.md` 275 · `02-design-system-authoring.md` 528 · `03-creative-from-scratch.md` 70 · `04-canvas-rulers-figma-feel.md` 680 · `05-canvas-performance.md` 372 · `06-editing-performance-store.md` 435 · `07-drag-and-drop.md` 566 · `08-properties-panel-design.md` 415 · `09-refusal-states.md` 180 · `10-classes-vs-inline-styles.md` 511 · `11-colors-and-fonts.md` 670 · `12-components-and-slots.md` 976 | 5,678 | historical (the PARITY plan's source audit) | KEEP + header |
| `2026-08-07-parity-handoffs/` 32 files: `handoff-a5-guide` 216 · `b1-css-engine` 224 · `b1b-create-stylesheet` 305 · `b2-classname` 135 · `b3-tailwind` 224 · `c2-boardframes` 222 · `c3-injectors` 162 · `c5-reload` 290 · `canvas` 300 · `d1-rulers` 200 · `d2-d3-dnd` 547 · `e1-catalog` 209 · `e21-extract` 288 · `e22-slot-props` 596 · `e23-parser` 232 · `e24-slot-writeback` 392 · `e25-surfaces` 293 · `e3-e4-packages` 339 · `f1-inspector` 381 · `f2-refusals` 133 · `gate-backlog-2` 210 · `gate-backlog` 261 · `gates` 594 · `h-tokens` 405 · `mcp` 255 · `panel` 398 · `scribe-b2-followups` 189 · `scribe` 125 · `store-seams-c1-c4` 279 · `store` 135 · `t4-token-shadowing` 285 · `track-a` 362 | about 9,300 | historical handoffs; **0 code refs**; 1 doc ref (PARITY §0a) | **ARCHIVE** to `docs/archive/2026-08-07-parity-handoffs/` together with PARITY |
| `2026-09-13-live-frame-memory-baseline.md` | 76 | stale placeholder ("BLOCKED, no number measured"). Its blocker, "no Tier-2 project exists", is gone (Vite auto-promote; run-project default in flight). | KEEP (1 code ref); the measurement goes to ROADMAP |
| `penpot-inspector-baseline/README.md` 85 · `00-setup` 117 · `01-fixtures` 134 · `02-measurements` 192 · `03-operating-behaviors` 138 · `04-token-gaps` 92 · `05-section-heights.md` 312 + `.json` + `measurements.json` + screenshots | | historical measurements, cited as evidence by `measurement.test.ts` and 11 source files | KEEP + header (`05-section-heights.json` is modified in the working tree) |

### 1i. `docs/state-archive/`

| Path | Lines | Status | Disposition |
|---|---|---|---|
| `2026-Q3.md` | 14,073 | historical; 164 `###` headings in 4 parts (Jul 30 → Sep 6) | KEEP untouched. Its index moves out of STATE (§2). |

### 1j. `.claude/agents/` (15 files; frontmatter `model: sonnet`, consistent with CLAUDE.md:22)

| Path | Lines | Stale references to fix |
|---|---|---|
| `README.md` | 67 | none beyond the protocol |
| `canvas-engineer.md` | 120 | **L35 routes to `standing-03` (stale)** |
| `perf-hunter.md` | 112 | **L15 `standing-03`**; L18 IMPORT-V2 WS-5 |
| `store-engineer.md` | 119 | **L18 `standing-03`** |
| `mcp-tooling.md` | 112 | L18 IMPORT-V2 WS-9 |
| `panel-designer.md` | 103 | L19 IMPORT-V2 WS-6 |
| `parser-surgeon.md` | 118 | L111 IMPORT-V2 WS-3 |
| `security-guard.md` | 119 | L22 IMPORT-V2 §0 / WS-1.4. Goes to `trust-tiers.md`. |
| `studio-architect.md` | 99 | L3, L18, L55: the output template field `ROADMAP: <WS-n §x.y of STUDIO-IMPORT-V2-PLAN.md>` goes to `ROADMAP.md` |
| `studio-scribe.md` | 80 | L30 "Intent not yet built → IMPORT-V2" goes to ROADMAP.md. L49-52 procedure goes to the new protocol. |
| `studio-implementer.md` 91 · `studio-verifier.md` 107 · `test-engineer.md` 104 | | route to `standing-01`. **Keep that id stable** in the new STATE. |
| `server-engineer.md` 144 · `studio-scout.md` 78 | | none (server-26's `gitStatusParse.ts` landmine is already fixed at L49) |

Other tracked md files are out of scope; KEEP: `.github/PULL_REQUEST_TEMPLATE.md`, `examples/*/README.md`, `scripts/bench/README.md`, `.agents/skills/**` (third-party skill packs; their 6 dangling links are upstream's).

`docs/assets/readme/*` holds 6 CMS-era images (analyze-dashboard, manage-media, …) with **zero references**. They are a DELETE candidate, but they are images, so confirm with the owner.

### 1k. Missing link targets (every `docs/…md` / `X-PLAN.md` path mentioned anywhere in tracked files, checked for existence)

| Target that does not exist | Cited at |
|---|---|
| `docs/features/inspector-disclosure.md` | **52 places outside STATE** (`inspector-disclosure-refs.txt`) + 29 in STATE |
| `docs/features/media.md` | `docs/reference/architecture-tests.md:216` · `server/handlers/cms/mediaUpload.ts:313` · `docs/CONVENTIONS.md:67` |
| `docs/features/loops.md` | `docs/features/publisher.md:172` |
| `docs/features/studio-projects.md` | `STUDIO-IMPORT-V2-PLAN.md` (1) |
| `docs/features/site-transfer.md` | `docs/reference/architecture-tests.md:261` (admitted never written) |
| `docs/e2e/feature-matrix.md` | `docs/e2e/protocol.md:59` (admitted) |
| `docs/plans/2026-05-*.md`, `docs/superpowers/**` (Instatic-era) | 18 code comments, e.g. `no-vc-mode-branches-in-mutations.test.ts` (4), `treeSchema.ts`, `page.ts`, `condition.ts`, `capabilities.ts`, `classCss.ts`, `styleRule.ts`, 6 architecture tests |
| `STUDIO-WAVE4-PLAN.md`, `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`, `STUDIO-COMMENTS-PLAN.md` (deleted by docs-04) | PARITY:24-25 · NEXT-WS:1743-1744 · WAVE7-PLAN:5 · inspector.md:18. "Retired" prose; acceptable. |

The markdown-link-only scan (`dangling.txt`) is clean apart from `.agents/skills` and 2 placeholder links. **Nearly all rot is in backtick paths, which a link checker does not see.** Any "check for dangling links" step must also grep backtick paths.

---

## 2. STATE.md restructuring

### 2.1 What is there now (line ranges on this worktree)

| Zone | Lines | Size | Entries | What it actually is |
|---|---|---|---|---|
| Header | 1-14 | 14 | — | Pointer to the protocol and archive. L6 "Areas in use" lists 14 areas; about 30 are in use (`live`, `git`, `verify`, `resil`, `keys`, `proto`, `dev`, `e2e`, `refusal`, `board`, …). |
| **Orphan prelude** (no section) | 15-1987 | 1,973 | 15 | parser-14, perf-10, store-11, panel-33, panel-32, canvas-16, panel-31, test-04, panel-29, panel-28, panel-27, meta-10, panel-26, meta-09, store-10. Agents prepend here instead of under `## Now`. |
| `## Now` | 1988-15276 | **13,289** | **137** | Only `resil-01` is genuinely in flight. `verify-4` is "in progress" but superseded by e2e-1. `panel-23`, `meta-08`, `live-01`, `live-02`, `refusal-01`, `board-27c` and `server-19` carry stale `verifying`/`design` stages for work their plans record as landed. The rest are `done`. Entry-internal `##` headings (sec-16, canvas-20, …) break every outline tool. |
| `## Blocked` | 15277-15283 | 7 | 0 | "nothing blocked", dated to meta-02/03 in July |
| `## Pending dogfood` | 15284-15561 | 278 | — | Real human checklist: pointers for entries still in STATE, plus verbatim scripts for archived ones (mcp-19, …) |
| `## Recently landed` | 15562-17623 | 2,062 | 23 | cap about 10; the newest is from 2026-09-07 |
| `## Standing notes` | 17624-17783 | 160 | 10 | see 2.3 |
| `## Standing authorization` | 17784-17807 | 24 | — | 2026-07-31 "run the whole plan without stopping to ask" + the acceptance bar |
| `## Archive` | 17808-17974 | 167 | index of 154 | one-line index into `2026-Q3.md` |
| stray `## e2e-1` | 17975-18013 | 39 | 1 | appended after Archive; holds 5 durable e2e facts |

Duplicate ids (the archive index must disambiguate by date): `panel-33` (L594 and L8545), `panel-19` ×2, `server-20` ×2, `panel-14` ×2, `panel-15` ×2, `mcp-20` ×2, `perf-04` (L13240 and L17145), `panel-11` (L14624 and L17362), `panel-10` (Now and archive), plus `perf-9`/`perf-09`-style drift. Full per-zone id list with line numbers: `state-ids.txt`.

### 2.2 Target shape (≤400 lines; each section has a hard cap)

```markdown
# STATE
> Purpose: live coordination only: what is in flight, blocked, owed. · Read when: before any task; write at every stage boundary. · Trust: live; a claim older than its Updated date may be stale.
Protocol: docs/agent-refs/handoff-protocol.md · Plan: ROADMAP.md · Decisions: docs/decisions.md · History: docs/state-archive/INDEX.md

## Now                  ≤ 8 entries, ≤ 40 lines each. ONLY unmerged work. New entries go HERE, never above this heading.
## Blocked              one line per item: id · question · who decides · since
## Pending dogfood      one line per item: id · route · what to look at · link to the full script
## Standing notes       ≤ 120 lines, grouped by subsystem (see 2.3), each: id · fact · date verified · gate/file
## Recently landed      ≤ 10 one-liners: id — title — PR — date → archive file
## Archive              3 lines: pointer to docs/state-archive/INDEX.md
```

Supporting moves:
- **`docs/state-archive/2026-09.md`** (new): every entry moved out of this STATE, verbatim, newest first. Use monthly files from here on. At 14k lines, `2026-Q3.md` shows a quarter is already too big to grep comfortably. Update `handoff-protocol.md` to match.
- **`docs/state-archive/INDEX.md`** (new): one line per entry for all archive files: `date · id · title · file`. It absorbs STATE L17808-17974 and the index inside `2026-Q3.md`. Duplicate ids are disambiguated by date.
- **`docs/e2e/dogfood-backlog.md`** (new; or keep inside STATE if the owner prefers): the verbatim dogfood scripts now at L15284-15561. STATE's Pending dogfood becomes one line per item. The protocol's requirement that scripts are "reproduced verbatim until run" is met in a file nobody has to scroll past.
- **`docs/decisions.md`** (new): owner decisions with date, source and consequence (§3a).

### 2.3 Durable-fact extraction: exact sources and destinations

**Standing notes (L17624-17783), triaged:**

| Id | Verdict | Destination |
|---|---|---|
| standing-01 (L17660) failure bucket "33" | **stale number** (later entries measure 5-17 reds; e2e-1 adds the cold e2e baseline). The method stays valid. | Keep the id. Rewrite it as a pointer plus the triage rule, and move the `mock.module` / store-leak / CRLF causes to `conventions-quickref.md` |
| standing-02 (L17671) browser vs static split | duplicate of CLAUDE.md "Verification" (L362-372) | **Drop from STATE**; CLAUDE.md owns it |
| standing-03 (L17716) "two known perf defects" | **stale**. Defect 2 is fixed: `PropertiesPanelBody.tsx:104-111` reads the O(1) `_textOriginKeyToCount` index (WS-5.2), and `InPlaceInspector.tsx` has moved to `canvas/InPlaceInspector/`. Defect 1 was addressed by the in-iframe/event-driven overlay (canvas-17 S4). | **Retire → archive**; fix canvas-engineer:35, perf-hunter:15, store-engineer:18 |
| standing-04 (L17726) `public/runtime/react.js` | probably superseded (WS-3 shipped the `componentBundle` path) | verify, then fold into `path-index.md` or retire |
| standing-05 (L17732) parallel-wave protocol | current | KEEP (group: Workflow). Add server-26 landmines 2-3 (L6660-6665): worktrees seeded 197 commits behind; the scratchpad is not per-agent. |
| standing-06 (L17693) one commit per work order | mostly duplicates CLAUDE.md "Repository workflow" | move "one commit per work order" into CLAUDE.md; **drop** |
| standing-07 (L17704) | self-marked RETIRED | **archive** |
| standing-08 (L17626) never `npx tsc` | current | KEEP (group: Tooling) |
| standing-09 (L17744) happy-dom drops `@layer` | **stale in its "live defect" half**: `cssToStyleRules.ts:39-48` now runs `unwrapCssLayers` (PARITY B3). The happy-dom CSSOM fact is still true. | Move the happy-dom fact to `conventions-quickref.md` §tests; **archive** the rest |
| standing-10 (L17657) `setup.ts` tmpdir workspace root + `--parallel=4` + the `\u0000` tool-escape trap | current | KEEP (group: Tests); split the tool-escape trap into its own line |

**Durable facts buried in entries** (grep markers: `DURABLE FACT`, `Decisions a later agent should not re-litigate`, `Landmines`, `must not rediscover`). For each one, check the named doc first. Most were already folded in by per-task scribes, so the default is to **archive the entry verbatim and not copy the fact** (one fact, one place).

| STATE location | Fact | Already in | Action |
|---|---|---|---|
| L17975-18013 `e2e-1` facts 1-5 | `openFixtureBoard`/Ctrl+0; ClassPicker pill is the write target; size lives in Measures; same-file reparent is a write; the CMS e2e half tests a UI that no longer exists | `docs/e2e/COLD-SUITE-TRIAGE.md` (which #204 deletes) | Move to `docs/e2e/README.md` "Authoring rules"; the CMS-half decision goes to ROADMAP/Blocked |
| L2126-2150 `sec-14` decisions 1-6 + landmines 1-9 | route-capability design (map by effect; undeclared → 404; never `requireCapability` in a sub-router; two edits per sub-router; MCP not covered by the gate) | CLAUDE.md "Studio routes are declared" + `capabilities.md` + `server.md` (all name `routeCapabilities`) | verify landmines 3-9 are in `capabilities.md`; archive |
| L4544-4575 `sec-18` decisions + landmines | exact route entries, `jobId`, realpath `.native` casing, private-file writers, `redactRemoteUrlCredentials` placement | `conventions-quickref.md` + `path-index.md` (they name `writePrivateFile*`) | verify `.native` and `/inheritance:r` in `conventions-quickref.md` §Safety; archive |
| L2338-2360 `server-25` decisions | trust tier read from one directory | `trust-tiers.md` (new) | fold; archive |
| L6635-6670 `server-26` decisions + landmines | `splitLines`/`toLf`, the runner does not normalise, NDJSON out of scope, `bun run test` redirected prints no summary | `conventions-quickref.md` + `studio-git.md` (they name `splitLines`) | add the "no summary when redirected" note to standing (Tests); archive |
| L7194-7210 `server-24` DURABLE FACT (CRLF broke the `*:sync` gates) | | `PROJECT-BRIEF.md` §6 trap 15 | archive only |
| L2032 `meta-13`, L4405 `meta-17`, L6961 `meta-16`, L7073 `meta-15`, L7084 `meta-14` | wave narratives | FEEL plan (archived) | archive |
| L1990 `resil-01` | the one real in-flight entry (draft PR #193 merged into this line) | — | stays in **Now**, trimmed to ≤40 lines, with its long form archived |
| L15/271 `parser-14`, `perf-10` | merged into this branch (`3f2a4c6b`, `560ddb0e`) but not into `origin/main` | — | Now → Recently landed once the line merges |
| L17784-17807 Standing authorization | "run to completion without asking" + the acceptance bar | — | **Owner must re-confirm.** An agent cannot carry a blanket authorization forward on its own say-so. If confirmed, it goes to `docs/decisions.md`. The acceptance bar ("done = a browser pass drives real input") is already CLAUDE.md's e2e rule. |
| `sec-05` (L11367), `verify-4` (L6554), FEEL L779-810, `sec-18` open items | open findings | — | ROADMAP "Open" (not STATE) |

### 2.4 Procedure (for the orchestrator, after the in-flight PRs land)

0. **Freeze.** Announce the restructure. Run it on the integration head that contains #192/#195/#198-#210/#205, or on `main` after they merge. In-flight branches write their handoffs to a scratch file per `standing-05` until it lands.
1. Re-run the zone scan (the awk in this audit) on that head. Line numbers in this report are for `560ddb0e` only.
2. Create `docs/state-archive/2026-09.md`. Append **verbatim**: the orphan prelude (entries at L15-1987), every `## Now` entry except those still unmerged, all 23 `## Recently landed` entries, standing-03/07/09 (retired), and entry-internal sections as-is. Order newest first by `Updated`.
3. Build `docs/state-archive/INDEX.md` from both archive files. Mechanical: `^### <id> — <title>` plus the `Updated:` line plus the file. Disambiguate duplicate ids by date.
4. Move the dogfood scripts (L15284-15561) verbatim into `docs/e2e/dogfood-backlog.md`. Leave one line per item in STATE.
5. Fold durable facts per the 2.3 table. **For each fact, grep the destination first; copy only what is missing.**
6. Write the new STATE (2.2). Keep the ids `standing-01`, `-05`, `-08` and `-10` stable, because agent files cite them.
7. Rewrite `handoff-protocol.md`:
   - new layout;
   - "new entries go under `## Now`, never above it";
   - a 40-line cap per entry (long form goes in the PR body, linked);
   - monthly archive files + INDEX;
   - "Recently landed = one-liners";
   - remove the L135 IMPORT-V2 row.
8. Verify: `wc -l STATE.md` ≤ 400. Every id in the old STATE appears in INDEX.md (`grep -c` parity). No `### ` heading appears before `## Now`.

---

## 3. Proposed doc map

### 3a. Who owns what (no overlap)

| File | Owns | Must NOT contain |
|---|---|---|
| `CLAUDE.md` | Constraints every change must satisfy, each with its gate; a 5-line reading order; workflow/PR rules | Product narrative, stack description, plan tables, feature descriptions (the invariant-1 parenthetical goes to `trust-tiers.md`) |
| `AGENTS.md` | 3-line pointer for non-Claude tools → CLAUDE.md | anything else |
| `PROJECT-BRIEF.md` | What Studio is, the CMS disambiguation, what works and what doesn't (orientation level), traps, task → agent routing | Plan/status tables (→ ROADMAP), per-track status, line counts |
| `ROADMAP.md` (new, root; the orchestrator's master plan) | **The only living plan**: product bar (IMPORT-V2 §1), open work grouped by area, each with its source entry id, owner-pending decisions, and the in-flight plan (SPEED) | Shipped-feature descriptions (→ `docs/features`), history (→ archive) |
| `docs/decisions.md` (new) | Settled owner decisions: date · decision · consequence · source. Sources: FEEL §6 (7), NEXT-WS D1-D5, BUILTIN §0 (3), PROTOTYPE §1, CMS-REMOVAL "the decision" if called, trust default 2026-09-20 (`sec-19`), standing authorization if re-confirmed | Open questions (→ ROADMAP) |
| `STATE.md` | Live coordination only (§2.2) | durable how-it-works (→ refs), plans |
| `docs/README.md` | **The map**: every doc, one row: path · purpose · read when · trust. The agent entry point after the BRIEF. | prose orientation (→ BRIEF) |
| `docs/archive/` (new) | `plans/` (archived root plans, filenames unchanged), `2026-08-07-parity-handoffs/`, e2e one-offs; `README.md` says "historical — never act on these" | anything current |
| `README.md` (root) | Humans: what it is, quick start, commands, link to docs/README | agent routing |

**Agent entry path (one line, stated identically in CLAUDE.md, AGENTS.md and README.md):** `PROJECT-BRIEF.md` → `STATE.md` → `ROADMAP.md` → `docs/README.md` (map) → the `agent-refs/` page the BRIEF's routing table names. There is no new entry file: a fifth "start here" file would itself be a contradiction source.

### 3b. Header convention for every doc (add to `docs/CONVENTIONS.md` first)

The header replaces the current first line:

```markdown
# <Title>
> **Purpose:** <one line> · **Read when:** <task trigger> · **Trust:** <level> · **Owner:** <agent> · **Verified:** <YYYY-MM-DD>
```

Trust levels:

| Level | Meaning |
|---|---|
| `rule` | Gated; CLAUDE.md, conventions-quickref |
| `current` | Describes the tree as it is; maintained |
| `current-cms` | Accurate, but for the dormant CMS half |
| `live` | Changes daily (STATE, ROADMAP) |
| `index` | A map (docs/README) |
| `historical` | Dated record; paths may be wrong; never act on it (audits, archive, state-archive) |

Exclusions: `vendor/**` (data), `.agents/**` (third party), `examples/**`. Optionally add a cheap gate: an architecture test asserting that line 2 of every `docs/**/*.md` outside `audits`/`archive`/`state-archive` matches `^> \*\*Purpose:\*\*`. The same test can assert that no tracked file names `docs/features/inspector-disclosure.md` or any path in the known-missing list.

### 3c. Contradictions that would confuse an agent today

| # | Claim | Contradicted by |
|---|---|---|
| C1 | `PROJECT-BRIEF.md:129` and `docs/README.md:202`: FIGMA-FEEL is "the plan currently being executed" | `STUDIO-FIGMA-FEEL-PLAN.md:117-120` ("the owner called the plan closed"); STATE `meta-17` (L4405) |
| C2 | `STUDIO-FIGMA-FEEL-PLAN.md:3`: "proposed, nothing started" | same file L50-147 (three waves landed) |
| C3 | `STUDIO-NEXT-WORKSTREAMS.md:3`: "in progress (2026-08-01)"; L1800: "CLAUDE.md lists seven barrelled modules" | WS-10…13 shipped (`canonical-jsx.md`, `claudeCli.ts`, `previewAxes.ts`); CLAUDE.md "Barrel imports" lists 12 |
| C4 | `PROJECT-BRIEF.md:419`: "CSS-in-JS is detection-only. Nothing reads or writes those styles." | `src/core/page-parser/cssInJsExtract.ts`, `src/core/ast-codemods/setStyledDeclaration.ts`; PARITY §0a waves 4-5 row; STATE parser-11/style-05 |
| C5 | `PROJECT-BRIEF.md:422`: "Cross-FILE reparent refuses" | `PROJECT-BRIEF.md:365` ("cross-frame move … one ⌘Z"); `src/core/ast-codemods/transplantJsxElement.ts`; STATE canvas-20 |
| C6 | `PROJECT-BRIEF.md:130` and `STUDIO-LIVE-CANVAS-PLAN.md:14-15`: "no project has ever been promoted to Tier 2" | CLAUDE.md:66 (Vite auto-promote); `studio-workspace/__vite-live-fixture/.studio/meta.json:10-12` (`run-project`, `trustAutoPromoted: true`) |
| C7 | `CLAUDE.md:66`: `static` is "the never-auto-promoted default" | in-flight `feat/trust-tier-default-run-project` / #204: `DEFAULT_TRUST_TIER = 'run-project'`, owner decision 2026-09-20 (sec-19). **This will be true on the integration head, so docs must follow it there.** |
| C8 | `CLAUDE.md:12`, `handoff-protocol.md:135`, `studio-scribe.md:30`, `studio-architect.md:18,55`: IMPORT-V2 is "the roadmap / where intent lives" | `STUDIO-IMPORT-V2-PLAN.md:10-19` ("Read this as intent, not as status. Nine of ten sections shipped") |
| C9 | `PROJECT-BRIEF.md:387`, `docs/README.md:205`, `inspector.md:22`: "PARITY §0a is the single status ledger" | PARITY §0a stops at waves 7-10 (2026-09-06); waves 1-3 of FEEL are tracked only in FEEL. There is no single ledger. |
| C10 | STATE `standing-03` (L17716-17724): two open perf defects, "do not re-diagnose" | `PropertiesPanelBody.tsx:104-111` (O(1) index); FEEL L37 ("Track C perf fixes are real"); agents are routed there by canvas-engineer:35, perf-hunter:15, store-engineer:18 |
| C11 | STATE `standing-09` (L17744): the `@layer` loss is "a live, un-fixed defect" | `src/core/siteImport/cssToStyleRules.ts:39-48` (`unwrapCssLayers`); PARITY §0a B3 ✅ |
| C12 | STATE `standing-01` (L17660): "the bucket is 33" | later entries: meta-16 L7045 (5 fail / 1 error), server-26 (13 `(fail)` lines, all load artefacts) |
| C13 | `handoff-protocol.md` layout ("Now = a handful"; "Recently landed ≈10") | STATE: 15 orphan entries, 137 in Now, 23 in Recently landed |
| C14 | `docs/README.md:8`: "Nothing in that half has been deleted" | `CLAUDE.md:74` (workspace routes deleted, PR #18); `docs/editor.md:92` |
| C15 | `docs/reference/canvas-dnd.md:103,175`: the Media workspace is a live DnD mechanism | `docs/editor.md:92`, `docs/reference/admin-router.md:62` (route deleted) |
| C16 | `docs/reference/capabilities.md:58-76`: "Open the Data workspace" / "Open the Media workspace" | same as C15 |
| C17 | `PROJECT-BRIEF.md:480`, `docs/agent-refs/studio-pipeline.md:5`: studio-import.md is "578 lines" | 1625 lines |
| C18 | `PROJECT-BRIEF.md:134`: test projects are "`test4` and `test4 copy`" | `studio-workspace/` holds `__board-perf-fixture __canonical-fixture __vite-live-fixture tasdasdas test4 untitled` |
| C19 | `STUDIO-FIGMA-PARITY-PLAN.md:59`: "the six open decisions in §15 are unanswered" | FEEL §6 decision 1 answered §15.1; the rest are unverified |
| C20 | 52 code/doc refs to `docs/features/inspector-disclosure.md` | the file is `docs/features/inspector.md` |
| C21 | `STATE.md:6`: "Areas in use: …" (14 areas) | about 30 areas in use |
| C22 | `docs/deployment/backup-restore.md`: a complete backup = database + uploaded media | Studio's user data is `studio-workspace/`, which no deployment doc mentions |

---

## 4. References that must be updated when files move

### 4a. Required. These break a gate, a link or agent routing.

**Path-sensitive markdown links to root plans (update if a plan moves):**
`CLAUDE.md:12` · `PROJECT-BRIEF.md:127,128,129,130,131,387,459` · `README.md:114` · `docs/README.md:8,202,203,204,205,206,207,208,209,210` · `docs/agent-refs/path-index.md:402` · `docs/features/inspector.md:22,57,2122,2124` · `docs/features/studio-prototype.md:565` · inter-plan links (only matter if the plans stay together): `STUDIO-FIGMA-PARITY-PLAN.md:6,29,94,1153` · `STUDIO-IMPORT-V2-PLAN.md:14` · `STUDIO-NEXT-WORKSTREAMS.md:1752,1777` · `STUDIO-WAVE7-STATUS.md:4`.

**Gate assertion messages (strings shown to an agent when a gate fails):**
`src/__tests__/architecture/single-drag-mechanism.test.ts:159,200` ("see STUDIO-FIGMA-PARITY-PLAN.md's D2 target architecture"; retarget to `docs/reference/canvas-dnd.md`) · `src/__tests__/architecture/toast-dedupe-default.test.ts:89` ("see STUDIO-FIGMA-FEEL-PLAN.md Z1").

**Gate config comment:** `src/__tests__/architecture/no-alm-npm-specifier.test.ts:49-52` (list `docs/archive/` among the excluded written records).

**Agent routing (prose, but agents execute it):**
`.claude/agents/studio-architect.md:3,18,55` · `studio-scribe.md:30,49` · `mcp-tooling.md:18` · `panel-designer.md:19` · `parser-surgeon.md:111` · `perf-hunter.md:15,18` · `security-guard.md:22` · `canvas-engineer.md:35` · `store-engineer.md:18` · `docs/agent-refs/handoff-protocol.md:135` (+ the layout section) · `docs/agent-refs/glossary.md:200`.

**Other docs naming plans (bare text):**
`PROJECT-BRIEF.md:105,183,208` · `docs/features/plugin-system.md:3` · `docs/features/publisher.md:7` · `docs/features/site-import.md:7` · `docs/reference/architecture-tests.md:134` · `docs/reference/canvas-dnd.md:6,897` · `docs/reference/capabilities.md:144,191` · `docs/reference/error-boundaries.md:48` · `docs/e2e/README.md:294,295,296,298` · `.gitignore:147` · `.gitattributes:6` · `CLAUDE.md:67`.

**Dangling today, fix regardless of any move:** the 52 `inspector-disclosure.md` refs (`inspector-disclosure-refs.txt`) · `docs/reference/architecture-tests.md:216` · `docs/features/publisher.md:172` · `docs/CONVENTIONS.md:67` · `server/handlers/cms/mediaUpload.ts:313`.

**If STATE is restructured:** every `standing-03`/`-07`/`-09` citation (canvas-engineer:35, perf-hunter:15, store-engineer:18). The `docs/state-archive/2026-Q3.md` links at `docs/README.md`, `docs/CONVENTIONS.md`, `handoff-protocol.md` and `STUDIO-FIGMA-FEEL-PLAN.md` still resolve, because that file does not move.

### 4b. Optional. These are code-comment citations that still resolve if plans are archived with unchanged filenames.

199 lines in `src/`, `server/`, `tests/` and `scripts/`. **If the orchestrator instead DELETES the plans, all of these become dangling rationale** and each needs rewriting to a feature-doc anchor. Full grouped list below (from `planrefs-compact.txt`; non-code rows are repeated from 4a for completeness):


```text
#### STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md
PROJECT-BRIEF.md:131,208 STUDIO-FIGMA-PARITY-PLAN.md:87 STUDIO-IMPORT-V2-PLAN.md:347 docs/README.md:208 

#### STUDIO-CMS-REMOVAL-PLAN.md
STUDIO-NEXT-WORKSTREAMS.md:1777 docs/README.md:8,209 docs/agent-refs/path-index.md:402 docs/features/plugin-system.md:3 docs/features/publisher.md:7 docs/features/site-import.md:7 

#### STUDIO-FIGMA-FEEL-PLAN.md
.gitattributes:6 .gitignore:147 CLAUDE.md:67 PROJECT-BRIEF.md:105,129,183 STUDIO-FIGMA-FEEL-PLAN.md:30,31,32,33,35,36 STUDIO-FIGMA-PARITY-PLAN.md:48,55,74,1148 STUDIO-LIVE-CANVAS-PLAN.md:22,650 STUDIO-NEXT-WORKSTREAMS.md:1763,1766 STUDIO-PROTOTYPE-PLAN.md:4,204,216 docs/README.md:202 docs/agent-refs/glossary.md:200 docs/e2e/README.md:294,295,296,298 docs/reference/capabilities.md:144,191 docs/reference/error-boundaries.md:48 scripts/bench/studioBoard.bench.ts:2 scripts/lib/devPreflight.ts:4 scripts/lib/stackChild.ts:17 server/ai/mcp/tools/studio/referenceRender.ts:32 server/auth/capabilities.ts:91 server/handlers/studio/agentTurnLog.ts:199 server/handlers/studio/trustGate.ts:21 server/handlers/studio/trustTier.ts:32 src/__tests__/architecture/error-boundary-coverage.test.ts:40 src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts:94 src/__tests__/architecture/studio-tier2-two-gates.test.ts:30 src/__tests__/architecture/toast-dedupe-default.test.ts:21,89 src/__tests__/inspector/measurement.test.ts:54 tests/e2e/agent-turn.e2e.ts:16 tests/e2e/github-sync.e2e.ts:4 tests/e2e/helpers/githubScratchRepo.ts:5 tests/e2e/studio-feel-phase0.e2e.ts:30 tests/e2e/studio-feel.e2e.ts:8 

#### STUDIO-FIGMA-PARITY-PLAN.md
PROJECT-BRIEF.md:128,387 README.md:114 STUDIO-FIGMA-FEEL-PLAN.md:33,36 STUDIO-FIGMA-PARITY-PLAN.md:6,29,48,55,74,87,94,1148,1153 STUDIO-IMPORT-V2-PLAN.md:14 STUDIO-NEXT-WORKSTREAMS.md:1752,1796 STUDIO-WAVE7-PLAN.md:6 docs/README.md:205 docs/audits/2026-08-07-parity-handoffs/handoff-c3-injectors.md:5 docs/audits/2026-08-07-parity-handoffs/handoff-canvas.md:198 docs/audits/2026-08-07-parity-handoffs/handoff-gates.md:228 docs/audits/2026-08-07-parity-handoffs/handoff-scribe-b2-followups.md:119 docs/features/inspector.md:22,2122 docs/reference/architecture-tests.md:134 docs/reference/canvas-dnd.md:6,897 server/ai/chatSystemPrompt.ts:72 server/ai/mcp/tools/studio/frameDiffEngine.ts:172,320 server/ai/mcp/tools/studio/qualityCheck.ts:2 server/ai/mcp/tools/studio/screenshot.ts:152 server/ai/tools/studio/agentToolNames.ts:63,88 server/ai/tools/studio/systemPrompt.ts:85,114,520 server/handlers/__tests__/studioWriteback.test.ts:600 server/handlers/studio.ts:221,241 server/handlers/studio/__tests__/tokenExtractCssScan.test.ts:66,140 server/handlers/studio/__tests__/tokenExtractJsTheme.test.ts:2 server/handlers/studio/__tests__/tokenExtractScss.test.ts:2 server/handlers/studio/__tests__/tokenExtractTailwind.test.ts:2 server/handlers/studio/canonicalPageCheck.test.ts:3 server/handlers/studio/canonicalPageCheck.ts:9 server/handlers/studio/componentSpecExtract.ts:4 server/handlers/studio/components.ts:3 server/handlers/studio/designSystemDigest.ts:209 server/handlers/studio/installDeps.ts:97 server/handlers/studio/packageManifest.ts:30 server/handlers/studio/pageSourceFile.ts:9 server/handlers/studio/projectTokenIndex.ts:38 server/handlers/studio/qualityAudit.ts:6 server/handlers/studio/referenceMeasure.ts:154,183 server/handlers/studio/reloadScope.ts:3 server/handlers/studio/tokenExtract.ts:19,217 server/handlers/studio/tokenExtractBuild.ts:96,108 server/handlers/studio/tokenExtractCssScan.ts:445 server/handlers/studio/tokenExtractJsTheme.ts:3 server/handlers/studio/tokenExtractScss.ts:3 server/handlers/studioEditSchemas.ts:415 server/handlers/studioSlotWriteback.ts:3 src/__tests__/admin/propertyControls/tokenizedColorField.test.tsx:2 src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts:121 src/__tests__/architecture/single-drag-mechanism.test.ts:2,32,159,200 src/__tests__/architecture/token-offered-is-reachable.test.ts:3,67 src/__tests__/canvas/boardFramesLayerRenderScope.test.tsx:14 src/__tests__/canvas/canvasComposedTreeRenderScope.test.tsx:12 src/__tests__/canvas/canvasDnd.test.ts:152 src/__tests__/editor-store/selectionSlice.test.ts:41 src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts:3 src/__tests__/editor-store/styleRuleSlice.test.ts:225 src/__tests__/framework/colors.test.ts:194 src/__tests__/store/selectCanvasPageFor.test.ts:2 src/admin/pages/site/canvas/canvasClassCss.ts:79 src/admin/pages/site/canvas/canvasDomGeometry.ts:327,377 src/admin/pages/site/canvas/canvasZoomFit.ts:4 src/admin/pages/site/hooks/useCanvasZoomToFit.ts:84 src/admin/pages/site/panels/AssetsPanel/ModulePicker.tsx:17 src/admin/pages/site/panels/AssetsPanel/PackageBundleNotice.tsx:2 src/admin/pages/site/panels/DependenciesPanel/DepsSection.tsx:15 src/admin/pages/site/panels/DependenciesPanel/useDependencyInstallJob.ts:2 src/admin/pages/site/panels/DomPanel/DomPanel.tsx:220 src/admin/pages/site/panels/PropertiesPanel/slotOwners.ts:16 src/admin/pages/site/panels/classAssignmentUnsavedNotice.ts:18 src/admin/pages/site/panels/unexplainedSkipsNotice.ts:3 src/admin/pages/site/property-controls/ColorControl.tsx:17 src/admin/pages/site/property-controls/ColorValueInput.tsx:41 src/admin/pages/site/property-controls/TokenizedColorField.tsx:41,176 src/admin/pages/site/store/historyCoalesce.ts:8 src/admin/pages/site/store/slices/selectionSlice.ts:597 src/admin/pages/site/store/slices/site/historyPreservation.ts:5,26 src/admin/pages/site/store/slices/site/importedColorTokens.test.ts:51 src/admin/pages/site/store/store.ts:322 src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts:347 src/admin/pages/site/studio/fsCodemodAdapter.ts:619 src/admin/pages/site/studio/installDeps.ts:13 src/admin/pages/site/studio/loadedValuesBaseline.ts:228 src/admin/pages/site/studio/registerProjectModules.ts:40 src/admin/pages/site/studio/studioSaveRequests.ts:81 src/admin/pages/site/studio/studioStructuralCommits.ts:519,542,556 src/admin/state/adminEvents.ts:54 src/core/ai/captureScale.ts:35 src/core/ast-codemods/extractSubtreeToComponent.ts:3,8 src/core/ast-codemods/insertJsxIntoSlotProp.ts:4 src/core/ast-codemods/setJsxClassName.ts:6 src/core/design-tokens/colorMath.ts:4 src/core/design-tokens/index.ts:3 src/core/design-tokens/schemas.ts:5 src/core/framework-schema/schemas.ts:134 src/core/framework/colors.ts:162,530 src/core/page-parser/__tests__/insertJsxIntoSlotPropRoundtrip.test.ts:26,163 src/core/page-parser/nodeResolution.ts:50 src/core/page-parser/types.ts:261 src/core/page-tree/editConstraint.ts:13 src/core/page-tree/sourceStructure.ts:324 src/core/page-tree/sourceStructurePreview.ts:63 

#### STUDIO-IMPORT-V2-PLAN.md
.claude/agents/mcp-tooling.md:18 .claude/agents/panel-designer.md:19 .claude/agents/parser-surgeon.md:111 .claude/agents/perf-hunter.md:18 .claude/agents/security-guard.md:22 .claude/agents/studio-architect.md:3,18,55 .claude/agents/studio-scribe.md:30 CLAUDE.md:12 PROJECT-BRIEF.md:127,459 README.md:114 STUDIO-FIGMA-PARITY-PLAN.md:6 STUDIO-IMPORT-V2-PLAN.md:14,347 STUDIO-NEXT-WORKSTREAMS.md:4 docs/README.md:203 docs/agent-refs/handoff-protocol.md:135 docs/audits/2026-08-06/01-figma-fidelity.md:262 docs/audits/2026-08-06/02-design-system-authoring.md:281 docs/audits/2026-08-06/07-drag-and-drop.md:390 docs/audits/2026-08-06/08-properties-panel-design.md:9,415 docs/audits/2026-08-06/12-components-and-slots.md:262,270,520 docs/audits/penpot-inspector-baseline/05-section-heights.md:276 server/handlers/studio/componentBundle.ts:2 server/handlers/studio/componentBundleWorker.ts:15 server/handlers/studio/packageManifest.ts:2 server/handlers/studio/packageManifestSchema.ts:9 server/handlers/studio/projectProbe.ts:2 server/handlers/studio/studioMeta.ts:4 server/handlers/studio/styleCompile.ts:2 server/handlers/studio/styleCompileTier1.ts:30 server/handlers/studio/styleCompileWorker.ts:13 server/handlers/studio/tokenExtract.ts:3 src/admin/pages/site/canvas/BoardFramesLayer/frameSnapshotCache.ts:12 src/admin/pages/site/canvas/BreakpointSelectionOverlay.tsx:6 src/admin/pages/site/canvas/CanvasSelectionOverlayInjector.tsx:3 src/admin/pages/site/canvas/ProjectCssInjector.tsx:5 src/admin/pages/site/panels/PropertiesPanel/SelectorPillStack.tsx:17 src/admin/pages/site/studio/registerProjectModules.ts:2 src/core/css-codemods/setDeclaration.ts:35 src/core/module-engine/packageModuleId.ts:3 src/core/page-parser/__tests__/nextAppLayout.test.ts:2 src/core/page-parser/cssInJsExtract.ts:13 src/core/page-parser/nextAppLayout.ts:2 

#### STUDIO-LIVE-CANVAS-PLAN.md
PROJECT-BRIEF.md:130 STUDIO-FIGMA-FEEL-PLAN.md:30,32,35 STUDIO-FIGMA-PARITY-PLAN.md:55,1153 STUDIO-LIVE-CANVAS-PLAN.md:22,650 docs/README.md:206 docs/audits/2026-09-13-live-frame-memory-baseline.md:9 docs/audits/penpot-inspector-baseline/01-fixtures.md:7,10,132 docs/audits/penpot-inspector-baseline/02-measurements.md:184 docs/audits/penpot-inspector-baseline/03-operating-behaviors.md:30,93,136 docs/audits/penpot-inspector-baseline/04-token-gaps.md:20,56 docs/audits/penpot-inspector-baseline/README.md:4,60,73 docs/features/inspector.md:26 docs/features/prototype-export.md:241 server/handlers/studio/__tests__/prototypeShell.test.ts:557 server/handlers/studio/devServer.ts:10 src/__tests__/architecture/inspector-icon-toggle-enum-controls.test.ts:3 src/__tests__/architecture/inspector-icon-toggle-groups.test.ts:4 src/__tests__/panels/propertiesPanel-redesign.test.tsx:205 src/__tests__/panels/sourceConstraintNotice.test.tsx:134 src/admin/pages/site/canvas/BoardFramesLayer/framePool.ts:67 src/admin/pages/site/canvas/canvasNodeInlineStyle.ts:8 src/admin/pages/site/inspector/InspectorShell.tsx:3 src/admin/pages/site/inspector/commitApi.ts:2 src/admin/pages/site/inspector/resolveWriteTarget.ts:4 src/admin/pages/site/inspector/sections/AlignSection.tsx:4 src/admin/pages/site/inspector/sections/BlurSection.tsx:3 src/admin/pages/site/inspector/sections/ExportSection.tsx:3 src/admin/pages/site/inspector/sections/FillSection.tsx:3 src/admin/pages/site/inspector/sections/LayerSection.tsx:4 src/admin/pages/site/inspector/sections/LayoutSection.tsx:4 src/admin/pages/site/inspector/sections/MeasuresSection.tsx:4 src/admin/pages/site/inspector/sections/ShadowSection.tsx:3 src/admin/pages/site/inspector/sections/StrokeSection.tsx:3 src/admin/pages/site/inspector/sections/TextSection.tsx:3 src/admin/pages/site/inspector/sections/index.ts:2 src/admin/pages/site/inspector/selectionModel.ts:3 src/admin/pages/site/panels/PropertiesPanel/PropertiesPanelBody.tsx:176 src/admin/pages/site/panels/PropertiesPanel/SourceConstraintNotice.tsx:29 src/admin/pages/site/panels/PropertiesPanel/StyleSurface.module.css:4 src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx:6 src/admin/pages/site/property-controls/CodeValueControl.tsx:29 src/admin/pages/site/property-controls/PropertyControlRenderer.tsx:58 src/admin/pages/site/ui/ConstraintNotice/ConstraintActionButtons.tsx:4 src/admin/pages/site/ui/RefusalDialog/RefusalDialog.tsx:2 src/core/page-tree/__tests__/editConstraint.test.ts:146 src/core/studio-runtime/hmrState.ts:26 src/core/studio-runtime/messages.ts:4 src/core/studio-runtime/runtime.ts:3 src/core/studio-runtime/runtimeConfig.ts:4 

#### STUDIO-NEXT-WORKSTREAMS.md
PROJECT-BRIEF.md:127 STUDIO-FIGMA-FEEL-PLAN.md:31 STUDIO-FIGMA-PARITY-PLAN.md:29 STUDIO-NEXT-WORKSTREAMS.md:4,1752,1763,1766,1777,1796,1797 docs/README.md:204 docs/features/inspector.md:57,2124 src/core/studio-board/previewAxes.ts:15 

#### STUDIO-PROTOTYPE-PLAN.md
STUDIO-FIGMA-FEEL-PLAN.md:31 STUDIO-PROTOTYPE-PLAN.md:4,204,216 docs/README.md:207 docs/features/studio-prototype.md:565 server/handlers/studio/prototypeCodeFlow.ts:4 src/admin/pages/site/canvas/BoardFlowLayer/BoardFlowLayer.tsx:4 src/admin/pages/site/canvas/BoardFlowLayer/__tests__/flowRouting.test.ts:6 src/admin/pages/site/canvas/BoardFlowLayer/flowGeometry.ts:5 src/admin/pages/site/panels/PrototypePanel/PrototypePanel.tsx:5 src/admin/pages/site/store/slices/prototypeSlice.ts:27 src/core/studio-prototype/codeFlow.ts:3 src/core/studio-prototype/types.ts:7 

#### STUDIO-WAVE7-PLAN.md
STUDIO-FIGMA-PARITY-PLAN.md:94 STUDIO-NEXT-WORKSTREAMS.md:1797 STUDIO-WAVE7-PLAN.md:6 STUDIO-WAVE7-STATUS.md:4,45,82 docs/README.md:210 server/ai/mcp/tools/studio/qualityCheck.ts:24 server/handlers/studio/compositionAudit.ts:5 server/handlers/studio/projectThumbnail.ts:4 server/handlers/studio/qualityAudit.ts:114 server/handlers/studio/variantSeeds.ts:2 src/admin/pages/site/panels/PropertiesPanel/constraintMapping.ts:3 src/admin/pages/site/panels/PropertiesPanel/nodeExportModel.ts:3 

#### STUDIO-WAVE7-STATUS.md
STUDIO-WAVE7-STATUS.md:4,45,82 docs/README.md:210 

```

### 4c. The 52 inspector-disclosure.md references

```text
STUDIO-LIVE-CANVAS-PLAN.md:600
STUDIO-NEXT-WORKSTREAMS.md:1794
STUDIO-WAVE7-PLAN.md:47
STUDIO-WAVE7-PLAN.md:249
docs/audits/penpot-inspector-baseline/measurements.json:104
src/__tests__/admin/propertyControls/tokenizedColorField.test.tsx:3
src/__tests__/architecture/button-primitive-usage.test.ts:164
src/__tests__/architecture/inspector-icon-toggle-enum-controls.test.ts:6
src/__tests__/architecture/inspector-icon-toggle-enum-controls.test.ts:36
src/__tests__/fonts/variationAxes.test.ts:2
src/__tests__/panels/sizeSectionDensity.test.tsx:7
src/__tests__/property-controls/PropertyControlRenderer.test.tsx:226
src/admin/pages/site/canvas/canvasNodeInlineStyle.ts:7
src/admin/pages/site/inspector/sections/ExportSection.tsx:4
src/admin/pages/site/inspector/sections/FillSection.tsx:78
src/admin/pages/site/inspector/sections/FillSection.tsx:283
src/admin/pages/site/inspector/sections/LayoutSection/LayoutSettingsButton.tsx:2
src/admin/pages/site/inspector/sections/LayoutSection/PaddingCluster.tsx:5
src/admin/pages/site/inspector/sections/LayoutSection/ScrubTokenField.tsx:3
src/admin/pages/site/inspector/sections/StrokeSection.tsx:67
src/admin/pages/site/inspector/sections/StrokeSection.tsx:256
src/admin/pages/site/inspector/sections/TextSettingsPopover.tsx:6
src/admin/pages/site/inspector/sections/__tests__/boxShadowLayers.test.ts:3
src/admin/pages/site/inspector/sections/__tests__/imageFill.test.tsx:2
src/admin/pages/site/inspector/sections/boxShadowLayers.ts:4
src/admin/pages/site/inspector/sections/resolveAlignWrite.ts:4
src/admin/pages/site/panels/PropertiesPanel/SizeSection.tsx:4
src/admin/pages/site/panels/PropertiesPanel/SizeSection.tsx:9
src/admin/pages/site/panels/PropertiesPanel/SizeSection.tsx:34
src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx:11
src/admin/pages/site/panels/PropertiesPanel/__tests__/backgroundLayers.test.ts:3
src/admin/pages/site/panels/PropertiesPanel/__tests__/sizeSection.test.tsx:2
src/admin/pages/site/panels/PropertiesPanel/backgroundLayers.ts:3
src/admin/pages/site/panels/PropertiesPanel/classStyleSections.ts:49
src/admin/pages/site/panels/PropertiesPanel/elementSizing.ts:5
src/admin/pages/site/panels/PropertiesPanel/flipValue.ts:3
src/admin/pages/site/panels/PropertiesPanel/gradientValue.ts:4
src/admin/pages/site/panels/PropertiesPanel/multiSelectStyleBags.ts:23
src/admin/pages/site/panels/PropertiesPanel/styleFieldDisplay.ts:51
src/admin/pages/site/panels/PropertiesPanel/verticalAlignWrite.ts:4
src/admin/pages/site/property-controls/TokenizedColorField.tsx:119
src/admin/pages/site/property-controls/TokenizedColorField.tsx:177
src/core/fonts/variationAxes.ts:6
src/core/page-tree/cssPropertyBag.ts:47
src/core/page-tree/cssPropertyBag.ts:152
src/ui/components/AddablePropertyField/AddablePropertyField.tsx:17
src/ui/components/ColorPickerPopover/ColorPickerPopover.tsx:3
src/ui/components/ExpandableFieldCluster/ExpandableFieldCluster.tsx:5
src/ui/components/InspectorPopover/InspectorPopover.tsx:6
src/ui/components/PropertyList/PropertyList.tsx:3
src/ui/components/Section/Section.module.css:161
tests/e2e/inspector-panel-measurement.e2e.ts:295
```

## 5. Gaps in this audit

- I did not verify each of the 137 Now entries against a merged PR. I used stage lines plus plan ledgers. `gh pr list` shows 17 open drafts; confirm merge status per id before archiving.
- I did not verify CMS-REMOVAL Tier 0 progress since 2026-09-01, the PARITY §15 decisions, or standing-04.
- The docs on the in-flight branches (#204 and siblings) were read only as a diff stat plus a CLAUDE/BRIEF trust grep. Re-run this audit's greps on the integration head.
- I did not check the long feature docs (inspector, agent, studio-import, canvas-internals) line by line for staleness; they are marked current on the strength of recent scribe passes.
