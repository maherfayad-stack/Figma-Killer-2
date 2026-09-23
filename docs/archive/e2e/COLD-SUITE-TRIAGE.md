# e2e cold-suite triage

Branch `test/e2e-cold-suite-triage` off `9716abf7` (= `main` `51b19940`).

## The baseline run (cold, full suite, 1.1h)
`68 unexpected · 49 expected · 14 skipped`. "expected" includes the passing tests AND the
cases already annotated `test.fail()` naming a recorded defect — so github-sync 2b/6b/8 and
agent-turn's fidelity case are NOT part of the 68; they are already-owned defects.

Per-test failure reasons were read out of the run's own HTML-report payload
(`.tmp/playwright-report/index.html` → embedded zip → per-file JSON), not guessed.

## Rule (unchanged)
Delete a test only when the surface it tested is genuinely gone. When the capability survives
and only the authoring path was removed, re-point the test. Never weaken an assertion to make
it pass.

## Root cause 1 — the Explorer tab family is gone (≈50 of the 68)
`tests/e2e/helpers/editor.ts` still drives a CMS-era left panel:

- `openExplorerTab(page, 'Site'|'Code'|'Media')` waits for a tab row inside
  `role=complementary[name=Explorer]`.
- `src/admin/pages/site/panels/ExplorerPanel/ExplorerPanel.tsx` says in its own docblock:
  *"Studio's explorer body: no tab row… Studio has no separate 'Site'/'Code'/'Media' concepts
  of its own (those were CMS-only content-workspace ideas that lived here as a tab row over
  panels that have since been deleted)."*
- `openSitePanel` then waits for a **"New page"** button; the only "New page" left in the
  product is a section label inside `canvas/BoardFramesLayer/AddPagePicker.tsx`, and that
  picker takes **no name and no slug** — the server auto-names a page for its `PAGE_KIND`.
- `createPage(page, name, slug)` fills a `New page` dialog that no longer exists.

Every one of those tests dies on a 60s timeout inside `openExplorerTab` at `editor.ts:132`.
Files affected: `visual-builder` (22), `page-management` (6), `command-palette` (10, via
`createPage`), `runtime-dependencies` (2), `accessibility` (1), `background-image-smoke`,
`error-handling`, `performance`, `preview-live`, `reliability`, `site-files` (1 each).

**The capabilities under test mostly survive** — inserting modules, selecting layers, editing
text, undo/redo, clipboard, layer reorder, the Classes panel, spacing/colour/typography
controls, publishing. Only the way the spec *obtains a page* is dead. So this is a re-point,
not a delete: author the page on disk with `helpers/studioFixtureProject.ts`
(`createAuthoredFixtureProject`) and open it on a board, the way the Studio-native specs
(`css-writeback`, `structural-writeback`, `design-system-insert`, `studio-feel-phase0`)
already do.

Sub-population that IS a delete — CMS-only concepts with no Studio surface at all:
- `visual-builder` SITE-018 posts template (`New post` button, disabled → gone)
- `visual-builder` SITE-019 layouts
- `page-management` PUBLISH-002 scheduling, PAGE-002 rename-by-slug, `error-handling` REL-002
  page-slug validation — the slug model is CMS-side; Studio names a page from its file.

## Root cause 2 — deleted admin routes (≈6)
PR #18 left only `/admin/dashboard`, `/admin/site`, `/admin/account`,
`/admin/plugins/:pluginId/:pageId`.
- `admin-navigation` "moves between Site, Content, Plugins, Users, and Account" → delete.
- `admin-navigation` ADMIN-005 waits for `content-explorer-panel` → delete that leg.
- `accessibility` A11Y-002 wants a toolbar `link[name=Content]` → delete the removed hops.
- `command-palette` SPOT-011/013 want a `Go to Content` option and SPOT-010 a `group[name=Content]`.
  Check whether the palette still publishes a Content group; if not, re-point to a live group.
- `admin-navigation` ADMIN-003/ADMIN-004 want `heading[name=Overview]` on `/admin/dashboard`.
  **Stale assertion, live surface:** `DashboardPage.tsx:397` renders `greetingFor(displayName)`
  as its title. Re-point — do not delete.

## Root cause 3 — Studio-native failures worth treating as product signal (12)
These do not touch the dead helpers, so they are either real defects or full-suite-load
artefacts. An isolation run of the first four files is in flight to tell them apart.

| Spec | Failure | Reading |
|---|---|---|
| `studio-feel-phase0` ⌘D×5 | "presses were dropped rather than queued" — 2 copies, not 5 | store-14's queue contract. Was green at the wave-3 merge head, run alone. |
| `studio-feel-phase0` ⌘G/⌘⇧G | the SECOND ⌘G wrote nothing | struct-11's contract, same story |
| `studio-feel-phase0` auto-promote | `live-runtime-pill` never reads "live" | Tier-2 auto-promote (decision 2) |
| `studio-feel-phase0` dev-server case | `EPERM` unlinking `__e2e-phase0-vite` | fixture teardown vs a live Vite child on Windows |
| `css-writeback` ×2 | selecting a node does not bind the Style panel to a class (`style-target-chip-class`) | |
| `structural-writeback` ×2 | `dom-tree-item-pages/Home.tsx:7:8` never appears in the layers tree | the fixture's page never parsed |
| `design-system-insert` ×2 | written .tsx differs by one line; the other times out at 180s | |
| `frame-file-drop` | nothing written into `public/` — relay or `POST /admin/api/studio/asset-drop` | sec-17 landmine 6 territory |
| `ai.e2e.ts` ×6 | strict-mode violations (a filter matching 3 Delete buttons), a missing `menuitemradio`, 2 timeouts | test-side selector drift + one real gap |

