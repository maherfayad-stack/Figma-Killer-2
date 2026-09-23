# studio-implementer handoff — real violations surfaced by the repaired gates

Scope: fix the genuine pre-existing violations in `direct-icon-imports.test.ts`,
`canvas-aware-selectors.test.ts`, and `ui-primitives-location.test.ts` that the
gate-repair session (see `handoff-gates.md`) left red on purpose. Worked from
that file's exact `file:line` list, not from the task brief's summary.

No commits, no `git add`, `STATE.md` untouched, per the absolute constraints.

---

## 1. `direct-icon-imports.test.ts` — 5 violations, 4 fixed, 1 reported

All 5 were the SAME false-shape as a real bug: a local variable literally
named `Icon` (PascalCase, required for React to treat it as a component)
holding a data-driven icon component reference, then rendered as `<Icon ... />`.
The gate's `<Icon\b` regex exists to ban the **lazy** `pixel-art-icons/Icon`
wrapper — it can't distinguish that from an unrelated local also named `Icon`.
This is a known, already-established pattern in the codebase: `AlignBar.tsx`
(`src/ui/components/AlignBar/AlignBar.tsx:46-51`) has a doc comment describing
exactly this collision and renaming its own local to `EdgeIcon`, citing
`StyleCategoryRail.tsx`'s `ModuleRailButton` as the same fix. I followed that
established convention rather than inventing a new one.

Fixed (source, not gate — genuine drift, no allowlist needed):
- `src/admin/modals/SiteImport/steps/CmsBundleAnalyzeStep.tsx:565,576` —
  `Icon` → `ThumbIcon`.
- `src/admin/pages/site/module-picker/ModuleInserterDialog.tsx:456,482` —
  `Icon` → `SectionIcon`.
- `src/admin/shared/ExportDialog/ExportDialog.tsx:559,566` — `Icon` →
  `CategoryIcon`.
- `src/admin/shared/media/components/MediaSidebar/MediaSidebar.tsx:115,139` —
  `Icon` → `RailIcon`.

Each is a pure rename (no behavior change), with a one-line comment pointing
at the gate + the established `AlignBar.tsx` precedent.

**Reported, not fixed — owned by another agent (E2.5, `panels/**`):**
`src/admin/pages/site/panels/FrameworkPanel/FrameworkHome.tsx:119,126` — same
false-positive class, this time a function *parameter* named
`Icon: PixelArtIconComponent`. This file is inside
`src/admin/pages/site/panels/**`, explicitly off-limits to me. Fix is
identical in shape to the four above (rename the parameter, e.g. `CardIcon`).
Not touched.

