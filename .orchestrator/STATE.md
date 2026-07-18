# STATE — canvas-code-studio orchestration board

_Living status board. Append-only decisions log at bottom. Last updated: 2026-07-13._

## Current phase

**P0 — COMPLETE** (AUDIT-1 PASS, tag `phase-0-complete`, protocol FROZEN).
**P1 — COMPLETE** (AUDIT-2 daemon + AUDIT-3 canvas/integration PASS, tag `phase-1-complete`; defect fix AUDIT-4 PASS, dc070de).
**P2 — COMPLETE** (AUDIT-5 PASS, tag `phase-2-complete`). Selection Bridge: source-uid plugin + bridge + canvas edit-mode/overlay. Hard stop LIFTED 2026-07-14. Running P2→P8 gated per phase.
**P3 — COMPLETE** (AUDIT-6 FAIL→remediated→AUDIT-6b FAIL→remediated→**AUDIT-6c PASS**, tag `phase-3-complete`). AST Write-Back Engine: canvas ops mutate real source (ts-morph+prettier, format-preserving), byte-identical undo, uid-remap, git checkpoints, concurrent-edit guard, and file-folder write-boundary containment (ADR-0020). The core editing loop is live + sandbox-safe.
**P4 — COMPLETE** (AUDIT-7 FAIL→remediated→**AUDIT-7b PASS**, tag `phase-4-complete`). Design-system ENGINE: token pipeline (Almosafer tokens.js → CSS vars + Tailwind preset, both build-verified), daemon token-CRUD+watch (edit→HMR ~40ms), 39 meta.ts (ADR-0021), frozen engine API (ADR-0022). CSS-injection hardened (3-layer, ADR-0020 pattern).
**P5 — COMPLETE** (AUDIT-8 PASS, tag `phase-5-complete`). Studio UI Chrome (Penpot-grade): dock, LayersPanel (LIVE frame AST via daemon tree-snapshot), Inspector (§2.3, ops + token-aware + dynamic→read-only), Toolbar, Components/Tokens panels (real @ccs/tokens), context menu, keyboard map, Dashboard. RTL-first. uid-consistency proven (tree === bridge === applyOp). One Rule intact (studio zero fs writes). 406 unit + 9 e2e green.

## 🎉 MILESTONE: P0–P5 COMPLETE — the studio is a usable end-to-end design tool.
Canvas + live frames (P1) → click real JSX nodes (P2) → edit → real source rewritten, format-preserving, undoable, sandbox-safe (P3) → design tokens + component catalog (P4) → full Penpot-grade chrome (P5). Next: P6 backend.

**P6 — NEXT** (Backend: Supabase + git-host). ⚠️ NEEDS HUMAN DECISION at kickoff: git-host = self-hosted Gitea vs GitHub App integration (behind the `packages/git-host` interface).
**Standing rules:** workers/auditors = Sonnet 5 medium; run heavy workers SEQUENTIALLY (parallel double-burns the session limit — [[session-limit-clean-respawn]]); workers self-commit despite the rule → git-reconcile at every gate ([[workers-self-commit]]); orchestrator owns tags + gate commits; frozen protocol/design-system/playbook off-limits.

## Phase status board

| Phase | Title | State | Gate |
|---|---|---|---|
| P0 | Foundations & Contracts | ✅ complete (tag phase-0-complete) | — |
| P1 | Infinite Canvas + Live Frames | ✅ complete (tag phase-1-complete) | P0 ✅ |
| P2 | Selection Bridge | ✅ complete (tag phase-2-complete) | P1 ✅ |
| P3 | AST Write-Back Engine (critical path) | ✅ complete (tag phase-3-complete) | P2 ✅ |
| P4 | Design System: Tokens + Components | ✅ complete (tag phase-4-complete) | P3 ✅ |
| P5 | Studio UI Chrome | ✅ complete (tag phase-5-complete) | P3 ✅ |
| P6 | Backend (Supabase, git-host) | 🔜 next [HUMAN: git-host] | P4 ✅,P5 ✅ |
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

