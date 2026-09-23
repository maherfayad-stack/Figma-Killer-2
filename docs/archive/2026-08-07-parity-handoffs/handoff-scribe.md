# studio-scribe handoff — PROJECT-BRIEF.md corrections (Phase 0, exit criterion 3)

**File touched:** `C:\Users\Admin\Documents\GitHub\Figma Killer 2\PROJECT-BRIEF.md` only.
Nothing staged, nothing committed. `docs/reference/canvas-dnd.md` and `STATE.md`
were not touched, per scope.

## All six corrections verified against code and applied

1. **npm package components** — confirmed working. Read
   `server/handlers/studio/componentBundle.ts:294` (`tryServeStudioComponentBundle`)
   and `src/admin/pages/site/studio/registerProjectModules.ts:476`
   (`useRegisterProjectModules`); both match the plan's line references exactly.
   Moved from "does NOT work" to "works today" with two boundaries I found and
   added (not in the plan's table, but load-bearing for anyone reading the
   claim without them): (a) gated on trust tier ≥ 1 — Tier 0 shows a
   placeholder, no fetch/execution; (b) the **insert picker** still only lists
   `@alm-design/design-system` (unconditionally registered) plus whatever
   `pkg.*` the loaded board already calls — a package never yet used anywhere
   in source has no picker row until something else seeds a first call site.
   This second point is audit finding D2 in `docs/audits/2026-08-06/
   02-design-system-authoring.md` — genuinely still a gap, just a narrower one
   than the brief's old blanket claim.

2. **Instances / swap / detach** — confirmed working. Read
   `src/core/page-parser/inlineLocalComponents.ts:321` (the `instanceOf` node
   mint) and `renderModuleTabContent.tsx:99` (routes `studio.instance` to
   `InstanceCallSiteView`) — line numbers hold. Confirmed the e2e evidence via
   `STATE.md` grep (parser-05 and instance-ui-01 entries, `tests/e2e/
   instance-selection-ui.e2e.ts` and `instance-fragment-node.e2e.ts` both
   passing against the real eSIM board) rather than trusting the stale
   `STATE.md:4530` pointer, which had drifted — I cited the test files by name
   instead of a line number for durability. Moved to "works today" with the
   real numbers from `STATE.md`'s parser-05 entry (~42% clean-detach rate on
   the real corpus; the rest are correct refusals for hooks/no-writable-
   location, not bugs) and instance-ui-01's named gaps (swap candidates are
   board-local only; package-sourced instances can't be detached).

3. **CSS write-back** — confirmed the narrow framing is correct. Read
   `src/admin/pages/site/studio/styleRuleWriteback.ts` in full: an unmapped
   rule (no hand-authored `.css` source — Tailwind/Sass/CSS-Modules-compiled,
   or a framework-generated utility) is reported via `unmapped`, never
   written; a real `@media`/breakpoint change is separately reported via
   `unwritableContexts`, also never written. Only a value change to an
   existing declaration in an existing rule, in the board's synthetic
   viewport context, actually diffs and writes (`collectStyleRuleEdits`).
   Confirmed server side too: `studioCssWriteback.ts` imports `setDeclaration`
   from `@core/css-codemods`, a real postcss CST round-trip; `setDeclarationAtMedia`
   exists but isn't wired in yet. I split the brief's single row into two
   precise, separately-labeled non-working items (creating new CSS; writing
   under a real breakpoint) rather than one blob, per the task's instruction
   to make this the most unmissable fact in the doc.

4. **New page creation** — confirmed working. Read
   `server/handlers/studio/pageScaffold.ts:68` (`createScaffoldedPage`) — matches
   exactly, including the three wiring points the plan cites (`NewPageButton.tsx`,
   HTTP route, MCP `studio_create_page`). Added a "works today" bullet; there was
   no existing false claim to remove (the brief never explicitly listed page
   creation as a gap), so this is purely a preemptive correction against the
   omission an agent could misread as "not built."

