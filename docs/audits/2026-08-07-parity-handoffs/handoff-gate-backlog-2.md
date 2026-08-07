# canvas-engineer handoff — clearing the freed-owner gate backlog

Scope: the 3 items in `handoff-gate-backlog.md` that were blocked on other
agents' file ownership (`TemplateModeControl.tsx` ×3, `UserStylesheetInjector.tsx`
×1, `controls.module.css:115`). Those owners (D2/D3 canvas+DnD, the T8/T9
contrast-badge track) have finished, so all three files were free to touch.

No commits, nothing staged (`git status -sb` only shows working-tree
modifications), `STATE.md` untouched, per the absolute constraints.

---

## 1. `canvas-aware-selectors.test.ts` — `TemplateModeControl.tsx` (3 occurrences)

**Fixed at the source** (not allowlisted). Checked on the merits first:
`TemplateModeControl` explicitly bails (`if (isVcMode || …) return null`)
before ever using `activePage`, so the component was never *visibly* wrong —
`selectActivePage` and `selectActiveCanvasPage` only diverge when
`activeDocument.kind === 'visualComponent'`, and that exact condition is what
`isVcMode` already gates on. Also confirmed `flattenVCToVirtualPage`
(`src/core/visualComponents/virtualPage.ts`) never sets `.template` on the
synthesized VC page, so the `!activePage.template?.enabled` check alone would
have caught it too.

Given the fix is genuinely free (in page mode, `selectActiveCanvasPage`
delegates straight to `selectActivePage` — see store.ts §A.6 — so this is a
no-behavior-change swap) and the gate's whole point is "canvas-surface
components read the canvas-aware selector," I fixed it rather than adding a
4th allowlist entry that would just restate "it's fine because a separate
manual guard already covers it" — that's exactly the kind of guard a future
edit could accidentally remove or reorder.

Changed (`src/admin/pages/site/canvas/TemplateModeControl.tsx`):
- import `selectActiveCanvasPage` instead of `selectActivePage`
- `const activePage = useEditorStore(selectActiveCanvasPage)`
- `PreviewSourceSelectProps.page: NonNullable<ReturnType<typeof selectActiveCanvasPage>>`

`isVcMode` guard left in place unchanged (still correct, still the most
readable statement of "templates are a page-only concept").

## 2. `canvas-aware-selectors.test.ts` (GATE 2) — `UserStylesheetInjector.tsx`

**Fixed at the source — this one is a real bug**, same class as the
`BindingPickerPopover.tsx` finding from the prior pass. Traced the data flow:
`CanvasRoot.tsx:91` resolves `canvasPage = useEditorStore(selectActiveCanvasPage)`
and threads it down through `CanvasTransformLayer` → `BreakpointFrame` →
`IframeFrameSurface`, which mounts `UserStylesheetInjector` per frame. In VC
edit mode that's a **virtual Page** (`vc-virtual:<vcId>`, from
`flattenVCToVirtualPage`) that is never a member of `site.pages`.
`UserStylesheetInjector`'s own `activePageScope` selector, though, did
`s.site?.pages.find(p => p.id === s.activePageId) ?? s.site?.pages[0]` —
and `s.activePageId` is deliberately **not cleared** when entering VC mode
(`uiSlice.ts`), so it kept resolving whatever *real* page the author was on
before opening the VC. That real page's `id`/`template` then fed
`assetScopeAppliesToPage` (`runtimeConfig.ts`) for **the frame currently
showing the VC's content** — so a "this page only" user stylesheet scoped to
the stale real page would wrongly apply inside the VC-editing frame, and a
stylesheet actually scoped to the VC page would never match (no `id` in
`site.pages` matches a `vc-virtual:` id in the first place).

