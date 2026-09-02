# Track C3 handoff — whole-`s.site` selectors in canvas injectors

## Scope

Fixed the three files named in `STUDIO-FIGMA-PARITY-PLAN.md` §6 (C3) / audit
06 (E9): `UserStylesheetInjector.tsx`, `CanvasComposedTree.tsx`,
`useRuntimeScriptBuild.ts`. Each subscribed to the WHOLE `s.site` object
(directly, or transitively via a same-render-body call) and did real work
(CSS regex transforms, `JSON.stringify`, a template-matching pass) in the
render body, gated by nothing. `site`'s top-level reference changes on every
site-touching mutation anywhere in the document (Mutative mints a new root
per mutation), so all three re-ran on every keystroke, in every mounted
frame — not just the frame being edited.

Followed `ClassStyleInjector.tsx`'s existing pattern (narrow slices +
effect-gated recompute) exactly as instructed — no new mechanism invented.

## Measured before/after (real numbers, via `Profiler`-instrumented tests)

Two new regression tests mount 2 "frames" (mirroring 2 board frames showing
different pages, or 2 breakpoint iframes of the same page) and count actual
React re-renders via `<Profiler onRender>`, then drive a real store mutation
(`updateNodeProps`, the exact path a Properties Panel keystroke takes) and
assert on the *other*/*irrelevant* frame's render count.

I proved each one BOTH ways: ran it against the pre-fix code (via a scoped
`git stash` of just the fixed files) to confirm it fails there, then restored
the fix and confirmed it passes.

| Test | Pre-fix (measured) | Post-fix (measured) |
|---|---|---|
| `CanvasComposedTree` — frame B's render count after an edit to frame A's page | **2** (re-rendered on an edit to a DIFFERENT page) | **1** (unchanged) |
| `UserStylesheetInjector` — frame render count after a keystroke on the active page's own text (CSS-irrelevant) | **2** (recomputed CSS + regex transforms for a content edit) | **1** (unchanged) |

Both tests also assert the POSITIVE case — the count *does* increase when the
input the CSS/template-matching genuinely depends on changes (a style file's
content, or the active page's node text respectively) — so this is not just
"stop re-rendering," it's "re-render exactly when correct."

New test files (both pass now, both fail against the pre-fix code):
- `src/__tests__/canvas/canvasComposedTreeRenderScope.test.tsx`
- `src/__tests__/canvas/userStylesheetInjectorRenderScope.test.tsx`

These double as the "cheap regression gate" the task asked for — they will
catch a future regression back to a whole-`site` (or whole-`page`) subscription
in either file. I did not add a generic `useEditorStore`-scanning architecture
gate (like `no-full-site-scan-in-selectors.test.ts`, which only catches
`for (const page of X.pages)`, not "subscribes to `s.site` directly") because
that would be a second, broader mechanism not asked for here and risked
false-positiving on legitimate whole-`site` reads elsewhere (e.g. save/reload
code) — the two targeted Profiler tests are the honest, scoped gate for
these three files specifically.

`useRuntimeScriptBuild`'s existing coverage in `canvasMode.test.tsx`
("does NOT rebuild on a node-tree edit", "rebuilds when a script file
changes", "rebuilds when packageJson changes") already exercised the exact
contract my fix preserves — all three still pass unchanged (see below), so I
did not duplicate that with a third Profiler test; its narrower `files`/
`runtime`/`packageJson`/`hasSite` selectors are covered by that pre-existing
suite plus `tsc`.

## Exact slices each file now subscribes to

### `UserStylesheetInjector.tsx`
- `files = s.site?.files ?? EMPTY_FILES` — reference-stable across node edits (Mutative structural sharing keeps untouched sibling keys of `site` unchanged).
- `runtime = s.site?.runtime ?? null` — same.
- `activePageScope = useShallow(s => { const page = s.site?.pages.find(p => p.id === s.activePageId) ?? s.site?.pages[0]; return page ? { id: page.id, template: Boolean(page.template) } : null })` — only `id` + template-PRESENCE (not the template's own content, and never the page's node content) feed `assetScopeAppliesToPage`, so this is the true minimal dependency. `useShallow` keeps its identity stable unless the active page changes or its template is toggled on/off.
- The CSS computation itself moved into a `useEffect` gated on `[targetDocument, viewport, files, runtime, activePageScope]`. Inside the effect, the full `SiteDocument` is re-read via `useEditorStore.getState().site` (a non-reactive snapshot read, mirroring the existing pattern already used by `useRuntimeScriptBuild`'s debounced build callback) purely to hand `collectUserStylesheetCss` a real `SiteDocument` — this read adds no reactivity of its own.
- **Type-level change enabling this:** `collectUserStylesheetCss(site, page?: Page)` → `collectUserStylesheetCss(site, page?: RuntimeScopedPage)`. `RuntimeScopedPage` (`{ id: string; template?: unknown }`) already existed as an unexported internal type in `site-runtime/runtimeConfig.ts` (the ACTUAL type `collectAppliedStyles`/`collectRuntimeScripts` use internally) — I exported it and re-pointed `collectUserStylesheetCss`'s signature at it. Every other caller (`render.ts`, `readSurface.ts`) already passes a full `Page`, which is structurally compatible — zero call-site changes needed there.

### `CanvasComposedTree.tsx`
- `isVcMode`, `styleRules` — unchanged (already narrow).
- `templatePages = useShallow(s => s.site?.pages.filter(isTemplatePage) ?? EMPTY_TEMPLATE_PAGES)` — the WHOLE `s.site` subscription is gone. Only template-marked pages (`isTemplatePage`) participate in wrapper-chrome resolution; ordinary content pages (the overwhelming majority on a real board) never do. `useShallow` means this stays reference-stable unless: an actual template's own content changes (needed — the read-only wrapper chrome must reflect it), a page's template config is toggled, or a page is added/removed.
- **Enabling refactor:** `resolveEditorWrapperTemplates(site: SiteDocument, activeDoc: Page)` → `resolveEditorWrapperTemplates(templatePages: Page[], activeDoc: Page)` in `canvasComposition.ts`. Its only site-derived dependency was `resolveTemplateChain(site, ctx)`, which itself only ever read `site.pages` — extracted `resolveTemplateChainFromPages(pages: Page[], ctx)` in `@core/templates/templateMatching.ts` (now shared: `resolveTemplateChain` is a one-line wrapper calling it with `site.pages`, so its 10 existing callers across the codebase — module-picker, `useActiveLivePath`, `TemplateModeControl`, `DocumentSwitcher`, the publisher, etc. — are untouched, same signature, same behavior).

### `useRuntimeScriptBuild.ts`
- `hasSite = s.site !== null`, `files = s.site?.files ?? EMPTY_FILES`, `runtime = s.site?.runtime ?? null`, `packageJson = s.site?.packageJson ?? null` — the exact three fields `computeBuildSignature`'s `JSON.stringify` already only used, now selected directly instead of destructured from a whole-`site` subscription every render.
- `computeBuildSignature` signature updated to take these 4 primitives/slices instead of `site: SiteDocument | null` — same output, computed only when one of them (or page/breakpoint/template) actually changed.
- The debounced build's `setTimeout` callback still does `useEditorStore.getState().site` for the real build call (unchanged — needs the full document, non-reactive read, matches the pre-existing pattern).

## Integration-gap check (per the protocol)

- `UserStylesheetInjector` is mounted by `IframeFrameSurface.tsx:688` (`<UserStylesheetInjector targetDocument={iframeDoc} viewport={viewport} />`), one per breakpoint frame — confirmed still called, confirmed the `mc-user-styles` `<style>` tag's `textContent` still updates correctly in tests (`canvasCssLayerOrder.test.tsx`, my new render-scope test).
- `CanvasComposedTree` is mounted by `BreakpointFrame.tsx` / `AgentSnapshotFrame.tsx` / `CanvasLiveSurface.tsx` — confirmed via `grep`, and exercised end-to-end by `src/__tests__/canvas/breakpointProps.test.tsx` (59 tests, all passing) which mounts real `BreakpointFrame`s inside real iframes.
- `useRuntimeScriptBuild` is called by `CanvasRoot.tsx:496` and directly exercised by `canvasMode.test.tsx`.
- `RuntimeScopedPage` is exported through `@core/site-runtime`'s barrel (not deep-imported) and consumed structurally (no import needed at the `UserStylesheetInjector.tsx` call site — TS structural typing handles it).

## Budget added

The two new Profiler-based tests ARE the budget gate for these three files:
"an edit to page/frame A must not re-render the injector/composed-tree for
page/frame B, and must not recompute CSS for a keystroke that doesn't touch
CSS-relevant inputs." This directly encodes the plan's stated budget
(`≤ 1 re-render per visible frame, not per mounted frame`) for the C3 defect
class specifically. I did not add a new architecture-wide gate (see "why not"
above) — a broader "no `useEditorStore((s) => s.site)` anywhere" gate would be
a good future addition but needs its own allowlist audit (several legitimate
whole-`site` reads exist, e.g. save/reload paths) — out of scope for this
task's three named files.

## Landmines / things that did NOT help or weren't needed

- I considered constructing a fake `{ files, runtime } as SiteDocument` inside
  `UserStylesheetInjector`'s effect to avoid the `useEditorStore.getState()`
  re-read. Rejected: it needs an unsafe cast past `SiteDocument`'s full shape
  for no real benefit — re-reading the real `site` via `getState()` inside the
  effect is exactly the pattern `useRuntimeScriptBuild` already used for its
  debounced build call, so I matched it instead of inventing a second
  approach.
- I considered widening the architecture gate `no-full-site-scan-in-selectors.test.ts`
  (which only catches `for (const page of X.pages)`) to also catch bare
  `useEditorStore((s) => s.site)`. Didn't do it — that gate's own doc explains
  it was deliberately narrowed after a broader regex false-positived on 14
  legitimate call sites; broadening it again risks the same thing, and this
  task's ask was these three files, not a new sweep.
- Did not touch `BoardFramesLayer.tsx` / `resolveFramesWithPages.ts` (C2's
  `s.site?.pages` subscription) — explicitly out of scope, shares a page-index
  cache C2 is building concurrently.

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json   → clean
bun test src/__tests__/canvas/canvasComposedTreeRenderScope.test.tsx \
         src/__tests__/canvas/userStylesheetInjectorRenderScope.test.tsx \
         src/__tests__/canvas/canvasCssLayerOrder.test.tsx \
         src/__tests__/canvas/canvasMode.test.tsx \
         src/core/templates/__tests__/templateMatching.test.ts \
         src/__tests__/templates/templateMatching.test.ts \
         src/__tests__/templates/pageTemplateConfigTarget.test.ts \
         src/admin/pages/site/canvas/__tests__/styleRuleDarkModeRoundTrip.test.ts \
         src/__tests__/site-runtime \
         src/__tests__/publisher/render.test.ts \
         src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts
  → 123 pass / 0 fail

bun test src/__tests__/canvas   → 582 pass / 0 fail
```

Pre-existing/concurrent-agent failures observed but NOT mine (confirmed via
`git diff --stat` — none of these files are in my diff):
- `src/__tests__/store/selectorStability.test.ts` — flags a NEW `?? []` in
  `PropertiesPanel/InstanceCallSiteView.tsx:115` (a sibling's in-flight change).
- `src/__tests__/canvas/canvasNotch.integration.test.tsx`,
  `src/__tests__/canvas/selectionToolbar.test.tsx` — `ReferenceError:
  packageNotice is not defined` in `ModuleInserterDialog.tsx`, a mid-refactor
  sibling working on `module-picker`/`DepsSection` (explicitly listed as
  "not yours" in my work order).

## Files touched

- `src/admin/pages/site/canvas/UserStylesheetInjector.tsx`
- `src/admin/pages/site/canvas/CanvasComposedTree.tsx`
- `src/admin/pages/site/canvas/useRuntimeScriptBuild.ts`
- `src/admin/pages/site/canvas/canvasComposition.ts` (enabling refactor)
- `src/core/templates/templateMatching.ts` / `index.ts` (extracted `resolveTemplateChainFromPages`)
- `src/core/site-runtime/runtimeConfig.ts` / `index.ts` (exported `RuntimeScopedPage`)
- `src/core/publisher/userStylesheets.ts` (narrowed `collectUserStylesheetCss`'s `page` param type)
- New: `src/__tests__/canvas/canvasComposedTreeRenderScope.test.tsx`
- New: `src/__tests__/canvas/userStylesheetInjectorRenderScope.test.tsx`

Working tree only — nothing committed or staged, per the absolute constraints.
