# STATE — canvas-code-studio orchestration board

_Living status board. Append-only decisions log at bottom. Last updated: 2026-07-13._

## Current phase

**P0 — COMPLETE** (AUDIT-1 PASS, tag `phase-0-complete`, protocol FROZEN).
**P1 — COMPLETE** (AUDIT-2 daemon + AUDIT-3 canvas/integration PASS, tag `phase-1-complete`; defect fix AUDIT-4 PASS, dc070de).
**P2 — COMPLETE** (AUDIT-5 PASS, tag `phase-2-complete`). Selection Bridge: source-uid plugin + bridge + canvas edit-mode/overlay. Hard stop LIFTED 2026-07-14. Running P2→P8 gated per phase.
**P3 — COMPLETE** (AUDIT-6 FAIL→remediated→AUDIT-6b FAIL→remediated→**AUDIT-6c PASS**, tag `phase-3-complete`). AST Write-Back Engine: canvas ops mutate real source (ts-morph+prettier, format-preserving), byte-identical undo, uid-remap, git checkpoints, concurrent-edit guard, and file-folder write-boundary containment (ADR-0020). The core editing loop is live + sandbox-safe.
**P4 — COMPLETE** (AUDIT-7 FAIL→remediated→**AUDIT-7b PASS**, tag `phase-4-complete`). Design-system ENGINE: token pipeline (Almosafer tokens.js → CSS vars + Tailwind preset, both build-verified), daemon token-CRUD+watch (edit→HMR ~40ms), 39 meta.ts (ADR-0021), frozen engine API (ADR-0022). CSS-injection hardened (3-layer, ADR-0020 pattern).
**P5 — IN PROGRESS** (studio CHROME): chrome BUILT + green + committed (WIP), NOT yet gated.

## ⏸ SESSION PAUSED 2026-07-15 — P5 RESUME HERE
**Last committed:** `f9fab96` (tag `phase-5-wip-checkpoint`). ⚠️ Its commit MESSAGE ("feat: add new UI primitives…") is a WORKER SELF-COMMIT (recurring [[workers-self-commit]]) and UNDERSELLS its content — f9fab96 actually contains the FULL P5 chrome + ast-engine `buildTree`: `apps/studio` (37 files: dock, LayersPanel, Inspector, Toolbar, Components/Tokens panels, context menu, keyboard, Dashboard, e2e), `packages/ui` (19: Penpot-grade RTL primitives), `packages/ast-engine` (4: additive `buildTree`), pnpm-lock. Clean scope (NO frozen-protocol/tokens/daemon files). Not amended (origin/main divergence → avoided history rewrite). Tags: phase-0..4-complete + phase-3-wsA-checkpoint + phase-5-wip-checkpoint.
**Verified green at pause:** ast-engine 150/150 (140 + 10 new buildTree), studio 24/24, ui 16/16, apps/studio e2e 9/9 (real daemon+ast-engine+tokens), monorepo typecheck 12/12. tldraw watermark intact. Real `@ccs/tokens` wired (39 DS components + token sets) via a dev-server catalog bridge. Two critical bugs fixed (Inspector zustand-selector never re-rendered; LayersPanel root-node hid layers).
**REMAINING to reach `phase-5-complete` (in order):**
1. **daemon `tree-snapshot` emission — NOT STARTED.** LayersPanel/Inspector currently read a TreeNode FIXTURE (`apps/studio/src/engine/tree-fixtures.ts`), NOT the live frame AST. The additive `ast-engine buildTree(sourceText, relPath): TreeNode` is DONE + green (reuses canonical uid-path, ADR-0017). Wire the daemon: on frame change/open → `buildTree` → broadcast frozen `{t:'tree-snapshot', file, tree}` (debounce HMR bursts). (This is the task that was mid-spawn when paused.)
2. **studio: swap fixture → live tree-snapshot** (isolated behind `workspace-store.currentTree()`/`selectedNode()` — a one-function swap); e2e test (b) should assert the LIVE tree matches the real frame; verify tree uid === bridge selection uid === applyOp target.
3. **P5 gate:** fresh adversarial audit → tag `phase-5-complete` + retro. (Watch the recurring "wire-controlled string → sink" vuln class + do the standard One-Rule/boundary/security scan.)
**P5 carry-forwards surfaced by workers (for P6/P8):** catalog reads are DEV-SERVER-ONLY (Vite middleware `/__ccs/catalog/*`) — no production/static path; right fix = a daemon control-message (daemon is sole fs-reader). Local projects registry (`~/.studio/projects.json`), lock/hide persistence into canvas.json, byte-exact clone-node primitive — all need daemon APIs (P6). 39 meta.ts live untracked in the external design-system repo (versioning home TBD).
**Then P6** (Backend) — needs HUMAN git-host decision (Gitea vs GitHub App).
**Standing rules:** workers/auditors = Sonnet 5 medium; run heavy workers SEQUENTIALLY (parallel double-burns the session limit — [[session-limit-clean-respawn]]); workers self-commit despite the rule → git-reconcile at every gate ([[workers-self-commit]]); orchestrator owns tags + gate commits; frozen protocol/design-system/playbook off-limits.