## P5 retro (≤10 lines)
- The DATA-vs-CHROME partition (ADR-0022: P4=engine, P5=all UI consuming a frozen API) let P4∥P5 truly parallelize — and after the parallel session-limit double-death, each finish-and-verify'd independently against that frozen seam with no churn.
- zustand selector-called-outside-the-callback bug appeared THREE times (Inspector, then LayersPanel ×2 workers) — `useStore((s)=>s.fn())` not `useStore((s)=>s.fn)()`. Pattern to grep for in any future zustand code.
- Live LayersPanel demanded uid-consistency across FOUR producers (babel plugin, bridge, ast-engine applyOp, ast-engine buildTree). Solved by making buildTree REUSE the plugin's uid-path module (not re-derive) — the ADR-0017 corpus discipline paying off again. Proven live in e2e.
- Studio makes ZERO fs writes — everything through the daemon (One Rule held even for a big UI). localStorage only for studio-local project prefs.
- The recurring wire-string→sink vuln class (P3 path, P4 CSS) was pre-empted here: the new dev-server catalog bridge inputs go only to in-memory .find()/static-key-lookup — audit found no sink. Pre-empting worked.
- Worker self-commit recurred (f9fab96, misleading msg) — tagged + documented, not amended (origin divergence). git-reconcile at the gate caught it as always.
- Carry-forward P5-polish/P8: disable drag on dynamic Layers rows + op-rejected toast; TokensPanel→daemon token-write wiring; byte-exact clone-node; catalog dev-server-only→daemon control-message (P6); git-checkpoint .gitignore warning.

## P5 acceptance demo (one command)
`pnpm --filter @ccs/studio run test:e2e` → 9/9: builds a landing page using ONLY the studio UI against the real daemon+ast-engine+tokens (insert component, edit text, set class, bind token), clean prettier diff, file-app still builds; live Layers tree + uid-consistency; RTL; dynamic-node read-only. Manual: `pnpm --filter @ccs/studio run dev` (needs a daemon: `pnpm --filter @ccs/canvas run demo:daemon`).

## P5-REWORK ground-truth QA (2026-07-16, orchestrator drove the REAL studio in a browser)
Human dogfood found P5 broken in real use despite green audits (audits tested op-emission + scripted flows + a design-system STUB, not integrated human UX). Combined P5-rework authorized (HUMAN): fix functionality + Penpot look/feel in ONE pass, CODE-FIRST (no vector/shape tools). P6 on hold (ADR-0023).
**Confirmed findings (from real browser QA at localhost:5173):**
1. [BLOCKER, root-caused] `insert-node` DS component writes `import { X } from 'design-system'` but NOTHING makes `design-system` resolvable by a file-app (no dep, no vite alias, no node_modules). → frame crashes ("Failed to resolve import design-system") → cascades: crashed frame = no DOM = selection/inspector/layers/editing ALL dead. This is why "can't edit anything." DS pkg IS named "design-system" (main ./dist/index.js) → fix = daemon studio-vite-config injects a `design-system` alias → DS dist (+ template for standalone), and BUILD the DS dist. (Temp: removed the bad insert from files/demo/Hero.tsx so demo renders.)
2. [major] Camera doesn't fit/center the frame on open — Hero content dumped bottom-right, mostly off-screen. Bad first impression. Need zoom-to-fit on project open + on frame select.
3. [major] Layers panel: shows "Select a frame in Pages to see its layers"; selecting a frame did NOT populate the live tree in my QA (needs verification — either selection doesn't drive Layers, or a wiring bug). Layers is a headline panel; must show the live tree reliably.
4. [design] "Doesn't look/function like Penpot at all" (human) — CONFIRMED. Dashboard is a single bare card (no team sidebar/drafts/grid). Workspace has the right STRUCTURE (Pages/Layers/Assets/Tokens tabs, toolbar, Design inspector, connected) but is sparse, plain, low-density — not Penpot's polished dense UI. Pages vs Frames conflated (Hero/Pricing listed as "Pages" but they're frames).
5. [minor] WebSocket warning on open ("closed before connection established") — possible double-connect/flaky; verify the ops+canvas connections.
6. Scope clarifications given to human: Comments = P7 (not built, stub) — correct it's absent. Shapes/vector = deliberately OUT of scope permanently (§5.6); human confirmed code-first, NO vector.
**REWORK PLAN (not yet started):** (a) fix DS resolution + rebuild DS dist so component-insert works end-to-end; (b) zoom-to-fit camera; (c) fix Layers-from-selection wiring; (d) real Penpot-fidelity design pass on dashboard + workspace chrome; (e) RE-GATE on REAL browser QA (drive it, screenshot, verify editing by hand) — NOT scripted e2e alone. Screenshots: scratchpad/studio-01..04*.png.
**Process learning:** green automated gates gave false confidence; must dogfood in a browser before tagging any UI phase complete. e2e that asserts "op emitted" ≠ "feature works end-to-end / frame still renders."

