# STATE — canvas-code-studio orchestration board

_Living status board. Append-only decisions log at bottom. Last updated: 2026-07-13._

## Current phase

**P0 — COMPLETE** (AUDIT-1 PASS, tag `phase-0-complete`, protocol FROZEN).
**P1 — COMPLETE** (AUDIT-2 daemon + AUDIT-3 canvas/integration PASS, tag `phase-1-complete`; defect fix AUDIT-4 PASS, dc070de).
**P2 — COMPLETE** (AUDIT-5 PASS, tag `phase-2-complete`). Selection Bridge: source-uid plugin + bridge + canvas edit-mode/overlay. Hard stop LIFTED 2026-07-14. Running P2→P8 gated per phase.
**P3 — NEXT** (AST Write-Back Engine, the critical path).

## Phase status board

| Phase | Title | State | Gate |
|---|---|---|---|
| P0 | Foundations & Contracts | ✅ complete (tag phase-0-complete) | — |
| P1 | Infinite Canvas + Live Frames | ✅ complete (tag phase-1-complete) | P0 ✅ |
| P2 | Selection Bridge | ✅ complete (tag phase-2-complete) | P1 ✅ |
| P3 | AST Write-Back Engine (critical path) | 🔜 next | P2 ✅ |
| P4 | Design System: Tokens + Components | ⬜ not started | P3 |
| P5 | Studio UI Chrome | ⬜ not started | P3 |
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