## Phase status board

| Phase | Title | State | Gate |
|---|---|---|---|
| P0 | Foundations & Contracts | ✅ complete (tag phase-0-complete) | — |
| P1 | Infinite Canvas + Live Frames | ✅ complete (tag phase-1-complete) | P0 ✅ |
| P2 | Selection Bridge | ✅ complete (tag phase-2-complete) | P1 ✅ |
| P3 | AST Write-Back Engine (critical path) | ✅ complete (tag phase-3-complete) | P2 ✅ |
| P4 | Design System: Tokens + Components | ✅ complete (tag phase-4-complete) | P3 ✅ |
| P5 | Studio UI Chrome | 🟡 chrome built+green (tag phase-5-wip-checkpoint); live-tree + gate remain | P3 ✅ |
| P6 | Backend (Supabase, git-host) | ⬜ not started | P4,P5 |
| P7 | Presence + Comments | ⬜ not started | P6 |
| P8 | Hardening + Polish | ⬜ not started | P7 |

Dependency graph: `P0 → P1 → P2 → P3 → {P4, P5} → P6 → P7 → P8`.

## Standing spawn rules

- **All workers AND auditors run on Sonnet 5** (`model: sonnet`), medium effort — human directive 2026-07-13. Keep tasks tightly scoped to fit that budget.

## Open workstreams / agent assignments

- **P1 / sync-daemon** — worker COMPLETE + AUDIT-2 PASS. Vite-per-folder, loopback ws, chokidar, atomic geometry writes; 62+9 real tests; wire format frozen (ADR-0013). Committed as 85c8900 (worker self-committed — see learning). Carry-forward minors: empty .studio dir on shutdown; e2e (e) soft-skip.
- **P1 / canvas** — worker COMPLETE (no-git rule respected ✅). All 4 acceptance met; perf 20 frames ~117fps avg (gate: 60fps) ✅; 98 unit + 4 e2e green; tldraw abstracted, watermark per ADR-0005. 2 interface gaps → ADR-0014.
- **P1 / integration** — worker STALLED at ~95% (watchdog, not logic fail); protocol+daemon typecheck clean, only `onControlReply` wiring in StudioCanvas + a test left. Finish-and-verify worker dispatched. daemon `create-frame`/`get-canvas-json` + additive protocol/control-messages.ts + canvas client all present.
- **P0 / infra** — COMPLETE (AUDIT-1 PASS, tag phase-0-complete).
- Topology (playbook §6): infra, canvas, ast, tokens-ds, chrome, platform, qa.
- Sequencing: P3 golden suite is the critical path — staff ast first/heaviest; scaffold golden suite during P2.

### Carry-forward into later phases (from P0 CRs)
- **P2/P5:** confirm the frozen `TreeNode` shape before building (ADR-0009).
- **P4:** token pipeline parses Almosafer DS format, DTCG = interop (ADR-0010); Almosafer DS is untyped `.jsx` w/o metadata → prop-extraction needs JS fallback + meta strategy, decide at P4 kickoff, flag to human (ADR-0011).
- **P7:** may additively extend `FrameMeta.comments` (ADR-0009).

