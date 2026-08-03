# Agent upgrade — dogfood plan (2026-08-03)

Test plan for the five-workstream agent upgrade landed on
`feat/alm-figma-killer-studio-shell`. Engineering detail, reasoning, and known
gaps are in `STATE.md` — entries `perf-02`, `agent-02`, `agent-03`, `mcp-08`
through `mcp-12`, `panel-03`, `server-16`, `store-02` through `store-05`,
`sec-03`, `sec-04`.

**Why this file exists.** Every item below was verified by unit and integration
tests, and by static gates. **Nothing here was driven through a real browser.**
That split is deliberate — it matches this project's standing division of labour
(workers run static gates, the human dogfoods UI) — but it means the test list
in each `STATE.md` entry must not be read as end-to-end coverage. The point of
this document is to name exactly what still needs a human.

Gate status at hand-off: `bun run build` clean, `bun run lint` exit 0, all
architecture gates green, `bun test` passing except the two documented
Windows-environmental failures in `standing-01` (a POSIX path assertion and a
`chmod` 0600 check).

---

## What changed, in one table

| Workstream | What shipped |
|---|---|
| Live canvas | Agent writes report touched page ids and push a targeted reload to the open board. No filesystem watcher; an explicit agent-triggered event instead. |
| Component awareness | `studio_list_components` / `studio_find_component` / `studio_list_component_bindings`; a Figma Code Connect reader; design-system-first ordering in prompts. |
| Speed | Roster regeneration gated behind a staleness fingerprint; a duplicate project probe removed; `bun run bench:agent-turn` added. Warm turn path 19.31 ms → 2.46 ms. |
| Visual accuracy | Lossless design-reference upload + store; dpr-matched pixel diffing; `design-critic` granted the diff tools. |
| Figma MCP | Subagents can hold a vetted `mcp__<server>__<tool>`; a conditional `figma.md`; `figma-asset-scout`; `studio_fetch_remote_asset` with SSRF hardening. |

Fixed along the way, each with a regression test: a `boards.json` overwrite race
plus a second out-of-order-load vector; an unrestricted `Bash`/`Write` surface on
the agent subprocess (while its own system prompt claimed it had none); an
unsanitised-SVG upload path; two duplicated SSRF address classifiers; two
duplicated helpers (`PALETTE_HIDDEN_NAME_RE`, an image-header sniffer).

---

## Prerequisites

1. `bun run dev` — SQLite at `.tmp/dev.db`, no external services.
2. Sign in as the **owner** account. `studio.write` and `studio.run.project` are
   owner-only capabilities; an `admin` login will fail Studio operations.
3. **Approve the design system's MCP server.** Settings → AI → MCP Servers →
   approve `design-system`. `studio-workspace/untitled/.mcp.json` already
   declares it and `@alm-design/design-system@1.1.3` is installed there, but
   nothing is approved by default and Studio cannot approve it for you — a
   `.mcp.json` entry is a command line, so consent is a deliberate human act.
   **Group B below does nothing until this is done.**

---

## Group A — live canvas reload (test this first)

Highest risk: it touches the save path, and `store-02`/`store-04` record one
data-loss incident on that path already.

**A1 — an agent edit appears without a refresh.**
Open a project at `/admin/site?studio`. Drive `studio_apply_edits` against a
visible page (the Agent Panel, or an MCP client against `/_studio/mcp`).
*Expect:* the frame updates on its own, within a second or so.
*Failure:* the canvas stays stale until you reload — the push or the dispatch is
not wired. Check the browser console for `[studioLiveReload]`.

**A2 — a new page lands on the board.**
Drive `studio_create_page`.
*Expect:* the new frame appears at the next free grid slot, selected.
*Failure:* the file exists on disk but no frame appears.