Fix: replaced the raw `pages.find` with `selectActiveCanvasPage(s)` inside
the same `useShallow` selector, keeping the exact narrow-slice/effect-gated
pattern C3 built (see below — verified this did not regress it). Also
dropped the `?? s.site?.pages[0]` fallback-to-first-page: it had no
counterpart in `CanvasRoot`'s own canonical resolution (`selectActiveCanvasPage`
has none), so if `canvasPage` is null nothing is actually rendered in that
frame and there is nothing for a fallback scope to usefully serve — keeping
it would have meant the injector's scope resolution could disagree with what
is literally on screen.

Changed (`src/admin/pages/site/canvas/UserStylesheetInjector.tsx`):
```ts
const activePageScope = useEditorStore(
  useShallow((s) => {
    const page = selectActiveCanvasPage(s)   // was: s.site?.pages.find(...) ?? s.site?.pages[0]
    return page ? { id: page.id, template: Boolean(page.template) } : null
  }),
)
```
Added a comment on the `selectActiveCanvasPage` call explaining why the raw
`pages.find` was wrong, and imported it from `@site/store/store` alongside
the existing `useEditorStore` import. No other lines in the effect/deps
changed.

### C3 render-scope tests — confirmed still green, both directions

Re-read `handoff-c3-injectors.md` first per the task's warning. Ran the exact
Profiler-based regression suite before AND after my edit:

```
bun test src/__tests__/canvas/userStylesheetInjectorRenderScope.test.tsx \
         src/__tests__/canvas/canvasComposedTreeRenderScope.test.tsx \
         src/__tests__/canvas/canvasCssLayerOrder.test.tsx \
         src/__tests__/canvas/classStyleInjector.test.ts \
         src/__tests__/architecture/canvas-aware-selectors.test.ts \
         src/__tests__/architecture/admin-spacing-token-policy.test.ts
→ 31 pass / 0 fail (98 expect() calls)
```

The render-scope test only exercises page mode (no VC), where
`selectActiveCanvasPage(s)` delegates straight to `selectActivePage(s)` (same
cached lookup, same object identity per store update) — so the measured
render counts (frame-1/frame-2 stay at 1 render on an irrelevant node-content
edit, both increase on a real style-file change) are unaffected. Did not
touch `files`/`runtime` selectors, the effect's dependency array shape, or
the `useShallow` wrapper — only what's computed *inside* it.

---

## 3. `admin-spacing-token-policy.test.ts` — `controls.module.css:115` (now `:136` after the sibling's finished edit)

**Fixed.** By the time I got to this file, the T8/T9 contrast-badge track had
already landed (as the backlog doc predicted), so the offending line had
shifted from `:115` to `:136`, still `margin: -1px;` inside `.hiddenColorInput`
— the classic visually-hidden-input trick (`position: absolute; width: 1px;
height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0);`).