## ✅ HARD STOP LIFTED (human, 2026-07-14)
Prior instruction "stop when Phase 1 is done" was satisfied and then **lifted** — human said "continue with the rest of the phases". Now authorized to run P2→P8, **gated per phase** (worker → git-reconcile → fresh adversarial audit PASS → tag `phase-<n>-complete` + retro → next). Surface human-decision points as they arrive: P4 = Almosafer DS untyped `.jsx` prop-extraction strategy (ADR-0011); P6 = git-host choice (gitea vs GitHub App); tldraw license before launch (ADR-0005). None block P2/P3.

## Blockers (owner)

1. **[HUMAN] tldraw license decision.** SDK ≥4.0 needs a license key for production; watermark-free = $6,000/yr Business License. Options: (a) buy Business License, (b) ship with "made with tldraw" watermark under Hobby/Trial, (c) invoke the `packages/canvas` custom-camera fallback (§5.4, ~2–4 wks). Blocks P1 completion, not P0 start. See DECISIONS ADR-0005.
2. **[HUMAN] design-system source decision.** A real Almosafer Design System (`tajawal/design-system`) is already present in the working dir. Use it as the project's live `design-system/` (its tokens/components) vs. the playbook's generic scaffold? See DECISIONS ADR-0006.
3. **[HUMAN] go/no-go to begin P0 worker spawn.** P0 is the first real code-writing commitment.

## Verified facts (2026-07-13, from npm registry + tldraw.dev)

- tldraw **5.2.4** · ts-morph **28.0.0** · vite **8.1.4** · @supabase/supabase-js **2.110.2**
- Full rationale + pins in DECISIONS.md ADR-0001..0004.

## Discovered assets

- `design-system/` = clone of `github.com/tajawal/design-system` (Almosafer DS): tokens, components, icons, `mcp/` server, `design.md`, `CLAUDE.md`. Own git repo. NOT yet wired to anything.

## Phase acceptance demo commands

_(one-command demo per phase recorded here as phases complete)_

- P0: `pnpm create-file demo && pnpm dev` → template app serves standalone. _(pending)_

## Decisions log (append-only, dated)

- **2026-07-13** — Read playbook fully; it is the constitution. Created .orchestrator scaffolding.
- **2026-07-13** — Verified live versions from npm registry (not memory), per Step 0 mandate. Recorded ADR-0001..0004.
- **2026-07-13** — Flagged tldraw licensing ($6k/yr or watermark) to human (ADR-0005) — cost/license implication, out of my autonomous authority.
- **2026-07-13** — Flagged presence of real Almosafer DS in working dir (ADR-0006) — affects P4 scope.
- **2026-07-13** — Gating before P0 worker spawn; reported status board to human.

## P0 retro (≤10 lines)
- Worker delivered clean, self-audited honestly, disclosed every divergence as a CR — high trust; keep this worker profile.
- The real Almosafer DS being untyped `.jsx` w/o metadata is the biggest downstream surprise (ADR-0011) — surface to human at P4 kickoff, not later.
- Protocol froze cleanly; TreeNode/FrameMeta item shapes were underspecified in the playbook — pre-specify cross-boundary interfaces BEFORE spawning (did this for P1 via ADR-0012).
- Change for P1 prompts: give workers an independently-demonstrable sub-acceptance so serialized coupled workstreams each prove something alone.
- Watch: TS pinned to ^6.0.3 (not 7.x) due to typescript-eslint peer crash — revisit when tseslint supports TS7.

