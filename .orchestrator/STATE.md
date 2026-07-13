# STATE — canvas-code-studio orchestration board

_Living status board. Append-only decisions log at bottom. Last updated: 2026-07-13._

## Current phase

**P0 — COMPLETE** (audit AUDIT-1 PASS, tagged `phase-0-complete`, protocol FROZEN).
**P1 — Infinite Canvas + Live Frames — IN PROGRESS.** Serialized: sync-daemon → canvas. daemon worker spawned.

## Phase status board

| Phase | Title | State | Gate |
|---|---|---|---|
| P0 | Foundations & Contracts | ✅ complete (tag phase-0-complete) | — |
| P1 | Infinite Canvas + Live Frames | 🟡 in progress (sync-daemon) | P0 ✅ |
| P2 | Selection Bridge | ⬜ not started | P1 |
| P3 | AST Write-Back Engine (critical path) | ⬜ not started | P2 |
| P4 | Design System: Tokens + Components | ⬜ not started | P3 |
| P5 | Studio UI Chrome | ⬜ not started | P3 |
| P6 | Backend (Supabase, git-host) | ⬜ not started | P4,P5 |
| P7 | Presence + Comments | ⬜ not started | P6 |
| P8 | Hardening + Polish | ⬜ not started | P7 |

Dependency graph: `P0 → P1 → P2 → P3 → {P4, P5} → P6 → P7 → P8`.

## Standing spawn rules

- **All workers AND auditors run on Sonnet 5** (`model: sonnet`), medium effort — human directive 2026-07-13. Keep tasks tightly scoped to fit that budget.

## Open workstreams / agent assignments

- **P0 / infra** — worker COMPLETE (13 workspace projects, protocol frozen, templates standalone, CI). Independent auditor RUNNING. 6 CRs adjudicated → ADR-0009/0010/0011.
- Topology (playbook §6): infra, canvas, ast, tokens-ds, chrome, platform, qa.
- Sequencing: P3 golden suite is the critical path — staff ast first/heaviest; scaffold golden suite during P2.

### Carry-forward into later phases (from P0 CRs)
- **P2/P5:** confirm the frozen `TreeNode` shape before building (ADR-0009).
- **P4:** token pipeline parses Almosafer DS format, DTCG = interop (ADR-0010); Almosafer DS is untyped `.jsx` w/o metadata → prop-extraction needs JS fallback + meta strategy, decide at P4 kickoff, flag to human (ADR-0011).
- **P7:** may additively extend `FrameMeta.comments` (ADR-0009).

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
