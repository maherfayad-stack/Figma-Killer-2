# Handoff protocol — how agents communicate
> **Purpose:** how `STATE.md`, its archive and a PR's handoff are written, so work survives the session that did it · **Read when:** before writing or archiving a `STATE.md` entry, and at every stage boundary · **Trust:** rule · **Owner:** studio-scribe · **Verified:** 2026-09-23

Every agent on this project reads `STATE.md` **before** working and writes to it at every stage boundary. That file is the only shared memory between sessions and between agents: a chat transcript is not shared, and `STATE.md` is. It is also read in full by every agent that starts work, so it stays under 400 lines, and everything that leaves it moves to the archive verbatim.

---

## TL;DR

- **Read first; write at every stage boundary; never delete another agent's entry** (archive it).
- **New entries go under `## Now`, never above it.** Nothing sits above `## Now` except the file header.
- **An entry is at most 40 lines.** The long form (full verification output, every file touched, the dogfood script) goes in the PR body, and the entry links to it.
- **When the work merges into the trunk**, the entry leaves `## Now`: its body moves verbatim to the month's archive file, it gets one line in `docs/state-archive/INDEX.md`, and a one-liner in `## Recently landed`.
- **Archives are monthly**: `docs/state-archive/YYYY-MM.md`, newest entry first.
- **Intent does not go in `STATE.md`.** Planned work is in [`ROADMAP.md`](../../ROADMAP.md); settled owner decisions are in [`docs/decisions.md`](../decisions.md).

---

## The three rules

1. **Read first.** Before any work, read `STATE.md`. It tells you what is in flight, what is blocked, and what a previous agent learned the hard way. Skipping it is how two agents edit the same file in opposite directions.
2. **Write at every stage boundary**, not only at the end. A stage boundary is: research complete · design agreed · implementation complete · verification complete · blocked. If you stop for any reason, including running out of room, the entry you leave behind is the deliverable.
3. **Never delete another agent's entry.** Update the entry you own (matched by its `id`). Finished work is archived, never discarded.

---

## `STATE.md` layout

Each section has a hard cap. The whole file stays under 400 lines.

```markdown
# STATE
> header line (docs/CONVENTIONS.md)
Protocol · Plan · Decisions · History links

## Now                ≤ 8 entries, ≤ 40 lines each. Only work not yet merged into the trunk.
## Blocked            one line per item: id · question · who decides · since
## Pending dogfood    one line per item: id · route · what to look at (script: the entry, or docs/e2e/dogfood-backlog.md)
## Standing notes     ≤ 120 lines, grouped by subsystem; each: id · fact · date verified · where it is enforced
## Recently landed    ≤ 10 one-liners: ids — what — PR — date
## Archive            a pointer to docs/state-archive/INDEX.md
```

"The trunk" is the branch bundle PRs target (`feat/canvas-excellence` for the canvas excellence program, `ROADMAP.md` §4). In a parallel wave, agents do not edit `STATE.md` at all: each puts its entry in its PR body under `## STATE entry`, and the orchestrator folds them in once (`STATE.md` → `standing-05`).

---

## Entry format

Copy this block. Fields are not optional: an empty field means you did not do that stage, and saying so is the point. The whole entry is at most 40 lines.

```markdown
### <ID> — <short title>
- **Agent:** <agent-name> · **Branch:** <branch> · **PR:** <link or none> · **Updated:** YYYY-MM-DD
- **Stage:** research | design | implementing | verifying | done | blocked
- **Goal:** one sentence. What "done" means.
- **Scope:** files/areas this touches. Be specific: this is the lock other agents read.
- **Done so far:**
  - <fact, with file:line where it applies>
- **Next step:** the single next action, concrete enough to execute without re-deriving context.
- **Decisions:** <choice> — because <reason>. (Only decisions a later agent could otherwise reverse by accident.)
- **Landmines:** what surprised you. What looks safe and is not.
- **Verification:** commands run + result. `not run` is a valid, honest answer.
- **Human action needed:** none | dogfood <route>: <one line; full script in the PR body> | decide <question>
```

`<ID>` is `<area>-<nn>`, for example `parser-04`, `canvas-11`, `mcp-02`. Take the next free number in that area from `STATE.md` and `docs/state-archive/INDEX.md`. Areas in use include `parser`, `canvas`, `store`, `panel`, `server`, `mcp`, `perf`, `sec`, `test`, `docs`, `meta`, `style`, `struct`, `live`, `speed`, `git`, `verify`, `keys`, `proto`, `dev`, `resil`, `e2e`; a new area is fine when none fits.

