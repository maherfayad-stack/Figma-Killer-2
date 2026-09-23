# ROADMAP: the canvas excellence program
> **Purpose:** the single living plan for Studio: what to build next, in what order, by whom, and the questions still open for the owner · **Read when:** before designing any change, to find its bundle · **Trust:** live (written 2026-09-23 at `560ddb0e`) · **Owner:** studio-architect keeps it current; studio-scribe folds finished bundles out · **Verified:** 2026-09-23

The owner asked for eight things on 2026-09-23. The canvas should:
- not lag;
- never show an error, and "magically solve my issues";
- move, drop and place like Penpot or Figma, with Figma's smoothness.

They also asked for:
- a design pane with room to breathe;
- a better experience everywhere;
- the most creative, best-equipped assistant possible;
- image drag and drop;
- SVG draw and edit that does not slow the canvas;
- component detach;
- clean docs.

Nine Opus auditors read the code, the docs and Penpot's source to produce this plan. Their
reports are the evidence, and every ID below resolves in them:
[`docs/audits/2026-09-23-studio-audit/`](docs/audits/2026-09-23-studio-audit/README.md).

**How to use this doc.** Work is grouped into **bundles**, and a bundle is one PR by one specialist, for example
`P2-B`. A bundle lists the audit IDs it closes. Before starting a bundle, read those IDs in the
audit report, then write a `STATE.md` entry that names the bundle. Phases have exit gates. A phase
may start before the previous one ends only where §11 (collision map) says the files are disjoint.

---

## 1. What the audit found, in ten lines