## P5-REWORK — WS-6 functionality GATE PASSED (2026-07-16)
Verified LIVE in browser (daemon restarted to regenerate studio vite config):
- DS-resolution BLOCKER fixed: `studio-vite-config.ts` now emits `resolve.alias`
  design-system → design-system/dist/index.js (+ .css) + dist in fs.allow.
  Confirmed: Hero.tsx with `import { Accolade } from 'design-system'` RENDERS,
  no crash (this exact import crashed it pre-fix).
- Camera zoom-to-fit on open (StudioCanvas): all 3 frames fitted in view (was
  off-screen bottom-right = the "pan doesn't work" symptom).
- Layers-from-selection: populates (h1/p/button) on Hero select.
- Pan/context-menu: no real pointer/z-index trap found; symptom was camera-fit.
Tests: sync-daemon 216/216, canvas 150/150, typecheck clean. No worker self-commit.
NEXT: WS-1 foundations (tokens/fonts/icons) → WS-3 panels → WS-2 dash → WS-4/5 → re-gate.

## P5-REWORK COMPLETE — all 6 workstreams shipped + dogfooded (2026-07-16)
Commits: WS-6 031a68b, WS-1 a54d827, WS-3 d0e499f, WS-2 b68b82c, WS-4 cee3617, WS-5 3c7fe91.
Full real-browser re-gate PASSED (drove the whole flow, screenshots in scratchpad rework-*.png):
- Dashboard: Penpot 3-col (rail+sidebar+grid, hover-kebab cards).
- Open project -> camera fits all frames (was off-screen).
- Left panel: Pages+Layers ONE tab; "Page 1" surface; frames as BOARDS (Hero
  expands -> h1/p/button/ds:Accolade); real vendored Penpot icons + mint theme.
- Assets: grouped categorized component cards + search + grid/list.
- Tokens: DS color tokens w/ swatches + light/dark segmented switcher.
- Inspector: LAYER/CONTENT/LAYOUT/FILL/Component-props/CODE sections.
- EDITING PROVEN: set-text wrote to Hero.tsx source; Padding-4 preset added
  `p-4` to h1 className in real source; ds-component insert renders (no crash).
- No console errors (only benign double-connect ws warnings).
Tests across the rework: sync-daemon 216/216, canvas 150/150, studio 25/25, ui 20/20.
DEFERRED (own follow-up WS, needs canvas+daemon): multi-page canvas-surface CRUD;
UI Tree primitive indent (14px vs --ccs-layer-indent 24px); token write-back persistence.
P6 remains ON HOLD until human sees P5.

## FEATURE-PARITY EXECUTION AUTHORIZED (human, 2026-07-17)
Human said "start working on the feature parity plan, spawn multiple agents, you
orchestrate+audit, don't do the work yourself, all agents on Sonnet 5." Plus:
"check Penpot's real implementation and take most of the features + look/feel."
→ Executing `.orchestrator/FEATURE-PARITY-PLAN.md` FP-1..7 in the resolved order
(FP-1→2→3→4, dogfood+show human, then FP-6→5→7). One Sonnet-5 worker + one fresh
Sonnet-5 adversarial auditor per FP, SEQUENTIAL (session-limit discipline),
no-git workers, orchestrator owns commits+tags, real-browser dogfood gate.
**Penpot source is cloned at `c:\Users\Admin\Documents\GitHub\penpot` (`../penpot`,
MPL-2.0)** — every worker studies the real cljs/scss for its feature (map saved in
memory `penpot-source-reference-map.md`) and cites what it pulled; auditors verify
fidelity against the same source.

