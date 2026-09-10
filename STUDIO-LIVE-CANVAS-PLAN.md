# Studio Live Canvas + Penpot Inspector — plan

**Status:** proposed, nothing started · **Opened:** 2026-09-08 · **Owner:** main session (orchestrator)

Three tracks, one goal: the board behaves like the real app, every edit lands
in the repo, the download runs, and the inspector is one a Figma or Penpot user
already knows how to use.

| Track | What it delivers | Size |
|---|---|---|
| **L — Live runtime frames** | At Tier 2 a frame is the project's own dev server, with the editor overlaid. Typing, auto-advance, navigation, hover, JS animation all behave as in the app. | XL |
| **R — Refusals become choices** | Every "refused" toast becomes a dialog offering the honest targets that already exist as verbs (detach, extract a copy, edit the component). | M |
| **P — Penpot-exact inspector** | The properties panel is restructured for speed of use (one paradigm, most-used first, preview-then-commit, one selection model) and re-skinned to a measured Penpot baseline, section by section, keeping token autocomplete, provenance and honest refusal. | L |

The ask this answers, verbatim from the user: *"I want it to be same as figma
… really no errors, and speed … while also being able to click download and it
works, not some element exist only in canvas."* And on the panel: *"the
properties panel … act as figma it's not familiar, can't we redesign it
completely using penpot exactly?"*

---

## 0. What is already true, and must not be rebuilt

- **The download already runs.** `ensurePrototypeShell` writes `index.html`,
  `vite.config.js`, `prototype/registry.generated.jsx` (every screen by key)
  and a Player that follows `.studio/prototype.json` links. Track L builds on
  this shell rather than inventing a second harness.
- **Studio already boots the project's dev server.** The MCP tool
  `studio_render_reference` (`server/ai/mcp/tools/studio/referenceRender.ts`)
  spawns `scripts.dev` in a capped subprocess, discovers the printed URL, reuses
  the process and tears it down on idle. L1 extracts it; it does not rewrite it.
- **Node ids are source locations** (`relFile:line:col`, `sourceNodeId.ts`).
  A compile-time plugin can stamp the same id the parser mints, so the live DOM
  maps back to the tree with no new id scheme.
- **Trust tiers exist and are consented.** `trustTier.ts` reads/writes
  `static | render-packages | run-project`; promotion is a click. Track L is
  the first thing that makes Tier 2 mean something different from Tier 1.
- **Posters and virtualization exist.** `frameSnapshotCache.ts` /
  `useFramePosterCapture.ts` already swap an offscreen frame's body for an
  image. Live frames plug into the same cache.
- **Detach, extract-a-copy and swap exist** as real codemods
  (`detachComponent.ts`, `extractComponentCopy.ts`). Track R exposes them at
  the moment of refusal; it writes no new codemod for the common cases.
- **The inspector's field model is worth keeping** — `docs/features/inspector-disclosure.md`
  §5 (prefill from what renders, coerce on commit, one scrub engine, arithmetic,
  Mixed). Track P keeps the model and replaces the chrome and the sections.

---

## 1. The decisions

### 1.1 Live frames run on a **separate origin**, driven by an **in-frame runtime bridge**

Considered and rejected:

- *Same-origin proxy* (`/__live/<project>/…` under the admin origin). Simplest,
  keeps all 39 canvas files that touch `targetDocument` working unchanged. Rejected
  because the user's code, and every dependency it imports, would then run with
  the admin session cookie and could call `/admin/api/*` as the user. Tier 2 is
  consent to *run* the project, not consent to hand it the account.
- *Sandboxed iframe without `allow-same-origin`.* Opaque origin, so the parent
  loses DOM access anyway. Same cost as cross-origin with none of the control.

So: Studio's server opens a second listener (`LIVE_ORIGIN`, default a second
port on the same host) that proxies `/p/<projectKey>/*` to that project's dev
server. The iframe is cross-origin by construction. Everything the editor
needs from inside the frame is done by a small Studio runtime module that the
Vite plugin injects, talking to the parent over `postMessage` with
TypeBox-validated messages both ways.

This is the load-bearing decision. It forces L5 — an adapter boundary between
the editor and "the frame's document" — which is the largest single refactor in
the plan and the reason Track L is XL rather than L.

### 1.2 Tier 0 stays. Tier 2 is a per-project mode, not a replacement

A fresh import is still `static`: parsed, never executed, rendered by the
editor's React. That path is the safe default and the only one available for
a project whose toolchain the plugin does not yet support. Both render paths
share one tree, one store, one writeback, one inspector. The *only* thing that
differs is which `FrameDocumentAdapter` a frame mounts.

