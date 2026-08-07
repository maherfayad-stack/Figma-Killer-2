# E3 + E4 handoff — Dependencies panel install, generic package registration

## Bottom line

**Yes.** A component from a freshly-installed non-ALM package can now be
dragged onto an empty page, provided the project is at trust tier ≥ 1
(`render-packages`). If it isn't, the picker now says so and offers a
one-click "Promote project" instead of showing nothing.

**Human dogfood state:** open a Studio project that imports a real npm
component library (not `@alm-design/design-system`) that isn't yet a
`dependencies` entry — or add one via the Dependencies panel. Promote the
project to Tier 1 if prompted. Open the "+ Add to canvas" dialog (toolbar) on
an **empty page with no `pkg.*` node anywhere on the board** and confirm the
package's components appear under "Design System" / Modules, are draggable,
and land as a real parsed node (writes the `import` + element into the
`.tsx`). Also dogfood: click "Add" in the Dependencies panel with a real
package name (e.g. `axios`), watch "Installing axios…" appear, confirm a
toast on completion, and confirm the package now shows up as an installed
dependency (and, if it's a component library, its components become
available in the picker without a full page reload).

## E4 — registration driven by the catalog + `componentPackages`, not board contents

**File:** `src/admin/pages/site/studio/registerProjectModules.ts`

The bug: `useRegisterProjectModules`'s effect required `siteHasUnregisteredPackageNode()`
— a `pkg.*` node **already on the loaded board** — before it would ever fetch
the component bundle. Chicken/egg: nothing to drag in until something was
already dragged in.

The fix: deleted `siteHasUnregisteredPackageNode()` entirely (and its now-stale
allowlist entry in `src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts`).
The effect now calls `syncProjectModules(projectDir)` on every project-dir/
trust-tier transition, full stop — no board-contents precondition. This was
already safe to do generically: `server/handlers/studio/componentBundle.ts`'s
route already computed its OWN demand list from `ProjectProfile.componentPackages`
(via `resolveProjectProfile`, E1's `resolveProjectProfile`/`componentPackageDemand`)
— nothing server-side needed to change. The client hook's job was just to
actually CALL it unconditionally instead of gating the call behind board state.

**The trust gate is untouched and still load-bearing** (invariant 1 — parse,
never execute). I did **not** remove `componentBundle.ts`'s Tier-1 check. What
changed is that the CLIENT now calls the route even at Tier 0, so a project
that genuinely depends on a component package gets an honest refusal instead
of the route never being reached:

- `componentPackageDemand(dir).length === 0` (no component-package dependency
  at all) → route returns `{ ok: true, components: [] }` before ever checking
  trust. Zero cost, zero noise, for the overwhelmingly common "no design
  system" project.
- Demand present, trust `'static'` → route refuses with code
  `trust-tier-required` and an explicit message. Client records this via
  `setPackageBundleStatus`.
- Demand present, trust ≥ 1 → bundles and registers as before.

**"Never fails silently" — the way forward.** Previously this refusal was only
ever surfaced per-node, by `PackageComponentPlaceholder.tsx` (canvas
fallback for an *already-placed* `pkg.*` node) — useless for the "nothing on
the board yet" case. New shared component:

- `src/admin/pages/site/module-picker/PackageBundleNotice.tsx` (+
  `PackageBundleNotice.module.css`) — reads the same `getPackageBundleStatus`/
  `subscribePackageBundleStatus` external store `PackageComponentPlaceholder.tsx`
  already reads, renders the refusal message, and — only for
  `trust-tier-required` — a "Promote project" button wired to the existing
  `promoteProjectToTier1`. Returns `null` outside Studio mode or when there's
  nothing to report.
- Wired into **both** picker surfaces: `ModulePicker.tsx` (compact
  context-menu picker) and `ModuleInserterDialog.tsx` (toolbar "+ Add to
  canvas" — the actual primary insertion surface; the plan's own text names
  `ModulePicker.tsx` but the toolbar dialog is what a user actually drags
  from, so I did not leave it out).
- `syncProjectModules`'s whole body is now wrapped in try/catch (previously
  only the structured `{ok:false}` branch was handled) — see "the bug I found
  and fixed" below for why this was load-bearing, not decoration.

### `resolveModuleId` / module-id derivation — verified, not touched

Checked `server/handlers/studioPageLoad.ts`'s `resolveModuleId` and
`src/core/module-engine/packageModuleId.ts`. This was **already fixed** before
my change (presumably by the E1 sibling / earlier WS-3.3 work): a
`kind: 'component'` node whose `componentSources` classification says
`package` and whose specifier isn't `@alm-design/design-system` gets
`packageModuleId(source.specifier, node.name)` → `pkg.<sanitized-package>.<ComponentName>`
— the SAME shared function `registerProjectModules.ts` uses to register
(`packageModuleId` is a single exported function in `@core/module-engine`,
re-exported by both the server parse path and the client register path, with
a comment explicitly warning against two independently-maintained copies).
No hardcoded `alm.<Name>` for a non-ALM package. I did not need to change
this — verified the id a parsed node gets is the exact id the registry
registers under.