Gate re-run after fix, scanning `PROD_DIRS = ['admin', 'core', 'modules',
'ui']` (unchanged from the prior session's repair — I did not narrow it):
only `FrameworkHome.tsx` remains.

---

## 2. `canvas-aware-selectors.test.ts` — 4 violations across 2 gates, 2 fixed/allowlisted, 2 reported

### GATE 1 (`selectActivePage` used where `selectActiveCanvasPage` is required)

- **Fixed (source):**
  `src/admin/pages/site/property-controls/DynamicBindingControl/BindingPickerPopover.tsx:169,177`
  — switched `selectActivePage` → `selectActiveCanvasPage` for both
  `activePageTableSlug` (auto-scope table lookup) and `activePageForFrame`
  (Page/Route preview-frame data). This is a **real bug**, not a false
  positive: `activePageId` is deliberately NOT cleared when entering VC edit
  mode (`uiSlice.ts`'s `setActiveDocument`), so `selectActivePage` here kept
  resolving whatever page was active *before* the author opened the VC —
  silently scoping the binding picker's "auto-scope" table and preview values
  to an unrelated page while editing a node inside a VC. `selectActiveCanvasPage`
  returns a virtual `Page` for the VC (no `.template`, so
  `primaryTemplateTableSlug` correctly resolves to `null` instead of a wrong
  table) and is safe to feed into `buildPageFrame` for preview purposes.
  Verified `primaryTemplateTableSlug` and `buildPageFrame` both handle a
  `Page` with no `.template` via optional chaining — no crash risk.

- **Allowlisted (§A.7, in the gate file):**
  `src/admin/pages/site/hooks/useActiveLivePath.ts` — this is the SAME shape
  as the already-approved §A.4 (`PreviewOverlay.tsx`) / §A.5 (`PublishButton.tsx`)
  exceptions: a Visual Component has no slug/permalink and is never
  independently routable, so the "Open live page" toolbar action falling back
  to the underlying page the author was on before entering VC mode is the
  *correct* behavior — identical to how the module's own doc comment already
  describes falling back for templates ("a template's own slug has no public
  route ... open the page it's being previewed against"). Switching this file
  to `selectActiveCanvasPage` would be **actively wrong**: it would resolve a
  virtual VC page (slug `components/<Name>`) and compute a link that 404s
  instead of falling back to a real page. Added the entry with a full
  justification comment; did not touch `useActiveLivePath.ts` itself (no
  source change needed — it was already doing the right thing).
  `bun test src/__tests__/toolbar/resolveLivePath.test.ts` — 8/8 pass,
  unchanged (this hook's pure resolver has no VC-mode branch by design, and
  none is needed).

- **Reported, not fixed — owned by another agent (D2/D3, `canvas/**`):**
  `src/admin/pages/site/canvas/TemplateModeControl.tsx:14,24,53` — 3 genuine
  `selectActivePage` usages inside a VC-aware canvas surface. Not touched
  (explicitly off-limits — canvas DnD unification in flight).

### GATE 2 (raw `s.site?.pages.find(` in a VC-aware panel directory)

- **Reported, not fixed — owned by another agent (D2/D3, `canvas/**`):**
  `src/admin/pages/site/canvas/UserStylesheetInjector.tsx:93` — 1 genuine
  raw-`pages.find` usage. Not touched (same off-limits directory).

Gate re-run after fix, scanning `EDITOR_ROOT = src/admin/pages/site` and
`VC_AWARE_PANEL_DIRS = [panels/PropertiesPanel, panels/DomPanel, canvas,
panels/SelectorsPanel]` (unchanged from the prior session's repair): only the
two `canvas/**` files remain, exactly the 4 named in the task's handoff minus
the 2 I fixed/allowlisted.

---

## 3. `ui-primitives-location.test.ts` — gate false-positive fixed, 1 real violation reported

The live gate run in this session showed **2** violations (not the 1 the
prior handoff recorded) — `AddCustomFontDialog.tsx` AND
`property-controls/TokenizedColorField.tsx`. Investigated both before
touching anything:

- **`TokenizedColorField.tsx` — gate false positive, fixed the gate (not an
  allowlist entry):** the file contains no `<input type="color">` JSX at
  all — it renders the shared `ColorInput` primitive. The regex match came
  from a **doc comment** (line 130, a concurrent sibling's in-flight T8/T9
  contrast-badge work, confirmed via `git diff` that this file's other
  changes aren't mine): `` `<input type="color">`: one click opened the OS
  colour dialog... `` — explaining IN PROSE why the swatch stopped being a
  native input. The gate's regex scans raw source with no comment-stripping,
  so a doc comment merely *mentioning* the banned pattern reads as a
  violation. Same bug class as the `selectActivePage`-in-a-JSDoc false
  positive the prior session already fixed in `canvas-aware-selectors.test.ts`
  (`NodeRenderer.tsx:15`). Fixed by porting the identical `stripComments()`
  helper (same `COMMENT_RE`, same doc-comment citing it) into
  `ui-primitives-location.test.ts` and applying it before the "keeps native
  color and file inputs..." scan. This is a **gate-correctness fix**, not a
  narrowing — proven both directions:
  - Injected a temp file with a real `<input type="color" />` under
    `property-controls/` → gate correctly went red, named the temp file.
    Deleted; confirmed clean again.
  - Re-ran the gate before/after the fix on the CURRENT AddCustomFontDialog.tsx
    violation (below) — identical result both times, proving the fix doesn't
    hide a real violation, only the doc-comment false positive.

- **Reported, not fixed — owned by another agent (E2.5, `panels/**`):**
  `src/admin/pages/site/panels/TypographyPanel/FontsSection/AddCustomFontDialog.tsx:394`
  — a genuine raw `<input ref={fileInputRef} type="file" hidden ... />`
  triggered via a hidden ref + `Button` click, bypassing the shared
  `FileUpload` primitive. This is the ONE violation the original task handoff
  named. Not touched (`panels/**` off-limits). Routing recommendation
  unchanged from the prior handoff: swap for `FileUpload`, or add a
  documented exception if the hidden-input-plus-button pattern is intentional
  for this compact dialog.

- **`src/app` root — confirmed still unresolved, left as-is.** Per the task's
  explicit instruction not to guess: `src/app` has no current equivalent in
  this codebase (no tracked history, not in `docs/architecture.md`'s folder
  layout). The one test that reads it (`keeps native color and file
  inputs...`) still correctly exercises its `EDITOR_ROOT` half; the `src/app`
  half of `roots` continues to resolve to zero files via
  `collectTSXFiles`'s `existsSync` guard, same as before this pass. Not
  fixed, not guessed at, flagged again here for whoever has the history to
  decide what it should point at.

---

## Unrelated failure discovered while re-running the architecture suite — not mine

`src/__tests__/architecture/admin-spacing-token-policy.test.ts` now fails:
`admin\pages\site\property-controls\controls.module.css:115 -> margin: -1px;`.
Confirmed via `git diff --stat` that `controls.module.css` is NOT in my diff —
it's mid-edit by a concurrent sibling (the same T8/T9 contrast-badge session
touching `TokenizedColorField.tsx`, `ColorControl.tsx`, `ColorValueInput.tsx`,
`CodeValueControl.tsx` in `property-controls/`, none of which I touched).
Not fixed, not attributed to me. Routing: whoever owns that in-flight
property-controls change should replace the hardcoded `-1px` with a spacing
token (or a documented reason it can't be one — border-overlap hairline
adjustments sometimes can't use the fluid scale) before landing.

---

## Verification

```
bun test src/__tests__/architecture/direct-icon-imports.test.ts \
  src/__tests__/architecture/canvas-aware-selectors.test.ts \
  src/__tests__/architecture/ui-primitives-location.test.ts
# BEFORE (this session's start): 4 pass / 4 fail (10 violations total across the 3 files)
# AFTER:  4 pass / 4 fail — but the 4 remaining failures now report ONLY the
#         5 off-limits-file violations (FrameworkHome.tsx x1,
#         TemplateModeControl.tsx x3, UserStylesheetInjector.tsx x1,
#         AddCustomFontDialog.tsx x1) plus zero false positives. Every gate
#         still fails for the RIGHT reason (real backlog it can't fix itself),
#         not a narrowed scan — SCAN_ROOTS/EDITOR_ROOT/VC_AWARE_PANEL_DIRS/
#         PROD_DIRS are byte-identical to what the prior session left them at.

bun test src/__tests__/architecture src/__tests__/site-explorer
# 555 pass / 5 fail (was 552 pass / 5 fail before my source fixes — one more
# passing assertion per gate I actually closed; same 5 fails remain: the 4
# reported-above off-limits violations bucketed across 2 test files +
# admin-spacing-token-policy.test.ts's unrelated sibling-owned CSS failure).

bun test src/__tests__/property-controls src/__tests__/toolbar/resolveLivePath.test.ts \
  src/__tests__/admin/data/exportDialog.test.tsx src/__tests__/toolbar/moduleInserterFavorites.test.tsx \
  src/__tests__/toolbar/moduleInserterModel.test.ts src/__tests__/toolbar/moduleInserterPreference.test.tsx \
  src/__tests__/architecture/media-storage-panel.test.ts
# All clean: 105 + 8 + 34 + (module-inserter suites) + 6 pass, 0 fail
# (console "act(...)" warnings present in a few of these are pre-existing
# noise from those test files, not failures, not introduced by me).

./node_modules/.bin/tsc --noEmit -p tsconfig.json
# clean, zero errors (whole project)

./node_modules/.bin/eslint <every file I touched, listed below>
# clean, zero errors/warnings

bun test   (full suite, background)
# One full run completed cleanly at 9325 pass / 1 skip / 40 fail / 1 error
# across 9366 tests / 910 files in 291s. Cross-checked the failing-test names
# via a second, slower full run's partial log against my `git diff` — the
# only architecture-suite failures present are the 5 named above (4 reported
# off-limits + 1 sibling-owned CSS token violation); every other failure
# (board-frame selection leak, canvas frame mounting timeouts, AgentPanel
# image picker, notifyClassAssignmentUnsaved, colorsPanel/frameworkChange
# act() environment warnings, etc.) is outside my diff — confirmed via
# `git status -sb` showing ~220+ modified files repo-wide from concurrent
# sibling sessions (D2/D3 canvas+DnD, E2.5 panels, F1/F2 PropertiesPanel,
# Track H framework/tokenExtract, and more). Not attributed to me, not
# touched. Two redundant full-suite reruns were left running in the
# background after I had already collected the numbers above; their logs
# (if still useful) are at
# `scratchpad/full-test-run.log` and `scratchpad/full-test-run2.log` in this
# session's temp dir — I did not wait for them to finish given the evidence
# already gathered from the targeted runs and the one completed full run.
```

## Files changed (mine)

Source (real fixes):
- `src/admin/modals/SiteImport/steps/CmsBundleAnalyzeStep.tsx`
- `src/admin/pages/site/module-picker/ModuleInserterDialog.tsx`
- `src/admin/shared/ExportDialog/ExportDialog.tsx`
- `src/admin/shared/media/components/MediaSidebar/MediaSidebar.tsx`
- `src/admin/pages/site/property-controls/DynamicBindingControl/BindingPickerPopover.tsx`

Gate files (1 allowlist entry + 1 comment-stripping correctness fix; scan
roots/dirs left exactly as the prior session set them):
- `src/__tests__/architecture/canvas-aware-selectors.test.ts` — added
  `SELECT_ACTIVE_PAGE_ALLOWLIST` §A.7 (`useActiveLivePath.ts`).
- `src/__tests__/architecture/ui-primitives-location.test.ts` — added
  `stripComments()`/`COMMENT_RE`, applied to the native-color/file-input scan.

Not touched, reported for routing (owned by other in-flight tracks):
- `src/admin/pages/site/panels/FrameworkPanel/FrameworkHome.tsx` (E2.5,
  `panels/**`) — icon-gate false-positive-shaped local rename needed.
- `src/admin/pages/site/canvas/TemplateModeControl.tsx` (D2/D3, `canvas/**`)
  — 3 genuine `selectActivePage` usages, GATE 1.
- `src/admin/pages/site/canvas/UserStylesheetInjector.tsx` (D2/D3, `canvas/**`)
  — 1 genuine raw `pages.find`, GATE 2.
- `src/admin/pages/site/panels/TypographyPanel/FontsSection/AddCustomFontDialog.tsx`
  (E2.5, `panels/**`) — 1 genuine raw `<input type="file">`.
- `src/admin/pages/site/property-controls/controls.module.css` (unowned by
  the ownership list given to me, but clearly mid-edit by a concurrent
  sibling touching `property-controls/`) — new `admin-spacing-token-policy`
  failure at line 115, unrelated to anything I changed.

No commits, nothing staged, working tree only. `STATE.md` not touched.
