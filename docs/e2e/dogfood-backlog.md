# Dogfood backlog
> **Purpose:** every human dogfood script owed for work that landed without a browser pass · **Read when:** running a dogfood session, or archiving a `STATE.md` entry whose "Human action needed" block is a script · **Trust:** live · **Owner:** studio-verifier · **Verified:** 2026-09-23

`STATE.md` → "Pending dogfood" is the short queue, one line per item. This file keeps the scripts those lines point to, so archiving an entry never buries a step a human still owes. When a script has been run, delete its block here and its line in `STATE.md`, and record the result in the entry's successor or the PR.

---

## Scripts moved from STATE.md on 2026-09-23

The old `STATE.md` section, **verbatim**. Its relative links were written from the repo root. "Recently landed below" and "in `## Now`" refer to the old file; those entries are now in [`docs/state-archive/2026-09.md`](../state-archive/2026-09.md).

## Pending dogfood

Everything below **landed with green gates and was never driven in a browser.**
This is the checklist for the batched dogfood session. Per the
`dogfood-ui-before-gating` lesson, a green gate is not evidence that a surface
works — several features in this repo shipped "green" and unusable.

Entries still in "Recently landed" carry their own script inside the entry; this
list points at them. Scripts belonging to entries that moved to
[`docs/state-archive/2026-Q3.md`](docs/state-archive/2026-Q3.md) are reproduced
here **verbatim**, so archiving buries no dogfood step.

### Still in "Recently landed" below — the entry carries the full script