## E3 — Dependencies panel wired to `installDeps.ts`

**Files:** `server/handlers/studio/installDeps.ts`,
`src/admin/pages/site/studio/installDeps.ts` (client),
`src/admin/pages/site/panels/DependenciesPanel/DepsSection.tsx`,
new `src/admin/pages/site/panels/DependenciesPanel/useDependencyInstallJob.ts`.

**Server** — extended the existing WS-1.4 job (`startInstallJob`/`tryServeStudioInstall`),
not a second install path:

- `POST /admin/api/studio/install` body now optionally carries
  `{ add: { name, version?, dev? } }` or `{ remove: { name } }`, mutually
  exclusive (400 if both). Both validated with `isSafeDependencyName`
  (= the same `isSafePackageName` the client and the runtime dependency
  resolver already use) and a new `isSafeDependencyVersion` (rejects a
  version string shaped to look like a CLI flag). Invalid → 400 before
  `startInstallJob` is ever called — never reaches a real subprocess.
- `startInstallJob(dir, overrides, mutation?)` — when `mutation` is given,
  runs `<packageManager> add <name>[@version] [--dev] --ignore-scripts` or
  `<packageManager> remove <name> --ignore-scripts` (npm alone spells removal
  `uninstall`) instead of the bare `install` argv. `--ignore-scripts` still
  mandatory, still never conditional. A plain `{ dir }` body (no mutation)
  runs exactly the old "install everything in package.json" job —
  `InstallDependenciesPrompt.tsx`'s own call is untouched.