**Over 40 lines?** The detail belongs in the PR body (and durable "how it works" belongs in a ref doc). Keep the entry to the facts the next agent needs to act, and link the rest.

---

## When work lands: archiving

The moment an entry's work is merged into the trunk:

1. **Move the entry verbatim** to the top of `docs/state-archive/YYYY-MM.md` for the current month (create the file if needed, with the historical header from `docs/CONVENTIONS.md`). Put `<!-- archived from STATE.md, zone: ## Now -->` above it. Nothing is summarised or edited.
2. **Add one line** to the top of that month's section in `docs/state-archive/INDEX.md`: `- YYYY-MM-DD · \`id\` · title · [\`YYYY-MM.md\`](YYYY-MM.md)`.
3. **Add a one-liner** to `## Recently landed` (ids — what — PR — date). When that section passes 10 lines, delete its oldest line: the entry is already archived and indexed.
4. **Check what it still owes before it leaves.** A dogfood script the owner has not run gets one line in `## Pending dogfood`, and the script itself goes in `docs/e2e/dogfood-backlog.md` (or stays reachable in the archived entry the line names). A durable fact goes to the doc that owns it (below), or to `## Standing notes` if it is operational. Grep the destination first; copy only what is missing.

Standing notes are archived only when retired (stale, superseded or folded into a doc). Retire one by moving it verbatim to the month's archive file, like an entry.

---

## Worked example

```markdown
### canvas-07 — move selection rings inside the iframe
- **Agent:** canvas-engineer · **Branch:** `fix/rings-in-frame` · **PR:** #88 (draft) · **Updated:** 2026-07-30
- **Stage:** implementing
- **Goal:** the selection ring and node badge render inside the frame's own document, so their position needs no zoom/pan conversion.
- **Scope:** src/admin/pages/site/canvas/{BreakpointSelectionOverlay.tsx,canvasSelectionOverlayPositioning.ts,IframeFrameSurface.tsx}
- **Done so far:**
  - Added an overlay root appended to the iframe body (IframeFrameSurface.tsx:214).
  - Rings now position in element coordinates; the zoom multiply is gone.
- **Next step:** publish the anchor rect via a `--selection-anchor-*` channel and point InPlaceInspector at it.
- **Decisions:** the overlay root is excluded from applyIframeBodyPresentation's ownership — otherwise `body > :first-child` in user CSS would match it.
- **Landmines:** the overlay root must not participate in layout; `:nth-child` and `:empty` in authored CSS see it otherwise.
- **Verification:** `bun test src/__tests__/canvas` pass. Full suite not run yet.
- **Human action needed:** dogfood `/admin/site`: select nodes at 50 % and 200 % zoom on a multi-frame board; the ring tracks exactly (script in #88).
```

---

## Standing notes

The "Standing notes" section is for operational facts that outlive any one task: a measurement, a dead end, a constraint discovered by experiment, a tool trap. Add one when you learn something a future agent would otherwise waste an hour rediscovering. Give it the next free `standing-<nn>` id, the date you verified it, and the gate or file that enforces it.

Good standing note: *"`bun run test` writes no run summary when its stdout is redirected; count `(fail)` lines."*

Bad standing note: *"the parser uses ts-morph"*. That belongs in a ref doc.

---

## Where knowledge goes

| Knowledge | Destination |
|---|---|
| Work in flight | `STATE.md` → Now / Blocked |
| A durable operational fact, measurement or dead end | `STATE.md` → Standing notes |
| A dogfood script a human still owes | `STATE.md` → Pending dogfood (one line) + `docs/e2e/dogfood-backlog.md` |
| How a subsystem works, compressed | `docs/agent-refs/*.md` |
| The long-form contract of a shipped feature | `docs/features/*.md` |
| Orientation, traps, routing | `PROJECT-BRIEF.md` |
| Work not yet built, and open owner questions | [`ROADMAP.md`](../../ROADMAP.md) |
| A settled owner decision | [`docs/decisions.md`](../decisions.md) |
| A finished entry | `docs/state-archive/YYYY-MM.md` + `INDEX.md` |

Each fact lives in exactly one place; the others link to it.

## Related

- [`STATE.md`](../../STATE.md) — the file this protocol governs
- [`docs/state-archive/INDEX.md`](../state-archive/INDEX.md) — every archived entry
- [`docs/e2e/dogfood-backlog.md`](../e2e/dogfood-backlog.md) — dogfood scripts still owed
- [`docs/CONVENTIONS.md`](../CONVENTIONS.md) — the header line and the archive doc type
- [`.claude/agents/README.md`](../../.claude/agents/README.md) — the agent roster that follows this protocol
