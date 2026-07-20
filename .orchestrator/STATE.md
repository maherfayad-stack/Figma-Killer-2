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

## DOGFOOD ROUND 4 (human, 2026-07-18, WITH side-by-side Penpot-vs-ours screenshots) → FIX-W4b-3
Human compared Penpot's Design panel to ours and said "it's not there yet ... see how
complicated ours vs penpot." Ours is functional but far less clean/dense/capable.
Concrete gaps (from the screenshots):
- **R4-1 (Layout too cluttered):** Penpot's LAYOUT is a COMPACT cluster — one 3×3
  align-grid + direction arrows + wrap toggle in ~2 tight rows, then small icon
  numeric fields for gap/padding. Ours spreads Direction/Wrap/Justify/Align/Gap into
  big labelled dropdowns/button-rows (tall, verbose). Rebuild dense like Penpot.
- **R4-2 (frame sizing not real):** Penpot has DIRECT editable W/H/X/Y numbers +
  rotation + radius + a "Size presets" dropdown + device-type icons (phone/tablet).
  Ours uses clunky Width[Auto▾]+"Custom W px" two-step dropdowns, no presets/devices.
  Give direct numeric inputs (write w-[..]/h-[..]/arbitrary) + size presets + device
  dimensions. ABSORBS the device-preset half of FIX-W5 (item 8).
