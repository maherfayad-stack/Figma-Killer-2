# Track B1's deferred branch — creating a co-located stylesheet — handoff

Status: **complete**, working tree only (nothing committed/staged). Builds on
the prior agent's `handoff-b1-css-engine.md`; reuses its published contracts
(`CssEditSchema`'s `kind`/`op` two-level discriminant, `insertRule`,
`classifyStylesheetEditability`) without redesigning them.

## Final destination-resolution order

`resolveCssInsertDestination(rule: StyleRule)` in
`src/admin/pages/site/studio/styleRuleWriteback.ts` (now takes the rule —
was zero-arg before this pass):

1. **The one editable stylesheet this workspace already knows about** —
   every DISTINCT `classifyStylesheetEditability(...).kind === 'plain-css'`
   file already named across `styleRuleSources`, if there is exactly one.
   → `{ ok: true, kind: 'existing', file }`, emits `op: 'insert'`. Unchanged
   from B1.
2. **Refuse `ambiguous-stylesheet`** when there is MORE than one candidate,
   naming every one. **Never creates** — this branch is about multiple
   EXISTING choices, not about needing a new one (renamed from B1's shared
   `no-editable-stylesheet` reason so the two zero-vs-many cases are
   distinguishable; nothing outside this module reads `.reason`
   structurally — see B1's own note that it's folded into `unmapped`'s
   label text).
3. **Zero candidates — try to name the rule's PAGE.** Only a
   NODE-SCOPED rule (`scope: { type: 'node', nodeId, role: 'module-style' }`
   — `ensureNodeStyleClass`'s auto-created per-element classes, the common
   "style this element directly" path) carries a `nodeId`, and only when
   that id is a real STUDIO source location (`@core/page-tree`'s
   `decodeSourceNodeId`, `rel:line:col`, works through `.map`/inline
   suffixes too) does it name a file. If it resolves →
   `{ ok: true, kind: 'create', pageFile }`, emits `op: 'create'`.