## P1 retro (≤10 lines)
- Serializing coupled workstreams (daemon→canvas) paid off: each proved a sub-acceptance alone; integration risk stayed low.
- Pre-freezing the daemon↔canvas wire format (ADR-0012/0013) BEFORE spawning meant zero interface churn between the two workers.
- One worker stalled (watchdog) at ~95%; a tight "finish-and-verify" respawn recovered it cheaply — cheaper than resuming a stalled agent.
- Interface gaps (create-frame/get-canvas-json) surfaced late; folding them into ADR-0014 kept the daemon as sole fs-writer — worth blocking the tag for.
- .orchestrator/DECISIONS.md was silently truncated by an external edit (lost ADR-0014 once); AUDIT-3 caught it. LESSON: re-grep the ADR is present after each append; auditors reading the doc are a good backstop.
- Perf gate smashed (118fps vs 60); had to tighten a too-loose CI guard (>24→>50) so the gate actually guards.
- Change for P2 prompts: keep the "run NO git commands" rule (it worked); keep verifying git tree + ADR presence at every gate.

## P1 acceptance demo (one command)
`pnpm --filter @ccs/canvas run test:e2e`  → drives real daemon+canvas: (a) HMR<1s (b) drag→canvas.json (c) new-frame via daemon API (d) 20 frames ~118fps. Manual: `pnpm --filter @ccs/canvas run demo:daemon` + `demo:harness`, open http://127.0.0.1:5555/?daemonPort=4700

## Note on P1 git history
- `phase-1-complete` = commit `bcf884f` (verified state: typecheck/lint/test 12/12, e2e 4/4, tree clean).
- P1 history = `8fa895c` (canvas, worker self-committed again despite hardened no-git rule) + `bcf884f` (gate commit: integration + protocol-additive + orchestrator docs). Cumulative diff phase-0-complete..HEAD is in-scope (packages/{canvas,protocol,sync-daemon} + config + .orchestrator). Not rewriting history; see memory [[workers-self-commit]].

## P2 retro (≤10 lines)
- Pre-freezing BOTH the data-uid derivation AND the full bridge postMessage contract (ADR-0016) before spawning again gave zero interface churn across the A→B serialization — the P1 lesson keeps paying.
- The standalone-contract constraint (templates stay zero-@ccs) forced the right architecture: daemon layers instrumentation in at studio-boot via an ephemeral merged Vite config; file-app template never changed. Proven live by a boot-with/without diff test.
- Converting the "shared derivation module" ideal (impossible across babel vs ts-morph) into a golden CONFORMANCE CORPUS (ADR-0017) is the durable fix — P3's ts-morph resolver must pass byte-identical uids or a test fails.
- WS-B caught two real bugs by RUNNING not inspecting: capture-overlay swallowing wheel events (broke pan/zoom in edit mode) and a camera-animation race. "Drive the real thing" in acceptance is worth the e2e cost.
- Session limits bit again: WS-B died once at ~0 code, clean respawn with an efficiency preamble succeeded. Cheap because the tree was clean (no partial state to reconcile).
- Cross-origin reality: iframes never deliver DOM events to the parent → hit-testing MUST be a parent-owned capture overlay + postMessage. Good that the frozen bridge protocol already assumed this.
- Carry-forward: bridge targetOrigin '*' → tighten to exact origin + doc "identity-based" (P8); e2e (a) should pre-warm Vite deps before the HMR timing assert (flaky cold-start); watcher.test.ts deflake (P8).

## P2 acceptance demo (one command)
`pnpm --filter @ccs/canvas run test:e2e` → 11/11 (5 P1 + 6 P2) against a real studio-mode daemon. Manual: `pnpm --filter @ccs/canvas run demo:daemon` + `demo:harness`, open http://127.0.0.1:5555/?daemonPort=4700, double-click a frame → hover/click nodes → breadcrumb + lock badges. NOTE: the demo harness now opens with `studioMode:true` (data-uids + bridge injected).