- **`resil-01` — the gateway retry + idempotency-key fix** (in `## Now`, not
  yet landed to `main`; draft PR #193). No test can stand in for actually
  restarting a real process mid-request. Script: with the dev server running,
  (1) open a project on a board, (2) touch a server file (or `kill` the `bun
  --watch server/index.ts` process and let it come back) at the exact moment
  you click "Add page" / drag a duplicate (⌘D) / drop a frame edit that
  triggers a boards.json save, (3) confirm NO red toast appears and the
  gesture completes once the server is back, (4) reload the board and confirm
  **exactly one** new page/duplicate landed, never two. This is also the
  correctness bar this whole fix exists for — a second copy landing silently
  would be a worse outcome than the toast it replaces, so this step is not
  optional. Live-browser (Playwright) verification of this exact scenario
  could NOT be produced in this session's sandboxed agent worktree — chromium
  launch hangs and times out at 180s (CDP handshake never completes) even
  though the browser binary itself is cached and starts a process — so this
  is unverified beyond deterministic unit tests until a human or an
  unsandboxed environment runs it.
- **`panel-16` — W8-4 the Export section** (in `## Now`, not yet landed to
  `main`). Six-step script in the entry. The two steps no test can stand in
  for: whether the PNG crop actually lands on the selected element (needs
  `bunx playwright install chromium`), and whether the SVG refusal reads as
  helpful rather than obstructive on a plain `<div>`.
- **`panel-13` — W8-1 inspector field ergonomics** (in `## Now`, not yet landed
  to `main`). Open the Properties panel on a text node in `studio-workspace/test4`
  and, in one pass: (1) type `50` into Width, press **Enter** — the field must
  read `50px`, keep focus, and have its text selected; (2) type `100/2` into
  Height and Tab out — `50px`; (3) Shift+↑ on any length (should step 10, not 8),
  then Alt+↑ (0.1), then Shift+Alt+↑ (0.1 — Alt wins); (4) ↑ on **Opacity** and
  **Z-index**, which had no keyboard step at all before — confirm no `px` is
  appended; (5) Escape mid-edit — the old value must come back, and must NOT be
  overwritten by the blur; (6) the two **Flip** buttons beside Rotation — flip
  H, flip V, flip both, then flip back and confirm the `scale` declaration is
  removed from the file rather than left as `scale: 1 1`; then set
  `transform: scale(2)` by hand and confirm both buttons go disabled with a
  reason on hover; (7) **Fill** now carries a **Text** row for `color` and an
  "Add text colour" `+`, and **Effects** carries **Text shadow** rows with no
  Spread/Inset fields — check both write to the real `.tsx`/CSS on disk.
- **`panel-15` — inspector at narrow width** (in `## Now`, not yet landed to
  `main`). The rail-overlap fix, the empty-section header, and Size's W/H were
  all measured in a headless browser, but nobody has *used* the panel at 260px:
  drag the right sidebar to its minimum, confirm no control touches the rail in
  either theme, confirm an untouched section offers no chevron, turn "Expand
  style sections by default" OFF and confirm Fill's `+` both writes and opens,
  and confirm W/H still scrub and still open Fixed/Hug/Fill.
- **`panel-12` — W7-1 launcher polish** (in `## Now`, not yet landed to `main`).
  Card scale + hover lift in both themes, the rename-then-sort fix, the failed-
  listing retry, and the post-delete refetch. Five-step script in the entry.
- **`style-04` — Animations section.** Three things first: (1) an edited imported
  `@keyframes` renders from `ClassStyleInjector`'s overlay while
  `AuthoredCssInjector` still holds the on-disk snapshot — for `@keyframes` the
  LAST definition wins entirely, so confirm DOM order lands the overlay second;
  (2) the scrub against a real animated frame, and whether 1% steps feel right;
  (3) creating an animation end to end in a project with exactly one stylesheet,
  and again in one with several.
- **`server-18` — share links.** Create a share on `studio-workspace/test4`, copy
  the link, open it in a private window; then revoke and reload. Needs
  `bunx playwright install chromium` — the one thing no test covers is whether
  the headless capture produces frames on this machine.
- **`mcp-17` — the warm CLI session.** Open the AgentPanel, send two turns, and
  confirm (a) the second starts streaming with no `initialize` lines in the
  server log, (b) Stop cancels a turn and the NEXT turn still works,
  (c) "Restart agent session" visibly kills the process.
- **`struct-06` — duplicate / wrap / same-file reparent.** Dogfood the three
  gestures on an imported board; confirm the narrow reload brings the new
  element back selected-or-not as expected, then check `git diff` in the
  workspace repo.
- **`style-05` — styled-component write-back.** Measured on two OSS corpora, never
  driven in a browser.
- **`perf-04` — narrow save/reparse.** Dogfood at `/admin/site?studio` on a board
  with several frames sharing a component. Type in one text node, wait for the
  autosave, and confirm (a) only the frames that actually share the touched file
  flicker/re-render, (b) undo still walks back through the whole burst, and
  (c) a class edit that Studio refuses still re-attempts on your next save
  instead of going quiet.
- **`panel-11` — the left rail's colour identity.** Dogfood the left rail at
  `/admin/site?studio`. Expect: Explorer gold (unchanged), **Framework and
  Classes both mint** (they used to be two different colours — the shared tint is
  the point), Inspect sky, Content lilac, Comments lilac (unchanged), AI
  assistant violet. Also click any migrated async button (Account → Save profile,
  Settings → plugin dialogs, Export → Download bundle) and confirm the spinner
  appears **without the button changing width**.
- **`server-17` — Storybook CSF import.** Put a project with `*.stories.tsx` in
  `studio-workspace/` (or point `pagesDir` at one), open `/admin/site`, and:
  (1) confirm a second board named **Stories** appears in the board switcher and
  the project's own board's frame count is UNCHANGED; (2) open it and confirm one
  row per `meta.title` with the variants laid out left to right; (3) select a node
  INSIDE a story frame and confirm its text/style edits still write back (they
  land in the component's own file, warned as shared); (4) confirm the story
  frame's own args show in the panel as read-only rather than as live-looking
  inputs that eat keystrokes; (5) delete a story frame, reload, and confirm it
  stays deleted.

### Archived entries — script reproduced verbatim

**`mcp-19` — headless capture (agent verification with the tab closed).** The
DoD test proves the server stack; it cannot prove the PAGE renders correctly,
because that is the half Chromium was faked for. Please:

1. `bun run dev`, open a project at `/admin/site?studio`, then run a
   `studio_compare` or `studio_screenshot` from the agent panel and confirm the
   returned PNG looks like the board frame — not blank, not unstyled, fonts
   loaded, images present.
2. Do the same with the Studio tab CLOSED.
3. With the tab OPEN and a node selected, run a capture and confirm the canvas
   does NOT pan/zoom and the selection is NOT cleared.
4. Confirm `capturedVia` reads `"headless"` in both cases.

If step 1 shows an unstyled or blank frame, the suspect is store hydration in
`src/admin/agentCapture/CaptureApp.tsx` (`hydrateCaptureStore`) — specifically
whether `authoredCss`/`vendorCss` reached the injectors and whether the synthetic
`'studio'` breakpoint id matches the class CSS, not the driver.

**`mcp-18` — turn routing, and a chip nobody renders.**

1. **Dogfood the routing feel.** No amount of unit testing says whether "change
   the button colour to coral" *should* be a `medium`. Watch a few real turns:
   the failure to look for is a genuine build turn classified `question`, which
   shows up as a shallow answer rather than as an error.
2. **Render the chip — one line, blocked on file ownership.** `agentRoutedTurn`
   is on the agent slice and `routedTurnLabel` / `routedTurnTitle` are exported
   from `@site/agent`, but `panels/**` belonged to another agent this pass, so
   nothing renders them. The wiring is `ModelEffortPicker.tsx`'s
   `trailingLabel={agentEffort ? currentEffortLabel : routedTurnLabel(agentRoutedTurn)}`
   with `routedTurnTitle` as the tooltip. Until then the router is invisible —
   exactly the state its own doc argues against.

**`canvas-15` — viewport and keyboard staples** (`standing-02`):
`/admin/site?studio` on a project with ≥ 3 board frames. (a) Click the `%`
readout → 50 / 100 / 200 / Fit / Fill / Zoom to selection; Fit should frame every
frame with even margins, Fill should bleed off the short axis, and Zoom to
selection should be greyed out until you select a layer. (b) Zoom to ~40 %, click
a frame header, hold ← and → — the frame should slide 1 unit per press and 10
with Shift, and the move should persist across a reload. (c) Select a nested
node, press Enter repeatedly to walk in, ⇧Enter to walk back out, then Escape
once — it must clear the whole selection in ONE press, not walk up. (d) ⌘R on a
selected node opens the rename dialog and does **not** reload the browser.
(e) The `⌘`-ish icon left of the settings cog opens Settings → Shortcuts.

**`panel-10` — the class-CSS write lock.** Open a Studio board on a Tailwind or
`dist/`-CSS project and **select an element whose only class is a
compiled/unmapped one**. Expect: an amber "read-only here" banner naming the
selector at the top of the class block, every property row greyed with no ×
button, and a **"Style the element instead"** button that opens the Element
block. Then **select an element whose class lives in a hand-authored `.css`** and
confirm nothing is greyed. Finally, in the DB-backed editor (non-Studio page),
confirm **no** row is greyed anywhere.

**`style-03` — cleared declarations and breakpoint overrides.** Dogfood at
`/admin/site?studio` — clear a declaration on a class and an inline style and
confirm both disappear from disk and stay gone after a reload; then set a value
on a `mobile` frame and confirm an `@media (max-width: …)` block appears in the
stylesheet.

**`canvas-14` — prototype flow curves.** This is visual, please dogfood.

1. `bun run dev`, open `/admin/site?studio` on a project with more than one page
   (`studio-workspace/test-3` has four).
2. Add a `<a href="/sign-up">` or `onClick={() => navigate('/sms')}` to one page's
   `.tsx` and let it reload.
3. In the canvas chrome pill, press the **arrow** toggle (right of Design/Live —
   it only appears on a Studio board in design view).
4. Expect: a **grey dashed** curve from that frame to the target frame, with a
   monospace chip on it; hovering the chip cites the exact snippet and
   `file:line:col`.
5. Select an element, and in the right sidebar (now showing **Prototype**) pick a
   destination. Expect a **teal solid** curve to appear, and
   `.studio/prototype.json` to gain a link.
6. Delete the element you linked. Expect the teal curve to turn **red and dashed**
   rather than disappearing.
7. Zoom right out and right in: line weight, dash rhythm, arrowhead and chip
   should all stay the same size on screen.

**`style-02` — class assignment on a CSS-Modules project.** Dogfood at
`/admin/site?studio` — assign a class to an element and confirm the `.tsx` gains
`styles.<local>`, not a hash; then assign one to a page whose file does not
import that stylesheet and confirm the `css-module-import-missing` toast names
the import to add.

**`panel-10` / `mcp-17` — refusal chips, toasts, and the Layers footer** (the
same script appears in both entries). Dogfood at `/admin/site?studio` on an
imported project. (1) Drag a `.map` row or a shared-component element in the
canvas — a warning chip should follow the refused drop box with the reason,
readable at 25% and 200% zoom. (2) Let go: the toast should stay until dismissed,
and its button should open the right file; repeat the same drag twice more and
the toast should show `×3` rather than stacking. (3) Right-click that element in
the Layers panel — the footer under the greyed-out Delete/Duplicate should
explain why and offer "Open the array in code". Check the footer does not stretch
the menu.

**`mcp-17` — the style-compile banner.** This is a visual, first-run surface and
no static gate can tell you it looks right. Open a Tailwind or Sass project that
has never been promoted at `/admin/site?studio`. Expect the banner bottom-centre
on the board naming the toolchain. Click **Run the project's compiler**: the
board should reload and the frames should come back styled (a project with no
`node_modules` will instead stay unstyled — install deps from the Dependencies
panel, then reload). On a second project, click **Not now**, reload the page, and
confirm it stays gone — `.studio/meta.json` should show
`"styleCompilePromptDismissed": true` and NO `"trust"` key. Also confirm the
banner never appears on a plain-CSS project or in CMS (non-studio) mode.

**`mcp-17` — one real agent turn.** The observable wins are (a)
`cache_read_input_tokens` should now dominate `input_tokens` from round 2 onward
in the context meter, and (b) a multi-screen `studio_compare` should return in
roughly a quarter of the time it used to.

**`perf-03` — the windowed Layers tree, three things the tests cannot see.** Open
`/admin/site?studio` on a real imported project (a deep one — `esim-journey`, not
`untitled`), expand the active page in the Layers panel, then `Ctrl+E` to expand
everything.

1. **Scroll feel.** Wheel-scroll the layers list fast, top to bottom. No blank
   bands, no jitter, no scrollbar jump. Then switch Settings → density to
   *comfortable* (36px rows) and scroll again — the row height is measured, not
   assumed, so this is the case that would expose a wrong constant.
2. **Drag feel — the one real behaviour change.** Drag a layer to the top and
   bottom edges of the list and hold. It should auto-scroll (it did NOT before
   that branch), and the drop line should keep resolving onto rows as they scroll
   in. Drop somewhere far from where you started and confirm the move landed
   where the line said.
3. **Focus.** Click a row, press Tab/arrows to confirm it has keyboard focus, then
   wheel-scroll it far out of view and back. Focus must return to the same row,
   and `Enter` must still act on it. Also click a node on the CANVAS that is deep
   inside a collapsed branch — the tree should expand the path and scroll that row
   into view even though it was never mounted.

**`perf-03` — five measured hot-path fixes, dogfood the canvas.** Open a board
with **6+ frames at mixed widths** (`studio-workspace/test-3` has the 178 KB CSS
corpus these numbers came from) at **~50% zoom**, then: (a) type into a text node
and watch that the save status goes `unsaved` and stays there until you STOP
typing — it should not flip to `saving` mid-word; (b) drag a frame by its header
and watch that the other frames' content does not flicker/re-render; (c) zoom out
past the virtualization boundary so 6 → 15 frames mount and see whether the stall
is visibly shorter than the 290 ms `perf-01` recorded. (c) is the one number that
could not be measured without a browser.

**`server-12` — preview deploys.** Open Version control on a Tier-2 project with
a real linked Vercel or Netlify project, deploy, and confirm the URL opens. A
real deploy cannot run in CI. Nothing else is blocked on it.

**`server-17` — the Git panel.** Needs dogfooding against a real repository with
a real remote. Every route and refusal is covered by tests against real `git`
(including a push to a local bare remote), but nobody has driven the panel in a
browser.

**`panel-05` — inspector disclosure wave 2.** Drive `:5173`: a plain `<div>` with
no `display` should show the display switcher, a two-field padding row, a Clip
content checkbox and a resident ⚙ — open it and confirm `alignSelf` is writable.
Then `display: flex` → the 3×3 pad, gap, and container-only rows appear in the ⚙;
`display: grid` → the inverse. Check Size shows one row for a width-only element
and that "Add minimum width" writes nothing until you type. Check Typography is
four rows and its ⚙ tabs. Check Position's rotation field, and that a node with
`transform: translateX(20px)` keeps it.

**`panel-04` — inspector disclosure wave 1.** Drive `:5173`: (a) select a plain
`<div>` with an empty class and confirm Background/Border/Effects/Interaction/
Typography are single `+` lines while Position/Size/Layout/Spacing keep their
controls; (b) set a value on a non-desktop breakpoint and confirm that section
stays open with its dot lit on the Desktop tab; (c) select a div inside a flex row
and confirm the align buttons that cannot write honestly are disabled *with a
reason*; (d) set `position: absolute` and confirm the Left▾/Top▾ pickers move the
value rather than duplicating it.

---

## Archived entries that carry a "Human action needed" block

Generated on 2026-09-23 from [`docs/state-archive/2026-09.md`](../state-archive/2026-09.md). Every archived entry whose text contains a "Human action needed" block is listed, newest first, so no script is lost in the archive. Many of these blocks say "none", ask for a merge that has since happened, or were closed by a later entry: read the block before running anything. The ones still worth running are queued in `STATE.md` → "Pending dogfood".

- `live-19` · 2026-09-21 · middle-mouse pan wiggles when a drag starts inside a Tier 2 (bridge) frame: the frame's `clientX` lags the parent's compositor during a pan; the fix drives the replay from `screenX/screenY` instead
- `live-18` · 2026-09-21 · double-click inline text editing inside a Tier 2 (live/bridge) frame
- `speed-02` · 2026-09-21 · autosave cadence: 2s → 250ms, plus an immediate flush on blur/Enter/scrub-release
- `speed-01` · 2026-09-21 · optimistic style application in live (Tier 2 bridge) frames
- `speed-05` · 2026-09-21 · a refused Delete answers inside the keydown task; now it doesn't
- `speed-04` · 2026-09-21 · cold selection on a Tier-2 board frame: one overlay, not two
- `server-22` · — · localized page frames rendered completely unstyled (style rule ids re-minted)
- `sec-19` · 2026-09-20 · every project starts at run-project (owner decision 2026-09-20)
- `sec-20` · 2026-09-20 · security review of the Tier-2 default (feat/trust-tier-default-run-project)
- `perf-10` · 2026-09-20 · the resync after every structural write took 2 s; it now takes ~100 ms
- `live-10` · 2026-09-20 · live frames render on a local install, and the Tier-2 default only ever runs `vite`
- `sec-21` · 2026-09-20 · security re-review of the sec-20 fix + local live-frame CSP/origin changes (commit `1496421e`)
- `store-15` · 2026-09-20 · ⌘Z after a source delete puts the element back, byte-for-byte
- `parser-14` · 2026-09-19 · the page-parse cache now tracks a component's DEEP local imports, not just its direct ones
- `perf-10` · 2026-09-19 · insert/duplicate/wrap/group paint the canvas before the write lands
- `resil-01` · 2026-09-19 · "no matter what I do shouldn't get an error": the gateway retry, made server-provably safe, and the rest of the inventory this leaves open
- `sec-14` · 2026-09-18 · per-request capability gating on every Studio route
- `sec-16` · 2026-09-18 · security review of PR #167 (per-route capability gating + CSRF on the Studio surface)
- `server-25` · 2026-09-18 · the trust tier is read from one directory, and the two Windows-shaped reds close for real
- `sec-15` · 2026-09-18 · security review of PR #166 (`fix/server-tier-dir-and-windows-reds`): a planted temp file could receive the live MCP bearer token — APPROVED WITH FIXES
- `mcp-24` · 2026-09-18 · the MCP half of `standing-01`'s named reds: a real parity gap, two stale test premises, and one guard that was only half-wired
- `parser-13` · 2026-09-18 · CRLF-safe parsing and formatting-preserving codemods for USERS' repositories
- `store-13` · 2026-09-18 · structural commits report the ids they create, and no insert orphans a node
- `canvas-20` · 2026-09-18 · D2 G3 + G15: a drag that crosses a frame moves markup between files, and a dropped file becomes an `<img>`
- `sec-17` · 2026-09-18 · security review of PR #172 (cross-frame transplant + OS image drop)
- `perf-9` · 2026-09-18 · one module decides which frames are mounted, and why
- `panel-38` · 2026-09-18 · FillSection tells the truth about Mixed, and so do Layer, Shadow and Blur
- `panel-39` · 2026-09-18 · the Design tab fits a 900px window (density pass + one real budget)
- `verify-3` · 2026-09-18 · the Phase 0 exit dogfood, machine-checked: 3 contracts locked, 4 defects named
- `verify-2` · 2026-09-18 · the e2e stack starts itself on Windows, the perf gate has a tracked corpus, and a run leaves the tree clean
- `meta-17` · 2026-09-18 · wave 3 integrated and merged: the plan is closed
- `sec-18` · 2026-09-18 · the route table is exact, and every sidecar and secret lives where it should
- `struct-11` · 2026-09-18 · ⌘G never writes invalid markup: the wrapper tag follows the HTML content model
- `store-14` · 2026-09-18 · structural gestures queue, keep their selection, and undo in one step
- `panel-41` · 2026-09-18 · the Design tab's last 444px: one write-target surface, Law 3 in the Module block, and a budget that is finally strict
- `mcp-25` · 2026-09-18 · a Studio-scoped connector sees no CMS write tool, and one real agent turn is measured
- `git-23` · 2026-09-18 · the G8 dogfood, machine-driven against a real private GitHub repository: 12 steps green, 1 defect named, 4 product fixes
- `canvas-21` · 2026-09-18 · the drag shows its reflow, a dropped file says where it will land, and a refused cross-frame move offers the copy
- `server-26` · 2026-09-18 · every line-wise read of subprocess output is CRLF-safe, through one helper
- `panel-40` · 2026-09-18 · a panel that throws takes out that panel, and hidden/locked fan out over the selection
- `meta-16` · 2026-09-18 · wave 2 integrated: 13 merges, 6 named reds closed, `verify-2` never opened a PR
- `meta-15` · 2026-09-18 · wave 2 of the Figma-feel plan dispatched: eleven parallel work orders from §9
- `meta-14` · 2026-09-18 · wave 1 of the Figma-feel plan integrated: 24 merges, 12 named reds, one S1 regression found
- `panel-37` · 2026-09-18 · the inspector height gate: scoped to the active tab, and told the truth about 900px
- `perf-08` · 2026-09-18 · S1's mount pool broke the agent's breakpoint capture three ways; a loaded document is not a mounted frame
- `store-11` · 2026-09-17 · a duplicate you click once could write itself twice, silently
- `panel-33` · 2026-09-17 · one click to the colour picker, and a swatch that finally paints a `var()` value
- `panel-32` · 2026-09-17 · Fill collapses a text colour that IS the user's own CSS, because it's declared at BASE and a breakpoint tab is active
- `canvas-16` · 2026-09-17 · a pinned frame's preview-axes override is now visible and clearable
- `panel-31` · — · Transform/Animations/Interaction move to Prototype; Attributes retired (direct user feedback)
- `meta-13` · 2026-09-17 · plan: "feels like Figma, never shows me an error" — `STUDIO-FIGMA-FEEL-PLAN.md`
- `dev-04` · 2026-09-17 · Z4: the dev server does not restart on workspace writes, and never did; the reload was Vite's
- `docs-14` · 2026-09-17 · the plan headers lied about three shipped tracks, and the Studio auth posture was never written down
- `mcp-21` · 2026-09-17 · Z3: every agent loop has a ceiling
- `style-06` · 2026-09-17 · Z8: the residual CSS refusal picks the open page; ambiguity is a choice
- `canvas-17` · 2026-09-17 · S3 + S4: sandbox-module selectors narrowed; the selection overlay is event-driven
- `canvas-18` · 2026-09-17 · K5: Alt-hover measures distances and padding
- `canvas-19` · 2026-09-17 · S2 + K2 + K6: the drag is a session; Alt duplicates; ⌘ places
- `perf-07` · 2026-09-17 · S1: a frame mount that does not block a zoom; the 290 ms was mostly poster rasterization, not the mount
- `keys-01` · 2026-09-17 · one keyboard dispatcher, the missing bindings, paste beside the selection (K1 · K4 · K7)
- `struct-10` · 2026-09-17 · K3: ⌘G / ⌘⇧G write real source (group and ungroup)
- `panel-35` · 2026-09-17 · P9: Figma parity gaps in the inspector (constraints, auto layout, radius link, fill blend)
- `panel-36` · 2026-09-17 · S5: the Design tab fits 900px, and multi-select goes through the one model
- `proto-07` · 2026-09-17 · P7: five prototype triggers, smart-animate, and pruning on page delete
- `live-09` · 2026-09-17 · Z5 + P8: live frames report their errors; the preview never breaks silently; Vite auto-promotion
- `git-21` · 2026-09-17 · G2 + G1: sign in to GitHub, connect a repository — shipped, needs dogfood
- `git-22` · 2026-09-17 · G7/G3/G4/G5/G6: write lock, branches, fetch/pull/conflicts, pull requests, agent parity
- `verify-01` · 2026-09-17 · S6 + V1 + V3(CI): a browser perf gate that runs
- `test-05` · 2026-09-17 · the Windows bucket closed: 210 fail / 134 errors → 33 fail / 0 errors
- `sec-10` · 2026-09-17 · security review of PR #150 (live-frame errors + Vite auto-promotion): APPROVED WITH FIXES
- `sec-11` · 2026-09-17 · security review of PR #151 (GitHub connect + sign-in): APPROVED WITH FIXES
- `sec-12` · 2026-09-17 · security review of PR #154 (`fix/agent-tool-truth-and-gates`, A10/A11/A14) — APPROVED WITH FIXES; one HIGH closed
- `sec-13` · 2026-09-17 · security review of PR #160 (G3–G7): CSRF reached half the git surface, and the write lock had two unbounded edges — APPROVED WITH FIXES
- `panel-34` · 2026-09-17 · DS-7: the built-in design system's colours as an Assets → Colors section
- `struct-09` · 2026-09-17 · DS-9: the deletion sweep, the no-npm gate, docs, and the standalone-build proof
- `meta-12` · 2026-09-17 · the four built-in-design-system branches merged into one integration branch
- `struct-08` · 2026-09-17 · DS-1: vendor the design system into Studio (+ DS-6's data half)
- `server-23` · 2026-09-17 · DS-2: projects carry a Studio-written `design-system/` folder instead of the npm
- `panel-33` · 2026-09-17 · Assets panel, live previews, ranked search, and Add page (DS-4 / DS-5 / DS-6-UI / DS-8)
- `panel-29` · 2026-09-16 · inspector spacing audit: one inset, one row height, a real hierarchy
- `panel-28` · 2026-09-16 · a Button on `variant="primary"` showed a dead `cardArt` picker: component prop rows now respect variant applicability
- `panel-30` · 2026-09-16 · Fill (and later Stroke/Shadow/Blur) disclosure judged on STORED, not RENDERED — "the bg is white, I don't see it in Fill" (work order)
- `server-21` · 2026-09-16 · findScaffoldedI18n found the wrong directory in a `src/`-shaped project
- `panel-27` · 2026-09-14 · P6: delete and gate (work order)
- `meta-10` · — · second consolidation: P3 Layer/Align/Measures/Layout + L6/L8 Phase A+B + R2 + L7 merged into `feat/alm-figma-killer-studio-shell`
- `panel-26` · 2026-09-14 · P5: values from the live DOM (work order)
- `panel-25` · 2026-09-14 · P3: sections in Penpot order
- `meta-09` · 2026-09-13 · all nine Live Canvas / Penpot inspector branches merged into `feat/alm-figma-killer-studio-shell`
- `store-10` · 2026-09-13 · R2: `RefusalDialog`
- `live-08` · 2026-09-13 · wire createStudioRuntimeBridge into the generated shell's real bootstrap
- `perf-06` · 2026-09-13 · L8: warm, posters, pool
- `live-07` · 2026-09-13 · L7: save → HMR loop
- `panel-23` · 2026-09-13 · P4: SelectionModel, section manifest, one commit API
- `live-06` · 2026-09-13 · L6: per-screen routes in the shell
- `panel-24` · 2026-09-13 · R3: remedy buttons in inspector refusal popovers
- `sec-09` · 2026-09-13 · security review of PR #103 (L6) and PR #102 (L7)'s re-touches to already-reviewed files
- `panel-21` · 2026-09-10 · P1+P2: the inspector shell (Design/Prototype/Inspect), wrapping — not replacing — the current panel
- `live-05` · 2026-09-10 · L5: `FrameDocumentAdapter` (**run ALONE — no other canvas work in parallel, per the plan's own text**)
- `sec-08` · 2026-09-10 · security review of the live-05 wire-protocol diff (occurrenceIndex, frame:resize, liveOrigin.ts integration fix)
- `live-01` · 2026-09-09 · L1: dev server manager (extract, gate, route, prewarm)
- `sec-05` · 2026-09-09 · two systemic gaps found reviewing PR #91, neither blocking, both worth tracking
- `live-02` · 2026-09-09 · L2: the live origin (second listener + proxy)
- `live-03` · 2026-09-09 · L3: Vite plugin id-stamping + liveNodeResolve
- `live-04` · 2026-09-09 · L4: the in-frame runtime bridge (`src/core/studio-runtime/`)
- `sec-06` · 2026-09-09 · security review of PR #93 (`feat/live-in-frame-runtime`, L4) — APPROVED, one hardening fix landed
- `sec-07` · 2026-09-09 · security review of PR #94 (`live-02`, `feat/live-origin-listener`): found and fixed a real SSRF, plus a WS resource-exhaustion gap
- `panel-20` · 2026-09-09 · P0: Penpot inspector baseline
- `panel-22` · 2026-09-09 · P2: operating rules (rules 4, 7, 8 — the slice independent of P1's shell)
- `meta-08` · 2026-09-08 · Live canvas + Penpot inspector plan
- `refusal-01` · 2026-09-08 · R1 remedies map: finish the table, don't build a new one
- `image-fill` · — · "in fill I need to be able to fill with image": the Fill section gets a real image source
- `test-03` · — · CI's Test job: 666 failures were ~35 real ones plus one bricked React
- `font-revert` · — · the font-family you picked came back, and installing a font did nothing
- `png-export` · — · PNG export stopped refusing to photograph a screen it could see, and ⌘⇧C copies it
- `apply-variable` · — · Figma's "Apply variable": every inspector field can bind to a project CSS custom property
- `panel-prefill` · — · Typography first on a text layer, and every field prefilled with what the element renders
- `panel-19` · — · W8-4: Hug/Fill stops writing `100%` into a flex row
- `panel-19` · — · W7: inspector ⚙ popovers ran off the bottom of the screen
- `look-pass` · — · W8-2: the inspector's look pass + a geometry gate that can outlive happy-dom
- `server-20` · 2026-09-07 · W7-3: the launcher tile shows the project, not a folder glyph
- `panel-14` · 2026-09-07 · W8-4: Fill edits `background-image` as N layers, honestly
- `mcp-20` · 2026-09-07 · W9-6: the last three bridge-bound tools go headless, and the agent gets a ruler
- `panel-14` · 2026-09-07 · W7-2: the launcher card says what a project IS, and every verb that acts on it
- `panel-15` · 2026-09-07 · the inspector at narrow width: the rail is no longer paved over, and an empty section is no longer an accordion
- `server-05` · 2026-09-07 · W10: agent sessions are per (account, project), and the `dir` escape is closed
- `mcp-20` · 2026-09-07 · W9-1(1): a pasted screenshot was silently the design spec; references now have roles, and an ambiguous page is refused
- `panel-16` · 2026-09-07 · W8-4: an Export section, and what it refuses to fake
- `inspector-w8-4-constraints` · 2026-09-07 · Figma's crosshair, over mappings that refuse when they'd lie
- `docs-06` · 2026-09-07 · W9-1.4: prose for every agent tool, plus three comment-truth fixes
- `panel-12` · 2026-09-06 · W7-1: the launcher sorts, fails, and redraws honestly
- `mcp-18` · 2026-09-06 · W9-1(2): `studio_computed_styles` read the frame HOST, so it returned zero rows in every real canvas
- `test-02` · 2026-09-06 · W9-1.3: `bench:agent-turn` measured one function against a fixture that no longer exists; it now measures the whole turn
- `struct-07` · 2026-09-06 · W6-5: the code the wave train orphaned is deleted
- `panel-11` · 2026-09-06 · the launcher could open a project but never remove one; now it can, recoverably
- `canvas-12` · 2026-09-06 · three features the user built were stranded on an unmerged branch; they are back on main
- `panel-10` · 2026-09-06 · the repo importer was unreachable from the launcher; it is now a peer of "New project"
- `meta-07` · 2026-09-06 · the first three screens a new user sees still spoke in the CMS's voice
- `server-19` · 2026-09-06 · the wave train's four deferred fixlets, closed together (W6-4)
- `docs-05` · 2026-09-06 · W6-4: sweep `docs/` to describe the current tree
- `docs-04` · 2026-09-06 · W6-1: retire the shipped plan files
- `docs-03` · 2026-09-06 · W6-3: rule-book and identity accuracy pass (`CLAUDE.md`, README/package/index identity, the 14 agent files)
- `docs-02` · 2026-09-06 · STATE.md archived per the handoff protocol (W6-2)
- `server-18` · 2026-09-06 · share links: a board is now showable to someone who is not an editor (W5-2)
- `struct-06` · 2026-09-06 · duplicate, wrap and same-file reparent write real code (W4-1)
- `perf-04` · 2026-09-06 · the user's own save reparsed the whole board; the agent's writes had used the narrow path for weeks
- `panel-11` · 2026-09-06 · the unreachable CMS explorer panels are gone; Button has a `loading` state; rail colour means something
- `server-17` · 2026-09-06 · Storybook CSF stories import as board frames, on a board of their own
- `board-27c` · 2026-08-31 · canvas silently drops `color-mix()`, system colours, slash-alpha `rgb()` from a project's own CSS
- `board-27e` · 2026-08-31 · canvas silently dropped `color-mix()`/system colours/slash-alpha declarations from a project's own CSS; fixed by injecting the raw text alongside the (lossy) StyleRule registry
