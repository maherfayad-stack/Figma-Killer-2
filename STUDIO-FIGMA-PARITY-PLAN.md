# Studio → Figma parity: the remediation plan

Derived from a 12-agent, whole-repo audit (2026-08-06). Every finding below
carries `file:line` evidence gathered by reading the actual code, not the docs.

**Companion documents.** [`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md) is
the *feature* roadmap (WS-1…WS-9) and remains valid. This document is the
*defect and ergonomics* plan: it says what is broken, what is a lie, what is
missing, and in what order to fix it. Where the two overlap, this one is newer
and was written against the code as it exists today.

---

## 0a. Execution status — updated 2026-08-07

**Everything below is uncommitted, in the working tree, awaiting one human review.**
The body of this plan is the *original* analysis and is deliberately left as
written; this block is the only place that tracks what has since landed. Where
the two disagree, this block wins. Per-track detail — published contracts,
refusal vocabularies, open seams — is in
[`docs/audits/2026-08-07-parity-handoffs/`](docs/audits/2026-08-07-parity-handoffs/),
and `STATE.md`'s `parity-01` entry is the coordination record.

| Track | Status |
|---|---|
| **Phase 0** (0.1-0.13) | ✅ all 13 landed |
| **B1** insert + destination resolution + `styleRuleId` file-scoping | ✅ landed |
| **B1b** create-a-stylesheet branch | ✅ landed — reachability guaranteed by construction, never creates when ambiguous |
| **B2** `setJsxClassName` + `class` edit kind | ✅ landed — **Tailwind element editing now exists**; replaces 0.6's refusal |
| **B3** `@layer` unwrap (`standing-09`) | ✅ landed — Tailwind v4 imported **zero** rules *and* zero warnings before this |
| **C1-C4** store/canvas perf | ✅ landed, measured |
| **D1** rulers + guides + `transformRef` | ✅ landed |
| **E1** component catalog + K3 | ✅ landed |
| **E2.1** extract-to-component · **E2.3** slot parsing | ✅ landed |
| **E3/E4** package registration + real installs | ✅ landed |
| **A1-A6, A8** agent fidelity · **A5** catalog-driven guide | ✅ landed |
| Windows architecture gates (4 vacuously-red + sweep) | ✅ landed |
| **D3** de-Studio-ify | ✅ landed |
| **D2** DnD | ◐ **partial** — G10, G9 (flex/RTL), G5 (`previewStructuralMove` published), G12 (Alt+↑/↓) landed. **G2, G3, G6, G7, G8, G15 and the `@dnd-kit` removal are NOT done** — the `dragSession` + `frameCandidateIndex` rewrite was deliberately deferred, not half-built |
| **E2.2** slot props · **E2.4** slot writeback | ✅ landed — E2.1's codemod now has a live caller (`promote-component`), and `add-slot-prop` runs its full pipeline in preview so blast radius is enforced, not advisory |
| **F1/F2** truthful inspector | ✅ landed — **S6 shipped**: inline + class styling are no longer mutually exclusive |
| **H** token model (scanner half) | ✅ landed — T12 reconciled, T9 shared, T8 demoted; **T4 fixed separately** (canvas no longer re-emits project tokens) |
| **C5** reload surgery | ✅ landed — 40-page board, one file: payload 38,637 → 1,174 B; page-ref churn 40/40 → 1/40 |
| Architecture-gate repairs + backlog | ✅ landed — and they hid **two real bugs**: `BindingPickerPopover` and `UserStylesheetInjector` both resolved the **stale pre-VC page** |
| **E2.5** panel surfaces | ◐ **incomplete** — agent was killed by a session limit just before its handoff; work is in the tree, unverified |
| **G** density · **A7** Figma discoverability · **A2** region-scoped compare | ⬜ not started |

**Still true and still blocking:** the six open decisions in §15 are unanswered,
and none of this has had the human dogfood pass that `standing-authorization`
requires. Three features in this repo have shipped green and unusable.

---

## 0. How to read this document

| Section | Use it when |
|---|---|
| §1 Corrections to the brief | **Before anything.** `PROJECT-BRIEF.md` is stale in six places and will send you chasing solved problems. |
| §2 The spine | You want to understand *why* all these defects are the same defect. |
| §3 Track map + parallelism | You are scheduling work across agents. |
| §4 Phase 0 | You are starting. Everything here is small, urgent, and mostly independent. |
| §5–§12 Tracks A–H | You are executing one work order. |
| §13 Collision map | Two agents are about to run at once. **Read before dispatching a wave.** |
| §14 Verification | You are finishing a work order. |
| §15 Open decisions | Something needs a human call. |

**Severity vocabulary.** `BLOCKER` = the advertised capability does not exist.
`CRITICAL` = silent data loss. `MAJOR` = works but wrong or unusable.
`MINOR` = friction.

**Effort vocabulary.** `S` ≤ half a day · `M` 1–3 days · `L` ≥ 4 days or needs
its own sub-plan.

---

## 1. Corrections to `PROJECT-BRIEF.md` — read first

The brief predates `pkg-01`, `pkg-02`, `parser-05`, `instance-ui-01`, `panel-01`,
`panel-02`, `perf-01`, `board-02/03` and `struct-01/02`. Six of its claims are
now false, and each one, believed, wastes days.

| Brief says | Reality | Evidence |
|---|---|---|
| "npm package components (only hardcoded `@alm-design`)" does not work | **Works.** Manifest → bundle → register → render is wired end to end | `componentBundle.ts:294` → `registerProjectModules.ts:476` |
| "component instances, swap, detach" do not work | **All work and are wired to UI**, with a passing real-browser e2e | `inlineLocalComponents.ts:321`, `renderModuleTabContent.tsx:99` → `InstanceCallSiteView.tsx`, `STATE.md:4530` |
| "CSS write-back to disk" does not work | **Editing an existing declaration works** (real postcss CST round-trip). *Creating* anything does not | `studioCssWriteback.ts`, vs `styleRuleWriteback.ts:200-267` |
| Creating a new page is a gap | **Works end to end** | `pageScaffold.ts:68`, `NewPageButton.tsx`, `studio_create_page` |
| (implied) `BreakpointFrame.tsx` is CMS residue | **Load-bearing** — board mode wraps every frame in one | `BoardFramesLayer.tsx:658-667` |
| §6 trap 11: two O(pages×nodes) selectors are a live bug | **Both fixed** (O(1) index reads). A *third*, worse one was found instead | `PropertiesPanelBody.tsx:100`, `findNodeById.ts:29-49`; new: `store.ts:300-310` |

**Also stale:** [`docs/reference/canvas-dnd.md`](docs/reference/canvas-dnd.md) is
*materially false*. It claims `@dnd-kit` is the only drag library (`:11`), that
`CanvasRoot.tsx` owns a `DndContext` (`:12`), and that `NodeRenderer` registers
`useDraggable` (`:221`). None is true, and its "forbidden patterns" table bans
exactly what ships. No architecture gate holds it honest. Fixing this doc is
part of Track D.

> **Action:** Track A includes a `studio-scribe` pass to correct all of the
> above in the same wave. Do not let the next agent re-derive it.

---

## 2. The spine — one defect, twelve faces

Twelve independent audits, given twelve unrelated briefs, converged on the same
failure mode:

> **The interface asserts something the filesystem does not honour, and nothing
> tells anyone.**

For a product whose entire thesis is *"the repository is the document"*, this is
the cardinal sin. It is not a cluster of unrelated bugs; it is one missing
invariant, violated in twelve places:

| Face | What the user is told | What actually happens |
|---|---|---|
| **E1** | "Saved" | Ctrl+Z after autosave leaves the old value on disk, permanently |
| **K11** | "Componentize" | Subtree cloned into a DB row Studio never saves; gone on reload |
| **S1** | Class applied to element | No `class` edit kind exists; vanishes on reload, no toast |
| **S4** | Inline style set | Dropped silently on any `pkg.*`/`alm.*` node |
| **C1** | New class styled on canvas | `unmapped` at save; never reaches disk |
| **G5** | Confident blue drop line | Refused *after* pointerup — on ~48.5% of nodes |
| **G3** | Drag to another frame | Silent no-op, no candidate, no message |
| **F3** | "Compared against your design" | Compared against a *different screen's* design |
| **F1** | "Tools available: …`studio_render_reference`" | Not in the capability-filtered toolset |
| **T1** | A font picker | Exactly one option: "Inherit" |
| **T3** | ~19 token choices | 18 of them do not exist in the user's app |
| **T5** | Dark-mode token values | Emitted to `:root.theme-alt`, which nothing ever sets |
| **standing-09** | Project CSS imported | Every rule inside `@layer` silently dropped (all Tailwind v4) |

**Therefore the ordering principle of this plan:** *first stop lying and stop
losing work; then make the honest thing capable; then make the capable thing
fast and pleasant.* Phase 0 buys back trust in a few days. Every later track
depends on that trust being real, because each one adds surface area that would
otherwise inherit the same disease.

**The invariant to adopt** (propose adding to `CLAUDE.md` once Track A lands):

> Every edit surface has exactly one of three outcomes: **it writes to disk**,
> **it refuses with a reason and a way forward**, or **it is not offered.**
> A fourth outcome — accepted, shown, discarded — is a bug regardless of cause.

---

## 3. Track map and parallelism

Eight tracks. **Phase 0 is a barrier — it runs first, alone.** After it, the
tracks split into three parallel bands.

```
                        ┌──────────────────────────────┐
                        │  PHASE 0 — Truth & data loss │   BARRIER
                        │  13 fixes, all S, parallel   │   (~3 days, 4 agents)
                        └──────────────┬───────────────┘
                                       │
        ┌──────────────────────┬───────┴────────┬──────────────────────┐
        │  BAND 1 (foundations)│                │                      │
        ▼                      ▼                ▼                      ▼
  ┌───────────┐         ┌────────────┐   ┌────────────┐        ┌────────────┐
  │ B  CSS    │         │ C  Store   │   │ E1 Component│        │ D1 Rulers  │
  │  authoring│         │  & perf    │   │   catalog   │        │  & guides  │
  │  engine   │         │            │   │  (endpoint) │        │            │
  └─────┬─────┘         └─────┬──────┘   └──────┬──────┘        └─────┬──────┘
        │                     │                 │                     │
        │  BAND 2 (capability)│                 │                     │
        ▼                     ▼                 ▼                     ▼
  ┌───────────┐         ┌────────────┐   ┌────────────┐        ┌────────────┐
  │ B2 class  │         │ C2 reload  │   │ E2 promote │        │ D2 DnD     │
  │  assign + │         │  surgery   │   │  + slots   │        │  unify     │
  │  Tailwind │         │            │   │            │        │            │
  └─────┬─────┘         └────────────┘   └────────────┘        └─────┬──────┘
        │                                                             │
        │  BAND 3 (surface)                                           │
        ▼                                                             ▼
  ┌────────────────────────┐   ┌──────────────┐   ┌──────────┐  ┌──────────┐
  │ F  Truthful inspector  │   │ G  Panel     │   │ H Tokens │  │ D3 de-   │
  │   (provenance+refusal) │   │   density    │   │  unify   │  │  Studio  │
  └────────────────────────┘   └──────────────┘   └──────────┘  └──────────┘

  A  Agent fidelity loop ──── fully independent, any time after Phase 0 ────►
```

### What can genuinely run in parallel

| Band | Tracks that may run **simultaneously** | Why they don't collide |
|---|---|---|
| **Phase 0** | 4 agents (see §4 split) | Disjoint files; one shared file (`STATE.md`) handled by `standing-05` protocol |
| **Band 1** | **B, C, E1, D1, A** — five agents | B owns `css-codemods`+`studioCssWriteback`; C owns `store/`; E1 owns `packageManifest`+a new route; D1 owns `canvas/CanvasRulers`+`studio-board`; A owns `server/ai/` |
| **Band 2** | **B2, C2, E2, D2** — four agents | B2 owns `ast-codemods/setJsxClassName`; C2 owns `fsCodemodAdapter`; E2 owns new codemods; D2 owns `canvas/` drag files |
| **Band 3** | **F, G, H, D3** — four agents | F+G both touch `PropertiesPanel/` → **serialize F before G**, or split by file (§13) |

### Hard dependency edges (do not violate)

| Edge | Reason |
|---|---|
| Phase 0 → everything | Data-loss fixes must land before more write paths exist |
| **B (CSS create) → H (tokens), fonts, motion, absolute-position** | Four features all block on "can we write a new CSS rule" |
| **B2 (`setJsxClassName`) → Tailwind support → F (class write target)** | No class target is honest without a `className` codemod |
| **E1 (catalog) → E2 (promote/slots), swap picker, local prop controls** | One endpoint unblocks three features |
| **C (perf indexes) → D2 (DnD)** | DnD re-measures per pointermove; fix the index first or you optimise twice |
| **D1 (expose `transformRef`) → D2, rulers, measurement HUD** | All need live transform, not the 100ms-lagged store |
| **F (provenance) → G (density)** | Don't shrink a panel whose contents are about to change |

### Explicitly *not* dependencies (common mistaken serialisations)

- Track A (agent fidelity) needs **nothing** from B/C/D/E. Run it in parallel from day one.
- Rulers (D1) need nothing from DnD (D2). Different files, different concerns.
- Panel density (G) does not need the CSS engine (B) — it is layout-only.
- Token unification (H) can begin its *scanner* work before B lands; only the
  *write* half blocks.

---

## 4. PHASE 0 — Stop losing work, stop lying. (BARRIER)

Thirteen fixes. **Every one is effort S.** Together they remove all known
silent-data-loss paths and every known false statement in the UI. Nothing else
starts until this lands, because every other track adds write surface that would
inherit the same failure mode.

**Dispatch as four parallel agents** (disjoint file sets):

| Agent | Items | Files owned |
|---|---|---|
| `store-engineer` | 0.1, 0.2, 0.3 | `store/slices/site/*`, `studio/loadedValuesBaseline.ts` |
| `panel-designer` | 0.4, 0.5, 0.6, 0.7 | `PropertiesPanel/*`, `property-controls/*` |
| `canvas-engineer` | 0.8, 0.9, 0.10 | `canvas/*dnd*`, `panels/DomPanel/*`, `media` DnD |
| `mcp-tooling` | 0.11, 0.12, 0.13 | `server/ai/*` |

### 0.1 — CRITICAL: undo after autosave permanently desyncs tree from disk

**Evidence.** `src/admin/pages/site/studio/loadedValuesBaseline.ts` holds the
diff baseline `saveSite` compares against. It is reset **only** on a full
`loadSite()` — never advanced after an ordinary non-reloading save.

**Reproduction (100%, ordinary usage):**
1. Edit a text/prop value. Wait 2 s for autosave → disk now holds the new value; baseline still holds the *original*.
2. Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> once. Tree reverts to the original — which now equals the never-advanced baseline.
3. Next autosave diffs tree-vs-baseline → "no change" → **no edit emitted, POST never fires**.
4. `hasUnsavedChanges` clears; UI shows **"Saved"**. The `.tsx` keeps the pre-undo value **forever**.

**Root cause.** An isolated oversight, not a design: the sibling paths
`styleRuleWriteback.ts` and `localizedPageWriteback.ts` **both** correctly
advance their baselines post-save. Only the main node-prop path forgets.

**Fix.** After a successful save in `fsCodemodAdapter.saveSite`, advance the
baseline for exactly the keys whose edits landed (mirror
`commitLocalizedTextBaseline`'s shape — same function, same position in the
sequence). Do **not** advance on a refused/skipped edit; that would re-hide the
edit the user still needs to see refused.

**Regression test (required).** `bun test` cannot catch this via happy-dom UI —
write it at the adapter level: seed baseline, mutate, save (fake fetch),
undo, save again, assert a second POST fires with the reverting edit.

---

### 0.2 — CRITICAL: forced reload destroys the entire undo stack and in-flight edits

**Evidence.** Every move/delete/insert/detach/swap/image-replace calls
`requestCmsSiteReload()` unconditionally in a `finally` block regardless of
outcome. That runs full `loadSite()`, which wipes `_historyPast`/`_historyFuture`
**entirely** and unconditionally clears `hasUnsavedChanges`.

**Three distinct losses:**
- The whole undo stack dies, not just the structural transaction.
- Any *other* edit still inside its 2 s autosave debounce is silently discarded.
- A <kbd>Ctrl</kbd>+<kbd>Z</kbd> issued while the structural POST is in flight is
  overwritten when the forced reload lands with already-committed disk state.
  No cancellation path, no race detection.

**Fix (Phase 0 scope — minimal, not the full redesign):**
1. Move the reload out of `finally` — reload **only when a write actually
   landed** (this is trap #5, already a documented rule, violated here).
2. Before reload, flush any pending debounced save and `await` it.
3. Preserve history across a structural reload: keep `_historyPast`/`_historyFuture`
   and re-anchor node ids (ids are re-derived source locations, so a
   post-reload re-anchor is well-defined).

Full reload surgery (targeted per-file re-parse instead of whole-workspace) is
**Track C2** — do not attempt it here.

---

### 0.3 — MAJOR: class/style edits flood and evict the undo history

**Evidence.** `updateClassStyles` / `setClassContextStyles` in
`store/slices/styleRule/crudActions.ts` call `mutateSite` with **no
`coalesceKey`**, unlike node-prop edits which correctly use
`coalesceKeyForPatch`. Every slider tick and colour-picker nudge becomes its own
undo entry, evicting the 50-entry cap.

**Fix.** Pass a `coalesceKey` of `(nodeId|classId, property)` — same shape the
node-prop path already uses.

---

### 0.4 — CRITICAL: "Componentize" is live in Studio and destroys work

**Evidence.** `componentizeEligibility.ts:4-14` checks VC-mode, `base.body`, and
ref-node — but **never `isStudioMode()`**. `visualComponentsSlice.ts:553` then
mints a `nanoid` Visual Component, clones the subtree out of the page, and
replaces it with `base.visual-component-ref` — inside `mutateSiteState`,
**bypassing `refuseStructuralEdit` entirely**. `fsCodemodAdapter.saveSite` has
no `visualComponents` path at all; VCs are `data_rows` in the dormant CMS DB.
**The subtree is gone on reload.**

Two entry points: the properties panel button and the layer-tree context menu.

**Fix.** Add `!isStudioMode()` to `componentizeEligibility`. Both entry points
read it, so one predicate closes both. Ship this **first, alone, today** — it is
a one-line fix for unrecoverable data loss.

**Do not** try to make Componentize work in Studio here. The real feature is
promote-to-component (Track E2) and it has a completely different substrate.

---

### 0.5 — MAJOR: inline-style edits dropped silently, and the panel claims otherwise

**Evidence.** `SourceConstraintNotice.tsx:70-76` states that per-property
inline-style refusals are "refused per-property by the style controls
themselves, which say so." **This is false.** `InlineStyleComposer.tsx` never
consults `codeProps` or `isStyleWritableToSource`. The only thing stopping the
write is a store guard at `store/slices/site/nodeActions.ts:452-459` — silent,
no toast, no notice. Additionally (S4) any inline style on a `pkg.*`/`alm.*`
node is dropped silently.

**Fix.** Two parts, both S:
1. Make `InlineStyleComposer` consult `isStyleWritableToSource` and render the
   control disabled-with-reason, *before* interaction.
2. Correct the false sentence in `SourceConstraintNotice.tsx`.

The full typed-constraint model is Track F; here, just stop the lie.

---

### 0.6 — MAJOR: class assignment vanishes with no message

**Evidence.** `StudioEditSchema` has seven edit kinds; **none is `class`**.
`setJsxClassName` has zero matches repo-wide. `studioCss.ts:119-132` states
outright that `className` is never rewritten. Yet `addNodeClass` mutates
`node.classIds` in memory, and `collectStyleRuleEdits` diffs `styleRules`, not
`classIds` — so a pure class assignment emits **zero edits, zero toasts**, and
vanishes on reload. Strictly worse than the `unmapped` path, which at least warns.

**Phase 0 fix (honesty only).** Detect a `classIds` delta at save time and raise
an explicit refusal toast naming the node and the class:
*"Applying a class to an element can't be written to your source yet."*
The real codemod is **Track B2**. Do not attempt it here.

---

### 0.7 — MAJOR: the save-skip toast never says which node

**Evidence.** The batched `unexplainedSkips` toast at
`fsCodemodAdapter.ts:516-533` never names the skipped node(s), while the newer
detach/swap/CSS refusal path does carry `nodeId`.

**Fix.** Thread `nodeId` (+ page id) through the skip envelope; render
"N edits skipped" with a clickable list that selects the node.

---

### 0.8 — MAJOR: drop-edge hit zones collapse at low zoom

**Evidence.** `MIN_EDGE_HIT_ZONE = 8` at `canvasDnd.ts:74` is expressed in
**unscaled frame px**. At 25 % zoom that is 2 screen px, so essentially every
drop resolves as `inside` instead of before/after.

**Fix.** Divide the constant by the live zoom when hit-testing (screen-space
constant, board-space comparison). Add a unit case at zoom 0.25 / 1 / 4.

---

### 0.9 — MAJOR: DOM panel auto-scrolls twice; no drop target resolves near an edge

**Evidence.** dnd-kit's default auto-scroll **and** a hand-rolled one in
`useDomPanelDnd.ts:183-212` both run. Already recorded independently at
`STATE.md:3947` as "no drop target ever resolves" near a scroll edge.

**Fix.** Disable dnd-kit's built-in auto-scroll for that `DndContext`
(`autoScroll={false}`) and keep the hand-rolled one. One line.

---

### 0.10 — MAJOR: illegal media drops highlight as valid, then no-op

**Evidence.** `useMediaDnd.ts:34` calls `getData()` during `dragover`, where the
HTML spec mandates it returns `""` (protected mode). So
`canAcceptDrop(…, null, …)` returns `true` — illegal folder drops highlight as
valid targets, then silently do nothing.

**Fix.** Carry the legality discriminator in the drag *type* string (available
during `dragover`) rather than the payload, or set a module-scoped
drag-session descriptor on `dragstart`. Both are standard workarounds.

---

### 0.11 — MAJOR: the system prompt advertises a tool the user cannot have

**Evidence.** `TOOL_NAMES_LINE` (`systemPrompt.ts:101`) is built statically from
`STUDIO_AGENT_TOOL_NAMES` and **never filtered by capabilities**, while the live
MCP surface *is* filtered (`registry.ts:97-99`). `studio_render_reference`
requires `studio.run.project` (`referenceRender.ts:286`), which
`capabilities.ts:90-93` deliberately never grants Admin — the role every real
operator has.

**Consequence.** The only tool that validates against the **actually-executing
app** is invisible; "done" is only ever proven against Studio's own static parse.

**Fix (Phase 0).** Make `TOOL_NAMES_LINE` capability-aware — pass the resolved
tool list from `server/ai/tools/studio/index.ts`, never the raw name array. The
*product* question (should Admin get `studio.run.project`?) is **§15 decision 1**.

---

### 0.12 — MAJOR: the best diagnostic tool is withheld from the agent

**Evidence.** `fidelityReport.ts:11-12` describes itself as "the single most
useful tool in the studio MCP family". It is **absent** from
`STUDIO_AGENT_TOOL_NAMES` (`agentToolNames.ts:36-69`) — while every *other*
exclusion in that file is explicitly justified in its own doc comment. Reads as
an oversight from WS-9.4 landing after WS-12's tool curation.

**Fix.** Add `'studio_fidelity_report'` to the array; add one line to the
system prompt's Required-workflow section telling the agent to call it when a
`studio_compare` region has no obvious CSS explanation. One array entry.

---

### 0.13 — MAJOR: the colour picker offers ~19 names per token; 1 exists

**Evidence.** `TokenizedColorField.tsx:57` sources
`generateFrameworkColorVariableSets`, which expands every token into base + 10
transparency steps + 4 shades + 4 tints (`colors.ts:264-305`), and
`tokenExtractBuild.ts:80-83` enables all of it for every *extracted project*
colour. Picking `var(--brand-l-2)` renders correctly in Studio and renders as
**nothing** in the user's app. The menu also caps at 32 (`:206`), so on a
60-token design system, search returns transparency steps before real tokens.

Paired defect (T5): dark values are emitted to `:root.theme-alt`
(`colors.ts:487-492`) while Studio's dark mode uses `html[data-studio-scheme]`.
Grep for `theme-alt` in `src/` returns **only that definition** — nothing ever
sets the class, so every dark token value is dead data.

**Fix (both S, same file family):**
1. Do not generate derived variants for **extracted project tokens** — only for
   tokens Studio itself authored and injects. A token offered must exist.
2. Re-target dark emission to `html[data-studio-scheme='dark']`.

Full token unification is **Track H**; these two stop actively-wrong output now.

### Phase 0 exit criteria

- [ ] All 13 items landed, each as its own commit (`standing-06`).
- [ ] Regression tests for 0.1, 0.2, 0.8 (the three with real reproduction steps).
- [ ] `studio-scribe` pass: correct the six false claims in `PROJECT-BRIEF.md`
      (§1) and the three in `docs/reference/canvas-dnd.md`.
- [ ] **Human dogfood** (`standing-02`): edit → autosave → Ctrl+Z → reload, and
      confirm the value on disk matches the screen. This is the one that matters.

---

## 5. TRACK B — The CSS authoring engine

**This is the highest-leverage track in the plan.** Four separate audits
independently blocked on it. Today Studio can *edit an existing declaration in
an existing rule in an existing file* and nothing else.

### What is blocked on B (and only on B)

| Blocked feature | Audit | Why |
|---|---|---|
| Any new class the user creates | C1 | `unmapped` at save, never written |
| Web fonts in the real repo | C3/T2 | needs `@font-face` emission |
| Creating a design token | T7 | needs a new custom property in `:root` |
| `position:absolute` on a new element | C4 | needs a new rule to hold offsets |
| Motion / `@keyframes` | C6 | needs a new at-rule |
| Breakpoint overrides | S7 | primitive exists, unwired; needs `@media` insert |

### B1 — `insertRule` and the source-synthesis half (M)

**Current mechanics.** `styleRuleWriteback.ts:200-267` (`collectStyleRuleEdits`)
sends any rule with no `styleRuleSources` entry to `unmapped`. That map is built
only from `.css` files that already exist (`studioCss.ts:87-104,270-304`,
`mappable = sourceFile !== undefined && /\.css$/i.test(sourceFile)`).
`src/core/css-codemods/` contains only `setDeclaration.ts`,
`analyzeDeclarationTarget.ts`, `classifyStylesheetEditability.ts`.

**Build:**
1. `src/core/css-codemods/insertRule.ts` — postcss CST insert, formatting-
   preserving, mirroring `setDeclaration.ts`'s existing byte-exactness tests.
   Signature: `insertRule(cssText, selector, declarations, { atMedia? })`.
2. **Destination resolution** — the genuinely new decision. A newly created class
   has no source. Resolve in this order, and *show the user which was chosen*:
   - the stylesheet the page already imports, if exactly one is editable;
   - else a co-located `<Page>.module.css` (create it **and** its `import`
     statement — this needs an `ast-codemods` call, so B1 touches both engines);
   - else refuse with `no-editable-stylesheet` and name why.
3. Extend `CssEditSchema` in `studioCssWriteback.ts` with an `insert` kind
   alongside `set`. **TypeBox at the boundary** — no `as`.
4. Synthesize a `styleRuleSources` entry at creation time so the rule is
   writable on its *next* edit without a reload.

**Landmine.** `styleRuleId(kind, name)` **omits the file** (S3d), so two `.css`
files defining `.button` collapse into one rule — the earlier becomes invisible
*and* unwritable. **Fix the id to include the source file as part of B1**, before
insert exists, or inserts will land in the wrong file. This is a data-shape
change: audit every `styleRuleId` consumer in the same commit.

### B2 — `setJsxClassName` (M) — unblocks class assignment *and* Tailwind

**Build** `src/core/ast-codemods/setJsxClassName.ts`: add/remove/replace a class
token in a `className` attribute. Shapes to handle explicitly, refusing the rest
by name (mirror `setJsxStyle`'s refusal vocabulary):

| Shape | Action |
|---|---|
| `className="a b"` | token add/remove in the literal |
| `className={styles.card}` | refuse `css-module-binding` — offer the declaration edit instead |
| `` className={`a ${x}`} `` | append to the static head only, or refuse `template-dynamic` |
| `className={cn('a', x)}` / `clsx` / `classnames` | append a literal arg (the evaluator already understands these calls) |
| absent | create the attribute |

Then add a `class` kind to `StudioEditSchema` and route `classIds` deltas to it
(replacing Phase 0.6's honest refusal with a real write).

**This is what makes a Tailwind project editable.** With `setJsxClassName`, a
fill change on a Tailwind element becomes `bg-red-500` → `bg-blue-600` — a
`className` edit, not a CSS edit. That is the correct write target for the
single most common React styling system, and today there is **zero** Tailwind UI
anywhere (S8).

### B3 — Tailwind read path (M) — prerequisite for B2's value

Two blockers make Tailwind projects render wrong *before* any edit:

1. **`standing-09`, live and unfixed:** `cssToStyleRules.ts` calls
   `sheet.replaceSync()` on whole CSS text through happy-dom's CSSOM, which
   **silently drops every rule inside `@layer`** — with no warning, not even
   `dropped-at-rule`. Tailwind v4's default output wraps *everything* in
   `@layer theme, base, components, utilities`. So a Tailwind v4 project imports
   **zero** rules today. Fix: unwrap `@layer` blocks in a pre-pass before
   `replaceSync`, preserving order. Reproduce first:
   `cssToStyleRules('@layer base { .x { color: red } }')` → `[]`.
2. **Tier-0 Tailwind imports render unstyled** — compilation requires trust
   promotion, and a fresh import never auto-runs it.

Also fix here: `parsed.warnings` is discarded entirely at
`studioCss.ts:274-292`. Surface them; they are the only signal that a stylesheet
partially failed.

### B4 — Fonts, for real (M) — depends on B1

**Current state is a dead end.** `FontFamilyControl.tsx:52` reads
`site.settings.fonts`; Studio builds its shell from `createDefaultSiteDocument`
(`fsCodemodAdapter.ts:291`) → `DEFAULT_SITE_SETTINGS = { shortcuts: {} }`
(`siteSettings.ts:55-57`), and `loadSite` overrides **only** `settings.framework`
(`:307-317`). **In Studio the font menu renders exactly one option: "Inherit."**
Meanwhile `FontsSection.tsx:29` imports `deleteCmsFontFamily` from the CMS
persistence layer and `googleFontsInstaller.ts:438` writes to `/uploads/fonts/`
— the admin namespace the Studio parser never reads, and `studioDownload.ts`
never zips.

**Build:** land font bytes into the project via `assetLanding.ts`; emit
`@font-face` via B1's `insertRule`; register the family in the token store
(Track H); populate the picker from **the project's own** discovered families
(`tokenExtractCssScan.ts:389,408-412` already finds them and throws them away as
`typography-detail`). Delete the CMS font path from the Studio surface.

---

## 6. TRACK C — Store correctness and performance

Four findings, all effort S, that together remove the largest per-interaction
costs. **`store.ts` is a collision point** — land C1 as one commit before
anything else in this track.

### C1 — the third O(pages×nodes) scan, worse than the two already fixed (S)

**Evidence.** `selectCanvasPageFor` (`store.ts:300-310`) runs an uncached
`board.frames.find()` + `site.pages.find()` on every call — while its sibling
`selectActivePage` deliberately keys a sweep-scoped single-slot cache for
exactly this reason. `NodeRenderer.tsx` calls it **twice per node** (`:70` for
`node`, `:135-139` for `mcClassName`), and every board frame sets both `pageId`
and `frameId` (`BoardFramesLayer.tsx:651-658`).

**Scale.** ~64,000+ comparisons per store commit on a 40-page board. WS-5.2
missed it because it runs per-**node**, not per-**panel** — the same defect class
at higher fan-out.

**Fix.** Give it the sweep-scoped `Map` memo `selectActivePage` already has.
Bundle with C2 (same file, same cache).

### C2 — `BoardFramesLayer` O(frames×pages) per render (S)

`BoardFramesLayer.tsx:172-173,220` subscribes to `s.site?.pages` (the whole
array) and `resolveFramesWithPages.ts:16-18` does a nested `.find()` per render
— re-triggered by **any keystroke anywhere**. Shares C1's page-index cache.

### C3 — CSS recomputed in a render body, once per iframe, per keystroke (S)

`UserStylesheetInjector.tsx:59-72` subscribes to the **whole `s.site` object**
and runs `collectUserStylesheetCss` → `resolveViewportUnitsForCanvas` (regex) →
`rewritePrefersColorScheme` (regex) in the **render body**, not a gated
`useEffect`. `site`'s top-level reference changes on every site-touching
mutation, so this re-runs on every keystroke × every mounted iframe (6–15+).

**Fix.** Copy `ClassStyleInjector.tsx`'s pattern sitting directly beside it —
narrow slices, effect-gated. Independently corroborated by audit 06 (E9), which
found the same `s.site` whole-object subscription in `CanvasComposedTree.tsx`
and `useRuntimeScriptBuild.ts`. Fix all three.

### C4 — save diffs the whole document every 2 s (S/M)

`saveSite` scans and diffs every node of every page on every autosave tick,
ignoring the `_opts.dirty` hints that `saveTrackingSlice.ts` already maintains
correctly (E5: `_opts` is literally unused — a dead duplicate source of truth).
At the docs' own 40-page/40k-node reference scale this is real client cost every
2 s. Also `selectionSlice.ts`'s `findSelectableNode` does an O(pages) linear
scan instead of using the existing `_nodeIdToPageIds` index (E10).

### C5 — reload surgery (M) — Band 2, depends on Phase 0.2

Every structural edit forces a **full-workspace re-parse** via
`/admin/api/studio/load`, though the server already knows which file it wrote.
Build a targeted per-file reload route and use it for structural commits.
This is what makes structural editing feel instant instead of a full board blink.

**Verified clean — do not re-audit:** Mutative usage throughout (correct
draft-mutation style, single correct `rawReturn`, no `structuredClone`),
node-prop coalescing, selection survival across reparse, `ClassStyleInjector`,
`frameVirtualization`, `frameSnapshotCache`, `useFramePosterCapture`, iframe
listener teardown, and `useCanvas.ts`'s 60 fps pan/zoom mechanism.

### Perf budgets to add (gate, per WS-5.6)

| Budget | Threshold |
|---|---|
| Store commits per single keystroke | ≤ 1 re-render per *visible* frame, not per mounted frame |
| `selectCanvasPageFor` calls per commit | O(visible nodes), cached |
| Autosave diff cost | O(dirty nodes), not O(document) |
| Pointermove during drag | 0 forced layout reads (see D2) |

---

## 7. TRACK D — The canvas as a design tool

### D1 — Rulers and guides (M)

#### The transform math — get this exactly right

```
transform: translate(panX, panY) scale(zoom)   /* transform-origin: 0 0 */
screen = local * zoom + pan
```

applied to `CanvasTransformLayer` (`math.ts`, `CanvasTransformLayer.module.css`).

**Two landmines that will silently break a naive implementation:**

1. **The 80px offset.** `.transformLayer` sits at a static
   `top:80px; left:80px` relative to `.canvas`
   (`CanvasTransformLayer.module.css:17-30`). **`frameVirtualization.ts`'s own
   documented formula omits this term** — harmless there (600px culling margin
   absorbs it), fatal for pixel-exact rulers. Copying that formula ships ticks
   80px off.
2. **The 100ms lag.** During an active gesture the store's `zoom/panX/panY` lag
   the real DOM transform (`useCanvas.ts` writes a `transformRef` and debounces
   the store commit). A ruler subscribing to the store selector visibly lags
   mid-drag. **It must read the live `transformRef`** — which `useCanvas()` does
   not currently expose. Exposing it is the one required hook change, and
   **D2 and the measurement HUD need it too**, so do it first.

#### Mount point

Rulers mount as **siblings of `CanvasTransformLayer`, inside `.canvas`** —
exactly where `CanvasNotch`/`CanvasModeToggle` already sit untransformed
(`CanvasRoot.tsx:560-592`). They must never be inside the transformed subtree.

#### Component design

```
src/admin/pages/site/canvas/CanvasRulers/
  CanvasRulers.tsx      composition + the corner square
  RulerH.tsx            <canvas>-painted, NOT per-tick DOM
  RulerV.tsx
  rulerGeometry.ts      PURE: niceTickStep(zoom), boardToScreen, screenToBoard
  CanvasRulers.module.css
  __tests__/rulerGeometry.test.ts
```

Paint to `<canvas>`, not DOM nodes — a 4000px ruler at 1px ticks is thousands of
elements otherwise.

- **Tick density:** nice-number ladder (1/2/5/10/25/50/100/250/500/1000) picking
  the smallest step whose on-screen spacing ≥ ~60px.
- **Origin:** board `(0,0)` normally; shifts to the active frame's own `(x,y)`
  when exactly one frame is active (matches Figma).
- **Pixel grid** at high zoom and the **Alt-hover measurement HUD** are
  separable follow-ups, not part of the M.

#### Guides — persistence

⚠️ **Name collision.** `BoardGuidesLayer`/`boardSnapGuides` already exist and are
**transient drag-time alignment lines**, not persisted ruler guides. Different
concept. Do not extend them; name the new one distinctly (`RulerGuidesLayer`).

Add `guides: BoardGuide[]` to `Board` in `src/core/studio-board/types.ts`,
mirroring the existing `docs`/`notes` pattern exactly (pure transform + coerce +
`boardSlice` action). **This rides `.studio/boards.json` autosave for free — no
new server route.** Guide↔frame snapping extends `boardSnapping.ts`'s
`collectPeerRects`.

**Scoped out, deliberately:** node-level (inside-a-frame) snap-to-guide. Canvas
nodes are real DOM elements in flow, not freely-positioned vector objects —
this is an architectural mismatch, not an oversight. Revisit only if free
positioning ever lands (§15 decision 3).

### D2 — Drag and drop: one architecture (L) — depends on C, D1's `transformRef`

**Current state: 16 surfaces, 4 incompatible mechanisms, 6 independent drop
resolvers, 3 separate index-normalisation implementations.**

| Mechanism | Surfaces |
|---|---|
| Raw pointer events | canvas node reorder, board frames/notes/docs, module palette, media→canvas, floating panels, marquee |
| `@dnd-kit/core` | layer tree (`DomPanel.tsx:493`), site explorer, dashboard — three separate `DndContext`s |
| Native HTML5 + `dataTransfer` | media workspace, image drop in Properties panel, CMS import |

#### The defects, in landing order

**Ship these four first — real fixes, independently shippable, under a day**
(0.8/0.9/0.10 are already in Phase 0; these are the rest):

- **G10** — multi-drag index off by n−1. `normalizeIndexAfterRemoval`
  (`core/page-tree/dnd.ts:119-131`) compensates for **one** removed node;
  `moveNodes` (`mutations.ts:580-587`) detaches **all** of them. Untested.
- **G12** — **zero keyboard path.** No `KeyboardSensor` anywhere, and no command
  alternative: no "Move up/down" in any menu, palette, or shortcut. Reordering
  requires a mouse. Add keyboard move commands — this closes the entire a11y gap
  independently of the DnD rewrite.

**Then the structural ones:**

- **G2 — you cannot drag an element on the canvas.** The only drag trigger is a
  13px hand-grab button in the floating selection toolbar
  (`SelectionToolbar.tsx:74-83`, wired at `BreakpointSelectionOverlay.tsx:540`)
  — a toolbar whose placement is itself the documented drift defect. **Make the
  element itself draggable.**
- **G3 — cross-frame drag is structurally impossible.** Candidates are measured
  once, from one iframe, against one page (`useCanvasReorderDrag.ts:301`); a drop
  over another frame finds no candidate and hits `if (!target) return` (`:248`)
  — silent no-op.
- **G5 — refusal is post-hoc, on ~half of all nodes.** `core/page-tree/dnd.ts`
  never consults `refuseStructuralEdit`; the gate lives in the store after
  pointerup (`nodeActions.ts:554-558`). `STATE.md:3894` records `shared-component`
  refusals at **48.5% of nodes**. `tests/e2e/structural-writeback.e2e.ts`
  currently encodes this as *intended* — that test must change with the fix.
- **G6 — no throttling.** `resolveCanvasPointerInsertionDrop` runs
  `querySelectorAll('[data-node-id]')` + `getBoundingClientRect()` +
  `getComputedStyle()` for every node, every pointermove
  (`ModuleInserterDialog.tsx:354-368`, copied verbatim in
  `useMediaCanvasInsertionDrag.ts:53-76`). ~2400 forced layout/style reads per
  move on the eSIM corpus.
- **G7 — insertion drags target the wrong page.** They resolve against
  `selectActiveCanvasPage` (`ModuleInserterDialog.tsx:120`) but measure from the
  frame under the cursor (`canvasInsertionDrop.ts:64-81`): preview highlights
  frame B, insert lands in page A (`:89-95`).
- **G9 — axis inference is flex-only.** `inferCanvasDropAxis`
  (`canvasDomGeometry.ts:286-291`) checks `display.includes('flex') &&
  flexDirection.startsWith('row')`. Grid → wrong. `row-reverse`/`column-reverse`
  → inverted. **RTL entirely unhandled**, though Studio ships an RTL preview axis.
- **G8 — board furniture** writes the store **twice per pointermove**
  (`setBoardSnapGuides` + `setFramePosition`, each cloning `boards`); no
  multi-frame drag; no Escape; snap peers keyed by `pageId` so variants never
  snap (`boardSnapping.ts:144-147`).
- **G15** — no file drop on the canvas or the Studio importer (zero `onDrop` in
  `canvas/`; `ImportProjectDialog.tsx` has none). Server side
  (`asset-upload`, `landAssetBytes`) is **already built** — this is UI-only.

#### The target architecture

One `dragSession` singleton (replacing the `data-studio-canvas-dragging` global
attribute and three inline pointer loops) + a lazily-built, cached, **board-wide**
`frameCandidateIndex` (fixes G3 and G6 together) + one source-aware `resolveDrop`
that calls an extracted `previewStructuralMove`, so **refusals surface while the
pointer is still down** (fixes G5). Three thin adapters: canvas / tree-row /
board-furniture.

**`@dnd-kit/core` is removed** — it cannot cross the iframe boundary, which is
precisely why a hand-rolled system already exists in parallel. Per CLAUDE.md's
no-old-and-new rule, one survives.

**The pattern to copy:** `useDraggablePanel.ts:136-144` — writes CSS custom
properties to a ref during the move, commits React state **once** on pointerup.
That is the only surface doing it right today.

**Add an architecture gate** (`src/__tests__/architecture/`) asserting a single
drag mechanism, and rewrite `docs/reference/canvas-dnd.md` to describe reality.

### D3 — De-Studio-ify (S, independent)

| Item | Verdict | Evidence |
|---|---|---|
| `CanvasContextSelector` (breakpoint/condition dropdown) | **Kill in board mode** — renders and functions but is a genuine no-op; every board frame uses one hardcoded synthetic breakpoint that ignores `activeBreakpointId` | `CanvasRoot.tsx:590-592`, `BoardFramesLayer.tsx:146` |
| `BreakpointFrame.tsx` | **KEEP** — load-bearing, wraps every board frame | `BoardFramesLayer.tsx:658-667` |
| Publish / save-draft chrome | **Already hidden correctly** — do not "fix" again | `AdminCanvasLayout.tsx:249-272` |
| `runScripts` toggle | **KEEP** — legitimate Studio infrastructure | — |
| Dead `workspace?: 'site'\|'content'\|'media'` prop | **Delete** — those workspaces don't exist on disk | `LeftSidebar.tsx:50`, `PanelRail.tsx:74` |
| `Shift+1` = "reset to 100%" | **Rebind** to zoom-to-fit; add zoom-to-selection. Neither exists | `ZoomControls.tsx:17-21` |
| Alt-hover distance / padding-margin viz | **Missing** — grep finds nothing. The ring/badge itself is already correct | — |
| Frame collapse-to-chip, board outline view | Missing at 30-frame scale; scoped as a later pass | — |

**Verified present — do not report as missing:** marquee selection, frame
multi-select (Shift-click, ⌘/Ctrl+A, bulk align/distribute/tidy), and the
intent-scoped Escape ladder all genuinely ship (`useMarqueeSelection.ts`,
`boardSlice.ts`, `useCanvasSelectionKeyboard.ts`).

**Architectural note, not a defect list:** node resize handles, rotation, and
alt-drag do not map 1:1 to Figma because nodes are real DOM elements in normal
flow, not free vector objects. **Rotation is the one clean, low-risk gap** —
everything else needs the layout-model decision in §15.

---

## 8. TRACK E — Components, props, and page-as-component

### E1 — The component catalog (M) — **do this first; it unblocks three features**

**The gap.** Nothing in the product can answer *"what components does this
project have, and what props do they take?"* Consequences:

- The Swap picker offers 0–3 candidates because it scans the **loaded board**
  (`InstanceCallSiteView.tsx:160-175`).
- A local instance's controls are guessed from **runtime value types**
  (`:80-85`), so a string union gets a text box, not a dropdown.
- A prop the call site **doesn't pass gets no row at all** (`:107, 310`) — you
  cannot add a prop in-product, though `setJsxProp.ts:62` would happily write it.

**Build:**
1. Move `classifyPropType` / `resolvePropsTypeNode` / `extractPropsFromMembers`
   out of `packageManifest.ts` into a shared `componentSpecExtract.ts`
   (**moved, not copied** — CLAUDE.md forbids old-and-new).
2. Land **K3** there once, for both paths: `classifyPropType`
   (`packageManifest.ts:167`) returns `unknown` for a `TypeReference`, so
   `variant?: ButtonVariant` — a named union alias, which is what **MUI, Chakra,
   Mantine and shadcn all ship** — renders a free-text box instead of a dropdown.
   The module already has bounded alias resolution (`findNamedTypeMembers:199`),
   just only down the object-shape path.
3. Add `GET /admin/api/studio/components` → `LocalComponentSpec[]`, off the
   ts-morph `Project` that `componentSources.ts` already builds. TypeBox schema.
4. JS-only projects fall back to `buildParamBindings`
   (`detachComponent.ts:145`) — names without kinds, which is **honest**.

### E2 — Page-as-component with slots (L) — the flagship

**The principle:** *the user's own `.tsx` is the only representation.* No
`.studio/` sidecar remembers what a slot is — the component's own `interface`
does, and the parser reads it back.

**Why not the CMS Visual Component system:** its `propBindings` map exists to
remember which node prop is wired to which param. In Studio that is just
`{title}` written in the JSX — **the source already carries what `propBindings`
exists to remember.** So VC is the wrong *substrate* (nanoid ids, DB rows) while
its *interaction model* is exactly right to copy: outlet-in-definition paired to
fill-in-consumer **by name**, "the outlet IS the slot", fills as ordinary locked
nodes in one flat tree.

**The observation that makes this affordable:** a slot fill written as
`header={<Original/>}` is **exactly the shape `captureSlotProps` already
materializes** (`parsePageFile.ts:524` mints `<Icon/>` as a real node with a real
`relFile:line:col`; `props` holds `studio-slot:<id>`; `revivePropValue`
(`registerProjectModules.ts:226`) renders it as a live editable subtree).
**A filled slot round-trips with zero parser change.**

**Today's four walls:** an *empty* slot has no node and no action
(`SlotControl.tsx:43` renders a dead `—`); a *fragment* value is declined
(`parsePageFile.ts:535`); nothing can be *inserted into* a slot (it is `locked`,
so `sourceStructure.ts:250` refuses `code-placed`); slot children are *invisible
in the layer tree* (the DOM panel walks `children`; slots live in `props`).

#### Sub-phases

**E2.1 — `extractSubtreeToComponent.ts` (L).** Locate → **refuse first** via a
lifted `refusePlacement` (`sourceStructure.ts:230`, reusing the vocabulary the
user already sees) plus new `spread-props` / `name-taken` → free-variable
analysis (generalize `referencedIdentifiers`, `detachComponent.ts:250`),
partitioning module-scope names into mirrored imports and body-locals into
**props**, *each inference shown for correction, never silently applied* → emit
plain hand-writable TSX **including the `interface`** → rewrite the call site
with the original **expressions verbatim** (`attrValueText` — never evaluated
values; **trap #4**) → `shifted: true`.

Hooks move *with* the subtree — safe in this direction, unlike detach.

Extract `addReconciledImports` / `removeImportIfLastUsage` into a shared
`importReconcile.ts` so detach/extract/promote share one implementation.

**Note:** `extractComponentCopy.ts` is **not** extract-to-component — it
duplicates an existing component *file* (`Card.tsx`→`Card2.tsx`) and repoints one
call site, reachable only behind a detach refusal. Do not mistake it for this.

**E2.2 — Typed slot props (L).** At promote time each direct child gets a
keep/slot toggle; a slot becomes `{children}`/`{header}` in the new file and
`header={<Original/>}` at the call site. `addSlotPropToComponent` does the same
to an existing component afterward, **stating its blast radius up front** and
emitting the prop **optional** so existing call sites stay valid.

**E2.3 — Parser, three small changes (M).**
- Capture fragment-valued slots as a `studio.slot` container whose id is the
  **`JsxFragment`'s own location**. ⚠️ A *minted* id would make
  `refuseMintedNodeInsert` correctly kill every insert into a multi-element slot
  — and the refusal would blame the wrong thing.
- New `studio.slot` module copying `src/modules/base/instance/` verbatim
  (`<>{children}</>`, zero DOM — **trap #1**).
- **Do not materialize declared-but-empty slots.** The panel learns them from
  E1's catalog; the tree stays honest.

**E2.4 — Writeback, two edit kinds (M).**
- `insert-slot` → new `insertJsxIntoSlotProp.ts`. Absent prop → `addAttribute`
  with JSX; present single element → wrap both in a fragment (round-trips via
  E2.3); expression-valued prop → **refuse `slot-ambiguous`, do not guess**;
  `children` → delegate to existing `insertJsxElement`, which already writes a
  whole subtree per call (one element per call was measured at **>20 min for a
  30-node screen**).
  A **new sibling of `setJsxProp`, not a widening** — `buildInitializerText`
  exists to write scalars safely.
- `promote-component` → one-shot commit, like `detach`.
- Both gate through `refuseStructuralEdit` before mutating, and both are added
  to `applyTreeOperation` so MCP and plugins ride the same gate.

**E2.5 — Surfaces (M).** No node-id grammar change needed (slot children already
have real locations; composite prefixing is handled by `rewriteSlotSentinels`).
Keep the sentinel in `props` (pkg-02's reasoning holds) and add `slotOwners` as
an **index built at load, never a selector scan** (**trap #11**).
Canvas: **no placeholder box inside the frame** (**trap #1**) — empty slots are
filled from the panel and layer tree; only `children` gets a real drop target;
`fragmentNodeRectSource` already measures box-less nodes correctly.
Panel: **one** Component section for local *and* package instances (today they
are two surfaces for one concept), every declared prop gets a row set-or-not,
`controlForCallSiteValue` **deleted**, `SlotControl` grows Replace/Clear/Add.

### E3 — Dependencies panel can't install (M, independent)

`DepsSection.tsx:144` writes the in-memory `site.packageJson` and carries
`// TODO(Phase G): ask the site bridge to install this`. `InstallDependenciesPrompt`
appears only when `node_modules` is **missing** (`:184`). So the brief's
documented remedy for the insert gap — "install it from the Dependencies panel"
— **does not exist**. Wire it to the existing `installDeps.ts` job.

### E4 — Non-ALM design systems can't be dragged in (M) — BLOCKER

`registerProjectModules.ts:379-489` registers a package's components only when
trust ≥ 1 **and** a `pkg.*` node already exists on the board — impossible on a
fresh page. `ModulePicker.tsx:84` lists only already-registered modules.
`@alm-design` sidesteps this entirely via a build-time static import
(`src/modules/alm/register.tsx:20`).

**Fix.** Drive registration from E1's catalog + `ProjectProfile.componentPackages`
rather than from board contents. This is the precondition for `standing-07`'s
`@alm-design` deletion.

---

## 9. TRACK F — The truthful inspector (M) — depends on B2

### F1 — Effective value + provenance: an integration, not a build

**The discovery that halves this work:** the honest view **already exists**.
`InspectPanel/useInspectComputedStyle.ts:62` reads real `getComputedStyle` from
the iframe. It lives in the **left** sidebar, read-only, disconnected from
editing.

> Studio today ships **a panel that lets you edit but shows lies**, and **a panel
> that shows truth but changes nothing.**

**The problem it fixes.** `StyleSectionsEditor.tsx:286-306` reads store bags
only, and the unset placeholder is a **hand-written spec-default table**
(`cssControlTypes.ts:208-328`) — so a field can confidently read `transparent`
on an element rendering red. No per-property provenance, no strikethrough for
shadowed declarations (`ClassPropertyRow.module.css` has no `line-through`), and
only one active class is ever consulted (`usePropertiesPanelData.ts:165-168`).

**Build.** One property list sourced from the **frame**, with per-row
provenance always visible: winner + losers + inherited. Per-row **write-target
menu** stating each option's disk outcome — replacing `StyleTargetChip`'s modal
design (today only two targets exist: Element via `setJsxStyle`, always lands but
inline; or Class, which refuses on Tailwind/CSS-Modules — i.e. most repos).

**Also fix here — S6, the direct answer to "classes and inline styles at the
same time":** inline and class styling are mutually exclusive **by store
invariant** (`uiStateActions.ts:28-48`) — you must delete a class to see inline
styles. That invariant is the feature request. Remove it; show both, always,
with provenance saying which wins.

### F2 — The refusal model (M)

The engine is **sound** — `isPropWritableToSource` (`sourceWritability.ts:56`)
and `refuseStructuralEdit` (`sourceStructure.ts:132`) are pure, single-sourced,
and correctly separate structure from values. The 30-row taxonomy is in
`audit/09-refusal-states.md`. The problem is transport and presentation.

**Build `src/core/page-tree/editConstraint.ts`:**

```ts
EditConstraint {
  reason:      // discriminated union — the taxonomy's 30 branches
  scope:       'prop' | 'style-property' | 'node' | 'gesture'
  explanation: string          // human sentence, engine-authored
  origin?:     { file, line, col }   // clickable
  actions:     EditConstraintAction[]  // the way forward
}
```

Additive wrapper — **zero changes to existing store guards or codemods.**

**Fixes it carries:**
- **R2** — `ParsedNode.resolution` keeps only the **first** resolved value per
  node (`nodeResolution.ts:161-171`), so with two code-valued props one shows its
  real source and the other falls back to a generic "set in code"
  (`propLockReason.ts` admits this in its own comment). Make `resolution`
  per-prop.
- **R4** — structural refusals are reactive-only; **pre-disable** the layer-tree
  context menu items.
- **R8** — no `file:line` anywhere in the refusal UI is clickable.
- **R6** — `branchAlternatives` is view-only by the author's own admission
  (`BranchChoiceNotice.tsx`); build the **switcher** (editor state only, never
  written back — per the `parser-06` decision).
- **R5** — `extractInstanceCopy`'s real "duplicate as new file" hatch is
  reachable only from a *failed Detach*, never from an attempted Duplicate.
- **R7** — three notice components stack unconditionally at the panel top;
  collapse to at most two genuinely whole-node banners once per-field
  affordances exist.

**Per-field design:** a lock/link glyph with hover explanation + action,
replacing today's inline `· set in code` text.

**Ways forward to build** (one per refusal family): *jump to the binding's
source* · *edit the data array* (`.map` row) · *detach or edit the definition*
(shared component) · *edit the call site* · *promote to Tier 1* (package).

---

## 10. TRACK G — Panel density (M) — run **after** F

> **This track is much smaller than expected.** WS-6.1–6.4 largely shipped
> already: `ScrubInput` (drag-scrub, ±1/Shift±10/Alt×0.1, `MIXED`),
> `StyleTargetChip`, `AlignBar`, `SpacingBoxControl`, `BorderControl`, and the
> full Figma-shaped collapsible section order all exist and are wired into
> `StyleSectionsEditor.tsx`. **This is surgery, not a redesign.**

### The density win (S)

| Control | Now | Target |
|---|---|---|
| `SpacingBoxControl` | box-model diagram, `aspect-ratio 4/3`, **~210px tall** (`SpacingBoxControl.module.css:22-28`) | one-row 4-up `ScrubInput` as **default**; diagram behind "Advanced" |
| `BorderControl` | side/corner picker diagrams, **~130-160px** (`BorderControl.tsx:255-369`) | same treatment |
| Panel width | floor 300px, default 360px (`src/admin/state/workspaceLayout.ts:9-10`) | floor ~260px, default ~300-320px (Figma ≈240px) |
| Label columns | three hardcoded `100px` literals (`ControlRow.module.css:6`, `ClassPropertyRow.module.css:9`, `LayoutSection.module.css:103`) | one new token |
| `Section.module.css:34` | hardcoded `12px` | `var(--panel-radius)` |

Keep the existing 28/32px control-height rhythm — it already matches Figma.

### Wiring already-built primitives (S — highest value per hour)

- **Multi-select style editing does not exist.** `MultiSelectionInspector.tsx`
  (2+ nodes) and `MultiSelectorInspector.tsx` (2+ classes) render only an action
  bar + layer list. `MIXED` and `ScrubInput` are **proven in
  `FrameBulkInspector.tsx`** and wired to **zero** node/class surfaces.
- **`AlignBar` is built** but reachable only from board-frame bulk align. Mount
  it above the style-target chip for single-node selection (WS-6.1 row 1).

### New primitives needed (M)

| Primitive | Why |
|---|---|
| `AlignGrid` (3×3) | `AlignmentControl` uses two linear `SegmentedControl` rows for what Figma does in one grid |
| `IconToggleGroup` | six enums (`textAlign`, `textDecoration`, `textTransform`, `fontStyle`, `objectFit`, `boxSizing`) render as word-labeled dropdowns |
| `ColorField` | today's `ColorInput` is a native `<input type="color">` — no alpha, no eyedropper, no hex/rgb/hsl toggle, no recents. **Keep its token-picker integration, which is genuinely good** |
| Math expressions | `"100/2"` rejected by both `scrubMath.ts:23` and `numericNudge.ts:41` |

**Consistency bug:** Shift-nudge is **10** in `ScrubInput` but **8** in
`numericNudge.ts`. Pick one. Also, drag-scrub is wired only into `SizeSection`'s
six fields — gap, TRBL offsets, padding/margin, border width/radius are
keyboard-only.

**Gate-clean already:** no hex/rgb and no `var(--x, fallback)` violations were
found anywhere in the audited panel files.

---

## 11. TRACK H — One token model (L) — write half depends on B

**Seven token models exist; four describe the same colours.**

| # | Model | Storage | Consumers |
|---|---|---|---|
| M1 | `FrameworkSettings` | `.studio/framework.json` | picker, ColorsPanel, canvas `:root`, `studio_list_tokens` |
| M2 | `ClassifiedTokens` | in-memory | extraction only |
| M3 | `ProjectTokenIndex` | rebuilt per call | `studio_measure_reference`, `studio_compare` |
| M4 | `SiteFontsSettings` | **CMS DB** + `/uploads/fonts/` | `FontFamilyControl`, `FontsSection` |
| M5 | design-import candidates | `styles/imported/<slug>/` | wizard → M1 |
| M6 | design-system digest | `.claude/design-system.md` | the Claude CLI agent |
| M7 | `StyleRule` registry | the project's real CSS | `StyleSurface` — **the only real write path** |

`projectTokenIndex.ts:33-38` explicitly refuses M1 ("two names from two
systems"). **That comment is a correct diagnosis of a wrong architecture.**

### The defects (beyond Phase 0.13)

- **T4 — the framework shadows the project's own tokens.** Framework values are
  HSLA-normalized (`colors.ts:356-359`) and injected into `@layer user-authored`
  (`ClassStyleInjector.tsx:175`) — **the same layer** the project's own
  stylesheets land in (`UserStylesheetInjector.tsx:90`). Two declarations of
  `--color-aqua-100` compete; within-layer order decides. Stop re-emitting
  project tokens.
- **T6 — discovery gaps.** Missed: **Tailwind v4 `@theme`** (not a global host
  selector, not in `atRuleDescentContext`'s allowlist at `:283-292` — invisible
  at Tier 0), Tailwind v3 non-`extend` `theme.colors`, Tailwind `fontFamily`,
  function/spread-built themes, SCSS `$vars`, **JS theme objects in the open
  project** (`extractJsTokens` exists but is wired only to the *external*
  npm/GitHub wizard), CSS-in-JS, Figma variables, non-16px root for `rem`, and
  **radius/elevation** (classifiers exist in `designSystemDigest.ts:180-183` for
  the markdown digest only).
- **T12 — the two scanners disagree** on scope, `var()` depth, `rem`, colour
  syntax, dark values, and font-size naming. The agent can name a token the
  picker never offers, and vice versa.
- **T8 — the raw hex escape hatch.** The native `<input type="color">` beside the
  token field writes a **raw hex on one click** (`TokenizedColorField.tsx:92-95`),
  silently detaching the token. Demote it behind "Custom".
- **T9 — `contrastRatio` is server-only** (`colorMath.ts:110`, zero imports from
  `src/`). No AA/AAA badge anywhere. **Cheapest high-value fix in the audit.**
- **T10 — no eyedropper, no reference sampling.** Zero `EyeDropper` matches. The
  server machinery (`referenceMeasure.ts` palettes, `extractReferenceAsset.ts`
  crops) is **already built** — UI only.

### Target

One `DesignToken` at `src/core/design-tokens/`, keyed by **the project's real
property name** — no slug, no derived variants — with `origin.{kind,file}` for
provenance, and families extended to font-family/weight/radius/elevation. One
sidecar `.studio/tokens.json` replacing `framework.json`. One resolution path:
scan → classify → persist → (picker | MCP | canvas), with the canvas **no longer
re-emitting project tokens**.

Five write targets: existing declaration · inline style · **Tailwind class** ·
**new declaration** · **new `@font-face`**. **Invariant: anything the picker
offers must be reachable by one of them** — otherwise it is listed read-only
with its origin file.

**Sequencing note:** the scanner work (`@theme` descent, T6 gaps, T12
reconciliation) needs **nothing** from Track B and can start immediately. Only
the create-a-token half blocks on B1.

---

## 12. TRACK A — The agent fidelity loop (M) — fully independent

Runs in parallel from day one. Needs nothing from any other track.

### A1 — Page-scope chat-pasted references (M) — **the flagship bug**

`turnDesignReferences.ts:78-97` registers every pasted image with **no
`pageId`**; `chat.ts:306-308` is the only call site and never threads one.
`resolveDesignReference` (`referenceResolve.ts:34-59`) falls back
*explicit id → this page's own → most recent project-wide*. Since a pasted
reference is never scoped, it **can never win the "this page's own" branch**.

**Consequence:** paste a second Figma frame anywhere in the conversation, and
every subsequent comparison for screen 1 silently measures against screen 2's
design. That is the literal flagship workflow — *paste several frames, build
several screens* — failing silently.

**Fix.** Thread the turn's live active-page id (already available in the digest
snapshot built earlier in the same request) into `registerTurnDesignReferences`
as an optional `pageId`. Add an explicit trap entry to the system prompt's
"Common failures to avoid" — the only WRONG/RIGHT example today
(`systemPrompt.ts:194-197`) covers the Figma-connector download path, not the
ordinary paste.

### A2 — Exact-pixel diffing survives tall screens (S doc / M real)

`renderEvidence.ts:412-421` clamps `pixelRatio` by **both** width and height
against `MAX_IMAGE_EDGE = 1568`. Any frame taller than ~784 CSS px at 2× drops
into `frameDiffEngine.ts:105-137`'s `resampled` branch (`fit: 'fill'`) — so the
"exact-pixel" comparison the measurement pipeline is built around becomes
interpolated for **most real mobile screens**. Disclosed via
`capture.dimensionMatch` but never flagged proactively, and
`studio_recommend_export_dpr` warns only about the width side (`:264`).

**Fix.** Short term: name the height clamp in the tool's description/output.
Real fix: region-scoped compare (crop to a viewport-height slice) so exactness
survives scroll-unrolled content.

### A3 — Reference-free quality signals (M)

`compare.ts` and `measureReference.ts` **both require a registered reference**.
On a from-scratch brief the only signal is `studio_screenshot` plus subjective
judgement. Build reference-free passes: contrast audit (reuse `colorMath.ts`'s
`contrastRatio`), token-adherence (declared scale vs one-off values), spacing
rhythm. No new infrastructure needed.

### A4 — Payload economics (S)

`compare.ts:238-242` returns **three full images** (capture, reference, diff)
on every call, and the prescribed loop calls it after *every* fix pass
(`systemPrompt.ts:135`). Add `includeImages?: boolean` (default `true`) so
later-loop calls can take the numeric verdict + regions only.

### A5 — Design-system knowledge (M)

The generated `CLAUDE.md` guide is **hardcoded to `ALM_PACKAGE`**
(`projectGuide.ts:308-312`). A generic imported design system gets no decision
map and no prop reference. Drive it from E1's catalog. Also mention
`studio_list_components`, which is in the toolset but never referenced in the guide.

### A6 — Re-arm the orphaned self-check (S)

`checkCanonicalJsx` is wired **only** into `studio_read_file`, which is
deliberately excluded from the agent's toolset in favour of native `Read`
(`agentToolNames.ts:19-24`). So **nothing** catches an agent-authored page
reintroducing inline styles, hardcoded colours, or fixed widths. Re-attach it to
the write path (post-`Write`/`Edit` hook or a `studio_screenshot` precondition).

### A7 — Figma Dev Mode discoverability (M, `panel-designer`)

The best-accuracy path (exact tokens, real vectors) needs **three** non-default
steps to all be true: the project declares the server in `.mcp.json`; the user
approves it by name (`approvedMcpServers`); and the operator sets
`STUDIO_ALLOW_LOOPBACK_ASSET_FETCH=1` because Dev Mode binds to loopback and the
SSRF guard blocks it otherwise (`remoteAssetFetch.ts:207-238`). The gating is
**correct and deliberate** — the gap is discoverability. Detect "no Figma MCP
server approved" and offer a guided setup, so the accuracy gap is visible rather
than silent.

### A8 — Font-size measurement caveat (S)

`referenceMeasure.ts:120-123` hardcodes `CAP_HEIGHT_RATIO = 0.72` /
`ASCENDER_SPAN_RATIO = 0.95`, calibrated for Latin UI sans. Silently wrong for
serif/display faces and non-Latin scripts — **notably Arabic, which Studio
explicitly supports via its RTL preview axis**. Surface a `caveat` on
`fontSizePx` rather than a bare confident range.

---

## 13. Collision map — read before dispatching a parallel wave

`standing-05`'s protocol applies: each agent's new routes live in their **own**
file exporting a `tryServeStudio*` sub-router; agents write handoffs to a scratch
file and the orchestrator merges `STATE.md` **once**, after the wave lands.

### Single-file collision points

| File | Wanted by | Rule |
|---|---|---|
| `STATE.md` | every agent | Scratch file per agent; orchestrator merges once |
| `server/handlers/studio.ts` (route table) | B1, E1, E3, C5 | Sub-router per agent; orchestrator composes `STUDIO_SUB_ROUTERS` |
| `server/handlers/studioWriteback.ts` (`StudioEditSchema`) | **B1 (`insert`), B2 (`class`), E2.4 (`insert-slot`, `promote-component`)** | **Serialize.** Land B1's schema change first, then B2, then E2.4. Three agents editing one discriminated union will conflict |
| `src/admin/pages/site/store/store.ts` | C1, C2 | Same agent, one commit |
| `src/core/page-tree/sourceStructure.ts` | E2.1 (lift `refusePlacement`), D2 (`previewStructuralMove`), F2 | **Serialize:** E2.1 → D2 → F2. All three extract from the same predicate |
| `PropertiesPanel/StyleSectionsEditor.tsx` | F1, G | **F before G** — don't shrink a panel whose contents are changing |
| `PropertiesPanel/` (other files) | F2, G, E2.5 | Splittable: F2 owns notices/constraints, G owns rows/sections, E2.5 owns the Component section |
| `src/core/page-parser/parsePageFile.ts` | E2.3 only | Single owner |
| `server/handlers/studio/packageManifest.ts` | E1 only (extract to `componentSpecExtract.ts`) | Single owner; K3 lands inside it |
| `canvasDnd.ts` / `useCanvasReorderDrag.ts` | Phase 0.8, D2 | 0.8 is a barrier item; D2 starts after |

### Safe concurrent sets (verified disjoint)

- **Wave 1 (Phase 0):** `store-engineer` ∥ `panel-designer` ∥ `canvas-engineer` ∥ `mcp-tooling`
- **Wave 2 (Band 1):** B1 ∥ C ∥ E1 ∥ D1 ∥ A1-A4
- **Wave 3 (Band 2):** B2 ∥ C5 ∥ E2.1 ∥ D2 ∥ H-scanner ∥ A5-A8
- **Wave 4 (Band 3):** F ∥ D3 ∥ H-write ∥ E3/E4 — then G last

---

## 14. Verification

Per `standing-02`, verification splits by whether the DOM can answer the question:

| Track | Method |
|---|---|
| B, C(save), E, F, H, A | **Static gates only** — `bun run build`, `bun test <suites>`, `bun run lint` |
| D (rulers, DnD, geometry), C(render perf) | **Real browser pass** (Playwright), asserting on *computed layout* — measured rects, `scrollHeight`, computed styles |
| G (panel density) | **Human dogfood** — it is a feel judgement |

**`standing-08`:** never type-check with `npx tsc` — it silently resolves 5.9.3
against this repo's pinned 6.0.3 and invents ~100-200 phantom errors. Use
`bun run build` or `./node_modules/.bin/tsc`.

**`standing-01`:** the full suite runs in ~300 s: **7618 pass / 34 fail / 1 skip**.
The 34 are pre-existing (Windows path gates, plugin QuickJS/worker suites,
parallel-agent in-flight work). Diff against that list; anything else is yours.

**The acceptance bar (`standing-authorization`, unchanged and load-bearing):**

> Unit tests here verify *functions*. They structurally cannot verify
> *interactions* — happy-dom has no layout engine and no real input pipeline.
> Three features have shipped "green" and unusable. **A feature is done when a
> browser pass drives real input against `studio-workspace/maherfayad-stack-eSIM`
> and shows the user-visible result.** A truthful "this does not work" outranks a
> passing test.

### New architecture gates to add

| Gate | Asserts |
|---|---|
| `no-silent-edit-drop.test.ts` | Every store mutation that can be refused either emits an edit or raises a typed constraint — **the §2 invariant, mechanized** |
| `single-drag-mechanism.test.ts` | No `@dnd-kit` imports outside the (eventually removed) allowlist |
| `no-cms-imports-in-studio.test.ts` | Studio surfaces don't import `@core/persistence/cms*` (would have caught the fonts defect) |
| `token-offered-is-reachable.test.ts` | Every token the picker lists resolves to a real property in project CSS |
| `studio-edit-kinds-exhaustive.test.ts` | Every `StudioEditSchema` kind has a codemod and a refusal path |

### Integration-gap protocol (the recurring failure mode here)

`STATE.md` records three shipped defects where **both** halves were individually
correct and fully tested, with nothing connecting them (ingest never called the
probe; `resolveModuleId` hardcoded `alm.<Name>`; install `cwd` was the wrong
directory). Unit tests could not see any of them.

> **When you finish a work order, name the consumer of what you built and verify
> it is actually called.** A feature nothing invokes is not shipped.

Highest-risk integration seams in *this* plan: B1's insert ↔ the panel's create-
class button · E1's catalog ↔ swap picker / prop controls / A5's guide ·
B2's `class` kind ↔ `classIds` delta detection · D1's `transformRef` ↔ rulers and D2.

---

## 15. Open decisions — need a human call

1. **Grant `studio.run.project` to Admin?** Today the only tool that validates
   against the *actually-executing* app is unreachable for every real operator
   (Phase 0.11 makes the prompt honest either way). Granting it enables true
   ground-truth verification; it also means executing the user's project code.
   *Recommendation: grant it behind the existing per-project Tier-2 trust
   promotion — the consent gate already exists and this is exactly its purpose.*

2. **Should a new project still be force-seeded with `@alm-design`?**
   `projectSeed.ts:112-165` copies it into every new project from Studio's own
   `node_modules`. It exists because a truly empty project made the agent
   hallucinate. *Recommendation: make it an explicit launcher choice ("Start
   blank" / "Start with ALM"), once Track B makes blank viable. Not before.*

3. **Free-form absolute positioning on the canvas?** Every insert is DOM-flow
   relative to a sibling; Figma-style pixel-anywhere placement conflicts with
   trap #1 (the canvas DOM must be the DOM React renders). *Recommendation: no.
   Ship `position:absolute` as a real, writable property via Track B instead —
   that covers the genuine use cases (badges, overlays) without breaking the
   invariant.*

4. **Compact spacing/border rows: replace the diagrams, or keep them behind
   "Advanced"?** A product-feel call a static audit cannot settle.
   *Recommendation: compact by default, diagram behind a toggle — reversible if
   dogfooding disagrees.*

5. **How far to take Tailwind?** B2 makes `className` edits possible, which is
   the correct write target for most real repos. Full Tailwind-aware UI (utility
   autocomplete, arbitrary-value syntax, variant prefixes) is its own sub-plan.
   *Recommendation: ship the class-edit target in B2; defer the Tailwind-native
   UI until a real Tailwind corpus is on the board.*

6. **Image generation for creative-from-scratch?** No image-gen driver exists
   anywhere under `server/ai/`; imagery is fetch-a-URL or crop-a-reference only.
   *Recommendation: out of scope for this plan — a real ceiling on "invent a
   design", but not a defect in this repo's architecture.*

---

## 16. Appendix — full audit index

Raw findings, with full `file:line` evidence, are committed at
[`docs/audits/2026-08-06/`](docs/audits/2026-08-06/) — ~5,700 lines total.
**Read the relevant one before starting a track**; it is the reason this plan
can be executed without re-deriving anything.

| File | Area | Findings |
|---|---|---|
| `01-figma-fidelity.md` | Figma 1:1 loop | F1–F8 |
| `02-design-system-authoring.md` | Building a page with the DS | D1–D10 |
| `03-creative-from-scratch.md` | Creative design | C1–C9 |
| `04-canvas-rulers-figma-feel.md` | Rulers + de-Studio-ify | V1–V10 + rulers spec |
| `05-canvas-performance.md` | Render perf | P1–P3 + verified-clean list |
| `06-editing-performance-store.md` | Edit latency + store | E1–E10 |
| `07-drag-and-drop.md` | DnD | G1–G18 + unified architecture |
| `08-properties-panel-design.md` | Panel density | Q1–Q10 + target spec |
| `09-refusal-states.md` | Refusals | R1–R8 + 30-row taxonomy + UX spec |
| `10-classes-vs-inline-styles.md` | Styling model | S1–S15 + 18-row capability matrix |
| `11-colors-and-fonts.md` | Tokens | T1–T12 + 7-model map + unified spec |
| `12-components-and-slots.md` | Components | K1–K13 + page-as-component design |

### Method note

Twelve agents, each given a disjoint brief and instructed to read actual code
rather than documentation, and to report `file:line` evidence plus a
cross-area dependency field. That dependency field is what §3's parallelism map
is computed from — it is not a guess.

Four agents were also explicitly told to *verify* claims in `PROJECT-BRIEF.md`
and `STATE.md` rather than accept them. That is where §1's six corrections came
from, and it changed the plan materially: three areas assumed to need building
turned out to need only wiring, and one assumed-fixed perf defect turned out to
have a worse, undiagnosed sibling.