- On a successful job, the EXISTING post-success `reprobeProjectProfile(job.dir)`
  call (already there for WS-1.4's bulk install) re-detects `componentPackages`
  — this is what makes a freshly-added design-system package show up in
  E4's demand list at all.
- New tests: `server/handlers/__tests__/installDeps.test.ts` — argv
  correctness per package manager for add/remove, and 400-refusal coverage
  for unsafe name/version/both-add-and-remove.

**Client (`DepsSection.tsx`)** — the two `// TODO(Phase G)` stubs are
deleted. `handleAddPackage`/`confirmRemove` still update the in-memory
`packageJson` mirror (`setDependency`/`removeDependency` — feeds the CMS
half's CDN-resolved runtime dependency lock, untouched), and in Studio mode
**additionally** call `runDependencyMutation` (new
`useDependencyInstallJob.ts` hook) to run the real `bun add`/`bun remove`
against the on-disk project. Progress: an inline "Installing axios…" /
"Removing axios…" status line (`role="status"`), Add button + row remove
buttons disabled while a job is in flight (guards against a second concurrent
install into the same `node_modules` — `installDeps.ts`'s own doc explains
why that's unsafe). Failure: **always** through `pushToast({ kind: 'error', ... })`
via the global toast bus, body via `getErrorMessage`. No `alert`/`confirm`/`prompt`
anywhere in this change.

`useDependencyInstallJob.ts` was split out of `DepsSection.tsx` (which the
extraction, plus `PackageBundleNotice.tsx`, was also needed for — see "module
size" below) — same poll-to-completion pattern `InstallDependenciesPrompt.tsx`
already uses for the bulk job, not a third variant.

## The install → register seam — proven, not assumed

This is the actual point of doing E3+E4 together, so I verified it connects
rather than asserting it does:

On a successful install/remove, `useDependencyInstallJob.ts` calls
`requestCmsSiteReload()` **and then `resyncActiveProjectModules()`** — a new
export from `registerProjectModules.ts`. **The reload alone does NOT
connect the seam**: `useRegisterProjectModules`'s effect only re-fires on a
`projectDir` change or a `trust` change (via `promoteProjectToTier1`'s
`setStudioTrustTier`), and installing a dependency touches neither. Without
`resyncActiveProjectModules()`, a freshly-installed package would sit
unregistered until the user happened to switch projects or promote — an
integration gap of the exact shape named in my instructions ("both halves
individually correct, nothing connecting them"). `resyncActiveProjectModules()`
is a two-line function: if a project is active, call the same
`syncProjectModules(dir)` the effect itself calls. No-op with no active
project.

Consumer verified: `useDependencyInstallJob.ts` → `resyncActiveProjectModules`
→ `syncProjectModules(activeProjectDir)` → `POST /admin/api/studio/component-bundle`
→ (now includes the just-installed package, because `reprobeProjectProfile`
already ran server-side) → `registry.registerOrReplace(...)` → picked up by
`registry.list()`/`registry.listByCategory()`, which `ModuleInserterDialog.tsx`/
`ModulePicker.tsx` already read reactively-enough (re-render on the next
state change; registry itself isn't a React store, but the components that
read it re-render on their own triggers — same as before this change, not
altered here).

## A real bug found and fixed along the way (not test-only)

`syncProjectModules`'s body was previously `await`-chained with **no**
try/catch beyond the structured `{ ok: false }` branch. Before E4, this was
practically unreachable in most environments (gated behind a `pkg.*` node
already on the board), so a thrown/rejected case never mattered. E4 makes
this reachable on every project load — including against a network hiccup, a
malformed bundle URL failing `import()`, or (this is what actually surfaced
it) a route the CALLER's own fetch mock doesn't special-case. An uncaught
rejection here previously meant `PackageComponentPlaceholder`/`ModulePicker`/
`ModuleInserterDialog` could get stuck showing "Loading…" forever, since
`setPackageBundleStatus` was never reached on that path — a real
production correctness bug, not just a test hazard. Fixed by wrapping the
whole function body in try/catch, converting any thrown failure into the
same honest `{ ok: false, code: 'sync-failed', message }` refusal the
structured branch already produces.

## Cross-file test pollution — diagnosed and fixed at the source

A parallel run surfaced 12 new failures in
`src/__tests__/layout/editorLayoutPersistence.test.tsx`, present ONLY in a
full-suite run (12/12 pass in isolation). Root cause, confirmed by
reproduction:

1. `useAdminUi`'s `studioProject` field is a plain in-memory Zustand
   singleton (no persistence, no test-scoped reset). `fsCodemodAdapter.ts`'s
   `loadSite` calls `useAdminUi.getState().setStudioProject({ dir, name })`
   as a normal side effect (**not my code, not touched**). Tests like
   `fsCodemodAdapter.test.ts` exercise `loadSite` extensively with
   `dir: '/tmp/studio-test'` and never reset `studioProject` back to `null`
   afterward — this leak pre-dates my change and is not mine to fix (that
   file is explicitly owned by a concurrent sibling).
2. Before E4, this leak was harmless: `useRegisterProjectModules`'s
   board-contents gate meant `syncProjectModules` essentially never fired in
   any test.
3. After E4 removed that gate, ANY later test file that renders
   `AdminCanvasEditorBody` with a (leaked) non-null `studioProject.dir` now
   triggers a real `POST /admin/api/studio/component-bundle` call.
   `editorLayoutPersistence.test.tsx`'s own ambient fetch mock has no
   special case for that route, so it falls through to its catch-all
   `{ error: 'Unhandled ...' }` / 500 response — and, before my fix,
   `syncProjectModules` had no try/catch around the initial `apiRequest`
   call, so this became an **unhandled promise rejection** that bun's test
   runner attributed to whatever test was executing when the microtask
   settled, in a LATER file.

**Fix, at the source, not a test reset:** the same try/catch described above
("A real bug found and fixed along the way"). This is not a band-aid on the
victim test file — `editorLayoutPersistence.test.tsx` was not touched, and
the pre-existing `studioProject` leak in `fsCodemodAdapter.ts` was not
touched either (out of my ownership, and papering over it with a reset in
one file wouldn't fix the same class of issue for the next consumer of a
leaked `studioProject`). The fix makes `syncProjectModules` itself
exception-safe, which is correct in production regardless of tests.

**Reproduction used to confirm the fix:**
`bun test src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts src/__tests__/layout/editorLayoutPersistence.test.tsx`
→ 40 pass / 0 fail (was previously reproducing the leak's mechanism before
the try/catch fix — the leaked `/tmp/studio-test` dir is directly visible in
console output as the `dir` query param on the failing request before the
fix).

**Full suite before this fix:** 9038 pass / 45 fail (coordinator-reported),
12 of the 45 in `editorLayoutPersistence.test.tsx`.
**Full suite after this fix:** 9053 pass / 33 fail — `editorLayoutPersistence`
fully passing, and the remaining 33 failures (verified via
`git status --porcelain` against the file list) are all outside my diff:
CodeMirror lazy-load, publish lifecycle bus, error-boundary coverage gate,
keybindings registry (`useCanvas.ts`/`UndoRedoButtons.tsx` — canvas work in
flight elsewhere), `AgentPanel`, `studio-plugin lint`, server plugin runtime
SDK, `requestFromWorker` timeout, `SiteExplorerPanel`, Zustand selector
stability, `mcpServerSecretStore`, `streamClaudeCli`, `resolveToolProjectDir`,
`generateStudioProjectGuide`, `resolveProjectSeedDir`, runtime cache layout —
none touch `installDeps`, `registerProjectModules`, `ModulePicker`,
`ModuleInserterDialog`, `PackageBundleNotice`, or `DepsSection`.

## Module size ceiling (`module-size-budgets.test.ts`, 700-line cap)

Two of my files crossed 700 lines after the additions; both split rather than
grandfathered:

- `ModuleInserterDialog.tsx` (was heading to 729) — extracted the
  package-bundle notice into the shared `PackageBundleNotice.tsx` (also
  de-duplicates the identical logic that would otherwise live twice, once
  per picker surface). Now 671 lines.
- `DepsSection.tsx` (was heading to 742) — extracted the install/remove job
  orchestration (state, polling, mutation runner, toast helpers) into
  `useDependencyInstallJob.ts`. Now 641 lines.
- `server/handlers/studio/installDeps.ts` — 691 lines, comfortably under.
- Per this session's instructions, did **not** touch `server/handlers/studio.ts`
  (721 lines, still over — owned by another agent splitting it).

## Files touched

- `server/handlers/studio/installDeps.ts` — add/remove mutation, argv
  builders, validation, route wiring.
- `server/handlers/__tests__/installDeps.test.ts` — new mutation tests.
- `src/admin/pages/site/studio/installDeps.ts` (client) — `startDependencyInstall`
  optional mutation param.
- `src/admin/pages/site/studio/registerProjectModules.ts` — E4 core fix:
  removed board-contents gate, wrapped `syncProjectModules` in try/catch,
  added `resyncActiveProjectModules`.
- `src/admin/pages/site/panels/DependenciesPanel/DepsSection.tsx` — real
  install/remove wiring, deleted both TODOs.
- `src/admin/pages/site/panels/DependenciesPanel/useDependencyInstallJob.ts`
  (new) — extracted job orchestration hook.
- `src/admin/pages/site/module-picker/ModulePicker.tsx`,
  `ModuleInserterDialog.tsx` (+ their `.module.css`) — render
  `PackageBundleNotice`.
- `src/admin/pages/site/module-picker/PackageBundleNotice.tsx` +
  `.module.css` (new) — shared refusal/promote notice.
- `src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts` —
  removed the now-stale allowlist entry for the deleted
  `siteHasUnregisteredPackageNode`.

## New CSS tokens

None. Reused existing tokens throughout: `--warning`, `--warning-text`,
`--text-muted`, `--info-text`, `--radius`, `--space-*`, `--text-*`. Verified
against `src/styles/globals.css` before use (note: this codebase's actual
radius tokens are `--radius`/`--radius-sm`/`--panel-radius`, not the
`--editor-radius*` names some docs use — used the real ones).

## Verify commands run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json      # clean
bun test src/__tests__/architecture/css-token-policy.test.ts
bun test src/__tests__/architecture/no-css-var-fallbacks.test.ts
bun test src/__tests__/architecture/button-primitive-usage.test.ts
bun test src/__tests__/architecture/ui-primitives-location.test.ts
bun test src/__tests__/architecture/boundary-validation.test.ts
bun test src/__tests__/architecture/module-size-budgets.test.ts
bun test src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts
bun test server/handlers/__tests__/installDeps.test.ts
bun test src/__tests__/panels/depsSectionRuntime.test.tsx
bun test src/__tests__/toolbar/modulePickerDropdown.test.tsx
bun test src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts
bun test src/__tests__/layout/editorLayoutPersistence.test.tsx
bun test    # full suite, twice — 9053 pass / 33 fail final, 0 in my area
```

Did **not** run `bun run build` / `bun run lint` (per instructions — a
sibling owns `server/handlers/studio.ts`, still mid-split).

## Human action needed

Dogfood in the browser (I did not and cannot — no browser tests here):

1. **The core E4 scenario**: a Studio project with a real npm component
   library dependency, at Tier 1, **empty page, zero `pkg.*` nodes anywhere
   on the board** — open "+ Add to canvas", confirm the library's components
   are listed and draggable (this was previously impossible).
2. **The trust-0 "way forward"**: the same project at Tier 0 — confirm the
   picker shows a warning chip with the refusal message and a working
   "Promote project" button, both in the compact `ModulePicker` (right-click
   → Insert) and the toolbar "+ Add to canvas" dialog — not a silently empty
   list.
3. **E3**: Dependencies panel → type a real package name → Add → watch
   "Installing …" appear, then a success/failure toast, then (for a
   component-library package) confirm its components become available in
   the picker WITHOUT a manual reload. Also try Remove on an existing
   dependency and confirm the same real-install/toast path.
4. Confirm no double-install race: click Add, then immediately try Add again
   (or Remove a different row) — both should be disabled/no-op until the
   first job settles.
