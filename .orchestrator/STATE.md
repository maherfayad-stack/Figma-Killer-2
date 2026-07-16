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