### 1.3 Vite first

The plugin is a Vite plugin and the shell already scaffolds Vite. Next and CRA
projects stay at Tier 0/1 until a Babel adapter lands (a follow-up, not this
plan). `referenceRender.ts`'s "spawn the script unchanged, parse the URL it
prints" posture is kept, so a Vite project with a custom config still works.

### 1.4 The inspector is rebuilt to a **measured** Penpot baseline

Penpot is MPL-2.0. Copying its layout, section order, geometry and interaction
model is permitted; none of its ClojureScript is copied; Penpot's name and logo
are not used in the product. Penpot is chosen over Figma because its model is
CSS-native (flex and grid layout, radius, fill/stroke/shadow/blur map 1:1 to
properties Studio can honestly write), so the "cannot translate" list in
`inspector-disclosure.md` §7 nearly vanishes.

Nothing in Track P starts before P0's baseline exists. The previous inspector
pass wrote budgets and never measured them (§6 is still "not implemented");
that is why the panel feels unfamiliar today, and it is the one mistake this
plan refuses to repeat.

---

## 2. Track L — Live runtime frames

### L1 — Dev server manager (S/M) · `server-engineer`

Extract the process half of `referenceRender.ts` into
`server/handlers/studio/devServer.ts`:

- `ensureDevServer(dir)` → `{ url, pid, startedAt }`; one per project, reused,
  idle timeout kept. Spawn through `subprocessRunner.ts` with
  `minimalSubprocessEnv()`, stdout/stderr capped, as today.
- **Gate: `trust === 'run-project'`.** Refuse with `code: 'trust-tier-required'`
  in the same 409 shape `deploy.ts` uses. This is the first gate that reads
  Tier 2 specifically — update `trustTier.ts`'s doc, `PROJECT-BRIEF.md` §2
  invariant 1, `CLAUDE.md` invariant 1 and `glossary.md` in the same PR.
- Routes: `GET /admin/api/studio/dev-server/status?dir`, `POST …/start`,
  `POST …/stop`. Status carries `phase: 'stopped' | 'booting' | 'ready' | 'failed'`
  and the capped log tail so the frame can show why a boot failed.
