# Audit: Building a page from scratch with the project's design system

Scope: `src/core/ast-codemods/`, `server/handlers/studioStructuralWriteback.ts`,
`server/handlers/studioWriteback.ts`, `src/core/page-tree/{sourceStructure,
sourceWritability,sourceNodeId}.ts`, `structuralSourceEdits.ts`,
`treeOperations.ts`, `mutations.ts`, `server/handlers/studio/{packageManifest,
packageManifestSchema,componentBundle,designSystemGuide,designSystemDigest,
pageScaffold,projectGuide}.ts`, `registerProjectModules.ts`,
`server/handlers/studioProjects.ts`, MCP tools under
`server/ai/mcp/tools/studio/` and `server/ai/tools/studio/`.

Two actors are audited separately because **they use structurally different
write paths**, discovered mid-audit and load-bearing for every finding below:

- **The in-canvas/chat agent** authors a whole new screen with the native
  `Write`/`Edit` CLI tools directly on the filesystem
  (`server/ai/drivers/claudeCliToolSurface.ts:81`, `WORKSPACE_NATIVE_TOOLS =
  ['Read','Write','Edit','Glob','Grep']`). It does **not** go through
  `insertJsxElement`/`studio_apply_edits` to build a screen — the project's own
  generated `CLAUDE.md` tells it so explicitly (`projectGuide.ts:123`: *"`Write`
  the component file and its stylesheet. One `Write` each — a screen is one
  file, not twenty edits."*). This makes the agent's screen authoring
  **mechanically unconstrained** (no codemod refusal can block it) but also
  **unverified** by any of the codemods' safety machinery.
- **The human**, dragging on the canvas (insert-from-picker, reorder, delete),
  goes through `insertJsxElement`/`moveJsxElement`/`deleteJsxElement` and is
  bound by every refusal in `sourceStructure.ts`.

---

## D1 — Page creation exists end-to-end; PROJECT-BRIEF's framing is stale (not a blocker)

**Severity:** Informational / correction.

**Evidence:** `server/handlers/studio/pageScaffold.ts:68` `createScaffoldedPage`
writes a canonical starter `.tsx`+stylesheet, auto-places a board frame
(`autoPlaceBoardFrame`, line 135), and returns a real `rootNodeId` read by
re-parsing the file it just wrote (line 89, 203). Wired three ways:
- HTTP: `server/handlers/studio.ts:672` `POST /admin/api/studio/page`.
- Human UI: `src/admin/pages/site/canvas/BoardFramesLayer/NewPageButton.tsx:55`
  calls `createStudioPage()` (`studioSaveRequests.ts:125`).
- Agent/MCP: `server/ai/mcp/tools/studio/projectTools.ts:393`
  `studio_create_page`, and it **is** in the in-canvas agent's own tool
  surface indirectly — actually it is *not*: `agentToolNames.ts:20` explicitly
  excludes `studio_create_page` from `STUDIO_AGENT_TOOL_NAMES` because the
  in-canvas agent creates the file with a native `Write` instead (see header).
  `studio_create_page` remains for **external MCP clients** only.

**Root cause of the stale doc:** `PROJECT-BRIEF.md` §3 lists "adding a
component whose package the project does not depend on yet" as a gap but does
not claim page creation is missing; my own initial read of `path-index.md`
missed `pageScaffold.ts` because it is not listed there. Not a functional bug —
flag for `studio-scribe` to add `pageScaffold.ts` to `path-index.md`.

**Effort:** S (doc only). No dependency.

---

## D2 — BLOCKER: a generic (non-`@alm-design`) design-system component can be permanently invisible in the human's insert picker

**Severity:** BLOCKER (for the human canvas-drag scenario, and for any
project whose design system is "an imported one" per the task prompt).

**Evidence — the chicken-and-egg:**
- `src/admin/pages/site/module-picker/ModulePicker.tsx:84` — the picker's
  entire module list comes from `registry.listByCategory()`. A `pkg.*`
  component that was never `registry.registerOrReplace`'d simply does not
  exist as a row, disabled or otherwise.
- `src/admin/pages/site/studio/registerProjectModules.ts:476-489`
  `useRegisterProjectModules` only calls `syncProjectModules` (the function
  that actually registers `pkg.*` modules) when **both**:
  1. `trust !== 'static'` (line 486) — Tier 0 is the default for every fresh
     import (confirmed in `PROJECT-BRIEF.md` §3 and `studioProjectTrust.ts`),
     and an agent may only *ask* for promotion, never grant it itself
     (`projectGuide.ts:290-292`: *"You may never promote a project
     yourself."*).
  2. `siteHasUnregisteredPackageNode()` (line 379-388) returns true — i.e. **a
     `pkg.*` node must already exist somewhere in `site.pages`** before the
     bundle is ever fetched.
- Condition 2 can never become true for a package the project's *existing*
  source has never used yet — installing the dependency is not enough; some
  `.tsx` already on disk must already contain a JSX call to one of its
  components for the parser to have minted a `pkg.*` node in the first place.
  This is documented as an "honest gap" in `STATE.md:6591-6596` (gap 4:
  "re-syncs only on a `[projectDir, trust]` transition, not on every reload")
  and `STATE.md:6519-6526` states plainly the generic pipeline **"never
  engages"** for the one real corpus in the repo, because nothing on that
  board triggers it.
- Contrast with `@alm-design/design-system`: `src/modules/alm/register.tsx` is
  a **module-level side effect at import** (line 20-21, `import * as DS from
  '@alm-design/design-system'`) — its 39 components are always registered,
  regardless of trust tier or board content. That is why the task's own
  phrasing ("`@alm-design/design-system` **or an imported one**") matters: the
  first half of that sentence works today, the second half is structurally
  blocked on a brand-new page.

**Consequence for the exact task scenario:** "user drags a design-system
component onto an empty frame" — if the project's design system is anything
other than `@alm-design/design-system`, and it is not already used anywhere
else in the imported source, **there is no menu item to drag.** The picker
shows nothing for it, forever, until some *other* mechanism (the agent writing
raw JSX that happens to use it, which then gets parsed and briefly appears as
an unregistered `pkg.*` node) seeds the first instance.

**Proposed fix:** `registerProjectModules.ts` should fetch/register a
project's declared `componentPackages` (`ProjectProfile.componentPackages`)
whenever trust ≥ 1, independent of whether a node already exists — i.e. treat
"trust promoted" alone as sufficient, dropping the `siteHasUnregisteredPackageNode`
gate (or keep it only as a Tier-0 fast-path optimization, not a Tier-≥1 hard
requirement). Names: `registerProjectModules.ts:476-489`,
`server/handlers/studio/componentBundle.ts` (`componentPackageDemand`).

**Effort:** M. Depends on `store-engineer`/`panel-designer` for picker UX
(should a Tier-0 project show disabled "promote to use" rows instead of
nothing?) — currently it shows literally nothing, which reads as "this design
system has no components," not "you haven't unlocked it yet."

---

## D3 — MAJOR: the rich design-system guide baked into `CLAUDE.md` is hardcoded to `@alm-design/design-system`; "an imported one" gets a materially thinner briefing

**Severity:** MAJOR.

**Evidence:**
- `server/handlers/studio/projectGuide.ts:308-312` `resolveDesignSystemGuide`:
  ```ts
  if (!profile.componentPackages.includes(ALM_PACKAGE)) return undefined
  ```
  literally hardcoded — no other installed package is ever passed to
  `buildDesignSystemGuide`.
- `designSystemGuide.ts:153-192` `buildDesignSystemGuide` — reads the
  package's own `CLAUDE.md`/`design.md` (decision map, per-component prop
  examples, icon surface). This is genuinely excellent content
  (`buildImportContract`, `renderIconReference`, `renderComponentReference`)
  but is reached **only** through the ALM carve-out above.
- For any other package, `projectGuide.ts:216-231`'s `else if (hasTokenDigest)`
  branch is the only fallback — it points the agent at
  `.claude/design-system.md`, which `designSystemDigest.ts` builds by scanning
  **CSS class selectors** (`CLASS_SELECTOR_RE`, `designSystemDigest.ts:109`)
  for a BEM block/variant index. That is a real, useful artefact for a
  CSS-class design system (Bootstrap-style `btn btn--primary`), but it
  extracts **zero information about a React component's props, required-ness,
  or JSX usage** — it cannot, because it never looks at `.tsx`/`.d.ts` at all.
- The generic, structurally-equivalent capability *does* exist —
  `server/handlers/studio/packageManifest.ts`'s `buildPackageManifest` (any
  installed package → real `PropSpec[]`) — and is exposed to the agent as a
  live tool, `studio_list_components`/`studio_find_component`
  (`server/ai/mcp/tools/studio/componentCatalogTools.ts:18-46`), which **is**
  in the in-canvas agent's own tool list
  (`server/ai/tools/studio/agentToolNames.ts:58-59`). But `projectGuide.ts`'s
  generated `CLAUDE.md` **never mentions this tool exists** — grep confirms
  zero occurrences of `studio_list_components`/`studio_find_component` in
  `projectGuide.ts`. The agent has to independently decide to call a catalog
  tool it was never told about, discoverable only from the tool's own
  one-line MCP description.