**A3 — the reload does not re-dirty the store.** *This is the important one.*
After A1 completes, watch the network panel for ~2 seconds.
*Expect:* **no** `POST /admin/api/studio/save`. The reload mirrors disk; it is
not an edit.
*Failure:* a save fires immediately after the reload. That is the
`write → reload → re-dirty → autosave → write` loop this repo has deliberately
avoided by having no watcher. Stop and report it.

**A4 — the save-diff baseline resynced.**
After A1, make one small real edit elsewhere and let it autosave.
*Expect:* the save payload carries only your edit.
*Failure:* it carries every prop on the reloaded page. The `loadedValues`
baseline was not resynced — harmless in content (the write is idempotent) but it
re-sends the whole page on every save.

**A5 — a Next App Router project is a known no-op.**
If your project uses the App Router, the file→pageId mapping does not attempt
its route-composed id scheme, so the canvas stays stale and the disk write still
succeeds. Documented in `mcp-11`; not a bug to report.

---

## Group B — component awareness (needs the MCP approval above)

**B1 — the agent asks what exists before building.**
Ask the agent to add a screen using the design system.
*Expect:* it calls `list_components` (the design system's own MCP tool) or
`studio_list_components` **before** writing markup, and composes with real
imported components rather than hand-rolled `div`s and a fresh CSS module.
*Failure:* it hand-rolls a nav, a divider, or card rows that already exist. That
is the exact documented failure this workstream targets.

**B2 — an empty catalog does not defeat it.**
`studio_list_components` returns **zero** components for ALM by design — the
package ships bundled untyped JS, no `.d.ts`, so a syntactic extractor has
nothing to read. This was verified empirically, not assumed.
*Expect:* the agent notices the `designSystems`/`note` fields, then falls back
to the design system's own MCP server or `design-system.md`'s BEM class index.
*Failure:* it treats `[]` as "there is no design system" and hand-rolls
everything.

**B3 — Figma Code Connect data is reachable.**
Ask for a component's props and its Figma node.
*Expect:* `studio_list_component_bindings` returns the mapping — e.g. `Button`
maps Figma `Type` → `variant` across 13 values.
*Note:* 26 of 29 components carry a usable mapping; 5 are unfilled
`REPLACE-ME` scaffolds flagged `nodeIdPlaceholder: true`; the corpus spans
**two** Figma file keys, so a per-component lookup is required.

---

## Group C — design reference and measurement

**C1 — attach a reference (UI mechanics).**
Agent Panel → "Attach design reference" above the composer. Attach a PNG export.
*Expect:* a chip with thumbnail, filename, **intrinsic dimensions read
client-side**, size, upload progress, and a working remove.
*Failure:* the dimensions are wrong or missing, or the chip clears itself when
you send a message — a reference is persistent, not per-message.

**C2 — it is stored losslessly.**
Check `studio-workspace/<project>/.studio/references/`.
*Expect:* byte-for-byte your original file. A PNG stays a PNG.
*Failure:* a re-encoded JPEG, or downsampled dimensions. The measurement
baseline has been degraded and every later diff inherits the loss.

**C3 — the critic measures instead of guessing.**
Ask for a design review of a page with a reference attached.
*Expect:* it lists references, calls `studio_recommend_export_dpr`, exports at
that dpr, diffs by reference id, and reports differing regions **with node
ids** — "the hero is 78% different, nodes X and Y".
*Failure:* it eyeballs a screenshot and gives an opinion without diffing.

**C4 — the `method` field is respected.**
*Expect:* if the diff came back `resampled`, the critic does not report
sub-pixel differences as defects. If it refused on aspect-ratio grounds, it
reports *that* as the finding — a missing section or wrong crop — rather than
forcing a comparison.
*Failure:* a confident similarity score with no mention of which path produced
it.

**C5 — no reference, no fabrication.**
Ask for a review with nothing attached.
*Expect:* it says plainly that no reference was supplied and reviews against the
house style.
*Failure:* an invented similarity number.

---

## Group D — Figma MCP (needs a Figma MCP server connected)

**D1 — a Figma-capable subagent exists at all.**
With an approved Figma server, start a turn.
*Expect:* `.claude/agents/figma-asset-scout.md` and `.claude/figma.md` are
generated in the project.
*Failure:* neither appears — the server name/summary did not match the detection
heuristic (it looks for "figma").

**D2 — the roster still generates.** *Check this even if you skip the rest.*
*Expect:* `.claude/agents/` holds the full roster.
*Failure:* it is empty or short. `assertKnownAgentTools` throwing degrades the
turn to **no subagents at all**, silently. That was the structural blocker this
workstream removed, and a regression would be invisible without this check.

**D3 — tool names.** `figma-asset-scout` is granted
`mcp__<server>__get_metadata` and `mcp__<server>__get_image` — Figma's
documented Dev Mode names, **never verified against a live connection**. If your
server exposes different names, correct the two literals in
`server/handlers/studio/agentRosterFigma.ts`. This is roster content, not
architecture.

**D4 — an asset lands without transiting the model.**
Ask for a component's icon to be pulled into the project.
*Expect:* `studio_fetch_remote_asset` fetches server-side and returns a
`relPath`. No base64 blob in the conversation.
*Failure:* the agent hand-carries base64 between two tools — which blows the
context window on any real asset.

---

## Group E — speed

**E1 — the measured baseline.**
```sh
bun run bench:agent-turn
```
*Expect:* warm roster p50 in the low single-digit milliseconds (2.46 ms at
hand-off, down from 19.31 ms), and cached `resolveProjectProfile` around
0.1 ms.
*Note:* re-run this now that `untitled` has a real `node_modules`. The install
moved its design system from the `imported` detection path to `node-modules`,
which exercises a different `almosafer-ds-expert` branch than the numbers were
taken on.

**E2 — subjective turn latency.** The first turn on a project still pays a cold
roster build; every turn after should feel immediate to start.

---

## Group F — data-loss regression watch

Not a feature. These guard the incident in `store-02`, whose root cause is
**still unexplained**.

**F1 — no spurious frame loss.**
Work normally for a while: switch projects, resize frames, add and remove pages.
*Expect:* `.studio/boards.json` never loses a frame you did not remove.
*Failure:* frames disappear. Capture `git diff` on `boards.json` immediately and
stop.

**F2 — the guard fires, visibly.**
If the save guard ever refuses a write, you get one toast (not a stream) and
work continues.
*Expect:* if you see it, that is the guard doing its job — but report it, because
it means something tried to persist a board smaller than the last known-good
state.

**F3 — an explicit removal still saves.**
Remove a frame deliberately.
*Expect:* it persists. The guard distinguishes a real removal from a suspicious
one.
*Failure:* your deliberate removal is refused — the `boardsPendingExplicitRemoval`
flag is not being set.

---

## Still open

- **The 56-file deletion (`store-02`).** Two full audits found no code path in
  the server, client, or Vite config that can empty `pages/` or
  `styles/imported/<slug>/`. Actively disproven: rename/move/copy, a
  Studio-routed AI turn (the session DB shows zero AI activity that day,
  corroborated by `~/.claude/projects`), a shell command (PowerShell history
  unmodified since the day before), OneDrive eviction, and the project-create
  path. **What would settle it:** an elevated Recycle Bin check for the 56
  filenames — a programmatic `rm` is permanent and never lands there, a GUI
  delete does — or an answer to what else was pointed at that directory around
  03:21–03:25.
- **Two-tab last-write-wins on `boards.json`** — needs server-side
  coordination; the client-side guards do not cover it (`store-04`).
- **`Task` → `general-purpose` subagent tool bounds** — one paid turn settles
  whether `--tools` bounds a built-in subagent. Ask the agent to dispatch
  `general-purpose` to run `echo hi` via Bash and confirm it is unavailable
  (`sec-03`).
- **SSRF residual** — a resolver compromised at the moment of the first lookup
  is outside any application-level guard (`sec-04`).