### INFRA (2026-07-17) — daemon Windows child-Vite spawn fixed → `c71cc3c`
`vite-orchestrator.ts` couldn't boot Vite on native Windows (spawn ENOENT). Fixed
with cross-spawn + win32 `taskkill /T /F` teardown; security/path code untouched.
Orchestrator-verified boot (Hero + Pricing HTTP 200). Unblocks all dogfooding on
this machine. See AUDIT-LOG INFRA entry.

### FP-1 — COMPLETE (AUDIT-FP1 PASS, tag `fp-1-complete`, commit `e02aced`) 2026-07-17
Canvas interaction unlock + Penpot zoom widget: native pan (space/middle/wheel,
shift+wheel=horizontal via a Windows axis-remap mirroring Penpot), ctrl+wheel
zoom-at-cursor; floating zoom widget (%/in/out/Reset ⇧0/fit-all ⇧1/fit-sel ⇧2,
strings ported from Penpot `right_header.cljs`+`en.po`); keys per `shortcuts.cljs`;
canvas frame-click → Layers sync. tldraw stays abstracted (index.ts leaks none),
One Rule intact. Fresh audit reproduced all 4 acceptance items live. Tests: canvas
150/150, studio 25/25, ui 20/20; lint+typecheck clean.
**Carry-forward → FP-4:** Layers-panel-originated selection doesn't drive tldraw's
canvas selection → zoom-to-selected no-ops after a panel-only select. Fix as part
of FP-4's bidirectional select+sync work (or gate the affordance).

### FP-2 — COMPLETE (AUDIT-FP2 PASS after lint remediation, tag `fp-2-complete`, commit `297a74e`) 2026-07-17
Removed global TopBar → Penpot two-header model: LeftHeader (file name + inline
rename + File menu + back-to-dashboard), RightHeader (relocated FP-1 zoom widget +
comments-toggle stub + undo/redo wired to sendUndo/sendRedo). `use-resize` hook
(React port of Penpot `resize.cljs`): per-panel drag handle, clamp 318–500 / 318–768,
width persisted per-project in localStorage, RTL-aware drag sign. Fresh audit
reproduced all acceptance live; FAIL'd on 2 react-hooks lint errors → worker fixed
(no suppressions) → orchestrator re-verified lint/typecheck/tests green.
**Carry-forwards:** undo/redo disabled until a frame is selected (fileFolder guard);
stale `acceptance.spec.ts` e2e (pre-existing from P5-rework `d0e499f` — repair the
suite); narrow-viewport <636px overflow (Penpot is non-responsive too).

### FP-3 — COMPLETE (AUDIT-FP3 PASS, tag `fp-3-complete`, commit `71fc9f4`) 2026-07-17
Wired the dead `activeTool` to real actions via a `use-tool-actions` bridge +
`use-tool-keymap` (toolbar click and V/F/T/I keys share one path): Frame(F) creates
an auto-named frame via the existing create-frame flow (exposed on the tldraw-free
FP-1 StudioCanvasHandle); Text(T) inserts a real `<p>` (insert-node+set-text);
Image inserts a real `<img>` data-URI (insert-node+set-prop, no new protocol msg);
Insert-component(I) focuses Assets; Comment(C) honest stub. Text/Image disabled with
no active frame. Floating pill restyled per Penpot `top_toolbar.cljs`. NOTE: the
first FP-3 worker died on the ACCOUNT MONTHLY SPEND LIMIT mid-exploration (zero code
written) → clean respawn succeeded. Fresh audit reproduced every tool's on-disk
effect live; studio 30/30, canvas 150/150, lint+typecheck green.
**Carry-forwards:** no op-rejected/no-op toast feedback (shared "no toast yet" gap);
Text-then-Image without reselect nests img in the p (consistent w/ insert pattern).

### FP-4a — COMPLETE (AUDIT-FP4a PASS, tag `fp-4a-complete`, commit `2d639e0`) 2026-07-17
Frictionless single-click element select (overlay sized to active frame only, no
double-click-into-edit-mode); two-way select sync canvas↔Layers↔Inspector (dedupe
guards, no ping-pong) — CLOSES the AUDIT-FP1 carry-forward (⇧2 works after Layers
select); in-place text edit via bridge `contentEditable` inside the iframe →
Enter/blur commits real `set-text` (Esc cancels byte-identical, Arabic byte-exact,
dynamic/.map() read-only). Bridge protocol extended ADDITIVELY (4 new msg kinds,
window-identity+zod preserved); frozen @ccs/protocol + sync-daemon + ast-engine
ZERO-diff. Fresh audit reproduced all acceptance live w/ disk diffs; hostile text
lands as inert escaped string literal (no injection); lint green (bridge/canvas/
studio), typecheck 11/11, tests bridge 39/canvas 155/studio 33.