- The asymmetry is stark: for ALM, `buildGuide` (`projectGuide.ts:154-215`)
  emits an entire mandatory-usage section — *"Use `<pkg>` — always... Never
  draw an icon yourself... Never hand-roll a nav, a card, a list row..."* — plus
  the decision map, the exact import line, and the full icon catalog with
  `?raw` import instructions. For a generic package this whole section is
  simply absent; only `- Component packages: \`<pkg>\`` (line 117) is emitted.

**Root cause:** `designSystemGuide.ts`'s doc comment is explicit this was a
deliberate, narrow first slice ("Nothing here is ALM-specific... degrades to
`undefined` when a package does not ship [`CLAUDE.md`/`design.md`]") — i.e.
the mechanism *would* generalize to any package that ships the same two doc
files, but most real npm design systems don't ship a `CLAUDE.md`/`design.md`
pair in that exact shape, so in practice it only ever fires for ALM.

**Proposed fix:** Two independent, additive improvements, don't need to ship
together:
1. `projectGuide.ts`'s `buildGuide` should always tell the agent about
   `studio_list_components`/`studio_find_component` when
   `componentPackages.length > 0` and no rich `DesignSystemGuide` was found —
   one paragraph, same mandatory-usage tone as the ALM section, pointing at
   the tool instead of a static file (since the props can't be pre-baked
   without running `buildPackageManifest` unconditionally on every guide
   regen, which is a bigger, separate change).
2. Longer-term: fold `buildPackageManifest`'s structured `ComponentSpec[]`
   directly into `buildGuideFiles` for any package with `componentPackages`
   entries, not gated on doc-file conventions — this is the WS-3.1 manifest
   the picker/bundle path already computes; reusing it here needs no new
   extraction, just a renderer parallel to `renderComponentReference`.

**Effort:** M (item 1) / L (item 2, needs a fixture design system with no
`CLAUDE.md`/`design.md` — exactly the `genericRepoShapes.test.ts` discipline
CLAUDE.md's own testing rules demand).

---

## D4 — MAJOR: there is no write path anywhere for a `node`-kind (JSX-valued) prop, on either insert or edit, for the human's canvas-driven workflow

**Severity:** MAJOR (human canvas path only — the agent's raw `Write` is
unaffected, see header).

**Evidence:**
- `src/core/ast-codemods/insertJsxElement.ts:68` `InsertableJsxPropValue =
  string | number | boolean` — the type of every value `insertJsxElement` can
  put in a prop. A design-system component whose API expects
  `icon={<ChevronLeftIcon/>}` or `startAdornment={<Icon/>}` cannot receive
  that prop through the insert-from-picker flow at all. The docstring at
  lines 67-68 is explicit this is deliberate ("Only these three shapes have an
  unambiguous JSX spelling") but the consequence is that **any node-prop-driven
  design-system API is only ever partially insertable** from the canvas —
  `children` composition works, prop-driven slots do not.
- `src/core/ast-codemods/setJsxProp.ts:15,32-41` — same restriction on
  editing an *existing* element's prop: `value: string | number | boolean`,
  `buildInitializerText` only knows how to emit a string/number/boolean
  literal.
- `src/admin/pages/site/property-controls/SlotControl.tsx:26-48` — the one
  panel control for a `node`-kind prop. It only renders an "Edit contents"
  button `if (slotNodeId)` (line 31) — i.e. only when the parser already
  captured a slot value from the source at parse time
  (`captureSlotProps`/`studioSlotSentinel`). When the prop is absent (line
  42-46, `— no content in this slot`), there is **no affordance to create
  one** — it is a dead end by design, confirmed by its own doc comment (WS-6.5:
  "clicking it selects the slot's own node... before this control existed,
  the prop got no row at all").
- `packageManifestSchema.ts:29` classifies exactly this shape as `kind: 'node'`
  — the classification pipeline knows precisely which props need this and
  cannot supply it.

**Consequence:** for a design system where a common component (Button,
Cell, ListItem) takes an icon/leading-element via a **prop** rather than
`children` — a very common React pattern — a human building a screen by
dragging components from the picker can place the component but can never
give it its icon/leading slot from the canvas. They would have to hand-edit
the `.tsx` file outside Studio, defeating the point of the visual tool for
that one prop.

**Proposed fix:** Two independent parts:
1. `insertJsxElement`'s `InsertableJsxPropValue` could gain a fourth shape,
   `{ elementRef: nodeId }` or similar, resolved to a sibling-node's markup
   spliced as a prop expression container — mechanically very close to the
   existing `children` subtree renderer (`renderJsxNode`,
   `insertJsxElement.ts:398-421`), just targeting an attribute instead of the
   element's own children.
2. `SlotControl.tsx` could offer a "choose an icon" affordance backed by the
   design-system's own icon catalog (`designSystemGuide.ts`'s `IconSurface`,
   already extracted for the agent but never surfaced to the panel) when the
   slot is empty, writing a fresh `<XIcon/>` insert via (1).

**Effort:** L. Depends on `parser-surgeon` (id grammar for a prop-targeted
insert) and `panel-designer` (SlotControl UI). No dependency on D2/D3.

---

## D5 — MAJOR: reparent/duplicate/wrap remain fully banned, quantified against the real corpus

**Severity:** MAJOR (composition, not insertion).

**Evidence:** `src/core/page-tree/sourceStructure.ts:145-174`
`refuseStructuralEdit` — `reparent`, `duplicate`, `wrap` each return a fixed
refusal unconditionally, before any placement check runs (lines 146-174). Not
approximated, not partial — 100% refusal rate for all three, on every
source-derived node, always. `STATE.md:3893` confirms this is the deliberate,
conservative half of `struct-01`: *"Reparent, insert, duplicate and wrap are
REFUSED, not approximated... a node minted with a nanoid id can never be
written back."*

Quantified against the real eSIM corpus (787 source-derived nodes,
`STATE.md:3881-3890`, `docs/agent-refs/studio-pipeline.md:222-224`):
reorder succeeds on 28.8% of attempts (`shared-component` refuses 48.5%,
`list-row` 14.9%); delete succeeds on 17.0% (`orphans-import` refuses an
additional 17.4% — 137 nodes where deleting the element would orphan its own
import, and Studio refuses rather than removing both in one edit). There is
no equivalent census for duplicate/wrap because they refuse **100% of the
time**, not measured because there is nothing to measure.

**Consequence for "build me a checkout page":** the natural way to build a
list of N items (order summary rows, form fields) on the canvas is to place
one row, style it, then duplicate it N-1 times. That gesture is fully banned.
The natural way to add spacing/background structure around two existing
sibling elements — wrap them in a new `<div>` — is fully banned. Both force
the human back to hand-editing the file, same as D4's gap, for two of the
most common canvas-composition actions when building a page. (The agent, via
raw `Write`, is unaffected — it can write duplicated markup or a wrapper
directly.)

**Effort:** XL, out of scope for this audit (this is the acknowledged
`STUDIO-IMPORT-V2-PLAN.md` roadmap item, not a quick fix — a duplicate/wrap
needs the codemod to MINT new source text and hand back a real `rel:line:col`
for the copy, analogous to what `insertJsxElement` does for a picker
insertion, but for markup that already exists rather than markup supplied by
the caller).

---

## D6 — MINOR: `orphans-import` delete refusal has no "remove both together" escape hatch

**Severity:** MINOR (already flagged in `STATE.md` as the single biggest
available follow-up on delete: `STATE.md:3912`, 137 nodes / 17.4% of the
corpus).

**Evidence:** `src/core/ast-codemods/deleteJsxElement.ts:61-70` refuses
outright rather than removing the now-unused import alongside the element,
citing "one honest target" — this is correctly conservative per the
project's own writeback invariant (`CLAUDE.md` invariant 3), not a bug, but
it means the common "delete the starter scaffold's placeholder button and its
now-unused `Button` import" gesture, on a page being cleared out to build
something new, always refuses and requires a manual second step.

**Proposed fix:** A distinct, explicit `kind: 'delete-with-import'` edit that
performs both splices in one commit — same "two writes, one indivisible
statement" reasoning `insertJsxElement`'s own doc comment (lines 17-26)
already uses to justify writing an element and its import together. Names:
`deleteJsxElement.ts`, `studioStructuralWriteback.ts`.

**Effort:** M. No dependency.

---

## D7 — Strength (not a defect): insert refusal is comparatively rare because it targets the container, not the moved node

**Severity:** Informational/positive finding — cite for calibration.

**Evidence:** `src/core/page-tree/sourceStructure.ts:151-162` — an `insert`
only asks "is this CONTAINER writable" (`code-placed`/`list-row`/
`shared-component`/`route-chrome` on the *parent*), never on the new element
itself (which has no id yet). `planSourceInsert`
(`structuralSourceEdits.ts:176-191`) additionally treats an anchor as an
optional refinement, not a requirement (`resolveInsertAnchor`, lines
228-246) — an unaddressable anchor degrades to "append as last child" rather
than refusing the whole insert. Net effect: **inserting into an ordinary page
body succeeds far more often than reordering or deleting existing content
does** (no equivalent corpus refusal-rate census exists for insert
specifically, but the mechanism structurally cannot hit `no-sibling-anchor`,
`multi-select`, or `cross-file`, three of the six reorder-only refusal
reasons). This matters for the audit's core question: the "place a new
design-system component" primitive is the one structural gesture Studio is
best at, once D2/D3/D4 are accounted for.

---

## D8 — MINOR: `packageManifest.ts`'s syntactic extraction has real, quantifiable blind spots

**Severity:** MINOR–MAJOR depending on the target package's typing style.

**Evidence, each independently reproducible from `packageManifest.ts`:**
1. **Color/image classification is prop-NAME regex, not type-aware**
   (`COLOR_NAME_RE = /color|fill|stroke|bg/i`, `IMAGE_NAME_RE =
   /src|image|icon|avatar|logo/i`, lines 127-128). A `tint`, `accent`, or
   `swatch` prop is missed; a prop literally named `background` that holds a
   CSS gradient string is misclassified as `color` and gets a color-picker
   control it can't really drive.
2. **No JSDoc/description is extracted at all.** `PropSpecSchema`
   (`packageManifestSchema.ts:42-47`) has no `description` field — only
   `name`/`kind`/`required`. Whatever explanatory comment the package author
   wrote above a prop is discarded; the agent/panel sees a bare name.
3. **No default value extraction.** Neither `.d.ts` default JSDoc tags nor a
   component's actual `defaultProps`/default-destructured-parameter values are
   read. `registerProjectModules.ts:355-362` `buildDefaults` invents its own
   defaults instead — `label` gets the component's own display name (line
   358, clearly a placeholder, not the real default), and an `enum` prop
   defaults to its first listed value (line 359) regardless of what the
   component itself defaults to.
4. **A non-string-literal union loses all information.** `classifyPropType`
   (`packageManifest.ts:167-187`) only turns a union into `enum` when *every*
   member is a string literal; `size?: 'sm' | 'md' | number` or `variant?:
   'primary' | CustomVariant` (a locally-typed alias it can't resolve) both
   collapse to `unknown` — the component's real, partially-enumerable shape is
   thrown away rather than partially kept.
5. **Handler props are silently dropped, never surfaced anywhere** —
   deliberate (`extractPropsFromMembers`, line 325, `if (kind.kind ===
   'handler') continue`) and consistent with the "parse, never execute"
   invariant (a function value has nothing to bind to on the canvas), but
   worth flagging because it means a component whose primary interaction is a
   handler prop (e.g. `onSelect`) shows in the panel with that row entirely
   absent, not disabled-with-reason — indistinguishable from "this component
   has no such prop."

**Proposed fix:** (1) is a quick regex/heuristic improvement, low risk. (2)
requires reading the JSDoc comment node above the `PropertySignature`
(`ts-morph`'s `getJsDocs()`), additive, no interaction with existing tiers.
(3)/(4) are real, harder generality gaps — defer per WS-3.1's own stated Gate
(only tiers 1-2 required). (5) is arguably fine as-is per the "never stub a
function" invariant, but the panel could at least list the handler prop's
*name* as a disabled row with a reason, mirroring `moduleAvailability`'s
existing disabled-with-tooltip pattern elsewhere in this codebase.

**Effort:** S (1, 2) / M (5, panel-designer). No dependency.

---

## D9 — Strength (not a defect): round-trip id integrity is solid by construction

**Severity:** Informational — confirms no bug found where one was suspected.

**Evidence:** Every structural edit kind (`move`/`delete`/`insert`) is
unconditionally treated as shared/line-count-shifting —
`server/handlers/studioWriteback.ts:294-297` `isSharedSourceNodeId`: `if
(kind !== undefined && isStructuralEditKind(kind)) return true`. The save
route/MCP bridge always reload after any structural write
(`docs/agent-refs/studio-pipeline.md:216-220`, "They always reload
afterwards"). Because every node id is a *derived* source position
(`decodeSourceNodeId`, `sourceNodeId.ts:71-76`) rather than a stored value,
there is no id to go "stale" independently — a full re-parse after any write
that changed line counts simply recomputes fresh, correct ids for everything.
This is the correct design and I found no case where an id survives a write
it shouldn't, or fails to update after one it should.

---

## D10 — MAJOR: the agent's own canonical-JSX self-check is orphaned from its actual authoring loop

**Severity:** MAJOR — a documented quality gate silently does not run for the
primary "build a page" path.

**Evidence:**
- `src/core/page-parser/canonicalCheck.ts:513` `checkCanonicalJsx` — the
  validator that flags non-canonical patterns (inline styles instead of a
  stylesheet, hardcoded colors instead of tokens, fixed pixel widths, etc. —
  exactly the rules `projectGuide.ts`'s `buildGuide` prose asks the agent to
  follow, lines 138-150).
- Its only real call site is `server/ai/mcp/tools/studio/projectTools.ts:489`
  inside `studio_read_file`'s handler — reading a file back through the MCP
  tool folds in a canonical summary (`canonicalSummaryFor`, lines 485-501).
- But `agentToolNames.ts:19-24`'s own doc comment says `studio_read_file` is
  **deliberately excluded** from the in-canvas agent's tool list, specifically
  *because* the native `Read` tool replaces it (`claudeCliToolSurface.ts:76-81`).
  The in-canvas chat agent — the one actually building "a checkout page using
  our design system" per the task scenario — uses native `Read`/`Write`, not
  `studio_read_file`, so `checkCanonicalJsx` **never runs during, or after,**
  the agent's own authoring loop. Nothing else calls it outside tests.
- `projectGuide.ts`'s generated `CLAUDE.md` never tells the agent to call
  `studio_screenshot` + inspect for the specific canonical-violation classes
  `checkCanonicalJsx` catches (inline `style={{}}`, hardcoded hex, fixed px
  width) beyond prose reminders (lines 138-150) — those prose rules are the
  *only* enforcement left; there is no tool-based feedback loop confirming the
  agent actually followed them.

**Consequence:** an agent-authored checkout page can silently accumulate
exactly the class of defects `canonicalCheck.ts` exists to catch (an inline
`style={{ padding: '16px', color: '#0C9AB0' }}` instead of the design
system's tokens — the precise failure mode `projectGuide.ts`'s own prose
warns against) with no automated check ever running against it, before or
after the fact.

**Proposed fix:** either (a) fold a canonical-check summary into
`studio_screenshot`'s own response (already in the agent's toolset and
already called every verification pass, per the guide's own "Verifying"
section) so a violation surfaces without a new tool, or (b) keep
`studio_read_file` in `STUDIO_AGENT_TOOL_NAMES` specifically for its
canonical-check side effect even though native `Read` is faster for plain
reads — the two aren't actually redundant once this gap is accounted for.
Names: `agentToolNames.ts`, `server/ai/mcp/tools/studio/screenshot.ts`,
`canonicalCheck.ts`.

**Effort:** M. Depends on `mcp-tooling` for the `studio_screenshot` wiring
choice.

---

## Answers to the audit's numbered questions (condensed)

1. **New page from scratch:** Yes — `POST /admin/api/studio/page` /
   `createScaffoldedPage` (`pageScaffold.ts:68`), reachable from both the UI
   (`NewPageButton.tsx`) and MCP (`studio_create_page`, external clients
   only). Not a blocker; PROJECT-BRIEF should be corrected (D1).
2. **Insert path:** Writes the element **and** its import in one splice
   (`insertJsxElement.ts`), refuses on binding conflicts, is byte-exact, and
   handles subtrees in one call (avoiding the documented 20-minute-per-screen
   regression from one-insert-per-call). It does **not** handle a package not
   yet in `package.json` (writes the import regardless; install is a separate
   manual step per `PROJECT-BRIEF.md`), and — for a human, not the agent — it
   cannot reach the picker at all for a generic un-instantiated package (D2),
   nor author node-kind props (D4). Reload is unconditional after any
   structural write (`sharedComponents` always true), so latency is one full
   page re-parse per insert, and nothing desyncs across that boundary (D9).
3. **`refuseStructuralEdit` enumerated with corpus rates:** `list-row`
   14.9%, `shared-component` 48.5%, `route-chrome`/`code-placed`
   (unmeasured separately), `reparent`/`duplicate`/`wrap` 100% always,
   `multi-select` (reorder only), `cross-file`/`no-sibling-anchor` 7.0%
   (reorder), `orphans-import` 17.4% (delete). See D5/D6/D7 for detail and
   file:line.
4. **Prop authoring:** `string`/`number`/`boolean`/`enum`/`color`/`image` are
   writable end-to-end. `handler` is dropped, never stubbed (by design).
   `node` is the real gap: read (parse-time capture + `SlotControl`
   "Edit contents") but **never writable**, on insert or edit (D4).
5. **Slots/children:** WS-3.4's sentinel mechanism is a solid *read* path
   (real materialized child node, ordinary selection/edit once rendered) but
   is one-way — nothing can *create* a slot value from the canvas (D4).
   Nested arbitrary children (not slot props) work fine via
   `insertJsxElement`'s recursive `InsertJsxNode` subtree.
6. **Manifest quality:** solid `.d.ts`-first / `.tsx`-fallback tiering, real
   union→enum handling for string literals, correctly Tier-0-safe (never the
   type checker). Gaps: name-regex color/image classification, no JSDoc, no
   default extraction, non-literal unions collapse to `unknown` (D8).
7. **Round-trip integrity:** solid by construction — ids are always
   re-derived positions, never cached across a structural write, and every
   structural write forces a full reload (D9). No churn bug found.
8. **What the agent knows:** for `@alm-design/design-system`, genuinely
   excellent — a decision map, mandatory-usage rules, full icon catalog with
   correct `?raw` import guidance, and a full prop reference file, all
   generated fresh every turn (`designSystemGuide.ts`, `projectGuide.ts`).
   For **any other ("imported") design system**, this collapses to a bare
   package-name mention plus (if the system is plain CSS) a BEM class digest
   — the equivalent generic tool (`studio_list_components`) exists and is in
   the agent's toolset, but the guide never tells the agent to use it (D3).

---

## TOP 5 BLOCKERS TO BUILDING A PAGE FROM SCRATCH

1. **(D2)** A non-ALM design system's components can be permanently absent
   from the human's insert picker — no fetch is ever triggered until an
   instance already exists on the board, which is impossible on a brand-new
   page/project. Structural, not cosmetic; blocks the exact "drag a
   design-system component onto an empty frame" scenario in the task.
2. **(D3)** The agent's static briefing (`CLAUDE.md`) about the design system
   is hardcoded to one package name. For "an imported" design system the
   agent gets almost no proactive guidance and must discover the
   `studio_list_components` catalog tool on its own — directly reproducing
   the documented historical failure mode (2 of 42 components used, hand-rolled
   nav/icons) for every design system except the one already special-cased.
3. **(D4)** No write path exists for JSX-valued (`node`-kind) props, on
   insert or edit, for the human canvas flow — a design system that passes
   icons/leading elements as props rather than children is only partially
   usable from the canvas.
4. **(D5)** Duplicate and wrap are 100% refused, always — the two most
   natural canvas gestures for building a list of rows or adding layout
   structure around existing content are unavailable to the human.
5. **(D10)** The agent's own canonical-JSX quality gate (`checkCanonicalJsx`)
   is wired only to a tool (`studio_read_file`) explicitly excluded from the
   in-canvas agent's toolset — so nothing automatically catches an
   agent-authored page reintroducing exactly the anti-patterns
   (`style={{}}`, hardcoded hex, fixed px width) the project's own guide
   warns against.