4. **Else refuse `no-editable-stylesheet`** — zero candidates AND no page
   association (a freestanding class made via ClassPicker's "create class"
   with nothing selected has no `scope` at all — genuinely nowhere honest to
   co-locate a new file, so this refuses rather than guessing "the
   currently open page", which this module has no notion of at all).

Every refusal is named and surfaced through `collectStyleRuleEdits`'s
existing `unmapped` channel (`${label} — ${destination.message}`), same as
B1 shipped.

## Naming/location convention detection (server-side, `applyCssCreateEdit`)

`detectStylesheetConvention(dir)` in `server/handlers/studioCssWriteback.ts`:
walks the whole workspace with the existing, already-shared
`listWorkspaceFiles` (bounded, symlink-free, `EXCLUDED_WORKSPACE_DIR_NAMES`-
respecting — the same walker the download zip and GitHub-import writer use),
counts `*.module.css` vs. every other `*.css`, and picks the majority.
**A tie (including "no stylesheet anywhere yet") resolves to plain `.css`**
— it needs no JS binding at all, so it's the lower-risk default when
nothing in the project says otherwise. This runs server-side because
convention detection needs a full workspace file listing the client does
not have (the client only knows the stylesheets its already-parsed rules
point at — see `resolveCssInsertDestination`'s own honest-scope doc).

The co-located path is `<page-dir>/<page-basename>.css` or
`.module.css`, computed from the page's own validated path segments
(`coLocatedStylesheetRelPath`).

## Reachability — the "unreachable class" refusal

`ensureStylesheetImport` in `studioCssWriteback.ts` NEVER produces the
mismatched pairing by construction: it branches on `convention` for every
import it writes — a `.module.css` always gets a `defaultImport` binding
(collision-safe local name, `styles`/`styles2`/… via `topLevelBindingNames`
from `@core/ast-codemods`), a plain `.css` never does. The one case that
can still go wrong is an import for the EXACT computed specifier already
existing with the wrong shape (an earlier inconsistent run, or a hand
edit) — that REFUSES by name (`stylesheet-import-shape-mismatch`) rather
than silently proceeding, which is the concrete, tested form of "refuse
rather than write something that renders as nothing." Covered by
`cssInsertIntegration.test.ts`'s `'refuses rather than write an
unreachable class when an existing import has the wrong shape…'` — proves
NEITHER the stylesheet nor the page's existing (wrong-shaped) import is
touched.

## How a created-file decision is surfaced to the user

Three layers, each landed as far as ownership boundaries allow this wave:

1. **Server → wire.** `StudioEditBatchResult.createdStylesheets: { nodeId,
   file }[]` (new field, `server/handlers/studioWriteback.ts`), mirroring
   `swapDetails`'s existing pattern exactly. `nodeId` is the edit's own
   synthetic id, `css:create:<ruleId>` — `ruleIdFromCssCreateNodeId` (new,
   exported from `styleRuleWriteback.ts`) decodes it back. Threaded through
   `POST /admin/api/studio/save`'s JSON response in `server/handlers/
   studio.ts` and automatically through `studio_apply_edits` (MCP —
   `editTools.ts` spreads the whole result, no MCP-side edit needed).
2. **Wire → client schema + ready-to-call helper.** `StudioSaveResponseSchema`
   (`src/admin/pages/site/studio/studioSaveRequests.ts`) gained the matching
   optional `createdStylesheets` field, plus a NEW, fully implemented and
   unit-tested function `notifyCreatedStylesheets(result, styleRules)`:
   decodes each `nodeId` back to a rule id, calls `recordCreatedStylesheet`
   (below) so the rule is writable via `set` next time with no reload, AND
   pushes a success toast naming the exact file and the class it belongs
   to — "Studio created `<file>` and wired it into your page for `<name>`."
   This is the literal implementation of requirement 3 ("a created file is
   a bigger surprise than a chosen one — it must be visible and
   attributable").
3. **Not wired into the live autosave path.** `fsCodemodAdapter.ts` is
   explicitly out of my ownership this wave (B2 owns it). Its `saveSite`
   is the one place that would actually call
   `notifyCreatedStylesheets(result, site.styleRules)` — one line, right
   alongside its existing `unexplainedSkips`/`shifted` handling. Flagged in
   that file's own `StudioEditPayload` doc comment for the next owner.
   **Absent that one line, a `create` edit still fully lands on disk and is
   NEVER silent** — the toast just doesn't fire yet, and the rule becomes
   writable again on the NEXT page load regardless (the created file is
   picked up like any other `.css` file `studioCss.ts` parses). This is the
   same "structural seam is real and tested, one call left for the next
   owner" posture B1 itself used for `unmapped`'s wording gap.

## Client write-back map: `recordCreatedStylesheet` / `commitBaseline`

`commitBaseline`'s existing per-rule auto-synthesis (B1) now ONLY fires for
an `existing` destination — synthesizing a source for `create` would mean
guessing the server's file-naming decision, exactly the fabricated-write-
target bug this whole module exists to prevent. New exported
`recordCreatedStylesheet(ruleId, file, selector)` is the explicit
`create`-branch counterpart: called once the save response is known (by
`notifyCreatedStylesheets`, or directly in tests), it sets
`styleRuleSources[ruleId]` so the SAME rule takes the ordinary `set` path
on its very next edit. Proven end-to-end, no reload, real temp files, in
`cssInsertIntegration.test.ts`.

## Wire contract — new op

`CssEditSchema` (`server/handlers/studioCssWriteback.ts`) gained a THIRD
member alongside B1's `set`/`insert`, same `kind: 'css'` outer + `op` inner
two-level discriminant B1's own handoff told the next op to use:

```ts
{
  kind: 'css'
  op: 'create'
  nodeId: string       // `css:create:<ruleId>` — decodable via ruleIdFromCssCreateNodeId
  pageFile: string      // workspace-relative .tsx/.jsx/.ts/.js the rule co-locates with
  selector: string
  declarations: Record<string, string>
  atMedia?: string      // carried for parity, unused this pass (same as `insert`)
}
```

`applyCssEdit` branches on `edit.op === 'create'` FIRST (before the
`file`-based checks, since `create` carries no `file`) and dispatches to
`applyCssCreateEdit`, which runs, in order: page-path containment/existence
→ convention detection → co-located path computation → that path's own
`classifyStylesheetEditability` (defends against a page living inside an
unexcluded-but-compiled-looking dir like `build/`/`out/`) →
`resolveStylesheetCreationPath` containment (parent-dir real-path
containment; the file itself is allowed not to exist yet, but must not
already be a directory/broken symlink if it does) → `ensureStylesheetImport`
(the reachability gate, above) → `insertRule` on the (possibly still empty)
existing content.

## Filesystem safety

- `safeRelSegments` — the shared segment/extension/`EXCLUDED_WORKSPACE_
  DIR_NAMES` validator every guard in `studioCssWriteback.ts` now builds on
  (existing `resolveContainedCssPath` refactored onto it too, behavior
  unchanged — verified by the untouched B1 tests still passing).
- `resolveContainedSourcePagePath` — the NEW page-path guard: same string
  checks + REAL-PATH containment after resolving symlinks, and the file
  MUST exist (there is no page to co-locate a new file with if it can't be
  found).
- `resolveStylesheetCreationPath` — the NEW creation-target guard: same
  checks, but only the PARENT directory's real path is required to exist
  and be contained (the leaf file is allowed to not exist yet); refuses if
  the target already exists as anything other than a plain file.
- All three real-path checks run — a workspace can arrive from GitHub, and
  git stores symlinks, so a textual check alone is bypassable (the standing
  rule this whole codebase enforces).
- `pageFile` is never used to derive a write target the caller controls
  beyond "co-locate a sibling file with the SAME basename" — the actual
  file name is server-computed (`coLocatedStylesheetRelPath`), never taken
  from the client.

## Verification

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json      # clean
./node_modules/.bin/eslint <every file listed below>     # clean
bun test server/handlers/__tests__/cssInsertIntegration.test.ts \
  server/handlers/__tests__/studioWriteback.test.ts \
  server/handlers/__tests__/studioCss.test.ts \
  src/__tests__/studio/styleRuleWriteback.test.ts \
  src/__tests__/architecture/boundary-validation.test.ts \
  src/__tests__/architecture/module-size-budgets.test.ts \
  server/handlers/__tests__/studio.test.ts
# 202 pass / 1 fail (pre-existing, NOT mine — see below)
```

**Rejection cases tested** (`cssInsertIntegration.test.ts`, all against real
temp files on disk, run through the REAL client `collectStyleRuleEdits` →
real server `applyStudioEditBatch`, not mocks):

- Zero stylesheets + no page association → `no-editable-stylesheet` refusal,
  nothing written (pre-existing B1 case, still passes with the new
  signature).
- Multiple candidate stylesheets, even for a node-scoped (page-having) rule
  → `ambiguous-stylesheet` refusal naming both files, **never creates a
  third file**, neither existing file touched.
- **Create branch, happy path**: no stylesheet exists → server creates
  `Home.css` next to `Home.tsx`, wires a side-effect `import './Home.css'`,
  writes the rule, response echoes the created file, `commitBaseline` does
  NOT auto-synthesize a source (asserted `undefined`), `recordCreatedStylesheet`
  (simulating `notifyCreatedStylesheets`) makes it writable, and a SECOND
  edit in the same session takes the ordinary `set` path and lands on disk
  — proving "editable on the next edit without a reload." Also asserts
  `result.shifted === true` after the create (the import shifted every
  line below it) and `false` after the follow-up `set` (which doesn't touch
  the page).
- **CSS-Modules convention detection**: workspace already leans on
  `.module.css` elsewhere → creates `Home.module.css` with a default
  `import styles from './Home.module.css'` binding.
- **Unreachable-class refusal**: convention says `module`, but the page
  ALREADY imports the co-located file side-effect-only → refuses
  `stylesheet-import-shape-mismatch`, **no byte written anywhere**
  (neither a new stylesheet nor the page's existing import).
- **Path traversal** (`pageFile: '../outside.tsx'`, a hand-crafted edit —
  not something the real client ever produces): refused silently
  (`applied:false`, no `refusals` entry — an attack, not a sentence to
  show a user, same posture `resolveContainedAssetPath` uses elsewhere),
  nothing written.
- **Missing page** (`pageFile` doesn't exist on disk — "a project layout
  you cannot place a file in"): same silent refusal, nothing written.

Client-side unit tests (`src/__tests__/studio/styleRuleWriteback.test.ts`)
cover `resolveCssInsertDestination`'s full 4-branch matrix (existing /
ambiguous-even-with-a-page / create / refuse-no-page), `pageFileForRule`'s
CMS-nanoid-vs-source-location distinction, `commitBaseline`'s NON-synthesis
for `create`, and `recordCreatedStylesheet`/`ruleIdFromCssCreateNodeId`
round-tripping.

**Pre-existing, not mine**: `the synthetic studio breakpoint id stays in
sync with the board` (in `styleRuleWriteback.test.ts`) fails because
`BoardFramesLayer.tsx` — explicitly excluded from my ownership this wave,
and confirmed via `git status -sb` to be currently modified in-flight by
another agent — no longer declares `id: 'studio'` at the moment I ran
tests. Not touched by this diff; not my regression.

## Files changed

**Owned, edited:**
- `server/handlers/studioCssWriteback.ts` — `op: 'create'` schema, three new
  path guards (+ shared `safeRelSegments`), `detectStylesheetConvention`,
  `coLocatedStylesheetRelPath`, `ensureStylesheetImport`,
  `applyCssCreateEdit`, dispatch in `applyCssEdit`, `CssEditOutcome`
  widened with `createdStylesheet`.
- `src/admin/pages/site/studio/styleRuleWriteback.ts` —
  `resolveCssInsertDestination(rule)` (signature change — now takes the
  rule), `pageFileForRule`, `CssCreateEditPayload`,
  `ruleIdFromCssCreateNodeId`, `recordCreatedStylesheet`, emission branch in
  `collectStyleRuleEdits`, `commitBaseline`'s create-branch exclusion,
  module doc rewritten ("Deferred: creating a NEW stylesheet" → "Creating a
  NEW stylesheet … now landed").
- `server/handlers/studioWriteback.ts` — `StudioEditApplyOutcome`/
  `StudioEditBatchResult` gained `createdStylesheet`/`createdStylesheets`;
  `applyStudioEditBatch` also adds the PAGE file to `touchedFiles` for a
  `create` edit (its import rewrite shifts lines just like every other
  kind's decoded location — this was a real gap, not cosmetic: without it
  `shifted`/live-reload page-touch detection would silently miss a `create`
  edit's line-count change).
- `server/handlers/studio.ts` — `/save` route destructures + returns the
  new `createdStylesheets` field.
- `src/admin/pages/site/studio/studioSaveRequests.ts` — `StudioSaveResponseSchema`
  gained `createdStylesheets`; new `notifyCreatedStylesheets(result,
  styleRules)` helper (toast + `recordCreatedStylesheet`), fully
  implemented and ready to call.

**Necessary, minimal, flagged boundary crossings (like B1's §7):**
- `src/admin/pages/site/studio/fsCodemodAdapter.ts` — ONLY the local
  `StudioEditPayload` mirror type's `css` variant widened with the third
  `create` shape (type-only; `edits.push(...cssPlan.edits)` would not
  compile otherwise). Doc comment updated to note the one remaining wiring
  step (`notifyCreatedStylesheets`) for whoever owns this file next. No
  other line touched — did NOT call `notifyCreatedStylesheets` from
  `saveSite` itself, since that's a behavior change to an excluded file.
  Trimmed the added comment (and condensed the `css` union's formatting) to
  keep the file at 687 lines — it was AT the 700-line ceiling before this
  edit and would have tipped over with the widening; module-size-budgets
  gate re-verified green.

**Test files, updated/new:**
- `server/handlers/__tests__/cssInsertIntegration.test.ts` — extended with
  the 6 new create-branch scenarios above (2 happy-path, 4 refusal).
- `src/__tests__/studio/styleRuleWriteback.test.ts` — updated for the new
  `resolveCssInsertDestination(rule)` signature and the `existing`/
  `ambiguous-stylesheet` renaming; added the create-branch, non-synthesis,
  and `recordCreatedStylesheet`/`ruleIdFromCssCreateNodeId` coverage above.

## Notes for whoever picks up `fsCodemodAdapter.ts` / MCP docs next

- One line in `saveSite`, right after the existing `unexplainedSkips`
  handling: `notifyCreatedStylesheets(result, site.styleRules)` (import
  from `./studioSaveRequests`). That's the entire remaining wiring gap.
- `server/ai/mcp/tools/studio/editTools.ts`'s tool description string
  (owned by `server/ai/**`, explicitly out of my reach this wave) doesn't
  yet mention the `create` op in its prose — the schema itself already
  accepts it (it re-exports `StudioEditSchema` verbatim, so an MCP caller
  CAN already send `{ kind:'css', op:'create', pageFile, … }` today), the
  description text just doesn't advertise it. Cosmetic, not a functional
  gap.
