# test-engineer handoff — Windows path/CRLF architecture-gate fixes

## Shared helper added

`src/__tests__/architecture/pathHelpers.ts` — new file, exports
`toPosixPath(p: string): string` (`p.split(sep).join('/')`). Doc comment
explains the bug class and points at the pre-existing idiom it formalizes
(`no-full-site-scan-in-selectors.test.ts`'s local `toPosix`,
`module-size-budgets.test.ts`'s inline `.split(sep).join('/')`). The three
gates below now import and use it instead of comparing raw
`path.relative()` output (backslash-separated on win32) against
forward-slash allowlist literals.

## The four gates

### 1. `src/__tests__/architecture/codemirror-lazy-only.test.ts`
Bug: `const rel = relative(SRC_ROOT, file)` compared with `rel === ALLOWED_CONSUMER`
(`'admin/pages/site/code-editor/CodeMirrorEditor.tsx'`, forward slashes).
Fix: `const rel = toPosixPath(relative(SRC_ROOT, file))`.
Proof: added a temp file `src/admin/pages/site/code-editor/__zzTempViolation.ts`
with `import { EditorView } from 'codemirror'`. Gate went red, correctly
named that file and the `codemirror` family. Deleted the temp file; gate
green again (2 pass / 0 fail).

### 2. `src/__tests__/architecture/dispatcher-html-pipeline.test.ts`
Bug: `const rel = file.slice(ROOT.length + 1)` (backslash-separated on
win32) compared against `allowedOwners.has(rel)` where the Set holds
`'server/publish/publishedHtmlPipeline.ts'`.
Fix: `const rel = toPosixPath(file.slice(ROOT.length + 1))`.
Proof: added `server/__zzTempViolation.ts` calling
`hookBus.emit('publish.before', {})`. Gate went red, reported
`server/__zzTempViolation.ts` (forward slashes) as driving the lifecycle
outside the owner. Deleted the temp file; gate green again (3 pass / 0 fail).

### 3. `src/__tests__/architecture/keybindings-registry-single-source.test.ts`
Bug: both `it()` blocks build `const rel = relative(SRC_ROOT, file)` and
check `ALLOWLIST.has(rel)` against forward-slash literals (`'admin/spotlight/keybindings.ts'`,
`'admin/pages/site/canvas/UndoRedoButtons.tsx'`, `'admin/pages/site/hooks/useCanvas.ts'`, etc.).
Fix: wrapped both `rel` assignments in `toPosixPath(...)`.
Proof (before fix, captured via `git stash`/`git stash pop` to inspect the
original failure): the gate reported three false violations —
`admin\spotlight\keybindings.ts:124` (the registry itself, self-match),
`admin\pages\site\canvas\UndoRedoButtons.tsx:49`, and
`admin\pages\site\hooks\useCanvas.ts:374` — even though all three are
listed in `ALLOWLIST`. That confirms the bug wasn't narrowly scoped to the
registry file; it silently defeated every allowlist entry in this gate on
Windows.
Proof (after fix): added `src/admin/__zzTempViolation.ts` with an inline
`(e.metaKey || e.ctrlKey) && e.key === 'k'` matcher. Gate went red, reported
`admin/__zzTempViolation.ts:2` (forward slashes). Deleted the temp file;
gate green again (2 pass / 0 fail).

### 4. `src/__tests__/site-explorer/siteExplorerPanel.test.tsx:371` (line numbers shifted slightly by the added comment; assertion itself untouched in logic)
Bug: `treeDropCss.match(/\.dropBefore::before,\n\.dropAfter::after,.../s)` —
literal `\n` never matches this repo's CRLF-materialized `.css` file, so
the match returns `undefined` and `beforeAfterBlock` resolves to `''`,
silently passing the two `.not.toMatch`/`.toContain` assertions against
empty string sometimes and failing others depending on encoding — on this
Windows checkout it failed outright.
Fix: normalize once at the read site — `readFileSync(...).replace(/\r\n/g, '\n')`
— matching the existing idiom in `src/__tests__/canvas/overlayRafDiscipline.test.ts`.
Proof: temporarily replaced the `position: absolute;` declaration inside
the `.dropBefore::before, .dropAfter::after, .dropRoot::after,
.rootDropGapActive::after { ... }` block in
`src/admin/pages/site/ui/Tree/TreeDrop.module.css` with a comment (first
attempt commented out the line but left the literal string "position:
absolute" inside the comment text, which false-passed — corrected to a
comment that doesn't contain the string). Gate went red:
`expect(beforeAfterBlock).toContain('position: absolute')` failed and
printed the extracted block (proving the regex now matches across the
CRLF-normalized text). Reverted `TreeDrop.module.css` via `git checkout --`;
gate green again (36 pass / 0 fail); `git diff` on the file is empty.

## UndoRedoButtons.tsx:49 / useCanvas.ts verdict

**`src/admin/pages/site/hooks/useCanvas.ts` (line ~389, `(e.metaKey || e.ctrlKey) && e.key === '0'`):
legitimate allowlist entry, no action needed.** This is the canvas
"reset zoom" viewport shortcut (Ctrl/Cmd+0), matching the allowlist's own
justification ("Canvas-specific zoom/pan shortcuts (Ctrl+0, f, 1, 2) — not
global commands"). Confirmed no other modifier+key inline matcher exists
in the file besides this one Ctrl+0 check (grepped for
`e.key === '<char>'` combined with metaKey/ctrlKey). There's a second,
independent Ctrl+0 handler at a document-level `useEffect` (~line 333,
"Browser-style reset shortcut") that intercepts the browser's native
Ctrl+0 zoom-reset globally, while the one at line ~389 is the
canvas-root-focused React `onKeyDown` handler — deliberately duplicated
coverage for focused vs. unfocused canvas, following the same
document-level-listener pattern already used for space-bar pan tracking
earlier in the same file. Not a drift from the registry; it's intentional
canvas-viewport chrome that doesn't belong in the global command palette.

**`src/admin/pages/site/canvas/UndoRedoButtons.tsx:49`
(`(e.metaKey || e.ctrlKey) && e.key === 'y'`): genuine, narrow drift —
report for routing, do not fix (file is under the excluded
`src/admin/pages/site/canvas/**`, "DnD unification in flight").** The
file's `ALLOWLIST` justification says "uses getKeybindingForCommand().match(e)",
which is true for the primary Undo/Redo bindings (`kbUndo`, `kbRedo`,
lines 43–48) — but the file *also* hand-rolls a bare `e.metaKey ||
e.ctrlKey) && e.key === 'y'` check for the Windows/Redo alias, with a
comment explicitly acknowledging it's "not in the registry since ⌘⇧Z is
the canonical binding, but handled here for convenience." That is exactly
the pattern this gate exists to catch: a second, un-registered keybinding
living outside `keybindings.ts`. Per CLAUDE.md's "no band-aids" stance,
the correct fix is to register Ctrl+Y as an alias/secondary match for
`editor.redo` in `src/admin/spotlight/keybindings.ts` (e.g. an
`aliasKeys`/multi-match field on the keybinding entry) and delete the
inline check in `UndoRedoButtons.tsx`, rather than keep two sources of
truth for the same command. I did not make this change: it touches
`src/admin/pages/site/canvas/UndoRedoButtons.tsx`, which is explicitly
off-limits to me (canvas DnD unification in flight), and possibly
`src/admin/spotlight/keybindings.ts`, which is tightly coupled to that
file's behavior. Left the existing allowlist entry in place (I did not
add or remove any allowlist entries) since removing it would just make the
gate red on a violation nobody but the canvas owner can fix right now.
Routing recommendation: canvas-engineer (or whoever owns keybindings.ts)
should add the alias to the registry and delete the inline branch in the
same change that lands the DnD unification, then this gate needs no
special-casing at all for this file.

## Sweep for the same bug class

Grepped every file under `src/__tests__/architecture/` and
`src/__tests__/site-explorer/` for (a) `relative()`/manual-slice path
comparisons against string-literal allowlists, and (b) regex literals
containing `\n` matched against file contents. Findings:

- **Already correctly normalized, no change needed:** `no-full-site-scan-in-selectors.test.ts`
  (local `toPosix` helper — matches this PR's new shared helper, left
  as-is since a sibling session is actively editing that file's allowlist
  right now, see "Concurrent sibling activity" below), `module-size-budgets.test.ts`
  (`.split(sep).join('/')` inline), `button-primitive-usage.test.ts`
  (`.split('\\').join('/')` inline), `cms-handlers-capability-gated.test.ts`,
  `ai-driver-isolation.test.ts`, `plugin-secrets-never-leak.test.ts`,
  `ai-tools-typebox-only.test.ts`, `ai-handlers-capability-gated.test.ts`,
  `ai-credentials-never-leak.test.ts` (all use `.replaceAll('\\', '/')`
  before comparing/reporting).
- **Symmetric-by-construction, no bug:** `boundary-validation.test.ts`,
  `db-postgres-isms.test.ts`, `no-plugin-tab-shells.test.ts` — these build
  both the allowlist *and* the walked file paths with the same
  `path.join()` (native separators on both sides), so the comparison is
  never cross-separator. Verified by reading each allowlist definition.
  `no-inline-error-ternary.test.ts` has an unnormalized `relative()` +
  `.has(rel)` but its `ALLOWLIST` is an intentionally empty `Set` — no
  live comparison to break.
- **Real bug found and fixed:** `error-boundary-coverage.test.ts` —
  `read(MAIN_FILE.replace(SRC_ROOT + '/', ''))` tried to strip the
  `SRC_ROOT` prefix from the already-absolute `MAIN_FILE` using a
  forward-slash-suffixed search string; on win32 `MAIN_FILE` is
  backslash-separated so the `.replace()` was a no-op, and `read()` then
  re-`join()`-ed the untouched absolute path onto `SRC_ROOT`, producing a
  malformed path and an `ENOENT` crash (`src\C:\Users\...\src\admin\main.tsx`).
  Fixed by reading `MAIN_FILE` directly (`readFileSync(MAIN_FILE, 'utf8')`)
  instead of re-deriving a relative path that was never needed. Proof: in
  `src/admin/main.tsx`, renamed the `logErrorChain` call site and dropped
  it from the import (`git checkout -- src/admin/main.tsx` restored it
  after). Gate went red (`Expected substring or pattern: /logErrorChain/`
  not found) before I reverted; green after
  (6 pass / 0 fail; confirmed `git diff` on `main.tsx` is empty).
- **CRLF-literal-`\n` bug class:** only the one instance already covered
  (`no-vc-mode-branches-in-mutations.test.ts` uses a literal `\n` inside a
  marker string/regex too, but it's `content.indexOf('\n    ' + name + ':')`
  / `fromMarker.search(/\n {4}[a-zA-Z_$]/)` — both are *substring/anywhere*
  searches, not "must immediately follow a comma with nothing between," so
  a `\r` sitting just before the matched `\n` doesn't break them the way it
  broke the site-explorer CSS-block regex. No fix needed there.)

## Out-of-scope finding (not fixed, flagging for routing)

`src/__tests__/architecture/canvas-aware-selectors.test.ts` and
`src/__tests__/architecture/ui-primitives-location.test.ts` both derive
`EDITOR_ROOT = join(SRC_ROOT, 'editor')`, but `src/editor/` does not exist
in this repo (the editor code lives under `src/admin/pages/site/`). Every
gate in `canvas-aware-selectors.test.ts` short-circuits on
`!existsSync(EDITOR_ROOT)` and is currently a no-op on every platform, not
just Windows — this is a different bug class (stale directory reference)
from the Windows-path/CRLF class this task scoped me to. I did not touch
it: retargeting `EDITOR_ROOT` to the real directory could surface genuine
`selectActivePage`/`s.site?.pages.find(` violations inside
`src/admin/pages/site/**`, which includes the explicitly off-limits
`src/admin/pages/site/canvas/**`. Recommend routing to whoever owns
canvas/store work next — the gate needs `EDITOR_ROOT` corrected and then a
real re-audit of any violations it starts reporting.

## Transient failure observed, not mine

During one interim `bun test src/__tests__/architecture src/__tests__/site-explorer`
run, `module-size-budgets.test.ts` failed on
`src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx` (706
lines, over the 700-line ceiling). That file is under the explicitly
off-limits `src/admin/pages/site/canvas/**` (DnD unification in flight). A
re-run moments later showed the file back at 286 lines and the gate green
— a concurrent sibling session was mid-edit on that exact file when my run
sampled it. Not a gate bug, not something I touched or fixed. Re-ran the
full architecture+site-explorer suite afterward and it was clean.

## Verification

- `bun test src/__tests__/architecture src/__tests__/site-explorer` →
  **552 pass / 0 fail** (clean; the transient BoardFramesLayer failure
  above was a one-off from a concurrent sibling edit, not present in this
  final run).
- Full `bun test`: **9060 pass / 30 fail / 1 skip / 1 error** (log saved at
  `scratchpad/full-test-run.log` in this session's temp dir), vs. the
  stated baseline of 9053 pass / 33 fail / 1 skip. None of the 30
  remaining failures are under `src/__tests__/architecture/` or
  `src/__tests__/site-explorer/` — confirmed by grepping the run log for
  `(fail)` and cross-checking paths. The remaining failures are spread
  across AI/agent panel, plugin-runtime SDK, MCP server, studio project
  guide, and worker-timeout suites — all outside my ownership and
  consistent with `standing-01` plus heavy concurrent-sibling churn (many
  files under `server/ai/**`, `server/handlers/studio*`, and
  `src/core/ast-codemods/**` show as modified in `git status` from other
  sessions, not from me). Full-suite numbers are noisy run-to-run because
  of that concurrent activity; the authoritative signal for this task is
  the isolated architecture+site-explorer run above.
- `./node_modules/.bin/eslint` on every file I touched (`pathHelpers.ts`,
  the four gate files, `siteExplorerPanel.test.tsx`) → clean, no errors.
- Did not run `bun run build` / `bun run lint` / `tsc -b` per the task's
  explicit instruction (siblings running those centrally).

## Note on files that changed but aren't mine

`git status` also shows `src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts`,
`src/__tests__/architecture/studio-agent-can-measure.test.ts`, and
`src/__tests__/architecture/studio-agent-no-subagents.test.ts` as modified.
I did not make these edits — diffing them shows a concurrent sibling
session's work (an allowlist entry removed after `registerProjectModules.ts`
was fixed per `STUDIO-FIGMA-PARITY-PLAN.md` E4, and two call-site updates
for a `buildStudioAgentSystemPrompt(null, studioAgentTools)` signature
change under `server/ai/**`, which is explicitly not mine to touch).
Left untouched.

## Files changed (mine)

- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\architecture\pathHelpers.ts` (new)
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\architecture\codemirror-lazy-only.test.ts`
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\architecture\dispatcher-html-pipeline.test.ts`
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\architecture\keybindings-registry-single-source.test.ts`
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\architecture\error-boundary-coverage.test.ts`
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\src\__tests__\site-explorer\siteExplorerPanel.test.tsx`

No commits made, nothing staged, working tree only, per instructions.

---

# Second pass — EDITOR_ROOT vacuous-scan gates + third-variant sweep

Scope for this pass: (1) fix the two EDITOR_ROOT-doesn't-exist gates
flagged in the first pass, with the same proof-of-failure discipline; (2)
sweep src/__tests__/architecture/** and src/__tests__/site-explorer/**
for the third variant of the same disease — any gate whose scan can
legitimately match zero files.

Note on an environment hiccup mid-task: partway through this pass a
`grep` check appeared to show several of my just-made edits reverted. I
did not trust it — I re-verified every file with Read (not grep)
immediately after, and every edit was actually present on disk; the grep
output had been stale/cached. No work was lost, nothing was blindly
re-applied over good content. Then I was killed by an unrelated
environment auth error ("Not logged in") while starting the full-suite
baseline run and resumed per the coordinator's message — all my changes
were intact in the working tree, confirmed via git status/git diff before
continuing.

## 1. The two EDITOR_ROOT-doesn't-exist gates — fixed

Both `src/editor` and `src/app` never existed in this repo's tracked
history (`git log --all -- src/editor` and `git log --all -- src/app` are
both empty — checked before touching either file, not guessed). Re-derived
intent from each gate's own doc comment cross-referenced against real
directories and the gates' own pre-existing allowlist entries (which are
all written as admin/pages/site/... paths).

### src/__tests__/architecture/canvas-aware-selectors.test.ts

- EDITOR_ROOT retargeted from join(SRC_ROOT, 'editor') to
  join(SRC_ROOT, 'admin/pages/site'). Evidence: SELECT_ACTIVE_PAGE_ALLOWLIST
  already contained entries like 'admin/pages/site/hooks/useInsertModule.ts'
  — these only make sense as relative(SRC_ROOT, file) output if EDITOR_ROOT
  is admin/pages/site. Not a guess.
- VC_AWARE_PANEL_DIRS retargeted from components/{PropertiesPanel,DomPanel,Canvas,SelectorsPanel}
  (never existed) to panels/PropertiesPanel, panels/DomPanel, canvas,
  panels/SelectorsPanel — matching the real directory tree
  (src/admin/pages/site/panels/{PropertiesPanel,DomPanel,SelectorsPanel},
  src/admin/pages/site/canvas) and the doc comment's own list ("DOM
  panel, Properties panel, Canvas, Selectors panel").
- Found and fixed a second, independent separator bug in the same file,
  invisible until the root retarget made the gate execute for real:
  relPath() did relative(SRC_ROOT, full) with no toPosixPath — on
  Windows this meant the pre-existing allowlist entries for
  PreviewOverlay.tsx and PublishButton.tsx never matched, so those two
  already-allowlisted files false-flagged as violations the instant the
  gate started scanning real files. Fixed by wrapping in toPosixPath.
- Found and fixed a false-positive from block-comment content: once
  live, GATE 1 flagged NodeRenderer.tsx:15 — a mention of
  selectActivePage inside a /** ... */ JSDoc file header, not real
  usage (the file doesn't even import selectActivePage; it imports
  selectCanvasPageFor). The gate's old /^\s*\/\// comment-skip only
  strips // line comments, not block-comment bodies or *-continuation
  lines. Added a stripComments() helper (same COMMENT_RE =
  /\/\/.*$|\/\*[\s\S]*?\*\//gm + space-replacement idiom already used in
  boundary-validation.test.ts / db-postgres-isms.test.ts) and applied
  it before both gates scan line-by-line. This is a gate-correctness fix,
  not a source fix — it removes a false positive, it doesn't hide a real one.
- Added one new allowlist entry, admin/pages/site/store/store.ts
  (§A.6), after confirming by reading the file that its three matches are:
  the selectActivePage definition (line 183), a JSDoc mention (line
  240 — now also caught by the block-comment fix above), and
  selectActiveCanvasPage's own implementation legitimately calling
  selectActivePage(s) as its page-mode branch (line 249) — i.e. store.ts
  IS the selector module, not a consumer. Same pattern as excluding
  mutateActiveTree from no-vc-mode-branches-in-mutations.test.ts. I did
  not touch store.ts itself (off-limits — src/admin/pages/site/store/**
  is sibling-owned); this is purely a SELECT_ACTIVE_PAGE_ALLOWLIST entry
  in my own gate file, with a full justification comment.
- Proof of failure (mechanism, on top of the real backlog below):
  injected src/admin/pages/site/toolbar/__zzTempViolation.ts (imports
  selectActivePage) and src/admin/pages/site/panels/DomPanel/__zzTempViolation.ts
  (raw s.site?.pages.find(). Both were caught by GATE 1 and GATE 2
  respectively, reported with forward-slash paths. Deleted both; confirmed
  only the real backlog (below) remains. git status/git diff on both
  temp paths — nothing left behind.
- Real backlog surfaced once the gate actually runs (left red,
  reporting, not fixing):
  - GATE 1 (selectActivePage used where selectActiveCanvasPage is required):
    - admin/pages/site/canvas/TemplateModeControl.tsx:14,24,53
    - admin/pages/site/hooks/useActiveLivePath.ts:30,40,90,94
    - admin/pages/site/property-controls/DynamicBindingControl/BindingPickerPopover.tsx:29,170,177
  - GATE 2 (raw s.site?.pages.find( in a VC-aware panel dir):
    - admin/pages/site/canvas/UserStylesheetInjector.tsx:93
  - These are genuine candidates for the exact bug this gate exists to
    catch (page-only lookups inside VC-aware surfaces) — but confirming
    each is a true violation vs. a legitimate page-mode-only design (like
    the existing §A.1–§A.5 exceptions) requires domain judgment I was told
    not to exercise. TemplateModeControl.tsx and UserStylesheetInjector.tsx
    are under the explicitly off-limits src/admin/pages/site/canvas/**.
    Routing recommendation: whoever owns VC canvas-mode work should audit
    these 4 files and either fix the lookup or add a documented §A.N /
    justified GATE-2 exception.

### src/__tests__/architecture/ui-primitives-location.test.ts

- EDITOR_ROOT retargeted the same way, same evidence class (the file's
  own doc comment: "shared by editor panels, settings, toolbar").
- src/app (used only in the "native color/file input" test's roots
  array) has no current equivalent anywhere in this codebase — no
  src/app in tracked history, and docs/architecture.md's folder layout
  lists only src/admin, src/core, src/modules, src/ui. Left the
  join(SRC_ROOT, 'app') entry as-is rather than guessing a replacement,
  and left a comment flagging it as an unresolved intent — my best
  guess is a since-removed public-site renderer surface, but I did not act
  on a guess. This needs a decision from someone with more history on
  this repo, not a fix from me.
- relative() calls in the two file-scanning tests wrapped in
  toPosixPath for clean, comparable reporting (no allowlist comparison
  was broken here, but leaving raw backslash paths in a violations array
  that other code might grow to compare against would repeat the same bug
  class later).
- Proof of failure — three separate mechanisms, each confirmed:
  1. Injected src/admin/pages/site/panels/__zzTempViolation.tsx importing
     Button from an editor-relative path ('../../../ui/Button'). The
     "imports shared Button from @ui/components instead of editor-relative
     paths" test went red, reporting panels/__zzTempViolation.tsx.
     Deleted; back to green for that test.
  2. Created src/admin/pages/site/components/ui/Button/Button.tsx
     (resurrecting the banned old primitive path). "does not keep the old
     editor-local Button primitive" went red (Expected: false, got
     true). Deleted the directory; green again.
  3. The "keeps native color and file inputs..." test was already red
     from real backlog (below) before I touched it — confirming the
     mechanism needed no synthetic injection there.
- Real backlog surfaced (left red, reporting, not fixing):
  admin/pages/site/panels/TypographyPanel/FontsSection/AddCustomFontDialog.tsx:396
  — a raw <input ref={fileInputRef} type="file" hidden ... /> triggered
  via a hidden ref + Button click, bypassing the shared FileUpload
  primitive. Precise, single file, single line, not under any off-limits
  directory. Routing recommendation: swap for FileUpload or add a
  documented exception if the hidden-input-plus-button pattern is
  intentional here (e.g. because FileUpload's visible drop-zone chrome
  doesn't fit this compact dialog control).

## 2. Third-variant sweep — "a scan that can legitimately match zero files"

Litmus test applied per-gate: if this gate's subject matter vanished
entirely from the codebase, would it still pass? Checked every top-level
_ROOT/_DIR constant and every SCAN_ROOTS/PROD_DIRS/_DIRS array literal
across src/__tests__/architecture/** (methodically: extracted every
const X_ROOT/_DIR = join(...)/resolve(...) declaration, resolved
each absolute path, and checked existence on disk) plus every array of
scan roots (SCAN_ROOTS, PROD_DIRS, VC_AWARE_PANEL_DIRS, etc.).

### Fixed — real coverage gaps (unambiguous, evidence-backed)

src/__tests__/architecture/close-icon-correctness.test.ts,
direct-icon-imports.test.ts, no-third-party-icons.test.ts — all
three had PROD_DIRS = ['editor', 'core', 'modules', 'ui', 'app', 'lib'].
'editor', 'app', 'lib' never existed in this repo's tracked history
(checked via git log --all) — and none of the three included 'admin'
at all, meaning src/admin/ — the single largest consumer of icons in
this codebase (toolbar, panels, dialogs, modals) — was never scanned
by any of these three gates since they were written. This is the litmus
test failing outright: every <XIcon>-as-close-button mistake,
lazy-Icon-wrapper usage, or third-party icon import anywhere in
src/admin/ could exist indefinitely and none of these three gates would
ever see it. close-icon-correctness.test.ts's own docstring even says
the original XIcon-misuse bug happened in "modal and overlay components"
— almost certainly under src/admin/. Fixed all three to
PROD_DIRS = ['admin', 'core', 'modules', 'ui'].
- Also normalized the rel/violation-path formatting in all three
  (toPosixPath) — cosmetic (no allowlist comparison was involved, so no
  correctness bug), but these three files are explicitly a copy-paste
  family (close-icon-correctness.test.ts's own comment: "same pattern as
  no-third-party-icons.test.ts") and reporting should read consistently.
- Proof of failure: injected src/admin/shared/__zzTempViolationX.tsx
  (XIcon import), __zzTempViolationLucide.tsx (lucide-react import),
  __zzTempViolationLazyIcon.tsx (lazy Icon wrapper import) under
  src/admin/. All three gates went red and correctly named the new
  files under src/admin/. Deleted all three temp files; re-ran — all
  three gates back to their true state (2 clean, 1 with genuine backlog
  below).
- Real backlog surfaced by direct-icon-imports.test.ts (left red,
  reporting, not fixing) — 5 files rendering the lazy <Icon> wrapper or
  importing pixel-art-icons/Icon instead of a concrete
  pixel-art-icons/icons/<name> import:
  - src/admin/modals/SiteImport/steps/CmsBundleAnalyzeStep.tsx
  - src/admin/pages/site/module-picker/ModuleInserterDialog.tsx
  - src/admin/pages/site/panels/FrameworkPanel/FrameworkHome.tsx
  - src/admin/shared/ExportDialog/ExportDialog.tsx
  - src/admin/shared/media/components/MediaSidebar/MediaSidebar.tsx
  - None are under an explicitly off-limits directory. close-icon-correctness.test.ts
    and no-third-party-icons.test.ts found zero real violations once
    pointed at src/admin/ — clean.

### Fixed — pure redundancy (dead entry alongside a real one that already covers it; zero behavior change, confirmed by identical pass/fail before and after)

These all had a dead 'editor' scan-root entry alongside a real
'admin' entry that already recursively covers src/admin/pages/site/
(the "editor" surface) — so unlike the three above, dropping the dead
entry changes no scanned file set (verified: pass/fail counts identical
before/after each edit):
- src/__tests__/architecture/css-token-policy.test.ts — SCAN_ROOTS = [admin, editor, ui] -> [admin, ui]
- src/__tests__/architecture/no-css-var-fallbacks.test.ts — same shape, same fix
- src/__tests__/architecture/no-native-title-tooltips.test.ts — SCAN_ROOTS = [admin, editor] -> [admin]
- src/__tests__/architecture/button-primitive-usage.test.ts — SCAN_ROOTS = [{admin}, {editor}] -> [{admin}], dropped the dead EDITOR_ROOT const
- src/__tests__/architecture/no-plugin-tab-shells.test.ts — collectAllFiles() walked join(SRC_ROOT, 'admin') and join(SRC_ROOT, 'editor'); dropped the dead second walk and updated the "SCAN ROOTS" doc-comment section (which had literally documented src/editor/** — host editor shell as if it were real)

Each of these was verified with a bun test run before AND after the
edit — identical pass/fail counts (proving true redundancy, not a
disguised coverage change) — since a synthetic-violation proof-of-failure
cycle is a null exercise on a root that was already fully covered by its
sibling entry.

### Checked, confirmed real (no gap found) — the exhaustive base-root and derived-path audit

All of the following resolve to real, existing directories/files on disk
(verified programmatically for every const X_ROOT/_DIR = join(import.meta.dir, ...)
base declaration across every file in src/__tests__/architecture/, then
individually for every derived join(<ROOT>, '<literal-subpath>')):
SRC_ROOT/PROJECT_ROOT/REPO_ROOT in all ~50 files that declare one;
server/ai/handlers, server/ai/tools, src/core/persistence,
src/admin, server, server/handlers/cms, src/core/loops/sources,
src/ui/components/Tabs, server/plugins/host, server/handlers,
src/core/siteImport, src/admin/spotlight/commands, src/ui/components,
vendor/pixel-art-icons/icons, vendor/pixel-art-icons/dist/icons,
vendor/pixel-art-icons/types.ts, vendor/pixel-art-icons/dist/types.js,
vendor/pixel-art-icons/package.json, server/plugins/quickjs/bootstrap/generated
(plugin-bootstrap-fresh.test.ts), src/admin/preauth (admin-startup-imports.test.ts,
uses un-guarded readdirSync with no existsSync check — a missing dir
would throw loudly, not pass silently, so it fails safe even without a
guard), src/admin/pages/site/canvas/EditorChromeInjector.tsx
(admin-spacing/typography-token-policy.test.ts single-file check).

Also checked every _ROOTS/_DIRS array literal in the file (not just
named constants) for the same disease: admin-spacing-token-policy.test.ts
/ admin-typography-token-policy.test.ts ([admin, ui], no dead entry),
css-token-vocabulary.test.ts ([admin, styles, ui], no dead entry —
already clean, someone fixed this one already), ai-driver-isolation.test.ts
(['src', 'server'], real), no-legacy-content-domain.test.ts
([src, server], real, whole-tree scan), singleInstallManagedHosting.test.ts
(['server', 'src/admin', 'src/core'], real), module-size-budgets.test.ts
/ no-core-barrel-deep-imports.test.ts (['src', 'server'] variants,
real), no-native-browser-dialogs.test.ts ([admin, core, ui], real),
noTailwindUtilities.test.ts ([admin, modules, ui], real).

Allowlist-swallows-everything check: grepped every ALLOWLIST/allowlist
Set/array definition in the folder for a pattern that would match all
scanned files (a bare prefix, an always-true predicate, a dynamically
populated set). Found none — every allowlist in the folder is either a
small hand-enumerated Set of specific relative paths (the common case) or,
in no-inline-error-ternary.test.ts, an intentionally empty Set
(new Set([]), documented as "keep this empty") — not a swallow-everything
bug, a correctly-strict gate with nothing exempted yet.

### Reported, not fixed — out of scope for this pass

src/__tests__/architecture/canvas-aware-selectors.test.ts and
ui-primitives-location.test.ts's VC_AWARE_PANEL_DIRS/app-root
situations are covered above (fixed / flagged respectively) since they
were this pass's primary target. No other genuinely-ambiguous root was
found that I declined to fix — every dead-root instance found in the
sweep fell cleanly into either "fix it, evidence is unambiguous" (icon
gates, EDITOR_ROOT gates) or "pure redundancy, zero risk to remove"
(the five 'editor'-alongside-'admin' cleanups).

## Not mine — observed in the full-suite run, confirmed via git diff --stat

- src/__tests__/architecture/no-circular-dependencies.test.ts fails
  on a real, current circular dependency:
  src/admin/pages/site/hooks/useCanvas.ts > src/admin/pages/site/canvas/canvasZoomFit.ts.
  Not a gate bug (no path-separator or CRLF issue — madge itself reports
  it). canvasZoomFit.ts and several new canvas test files
  (src/__tests__/canvas/canvasZoomFit.test.ts,
  boardFramesLayerRenderScope.test.tsx, etc.) are untracked/new in
  git status, consistent with the D2/D3 canvas+DnD sibling's in-flight
  work. Confirmed persistent (not a one-off mid-edit sample) by re-running
  twice, several minutes apart, both red. Both files involved are under
  directories explicitly off-limits to me
  (src/admin/pages/site/canvas/**) or adjacent to them
  (src/admin/pages/site/hooks/useCanvas.ts, which the coordinator's
  first-pass message already listed under the canvas/keybindings
  ownership group). Left untouched, reporting only.
- Every other full-suite failure outside src/__tests__/architecture/**
  and src/__tests__/site-explorer/** (AgentPanel, server plugin runtime
  SDK, requestFromWorker timeout, Zustand selector stability,
  mcpServerSecretStore, streamClaudeCli, resolveToolProjectDir,
  generateStudioProjectGuide, resolveProjectSeedDir,
  buildProjectTokenIndex, runtime cache layout, board-frame selection
  leak, notifyClassAssignmentUnsaved, studio-plugin lint) is outside my
  diff — confirmed via git status -sb showing ~248 modified files
  repo-wide from the five resumed sibling sessions (D2/D3 canvas+DnD,
  E2.4 ast-codemods/studioEditSchemas/studioWriteback, F1
  PropertiesPanel, F2 editConstraint/nodeResolution/notices, Track H
  framework/tokenExtract). None of those paths appear in my git diff
  --stat. Not attributed to me, not touched.

## Final verification

- bun test src/__tests__/architecture src/__tests__/site-explorer ->
  547 pass / 5 fail (105 files, 552 tests). The 5: the 4 real-backlog
  findings above (2 in canvas-aware-selectors.test.ts, 1 in
  direct-icon-imports.test.ts, 1 in ui-primitives-location.test.ts)
  plus the 1 not-mine circular-dependency failure. Re-ran this exact
  command a second time after the auth-error resume to confirm identical,
  stable results.
- Full bun test (log: scratchpad/full-test-run-2.log in this
  session's temp dir): 9114 pass / 1 skip / 38 fail / 2 errors across
  9153 tests / 895 files. Cross-checked every failing test name against
  git status -sb (~248 modified files repo-wide from 5 resumed sibling
  sessions) — none of the 38 failures fall under
  src/__tests__/architecture/ or src/__tests__/site-explorer/ except
  the 5 named above. The rest belong to the sibling work streams named in
  the coordinator's message; not attributed to me, not touched.
- ./node_modules/.bin/eslint on every file I touched across both
  passes (18 test files + pathHelpers.ts) -> clean, zero errors, run
  fresh at the end of this pass.
- No npx tsc, no bun run build, no bun run lint run, per instructions.
- Swept for leftover temp/proof-of-failure artifacts at the very end
  (find src -iname "*zzTemp*", git status -sb on both owned dirs) —
  none found; every injected violation across both passes was deleted
  after its gate confirmed red.
- src/__tests__/architecture/single-drag-mechanism.test.ts does not
  exist in the working tree as of this pass — nothing to avoid touching,
  confirmed before finishing.

## Full file list — both passes combined (mine)

New:
- src/__tests__/architecture/pathHelpers.ts

Modified:
- src/__tests__/architecture/codemirror-lazy-only.test.ts
- src/__tests__/architecture/dispatcher-html-pipeline.test.ts
- src/__tests__/architecture/keybindings-registry-single-source.test.ts
- src/__tests__/architecture/error-boundary-coverage.test.ts
- src/__tests__/architecture/canvas-aware-selectors.test.ts
- src/__tests__/architecture/ui-primitives-location.test.ts
- src/__tests__/architecture/close-icon-correctness.test.ts
- src/__tests__/architecture/direct-icon-imports.test.ts
- src/__tests__/architecture/no-third-party-icons.test.ts
- src/__tests__/architecture/css-token-policy.test.ts
- src/__tests__/architecture/no-css-var-fallbacks.test.ts
- src/__tests__/architecture/no-native-title-tooltips.test.ts
- src/__tests__/architecture/button-primitive-usage.test.ts
- src/__tests__/architecture/no-plugin-tab-shells.test.ts
- src/__tests__/site-explorer/siteExplorerPanel.test.tsx

Not mine, appear modified in git status but not touched by me (confirmed
by diffing — sibling work):
- src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts
- src/__tests__/architecture/studio-agent-can-measure.test.ts
- src/__tests__/architecture/studio-agent-no-subagents.test.ts

No commits made, nothing staged (git add never run), working tree only,
per instructions.
