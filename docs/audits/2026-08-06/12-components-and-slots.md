# Audit 12 — Components, props, and page-as-component with slots

Read-only audit. Branch `feat/alm-figma-killer-studio-shell`. No production code written.

Scope: importing component packages, editing their props, local-component instances,
swap/detach, `ReactNode`/`children` slot props, extract-to-component, and the
design-system working loop.

---

## 0. Executive summary

The engine layer for components is **much further along than `PROJECT-BRIEF.md` claims**.
Instances, detach, swap, extract-copy, package manifests, package bundling, package
rendering, typed prop controls, slot capture and Enter/Esc instance nesting are all
**built and wired to UI**. What is missing is not plumbing — it is:

1. **A local-component catalog.** Nothing in the product can answer "what components
   does this project have, and what props do they take". Every gap below traces to
   this one absence: swap has 3 candidates instead of 300, local instance props get
   guessed from runtime values instead of read from types, and unset props have no row.
2. **A slot you can fill.** A slot that is *already filled in source* round-trips
   beautifully. A slot that is empty, or that you want to change, has no path at all —
   no drop target, no insert edit kind, no fragment support.
3. **Promote-to-component.** There is no "select this subtree → make it a component"
   flow anywhere in Studio. The only button that says it does that
   (`ConvertToComponentButton`) is the CMS Visual Component system, is **not gated on
   Studio mode**, and silently loses the user's work.

Fifteen findings follow, then the flagship design.

---

## 1. Findings