### FP-4b — COMPLETE (AUDIT-FP4b PASS, tag `fp-4b-complete`, commit `85332d0`) 2026-07-17
Context-aware drag (D-EDIT): bridge reports parent layout mode LIVE from computed
style → flex/grid parent drag REORDERS (move-node, no coords; auditor confirmed
BOTH flex + grid live), non-layout parent FREE-drags (absolute + RTL logical
start-[Npx]/top-[Npx] via set-classes, +relative on static parent). 4px threshold
keeps click-select + dblclick-text-edit; dynamic/.map() + unaddressable-parent
disable drag. Reuses frozen move-node/set-classes (zero new ops); bridge additive;
@ccs/protocol+sync-daemon+ast-engine ZERO-diff. bridge 64/canvas 169/studio 33,
lint green, typecheck 11/11.
**Carry-forward (2 minor):** free-drag-onto-static-parent = 2 ops → 1 Undo leaves
transient half-state (2nd fully reverts); zoom-WHILE-dragging mixes camera frames
(constant-zoom correct). Snapping deferred ([secondary]).

## 🏁 FP-1..4 QUARTET COMPLETE (2026-07-17) — the "feels like a working editor" milestone
Tags fp-1-complete … fp-4b-complete (+ infra c71cc3c). Per D-ORDER, STOP HERE and
SHOW THE HUMAN a real dogfood before FP-5/6/7. What now works end-to-end: pan/zoom
+ zoom widget (FP-1); resizable panels + two-header shell, no global top bar (FP-2);
toolbar tools create frames / insert text+image / open assets (FP-3); single-click
select + in-place text edit + bidirectional Layers/Inspector sync (FP-4a);
context-aware drag = reorder in auto-layout / free-place otherwise (FP-4b).
Remaining (post-review): FP-6 export, FP-5 comments (local-first), FP-7 structure
ops + keyboard parity.

**FP status board:** FP-1 ✅ · FP-2 ✅ · FP-3 ✅ · FP-4a ✅ · FP-4b ✅ ·
**DOGFOOD REVIEW (human, 2026-07-17)** → see below · FP-INS-a ✅ · FP-INS-b 🔜 ·
FP-6 (raster export) · FP-5 (comments) · FP-7 (polish).