The four writeback/insert/file-drop files all build their fixture the same way, and two of them
fail with "the element never appeared in the tree" — one shared fixture-parse cause is more
likely than four independent defects.

---

# Root cause 3, resolved (2026-09-19)

The 7 Studio-native failures reproduce **in isolation** (5.9 min, same 7), so they are not
full-suite load artefacts. Two distinct causes, both proven:

## 3a — three specs opened the board without resetting the view
`css-writeback`, `structural-writeback` and `design-system-insert` each carried a PRIVATE
`openStudioBoard` that went straight from `page.goto('/admin/site?studio')` to a
`page.mouse.click(box.x + w/2, …)`. The canvas has no scroll container: where a frame lands is
decided by a "center on open" pass that races the arrival of the page documents it centres on,
so on a cold load the board settles pointed somewhere with no frame in it. Every click landed
on empty canvas. Nothing was selected — and the failures read as product bugs
("selecting .hero-title did not bind the Style panel to a class", "the nested element never
appeared in the layers tree").

The shared `helpers/studioFixtureProject.ts` already solved this: `openFixtureBoard` presses the
product's own **Ctrl+0** after the board attaches, and `panIntoView` puts a target under the
pointer before a click. `frame-file-drop` and `studio-feel-phase0` use it and do not have the
symptom. Fix: delete the three private copies, use the shared ones.

Evidence it was the cause: with only that change, the click selects, the layers tree expands to
the node, and the inspector binds — the snapshot goes from `Body → Container` and an empty right
sidebar to `Body → Container → Text[selected]` with `.hero-title` bound and its real font-size.

## 3b — two assertions were left behind by wave 3
- `style-target-chip-class` — panel-41's inspector-density work deleted `WriteTargetRow` as a
  duplicate of the ClassPicker above it. `StyleTargetChip` now renders ONLY for a
  multi-selection (`MultiSelectTargetBar.tsx`). For a single selection the write target is the
  class pill: `class-chip-<name>`, wrapped in `write-target-chip-<classId>` whose
  `data-locked="false"` carries what `data-writable="true"` used to. **Wave 3 changed the
  inspector and did not re-point the e2e that asserted the old surface.**
- `style-category-size` / `css-size-scrub-width-field` — Size was absorbed into **Measures**
  (`MIGRATED_SECTION_PROPERTIES`, `MeasuresSection.tsx` renders `SizeSection`). The width
  control is `css-size-input-width` → `textbox[name="Width"]`, and Measures is always mounted,
  so there is no category to navigate to first.
- `structural-writeback`'s "dragging into a different parent REFUSES" — **premise obsolete.**
  W4-1 made a same-file reparent a real write (`moveJsxElement.ts` takes a destination naming
  the new parent; `transplantJsxElement.ts` writes the cross-file case). Rewritten to assert the
  write. **Gap left open:** the refusal that survives is about SCOPE
  (`freeVariablesOutOfScopeAt` — markup lifted out of a `.map` callback). No e2e covers it; that
  case needs a fixture with a `.map` and belongs to whoever owns W4-1.

## Result
`css-writeback` 2/2 green · `structural-writeback` reorder green.

## Still red after 3a/3b, and confirmed reproducible (NOT fixed here)

| Spec | Evidence | Reading |
|---|---|---|
| `design-system-insert` — "inserting a component from the picker writes the .tsx" | the picker wrote `<Button cardLast4="1394" label="Label" …/>`; the spec expected `<Button dir="ltr" label="Button" …/>`. The fixture's own design system is literally `export function Button() { return null }` — **no props at all**, so BOTH the expected and the received attributes are invented somewhere else, and `cardLast4` is an ALM design-system prop. | Worth a product look: the picker appears to fill props from a component matched by NAME rather than from the project's own package, and the value it picks is not stable between runs. The spec's expectation was only ever a snapshot of that. |
| `design-system-insert` — "package CSS actually applies" | `locator.evaluate` times out at 180 s reading computed style off `button.btn` | unchanged by 3a; not diagnosed |
| `frame-file-drop` | "nothing was written into the project's `public/` — either the relay never carried the drop out of the frame, or `POST /admin/api/studio/asset-drop` refused it" | this spec ALREADY used the shared opener, so 3a was never its cause. sec-17 landmine 6 territory. |
| `studio-feel-phase0` ⌘D×5 (2 copies, not 5), second ⌘G writes nothing, Tier-2 auto-promote pill never reads "live", `EPERM` unlinking `__e2e-phase0-vite` | these were green when each was run alone at the wave-3 merge head | re-check individually; the ⌘D and ⌘G ones are store-14's and struct-11's own contracts |
| `ai.e2e.ts` ×6 | strict-mode violations (a `filter({hasText})` matching 3 Delete buttons), a missing `menuitemradio`, 2 timeouts | test-side selector drift, plus one real gap |