### K1 — `PROJECT-BRIEF.md` §3 is materially false about components
**Severity: High (misleads every new agent, which is the file's entire purpose)**

`PROJECT-BRIEF.md:150-151`:
```
npm package components (only the hardcoded `@alm-design/design-system`) ·
component instances, swap, detach · scroll unrolling · ...
```
listed under **"What does NOT work today"**.

Evidence that all four DO work:
- Package components: `server/handlers/studio/componentBundle.ts:294` (`tryServeStudioComponentBundle`),
  `src/admin/pages/site/studio/registerProjectModules.ts:476` (`useRegisterProjectModules`),
  wired into `STUDIO_SUB_ROUTERS` per `docs/agent-refs/path-index.md:44`.
- Instances: `src/core/page-parser/inlineLocalComponents.ts:321-330` mints the
  `instanceOf` node; `src/admin/pages/site/panels/PropertiesPanel/renderModuleTabContent.tsx:99`
  routes it to `InstanceCallSiteView`.
- Detach: `InstanceCallSiteView.tsx:123` → `studioSaveRequests.ts:337` →
  `server/handlers/studioWriteback.ts:565` → `src/core/ast-codemods/detachComponent.ts:399`.
- Swap: `InstanceCallSiteView.tsx:181` → `studioSaveRequests.ts:350` →
  `studioWriteback.ts:570`.
- `STATE.md:4530` (`instance-ui-01`) records a **passing real-browser e2e** against the
  eSIM board: click selects the instance, Enter enters, Esc exits, `value` prop edits
  from `"69"` to `"88"`, detach refuses `SheetHeader` with `uses-hooks`.

Also false in the same list: *"adding a component whose package the project does not
depend on yet (the `import` is written, `package.json` is not — **install it from the
Dependencies panel**)"*. See K13 — the Dependencies panel cannot do that.

**Root cause:** the brief was written before `pkg-01`/`pkg-02`/`parser-05`/`instance-ui-01`
landed and was never revised.
**Fix:** rewrite `PROJECT-BRIEF.md` §3's two lists against `STATE.md`'s landed entries;
add a standing rule that a `STATE.md` entry reaching `Stage: done` must edit §3.
**Effort: S.** No dependencies.

---

### K2 — Package import → render: the full trace, and the wall in the middle
**Severity: Medium**

Full chain, every gate:

| # | Step | File:line | Gate / cost |
|---|---|---|---|
| 1 | Probe the project | `server/handlers/studio/projectProbe.ts` → `componentPackageDetect.ts:1-38` | Two tiers: entry `.d.ts` scanned for PascalCase + React-ish type; else built `dist/*.js` scanned for BOTH a jsx-runtime import AND a PascalCase export. Deliberately biased to false-negative. Cached in `.studio/meta.json`'s `profile`. |
| 2 | Install deps | `server/handlers/studio/installDeps.ts`, UI `DependenciesPanel/InstallDependenciesPrompt.tsx:100` | Background job, polled every **1500 ms** (`InstallDependenciesPrompt.tsx:101`). Only offered when `node_modules` is absent (`:184`). |
| 3 | Demand list | `componentBundle.ts:127-130` | `profile.componentPackages` **only**. The plan's second source — "any bare specifier the parser actually saw a JSX component imported from" — is an explicit documented gap (`componentBundle.ts:80-85`). |
| 4 | **Trust gate** | `componentBundle.ts:334-341` | `trust === 'static'` (the default for every fresh import) → hard refusal `trust-tier-required`. |
| 5 | React skew | `componentBundle.ts:343-358` | Workspace `package.json` react major vs. **the admin server's own** `node_modules/react` (`:162`, keyed on `process.cwd()`). Any mismatch refuses the WHOLE feature — no per-package granularity. |
| 6 | Manifest | `packageManifest.ts:392` | Purely syntactic, `.d.ts` → `.tsx` → warning. Never the type checker (`:29-37`, deliberate). |
| 7 | Bundle | `componentBundle.ts:391-402` | Generated barrel at `<appRoot>/.studio-bundle-entry-<hash>.ts`, `Bun.build` in a subprocess, **60 s timeout** (`:111`), 20 MB cap (`:113`), cached at `.studio/cache/bundle-<hash>.{js,json}`. |
| 8 | Register | `registerProjectModules.ts:395-455` | Lazy: fires only when trust ≥ 1 AND the loaded board has an unregistered `pkg.*` node (`:487`). |
| 9 | Render | `registerProjectModules.ts:270-298` | `display: contents` host, error boundary, `revivePropValue` for slots/icons. |

**Click count, fresh MUI-using import → Button on canvas:** open project → Dependencies
panel → *Install dependencies* → wait 30 s–3 min → canvas shows
`PackageComponentPlaceholder` → *Promote project* → wait for a 60 s-budget bundle.
**≈4 clicks and two unbounded waits**, with no progress indicator for the bundle
(`PackageComponentPlaceholder.tsx:101-106` renders a bare `Loading <name>…`).

**What fails silently:**
- `componentBundle.ts:376` returns `warnings` on refusal, and
  `registerProjectModules.ts:403-406` **discards them** — only `code`/`message` reach
  `setPackageBundleStatus`. A `package-manifest-static-empty` warning
  (`packageManifest.ts:411`) naming the exact package that produced nothing is
  computed and thrown away.
- `registerProjectModules.ts:424` — `if (!Comp) continue`. A component in the manifest
  whose export is missing from the built bundle is skipped with no log, no warning, no
  placeholder. It renders as "Unknown module" forever.
- `componentBundle.ts:404-406` — a bundle timeout returns `ok:false`; the placeholder
  shows the message, but there is no retry affordance.

**Fix:** surface `warnings[]` in `PackageBundleStatus` and render them in the
Dependencies panel (not in the iframe placeholder, which has no room);
`console.warn('[registerProjectModules]', …)` on a missing export; add a *Retry* action
to the refusal placeholder. **Effort: S.** Depends on nothing.

---

### K3 — `PropKind` misses the single most common design-system prop shape
**Severity: High** (this is requirement 8, "dropdowns for predetermined props")

`packageManifest.ts:167-187` — `classifyPropType`:

```ts
if (typeNode.getKind() === SyntaxKind.UnionType) { … enum … }
return classifyNonNullish(name, typeNode)
```

`classifyNonNullish` (`:136-151`) handles `FunctionType`, the `ReactNode` text regex,
`StringKeyword`, `NumberKeyword`, `BooleanKeyword` — and returns `{kind:'unknown'}`
for **anything else, including a `TypeReference`**.

So:
- `variant?: 'primary' | 'ghost'` → `enum` ✅
- `variant?: ButtonVariant` where `type ButtonVariant = 'primary' | 'ghost'` → **`unknown`** ❌

The second form is what nearly every real design system ships (MUI, Chakra, Mantine,
shadcn, and any hand-rolled system with a shared token union). The module already owns
the machinery to fix this: `findNamedTypeMembers` (`:199-211`) resolves a named type
alias — but only down the *object-shape* path (`resolveTypeNodeToMembers`), never for a
union alias.

Same blind spot for `React.ReactNode`-aliased slots: `REACT_NODE_TEXT_RE`
(`:129`) matches literal text only, so `children: Children` or
`icon: IconSlot = ReactNode` classifies `unknown` and never becomes a slot.

**Root cause:** the alias-resolution path was built for props *objects*, not for prop
*types*.
**Fix:** in `packageManifest.ts`, add `resolveTypeAliasNode(project, typeNode, depth)`
(a sibling of `findNamedTypeMembers`, bounded the same way) and call it from
`classifyPropType` before falling through to `unknown`. Recurse once into the alias's
own type node, then re-enter `classifyPropType`. Add fixtures to
`packageManifest.test.ts` for: union alias, `ReactNode` alias, alias-of-alias, and a
self-referential alias (must terminate).
**Effort: S.** No dependencies. Highest value-per-line in this audit.

---

### K4 — Every `PropKind` and its control, and where the experience is worst
**Severity: Medium**

Server classification (`packageManifestSchema.ts:18-39`) → client control
(`registerProjectModules.ts:304-331`) → renderer
(`property-controls/PropertyControlRenderer.tsx:170-250`):

| `PropKind` | Control type | Component | Notes |
|---|---|---|---|
| `string` | `text` | `TextControl.tsx` | |
| `number` | `number` | `NumberControl.tsx` | |
| `boolean` | `toggle` | `ToggleControl.tsx` | |
| `enum` (≥2 values) | `select` | `SelectControl.tsx` | `registerProjectModules.ts:307` |
| `enum` (1 value) | `text` | `TextControl.tsx` | Degrades to free text — a 1-member union is still a constraint |
| `color` | `color` | `ColorControl.tsx` | Name-matched `/color\|fill\|stroke\|bg/i`, `packageManifest.ts:127` |
| `image` | `image` | `ImageControl.tsx` | Name-matched `/src\|image\|icon\|avatar\|logo/i`, `:128` |
| `node` | `slot` | `SlotControl.tsx` | "Edit contents" → `selectNode(slotNodeId)` |
| `handler` | — | — | **Dropped at `packageManifest.ts:325`**, never reaches a `ComponentSpec` |
| `unknown` | `text` | `TextControl.tsx` | **Falls to free text**, `registerProjectModules.ts:326-329` |

Two overrides sit above all of this in `PropertyControlRenderer.tsx:157-168`: a
`sourceLockReason` **or** an object/array value forces `CodeValueControl` (read-only).
That is correct and is the guard that keeps `actions={[{label}]}` from being destroyed.

**Where the experience is worst — ranked:**
1. **`unknown` → free text.** Combined with K3, most real enums land here. A user
   types a value the component rejects and gets a runtime error boundary
   (`registerProjectModules.ts:175-189` renders `"<Name> (render error)"`).
2. **`handler` props are invisible.** A user cannot see that `<Button>` even *has* an
   `onClick`, let alone that Studio deliberately won't touch it. Dropping the value is
   right; dropping the *row* is not.
3. **Local-component instances get no `PropKind` at all** — see K5.
4. **`color` and `image` are name-heuristics on `string`.** A prop typed
   `background: Color` (an alias) gets nothing.

**Fix:** (a) K3's alias resolution; (b) keep `handler` props in `ComponentSpec` with a
new `readOnly: true` flag and render them via `CodeValueControl` with the hint
"event handlers are edited in code"; (c) 1-member enums render a disabled `Select`
showing the only value. **Effort: S–M.** (b) touches `packageManifestSchema.ts`,
`packageManifest.ts:321-329`, `registerProjectModules.ts:304`.

---

### K5 — A local component instance's props are guessed from runtime values
**Severity: High**

`InstanceCallSiteView.tsx:80-85`:
```ts
function controlForCallSiteValue(value: unknown, label: string): PropertyControl {
  if (studioSlotNodeId(value) !== undefined) return { type: 'slot', label }
  if (typeof value === 'boolean') return { type: 'toggle', label }
  if (typeof value === 'number') return { type: 'number', label }
  return { type: 'text', label }
}
```
Its own doc (`:70-79`) calls this "a real, working, but coarser rule than WS-3.1's
classification" and names it `parser-05` honest gap #4.

Two consequences:
- **A local component's string-union prop never gets a dropdown**, even though the
  component's own `.tsx` declares it and `packageManifest.ts`'s classifier could read
  it verbatim (a typed parameter looks identical in `.d.ts` and `.tsx` — the module doc
  says so at `packageManifest.ts:13-16`).
- **A prop the call site does not pass has no row at all.** The panel iterates
  `Object.keys(callSiteProps)` (`InstanceCallSiteView.tsx:107, 310`). So `<Card/>` shows
  zero controls even when `Card` declares eight props. The user cannot *add* a prop
  from the panel — though `setJsxProp.ts:62` (`element.addAttribute`) would happily
  write one.

Contrast: a **package** component shows every declared prop, because the panel iterates
the module *schema* (`renderModuleTabContent.tsx:146`), which was built from the
manifest. Two components side by side on the same board behave differently for the
same reason.

**Root cause:** no local-component manifest exists.
**Fix:** Phase 0 of the design below.
**Effort: M.** Depends on Phase 0.

---

### K6 — Swap picker sees only components already on the board
**Severity: Medium**

`InstanceCallSiteView.tsx:160-175` (`openSwapPicker`) scans `state.site.pages` for other
`studio.instance` nodes and dedupes by `{sourceFile, componentName}`. The file states the
gap itself at `:27-32`. `STATE.md:4623` repeats it as a named follow-up.

Consequence: on a board with one page open you typically get **0–3 swap targets**, and
the empty state (`InstanceCallSiteView.tsx:278-280`) reads "No other local component is
on this board yet", which a user will read as "this project has no components".
Package components are excluded entirely (`:167` requires `p.source === 'local'`),
even though `swapComponentInstance` accepts `newComponentSource: 'package'`
(`studioSaveRequests.ts:353`).

**Fix:** Phase 0's `GET /admin/api/studio/components`, unioned with the already-fetched
`componentBundle` response's `components[]`. **Effort: S** once Phase 0 exists.

---

### K7 — Detach's real-world success rate is ~42%, and package detach is a dead end
**Severity: Medium (honest, but the offer is thin)**

`detachComponent.ts` refuses on: `not-a-component` (`:423`), `package-component`
(`:428`), `unresolvable` (`:435`), `uses-hooks` (`:441`), `unsupported-params`
(`:447`, an undestructured `props` param), `no-renderable-jsx` (`:455`),
`maps-over-props` (`:461`).

`STUDIO-IMPORT-V2-PLAN.md:498-500` records the eSIM corpus measurement: **139 instances,
59 clean detaches, 42 hook refusals, 38 `.map`-row no-location**.

The escape hatch is offered for only four reasons
(`InstanceCallSiteView.tsx:94-99` — `uses-hooks`, `maps-over-props`,
`unsupported-params`, `no-renderable-jsx`), which is correct reasoning. But:
- **`package-component` gets a refusal and nothing else.** The plan specced two
  alternatives — "Eject to local component" and "Replace with markup snapshot"
  (`STUDIO-IMPORT-V2-PLAN.md:625-633`). Neither exists. The Detach button is simply
  `disabled` for a package instance (`InstanceCallSiteView.tsx:228`) with the tooltip
  "Package components cannot be detached yet".
- `extractComponentCopy` (`extractComponentCopy.ts:64`) duplicates the component file
  and repoints one call site. It is a genuinely useful verb in its own right — "give me
  my own copy of this shared component" — but it is **reachable only after a detach
  refusal**. There is no direct button for it.

**Fix:** promote `extractComponentCopy` to a first-class "Duplicate this component"
action in the instance header, always available for a local instance. Implement
"Replace with markup snapshot" as a Tier-1 verb (the rendered DOM is already in the
iframe; serialize → `insertJsxElement`), labelled lossy.
**Effort: S** for the first, **M** for the second (needs Tier 1 + a DOM→JSX serializer).

---

### K8 — Slots: what actually round-trips, and the four walls
**Severity: High** (this is the heart of the requested feature)

**What works, and works well.** `<Cell icon={<Icon/>}/>`:
1. `parsePageFile.ts:524` `captureSlotProps` mints `<Icon/>` as a **real `ParsedNode`**
   via the ordinary `processElement` walk (`:539`), with its own real
   `relFile:line:col` id.
2. It is **not** added to `children`; the parent's `props[name]` gets
   `studio-slot:<nodeId>` (`parsePageFile.ts:464`, `studioSlotSentinel.ts:34`).
3. The child is unconditionally `locked` with reason
   `'slot content — fills a component prop'` (`parsePageFile.ts:72, 539`), but its own
   props stay editable — the correct `locked`-is-structure / `codeProps`-is-values split.
4. `inlineLocalComponents.ts:466-478` (`rewriteSlotSentinels`) rewrites the sentinel
   when ids get the composite prefix — a real bug caught pre-ship (`STATE.md:6480`).
5. `registerProjectModules.ts:226-241` (`revivePropValue`) renders the referenced node
   through the ordinary `NodeRenderer` and hands the React element to the component.
   **The slot's content is a fully live, selectable, editable canvas subtree.**
6. `SlotControl.tsx:31-41` gives it an "Edit contents" button that selects it.

That is a genuinely good mechanism. The four walls:

**Wall 1 — an empty slot cannot be filled.** No JSX value at the call site → no node →
no sentinel → `SlotControl.tsx:43` renders `— no content in this slot`, with no action.
There is no edit kind that writes a JSX value into a prop. `setJsxProp.ts:32-41`
(`buildInitializerText`) only produces scalars.

**Wall 2 — a fragment is declined.** `parsePageFile.ts:535` requires
`Node.isJsxElement(expression) || Node.isJsxSelfClosingElement(expression)`.
`header={<><Logo/><Nav/></>}` is silently dropped — the prop simply doesn't appear.
Documented as deliberate (`STATE.md:6412`) because a fragment "can expand to zero or
several roots", but it means a slot can hold exactly one element, forever.

**Wall 3 — nothing can be inserted into a slot's subtree.** The slot child carries
`lockReason` (`parsePageFile.ts:72`), and `sourceStructure.ts:250-253` refuses any
structural edit on a node with a `lockReason` as `code-placed`. So you can edit the
`<Icon/>`'s props but you cannot add a sibling next to it, delete it, or reorder inside it.

**Wall 4 — slot children are invisible in the layer tree.** The DOM panel walks
`children`; a slot child is reachable only through `props`. Grepping
`src/admin/pages/site/panels/DomPanel/` returns hits for `base.slot-instance`
(`LayerNodeContextMenu.tsx:146-160`, `TreeNode.tsx:292` — the **CMS** VC slot system)
and **zero** for WS-3.4 studio slots. The only way to reach one is the Properties
panel's "Edit contents".

**`children` (as opposed to a named slot prop)** is a different and better story:
`registerProjectModules.ts:433` sets `canHaveChildren: true` and `:287` passes
`children` straight through. Real JSX children of a package component are ordinary
tree children and behave normally. **But** `src/modules/alm/register.tsx` hardcodes
`canHaveChildren: false` — so on the one corpus that actually renders
(`@alm-design/design-system`, carved out at `studioPageLoad.ts`'s
`ALM_DESIGN_PACKAGE_SPECIFIER`), children are dropped. See K12.

**Fix:** the full design in §3.
**Effort: L.**

---

### K9 — No `ReactNode` prop can hold an arbitrary editable subtree *created in Studio*
**Severity: High** — direct answer to audit question 5

Precise trace: a `node`-kind prop can hold an arbitrary editable subtree **iff that
subtree already exists in source as a single JSX element**. Then it is a real node with
a real id and full editing of its own props/text/styles.

It **cannot**:
- be created (Wall 1),
- be more than one element (Wall 2),
- be structurally modified — no add/delete/reorder inside it (Wall 3),
- be found (Wall 4),
- be moved between slots, or out of a slot into the tree (`reparent` refuses
  unconditionally, `sourceStructure.ts:145-150`).

So the answer to *"can a `children` or `ReactNode` prop hold arbitrary editable
subtree today"* is: **read-mostly yes, write no.**

---

### K10 — There is no extract-to-component from a subtree
**Severity: High** — direct answer to audit question 6

`extractComponentCopy.ts` is **not** "select a subtree → make a component". Read its own
header (`:1-13`): it duplicates an **existing component file** under a fresh name
(`Card.tsx` → `Card2.tsx`, `:89`), renames the export (`:105`), and repoints one call
site (`:110-112`). It requires the selection to already *be* a component instance
(`:76-81` refuses `not-a-component` for a lowercase tag).

Reachability: `InstanceCallSiteView.tsx:135` only, behind a detach refusal.
Also exposed headlessly at `server/handlers/studio/extractComponent.ts:68` and to MCP as
`studio_codemod verb:'extract-component'` (`server/ai/mcp/tools/studio/editTools.ts:253`).

The only UI in the whole app labelled "make this a component" is
`ConvertToComponentButton.tsx` — see K11.

---

### K11 — The CMS "Componentize" button is live in Studio mode and silently loses work
**Severity: Critical** (silent data loss, and it is the button a user will reach for)

`src/admin/pages/site/componentization/componentizeEligibility.ts:4-14`:
```ts
export function canComponentizeNode(activeDocument, node): node is PageNode {
  return (
    activeDocument?.kind !== 'visualComponent' &&
    !!node &&
    node.moduleId !== 'base.body' &&
    node.moduleId !== 'base.visual-component-ref'
  )
}
```
**No `isStudioMode()` check.** It is consumed at
`PropertiesPanelBody.tsx:159` (gated only on `permissions.canEditStructure`) and
rendered at `:219`/`:224`, and again in the layer-tree context menu at
`DomPanel/LayerNodeContextMenu.tsx:186`.

What happens when a Studio user clicks it: `visualComponentsSlice.ts:553`
`convertNodeToComponent` mints `newVcId = nanoid()` (`:610`), deep-clones the selected
subtree into a separate flat VC tree, and replaces the subtree on the page with a
`base.visual-component-ref` node. It throws only for VC mode, a missing page/node, a
ref node, and `base.body` (`visualComponentsSlice.ts:565-590`) — **Studio mode is not
among them**. All of that happens in `mutateSiteState`, which **bypasses
`refuseStructuralEdit` entirely**. The user's `.tsx` is untouched.

There is no persistence path whatsoever:
- `fsCodemodAdapter.loadSite` builds `createDefaultSiteDocument('Studio')` and then only
  overwrites `site.pages`, `site.styleRules`, `site.conditions`,
  `site.settings.framework` (`fsCodemodAdapter.ts:292-311`);
  `createDefaultSiteDocument` sets `visualComponents: []`
  (`store/slices/site/defaults.ts:40`). Studio always starts with zero VCs.
- `fsCodemodAdapter.saveSite` (`:335`) never references `visualComponents` — grep
  returns nothing in that file.
- A VC's real home is a **database row**: `data_rows` where `table_id = 'components'`
  (`src/core/data/componentFromRow.ts:1-18`, seeded at `server/db/migrations-pg.ts:277`).
  Studio never talks to it.

On the next reload the "component" is gone and so is the subtree's place in the tree.
The same predicate also arms the layer-tree context menu's "Componentize" item
(`DomPanel/LayerNodeContextMenu.tsx:182-187, 372-377`), so there are two entry points.

This is precisely the failure mode `struct-01` was created to eliminate
(`docs/agent-refs/studio-pipeline.md:160-165`: *"the tree changed, the save reported
success, the `.tsx` was untouched, and the change was gone on reload"*).

**Fix (immediate, S):** add `&& !isStudioMode()` to `canComponentizeNode`. One line, one
import, one test in `src/__tests__/architecture/` asserting Studio mode hides it.
**Fix (proper, L):** replace it with the Promote-to-component flow in §3.

---

### K12 — The generic package pipeline is unexercised on the only real corpus
**Severity: Medium**

`registerProjectModules.ts:12-18` and `STATE.md:6520-6534` state it plainly: the eSIM
corpus declares exactly one component package, `@alm-design/design-system`, which
`studioPageLoad.ts`'s `ALM_DESIGN_PACKAGE_SPECIFIER` carve-out routes to `alm.<Name>` —
so it renders through the **old** `src/modules/alm/register.tsx`, and
`siteHasUnregisteredPackageNode` (`registerProjectModules.ts:379-388`) finds nothing to
trigger the new path. `standing-07` precondition 4 (a browser dogfood proving visual
equivalence) is open.

Practical consequences of two paths coexisting:
- `alm/register.tsx` sets `canHaveChildren: false`; `registerProjectModules.ts:433`
  sets `true`. Nested children work for every package **except the one that renders**.
- `alm/register.tsx` reads a build-time `manifest.generated.json` (39 specs) instead of
  the live `.d.ts`, so K3's fix will not reach it.

**Fix:** run the dogfood, delete `src/modules/alm/`, `scripts/gen-alm-manifest.mjs` and
the carve-out in one change (CLAUDE.md §"No band-aids").
**Effort: M.** Needs a human browser pass (trap #13).

---

### K13 — The Dependencies panel cannot install a package into a Studio project
**Severity: High**

`DependenciesPanel.tsx:28-29` renders two things:
- `InstallDependenciesPrompt` — the real Studio one. It returns `null` unless
  `isStudioMode()` (`:160`) AND `node_modules` is **missing** (`:184`:
  `if (!probe.hasPackageJson || probe.hasNodeModules || probe.dependencyCount === 0) return null`).
  It is a one-shot "install everything already in package.json" affordance and vanishes
  the moment it succeeds.
- `DepsSection` — the **CMS** panel. Its "Add package" handler
  (`DepsSection.tsx:129-145`) calls `setDependency(name, '*', addDev)`
  (`store/slices/sitePanelSlice.ts:210`), which writes the in-memory
  `site.packageJson`, and then:
  ```ts
  // TODO(Phase G): ask the site bridge to install this in the user site.
  ```
  Same TODO on remove (`DepsSection.tsx:170`). **Nothing reaches disk, and nothing
  reaches `bun install`.**

So `PROJECT-BRIEF.md:153-154`'s remedy for the documented insert gap — "install it from
the Dependencies panel" — does not exist. A user who inserts a component from a package
they don't depend on gets a broken import and no way out inside the product.

**Fix:** add `POST /admin/api/studio/install-package { dir, name, dev }` as a thin
wrapper over `installDeps.ts`'s existing job machinery (which already spawns a package
manager with a minimal env via `subprocessRunner.ts`), and repoint
`DepsSection.tsx`'s add/remove at it when `isStudioMode()`. The polling UI already
exists in `InstallDependenciesPrompt`.
**Effort: M.** Depends on nothing.

---

### K14 — The CMS Visual Component slot system: right shape, wrong substrate
**Severity: Informational (but decisive for the design)**

`src/core/visualComponents/` is 1450 lines across 11 files. The relevant mechanism:
- `slotSync.ts:31-32, 39-70` `collectSlotOutletNames` — walks a VC's tree collecting
  `base.slot-outlet` nodes' `props.slotName`, DFS pre-order, deduped, defaulting to
  `'children'`. **"The slot-outlet IS the slot — no separate `vc.params` slot entry
  required."** The author drops an outlet where consumer content goes; that is the
  entire authoring step.
- `syncSlotInstances` (`slotSync.ts:158-249`) reconciles the consumer's
  `base.visual-component-ref` children against that name set in four phases (match by
  name → positional rename → delete surplus → insert missing), minting each new
  `base.slot-instance` with a `nanoid()` id and unconditional `locked: true`
  (`:230-240`). Five production callers, including a load-time healing sweep in
  `src/core/persistence/validate.ts:614-616`.
- **Pairing at render:** publisher `src/core/publisher/renderVisualComponentRef.ts:89-95`
  and canvas `VisualComponentRefEditor.tsx:74-88` build the identical
  `slotInstancesByName` map; `instantiate.ts:127-167` substitutes it at each outlet,
  falling back to the slot param's `defaultValue`, then to the outlet as a placeholder.
- Param types — nine (`schemas.ts:25-41`): `string | number | boolean | url | enum |
  color | image | richText | **slot**`. Unknown values fall back to `'string'`.
- **Param→prop binding:** `BaseNode.propBindings?: Record<propKey, { paramId }>`
  (`src/core/page-tree/baseNode.ts:27-28, 126`), substituted at
  `instantiate.ts:170-179`, authored via `ParamPromotableRow.tsx` in VC edit mode.
  Per-instance values are a *separate* mechanism: `propOverrides` on the ref node,
  keyed by param id (`ComponentRefView.tsx:47-56`).
- Slot instances get dedicated DOM-panel chrome (`TreeNode.tsx:292`) and a structural
  lockdown (`LayerNodeContextMenu.tsx:146-165`), plus DnD (`page-tree/dnd.ts:93`),
  insert-redirect (`store/insertLocation.ts:74-82`) and multi-select
  (`selectionSlice.ts:478-495`) guards.

**Is it reusable here? No — and the plan already says so.** `STUDIO-IMPORT-V2-PLAN.md:471`:
*"reuse the shape, not the code path"*. Three disqualifiers:
1. **Every id is a `nanoid`** (`slotSync.ts:230`, `visualComponentsSlice.ts:610`).
   Studio's second invariant is that a write must have exactly one honest target, and
   `sourceStructure.ts` refuses any node whose id is not a source location
   (`refuseMintedNodeInsert`, `:284`). A VC node can never be written back.
2. **VCs are database rows** (`data_rows`, `table_id='components'`,
   `src/core/data/componentFromRow.ts:1-18`), reached only through the CMS adapter
   (`AdminCanvasLayout.tsx:187` picks `fsCodemodAdapter` in Studio, `cmsAdapter`
   otherwise). Studio state belongs on disk (CLAUDE.md, PROJECT-BRIEF §1).
3. **Nothing in the Studio load path produces one.** Grep for
   `visualComponent|slot-outlet|slot-instance` across `src/core/studio-sync/` and
   `server/handlers/studioPageLoad.ts` → zero matches.

**What IS worth copying:** the *interaction* model — outlet-in-the-definition paired to
instance-in-the-consumer by **name**; a slot fill being an ordinary, locked node in the
same flat tree; the "slot-outlet IS the slot" authoring economy (no separate declaration
step); and the DOM-panel row treatment. §3 does exactly that, substituting a real `.tsx`
file for the DB row, a `React.ReactNode` prop for the `slot` param, and — for the
`propBindings` mechanism — nothing at all, because in Studio a prop binding is simply
`{title}` written in the JSX. **The source already carries what `propBindings` exists to
remember.** That is the whole reason this design writes types to disk instead of
building a sidecar.

---

### K15 — Ergonomics: where the user waits and where they guess
**Severity: Medium**

**Waits (no progress feedback):**
| Wait | Where | Feedback |
|---|---|---|
| `bun install`, 30 s–3 min | `installDeps.ts` | Good — log tail, 1.5 s poll, toast (`InstallDependenciesPrompt.tsx:158-172`) |
| Bundle build, up to 60 s | `componentBundle.ts:111` | **Bad** — `Loading <name>…` inside the iframe, no spinner, no cancel, no timer (`PackageComponentPlaceholder.tsx:104`) |
| Save + full re-parse after any structural/instance edit | `studioSaveRequests.ts:341` | Board reloads; a cold `pageParseCache` can exceed 10 s (`STATE.md:4611`) |
| Call-site prop edit → canvas update | — | **Never live.** `STATE.md:4616`: *"Editing a call-site prop does not live-update the canvas… the new text appears after a save + re-parse."* |

**Guesses (the user cannot know without reading source):**
- Which components this project has (no catalog — K6).
- What props a local component takes (no rows for unset props — K5).
- Whether a component has an `onClick` (handler props invisible — K4).
- Whether a component has an *empty* slot (no row at all — K8 Wall 1).
- Why a `pkg.*` node shows "Unknown module" when the export is missing from the
  bundle (K2, silent `continue`).

**Click counts, common tasks:**
| Task | Clicks | Notes |
|---|---|---|
| Change a package component's `variant` | 2 (select, dropdown) | Good — when K3 doesn't degrade it to free text |
| Change a local instance's prop that IS passed | 2 | |
| Add a prop to a local instance that isn't passed | **∞** | Impossible in-product |
| Swap a local instance | 3 (Swap, search, pick) | Candidate list is near-empty (K6) |
| Detach | 1, then ~58% chance of a refusal | |
| Fill an empty slot | **∞** | Impossible |
| Make a page into a component | **∞** | Impossible (K10); the one button that claims to (K11) destroys the work |

---

## 2. Two full-site scans on user gestures (perf note)

Both are imperative (`getState()`), not reactive selectors, and both are deliberately
allowlisted — recording them so a future change doesn't convert either into a selector
(trap #11):
- `registerProjectModules.ts:379-388` `siteHasUnregisteredPackageNode` — once per
  `[projectDir, trust]` transition.
- `InstanceCallSiteView.tsx:160-175` `openSwapPicker` — once per click.

Phase 0's catalog endpoint replaces the second entirely.

---

## 3. PAGE-AS-COMPONENT WITH SLOTS: FULL DESIGN

**The user's ask, stated precisely:** *build a whole page (or any subtree) as a
component, then place other components and raw elements INSIDE it as props (slots).*

Decomposed into five verbs, each of which must write real source:
**(a) promote** a subtree to a component file · **(b) parameterize** it, including
typed slot props · **(c) place** instances of it · **(d) fill** its slots on the canvas ·
**(e) write all of it back**.

(c) is ~90% built (`insertJsxElement` writes element + import and re-reads the board —
`docs/agent-refs/studio-pipeline.md:170-181`; `ModuleDefinition.sourceImport`,
`src/core/module-engine/types.ts:337`). Everything else is new.

Design principle throughout: **the user's own `.tsx` is the only representation.** No
`.studio/` sidecar remembers what a slot is — the component's own TypeScript prop type
does, and the parser reads it back. If a concept cannot survive a round trip through
plain TSX that another engineer could have hand-written, it is not in this design.

---

### Phase 0 — The local component catalog (prerequisite for everything)

**New:** `server/handlers/studio/componentSpecExtract.ts` — a pure leaf holding
`classifyPropType`, `resolvePropsTypeNode`, `resolveTypeNodeToMembers`,
`extractPropsFromMembers`, `isComponentCandidate`, **moved** out of
`packageManifest.ts:127-348` (not copied — CLAUDE.md §"No band-aids").
`packageManifest.ts` imports them. K3's alias resolution lands here, once, for both.

**New:** `server/handlers/studio/localComponentIndex.ts` +
`GET /admin/api/studio/components?dir=<abs>` → `LocalComponentSpec[]`:
```ts
{ name, file /* workspace-relative */, exportName, isDefaultExport,
  props: PropSpec[], slotProps: string[] /* props whose kind is 'node' */ }
```
- Source: the workspace-wide ts-morph `Project` that
  `componentSources.ts` already builds (`createWorkspaceProject`) — no second scan.
- For a **JS project with no types**, fall back to `buildParamBindings`
  (`detachComponent.ts:145-171`), which already reads the destructured param names.
  That yields names with `kind: 'unknown'`, which is honest — never a guess.
- Cached in `.studio/cache/` keyed on a stat fingerprint of the components dir, exactly
  the convention `computeBundleCacheKey` (`componentBundle.ts:196`) and
  `designSystemDigest.ts` already use.
- Client: `src/admin/pages/site/studio/localComponentCatalog.ts` — a tiny external store
  (`studioProjectTrust.ts` is the template), refreshed on project open and after any
  `shifted` write.

**This one endpoint closes K5, K6, and half of K4**, and is what Phases 1, 2 and 8
consume. **Effort: M. No dependencies. Do this first.**

---

### Phase 1 — Promote a subtree to a component

**New codemod:** `src/core/ast-codemods/extractSubtreeToComponent.ts`.

```ts
extractSubtreeToComponent({
  file, line, col,            // the subtree root's JSX opening tag
  workspaceRoot,
  componentName,              // user-supplied, validated PascalCase + not taken
  targetDir,                  // default: <pagesDir>/../components
  slots: { propName: string; childLine: number; childCol: number }[],
}) → { ok: true; newFile; componentName; propSpecs } | { ok: false; refusal }
```

**Algorithm.**
1. Locate with `findJsxElementAtLocationOrThrow` (`locateJsxElement.ts`) — the same
   entry every codemod uses.
2. **Refuse before touching anything**, reusing `sourceStructure.ts`'s vocabulary. Lift
   `refusePlacement` (`sourceStructure.ts:230-259`) into an exported predicate so the
   codemod and the store ask one rule: `list-row` (a `.map` row), `shared-component`
   (an inlined id — the markup is in another file), `route-chrome`, `code-placed`.
   Add two new reasons: `spread-props` (the subtree carries `{...rest}` — cannot be
   parameterized honestly) and `name-taken`.
3. **Free-variable analysis.** Generalize `referencedIdentifiers`
   (`detachComponent.ts:250-270`) to return *every* identifier the subtree references,
   then partition against the page file's scopes:
   - **module-scope** (imports, top-level consts, other components) → mirrored as
     imports into the new file;
   - **component-body locals** (props, `useState` values, `.map` callback params) →
     become the new component's **props**, one `PropSpec` each. Kind inferred from
     usage position: JSX-child or JSX-attribute-holding-JSX → `node`; a `.map` receiver
     → the array type if `staticEval` resolved it, else `unknown`; otherwise the
     literal's runtime type. Every inference is recorded and shown in the dialog for
     the user to correct — **never silently applied**.
   - **hooks** move with the subtree. Unlike detach, this direction is safe: the new
     component is a real component, so a hook inside it is legal.
4. **Extract the shared import machinery.** `addReconciledImports`
   (`detachComponent.ts:293-354`) already does page←component; this needs
   component←page. Move both into `src/core/ast-codemods/importReconcile.ts` as
   `mirrorImports(fromFile, toFile, names)` and `removeImportIfLastUsage`
   (`detachComponent.ts:357`), and have detach/extract/promote all call it.
5. **Emit the new file** — plain, hand-writable TSX:
   ```tsx
   import { Icon } from '../ui/Icon'

   interface CardProps {
     title: string
     variant?: 'primary' | 'ghost'
     header?: React.ReactNode
     children?: React.ReactNode
   }

   export function Card({ title, variant = 'primary', header, children }: CardProps) {
     return ( …the subtree, with substitutions… )
   }
   ```
   **The `interface` is the contract and it must be written to disk**, because Phase 0's
   catalog reads it back through the same classifier. Nothing is remembered in
   `.studio/`.
6. **Rewrite the call site** to `<Card title={…} header={<Old/>}>{…}</Card>`, values
   being the original **expressions verbatim** (`attrValueText`,
   `detachComponent.ts:183-192` — never an evaluated value; PROJECT-BRIEF trap #4).
7. Add the `import { Card } from './components/Card'`; run `removeImportIfLastUsage` for
   anything the page no longer references.
8. Return `shifted: true` → client reloads. Every id below the edit is now stale.

**Effort: L.** Depends on Phase 0 (for name-collision checking and to refresh the
catalog afterwards).

---

### Phase 2 — Typed slot props

Two gestures, one transform.

**At promote time.** The Promote dialog lists the subtree's direct children with a
per-child toggle: *keep inline* / *make a slot*. For each slot:
- In the **new file**, the child's JSX is replaced by `{children}` or `{header}`, and a
  `React.ReactNode` entry joins `CardProps`. The first slot defaults to `children` so
  `<Card>…</Card>` works naturally; the rest are named by the user (default: the
  child's tag or `className` root, e.g. `header`, `footer`).
- At the **call site**, `children` becomes real JSX children; every other slot becomes
  `header={<OriginalChild/>}` — **which is exactly the shape `captureSlotProps`
  (`parsePageFile.ts:524`) already materializes on the next parse.** Zero parser change
  is needed to round-trip a filled slot. This is the single most important property of
  this design: promote emits source the existing pipeline already understands.

**After the fact.** `addSlotPropToComponent(file, componentName, propName, childLoc)` —
the same transform against an existing component. Because it changes the component's
signature it touches **every call site**, so it must state its blast radius before
running ("this changes 7 call sites in 4 files", listed and linked), and it must be a
one-shot commit that reloads. The prop is emitted **optional** (`header?: ReactNode`)
so existing call sites that don't pass it stay valid.

**Effort: L.** Depends on Phase 1.

---

### Phase 3 — Parser changes (three, all small)

**3.1 Capture fragment-valued slots (closes K8 Wall 2).**
`parsePageFile.ts:535` currently declines a fragment. Change it to mint a synthetic
container when the value is a `JsxFragment`: a node with `moduleId: 'studio.slot'` whose
`children` are the fragment's roots and whose **id is the fragment's own
`relFile:line:col`** — a real, writable source location. `JsxFragment` has one; do not
mint an id (`refuseMintedNodeInsert`, `sourceStructure.ts:284`, would correctly refuse
every subsequent insert).

**3.2 New module `studio.slot`.** Copy the pattern of `src/modules/base/instance/`
verbatim: renders `<>{children}</>`, zero DOM, `canHaveChildren: true`. This is what
makes a multi-element slot possible *and* gives Phase 4 an insertion container with a
real location.

**3.3 Declared-but-empty slots are NOT materialized.** Resist the temptation to invent
a placeholder node — it would have no source location and would poison every structural
gate. Instead the panel learns about empty slots from Phase 0's `slotProps[]` and
renders an empty row whose action issues the Phase-4 insert. The tree stays honest.

**Effort: M.** 3.1/3.2 depend on nothing; 3.3 depends on Phase 0.

---

### Phase 4 — Writeback: two new `StudioEdit` kinds

`server/handlers/studioWriteback.ts` (which already dispatches `detach` at `:565` and
`swap` at `:570` — the exact template) gains:

**`kind: 'insert-slot'`** → new codemod `src/core/ast-codemods/insertJsxIntoSlotProp.ts`:
```ts
{ file, line, col,        // the INSTANCE's own call site
  propName,
  name, importSpecifier?, props?, children? }   // same payload shape insertJsxElement takes
```
- **prop absent** → `element.addAttribute({ name: propName, initializer: '{<X/>}' })`.
  This must be a **new sibling of `setJsxProp`, not a widening of it** —
  `buildInitializerText` (`setJsxProp.ts:32-41`) exists to write *scalars* safely, and
  teaching it JSX would blur that.
- **prop present, single element** → wrap both in a fragment:
  `header={<><Existing/><X/></>}`. Round-trips because of Phase 3.1.
- **prop present, expression** (`header={renderHeader()}`) → **refuse**, reason
  `slot-ambiguous`. Do not guess.
- **`propName === 'children'`** → this is not a prop; delegate to the existing
  `insertJsxElement` with the instance's call site as the container. One thing to
  verify/add there: converting `<Card/>` → `<Card>…</Card>` when the target is
  self-closing. `insertJsxElement` already writes a whole subtree per call
  (`insertJsxElement.ts:95-125`), which matters — the alternative is one re-parse per
  element, measured at >20 minutes for a 30-node screen.

**`kind: 'promote-component'`** → `extractSubtreeToComponent` (Phase 1). One-shot
commit, not the `saveSite` diff (`studioSaveRequests.ts:337` `detachInstance` is the
template): always `shifted: true`, always reloads, refusal returned as a named reason
rather than a toast-only failure.

Both run through `refuseStructuralEdit` **before** any mutation, with two new
`StructuralRefusalReason`s: `slot-locked` and `slot-ambiguous`. Both are added to
`src/core/page-tree/treeOperations.ts`'s `applyTreeOperation` dispatch so plugins and
MCP agents ride the same gate.

**Effort: M.** Depends on Phases 1 and 3.

---

### Phase 5 — Node-id implications

**No new grammar. `sourceNodeId.ts` is untouched.** Three consequences to respect:

1. A slot child already has a real `relFile:line:col` id, because
   `captureSlotProps` mints it through the ordinary `processElement` walk
   (`parsePageFile.ts:539`). Every downstream gate already treats it correctly.
2. A slot child **inside an inlined instance** gets the composite prefix from
   `prefixParsedPage`'s `rewriteSlotSentinels` (`inlineLocalComponents.ts:466-478`).
   Already correct — and this was a real pre-ship bug, so it has a test.
3. The `studio.slot` fragment container (3.1) **must** take the `JsxFragment`'s own
   location. A minted id here would silently disable inserting into every multi-element
   slot, and the refusal would blame the wrong thing.

One writeback consequence: a promote **creates a new file**, so every id in the page
below the call site shifts *and* a whole subtree's ids move to a different file.
`promote-component` therefore behaves exactly like `detach` — full reload, no partial
patch.

**Effort: S.**

---

### Phase 6 — Store and tree representation

**Keep the sentinel.** `pkg-02` chose `studio-slot:<nodeId>` inside ordinary `props`
because `props` is `Record<string, ParsedPropValue>` end-to-end, so the reference rides
every layer for free — no schema change, no `parsedPageToSitePage` carry-through, no new
`PageNode` case (`STATE.md:6395-6410`). That reasoning is still right. Two additions:

**6.1 `slotOwners` — the reverse index the sentinel lacks.**
`Map<childNodeId, { ownerNodeId, propName }>`, built **once at load** in the site slice
(alongside the `nodeIdToPageId` index WS-5.2 specs). Consumers: the DOM panel (nest a
slot child under its owner), selection (Esc from a slot child selects the owner), and
the breadcrumb chip. **This must be an index, never a selector scan** — PROJECT-BRIEF
trap #11, and `sharedTextOriginCount` (`PropertiesPanelBody.tsx`) is the standing
cautionary tale.

**6.2 `structuralSourceEdits.ts` gains `insertIntoSlot(instanceNodeId, propName, moduleId)`**,
mirroring the existing insert action: ask `refuseStructuralEdit` first, then issue the
one-shot commit, then reload.

**Effort: M.** Depends on Phase 4.

---

### Phase 7 — Canvas

**Already works, do not rebuild:** `revivePropValue`
(`registerProjectModules.ts:226-241`) renders a sentinel through `NodeRenderer`, so a
filled slot is a live, selectable, editable subtree with its own `data-node-id`, its own
selection ring, and its own Properties panel.

**7.1 Drop targets — and the trap to avoid.** An empty slot renders nothing, so there
is no rect. **Do not inject a placeholder box into the frame** (PROJECT-BRIEF trap #1: a
wrapper breaks `%`/flex chains and `>`/`+`/`:nth-child`). Instead:
- **Empty slot** is filled from the *panel* ("Add content" → the module picker) and from
  the *DOM panel* (drop a layer onto the slot row). Both are outside the frame.
- **`children`** gets a real canvas drop target, because the instance's rendered root IS
  an element — reuse the existing container drop path unchanged.

**7.2 Slot boundary affordance.** When a slot child is selected, draw its ring in a
distinct accent and show a breadcrumb chip *"in `header` of `<Card>`"* in the selection
toolbar. Pure overlay, zero DOM inside the frame. `fragmentNodeRectSource`
(`canvasNodeLookup.ts`, built by `instance-ui-01`) already measures a box-less node as
the union of its shallowest rendered descendants — a `studio.slot` container gets
correct geometry with zero changes.

**7.3 Escape semantics.** Esc from inside a slot should select the slot's **owner
instance**, not clear the selection. `selectionSlice.ts:106-137` already implements
exactly this for entered instances (`enteredInstanceIds`); extend it to consult
`slotOwners` (6.1).

**Effort: M.** Depends on Phase 6.

---

### Phase 8 — Panel UI

**One Component section for both local and package instances.** Today they are two
surfaces for one concept: a local instance goes to `InstanceCallSiteView`
(`renderModuleTabContent.tsx:99`), a package instance falls through to the generic
schema loop (`:146`). Merge into `InstanceCallSiteView`, driven by Phase 0's catalog
unioned with the bundle's `components[]`:

```
┌──────────────────────────────────────────┐
│ ⬚ Card            [Local]  ⇄ Swap  ⊗ Detach │
│                            ⧉ Duplicate      │
├──────────────────────────────────────────┤
│ Props                                     │
│   title      [ Confirm            ]       │
│   variant    [ primary        ▾ ]         │   ← from the TS union (K3)
│   onSelect   ⟨handler — edited in code⟩   │   ← K4(b)
├──────────────────────────────────────────┤
│ Slots                                     │
│   header     ⟨Logo⟩   Edit · Replace · ✕  │
│   footer     — empty —      + Add content │   ← Phase 3.3 + Phase 4
│   children   3 items        Edit in canvas│
├──────────────────────────────────────────┤
│           ⌸ Promote selection to component │   ← Phase 1, on ordinary nodes
└──────────────────────────────────────────┘
```

Specifics:
- Every **declared** prop gets a row, set or not. `setJsxProp.ts:62`
  (`element.addAttribute`) already writes a prop that isn't there, so "add a prop" needs
  no new codemod — only a row to type into. This alone closes the worst gap in K5.
- Controls come from **one** shared `controlForKind`, lifted out of
  `registerProjectModules.ts:304-331` into `src/admin/pages/site/property-controls/`.
  `controlForCallSiteValue` (`InstanceCallSiteView.tsx:80-85`) is **deleted**, not kept
  beside it.
- `SlotControl.tsx` grows *Replace* and *Clear* next to *Edit contents*, and an
  *Add content* variant for the empty case (`:43`, currently a dead `—`).
- Promote lives on ordinary nodes, in the slot `ConvertToComponentButton` occupies today.

**Effort: M.** Depends on Phases 0 and 4.

---

### Phase 9 — What gets deleted (not left beside)

CLAUDE.md forbids old-and-new side by side. In the same changes:
- `canComponentizeNode` gains `!isStudioMode()` **the moment K11 is acknowledged** (do
  not wait for Promote — it is a live data-loss path today), and is deleted from Studio
  entirely once Promote lands.
- `controlForCallSiteValue` — deleted with Phase 8.
- `src/modules/alm/register.tsx`, `scripts/gen-alm-manifest.mjs`,
  `manifest.generated.json`, and `studioPageLoad.ts`'s `ALM_DESIGN_PACKAGE_SPECIFIER`
  carve-out — deleted once `standing-07` precondition 4 passes (K12). Its
  `canHaveChildren: false` is actively wrong for slots.

**Effort: S.**

---

### Sequencing and effort

| Phase | What | Effort | Depends on |
|---|---|---|---|
| **K11 hotfix** | `!isStudioMode()` in `canComponentizeNode` | **S** | — |
| **K3 fix** | Type-alias resolution in `classifyPropType` | **S** | — |
| **0** | `componentSpecExtract.ts` + local component catalog endpoint | **M** | — |
| **3.1/3.2** | Fragment slot capture + `studio.slot` module | **M** | — |
| **1** | `extractSubtreeToComponent` + `importReconcile.ts` | **L** | 0 |
| **4** | `insert-slot` + `promote-component` edit kinds | **M** | 1, 3 |
| **6** | `slotOwners` index + `insertIntoSlot` store action | **M** | 4 |
| **8** | Unified Component panel section | **M** | 0, 4 |
| **2** | Slot promotion (at-promote + after-the-fact) | **L** | 1 |
| **7** | Canvas drop targets, slot rings, Esc semantics | **M** | 6 |
| **9** | Deletions | **S** | 1, 8 |
| **K13** | `install-package` route + repoint `DepsSection` | **M** | — |

The two `S` items at the top are independent of everything and should ship first:
one closes a data-loss path, the other restores dropdowns for most real design systems.

### Gates this design owes

- `packageManifest.test.ts` — union alias, `ReactNode` alias, alias-of-alias, cyclic alias.
- `localComponentIndex.test.ts` — TS component, JS component (names only), barrel
  re-export, renaming barrel.
- `extractSubtreeToComponent.test.ts` — plain subtree, free variable → prop, free
  variable → import, hook moves with it, `{children}` slot, named slot, every refusal.
- `insertJsxIntoSlotProp.test.ts` — absent prop, single-element prop → fragment,
  expression prop refuses, `children` delegation, self-closing → open/close.
- `slotFragment.test.ts` (parser) — fragment slot round-trips, id is the fragment's own
  location.
- An architecture gate asserting `ConvertToComponentButton` is unreachable in Studio mode.
- A `studio.slot` variant of `instanceNodes.test.tsx` — zero DOM elements, `%`-height
  chain survives.
- **No e2e in-agent** (trap #13): hand off with a "needs human dogfood" note for the
  canvas drop targets and the Promote dialog.