- `referenceRender.ts` becomes a consumer of this module. No second spawner.
- **Prewarm:** the launcher calls `start` when a Tier 2 project is opened
  (`studioWorkspaceDir.ts`'s selection change), before the board mounts.

### L2 — The live origin (S/M) · `server-engineer` + `security-guard`

- `server/liveOrigin.ts`: a second `Bun.serve` on `LIVE_PORT` (config in
  `server/config.ts`, documented in `docs/deployment/`). Routes
  `/p/<projectKey>/*` → the project's dev server (HTTP + WebSocket for HMR).
  Refuses any project not `ready` in L1.
- No cookies are set or read on this origin. CSP forbids framing by anything
  but `PUBLIC_ORIGIN`. `postMessage` origin checks on both ends.
- Memory note for the tunnel case: `PUBLIC_ORIGIN` and `LIVE_ORIGIN` are two
  URLs now; the tunnel doc (`docs/deployment/`) gains the second one.

### L3 — The Vite plugin: ids and the runtime entry (M) · `parser-surgeon`

`src/core/studio-runtime/vitePlugin.ts`, shipped into the workspace by the
shell generator as a dependency of `vite.config.js` (hash-tracked, so an
untouched config picks it up on next open; an edited one is documented).

- Stamps `data-node-id` on every JSX element with **the same id the parser
  mints**. Share the builder from `sourceNodeId.ts`; a gate test parses the
  fixture corpus with ts-morph and with the plugin and asserts identical id
  sets (`src/__tests__/studio-runtime/idParity.test.ts`).
- Injects `virtual:studio-runtime` into the entry so L4 boots with the app.
- **Two id shapes need a resolver, not a hack.** Inlined components: the parser
  mints composite `callSite~component` ids, the DOM carries the component's own
  `components/X.tsx:l:c`. `.map` rows: the DOM repeats one id, the parser mints
  `…#n`. `liveNodeResolve.ts` maps a DOM element to a tree node by walking up
  to the nearest stamped ancestor with a call-site id and by sibling index
  among same-id siblings. Selection of anything unmapped resolves to that
  ancestor and says so in the badge.

### L4 — The in-frame runtime (M/L) · `canvas-engineer`

`src/core/studio-runtime/runtime.ts`, built to one ESM file served from the
live origin. It is the in-frame half of every injector, driven by messages:

| Command from parent | Effect in frame |
|---|---|
| `applyOverlay(id, css)` / `removeOverlay(id)` | the stylesheet an injector used to append to `<head>` (`EditorChrome`, `ClassStyle`, `CanvasAnimation`, `ScrollUnroll`, `HoverSuppression`, selection ring CSS) |
| `select(nodeIds)` / `hover(nodeId)` | sets the `data-*` attributes the ring CSS keys on — rings stay in-frame, same coordinate space, no zoom drift (keeps `canvas-07`'s fix) |
| `measure(nodeIds)` | rects + computed style for the inspector's prefill |
| `setAxes({dir, colorScheme, locale})` | the `applyPreviewAxesToFrameDocument` effect, in-frame |
| `optimistic.insert/delete/move/text` | mutate the live DOM by node id now; HMR reconciles when the write lands |

| Event to parent | Carries |
|---|---|
| `ready` / `hmr:before` / `hmr:after` | so the parent can hold selection and re-measure |
| `pointer` (down/move/up/click) | node id, rect, modifiers — feeds `canvasDnd`, marquee, the Player |
| `text:edit` | inline text edits, routed to the existing `textOrigin` writeback |

**State across HMR** (`hmrState.ts`): on `vite:beforeUpdate` snapshot, by node
id, every input/textarea/select value, checked state, scroll offsets, focused
element and `open` dialogs; restore on `vite:afterUpdate`. Style-only edits
never remount (CSS module HMR is a stylesheet swap); component edits keep hook
state through Fast Refresh. What still resets: state a component derives from a
fetch or a timer. Documented, not hidden.

### L5 — `FrameDocumentAdapter` (L, run alone) · `canvas-engineer`

The refactor everything else waits on. 39 files under
`src/admin/pages/site/canvas/` (46 under `site/`) reach into an iframe
`Document` directly. Replace that with one interface:

```ts
interface FrameDocumentAdapter {
  applyOverlay(id: string, css: string): void
  removeOverlay(id: string): void
  select(ids: string[]): void; hover(id: string | null): void
  measure(ids: string[]): Promise<NodeMeasurement[]>
  setAxes(axes: PreviewAxes): void
  optimistic: OptimisticDomOps
  on(event, handler): Unsubscribe
}
```

- `PortalFrameAdapter` — today's behaviour, direct DOM, for Tier 0 frames.
- `BridgeFrameAdapter` — `postMessage` to L4, for live frames.
- `IframeFrameSurface` takes `mode: 'portal' | 'live'`; `live` sets `src` to
  `<LIVE_ORIGIN>/p/<key>/__screen/<pageKey>?…` and mounts no portal.
- Every injector becomes an adapter consumer. **No injector keeps a
  `targetDocument` prop.** Choose A: the portal adapter is the only place that
  still holds a `Document`.
- `InPlaceInspector`, the selection toolbar and `BreakpointSelectionOverlay`
  already live in the parent and read the `--selection-anchor-*` channel; that
  channel is now fed by `measure` results in live mode.

No other canvas work runs in parallel with L5.

### L6 — Per-screen routes in the shell (S) · `server-engineer`

`prototype/App.jsx` (generated, hash-tracked) serves
`/__screen/<key>?dir=&theme=&lang=` for every entry in
`registry.generated.jsx`, rendering that screen inside `ScreenFrame` with the
project's providers (`providers.generated.jsx`). This is what makes *every*
page addressable in the real runtime — the problem `referenceRender.ts`
documents as "route, not pageId" — and it costs nothing at download time.

### L7 — Save → HMR loop (S/M) · `store-engineer`

- Writeback is unchanged: codemods write the file, Vite sees it.
- The "reload only when a write landed" rule (`PROJECT-BRIEF.md` trap 5) holds.
  In live mode a *style* write triggers no reload at all; a *structural* write
  re-parses the tree (real ids) but never remounts the frame.
- Optimistic DOM ops (L4) run first for insert/delete/move/text so a gesture
  paints on the same tick, exactly as the portal path does today.

### L8 — Warm, posters, pool (S) · `perf-hunter`

- Until `ready`, a live frame shows its poster or the Tier 0 render, then swaps.
- Live iframes are pooled: viewport frames plus a small LRU (default 8), the
  rest posters. Reuses `frameSnapshotCache`.
- Budgets, added to `bun run bench` and gated:

| Metric | Budget |
|---|---|
| Warm reopen → first live paint | ≤ 1.5 s |
| `applyOverlay` visible | ≤ 16 ms |
| Save → HMR reflected in frame | ≤ 400 ms |
| Memory per live frame | baseline recorded in `docs/audits/`, regression gate at +20 % |

### L9 — What Tier 2 makes redundant (S, last)

At Tier 2 the dev server serves package components, so
`PackageComponentPlaceholder` never shows and `componentBundle.ts` is not
needed for rendering. Tier 1 keeps both. Delete nothing until L5 has shipped
and a Tier 2 board has been dogfooded; then remove the Tier 2 branches that
still call the bundle.

**Track L exit:** the SMS screen in `test4 copy` at Tier 2 — type six digits,
each box advances, the last navigates to `/onboarding` inside the frame; select
a box, change its border in the inspector, watch it update without a remount
and land in `SMS.module.css`; download the zip, `npm i && npm run dev`, same
behaviour.

---

## 3. Track R — Refusals become choices

### R1 — Remedies on the reason (S/M) · `parser-surgeon`

In `src/core/page-tree/sourceStructure.ts`, every `StructuralRefusalReason`
maps to `RefusalRemedy[]`:

| Reason | Remedies |
|---|---|
| `shared-component` | **Edit the component** (select it in its own frame, or open the file) · **Detach here, then apply** · **Extract a copy** |
| `list-row` | **Edit the template** (select the `.map` source row) |
| `cross-file` | **Open the target file** · (move-into-file codemod: follow-up, listed, not promised) |
| `code-placed` / `route-chrome` | **Open source** at the line |
| `multi-select`, `no-sibling-anchor`, `insert` | none — reason text only |

Gate: a test asserts every reason has remedies or an explicit `none`.

### R2 — `RefusalDialog` (M) · `store-engineer` + `panel-designer`

Replaces the toast for any refusal that has remedies. Built from `src/ui`
primitives. Each remedy is a button that runs the existing action
(`detachComponent`, `extractComponentCopy`, selection jump, open-source) and
then **re-applies the original gesture** — the user asked to delete; after
detach, the delete happens. Non-actionable refusals keep the toast.

### R3 — Inspector refusals (S) · `panel-designer`

Popover refusal copy gains the same remedy buttons. Lands with P2, section by
section.

---

## 4. Track P — Penpot-exact inspector: structure, speed, then sections

### 4.0 Why the panel feels slow to use today

Measured against the current tree, not remembered:

- **Three editing paradigms share one scroll.** `StyleSurface.tsx` stacks a
  *Module settings* accordion (CMS heritage), then an *Element (inline)* and a
  *Class* composer drawn as CSS property rows (`ClassPropertyRow.tsx`, a
  Webflow-style list), then the Figma-style sections. A designer has to know
  which of the three a value lives in before they can change it.
- **Chrome that costs a click or a glance and buys nothing.** A sticky search
  bar and a sticky icon rail (`StyleCategoryRail`) frame the column. Neither
  Figma nor Penpot has either; both put the most-used fields at the top instead.
- **The write target is a mode.** `ClassPicker` sets the "active class" and the
  fields below then edit *that*; inline editing is another state. Choosing
  where an edit lands is asked of the user before the edit, every time.
- **Weight.** 86 files and ~29 k lines across `panels/PropertiesPanel/` and
  `property-controls/`, 133 direct `useEditorStore(` subscriptions, 25
  distinct commit call sites. `usePropertiesPanelData.ts` subscribes to the
  whole `site` object (line 27 area), so the panel re-renders on every
  keystroke anywhere in the document, and `buildClassTokenUsageMap` rebuilds
  in the render body.
- **Nothing was ever measured.** `inspector-disclosure.md` §6's gate is still
  "not implemented"; the budgets it lists were never asserted.

The result is a panel you *read* rather than *operate*. Track P fixes the
structure first (P1, P2, P4), then re-skins the sections (P3), because a
Penpot-looking panel over the current structure would still be slow to use.

### P0 — Baseline (S, first) · `panel-designer` with `/browse`

Run Penpot (self-hosted via its docker compose, version pinned in the audit)
and record, for four fixtures — rectangle, text layer, flex board, image:

- Full-panel screenshots for Design, Prototype and Inspect tabs, light and dark.
- Section order, each section's rest height, header height, field widths, icon
  size, row gap, label type size, colours (mapped to `globals.css` tokens; add
  tokens where none match).
- **Operating behaviours, timed:** clicks from selection to the most common
  edits (resize, pad, colour, font size, align), Tab order across fields, what
  Enter/Esc/arrows do, scrub feel, Mixed, token/variable pickers,
  add-property affordances, collapsed-empty rules.

Written to `docs/audits/penpot-inspector-baseline/` with the numbers in a
table the P6 gate reads. **Nothing else in P starts until this exists.**

### P1 — One paradigm: the shell (M) · `panel-designer`

New folder `src/admin/pages/site/inspector/`:

- Three tabs: **Design · Prototype · Inspect**. Design is the only editing
  surface. Prototype hosts the existing prototype inspector. Inspect is
  read-only: provenance, the winning rule, the computed CSS, the source path,
  copy buttons.
- **Gone:** the module-settings accordion, the inline/class composers as
  property lists, the search bar, the icon rail. Module props that are real
  call-site props (`InstanceCallSiteView`) become an ordinary section named
  after the component, in the same field vocabulary.
- **The write target is a rule, not a mode.** One row under the layer name
  shows the element's selectors as chips (`.card` `.primary` `style=`). Every
  field below shows the *effective* value with a provenance mark. A commit
  lands by one rule: the most specific writable source that already sets this
  property; otherwise the element's own class if it has exactly one editable
  class; otherwise inline. The field's menu can override the target for that
  one edit. This is Studio's only structural difference from Penpot and it
  costs one row.
- Section chrome to the measured geometry; field primitives: numeric with
  scrub + unit + arithmetic + token autocomplete (`TokenAwareInput` kept),
  select, colour row, icon toggle group, 3×3 pad. `--inspector-*` tokens
  replaced by the measured set.

The old `PropertiesPanel` keeps rendering sections that have not moved yet,
inside the new shell, for the duration of P3 only.

### P2 — Structured for speed: the operating rules (S, lands with P1) · `panel-designer`

Rules the shell enforces, each with a test where one is possible:

1. **Most-used first, fixed order.** Layer name → align row → Measures →
   Layout → Fill → Stroke → Text… Penpot's order is frequency-of-use order;
   nothing reorders by context.
2. **Everything is at rest.** No accordion to open. An empty section is one
   32 px line with `+`. A text layer's full panel fits 900 px with no scroll.
3. **Rare options live in a popover on the field they modify**, never in a
   separate section or a settings page.
4. **Enum-like values are icon toggle groups**, not selects: flex direction,
   wrap, justify/align, text align, decoration, case. One click, no menu.
5. **Two fields per row** for paired values (W/H, X/Y, gap row/col), unit
   inside the field, label as a one-letter mark that is also the scrub handle.
6. **Keyboard flow.** Tab walks fields in reading order; Enter commits and
   keeps focus; Esc reverts; ↑/↓ nudge 1, Shift 10, Alt 0.1 (exists);
   arithmetic in every numeric field (exists); typing into a field never
   loses a keystroke to a re-render.
7. **Preview, then commit.** A scrub or a typed value previews on every tick
   through the frame overlay (`applyOverlay`, no store write), and commits
   once on release/blur/Enter as **one** history entry. Undo never has to
   walk through a drag.
8. **Selection to painted panel in one frame.** Budget: ≤ 16 ms from the
   selection change to the panel's new values on screen at 10 sections.
9. **Multi-select edits everything.** Mixed shows as *Mixed*; typing sets
   all; §9 of the old doc's contract, kept.
10. **A field never lies.** Prefill from what renders (§5.0), coerce on
    commit (§5.1), refusal as a choice in the field's own popover (R3).

### P3 — Sections in Penpot order (L) · `panel-designer`

One PR per section; each deletes its predecessor.

1. Layer — name, visibility, lock, blend, opacity
2. Align — the row of alignment/distribution icons
3. Measures — W/H/X/Y, rotation, radius, Hug/Fill
4. Layout — flex and grid, Penpot's container-vs-element split
5. Fill
6. Stroke
7. Shadow
8. Blur
9. Text
10. Export
11. Studio extras — Component props (call-site), Attributes, Custom
    properties; Interactions on the Prototype tab

Each keeps token autocomplete, provenance and refusal-as-choice, in Penpot's
visual language rather than bolted on.

### P4 — Architected for speed (M) · `store-engineer` + `panel-designer`

What makes rule 7 and rule 8 true:

- **One `SelectionModel`.** A single store selector derives everything the
  panel needs for the current selection — node, effective style per property
  with provenance, writable targets, Mixed flags — memoised on
  `(selectedNodeIds, the nodes' own references, styleRules)`, never on `site`
  identity. Sections read from it; the 133 subscriptions become one per
  section at most. Gate: `no-full-site-scan-in-selectors.test.ts` extended to
  flag `s.site` whole-object subscriptions under `inspector/`.
- **A section manifest.** `sections/index.ts` lists
  `{ id, order, appliesTo(selection), Component }`; order and applicability
  are data, the shell mounts only sections that apply, lazily.
- **One commit API.** `commitStyle(prop, value, { preview?, target? })` and
  `commitProp(key, value)` route to inline / class / token / call-site by the
  P1 rule, coalesce under one history key per gesture, and are the only
  writers a section may call. The 25 ad-hoc commit paths are deleted.
- **Preview channel.** `preview: true` goes to the frame adapter's overlay
  (portal or bridge), never the store; the final commit clears it.
- Budgets added to `bun run bench`: selection→paint ≤ 16 ms; scrub tick ≤ 4 ms
  on the main thread; typing latency ≤ 1 frame.

### P5 — Values from the live DOM (S, after L5) · `panel-designer`

`SelectionModel`'s effective values read through `adapter.measure` at Tier 2;
Tier 0 keeps the registry-computed path. One call site.

### P6 — Delete and gate (S) · `test-engineer`

- `panels/PropertiesPanel/` and `property-controls/` removed — the 86 files.
- `src/__tests__/inspector/measurement.test.ts`: per-section rest heights
  within 4 px of the P0 baseline; the text fixture's full panel fits 900 px
  with no scroll; `scrollWidth === clientWidth` at 260 px for every section;
  the P0 click counts for the common edits matched or beaten.
- `docs/features/inspector-disclosure.md` → `docs/features/inspector.md`,
  rewritten against what shipped.

**Track P exit:** a Penpot user opens a text layer and a flex frame and finds
every control where they expect it, in the same number of clicks as Penpot;
the measurement gate is green; nothing in §7's "we stay better than Figma"
list regressed.

---

## 5. Sequencing and parallelism

```
week 1   P0 baseline ──┐        L1 dev server ─┐
                       │        L2 live origin ─┼─ security review
week 2   P1 shell + P2 rules ┤        L3 plugin ──────┤
                       │        L4 runtime ─────┘
week 3   P3 sections + P4 arch │        L5 adapter  (ALONE — no other canvas work)
week 4   P3 sections…  │        L6 routes · L7 save loop · L8 warm/pool
week 5   P5 live values · P6 gate ┘        L9 cleanup · Track L dogfood
R1 → R2 → R3 run whenever hands are free; they touch nothing L or P touches.
```

Hard edges: P0 before P1 · P1+P2 before any P3 section · P4 before the third
P3 section · L1+L3+L4 before L5 · L5 before L6–L9 and P5. Everything else can overlap. Track L work orders go
through `studio-architect` first; L5 gets its own.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Executing user code | Tier 2 consent click, capped subprocess, minimal env, separate origin, no cookies, CSP; `security-guard` signs off L1/L2/L4 before merge |
| Id parity drifts between parser and plugin | Shared builder + the L3 gate test on the fixture corpus |
| Cross-origin latency makes rings feel late | Rings are drawn in-frame (L4); only measurement crosses the boundary, and it is batched |
| HMR resets what the user typed | L4 `hmrState`; documented residue |
| Boards with many frames | L8 pool + posters; memory budget gated |
| Non-Vite projects feel second-class | Explicit in the promote dialog: "live frames need Vite"; Babel adapter is a named follow-up |
| The inspector rebuild stalls half-migrated | One section per PR, each deletes its predecessor; P6's gate is the finish line |
| A Penpot skin over the old structure | P1/P2/P4 land before the third section; the shell refuses the old composers by construction |

---

## 7. Open decisions for the user

1. **Live origin form.** Second port on the same host (simplest, works with the
   tunnel memory's caveat) or a subdomain (cleaner cookies story, needs DNS).
   Recommendation: second port.
2. **Promote prompt.** Keep promotion strictly manual, or ask once on open for a
   Vite project with a lockfile, the way `StyleCompileConsentBanner` does for
   Tailwind. Recommendation: ask once, default No.
3. **Penpot version** to pin the baseline to. Recommendation: latest stable
   self-hosted at P0 time, recorded in the audit.
4. **Order.** Panel shell first (improves every project this week) then live
   frames, or live frames first. Recommendation: P0+P1 and L1–L4 in parallel,
   then L5 alone.
