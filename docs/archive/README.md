# Archive
> **Trust:** historical, dated 2026-09-23. Paths may be wrong. Never act on it.

Finished plans and one-off records, kept because code comments, tests and old `STATE.md` entries cite them by name. **Nothing in this folder describes the system as it is, and nothing here is a work order.** The one living plan is [`ROADMAP.md`](../../ROADMAP.md); settled owner decisions are in [`docs/decisions.md`](../decisions.md); how the shipped system works is in [`docs/features/`](../features/) and [`docs/reference/`](../reference/).

---

## TL;DR

- Read an archived file only to learn **why** something was built the way it was, or to resolve a citation such as `STUDIO-FIGMA-PARITY-PLAN.md §D2` or `WS-4.4` in a code comment.
- Filenames are **unchanged** from when the files lived at the repo root, so a bare-filename search still finds them.
- Their "status", "today" and "not built" claims were true on the day they were written and are not maintained.
- Open rows from every archived plan were carried into [`ROADMAP.md` §13](../../ROADMAP.md#13-open-work-carried-from-the-archived-plans) on 2026-09-23.

## Contents

| Path | What it was | Superseded by |
|---|---|---|
| `plans/STUDIO-IMPORT-V2-PLAN.md` | WS-1…WS-9: "any React repo, edited like Figma"; §0's trust-model argument | [`docs/features/trust-tiers.md`](../features/trust-tiers.md); ROADMAP §13 |
| `plans/STUDIO-FIGMA-PARITY-PLAN.md` | Tracks B–H and A (2026-08 audit remediation) and the §0a status ledger | [`docs/reference/canvas-dnd.md`](../reference/canvas-dnd.md) (D2 target architecture); ROADMAP §13 |
| `plans/STUDIO-NEXT-WORKSTREAMS.md` | WS-10…WS-14 and decisions D1–D5 | `docs/decisions.md`; ROADMAP §13 |
| `plans/STUDIO-WAVE7-PLAN.md` | Waves 7–10 work orders (W7-x…W10) | ROADMAP §13 |
| `plans/STUDIO-LIVE-CANVAS-PLAN.md` | Tracks L (live frames), R (refusals as choices), P (Penpot inspector) | [`docs/features/live-canvas.md`](../features/live-canvas.md); [`docs/features/inspector.md`](../features/inspector.md) |
| `plans/STUDIO-PROTOTYPE-PLAN.md` | Prototype mode phases 1–6 | [`docs/features/studio-prototype.md`](../features/studio-prototype.md) |
| `plans/STUDIO-FIGMA-FEEL-PLAN.md` | Tracks Z/S/K/P/A/G/V, waves 1–3, and the 2026-09-17 owner decisions | `docs/decisions.md`; ROADMAP §13 |
| `plans/STUDIO-SPEED-PLAN.md` | speed-01…speed-09, the live-canvas speed plan of 2026-09-21 | ROADMAP §13 |
| `2026-08-07-parity-handoffs/` | Per-track handoffs of the parity plan's first waves | the feature and reference docs |
| `e2e/COLD-SUITE-TRIAGE.md` | The 2026-09-19 triage of the cold e2e suite (`e2e-1`) | [`docs/e2e/README.md`](../e2e/README.md) → "Authoring rules" |
| `e2e/agent-upgrade-dogfood.md` | The 2026-08-03 human dogfood script for the agent upgrade | none |

Three plans with no citations anywhere were deleted on 2026-09-23 after their content was harvested: `STUDIO-WAVE7-STATUS.md`, `STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md` (→ [`docs/features/design-system.md`](../features/design-system.md)) and `STUDIO-CMS-REMOVAL-PLAN.md` (→ [`docs/architecture.md`](../architecture.md) "The dormant CMS half"). Git history keeps them.

## Related

- [`docs/CONVENTIONS.md`](../CONVENTIONS.md) → "Archive and history": when a doc is archived instead of deleted
- [`docs/state-archive/INDEX.md`](../state-archive/INDEX.md): the `STATE.md` history
- [`docs/audits/`](../audits/): dated audit reports, also historical, kept in place because code cites their paths