5. **BreakpointFrame** — confirmed load-bearing. Read
   `src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx:659` —
   every board frame wraps a `<BreakpointFrame>`. Read `BreakpointFrame.tsx`'s
   own doc comment: it's the shared design-mode viewport both board mode and
   Live mode use (via `IframeFrameSurface`). Added an inline clause to the
   existing "iframe-per-frame canvas" bullet rather than a new one, since
   there was no explicit false claim to replace — same "preemptive" situation
   as #4.

6. **Trap 11 (perf)** — confirmed both halves. `PropertiesPanelBody.tsx:100`
   reads `s._textOriginKeyToCount` (O(1)); `findNodeById.ts:29-49` reads
   `s._nodeIdToPageIds` (O(1) + O(pages) `find`, not O(pages×nodes)). Both
   fixed, as claimed. Found and confirmed the new, worse defect independently
   by reading `store.ts:300-310` (`selectCanvasPageFor` — uncached `Array.find`
   over pages and frames) and `NodeRenderer.tsx:70` + `:135-139` (two separate
   per-node selectors calling it on every mount, every store commit, in board
   mode where `pageId`/`frameId` are always both set). Rewrote trap 11 in
   place with the real numbers, sourced from
   `docs/audits/2026-08-06/05-canvas-performance.md` (P1): ~30-60 comparisons
   on the current 15-page/803-node corpus, projected ~64,000+ comparisons per
   store commit on the docs' 40-page/800-live-node stress board. Cited the
   exact fix (`selectActivePage`'s sweep-scoped single-slot memo, seven lines
   above `selectCanvasPageFor` in the same file) so the note is actionable,
   not just a warning.

## A seventh false claim found while verifying #1 — corrected in the same edit

The brief's old "What does NOT work" list closed with: *"adding a component
whose package the project does not depend on yet ... install it from the
Dependencies panel"* — presenting the Dependencies panel as a working remedy.
It is not. Read `src/admin/pages/site/panels/DependenciesPanel/DepsSection.tsx`
directly: the "Add package" handler (`:141`) calls `setDependency` (writes
only the in-memory `site.packageJson`) followed by a literal
`// TODO(Phase G): ask the site bridge to install this in the user site.`
comment (`:144`), same on remove (`:170`). Nothing reaches disk, nothing runs
`bun install`. This is audit finding K13 in
`docs/audits/2026-08-06/12-components-and-slots.md`. Since this sentence sits
in the exact same "does NOT work" list I was already rewriting for the six
official corrections, I corrected it in place rather than leaving a
newly-verified-false claim standing — the brief now states plainly that
neither remedy path (Dependencies panel's CMS half) works. Flagging it here
explicitly in case this was meant to stay out of scope; it's a small, low-risk
addition immediately adjacent to row 1's edit, not a separate section.

## Gaps I could not fix (out of scope, noted for the orchestrator)

- `docs/agent-refs/path-index.md` does not list `pageScaffold.ts`
  (audit D1's own note: "flag for studio-scribe to add `pageScaffold.ts` to
  `path-index.md`"). I did not touch it — out of scope for this task
  (PROJECT-BRIEF.md only). Someone should add it in a future doc pass.
- `docs/reference/canvas-dnd.md` is confirmed still materially false (per the
  parity plan's own note) — not touched, per explicit instruction; the
  canvas-engineer agent owns it this wave.
- I did not touch `STATE.md`. The orchestrator merges it once at the end per
  the task's constraints.

## Verification

Did not run `bun test`/`bun run build`/`bun run lint` (instructed not to,
siblings running concurrently). This was a documentation-only change; no code
paths were touched. Confirmed no dangling markdown links introduced (grepped
every `](...).md)` target in `PROJECT-BRIEF.md` against the filesystem — all
resolve). Confirmed via `git status`/`git diff --stat` that only
`PROJECT-BRIEF.md` is modified by my work; all other pending changes belong to
sibling agents.