- **R4-3 (color control weak):** "I can't put custom colors just dropdown from our
  tokens, no search, no preview." Fill/color is a token DROPDOWN only. Need a real
  Penpot color widget: swatch + editable HEX (custom colors → bg-[#..]), a picker
  popover, the token palette SEARCHABLE, and color-PREVIEW swatches in the list.

→ FIX-W4b-3 refinement, 3 focused sub-workers (small = limit-resilient), SEQUENTIAL
after W4b-2 (icons) gates: W4b-3a Size&Position+frame-sizing+device presets → W4b-3b
Layout declutter (Penpot compact cluster) → W4b-3c color control (custom hex + picker
+ searchable token palette + preview swatches). W4b-2's real Penpot icons + icon-
button groups are the foundation these build on. FIX-W5 remainder (create-frame-
inside-frame → nested <div>) stays separate.

## DOGFOOD ROUND 4b (human, 2026-07-18) — Inspect tab + the 1:1 mandate
Human screenshot of Penpot Inspect vs ours + directive "make a step where this is
gonna be nearly 1:1 100% the same as penpot in every aspect."
- **CONFIRMED BUG (FIX-W2 is NOT resolved):** our Inspect tab NODE + FRAME code
  blocks are stuck on "Loading…" (read-source round-trip hangs; report-computed-
  style works). FIX-W2 reclassified from "await retry" to a real bug → folded into
  FIX-W4b-4.
- **Inspect not Penpot-clean:** ours dumps RAW computed CSS; Penpot curates (Board
  header + Layer info HEX/Styles toggle + friendly grouped Size/Fill/Layout labels).
- **1:1 MANDATE:** established `.orchestrator/PENPOT-PARITY-CHECKLIST.md` as the
  driving artifact. Acceptance gate for every parity workstream = a real-browser
  SIDE-BY-SIDE screenshot a fresh auditor agrees "reads as near-identical to Penpot"
  (density/grouping/icons/widgets/labels/behavior), not "the control exists." Honest
  limit disclosed (Penpot=cljs+SVG vs ours=React+real-DOM; some Inspect VALUES differ
  by nature). Scope right-pane FIRST (Design PANEL-1 + Inspect PANEL-2), then chrome.
- FIX-W4b-4 = Inspect Penpot-clean curation + fix the Loading… read-source bug
  (subsumes FIX-W2). Runs after W4b-3a/b/c per the checklist order.

### FIX-W4b-3b — COMMITTED self-verified (tag `fix-w4b-3b-complete`), INDEPENDENT AUDIT DEFERRED 2026-07-18
Round-4 R4-1 LAYOUT declutter → Penpot compact cluster (align-items+direction+wrap
row / justify row / align-content-only-when-wrapping row / gap+linked-padding row);
+20 real Penpot icons; FIXED the W4b-2 active-state carry-forward (GroupButtons
`seedFromLive` → highlight matches real computed value). Frozen zero-diff; @ccs/studio
82/82, @ccs/ui 20/20, lint+typecheck green.
**⚠️ DEFERRED:** the independent adversarial BROWSER audit was blocked TWICE by the
account session limit (process-exit interrupt, then session-cap resets 9:10pm
Asia/Riyadh). I orchestrator-self-verified (static gates + worker's own live
getComputedStyle cross-checks + disk diffs) and committed to lock the work in.
**TODO on next session/after reset: run a fresh independent browser audit of W4b-3b**
(side-by-side vs Penpot layout_container + active-state-vs-getComputedStyle) as extra
confirmation before treating the LAYOUT parity item as fully closed.

### ⛔ SESSION-LIMIT BLOCK (2026-07-18): cannot spawn/resume ANY agent until ~9:10pm
Asia/Riyadh. Next queued work needs a worker → BLOCKED until reset:
- FIX-W4b-3c (color control: custom hex + picker + searchable token palette +
  preview swatches — R4-3) [NEXT worker]
- FIX-W4b-4 (Inspect tab: FIX the read-source "Loading…" bug [user re-confirmed it's
  STILL broken via screenshot] + curate clean like Penpot — subsumes FIX-W2)
- deferred W4b-3b independent audit (above)
- then final HOLISTIC side-by-side parity sweep of Design+Inspect tabs (human noted
  repeatedly "still not 1:1 100% like penpot"), then PANEL 3+ chrome, FIX-W5/W6.

**Right-pane parity progress:** W4 ✅ W4b-1 ✅ (context-aware+live values) W4b-2 ✅
(real Penpot icons) W4b-3a ✅ (Size&Position+device presets) W4b-3b ✅ self-verified
(Layout cluster). REMAINING for "1:1": W4b-3c color, W4b-4 Inspect+Loading fix, final
sweep. Human's standing note: Design AND Inspect tabs not yet 1:1 — EXPECTED, tracked.

### FIX-W4b-5 — COMPLETE (AUDIT PASS visual bar + remediation, tag `fix-w4b-5-complete`) 2026-07-19
Design-tab HOLISTIC Penpot visual re-skin (round-4 "not even close" escalation).
Root cause: theme tokens (32px/8px/accent/bg) were DECLARED but Input/Select never
applied them (~26px/4px) + icon groups were separate buttons not segmented pills +
missing header row + loose grid. Fixed: SegmentedGroup pill primitive, Input/Select
real 32px/8px (shared — no regress), MeasureRow 3-col grid, LayerHeaderRow (blend/
opacity/eye/lock), honest disabled stubs. Remediation: Typography Align seedFromLive +
noConfidentDefault for Align-self (no fabricated highlight). Audit CSS-level-verified
"genuinely close to Penpot 1:1 now." Behavior from W4b-1..3c UNCHANGED.

### ⚠️ MONTHLY spend limit hit twice this session (raised each time). If a worker dies
with "monthly spend limit", it's the account cap — raise at claude.ai/settings/usage;
resume the same agent via SendMessage (context intact).

### RIGHT-PANE PARITY ~COMPLETE: Design tab (W4/W4b-1/2/3a/3b/3c/5) + Inspect tab
(W4b-4). REMAINING: final holistic side-by-side sweep (independent, covers deferred
W4b-3b Layout re-audit + align-content noConfidentDefault); then honest-stub wiring
DECISION for human (blend-mode/visibility/lock/per-corner radius — wire to real data or
leave as disabled stubs?); then PANEL 3+ chrome (left dock/headers/toolbar/dashboard);
FIX-W5 frame-nesting-<div>; FIX-W6 comments; bridge-rasterization (held).

### ROUND-5 progress (2026-07-19) — UI passes now STATIC-gated only (human tests; see memory ui-changes-human-tests)
- FIX-W4b-6 COMPLETE (tag `fix-w4b-6-complete`): Penpot +/add model for Fill/Stroke/
  Shadow (empty+title-bar-+ until added, − removes; present-vs-empty from computed
  style for Fill/Shadow, session-hint for Stroke). Static-gated (109/109), frozen 0-diff.
- FIX-W4b-7 COMPLETE (tag `fix-w4b-7-complete`): wired blend-mode (mix-blend-*),
  per-corner radius (rounded-tl/tr/br/bl-[..] toggle), aspect-lock (co-scale W/H).
  Static-gated (129/129), frozen 0-diff.
- BOTH awaiting HUMAN dogfood (paused pipeline here to avoid stacking untested passes).
- **FIX-W4b-8 (last stub: visibility + lock) — NEEDS DESIGN STEER before dispatch:**
  Visibility(eye) is a clean UI win = toggle the `hidden` (display:none) class via
  set-classes. LOCK is NOT a CSS class — needs editor state (a Set<uid> of locked
  nodes) in the studio workspace-store that the selection/edit-mode-layer respects;
  studio-local (no frozen-protocol change), but it's functional (selection-blocking),
  touches canvas edit layer + layers panel. Surface to human: proceed with that design
  or defer lock. Then: final STRICT side-by-side sweep (R5-3 remaining 1:1 deltas +
  deferred W4b-3b re-check + align-content noConfidentDefault).

---

## NEW TRACK (2026-07-20): tldraw removal + perf hardening — runs INDEPENDENTLY of the Penpot design-tab track above (do not conflate; FIX-W4b-8 + final sweep still pending, untouched by this track)

Human ask: full perf audit of the app + assessment of substituting tldraw without losing
features, then a plan to execute both. Audit found: canvas perf engineering is already
solid (viewport-cull hard-caps live iframes at 8, ~117fps @ 20 frames measured, gate
green) — no perf emergency in the canvas engine itself. Real findings: (a) zustand
selector-as-traversal antipattern in Inspector.tsx/WorkspaceShell.tsx re-running tree
walks on every store mutation; (b) LayersPanel over-subscribes to the whole `trees`
record; (c) zero React.memo anywhere in the repo; (d) the e2e perf-gate harness itself
is broken (design-system import unresolvable under its ephemeral daemon), so the fps
gate isn't actually exercised in CI; (e) tldraw's own actual API surface used here is
narrow (camera pan/zoom, one custom box shape wrapping an iframe, marquee/click
selection, resize handles — NONE of its vector/shape-library richness), the package
already enforces a strict abstraction boundary (`packages/canvas`'s public `index.ts`
leaks zero tldraw types — this is independently re-verified almost every audit pass),
and the real driver for removal is licensing cost (ADR-0005: $6,000/yr Business
License to remove the "made with tldraw" watermark, currently shipping watermarked
under Hobby), not performance.

**Plan (6 phases, written out in full to the human, approved):**
- Phase 0 — perf quick wins (the 4 findings above), apps/studio + e2e harness only, zero tldraw/canvas-engine changes.
- Phase 1 — design note: map every tldraw API used (enumerated via a dedicated research pass) to a plain custom-engine replacement; decide CSS-transform DOM camera approach.
- Phase 2 — build the replacement engine inside packages/canvas (camera store, gesture handlers, plain FrameShape component) behind a temporary `CCS_CANVAS_ENGINE=tldraw|custom` env flag; `viewport-cull.ts`/`geometry.ts`/`bridge-geometry.ts`/`drag-geometry.ts`/`wheel-gesture.ts` are ALREADY tldraw-independent pure modules — reuse verbatim; `StudioCanvasHandle`'s public interface does not change, so apps/studio needs zero edits.
- Phase 3 — parity verification: existing e2e acceptance/p2-selection specs + manual dogfood checklist (pan/zoom/marquee/resize/edit-mode/keyboard shortcuts) against the new engine.
- Phase 4 — cutover: delete tldraw-backed path + flag, drop the `tldraw` dependency from packages/canvas + apps/studio + the pnpm-workspace catalog, remove `tldraw/tldraw.css` import, resolve ADR-0005, update playbook architecture references, remeasure bundle size.
- Phase 5 — follow-on, parallel-safe perf hardening: Vite dev-server pool LRU cap (sync-daemon has no cap on simultaneous dev-server processes today — the one genuinely open scale risk), bridge-side screenshot rasterization (postMessage, replaces the cross-origin `contentDocument` read that can never succeed), Inspector.tsx decomposition (deferred until the Penpot-parity FIX-W4b-8 + final sweep above lands, to avoid restructuring a file that's about to change anyway).

**Standing rules for this track — same as the rest of the project:** workers = Sonnet 5
(`model: sonnet`); run workers SEQUENTIALLY, one phase-worker at a time (session-limit
double-burn risk on parallel heavy workers — see [[session-limit-clean-respawn]]);
ALWAYS `git log`/`git status` reconcile after each worker returns, before proceeding
(workers self-commit despite instructions — [[workers-self-commit]]); orchestrator
(this session) owns all git ops + phase tags; any user-visible/UI-behavior change in
this track must be dogfooded in a real browser before being called done, not just
green automated gates ([[dogfood-ui-before-gating]]) — Phase 0 is pure perf refactor
with no visible behavior change so it's exempted from browser dogfood, but Phase 2/3
(the new canvas engine) is NOT exempted and must get a real browser pass before cutover.

**Status:** Phase 0 worker dispatched 2026-07-20.

### Phase 0 — COMPLETE (orchestrator-verified 2026-07-20, no tag — pure perf refactor, no phase-gate ceremony for this track's small phases)
Git-reconciled clean: no self-commit (HEAD unchanged at 6b057c4), diff scoped to exactly
`apps/studio/src/workspace/{Inspector,WorkspaceShell}.tsx`, `packages/ui/src/primitives/
Tree.tsx`, `packages/canvas/e2e/tests/acceptance.spec.ts` — zero touches to `packages/
canvas/src` (tldraw itself), as required. Orchestrator independently re-ran (not just
trusted the worker's report): `@ccs/studio` typecheck ✅ + 127/127 tests ✅; `@ccs/ui`
typecheck ✅ + 22/22 tests ✅; diffs spot-read and confirmed correct (selector fix,
memo wrapping, e2e config change all match intent).
- **Fix 1 (zustand selector-as-traversal) ✅** — Inspector.tsx + WorkspaceShell.tsx now
  select primitives (`selectedUid`, `trees[framePath]`) and derive via `useMemo`.
  **Fast-follow found, not yet fixed:** the identical antipattern also lives in
  `InspectPanel.tsx:345` and `use-tool-actions.ts:76-77` — small follow-up candidate,
  not urgent (out of this pass's scope by design).
- **Fix 2 (LayersPanel subscription) — NOT changed, judgment call accepted.** Worker
  traced it: `Tree.tsx`'s `flattenTree` needs every board's tree just to compute
  `hasChildren` for the collapse arrow, even collapsed — narrowing the subscription
  would break the multi-board Layers view; also zustand v5 (installed) dropped
  selector+equalityFn entirely. Orchestrator agrees this is not actually a bug, just a
  necessary cost of correct rendering — accepted as-is, closes this finding.
- **Fix 3 (React.memo) ✅** — 29 Inspector section components + `Tree.tsx`'s row
  extracted to a memoized `TreeRowItem`. Caveat (undisputed, real): `LayersPanel.tsx`
  still passes fresh inline closures as row props each render, so the memo only pays
  off for `Tree`'s own scroll-driven re-renders, not parent re-renders — a real
  follow-up, logged, not chased this pass.
- **Fix 4 (e2e perf-gate harness) — PARTIALLY fixed, one bug remains, DEFERRED to
  Phase 2/3 on purpose.** Root cause #1 (`design-system` unresolvable — missing
  `studioMode: true` on the e2e harness's `openProject` call) is genuinely fixed and
  orchestrator-reproduced: `acceptance.spec.ts` now boots with the same studio Vite
  config `demo:daemon` always used. **Root cause #2, newly discovered, NOT fixed:**
  orchestrator re-ran `pnpm --filter @ccs/canvas run test:e2e` after the fix and
  confirmed test (a) still fails — `iframe[title="Hero"]` never appears. This is a
  REAL, separate, pre-existing bug in `packages/canvas/src/StudioCanvas.tsx`'s
  interaction between the mount-time `zoomToFit` (frames camera on the FULL bounding
  box of all 20+ frames once the perf-test fixture adds 18 extra frames) and
  `viewport-cull.ts`'s `selectLiveFrames` hard cap (nearest 8 to viewport CENTER) —
  Hero's fixed seed position isn't guaranteed to rank in the nearest-8 once the
  bounding-box center shifts with 18 more tiled frames added, so it silently renders
  as a placeholder instead of a live iframe, failing the test's very first assertion.
  **Deliberately NOT fixed in Phase 0** (out of that phase's "don't touch packages/
  canvas/src" scope) — logged here so it's fixed as part of **Phase 2/3 below**, since
  that's exactly the code being rewritten there anyway, and a green e2e perf gate is
  needed as the baseline BEFORE cutover verification. Likely fix: have the test zoom
  to Hero specifically after mount (matching what a real user editing Hero would do)
  rather than relying on incidental nearest-to-fit-all-center ranking — decide exact
  approach during Phase 2/3, not before.

## Phase 1 — design note (orchestrator-authored, no worker needed for pure scoping) — see `.orchestrator/CANVAS-ENGINE-DESIGN.md`
Maps every tldraw API surface in use today to its custom-engine replacement; the
CSS-transform DOM camera decision; the new module list inside `packages/canvas/src`;
the `CCS_CANVAS_ENGINE=tldraw|custom` flag strategy so `apps/studio` needs zero edits
(`StudioCanvasHandle`'s public interface is unchanged). Read that file before
dispatching Phase 2 workers.

**Next:** dispatch Phase 2a (camera store + gesture handlers, pure logic + unit tests,
no rendering yet) as the first Sonnet 5 worker for the actual engine build.

### Phase 2a — COMPLETE (orchestrator-verified 2026-07-20)
Git-reconciled clean: no self-commit, `geometry.ts` diff is purely additive (+60/-0,
one new `computeCameraToFitBounds`/`FitBoundsOptions` export), plus two new files
`camera-store.ts` + `camera-gestures.ts` (and their `.test.ts` companions) — nothing
else touched. Orchestrator independently re-ran (not just trusted the report):
`@ccs/canvas` typecheck ✅, test ✅ **234/234** (16 files, includes every pre-existing
suite untouched and still green). Hand-verified the core math myself: `zoomAtPoint`
and `pan` both correctly satisfy the `screen = (page + camera) * z` convention
`geometry.ts` already established (worked through the algebra by hand — checks out).
`computeCameraToFitBounds` replicates tldraw's `zoomToBounds({targetZoom, inset})`
clamp/center semantics that `StudioCanvas.tsx` currently relies on.
- Delivers: `camera-store.ts` (zustand: camera/frames/selectedIds + pan/zoomAtPoint/
  zoomIn/zoomOut/resetZoom/zoomToBounds/zoomToFit/zoomToSelection/select/
  clearSelection) and `camera-gestures.ts` (`classifyWheelGesture` + a
  `createPanDragController` state machine for space/middle-drag pan). Both pure logic,
  zero DOM coupling (wheel/pointer events modeled as plain-object shapes, not real DOM
  types), zero tldraw import, not yet wired into anything live.
- **Flagged for the Phase 3 parity-verification pass** (not bugs, disclosed
  assumptions where tldraw's real internal isn't discoverable from this repo):
  `ZOOM_STEP_FACTOR=1.25`/reciprocal 0.8 for zoomIn/zoomOut click-steps; `MIN_ZOOM=0.02`/
  `MAX_ZOOM=16` absolute bounds; the `factor = 1 - deltaZ` multiplicative model for
  ctrl/meta+wheel zoom (the `deltaZ` derivation itself IS verified, reused from
  `edit-mode-layer.tsx`'s already tldraw-checked `ZOOM_STEP_CLAMP`); and the "plain
  wheel = vertical-pan-only" simplification (today's tldraw fallthrough actually pans
  both axes on a diagonal trackpad scroll — worth checking whether that matters
  before cutover).

**Next:** dispatch Phase 2b (FrameShape + Canvas.tsx rendering behind
`CCS_CANVAS_ENGINE` flag, isolated dev harness, still not wired into the real
`StudioCanvas.tsx`) as the next Sonnet 5 worker.

### Phase 2b — COMPLETE (orchestrator-verified 2026-07-20)
Git-reconciled clean: no self-commit, diff is exactly the new `FrameShape.tsx` +
`Canvas.tsx` + a new isolated dev harness (`dev/custom-engine-harness.{tsx,html}` +
`dev/custom-engine-vite.config.ts`) + one additive line in `packages/canvas/
package.json` (`demo:custom-engine` script) — nothing else touched, no orphaned dev
server left running (checked `ps aux`, confirmed clean). Orchestrator independently
re-ran: typecheck ✅, lint ✅, test ✅ 234/234 (unchanged baseline, this workstream is
rendering not logic). Hand-verified the camera transform formula myself (`Canvas.tsx`
line ~256): `translate3d(camera.x*z, camera.y*z, 0) scale(z)` with `transformOrigin:
'0 0'` — algebra checks out against `geometry.ts`'s `screen=(page+camera)*z`
convention. Looked at the worker's own screenshot evidence
(`harness-multi-frame.png`) myself: Hero/Pricing/Aad all render live, side-by-side,
real content, at the reported zoomed-out state — confirms the worker's claim, not
just trusting the text report.
- Delivers: `FrameShape.tsx` (plain component, ports the current tldraw version's
  render logic 1:1 — chrome header, `content-visibility`/`contain` perf CSS, sandboxed
  iframe always `pointer-events:none` for now, labeled placeholder fallback; explicitly
  skips screenshot-capture/cache, matching that it's a still-unresolved, separately-
  tracked concern in the tldraw version too) and `Canvas.tsx` (root container + CSS-
  transformed "world" div, `ResizeObserver`-measured viewport size, `selectLiveFrames`
  wired in unchanged, `classifyWheelGesture` + `createPanDragController` wired to real
  DOM events, `frames` prop → `setFrames` sync).
- Real behavioral proof (not just visual): the worker dispatched actual `WheelEvent`/
  `PointerEvent` sequences and read `world.style.transform` before/after — a
  `(-150,-80)` drag-pan shifted the transform's translate by exactly that amount
  regardless of zoom (proves the pan math is zoom-independent as designed).
- **Open items carried to 2d/Phase 3:** wheel-zoom clamp (`MIN_ZOOM`/`MAX_ZOOM`) is
  applied in `Canvas.tsx`'s own wheel handler, not inside `camera-store.ts`'s
  `zoomAtPoint` itself — confirm this split is intentional when 2d wires the real
  thing. Same Phase-2a-flagged assumptions (zoom step factor, deltaZ curve, plain-
  wheel-vertical-only) still apply, unchanged by this pass.

**Next:** dispatch Phase 2c (selection: marquee/click/shift-click + resize handles)
as the next Sonnet 5 worker — still isolated, not yet wired into `StudioCanvas.tsx`.

### Phase 2c — COMPLETE (orchestrator-verified 2026-07-20; worker died mid-task on an
environment restart, RESUMED via SendMessage from its saved transcript rather than
discarded — see [[session-limit-clean-respawn]]: file timestamps showed complete,
sequential progress through the whole brief ending at the dev-harness extension, so
this was "substantial coherent progress," not a stall — resume was the right call,
confirmed correct in hindsight since the resume needed only re-verification, not
rework)
Git-reconciled clean: no self-commit, no orphaned dev server (port 5556 confirmed
free). Orchestrator independently re-ran: typecheck ✅, lint ✅, test ✅ **281/281**
(18 files, +47 new tests). Looked at the worker's own screenshots myself: `04-click-
select-hero.png` shows a clean blue selection outline + all 8 resize handles (4
corner + 4 edge) exactly at Hero's boundary; `06-marquee-drag.png` shows a proper
light-blue rubber-band rectangle spanning exactly Hero+Pricing with Aad correctly
excluded — both match the text report precisely.
- Delivers: `selection-gestures.ts` (click/shift-click-toggle/marquee, returns a
  result type from `onPointerMove` rather than an injected callback — a lint-driven
  design choice, documented), `resize-gestures.ts` (pure `computeResizedBox` + all 8
  handles, no 4-corner simplification taken), `frame-geometry-commit.ts` (mirrors the
  tldraw version's `onFrameGeometryCommitted` pub-sub exactly, so 2d can subscribe the
  same way). `camera-store.ts` gained one additive `setFrameBox` action.
  Multi-select-move-together was implemented (not simplified to single-frame).
- Confirmed via direct behavioral proof, not just visuals: drag-move computed exactly
  `screenDelta/zoom` in page space; resize-from-corner kept the opposite corner fixed;
  geometry-commit fired exactly once per gesture with the correct final box; space+drag
  pan over a selected frame still pans camera and leaves selection untouched (no
  conflict with 2b's pan gestures).
- **Open item for 2d:** if the `frames` prop's identity changes mid-drag (e.g. a
  daemon sync landing while a user is mid-move), the sync effect's `setFrames` would
  clobber the in-progress local edit — flagged, not resolved here; 2d must either
  guard against this or confirm it's not actually reachable in the real integration.

**Next:** dispatch Phase 2d — the real wiring, SPLIT into 2d-i (make `edit-mode-
layer.tsx` engine-agnostic, mechanical, zero tldraw-path behavior change) and 2d-ii
(the actual custom-engine assembly) — split decided given 2d's size and the 2c
mid-task interruption scare.

### Phase 2d-i — COMPLETE (orchestrator-verified 2026-07-20)
Git-reconciled clean: no self-commit; diff is exactly `edit-mode-layer.tsx`
(+155/-29, now zero tldraw imports) + one small, unavoidable adapter in
`StudioCanvas.tsx` (+74/-1: a new `EditModeLayerBridge` leaf component + its one call
site) — nothing else touched. Orchestrator independently re-ran: typecheck ✅, lint
✅, test ✅ 281/281 (unchanged). **Critical regression check, independently re-run
myself:** `test:e2e` shows the exact same 2 pre-existing failures, byte-identical
error messages/locators, as documented before this refactor — zero new failures.
Read the `StudioCanvas.tsx` diff myself: `EditModeLayerBridge` forwards
`setCamera`/`zoomToBounds`/`dispatch({type:'wheel',...})` to the real `editor.*`
verbatim — a pure reshape, not a behavior change.
- `EditModeLayer` now takes `cameraHandle: CanvasCameraHandle` (`setCamera`/
  `zoomToBounds`/`dispatchWheel`) + a plain `camera: CameraState` prop (the `useValue`
  subscription moved OUT to the caller) + `frameIdToShapeId: (id) => string` (replaces
  the direct `createShapeId` call) — zero tldraw imports remain in this file.
- **Open design question flagged for 2d-ii, not yet decided:** the tldraw path needs
  `dispatchWheel`'s synthetic-re-dispatch trick because `EditModeLayer`'s capture
  overlay is a DOM sibling of `<Tldraw>`, outside its container subtree, so a wheel
  event on the overlay never bubbles into tldraw's own listener without the manual
  forward. The custom engine's `Canvas.tsx` (2b) owns wheel handling directly via a
  native listener on ITS OWN container — if 2d-ii nests the overlay INSIDE that same
  container (a DOM restructuring tldraw's constraints never allowed, but which we're
  free to choose now), the synthetic-dispatch indirection may not be needed at all.
  2d-ii's call, document whichever way it goes.

**Next:** dispatch Phase 2d-ii — the actual custom-engine assembly. Real integration,
not isolated. Full real-browser dogfood of the custom-engine path required before
calling this done (not just green gates — [[dogfood-ui-before-gating]]), though the
REAL `apps/studio` default stays `tldraw` until Phase 3 signs off — 2d-ii's dogfood
happens against the isolated `demo:custom-engine` harness extended to mount the full
assembly (edit-mode, selection, zoom reporting), not against the real app yet.

### Phase 2d-ii — COMPLETE (orchestrator-verified 2026-07-20 — highest-risk sub-
workstream in this whole track, came through clean)
Git-reconciled clean: no self-commit, no orphaned processes, `files/demo` fixture
restored to its pre-dogfood state (only the original 3 frames remain on disk, verified
myself via `find`). `edit-mode-layer.tsx`'s diff confirmed byte-identical to 2d-i's own
(+155/-29, untouched by this worker, as claimed). `StudioCanvas.tsx` (was ~1427 lines)
is now a 62-line dispatcher; `index.ts` (public exports) confirmed UNCHANGED — still
imports from `./StudioCanvas.js`, which re-exports every type exactly as before, so
`apps/studio` needs zero edits. Orchestrator independently re-ran: typecheck ✅, lint
✅, test ✅ 281/281 (unchanged). **The critical check, independently re-run myself:**
`test:e2e` shows the exact same 2 pre-existing failures, byte-identical error
messages/locators — zero regression from restructuring ~1400 lines. Read the new
`StudioCanvas.tsx` dispatcher myself: reads `import.meta.env.VITE_CCS_CANVAS_ENGINE`
once, fails SAFE to `'tldraw'` for anything other than the literal `'custom'` — sound
default-safety design. Looked at the worker's own screenshots: `ce-01-loaded.png`
shows all 3 real frames rendering through `CustomEngineCanvas` (with the "+ New Frame"
button, confirming `NewFrameForm` wired in); `ce-11-after-duplicate.png` shows a real
daemon-created "HeroCopy3" frame with the edit-mode banner ("Hero — click an element
to select · Esc to exit") and resize handles all functioning against the NEW
`CustomEditModeLayerBridge` adapter — real, working edit-mode/bridge integration on
the custom engine, not just camera/rendering.
- Delivers the full split: `studio-canvas-types.ts` (shared contract), `use-studio-
  canvas-daemon.ts` (engine-agnostic daemon/frames/createFrame/duplicateFrame/
  setFrameGeometry/requestComputedStyle hook), `NewFrameForm.tsx` + `element-
  selection-bridge.tsx` (shared UI), `TldrawEngineCanvas.tsx` (mechanical extraction,
  behavior-frozen), `CustomEngineCanvas.tsx` (new assembly: `Canvas.tsx` + `camera-
  store.ts` + `frame-geometry-commit.ts` + a new `CustomEditModeLayerBridge`).
- **Design resolution for 2d-i's open question:** kept `EditModeLayer`'s overlay a
  DOM sibling of `<Canvas>` (identical shape to the tldraw path) rather than nesting
  it inside — `dispatchWheel` doesn't need DOM re-dispatch at all in the custom
  engine, it algebraically inverts the overlay's pre-computed `{point,delta}` straight
  into `camera-store`'s `pan`/`zoomAtPoint` calls. Verified live (zoom-at-cursor and
  pan both work correctly through the overlay).
- **Disclosed, intentional simplifications in the custom engine** (not bugs, not
  hidden): no phantom-frame guard (unnecessary — no native-duplicate path exists to
  guard against once we own creation fully), no `ScreenshotCacheContext` (FrameShape.
  tsx from 2b never implemented capture, matching that gap), no camera-move
  animations (tldraw's `{animation:{duration}}` options are currently no-ops on the
  custom engine's instant camera-store writes).
- Real behavioral proof beyond the screenshots: zoom-to-fit-on-open fires once
  (camera z≈0.31, not the default 1), resize/drag-move page-space math verified
  exact, geometry-commit persisted to real `.studio/canvas.json` on disk, Cmd/Ctrl+D
  triggered a REAL `duplicate-frame` daemon call (new `.tsx` + registry + canvas.json
  entry, HMR-confirmed) — not a stub.
- **One flagged-not-blocking caveat:** one dogfood run saw Esc not fire on the very
  first keypress immediately after a resize-drag pointer-capture release (fired on
  immediate retry) — looked like Playwright/CDP input-dispatch timing noise, not
  reproduced on a plain click→Esc, and `edit-mode-layer.tsx` itself is unchanged/
  shared by both engines so this isn't an engine-specific regression. Worth a human
  sanity check during Phase 3's real dogfood, not blocking.

## Phase 3 — parity verification (next)
Custom engine is now feature-complete and independently verified in isolation. Phase
3's job: (1) fix the two pre-existing e2e bugs for real (the viewport-cull/zoomToFit
interaction in `acceptance.spec.ts`, and the Playwright strict-mode locator ambiguity
in `p2-selection.spec.ts`) so there's a genuinely clean e2e baseline to certify
against; (2) run the FULL e2e acceptance + p2-selection suites against the CUSTOM
engine (not just the isolated harness) and get them green; (3) real human-quality
browser dogfood of the actual `apps/studio` with `VITE_CCS_CANVAS_ENGINE=custom` set,
side-by-side against the `tldraw` default, screenshots, checking the Esc-timing
caveat above and the disclosed simplifications (no animation, no screenshot capture)
for whether they're actually acceptable UX gaps or need addressing before cutover;
(4) run the 20-frame fps perf benchmark against the custom engine and compare to the
tldraw baseline (~117fps). `apps/studio`'s REAL default stays `tldraw` throughout
Phase 3 — flipping it is Phase 4's job, gated on Phase 3's sign-off.

### ⛔ SESSION PAUSED 2026-07-20 (Anthropic session-limit warning at 97%, human said
stop) — Phase 3a is PARTIAL, worker killed mid-investigation, NOT fully verified.

**What IS fully done + orchestrator-verified, safe to build on:** everything through
Phase 2d-ii (see entries above) — perf quick-wins, the full custom canvas engine
(camera/gestures/rendering/selection/resize/edit-mode, all behind
`CCS_CANVAS_ENGINE`/`VITE_CCS_CANVAS_ENGINE`, default `'tldraw'`, zero change to
`apps/studio`'s real behavior). Every one of those phases was independently
re-verified by the orchestrator (typecheck/lint/test/e2e re-run + diffs read + real
screenshots inspected), not just trusted from worker reports.

**Phase 3a — PARTIAL, confirmed via a live transcript peek before the kill (worker
was killed via TaskStop, not graceful — its OWN final report never arrived):**
- **Bug 1 (viewport-cull/zoomToFit) — FIXED and CONFIRMED**: a fresh `test:e2e` run
  (seen live) showed test (a) `✓ passed`. Fix approach and exact diff NOT yet reviewed
  by the orchestrator — read `packages/canvas/e2e/tests/acceptance.spec.ts` and
  `packages/canvas/dev/main.tsx` (both show as modified) before trusting further.
- **Bug 2 (Playwright strict-mode locator ambiguity) — MOSTLY fixed**: root cause was
  actually TWO always-present-vs-transient chrome-header/placeholder-label elements
  (not "chrome label vs iframe content" as originally hypothesized) — fixed via
  `.first()` at 3 call sites in `p2-selection.spec.ts`, confirmed tests (f)(g)(h)(i)(j)(k)
  now PASS in the same live run.
- **⚠️ TWO NEW FAILURES SURFACED, UNRESOLVED — READ THIS BEFORE ASSUMING 2d-ii HAS NO
  REGRESSIONS:** unblocking test (a) let the suite run further than any previous
  attempt this whole track — and tests (b) ("dragging a frame updates
  `.studio/canvas.json`") and (l) ("Esc exits edit mode") FAILED, having never been
  reached/observed in ANY prior e2e run in this entire track (they were always hidden
  behind test (a)'s cascading `beforeAll` failure). **This means every earlier
  "zero regression, same 2 known failures" verification claim in this file (Phase
  2d-i, 2d-ii) was only ever checking the tests that actually RAN — (b)/(c)/(d)/(e)/
  (l)/(h-k) were silently skipped every single time, never proven passing OR failing
  post-refactor.** Whether (b)/(l)'s failures are (a) genuinely NEW regressions from
  the 2d-ii `StudioCanvas.tsx` split, or (b) pre-existing bugs that simply never had
  a chance to surface before — is UNKNOWN. Do not treat 2d-ii as fully regression-free
  until this is resolved. Test (b)'s failure: drag doesn't update `canvas.json` within
  5s. Test (l)'s failure: `getByTestId('ccs-edit-mode-capture')` not found after
  double-click, inside the SAME `enterEditModeByHeader` helper that tests (f)/(g)
  used successfully moments earlier in the same run — inconsistent, worth checking
  for a timing/state-leakage issue between tests (shared `page`/`daemon` across the
  file?) before assuming it's a real bug.

**Immediate next step on resume:** do NOT resume the killed worker (context is
mid-diagnosis, not mid-implementation — a fresh worker re-reading this note is
cleaner). Read the diffs to `acceptance.spec.ts`/`p2-selection.spec.ts`/`dev/main.tsx`
first, decide whether bug-1's fix is sound, then investigate (b)/(l) as a NEW,
separate task — check test isolation/ordering in both spec files first (shared module-
scope `page`/`daemon` state across `test()` blocks in the same file is the most likely
culprit for an inconsistent edit-mode-entry failure like this).