## P3 retro (≤12 lines — the critical path)
- Serialize A→B held again: ast-engine (pure, zero-IO, huge golden+property suite) proven ALONE, then daemon wiring on top. Pre-freezing applyOp/ApplyOpError/uidRemap (ADR-0018) → zero interface churn.
- The ADR-0017 conformance corpus (ts-morph uids == babel plugin uids, byte-identical) paid off — no silent addressing divergence.
- **Property tests are the MVP of this phase.** ast-engine's caught 5 bugs pre-audit; the fix worker's strengthened property test (after removing a try/catch that SILENTLY SWALLOWED uid-not-found) caught 4 MORE invert bugs incl. a forward-path moveNodeRemap bug. Lesson: a property test that catches its own failures is worthless — never swallow the assertion.
- **The gate earned its keep.** 3 adversarial rounds on ONE boundary: AUDIT-6 found lexical path-traversal arbitrary-write (blocker); AUDIT-6b found symlink-escape (I'd wrongly hand-waved symlinks as unreachable — fresh eyes corrected my blind spot); AUDIT-6c confirmed closed. NEVER let authors self-certify a security boundary.
- Fix at the trust boundary, not the schema: containment lives in the sole-fs-writer daemon (ADR-0020), protocol stayed frozen.
- Clean-respawn (memory [[session-limit-clean-respawn]]) worked: WS-B died at session close, discarded partial, fresh respawn succeeded cheaply.
- Cost of the phase: 8 workers (WS-A, WS-B, ast-fix, 3 audits, 2 security fixes). Heavy but correct — this is the one component that writes users' real files.
- Carry-forward P8: TOCTOU O_NOFOLLOW write hardening; deflake watcher.test.ts + vite-orchestrator.test.ts (now occasionally flake isolated). P6: `.studio/canvas.json` excluded from checkpoints (frame-layout not in restore history — decide before "restore checkpoint" UX). P4: ds-component insert doesn't default required props + `{token}` set-prop = `unsupported` (needs token/type pipeline).

## P3 acceptance demo (one command)
`pnpm --filter @ccs/sync-daemon exec vitest run src/e2e-500-ops.test.ts` → 500 random ops through the REAL control-ws → app still typechecks + `vite build`s → all 500 undone byte-identical. Plus `pnpm --filter @ccs/ast-engine test` (140 tests / 66 golden) + `pnpm --filter @ccs/sync-daemon exec vitest run src/safe-path.test.ts src/op-apply.test.ts` (containment + symlink-escape rejection).

## P4 retro (≤10 lines)
- HUMAN chose manual meta.ts; the win was authoring them FROM the DS's own Code Connect (.figma.tsx, 29/39) + .jsx defaults → accurate, not guessed. ADR-0011's "untyped, no metadata" fear was overblown (Code Connect existed).
- Recurring vuln class struck again: wire-controlled string → sensitive sink unsanitized (P3: uid→fs path; P4: token key/value→CSS). Fresh adversarial audit caught it; fixed with the same defense-in-depth (boundary validate + sink fail-closed). PATTERN to pre-empt in P6+ (any new wire input).
- Parallel P4∥P5 double-burned the session limit → both died. Switched to SEQUENTIAL finish-and-verify; recovered the substantial partials cheaply (they died on limit not error → coherent). Memory [[session-limit-clean-respawn]] updated.
- ts-morph returns QUOTED text for string-literal object keys → corrupted `'2xl'` token names; caught by finish-worker. Watch for this in any ts-morph key handling.
- Orchestrator preset-verification mattered: an auditor's "preset broken" was actually Tailwind JIT (utilities only emit when used) — I build-tested it myself before gating rather than trust OR dismiss. Verify contested claims directly.
- Carry-forward: emit-tailwind-preset sink sanitization (non-exploitable, P8); demo frames use stock slate/sky not DS tokens (showcase gap, P5/P8); 39 meta.ts untracked in the external design-system repo (versioning home TBD, P6/P8).

## P4 acceptance demo (one command)
`pnpm --filter @ccs/tokens test` (112) + `pnpm --filter @ccs/sync-daemon exec vitest run src/token-crud.test.ts` (20, incl. CSS-injection rejection). Live loop: regen `files/demo`, add `bg-aqua-100` to a frame → `vite build` → output CSS has `.bg-aqua-100{background-color:var(--color-aqua-100)}`; edit that token via daemon control-ws → HMR ~40ms.
