# Handoff protocol — how agents communicate

Every agent on this project reads `STATE.md` **before** working and writes to it
**after**. That file is the only shared memory between sessions and between
agents. A chat transcript is not shared; `STATE.md` is.

---

## The three rules

1. **Read first.** Before any work, read `STATE.md` (repo root). It tells you
   what is in flight, what is blocked, and what a previous agent learned the
   hard way. Skipping it is how two agents edit the same file in opposite
   directions.
2. **Write at every stage boundary**, not only at the end. A stage boundary is:
   research complete · design agreed · implementation complete · verification
   complete · blocked. If you stop for any reason — including running out of
   room — the entry you leave behind is the deliverable.
3. **Never delete another agent's entry.** Append, or update the entry you own
   (matched by its `id`). Move finished work to the Archive section; do not
   discard it.

---

## `STATE.md` layout

```markdown
# STATE

## Now                ← at most a handful of entries; work actually in flight
## Blocked            ← needs a human decision or an external unblock
## Recently landed    ← last ~10 completed entries, newest first
## Standing notes     ← durable facts later agents must not rediscover
## Archive            ← everything older
```

## Entry format

Copy this block exactly. Fields are not optional — an empty field means you did
not do that stage, and saying so is the point.

```markdown
### <ID> — <short title>
- **Agent:** <agent-name>
- **Stage:** research | design | implementing | verifying | done | blocked
- **Updated:** YYYY-MM-DD
- **Goal:** one sentence. What "done" means.
- **Scope:** files/areas this touches. Be specific — this is the lock other agents read.
- **Done so far:**
  - <fact, with file:line where it applies>
- **Next step:** the single next action, concrete enough to execute without re-deriving context.
- **Decisions:** <choice> — because <reason>. (Only decisions a later agent could otherwise reverse by accident.)
- **Landmines:** what surprised you. What looks safe and is not.
- **Verification:** commands run + result. `not run` is a valid, honest answer.
- **Human action needed:** none | dogfood the canvas at <route> | decide <question>
```

`<ID>` is `<area>-<nn>`, e.g. `parser-04`, `canvas-11`, `mcp-02`. Pick the next
free number in that area.

---

## Worked example

```markdown
### canvas-07 — move selection rings inside the iframe
- **Agent:** canvas-engineer
- **Stage:** implementing
- **Updated:** 2026-07-30
- **Goal:** selection ring and node badge render inside the frame's own document, so
  their position needs no zoom/pan conversion.
- **Scope:** src/admin/pages/site/canvas/{BreakpointSelectionOverlay.tsx,
  canvasSelectionOverlayPositioning.ts,IframeFrameSurface.tsx}
- **Done so far:**
  - Added an overlay root appended to iframe body in IframeFrameSurface.tsx:214.
  - Rings now position in element coordinates; removed the zoom multiply.
  - InPlaceInspector still lives in the parent doc — inputs inside a transformed
    iframe behave worse, confirmed by hand.
- **Next step:** publish the anchor rect from the in-iframe overlay via a
  --selection-anchor-* custom property channel and point InPlaceInspector at it.
- **Decisions:** overlay root is excluded from applyIframeBodyPresentation's
  ownership — otherwise `body > :first-child` selectors in user CSS would match it.
- **Landmines:** the overlay root must NOT be a child that participates in layout;
  `:nth-child` and `:empty` in authored CSS see it otherwise. Same class of bug as
  the NodeWrapper divs the iframe redesign removed.
- **Verification:** `bun test src/__tests__/canvas` pass. Full suite not run yet.
- **Human action needed:** dogfood — select nodes at 50% and 200% zoom on a
  multi-frame board and confirm the ring tracks exactly.
```

---

## Standing notes

The "Standing notes" section is for facts that outlive any one task — a
measurement, a dead end, a constraint discovered by experiment. Add one when you
learn something a future agent would otherwise waste an hour rediscovering.

Good standing note: *"`bun test` takes ~195 s and ~200 failures are pre-existing
from parallel sessions as of 2026-07-30; triage against `git diff` before
assuming you broke something."*

Bad standing note: *"the parser uses ts-morph"* — that belongs in a ref doc.

---

## Interaction with the ref docs

| Where knowledge goes | What kind |
|---|---|
| `STATE.md` → Now / Blocked | Work in flight |
| `STATE.md` → Standing notes | Durable operational facts, measurements, dead ends |
| `docs/agent-refs/*.md` | How a subsystem works — stable, reusable |
| `docs/features/*.md` | The authoritative long-form contract for a shipped feature |
| `PROJECT-BRIEF.md` | Orientation, traps, routing |
| `STUDIO-IMPORT-V2-PLAN.md` | What we intend to build and why |

If you find yourself writing more than ~15 lines of durable "how it works" into
`STATE.md`, it belongs in a ref doc. Put it there and link to it from the entry.