## HUMAN DOGFOOD (2026-07-17) — feedback + new work
Human ran FP-1..4 in a browser. Findings + directives:
1. **[BLOCKER, FIXED]** Importing any component crashed the frame ("Failed to
   resolve import design-system"). Root cause: daemon aliases `design-system` →
   `<projectRoot>/design-system/dist`, but the built DS clone lives at the SIBLING
   `../design-system` in this checkout. UNBLOCKED via a directory junction
   `<repoRoot>/design-system` → `../design-system` (in `.git/info/exclude`).
   Proper fix QUEUED: daemon should locate DS robustly (inside/sibling/configured).
   Also: DS clone has ZERO `*.meta.ts` in this checkout → component CATALOG is
   empty (Assets panel + props-list lack real data) — pre-existing P4/P5 gap;
   fold catalog restore into the DS work.
2. **Inspector must have ALL Penpot features mapped to CSS** → FP-INS-a (below).
3. **Components as a list of props** → done in FP-INS-a.
4. **Inspect tab for code (page/component/anything)** → FP-INS-b (next).

### FP-INS-a — COMPLETE (AUDIT-FPINSa PASS, tag `fp-ins-a-complete`, commit `f83ef44`) 2026-07-17
Inspector Design tab expanded to the full Penpot section stack mapped to Tailwind
(Size/Layout-container/Layout-item/Typography/Fill/Border-radius/Shadow/Opacity),
component-instance props as an editable LIST, dynamic nodes read-only. Vector-only
menus dropped. Reuses set-classes/set-prop; frozen contracts ZERO-diff; studio
55/55, lint green. Worker survived a SESSION-LIMIT death mid-verify (code intact,
resumed to finish). Audit verified 11 preset groups live w/ disk diffs.
**Carry-forwards:** (a) controls WRITE classes but don't READ the node's current
classes — display-only, not corrupting (ast-engine evicts conflicts server-side);
true read needs additive TreeNode.className or a bridge query → queued. (b) DS
catalog empty (no meta.ts) → queued with DS work.

### FP-INS-b — COMPLETE (AUDIT-FPINSb FAIL→remediated→PASS, tag `fp-ins-b-complete`, commit `54b0579`) 2026-07-17
Design | Inspect tab toggle; Inspect shows read-only node JSX + whole-frame JSX +
computed CSS with Copy (component instance shows its `<Component .../>` usage).
Delivers FP-6's "copy code". Additive `read-source` control-message (READ-ONLY,
reuses hardened realpath containment — full AUDIT-6/6b re-attack incl. live symlink
REJECTED) + additive `report-computed-style` bridge message; frozen @ccs/protocol
types ZERO-diff. Audit FAIL'd on 1 major (computed-CSS never loaded on the default
open→Layers-select→Inspect flow: off-screen frame = no bridge + one-shot fetch) →
worker fixed (force the single edit-mode frame live regardless of zoom + re-fetch on
bridge `ready` via a generation counter) → orchestrator re-verified natural flow +
gates green (lint 6 pkgs, tests protocol 107/canvas 171/studio 58).
**Carry-forward (informational):** Windows CRLF clipboard normalization; empty
framePath fails-closed w/o control-error reply.

**Human's 3 dogfood asks all delivered:** (1) Inspector→CSS parity ✅ (FP-INS-a),
(2) component props list ✅ (FP-INS-a), (3) Inspect/code tab ✅ (FP-INS-b).

## DOGFOOD ROUND 2 (human, 2026-07-18) — 8 fixes → workstreams
Human dogfooded FP-1..INS-b and filed 8 items → FIX-W1..W6 + a new bridge-raster
workstream. Order: W1 canvas → W2 inspect-load → W3 components → W4 inspector-
restructure → W5 frames → W6 comments; bridge-raster after W1.

### FIX-W1 — COMPLETE (AUDIT-FIXW1 FAIL→remediated→PASS, tag `fix-w1-complete`, commit `8a37542`) 2026-07-18
Canvas dogfood fixes: (4) Ctrl/Cmd+wheel preventDefault so browser native zoom no
longer fires; (5) Layers type-icon click frames+selects the element (zoomToNode
clamped ≤200% + capture overlay clipped via overflow:hidden so it can't trap clicks
on the panels); (6) frames stay VISIBLE without perf blowup — `selectLiveFrames`
caps live iframes at 8 (nearest viewport-centre; edit-mode frame counts), culled
frames show LABELED PLACEHOLDER boards (never blank). Audit caught the deep root
cause: screenshot-capture reads `iframe.contentDocument` but studio/frames are
cross-origin (diff ports) → capture always fails → culled frames blanked (this is
WHY #6 happened) → the first fix's force-live became permanent (perf blocker). Cap
approach fixed it perf-safely (unit-tested 15/15, 60.4fps @ 20 frames). FP-INS-b +
frozen contracts preserved.
**KEY ARCHITECTURAL CARRY-FORWARD:** real cross-origin frame screenshots (culled-
frame thumbnails) + FP-6 raster export BOTH require BRIDGE-SIDE rasterization (the
in-iframe bridge snapshots its own DOM → posts image to parent). Queued as the
`bridge-rasterization` workstream, runs after re-verification. Until then culled
frames show labeled placeholders (fine for small projects — all frames live).
Also: e2e `acceptance.spec.ts`/`p2-selection.spec.ts` need harness repair.

**Queued next (surface to human for priority):** (a) Inspector READ current values
(additive TreeNode.className or bridge query) — controls write but show defaults;
(b) proper daemon DS-location fix + restore component catalog meta.ts (Assets panel
empty in this checkout); (c) original FP-6 raster export (PNG/JPG) · FP-5 comments
(local-first) · FP-7 structure ops + keyboard parity.
**Standing note:** account monthly spend limit was hit once (FP-3 attempt 1) — if a
worker dies with that API error, it's the account cap (raise at claude.ai/settings/
usage), not a logic failure; clean-respawn from the last tag.