1. **Studio can silently write to the wrong element.** Ids are `line:col`. When a file changes
   outside Studio (the agent's Edit tool, VS Code, `git pull`), a later prop, text or delete edit
   lands on a *neighbour* and reports `written:1`. A delete sent while a move is still in flight
   does the same (WB-1, ERR-4; both reproduced).
2. **Three more silent-loss bugs.** Dictionary text edits revert on the next reload, because the parse cache
   misses evaluator dependencies (WB-2). Two instances' style/class edits collapse to one (WB-7).
   After a resync, the selection can silently point at a different element (ERR-5).
3. **Undo lies.** A focused number field undoes your undo on blur (ERR-1). ⌘Z cannot get past a
   delete (ERR-2). Undo fails as soon as you click another frame (ERR-3).
4. **Ordinary React goes missing.** `<div>text</div>`, `<li>`, `<label>` and `<td>` drop their text (WB-3).
   `memo`, `forwardRef` and barrel re-exports render as "Unknown module" (WB-4).
5. **Lag has three concrete causes.** Each hover or selection makes every mounted frame re-run two
   full-page layout passes (PERF-2). Every store update runs 11 selectors per node, which costs 6–12 ms on a
   realistic board and 0.5 ms on the committed fixture, so no gate sees it (PERF-1). The toolbar
   freezes during pan, then jumps (PERF-3). A poster capture of 85–350 ms re-runs after every edit (PERF-5).
6. **Half of each Figma gesture is missing.** Arrow keys do nothing on a selected element. ⇧-click
   selects a range instead of toggling. Tab does not cycle siblings. ⌘A leaks to the browser. Resize
   ignores `box-sizing`, fights `flex:1`, and has no ⇧/⌥ modifiers. There is no `V`. Snapping is
   sibling-only and does not scale with zoom (IX-1…IX-6, IX-11).
7. **The design pane is flat.** Props are 8 px apart, and the gap from the last prop to the Layer
   row below is the same 8 px, with no line and no header. Penpot uses 4 px inside a group and 16 px between
   groups (UX-1…UX-3).
8. **The assistant's best guidance never reaches it.** On the default Claude-CLI path, the
   creative/strict mode block and the follow/free design-system block are never sent. On the
   API-key path, the assistant has no tool that can write a file. `studio_list_tokens` returns
   nothing on every project (AI-1, AI-2, AI-4).
9. **Image drop and detach already exist, but have bugs.**
   - Image drop: replacing an image writes a URL that 404s in production (IMG-1).
   - Detach: it can write code that references unbound names, or that silently rebinds to the page's own names, and it has no undo (DET-1, DET-4).
   - SVG: an `<svg>` is one opaque locked node, and inserting SVG markup writes a `style="…"` string that makes React throw.
10. **The docs contradict each other.**
    - There are ten root plans, most of them finished. None is marked closed.
    - `STATE.md` is 18,013 lines, with 137 entries in `## Now`, of which one is actually in flight.
    - 52 references point at a renamed doc.
    - 22 contradictions confuse agents (09-docs §3c).

---

## 2. Owner decisions (answered 2026-09-23)

All fourteen program decisions are settled. Their full text, with how each was answered, is in
[`docs/decisions.md`](docs/decisions.md) → "The canvas excellence program". Bundles below cite them by id:

| # | Short name | Affects |
|---|---|---|
| OD-1 | Archive the code-cited plans, delete the uncited three | P0 |
| OD-2 | Standing authorization re-confirmed 2026-09-23 | all |
| OD-3 | Figma shortcut meanings; ⇧-click toggles on the canvas | P2-B |
| OD-4 | Inspector section gap 12 px; Shadow + Blur → Effects | P2-F |
| OD-5 | Armed insert tools R/O/T/F | P5-E |
| OD-6 | Marquee inside a frame | P5-E |
| OD-7 | Structural gesture inside a shared component: this instance only | P3-D |
| OD-8 | `.map` rows: style edits to the template, structure edits to the array | P3-C/D |
| OD-9 | Detach inlines; "Expose as prop" is separate | P5-C |
| OD-10 | SVG D1–D6 (D1 → free canvas) | P5-D |
| OD-11 | Assistant imagery: stock now, generation later | P4-E |
| OD-12 | Image drop follows the project's import convention | P5-B |
| OD-13 | URL drag gets an SSRF-guarded fetch route | P5-B |
| OD-14 (+ OD-FC-1/2) | Free canvas: loose layers on the board | P5-G |

Questions still open for the owner are listed at the end of §13.

---

## 3. Program shape

```
P0 Consolidate docs ─┐  (1 scribe; STATE writes frozen for its duration)
                     ▼
P1 Never corrupt, never lie ── barrier: nothing from P2/P3/P5 merges before P1's exit gate
        │
        ├──► P2 Feel (perf quick wins · hands · resize · snapping · design pane)
        │         │
        │         └──► P3 Quiet editor (refusals become writes · toast policy · ordinary React)
        │                   │
        │                   └──► P5 Figma-grade tools (images · detach · SVG · draw tools · handles)
        │                             │
        │                             └──► P6 Scale (load path · reconciliation · remaining budgets)
        │
        └──► P4 Assistant ── runs in parallel from P1 on (server/ai + AgentPanel; disjoint files)
```

**Verification policy (every bundle).**
- `bun test`, `bun run build` and `bun run lint` pass on the bundle's own files.
- A bundle that touches the canvas, a frame, an overlay, geometry or a panel's height also runs `bun run test:e2e` for the specs it touches, and asserts on computed layout (CLAUDE.md, `standing-02`).
- **UI-only bundles** (panels, chrome, visual) stop at static gates. The owner dogfoods them, and the bundle's STATE entry ends with a dogfood checklist.
- **Non-UI bundles** (writeback, parser, server, security, store logic) get full verification, including a regression test for every reproduced bug.

---

## 4. Phase 0: consolidate the docs

**Why first:** every later bundle writes a STATE entry and reads CLAUDE.md, BRIEF and this ROADMAP.
Today those documents disagree with each other and with the code. **Precondition: met.** Every open draft line is merged into `chore/integrate-open-drafts` (PR #217, STATE `meta-19`). #99 was already in `main`, and #86 is superseded (see P0-I). The program trunk is `feat/canvas-excellence`, cut from that branch, and **every bundle PR targets the trunk**. #205 brought `STUDIO-SPEED-PLAN.md`: P0-B folded its open work orders into §13 of this file and archived it. The integration head carries the trust-default change (`run-project`, #198 line), and the docs must describe it.

Owner: **studio-scribe**. One PR per bundle, run strictly in order. Full procedure: 09-docs §2.4 and §3.

| Bundle | Work | Effort |
|---|---|---|
| **P0-A** Conventions | Add to `docs/CONVENTIONS.md`: a one-line header on every doc (`Purpose · Read when · Trust · Owner · Verified`), trust levels (`rule / current / current-cms / live / index / historical`), and the "plan" and "archive" doc types. Remove the dead `features/media.md` row | S |
| **P0-B** Plans | Per OD-1, move the seven code-cited plans to `docs/archive/plans/` with unchanged filenames, plus `docs/archive/README.md` saying "historical, never act on these". **Harvest before moving:** owner decisions go to a new `docs/decisions.md` (FEEL §6, NEXT-WS D1–D5, BUILTIN §0, the trust default of 2026-09-20). Create `docs/features/live-canvas.md` (Tier-2 runtime, dev server, liveOrigin), `docs/features/trust-tiers.md` (IMPORT-V2 §0 plus CLAUDE.md's invariant-1 parenthetical) and `docs/features/design-system.md`. The D2 target architecture goes to `docs/reference/canvas-dnd.md`, and the CMS-REMOVAL traps go to `docs/architecture.md`. Every plan's **open** rows go to §13 of this file. Delete the three uncited plans. Move `docs/audits/2026-08-07-parity-handoffs/`, `docs/e2e/COLD-SUITE-TRIAGE.md` and `agent-upgrade-dogfood.md` to the archive | M |
| **P0-C** STATE.md | Restructure to ≤ 400 lines, per 09-docs §2.2:<br>• Sections are Now (≤ 8, ≤ 40 lines each), Blocked, Pending dogfood (one line each), Standing notes (≤ 120 lines, grouped by subsystem), and Recently landed (≤ 10 one-liners).<br>• Everything else moves verbatim to `docs/state-archive/2026-09.md`, with a new `docs/state-archive/INDEX.md` (one line per entry across both archive files).<br>• Dogfood scripts move to `docs/e2e/dogfood-backlog.md`.<br>• Retire `standing-03`, `standing-07` and `standing-09`, which are stale.<br>• Keep the ids `standing-01`, `-05`, `-08` and `-10`, because agent files cite them.<br>• Verify that every old id appears in INDEX.md | M |
| **P0-D** Protocol | Rewrite `docs/agent-refs/handoff-protocol.md`. New entries go under `## Now`, never above it. Each entry has a 40-line cap, and the long form goes in the PR body. Archives are monthly. Point the roadmap reference at this file | S |
| **P0-E** References | Update every reference the moves affect:<br>• the 52 `inspector-disclosure.md` references, changed to `inspector.md`;<br>• the gate messages in `single-drag-mechanism.test.ts:159,200` and `toast-dedupe-default.test.ts:89`;<br>• the `no-alm-npm-specifier.test.ts` comment (name `docs/archive/`);<br>• the routing in 11 agent files (`studio-architect`, `studio-scribe`, `mcp-tooling`, `panel-designer`, `parser-surgeon`, `perf-hunter`, `security-guard`, `canvas-engineer`, `store-engineer`: IMPORT-V2 and standing-03 references become ROADMAP.md);<br>• `glossary.md:200` and `path-index.md:402`;<br>• the dangling `media.md`, `loops.md` and `feature-matrix.md` references.<br>The full list is in 09-docs §4a | M |
| **P0-F** Entry docs | Trim `CLAUDE.md` to rules with gates. The roadmap line points here, and the trust parenthetical becomes a link to `trust-tiers.md`. Rewrite `PROJECT-BRIEF.md` §3–§4 to fix contradictions C1–C6, C17 and C18, and replace the plan table with a pointer to this file. Rewrite `docs/README.md` as a one-row-per-doc map. Update `README.md:114` and `AGENTS.md`. **One stated reading order everywhere:** BRIEF → STATE → ROADMAP → docs/README → the agent-ref the BRIEF routes to | M |
| **P0-G** Headers + ops gap | Add the header to every doc, and a "historical" header to every audit file. Fix stale CMS-era prose (C14–C16). **Add `studio-workspace/` to `docs/deployment/backup-restore.md`**: today's backup guide skips the user's actual data (C22; server-engineer reviews) | M |
| **P0-I** CI | Re-land #86's still-missing CI change (run `bun run test` with bun pinned to 1.3.13) as a small new PR; #86 itself is 457 commits behind `main` | S |
| **P0-H** Gate (optional) | Add an architecture test: line 2 of every doc outside `audits/`, `archive/` and `state-archive/` is the header, and no tracked file names a known-dead doc path | S |

**Exit gate:** `wc -l STATE.md` ≤ 400; the root holds only `README`, `CLAUDE`, `AGENTS`,
`PROJECT-BRIEF`, `STATE` and `ROADMAP`; the grep for `inspector-disclosure.md` returns nothing; `bun test` is green on
the architecture gates that read docs.

---

## 5. Phase 1: never corrupt, never lie (the barrier)

Nothing that makes Studio smoother matters while it can write to the wrong element. **Every
P0 probe in 02-errors-client and 03-errors-writeback becomes a committed regression test in the bundle
that fixes it** (test-engineer pairs with each bundle).

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P1-A** Element identity guard | WB-1 (guard), ERR-4, WB-11 | Every value and structural edit carries the **expected opening-tag fingerprint** (tag plus hash of the opening tag's verbatim text) recorded at load. The server refuses `element-moved` on a mismatch, and the client silently resyncs and re-plans once. `moveNodes`, `deleteNodes` and undo's move re-issue go through `structuralCommitQueue`. `setJsxProp` refuses to overwrite a `{expr}` binding (`binding-overwrite`), and the MCP description that claims value edits never shift lines is fixed | parser-surgeon + store-engineer | M |
| **P1-B** State follows the element | ERR-5, ERR-10, ERR-23 | Both reload paths (`patchPages`, `loadSite`) remap `selectedNodeIds`, `activeInlineEdit`, `hoveredNodeId`, `enteredInstanceIds` and the drag session through `buildReparseNodeIdRemap`, and fall back to a module/tag/text fingerprint. A full reload becomes awaitable, and reloads carry a sequence token so a superseded response is dropped | store-engineer | S–M |
| **P1-C** Cache and batch correctness | WB-2, WB-7, WB-29, WB-23, WB-24, ERR-17 | The evaluator reports every source file it reads into the parse-cache dependency set. `dedupeStudioEdits` merges style patches and class sets instead of keeping only the last. `codeText` reaches `codeProps` (a one-line fix). A broken `tsconfig.json` falls back to no-tsconfig plus a warning instead of a 500. A page with syntax errors is write-locked, with a quiet in-frame badge. The localized-text baseline commits what was sent | parser-surgeon (+ store-engineer for ERR-17) | M |
| **P1-D** Notice outside edits | ERR-19, WB-1 (re-locate + watcher) | A debounced `fs.watch` on the open project (ignoring `.studio/`, `node_modules` and Studio's own writes) pushes the existing live-reload. An edit whose file hash changed is re-located through a line diff and re-verified against the fingerprint, and written only if exactly one candidate matches. This watcher is also PERF-8's invalidation source (P6-C) | server-engineer + parser-surgeon | M |
| **P1-E** No writer emits broken code | DET-1, IMG-1, SVG §2 defect 2 | Detach uses symbol-based prop substitution everywhere, substitutes `undefined` for omitted props, and passes a post-build free-variable gate. It aliases on a name collision (`styles` → `cardStyles`), mirrors side-effect CSS imports and carries `key`. **Every refusal leaves the file byte-identical.** The image landing contract gets one server-derived `src` (fixing `src="/src/assets/x.png"`), one project-dir helper, content dedupe and `wx` writes. The SVG→JSX converter writes `style` as an object, never a string | parser-surgeon · server-engineer + panel-designer · canvas-engineer | L / M / S |
| **P1-F** Undo tells the truth | ERR-1, ERR-3, ERR-2 (stop-gap), ERR-28, ERR-6 | `ScrubInput` commits on blur only if the user typed. Structural undo resolves each id's **owning page** instead of the active page. A refused delete-undo entry is skipped, so the stack never jams (the real restore lands in P3-F). A move or delete refused by the server rolls back through its inverse patches, and a network failure retries with backoff before rolling back | store-engineer + panel-designer | M |
| **P1-G** Close the `.studio/` write gap | 10-free-canvas FC-1 (security half) | `isWritableSourceRel` (`server/handlers/studioEditRouting.ts`) accepts any `.studio/*.tsx` path as a writeback target. Refuse every excluded directory. Later, FC-1 opens exactly the `.studio/canvas/<id>.tsx` pattern and nothing wider | security-guard + server-engineer | S |

**Exit gate:**
- Every reproduced finding has a committed regression test that failed before its fix: WB-1, WB-2, WB-7, WB-23, ERR-1, ERR-3, ERR-4 and ERR-5.
- A new e2e test edits a page file outside Studio mid-session, then edits and deletes on the canvas, and asserts the file changed exactly where intended.

---

## 6. Phase 2: feel

Order inside the phase: **P2-A first** (it commits the benches that measure everything after it).
After that, P2-B → P2-C → P2-E run serially, because all three edit `keybindings.ts` or the drag session. P2-D runs in parallel.
P2-F → P2-G → P2-H run serially (the inspector height gates). P2-I runs after P2-A.

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P2-A** Perf quick wins + benches | PERF-2, PERF-3, PERF-4, PERF-9, PERF-10, PERF-11, PERF-13; budgets 1, 2, 5, 6, 7 | **Benches first:**<br>• commit the subscriber-sweep bench (`01-perf.md` §1) into `bench:editor-store`, with a budget;<br>• generate a 40-frame × 300-node e2e corpus;<br>• a hover-sweep e2e (no animation frame over 20 ms);<br>• a pan-with-selection e2e (the toolbar stays on the ring);<br>• an idle rAF-count e2e.<br>**Then the fixes:**<br>• one shared `isSelectionChromeMutation` filter in all four frame observers, with rings toggled by attribute instead of mount/unmount;<br>• the toolbar and InPlaceInspector keep a board-space anchor and follow pan and zoom arithmetically;<br>• the rulers loop only while the viewport is active;<br>• live-runtime fit resets are debounced and attribute-only;<br>• lazy portal observers;<br>• equality guards on `hoverNode` and `setSelection`;<br>• selection chrome is scoped to the frames that contain the node | canvas-engineer + perf-hunter + store-engineer | M |
| **P2-B** Selection and keyboard hands | IX-2, IX-3, IX-4, IX-11, IX-15, ERR-11, ERR-21 | ⇧-click toggles on the canvas (OD-3). Tab / ⇧Tab cycle siblings (canvas-scoped only, never inside panels); the iframe bridge forwards Tab. ⌘A selects the siblings, and pressing it again climbs a level. `V` selects the move tool. The zoom keys and the Space/⌘0 listeners move onto the dispatcher, and the single-dispatcher gate is widened to `hooks/`. Window blur clears pan flags and latches. The input guard only matches text-entry inputs that are not read-only. **This bundle owns `keybindings.ts` for the phase** | canvas-engineer | M |
| **P2-C** Arrow keys | IX-1 | A flow child **reorders** along its parent's axis (`moveNode`). An absolute child **nudges** `left`/`top` by 1 px, or 10 px with ⇧. A held key is one undo entry and one source write, closed on keyup | canvas-engineer + store-engineer | M |
| **P2-D** Resize that obeys CSS | IX-6a, 6b, 6c, 6d, IX-18, ERR-12 | Convert the border box to the CSS width per `box-sizing`. A flex/grid child resize goes through `elementSizing`'s `sizingPatch('fixed')`. ⇧ locks aspect and ⌥ resizes from the centre, both read live. The W/N handles on an absolute element also move `left`/`top`. Add a W×H badge under the selection. A shared drag-session guard ends a drag when `buttons === 0` and cancels it on blur; guide drags use pointer capture | canvas-engineer (+ panel-designer for the sizing resolver) | M |
| **P2-E** Snapping and measuring | IX-5a, IX-5b, IX-6e, IX-24, IX-19 | Snap thresholds are in screen px ÷ zoom. The parent's edges and centre become snap peers. Resize edges snap. During a before/after drop, the parent of the drop target is outlined. With no hover target, Alt measures the selection against its parent | canvas-engineer | S–M |
| **P2-F** Design pane spacing *(the owner's ask)* | UX-1, UX-2, UX-3, UX-5, UX-6 | The props block gets a real 32 px header (the same recipe as every section), 8 px of bottom padding and a hairline. The between-section gap becomes a new `--inspector-section-gap` of 12 px (OD-4). Rows inside a group tighten to 4 px (props, Text, Measures). Shadow and Blur merge into **Effects**, which pays for the height. The ClassPicker fade shows only when scrolled. Update `measurement.test.ts`, `inspector-height.e2e.ts` and `05-section-heights.json` in the same PR, and rewrite the false "Penpot's gap is 8" comments | panel-designer | M |
| **P2-G** Component section | UX-7, UX-4, UX-14, UX-10, UX-16 | Instance props move directly under Measures. One title row ("Button · Local", with Detach and Swap as icon buttons) replaces three stacked bars. The section hides under multi-select instead of showing one instance's values. The label column widens from 68 to 96 px. Plain-text prop fields become draft-then-commit, with Esc to revert | panel-designer | M |
| **P2-H** Panel polish | UX-11, 12, 13, 15, 20, 21, 24, 25, 26, 27 | In the dark theme, field hover gets lighter instead of darker. Informative text moves off `--text-disabled` (2.7:1 contrast). Layers rows get a visible focus ring. The selected row is distinct from the hovered row. Layers and Agent get a skeleton on first open. Notice cards get an inset. Literal radii and dead tokens are removed | panel-designer | M |
| **P2-I** Selector sweep | PERF-1, PERF-12, PERF-14, PERF-5 | Hover moves off the global store into a canvas-local keyed notifier; `selectedNodeIds` gets the same keyed diff. The two `useShallow` selectors become primitives. The dead `isHovered`/`data-hovered` subscription is deleted. Always-mounted chrome narrows its whole-site subscriptions, and the gate pattern is widened. The inspector reads a deferred selection, so the ring paints first. Posters are captured only on the transition to offscreen, never for a live on-screen frame, and the busy listeners are registered in every frame | store-engineer + canvas-engineer + perf-hunter | M |

**Exit gate:**
- The hover-sweep, pan-with-selection and idle-rAF budgets pass on the large corpus.
- The selector-sweep bench is under budget.
- The owner dogfoods the P2-F spacing and the P2-B/C/D gestures on `test4`.

---

## 7. Phase 3: quiet editor ("it magically solves my issues")

The rule: **never show an edit the editor cannot keep, and never show a red toast for something
the editor could have done itself.** The dispositions for all ~158 toast sites and ~90 refusal reasons
are already written (02 §2, 03 §2). This phase executes them.

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P3-A** Toast and failure policy | WB-12, WB-13, WB-33, WB-35, ERR-13, ERR-18, ERR-22, ERR-24, ERR-25, ERR-26, ERR-29, and the 02 §2 SILENT/RETRY rows | Every value-kind failure gets a typed reason instead of the generic red "Some changes were not saved". Save-time refusals become warnings with a one-click remedy. Loads retry with backoff and get a Retry button. Every chrome seam gets its own silent error boundary, and "chunk failed" is shown only for real chunk errors. The server returns per-edit outcomes, so successes commit. A window `unhandledrejection` sink feeds diagnostics. Success toasts on canvas gestures are removed | store-engineer + panel-designer + server-engineer | M |
| **P3-B** Ordinary React renders | WB-3, WB-4, WB-26, WB-5 | Text inside container tags becomes an editable node. `memo`, `forwardRef`, `React.memo`, `export { default as X }` and `import * as UI` all unwrap. `React.Fragment` is a fragment. HOC-wrapped and class pages render (or show an empty state that names the shape), never a blank frame | parser-surgeon (+ canvas-engineer) | M |
| **P3-C** Value refusals become writes | WB-6, WB-8, WB-16, WB-17, WB-18, WB-19, WB-30, WB-31, ERR-14, ERR-15 | Two PRs.<br>(1) Text or props forwarded from a call site are written to the call-site literal. A resolved prop with an `origin` is written there. The editor picks a stylesheet automatically instead of opening the "which stylesheet?" modal. `no-editable-stylesheet` creates one.<br>(2) Style edits land after a spread or wrap an identifier. `className` adds wrap a ternary or call and add a missing CSS-module import in a post-batch pass. Name clashes import under an alias. Cascade refusals write to the winning declaration. Tailwind/compiled classes get "Apply to this element". `@container` and `@supports` are supported. An edit on a `.map` row is written to the template (OD-8) | parser-surgeon + panel-designer | L |
| **P3-D** Structural refusals become writes | ERR-7, ERR-8, ERR-16, WB-14, WB-15, WB-20, WB-21, WB-22 | Multi-select drag, ⌥-drag, paste and wrap become one gesture: a chained queue, one history entry. Copy/paste carries the verbatim JSX source, so a paste into another frame works. Non-adjacent group moves the members together first. Cross-file reparent goes through transplant. Deleting or moving `{cond && <X/>}` acts on the whole expression. Same-line siblings are split onto their own lines. A structural gesture inside a shared component applies to **this instance only** (OD-7): detach and replay, falling back to a component copy, as one gesture and one undo. List rows edit the array literal (OD-8) | store-engineer + parser-surgeon | L |
| **P3-E** Edits survive concurrent writes | ERR-9, WB-9, WB-10, WB-25, WB-32 | Unsaved edits are **rebased** onto a fresh page instead of being overwritten, and the toast that blamed "an agent" is removed. Text and style edits keep the file's formatting and quote style, which avoids line shifts. Each batch shares one ts-morph project per file, with a position-indexed lookup (40 edits took 3.8 s while holding the write lock). Locale JSON keeps its indentation and line endings | store-engineer + parser-surgeon + perf-hunter | M |
| **P3-F** Real delete undo | ERR-2 (full), DET-4 | **Start from draft PR #201 (`feat/undo-source-delete`)**, which already puts a deleted element back through a `reinsert-source` edit. Extend it to one **compare-and-swap restore journal**. Each one-shot write (delete, detach, swap, extract) records a pre-image at `.studio/undo-journal/<token>.json`. A new `restore` edit applies only if the file is unchanged since that write. ⌘Z after a delete restores the element. **Verify that `.studio/undo-journal/` is gitignored** and excluded from Studio's commit staging | server-engineer + store-engineer | M |

**Exit gate:** a new e2e **gesture sweep** on `test4` and the fixtures (drag, multi-drag, ⌥-drag,
delete, undo/redo across frames, paste across frames, type into an inspector field during a write,
edit inside a shared component). It must produce **zero `error`-kind toasts** and a file that matches the canvas
afterwards. Repeat the refusal-inventory count and record the before and after numbers in the STATE entry.

---

## 8. Phase 4: the assistant (runs in parallel from P1 on)

Files: `server/ai/**`, `server/ai/mcp/**`, `src/admin/pages/site/panels/AgentPanel/**`. These do not overlap with
P1–P3. The order follows 06 §7.

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P4-A** Truth fixes | AI-4, AI-5, AI-6, AI-24, AI-27 | `studio_list_tokens` reads `projectTokenIndex` (the CSS the canvas actually loads), grouped by family, with `file:line`. `mutates` splits into `requiresWrite` and `sideEffects`, so screenshots, comparisons, measurements and typechecks run in parallel and are never deduped into stale results. The phantom `studio_design_system_guide` is removed, and the A11 gate is extended to scan mode/policy blocks, tool descriptions and finding fix text. Schema errors return the expected shape | mcp-tooling + test-engineer | S |
| **P4-B** The prompt reaches the default path | AI-1, AI-3 | The static prefix, mode block and design-policy block go to the CLI via `--append-system-prompt`. Mode, policy and prompt version join the warm-session fingerprint. The generated `CLAUDE.md` keeps project **facts** only ("always use the DS, no third option" is deleted). A gate asserts that the CLI argv carries each policy and the subagent contract | mcp-tooling + server-engineer + test-engineer | M |
| **P4-C** The API-key path can build | AI-2, AI-8, AI-10, AI-11 | New tools `studio_write_file`, `studio_edit_file` and `studio_edit_files` (atomic), plus read, list, grep and `get_node_source`. They share one containment rule, the `agentWriteScope` deny list, the stale-hash guard, the turn write log and live-reload. **Security-guard review.** Transient 429/5xx errors retry with backoff. At 3 rounds left, the agent is told to wind down, and the cap ends with a summary round. `max_tokens` is set per model, and a response truncated mid tool call continues. `effort` maps to extended thinking or reasoning effort | mcp-tooling + security-guard + server-engineer | M |
| **P4-D** Creativity | AI-19, AI-12, AI-14, AI-16, AI-17, AI-15, AI-9 | Rewrite the prompt per 06 §2b, from one source for both paths:<br>• mode-first definition of done;<br>• decide before drawing;<br>• a craft rubric (hierarchy, rhythm, alignment, type, colour, touch targets, states);<br>• one self-critique pass;<br>• real content;<br>• initiative;<br>• the eSIM-project facts removed.<br>Also: mobile-app layout archetypes; `studio_component_snippet`; screenshots at several widths without mutating the board; `studio_arrange_frames` (x/y, grid); a `studio_set_tokens` CST codemod; the selection's `file:line`, excerpt and box in the digest, multi-select aware | mcp-tooling (+ parser-surgeon for tokens) | L |
| **P4-E** Assets for the agent | AI-13, AI-20 | `studio_find_icon` (fuzzy search over the DS catalogs). `studio_find_image` (licensed stock landed through `assetLanding.ts`, with attribution recorded; OD-11). `studio_list_fonts` and `studio_list_assets`. The prompt's asset ladder moves from "grey box" to "find, then say what should go there" | mcp-tooling + security-guard | M |
| **P4-F** Trust and panel | AI-7, AI-28, AI-18, AI-26, AI-22 | A pre-image checkpoint per turn, with "Changed N files", a per-file diff, "Revert turn" and per-file revert (refused if the user edited the file since). The panel docks full-height by default, with context-aware suggestion chips and a selection chip. Failures the agent recovered from render muted, not red. Variant thumbnails. History compaction with `claude-haiku-4-5-20251001`. Progress while arguments stream. Plan mode shown as an approvable checklist | panel-designer + server-engineer + mcp-tooling | L |
| **P4-G** Later | AI-21, AI-23, AI-25, AI-29 | Tier-2 `studio_lint`; `studio_delegate` for HTTP drivers; model routing by measured turn telemetry (`claude-opus-5-5` for build and creative turns, `claude-sonnet-5` for subagents and small edits, Haiku for utility calls; bench `claude-fable-5-1` first); trim tool descriptions to ≤ 900 characters each | mcp-tooling | M–L |

**Exit gate:** `bench:agent-turn` runs a creative brief and a match brief on both paths. The creative
brief produces no grey placeholder boxes, and the match brief passes `studio_compare`.

---

## 9. Phase 5: Figma-grade tools and the new features

**P5-A goes first:** both image paste and SVG paste need ⌘V driven by the browser's `paste`
event. Today the keydown handler calls `preventDefault`, so a paste event never fires.

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P5-A** One paste pipeline | IMG-4 (base), SVG-5 (clipboard part) | ⌘V is dispatched from the `paste` event, bridged from every frame document (`canvasClipboardBridge.ts`). Copying writes a Studio marker with `copiedAt`, so paste can tell "nodes I copied" from "a newer image or SVG on the OS clipboard". Test the Safari and Firefox paste-event behaviour, with a `navigator.clipboard.read()` fallback | canvas-engineer + store-engineer | M |
| **P5-B** Images | IMG-2 … IMG-11, IX-img | In order:<br>1. Multi-file drop as **one** insert of N siblings: one write, one undo (`insertJsxElement` gains siblings; this lands before SVG-5's subtree insert).<br>2. Dropping onto an `<img>` replaces it (⌥ inserts instead).<br>3. An optimistic ghost from an object URL, plus upload progress.<br>4. Intrinsic width and height, clamped to the container; ⌘-drop places absolutely.<br>5. ⇧-drop sets a background image.<br>6. Image paste.<br>7. ⇧K opens a file picker.<br>8. URL drag from another tab (OD-13, security review).<br>9. An Assets "Images" section with drag to canvas.<br>10. Import-convention mode (OD-12).<br>11. An asset ledger plus an explicit "delete unused" | canvas-engineer + server-engineer + store-engineer + panel-designer; security-guard on IMG-5/11 | L |
| **P5-C** Detach | DET-2, DET-3, DET-5, DET-6, DET-7 | Handle call-site spreads and component `...rest`. **One `detachInstances` action** behind the button, both context menus, **⌘⌥B** and the refusal remedy. A pre-commit confirm appears only when something is lost (other branches, N rows, moved hooks). Undo goes through P3-F's journal. Context-reader hooks (`useLanguage()`, 42 of 139 corpus refusals) move into the enclosing component; state hooks still refuse. Then **"Expose as prop"** (OD-9): the component gains an optional prop whose default is the old literal, so no other instance changes | parser-surgeon + store-engineer + panel-designer | L |
| **P5-D** SVG | SVG-0 … SVG-9 (then SVG-10/11 later, OD-10) | SVG-0 (render `<svg>` as itself, without the `display:contents` span) and SVG-1 (a pure `@core/vector` path engine, new barrel) run in parallel. Then:<br>• SVG-2: import clean-up — `style`/`<style>` to attributes, fragment-only `href`, id remapping; security-guard reviews.<br>• SVG-3: source-location stamps on SVG parts, stripped everywhere markup leaves Studio.<br>• SVG-4: a new `svg-attr` edit kind.<br>• SVG-5: paste, drop and icon insert (on P5-A and P5-B's multi-node insert).<br>• SVG-6: vector edit mode in a board-space overlay; each gesture is one write.<br>• SVG-7: pen, pencil, line and arrow, after P5-E's armed-tool model.<br>• SVG-8: a Vector section in the design pane.<br>• SVG-9: perf and e2e gates — zero React commits per move, p95 ≤ 16.7 ms on a 2,000-anchor path at every zoom, one `/save` per gesture | canvas-engineer (owner) + parser-surgeon + server-engineer + panel-designer + perf-hunter | L+ |
| **P5-E** Tools and handles | IX-12, IX-8, IX-16, IX-17, IX-10, IX-props, IX-7, IX-9, IX-20, IX-21, IX-26, IX-27, UX-22, UX-23 | Armed R/O/T/F/E tools (OD-5). Drag from the Assets panel to the canvas. An in-frame marquee (OD-6). **On-canvas padding and gap handles** (⇧ sets the axis pair, ⌥ all four). ⇧A adds a flex layout. ⌘⌥C / ⌘⌥V copy and paste style. ⏎ selects all children or starts a text edit. Bring to front and back. ⌥A/D/W/S/H/V align. Free move keeps `right`/`bottom` anchoring. Context menus and tooltips show shortcuts (one source: the keybinding registry) and gain Group, Ungroup, Lock and "Select layer" | canvas-engineer + panel-designer | L |
| **P5-G** Free canvas (OD-14) | FC-1 … FC-n | Loose layers on the empty board: elements, component instances, images and SVG shapes that persist but are never part of a page, the live preview or a publish. They can be dragged into frames and out again. The armed tools (P5-E) and the SVG draw tools (P5-D) draw there when you start on empty board. Design and work orders: `10-free-canvas.md` | canvas-engineer (owner) + parser-surgeon + store-engineer + server-engineer + panel-designer; **security-guard on FC-1** (it closes the gap where `isWritableSourceRel` accepts any `.studio/*.tsx` path) | L |
| **P5-F** Backlog | IX-5c/d/e, IX-6f/g, IX-13, IX-22, IX-23, IX-25, IX-misc, UX-8, UX-9 | Snap to guides and to equal spacing; snap toggles; double-click an edge to Hug; multi-select resize; the B board-draw tool; multi-select free move; grid-cell drops; rotation (the CSS `rotate` property, never `transform`); opacity keys 0–9, flips and aliases; chevrons visible when collapsed; a useful empty-selection panel | canvas-engineer + panel-designer | L |

**Exit gate:**
- The SVG-9 budgets pass.
- The image-drop, detach and vector e2e specs are green.
- The owner dogfoods the shortcut matrix (04 §1) against Figma.

---

## 10. Phase 6: scale

| Bundle | Closes | What changes | Owner | Effort |
|---|---|---|---|---|
| **P6-A** Reconcile after writes | PERF-6 | `patchPages` reuses node objects and style-rule objects that are deep-equal, and re-keys moved nodes through the relocation map, so a write re-renders only what changed and no frame restyles for nothing | store-engineer | M |
| **P6-B** Cold and warm load | PERF-7, PERF-8 | Parse in viewport order and stream each page to the client as it is parsed. Persist the parse cache in `.studio/cache/`, keyed by content hash. Invalidate `/load` from P1-D's watcher instead of walking and statting every file; use an LRU of projects; replace the 32-bit fingerprint | server-engineer + parser-surgeon + store-engineer | L |
| **P6-C** Remaining budgets | 01 §3 items 3, 4, 8–13; PERF-15 | Selection → ring < 32 ms; keystroke → paint; re-render count after a structural write; first frame interactive in < 2 s warm on a 40-page repo; no long task within 1 s of a click after an edit; heap and detached-document count; `/load` on a 1,000-file repo; a Tier-2 animated fixture. Profile the `will-change` toggle before changing it | perf-hunter + test-engineer | M |

---

## 11. Collision map (what must not run at the same time)

| Hot file / area | Bundles | Rule |
|---|---|---|
| `src/admin/spotlight/keybindings.ts` | P2-B, P2-C, P5-C (⌘⌥B), P5-D (vector keys), P5-E | One bundle at a time. P2-B's owner sets the conflict register (OD-3) in the file header |
| `server/handlers/studioEditSchemas.ts`, `studioWriteback.ts` | P1-A (fingerprint), P3-A (typed reasons), P3-F (`restore`), P5-D SVG-4 (`svg-attr`), P5-C DET-7 | Serial. Each adds one edit kind or field |
| `src/core/ast-codemods/insertJsxElement.ts`, `InsertEditSchema` | P5-B IMG-2 (siblings), IMG-10 (`__assetImport`), P5-D SVG-5 (subtree) | IMG-2 defines the multi-node insert first |
| `canvas/useCanvasNodeShortcuts.ts` (⌘V) | P5-A only | IMG-4 and SVG-5 consume P5-A; they do not edit this file |
| `store/slices/site/lifecycleActions.ts` | P1-B, P3-E, P6-A | Serial |
| `studioSourceWrites.ts` | P3-D, P5-D SVG-5, SVG-6 | Serial |
| Inspector CSS + `measurement.test.ts` + `inspector-height.e2e.ts` | P2-F → P2-G → P2-H → SVG-8 | Serial; each updates the height gates |
| `detachComponent.ts` | P1-E, P5-C | P1-E first |
| `NodeRenderer.tsx`, `selectionSlice.ts` | P2-B (IX-2), P2-I (PERF-1) | P2-B first |
| `STATE.md` | P0-C | Frozen during P0-C; handoffs go to a scratch file per `standing-05` |

---

## 12. Definition of done for the program

- [ ] P0: one root plan (this file), `STATE.md` ≤ 400 lines, a header on every doc, zero references to dead doc paths.
- [ ] P1: every reproduced data-loss and undo bug has a regression test that failed before its fix; the edit-outside-Studio e2e is green.
- [ ] P2: the hover-sweep, pan-with-selection, idle-rAF and selector-sweep budgets are green on the 40 × 300 corpus; the owner has dogfooded the design pane and gestures.
- [ ] P3: the gesture sweep e2e shows zero `error`-kind toasts; the refusal inventory's before and after counts are recorded.
- [ ] P4: both assistant paths receive the same guidance, both can write, the creative bench shows no placeholder boxes.
- [ ] P5: every P0/P1 row of the Penpot shortcut matrix is present; image, detach and SVG e2e specs are green; the SVG perf budgets pass.
- [ ] P6: the warm first frame is under 2 s on a 40-page repo; all the budgets in 01 §3 exist and are green.

## 13. Open work carried from the archived plans

**Already merged into the integration head** (`chore/integrate-open-drafts`, PR #217, STATE `meta-19`):
- The speed plan's work orders #205–#216 (autosave cadence, optimistic style in live frames, hover coalescing, refusal within keydown, and #211–#216 from `tmp/speed-integration`). Its open orders (speed-07, speed-08, speed-09) are in the tables below; the plan itself is archived at `docs/archive/plans/STUDIO-SPEED-PLAN.md`.
- The live-frame fixes #202–#204 and #209.
- The trust default change (#198).
- #199, #200, #201 and #192.

**Baseline:** `bun test` on the integration head has **16 failures that predate this program**. They are live dev-server timeouts, WebSocket and live-frame measurement tests, optimistic-broadcast tests, a Windows path bug in `withWorkspaceProject`, and a bundle-freshness check (probably local bun 1.3.6 against CI's 1.3.13). A bundle is clean when it adds no new failure. Fixing the Windows path bug belongs in P1-C.

Before starting a bundle, check whether one of these already covers part of it. For example, #208 overlaps PERF-11 and PERF-1, and #201 overlaps ERR-2.

### The product bar (IMPORT-V2 §1, in the owner's words)

The ten asks the whole import roadmap answered, kept here as the bar every bundle is measured against:

1. Import from GitHub **or upload**.
2. "Add all the styles", and "import the npm packages … and modules for npm packages".
3. Edit local components, and pass props at call sites.
4. Smooth, no canvas glitch, the menu not far from the selection.
5. Detach an instance to source.
6. A right panel closer to Figma.
7. Set all pages to one width; select all for bulk actions.
8. Swap instances, upload images, dropdowns for known props.
9. Freeze animation, kill all scroll.
10. MCP tools for visual audit, bulk edits and structural guidance.

### Open rows carried from the archived plans (2026-09-23)

Each row names its source (plan section or STATE id) and the bundle above that already covers it, if any. Rows marked *unverified* were open when their plan was last updated and were not re-checked against the code on 2026-09-23.

**Canvas and drag-and-drop**

| Row | Source | Covered by |
|---|---|---|
| Remove `@dnd-kit/core`: the DOM panel's layer tree and `AdminCanvasEditorBody.tsx` still use it; a tree-row adapter on the shared drag session does not exist (`docs/reference/canvas-dnd.md` → "The D2 target architecture") | PARITY D2 | none |
| Shadow + Blur become one Effects section (41 px of the F2 text-layer budget) | FEEL "still open", `panel-41` | P2-F (OD-4) |
| Frame pool: keep bridge frames alive across page switches; prefer posters over a second live document while booting. (The two pools are already one, `framePool.ts`.) | SPEED speed-09 | none |
| Remove the Tier-2 branches that still call `componentBundle.ts`; run the Track L exit check on a real Tier-2 board | LIVE-CANVAS L9 | none |
| E2.5 panel surfaces: work in the tree, never verified (*unverified*) | PARITY §0a | none |
| A7: Figma Dev Mode discoverability (*unverified*) | PARITY §0a | none |

**Writeback and parser**

| Row | Source | Covered by |
|---|---|---|
| Package-instance detach | IMPORT-V2 WS-4.4 | P5-C (partly) |
| Emotion object styles (`css({ … })`, object `css` prop): refused by name on both sides | NEXT-WS WS-14.1 | none |
| Storybook story `args` writeback: args-only call sites are locked | NEXT-WS WS-14.3 | none |
| Selection colours: with 2+ nodes selected, list every distinct colour and rewrite them in one edit | NEXT-WS WS-14.4 | none |
| `runScripts` default for freezing JS animation | IMPORT-V2 WS-8.1 | none |
| `back`-shaped derived flows (`router.back()`, `navigate(-1)`) are not drawn | PROTOTYPE §9 | none |
| Single undo step for Hug/Fill mode switches and constraint crosshair clicks (*unverified*) | WAVE7 W8-4 | P1-F (partly) |
| Indeterminate state for `AlignGrid` / Clip content under multi-select (*unverified*) | WAVE7 W8-3 | none |

**Speed and budgets**

| Row | Source | Covered by |
|---|---|---|
| Project open: `/load` measured 1.05 s; target ≤ 300 ms warm (cache the CSS registry by stylesheet mtimes, stream the first page, never block load on git or thumbnails) | SPEED speed-07 | P6-B |
| Budgets for click-to-ring, keydown-to-dialog, panel-edit-to-frame, hover store writes and load time in the `e2e-budgets` CI job (partial: cold click and the refusal dialog exist) | SPEED speed-08 | P2-A, P6-C |
| The board bench's budgets are uncalibrated | IMPORT-V2 WS-5.6 | P2-A |
| Live-frame memory baseline (`docs/audits/2026-09-13-live-frame-memory-baseline.md` is a placeholder) | LIVE-CANVAS L8 | P6-C |
| W9-5 speed levers 4–6 and an on-disk parse cache for the Stop hook (*unverified*) | WAVE7 | P6-B (partly) |

**Assistant** (all *unverified*, from the Waves 7–10 closing status of 2026-09-07)

| Row | Source | Covered by |
|---|---|---|
| `studio_ingest_design_text` and text diffing; strict mode should refuse to claim text fidelity until it exists | WAVE7 W9-3 | none |
| The creative and balanced halves of the mode-aware Stop gate | WAVE7 W9-2 | P4-D (partly) |
| Connector-state UI in the Agent panel | WAVE7 W9-4 | P4-F (partly) |
| Variant fan-out: `studio_plan_variants` plans, nothing creates the pages | WAVE7 W9-3 | none |

**Security and server** (FEEL "still open")

| Row | Source | Covered by |
|---|---|---|
| `GET github/device/poll` writes a credential under a GET; closing it changes how the route gate keys CSRF | `sec-18` | none |
| `GET /load` spawns the Tier-1 style compiler at `site.read`; documented in `capabilities.md`, not gated | `sec-18` | none |
| `ensureClaudeCliConfigDir` is fail-soft where Studio's own secret writers fail closed | `sec-18` | none |

**End-to-end suite**

| Row | Source | Covered by |
|---|---|---|
| The cold `bun run test:e2e` suite is not green (23 pass / 64 fail / 13 skip on 2026-09-18); every failure needs a verdict: delete the spec, move its fixture, fix the product, or annotate it with an owner. About 56 of the failures are CMS-half specs driving UIs PR #18 deleted | FEEL §8 (the one unmet DoD line), `verify-4`, `e2e-1` | none |

**Docs, tooling and the CMS half**

| Row | Source | Covered by |
|---|---|---|
| Dead-code sweep (`npx fallow dead-code`, `knip`), with `bun run fallow:health` before and after; `fallow:health` could not complete on 2026-09-07 | NEXT-WS WS-14.7, WAVE7 | none |
| `no-circular-dependencies` fails as a 60 s timeout, not a cycle (`madge` alone takes about 82 s) (*unverified*) | WAVE7 | none |
| The MCP server still names itself `alm-figma-killer` (`server/ai/mcp/server.ts`); a stray `pnpm-lock.yaml` sits at the root of a Bun-only repo | WAVE7 | none |
| Split the docs over the ~600-line ceiling: `docs/features/agent.md`, `inspector.md`, `studio-import.md`, `docs/agent-refs/canvas-internals.md` | 09-docs §1 | none |
| CMS removal, Tier 1 (safe, larger): the plugin subsystem, about 20,000 lines across `server/plugins/`, `src/core/plugins/`, `src/core/plugin-sdk/` and the QuickJS bootstrap; 18 architecture gates and about 14 docs change with it | CMS-REMOVAL | none |
| CMS removal, Tier 2 (blocked on the owner, below): `server/publish/**`, and the CMS bundle import/export in `SiteImportModal` (a surgical split, since the same modal carries the live "drop a folder of HTML/CSS" importer) | CMS-REMOVAL | none |

### Open questions for the owner

- **Do live CMS installations still matter for this fork?** Yes: stop CMS removal at Tier 1 and gate rather than delete. No: `server/publish/**`, the CMS bundle import/export and the CMS persistence adapter can go, leaving one adapter and one code path. Sub-questions: do external MCP clients still need `site_publish`, and is portable full-site export/import between installations still a requirement? (CMS-REMOVAL "the decision")
- **Should an Admin hold `studio.git.write`?** Today the HTTP git surface is gated on `site.structure.edit`, so Admin keeps the Version control panel without the agent's commit right. (`sec-14`)
- **GitHub device-flow sign-in needs `GITHUB_OAUTH_CLIENT_ID`**, which only the owner can create (a GitHub OAuth App with Device Flow enabled). Until then G8 runs through the paste-a-token path. (`git-23`)
- **How far to take Tailwind** beyond class edits (utility autocomplete, arbitrary values, variant prefixes)? (PARITY §15.5)
- **Compact spacing and border rows** by default, with the diagram behind a toggle? Track P's Penpot rebuild may have settled this; confirm. (PARITY §15.4)
