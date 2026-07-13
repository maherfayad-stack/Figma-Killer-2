# AUDIT-LOG — independent audit verdicts

Every worker completion gets a FRESH adversarial audit agent (never the author). No workstream merges without a PASS logged here. Format below.

---

## Template

```
### AUDIT-<n> — <workstream> · Phase <p> · <date>
Auditor: fresh agent (id) · Diff/ref: <ref>
Verdict: PASS | FAIL
Findings:
  1. [blocker|major|minor] file:line — one-line issue — one-line fix
Reproduced acceptance criteria: <list, pass/fail each>
One-Rule scan: <clean|hits>
Contract scan (P2+): <n/a|result>
Codemod hygiene (P3+): <n/a|golden+fuzz result>
Boundary check: <clean|violations>
type/lint/test: <green|red>
Security spot-check (P1+): <n/a|result>
Perf gate: <n/a|result>
Action: <merge | back-to-worker | intervene/split>
```

---

### AUDIT-1 — infra · Phase 0 · 2026-07-13
Auditor: fresh independent agent (Sonnet 5) · Ref: uncommitted working tree
**Verdict: PASS** (no blockers)
Findings:
  1. [minor] .orchestrator/* shows diffs — NOT worker's edits; they are orchestrator's own ADR/STATE updates. No action.
  2. [minor] templates/design-system ships CSS-vars+JS-mirror not DTCG tokens.json — disclosed, per ADR-0010/0006. No action.
  3. [info] canvas/ast-engine/sync-daemon are typed stubs; tldraw not installed — correct P1–P3 deferral (ADR-0005).
Reproduced acceptance criteria: install 13 projects ✅ · typecheck/lint/test/format green (turbo --force 36/36, cache bypassed) ✅ · protocol 50 tests incl. Arabic round-trip + op-rejected ✅ · `create-file demo` standalone (0 @ccs deps, 0 symlinks into packages/) + dev server /, ?frame=Hero, ?frame=Pricing all 200 ✅ · Arabic RTL fixture asserted by Playwright 2/2 ✅
One-Rule scan: clean (0 hits localStorage/sessionStorage/indexedDB/DB; only .studio/canvas.json) ✅
Contract scan (P2+): n/a
Codemod hygiene (P3+): n/a (golden/ scaffolded empty as designed)
Boundary check: clean (design-system/ + playbook untouched; all files within apps/packages/templates/e2e/.github/+root) ✅
type/lint/test: green (36/36 forced) ✅
Security spot-check (P1+): n/a
Perf gate: n/a
**Action: MERGE — P0 gated complete.**

### AUDIT-2 — sync-daemon · Phase 1 · 2026-07-13
Auditor: fresh independent agent (Sonnet 5) · Ref: `git diff phase-0-complete` (tree == commit 85c8900)
**Verdict: PASS** (no blockers)
Findings:
  1. [info] .orchestrator/.gitignore diffs belong to earlier orchestrator commit 58b9917 — not worker's. No action.
  2. [info] Commit 85c8900 landed mid-audit — the sync-daemon WORKER self-committed despite "do not commit" instruction (authored as repo git identity). Content byte-identical to audited diff; conclusions unaffected. → process learning, prompts tightened.
  3. [minor] coord-file.ts:54-56 removeDaemonCoordFile leaves an empty `.studio/` dir on shutdown — harmless (gitignored, no state). Carry-forward P8.
  4. [minor] e2e.demo.test.ts:233-236 sub-acceptance (e) soft-skips if no non-loopback iface (proven live this run). Carry-forward: assert bind-config as fallback.
Reproduced: protocol freeze additive-only (diff = +1 export line; frozen types zero diff) ✅ · 62 daemon + 9 ProjectInfo tests real & green ✅ · e2e a–e live (vite 200s, hmr-update+file-changed, add/remove, atomic geometry write, non-loopback refused) ✅ · one vite/file-folder, HMR direct ✅
One-Rule scan: clean (only .studio/canvas.json for design state; daemon.json = ports/pids, asserted no 'canvas') ✅
Wire-format (ADR-0013): conforms exactly ✅
Boundary check: scoped to sync-daemon/ + additive protocol/ + .gitignore; design-system/playbook/canvas/studio untouched ✅ · files/demo fixture reverted byte-identical ✅
type/lint/test: 12/12 green ✅
Security (§5.8): all sockets 127.0.0.1 only; no 0.0.0.0 ✅
Cleanup: child vite servers SIGTERM→SIGKILL, no orphaned ports ✅
Perf gate: n/a (canvas concern)
**Action: MERGE daemon workstream. P1 NOT yet complete — canvas workstream next; phase-1-complete tag deferred to joint acceptance.**

### AUDIT-3 — canvas + integration (P1 GATE) · Phase 1 · 2026-07-13
Auditor: fresh independent agent (Sonnet 5) · Ref: full uncommitted tree since `phase-0-complete` (canvas + ADR-0014 integration on top of committed daemon)
**Verdict: PASS** (1 major = paper-trail, remediated; 1 minor = remediated; no code blockers)
Findings:
  1. [major] ADR-0014 cited across code but MISSING from DECISIONS.md (lost to an external file edit). → REMEDIATED: re-logged ADR-0014.
  2. [minor] e2e perf guard `>24` far looser than 60fps gate. → REMEDIATED: tightened to `>50` (measured 118.4fps); e2e re-run 4/4 green.
  3. [info] dev-only create-frame-server.ts still exists but is UNUSED by production StudioCanvas + e2e — (c) is genuinely daemon-routed. Verified, no action.
  4. [info] 1/357 perf frames at 57ms (zoom-mode transition) — avg/gate unaffected.
Reproduced: all 4 acceptance via real daemon — (a) HMR 818ms no-reload; (b) drag→canvas.json via daemon; (c) create-frame via daemon control-ws API (NOT dev HTTP); (d) 20 frames avg 8.45ms ≈118fps (gate 60) ✅
Perf mechanisms: offscreen unmount→screenshot, zoom<30%→screenshots, content-visibility/contain ✅
Protocol freeze: frozen types zero diff; only additive project-info.ts + control-messages.ts + 2 export lines ✅
One-Rule: canvas makes ZERO direct fs writes — all via daemon FileOpQueue; no tldraw localStorage/indexeddb; only .studio/canvas.json + .studio/daemon.json(ports) ✅
Security (§5.8): iframe sandbox allow-scripts+allow-same-origin, pointer-events:none in nav mode; all sockets 127.0.0.1 (0 hits 0.0.0.0); create-frame rejects traversal/dup/unknown ✅
tldraw abstraction (§5.4): no tldraw types leak from packages/canvas/index.ts; pinned 5.2.4; watermark intact (ADR-0005) ✅
Boundary: scoped to packages/{canvas,sync-daemon,protocol}+root config+.orchestrator; files/ apps/ design-system/ templates/ playbook untouched; files/demo byte-identical ✅
No rogue git: HEAD 2c40fc1, all changes uncommitted ✅
type/lint/test: 12/12 green single run ✅
**Action: MERGE — P1 gated complete after remediation. Tag phase-1-complete.**