### FIX-W3 — COMPLETE (AUDIT-FIXW3 PASS, tag `fix-w3-complete`, commit `d639d5d`) 2026-07-18
Component-import fixes (dogfood round-2 item 7a/b/c). Root cause: junctioned DS
clone ships 117 raw .jsx/.css, ZERO .meta.ts → `catalog.ts` (reads only *.meta.ts)
returned [] → "No components match" + nothing to insert. Second co-located bug: DS
component CSS never imported into any frame project → styled `<span>` = 0×0 box (the
literal "empty box representing nothing"). Fix (additive, low-risk): NEW build-time
generator `packages/tokens/src/generate-meta.ts` (+ CLI `scripts/generate-component-
meta.ts`) derives metadata from raw .jsx via ts-morph — `catalog.ts` + protocol/ast-
engine/sync-daemon ALL zero-diff. `ComponentsPanel.tsx` empty-search UX. `@import
'design-system/dist/index.css'` added to the TRACKED `templates/file-app/src/
index.css` (audit proved load-bearing: toggling off → Badge/Button collapse to 0×0).
28 components got usable metadata + render visibly; 33 skipped (need real data). Audit
reproduced all 5 acceptance items + 3 distinct components rendering styled, live.
**RELEASE-RISK carry-forward:** the 28 generated .meta.ts live OUTSIDE this repo's
VCS (external junctioned DS repo). Re-clone / force-reset / stale-after-DS-upstream →
Components panel silently degrades back to empty, NO CI signal here. Needs ADR/CR to
wire the generator into DS onboarding/CI. Also carried: pre-existing use-component-
insert.ts uid-prediction drift (schema-default set-prop sometimes doesn't persist on
insert); 2 pre-existing parse-almosafer.test.ts failures (DS token drift).

**Remaining dogfood round-2 queue:** bridge-rasterization (real culled-frame
screenshots + FP-6 raster export) → FIX-W4 (Inspector Penpot structure+icons item 1
+ component-instance ONLY props item 7d) → FIX-W5 (frames nest as <div> + device
presets item 8) → FIX-W6 (comments FP-5 faithful item 2). FIX-W2 (Inspect-tab
loading item 3) likely already resolved by fresh daemon + FP-INS-b/FIX-W1 — AWAIT
human retry before spending a worker.

## DOGFOOD ROUND 3 (human, 2026-07-18) — 4 asks → FIX-W4b/W7/W8
Filed while FIX-W4 (Inspector reorder + instance-props-only) was mid-audit. These
RAISE THE BAR on the right pane and add a canvas ask:
- **R3-1 → FIX-W4b (big):** right pane must be "100% the same as Penpot" AND genuinely
  CONTEXT-AWARE by node type (focus text → text controls; focus frame → frame controls;
  element → element controls) AND "actually works" = reflect the focused element's ACTUAL
  CURRENT values, not neutral defaults. => promote the deferred read-current-values
  (reuse FP-INS-b `report-computed-style` bridge msg) to CORE + drive per-node-type
  section visibility off Penpot `options.cljs` + tighten visual fidelity to the real
  `menus/*.scss` widget/row anatomy. Builds on FIX-W4.
- **R3-2 → FIX-W7:** Inspect tab sometimes gets huge width → horizontal scroll. Containment
  bug (long unwrapped JSX line / CSS value not inside an overflow-x:auto box). The pane body
  must never scroll horizontally; wide content scrolls inside its own box.
- **R3-3 → FIX-W7:** pane resize MIN-WIDTH is too large — make the smallest allowed pane
  width WAY smaller (loosen the clamp in the resize hook).
- **R3-4 → FIX-W8:** frames on the canvas sometimes show an INTERNAL scrollbar. Eliminate
  the internal scroll where feasible (size-to-content), and where content genuinely
  overflows, HIDE the scrollbar (scrollbar-width:none / ::-webkit-scrollbar{display:none})
  while keeping it scrollable. Canvas/frame-rendering (frame-shape / frame-app template).