Did not invent a new token. Found the exact same pattern already token-ified
twice elsewhere in the codebase (`SettingsModal.module.css`'s `.srOnly`,
`CodeEditorPanel.module.css`'s `.loadingSrOnly`), both using
`margin: calc(var(--space-px) * -1);` against the existing `--space-px: 1px;`
token in `globals.css`. Applied the identical fix — no new token needed, no
`var(--name, fallback)`, matches established convention exactly.

```css
/* before */
margin: -1px;
/* after  */
margin: calc(var(--space-px) * -1);
```

---

## Verification

```
bun test src/__tests__/architecture/canvas-aware-selectors.test.ts
  → 2 pass / 0 fail

bun test src/__tests__/architecture/admin-spacing-token-policy.test.ts
  → 5 pass / 0 fail

bun test src/__tests__/architecture src/__tests__/site-explorer
  → 558 pass / 2 fail — both remaining failures are the two panel items
    listed below as NOT mine (FrameworkHome.tsx icon-gate, AddCustomFontDialog.tsx
    file-input gate). canvas-aware-selectors and admin-spacing-token-policy
    are now fully green — the 3 items I owned are closed.
    (A `module-size-budgets` failure on server/handlers/studioWriteback.ts —
    701 lines — also showed up in a wider run; confirmed via `git diff --stat`
    that file is NOT in my diff, owned by the concurrent E2.2 track. Not
    touched, not mine.)

bun test src/__tests__/canvas
  → 606 pass / 6 fail on the first run — all 6 are timing/act-warning-style
    failures (`boardFrameVariantSelection.test.tsx`'s selection-leak-between-
    frames pair, `canvasFrameMounting.test.tsx` ×3, `canvasFormControls.test.tsx`)
    with 5000ms timeouts, consistent with resource contention from the many
    parallel sibling sessions currently running on this machine (this is the
    exact "board-frame selection leak, canvas frame mounting timeouts" the
    PRIOR agent's handoff also observed and attributed to "not mine"/environment,
    not a real regression). Re-ran each of the 3 affected test files in
    isolation — all pass cleanly, 0 fail, confirming this is contention, not
    a regression from my change:
      bun test src/__tests__/canvas/boardFrameVariantSelection.test.tsx  → 2 pass / 0 fail
      bun test src/__tests__/canvas/canvasFrameMounting.test.tsx         → 3 pass / 0 fail
      bun test src/__tests__/canvas/canvasFormControls.test.tsx          → 1 pass / 0 fail

bun test src/__tests__/property-controls
  → 109 pass / 0 fail (act() warnings present, pre-existing noise, not failures)

./node_modules/.bin/tsc --noEmit -p tsconfig.json
  → clean, zero errors

./node_modules/.bin/eslint src/admin/pages/site/canvas/TemplateModeControl.tsx \
                            src/admin/pages/site/canvas/UserStylesheetInjector.tsx
  → clean, zero errors/warnings
```

Did NOT run `bun run lint` / `bun run build` per the task's instruction
(siblings collide on `dist/`/`.tsbuildinfo`), and did not run the full
`bun test` suite (targeted suites above cover every file I touched plus the
gates I was asked to close; the task's own baseline — 9325 pass / 40 fail —
was established by the prior agent's completed full run and I have no reason
to believe my 3-file, behavior-narrowing change moved that number in any
direction other than -2 gate failures).

## Files changed (mine — 3 files, all working-tree only)

- `src/admin/pages/site/canvas/TemplateModeControl.tsx` — `selectActivePage` → `selectActiveCanvasPage` (import, hook call, prop type).
- `src/admin/pages/site/canvas/UserStylesheetInjector.tsx` — raw `s.site?.pages.find(...)` → `selectActiveCanvasPage(s)` inside the existing narrow `useShallow` selector; dropped the `pages[0]` fallback; added explanatory comment; added `selectActiveCanvasPage` to the existing store import.
- `src/admin/pages/site/property-controls/controls.module.css` — `.hiddenColorInput`'s `margin: -1px` → `margin: calc(var(--space-px) * -1)` (line was `:115` in the original backlog, `:136` by the time I got there — same violation, shifted by the sibling's finished edit).

No gate test files touched — both `canvas-aware-selectors.test.ts` and
`admin-spacing-token-policy.test.ts` are closed by source fixes, not new
allowlist entries, so their `ALLOWLIST`/`SCAN_ROOTS` are byte-identical to
what the repair session left them at (I diffed the gate files: 0 changes).

## Still needing an owner (confirmed NOT touched, per explicit instruction)

- `src/admin/pages/site/panels/FrameworkPanel/FrameworkHome.tsx:119,126` —
  icon-gate false-positive-shaped: function *parameter* named
  `Icon: PixelArtIconComponent`. Same fix shape as the 4 already-fixed
  siblings in the prior pass (rename the param, e.g. `CardIcon`). `panels/**`,
  owned by E2.5.
- `src/admin/pages/site/panels/TypographyPanel/FontsSection/AddCustomFontDialog.tsx:394` —
  genuine raw `<input type="file" hidden>` bypassing the `FileUpload`
  primitive. `panels/**`, owned by E2.5.

Both confirmed still red in the gates above; neither is in my diff
(`git status -sb` shows only the 3 files listed).