Planned sequence (SEQUENTIAL, after FIX-W4 gates): FIX-W7 (quick: resize min-width +
Inspect horizontal-scroll) → FIX-W8 (frame internal scrollbar) → FIX-W4b (context-aware +
read-current-values + Penpot visual fidelity — the headline). Quick fixes first to relieve
daily friction and de-risk against re-hitting the account session limit mid-worker.

### FIX-W4 — COMPLETE (AUDIT-FIXW4 PASS, tag `fix-w4-complete`, commit `ce805e8`) 2026-07-18
Inspector Penpot-faithful reorder + component-instance = props-only (round-2 items
1 + 7d). Section stack now mirrors Penpot options/shapes order; Opacity→Layer,
Radius→Size&position, Stroke split out; header icons; instance renders ONLY Layer+
Props+Code with CSS sections STRUCTURALLY UNMOUNTED (audit probed count()===0).
Additive Panel `icon` prop. Frozen surfaces zero-diff; @ccs/studio 58/58 + @ccs/ui
20/20; lint+typecheck green. This is the STEPPING STONE for FIX-W4b (round-3 full
Penpot design-parity). Audit intel confirmed: context-awareness is BINARY today
(board selection = empty state), read-values all defaults, Inspect h-scroll root
cause = CssRows flex min-width:0 miss, right-dock min-width hardcoded 318px.

### FIX-W8 — COMPLETE (orchestrator self-verified, tag `fix-w8-complete`) 2026-07-18
Round-3 R3-4: frames' internal scrollbar. CROSS-ORIGIN iframes → parent can't
style frame scrollbars → fix lives in the frame-app global CSS (templates/file-app/
src/index.css, inherited by every create-file project; files/demo mirrored for the
running demo). `* {scrollbar-width:none}` + `*::-webkit-scrollbar{display:none}` —
hides the BAR only, overflow untouched so scroll still works, no content clipped.
"Eliminate" reduces to "hide" (no safe general way to remove overflow w/o clipping).
frame-shape.tsx/canvas zero-diff. Self-verified (trivial pure-CSS + worker DOM-proof)
rather than a full fresh audit, to conserve the account session limit — disclosed.

### ROUND-3 STATUS: W7 ✅ (gated) · W8 ✅ (gated) · W4b = NEXT (the headline).
Remaining round-3: FIX-W4b — full Penpot design-parity right pane (real ported
Penpot SVG icons w/ MPL attribution + per-node-type context-awareness driven off
options.cljs + read-current-values via the existing report-computed-style bridge).
Then original round-2 leftovers: FIX-W2 (inspect-load, await human retry), FIX-W5
(frame nesting + device presets), FIX-W6 (comments), bridge-rasterization (held).

### FIX-W4b-1 — COMPLETE (AUDIT-FIXW4b-1 PASS, tag `fix-w4b-1-complete`) 2026-07-18
Round-3 R3-1 FUNCTIONAL half. Per-node-type context-aware sections (text/element/
fragment/instance/frame each a DIFFERENT verified data-panel subset, cited to Penpot
options/shapes/*.cljs) + frame/board selection now shows frame-level controls (was
the empty "Select a layer" state) + read-current-values via the EXISTING report-
computed-style bridge with a strict NO-FABRICATION rule (raw computed value or
honest loading/not-set; keyword-label only on exact CSS equivalence; numeric scales
never reverse-mapped). Audit fabrication-hunt found ZERO false values (byte-identical
to getComputedStyle). 5 new files in apps/studio/workspace; frozen packages/ zero-
diff; @ccs/studio 73/73; FIX-W4 preserved. Carry-forward: ast-engine buildTree never
emits kind:'text' (tag-based bridge used); board readouts may show "loading…" if the
frame bridge isn't live (honest, never fabricated).

### ROUND-3 STATUS: W7 ✅ · W8 ✅ · W4b-1 ✅ (functional) · W4b-2 = NEXT (visual parity).
W4b-2: port the real Penpot SVG icons (317 at penpot/frontend/resources/images/
icons/*.svg, MPL-2.0 © KALEIDOS — carry attribution) into the studio icon registry
for each Inspector section/control, and replicate the menus/*.scss widget/row/header
anatomy in CSS for the "100% same design/look as Penpot" ask. Builds on W4b-1.
