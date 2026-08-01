# STUDIO — next workstreams

**Status:** in progress (2026-08-01).
**Companion:** `STUDIO-IMPORT-V2-PLAN.md` — these are new workstreams beyond it.

### Decisions taken (2026-08-01)

Every open-decision list below is now closed. Where a decision changed the
design, the section itself has been rewritten — this table is the log, not the
spec.

| # | Decision | Effect |
|---|---|---|
| **D1** | All four workstreams land as sequential commits on `feat/alm-figma-killer-studio-shell`, one commit per coherent step. Nothing is pushed. | `main` is 21+ commits behind; it is not the trunk here. |
| **D2** | **WS-11 authenticates per user, not per machine.** Each user gets an isolated CLI environment (`CLAUDE_CONFIG_DIR`) and logs in with their own Claude account through a Studio-surfaced OAuth flow. | Replaces the multi-user *gating* in §5.1/§7.2 outright. The machine-owner problem does not get fenced off — it stops existing. See WS-11 §2.1. |
| **D3** | **One agent scope: Studio.** The CMS scopes come out of the application entirely. | Rewrites WS-12 §8.1. No new column — see below. |
| **D4** | Generated subagents live in `<project>/.claude/`, committed. | The agents travel with the user's repo, like any hand-written Claude Code setup. |
| **D5** | Validator reports, never blocks (WS-13 §7.1). `.tsx` is the scaffold default (§7.2). Dark-mode tokens stay single-valued (WS-10 §8.2). Axes persist **per project** (WS-10 §8.3). Agent may *ask* for trust promotion, never perform it (WS-12 §11.2). `studio_create_page` auto-places the frame (§11.3). Bypass mode stays non-persisting, indicated, trust-bound (§11.5). | Taken at the recommended default; recorded here rather than restated per section. |

### Two research findings that changed the plan

**F1 — the scope collapse is nearly free, and needs no migration.**
Recon found `ToolScope` is already `'site' | 'data' | 'plugin'`
(`server/ai/runtime/types.ts:39`) — `'content'` was removed from the code long
ago and survives only as a DB CHECK literal. `'data'` and `'plugin'` return an
**empty tool array** (`server/ai/tools/index.ts:32-37`) and a placeholder system
prompt (`chat.ts:506-511`). There is exactly one live scope, one toolset, one
panel; `src/admin/pages/content/` and `.../data/` do not exist on disk.

So D3 does not collapse four subsystems into one — it deletes two empty reserved
branches and a dead literal, roughly 150–250 lines concentrated in
`DefaultsTab.tsx`'s per-scope grid. **And with a single scope, `scope` stops
being a discriminator at all:** it is removed from the application, from the
route paths, and from the request schemas. The DB column becomes vestigial,
holding a permitted constant to satisfy migration `007_ai_runtime`'s CHECK.
That is strictly better than the plan's original option (a) — adding a column to
store a value that can only ever have one value is waste. **No migration is
needed for this at all.**

**F2 — `CLAUDE_CONFIG_DIR` relocates credentials, not just settings.**
Confirmed in the CLI's own authentication docs: on Linux and Windows,
`.credentials.json` lives under `CLAUDE_CONFIG_DIR` when it is set. That is the
whole mechanism behind D2 — a per-user config directory *is* the "small
environment" per user. macOS is the exception (OS keychain, not relocatable by
env var) and is handled as a documented limitation, not silently.

| | Workstream | Ships as |
|---|---|---|
| **WS-13** | [Canonical JSX — the authoring subset](#ws-13--canonical-jsx) | its own PR — **start here** |
| **WS-10** | [Preview axes — RTL, localization, dark mode](#ws-10--preview-axes) | its own PR |
| **WS-11** | [Canvas chat on Claude subscription login (no API key)](#ws-11--canvas-chat-on-claude-cli-login) | its own PR |
| **WS-12** | [The Studio agent — prompt, harness, subagents, tools](#ws-12--the-studio-agent) | 6 PRs (§10) |

Dependencies: **WS-13 → WS-12** (the agent authors in the canonical subset, which
is what makes screen-building tractable) and **WS-11 → WS-12** (WS-11 decides who
owns the agent loop, which sets how much of WS-12 exists at all — WS-12 §2).
WS-10 is independent of all three.

Each lands as its own PR — `CLAUDE.md`'s scope rule ("create a separate PR when
the change has a different reason").

### A standing decision that reframes all of this

**Studio is no longer optimising for making any one imported corpus render.**
Reading arbitrary third-party React is best-effort and stays best-effort. The
priority is **authoring**: new screens are written in a shape the tool reads
perfectly, and no agent time is spent forcing an existing project's hard cases to
parse. WS-13 is that shape; it is listed first because it is what makes WS-12
worth building.

---

# WS-13 — Canonical JSX

**A documented subset of React that Studio reads perfectly and writes back
losslessly. New screens are authored in it.**

---

## 1. The premise flip

Every limitation in `docs/features/studio-import.md`'s table — branch guessing,
locked props, unresolved `.map`s, spread props, computed `className`s — exists
for one reason: **the parser is reading code somebody else wrote.** It has to
cope with whatever shape it finds, without executing it.

**But when Studio authors a screen, Studio chooses the shape.** There is no
reason to emit code that lands in the parser's hard cases and then fight to
render it.

So there are two paths, and conflating them is what makes screen-building feel
hard:

| | **Import path** | **Authoring path** (this workstream) |
|---|---|---|
| Input | Any React repo | Screens Studio or its agent writes |
| Fidelity | Best-effort; codes report the gaps | **Total** — round-trips losslessly |
| Editability | Per-node, per-prop, often locked | **Every node unlocked, every prop writable** |
| Goal | Understand what's there | Build something new |

The import path keeps working exactly as it does. This workstream is about
making the authoring path *predictable* — which is also the single biggest lever
on the agent's success rate, because an agent that only ever writes canonical JSX
never has to reason about why a node came back locked.

## 2. The subset

Each rule exists because of a specific, documented limitation — none is
arbitrary.

| Rule | Because, without it |
|---|---|
| **One `return`.** No top-level conditional rendering, no multi-stage screens. | `BRANCH_AUTO_SELECTED` — the parser picks one branch and can pick wrong. |
| **Props are literals or module-scope `const`s.** | Tier A resolves those. A prop from hook state or an unresolvable expression becomes `CODE_VALUED_PROP` — read-only. |
| **Text is a literal string in the JSX.** | `textOrigin` writeback needs a literal to target. Text produced by a runtime expression cannot be edited on canvas. |
| **`.map` only over a module-scope `const` array.** | Bounded loop expansion handles those. A `.map` over props/state/fetch collapses to one opaque locked node. |
| **No `{...spread}`.** | `SPREAD_PROPS_UNRESOLVED` — the prop bag is unreadable. |
| **`className` is a static string or `styles.x`.** | A computed interpolation keeps only its static prefix. |
| **One *authored* styling mechanism: plain CSS or CSS Modules.** | Sass/Less/PostCSS/Tailwind need Tier 1 trust promotion; CSS-in-JS is detected but never compiled. **This governs the CSS you write — not CSS a package ships (§2.1).** |
| **Inline `<svg>` is static JSX.** | A dynamic attribute is dropped; SVG built by a transform doesn't resolve at all. |
| **Components are imported directly** — local *or* from an npm package. | Resolution stays traceable through `componentSources.ts`. |
| **No wrapper elements added around content.** | Trap #1 — breaks `%`/flex chains and `>`/`+`/`:nth-child` combinators. |

### 2.1 npm design systems are the best case, not an exception

Nothing in §2 restricts design-system usage. **A design-system call with literal
props is the most canonical JSX there is:**

```jsx
<Button variant="primary" size="large">Book now</Button>
```

Every prop is a literal → Tier A resolves it → every prop is writable, the node
is unlocked, no fidelity code fires. Compared with a hand-rolled `<div>` carrying
a computed `className`, this is strictly better on every axis the subset cares
about. **The canonical subset actively pushes toward design systems.**

Three separate mechanisms are involved, and only one is trust-gated:

| | What | Trust |
|---|---|---|
| **The package's CSS** | A bare-specifier `.css` import resolved against the project's own `node_modules`, injected read-only as `@layer vendor`, ordered *below* the editable `user-authored` layer (WS-2.3) | **Tier 0** — a text scan and a file read |
| **`@alm-design/design-system` components** | Compiled into Studio's own bundle (`src/modules/alm/register.tsx` imports it directly, with a build-time `manifest.generated.json`) | **Tier 0** — works on a fresh import, no promotion |
| **Any *other* npm package's components** | `componentBundle.ts` runs `Bun.build` over the workspace's real code | **Tier 1** — refuses at Tier 0 with `trust-tier-required`, because a package can execute a macro at build time |

So: **ALM works today with no trust promotion.** Another design system needs one
consent click to promote the project, and then works the same way. Either way
their CSS renders at Tier 0.

The `@layer vendor` / `user-authored` split is why the styling rule above says
*authored*: a package's stylesheet lives in a read-only layer beneath yours, so
it never counts as a second styling mechanism. Your CSS Module and ALM's shipped
CSS coexist by design.

**The one genuinely restricted case** is a design-system prop that takes a
runtime value — `<Chip label={t(key)}>`. That prop comes back read-only, same as
anywhere else in the subset. Pass a literal, or a module-scope const.

#### The instance stays linked to the package

Inserting a design-system component writes a **real import** into the user's
source. Each module declares `sourceImport: { specifier, name }`
(`register.tsx:261`), and the insert path emits:

```jsx
import { Button } from '@alm-design/design-system'
…
<Button variant="primary">Book now</Button>
```

There is no generated copy and no inlined markup. **Bump the package version and
every screen using it updates**, because the screens reference it the same way
any hand-written React file would. This is the "no codegen" invariant applied to
components: the repo is the document, and the document imports the package.

The link is also not breakable by accident. `detachComponent` — the Figma
"detach instance" verb — applies to **local** `studio.instance` nodes, i.e.
components whose source lives in the project. A package component has no source
in the workspace to inline, so there is nothing to detach it into.

#### Restyling it — three layers, in order of preference

You cannot edit the package's own CSS from Studio, and that is deliberate: it
lives in `node_modules` and would be erased by the next install. The sanctioned
paths, best first:

1. **Its design tokens.** `tokenExtract.ts` already treats **`vendor-css` as one
   of its three token sources** (alongside `project-css` and `tailwind-theme`),
   so a package's `:root` custom properties are extracted into Studio's own
   framework panel and editable there. For a package that ships a token layer —
   ALM ships `src/tokens/*.css` — this is the real theming surface.
2. **Your own CSS.** The `user-authored` layer is ordered **above**
   `@layer vendor`, so an authored rule overrides a package rule without
   `!important` and without specificity games. This is what the layer split is
   for.
3. **Props.** Anything the component exposes as a variant — the most canonical
   option of the three, and the one the DS-expert agent (WS-12 §7.2) should
   reach for first.

### 2.2 What this costs, stated plainly

**A canonical screen is a static composition.** Interactivity, data fetching, and
conditional states live in the surrounding app or inside components the screen
imports — not in the screen file.

That is a real constraint and it should not be soft-pedalled. It is also the
right one: a design tool's frame *is* a static composition. Figma has no
`useState` either. The screen file is the design; behaviour belongs to the app
around it.

Where a screen genuinely needs a stateful piece, it imports a component that owns
that state. The screen stays canonical; the component is ordinary React and is
rendered as an instance.

## 3. The validator — mostly free

`src/core/page-parser/canonicalCheck.ts` (new): given a `ParsedPage`, report
which rules a file violates, with `file:line:col`.

**This is largely a view over signals that already exist.** The fidelity codes
already detect most of these conditions — `BRANCH_AUTO_SELECTED`,
`CODE_VALUED_PROP`, `SPREAD_PROPS_UNRESOLVED`, `DYNAMIC_CONTENT_UNRESOLVED`. A
canonical file is, almost exactly, **a file with zero fidelity findings**, plus a
few structural checks (single return, styling mechanism, no wrappers).

So the deliverable is a small composition layer plus a rule registry — not a new
analysis engine. Reuse `fidelityCodes.ts`'s registry pattern so a rule, its
message, and its documentation entry cannot drift apart.

**It reports; it does not enforce on import.** Running it against a third-party
repo would produce a wall of findings that mean nothing — that repo was never
trying to be canonical. It runs on **files Studio authored**, and on demand.

## 4. Deliverables

| File | Change |
|---|---|
| `docs/reference/canonical-jsx.md` | **new** — the spec in §2, with a canonical example screen and a non-example per rule |
| `src/core/page-parser/canonicalCheck.ts` | **new** — the rule registry + validator |
| `src/core/page-parser/__tests__/canonicalCheck.test.ts` | **new** — one fixture per rule, positive and negative |
| `server/handlers/studio.ts` (`POST /admin/api/studio/page`) | scaffold canonical by construction |
| `studio-workspace/__canonical-fixture/` | **new** — the small reference project that replaces any real corpus as the verification target (§5) |
| `docs/features/studio-import.md` | link the two paths explicitly — import vs. authoring |

## 5. Verification corpus

**No real project is the target.** A purpose-built fixture — a handful of screens
exercising every rule in §2 plus a deliberate violation of each — is faster,
deterministic, reviewable in a diff, and does not drag a third-party repo's
quirks into the gate.

Real projects remain useful as *import-path* smoke tests. They are not what the
authoring path is measured against, and no agent time goes into making any
particular one of them render.

## 6. Sequencing

| Step | Contents |
|---|---|
| 1 | `docs/reference/canonical-jsx.md` — write the spec first; it is the contract everything else implements |
| 2 | The fixture project |
| 3 | `canonicalCheck.ts` + tests |
| 4 | Canonical scaffolding in `POST /admin/api/studio/page` |

Step 1 genuinely comes first: WS-12's system prompt (§4) quotes this contract,
and `studio_create_page` implements it. Writing the spec settles both.

## 7. Open decisions

Closed (D5).

1. ~~Does the validator block a write?~~ **Report only.** A user hand-editing a
   Studio-authored screen into non-canonical React is making a legitimate
   choice; the tool tells them what they lose, it does not refuse.
2. ~~`.jsx` or `.tsx`?~~ **Match the project's existing convention; `.tsx` when
   there is none.**

---

# WS-10 — Preview axes

**RTL, localization, and dark mode.**
**Scope:** Studio's own feature set — the board gains three render dimensions.

---

## 0. What this is, and what it is not

Today Studio renders a user's React screens in exactly one configuration: LTR,
whichever locale `.studio/meta.json`'s `previewLocale` names (hand-typed), light.
`docs/features/studio-import.md`'s limitation table says so explicitly:

> `—` | Only the `previewLocale` branch renders; the other locale/RTL is not applied.

This plan turns those three into **first-class preview axes** — a named,
switchable, persisted triple that the board renders along:

```ts
type PreviewAxes = {
  direction:   'ltr' | 'rtl'
  locale:      string | undefined      // a key of the project's own dictionary
  colorScheme: 'light' | 'dark'
}
```

**Not in scope:** implementing RTL/i18n/dark mode *inside* a user's project.
For the **import path**, Studio reveals what a project already does; it does not
retrofit i18n into it. A project that already ships `en`/`ar` with a `dir` value
still cannot be *seen* in Arabic RTL on the board today — that gap is the point.
For the **authoring path**, WS-13's canonical screens are static compositions, so
their locale variants come from the same dictionary mechanism, read the same way.

**Not in scope:** Studio's own admin chrome. `src/styles/globals.css` is
unaffected.

---

## 1. The one architectural fact that shapes everything

The three axes are **not the same kind of thing**, and the plan fails if they are
implemented as one uniform switch.

| Axis | When it applies | Cost of changing it |
|---|---|---|
| **Locale** | **Parse time.** `previewLocale` → `preferredKey` → the evaluator picks a dictionary branch (`staticEvalCore.ts:440`). It changes *the text in the tree*. | A **re-parse** of the project. Already reflected in `hashWorkspaceConfig` (`studioPageLoad.ts:571`). |
| **Direction** | **Render time.** A `dir` attribute on the frame's `<html>`. | Free. No re-parse, no remount. |
| **Color scheme** | **Render time.** A class/attribute on `<html>`, plus a transform on the *injected copy* of the project's CSS. | Free. No re-parse. |

Consequence: **direction and color scheme ship first** (Phase 1) because they are
self-contained render-time work. Locale is a load-pipeline change and carries the
only genuinely hard problem in this plan (§4.3).

---

## 2. Phase 1 — Direction (RTL)

### 2.1 Model

- New pure leaf `src/core/studio-board/previewAxes.ts`: the `PreviewAxes` type,
  `DEFAULT_PREVIEW_AXES`, and a TypeBox schema. Dependency-free so the server
  (`studioMeta.ts`), the store, and the canvas can all import it. Exported
  through `src/core/studio-board/index.ts` — barrel rule.
- `canvasSlice.ts` gains `previewAxes: PreviewAxes` + `setPreviewAxes(partial)`.
  It sits next to `canvasView` / `runScripts`, which are the existing
  render-mode fields — same shelf, same lifetime.

### 2.2 Apply

`IframeFrameSurface.tsx` boots each frame from a static `IFRAME_SRC_DOC`
skeleton (line 639). Direction must be settable **without remounting the frame**
— a remount costs ~100–140 ms per frame (`perf-01`), and toggling RTL across a
20-frame board must not pay that.

So: an effect that sets `dir` (and `lang`) on the iframe's
`contentDocument.documentElement` whenever the axis changes.

> **Trap #1 applies.** Do **not** add a wrapper `<div dir="rtl">`. It breaks
> `%`/flex height chains and `>`/`+`/`:nth-child` combinators in the user's CSS.
> The attribute goes on the document element the frame already has.

A node that resolves its own `dir` prop — e.g. `dir={dir}` coming from a language
context, which Tier B already resolves — still wins locally. That is the normal
DOM cascade and is correct. Document it; do not special-case it.

### 2.3 Honesty — the part that makes this a design tool, not a toggle

RTL preview must **not** silently correct the project. A project written with
physical properties (`margin-left`, `left:`, `text-align: left`) *should* look
wrong in RTL, because it is wrong in RTL. That is the finding the user opened
Studio to get.

New fidelity code **`RTL_PHYSICAL_PROPERTY`**: scan the `StyleRule` registry for
physical-direction declarations on nodes rendered inside an RTL frame, and report
them per node. Registered in the fidelity code registry — `fidelityCodes.test.ts`
gates that the code, the registry, and the `studio-import.md` table agree, so all
three land in the same change.

Surfaced in two places: `studio_fidelity_report` (MCP) and the properties panel
alongside the existing `SourceConstraintNotice` treatment.

### 2.4 Files

| File | Change |
|---|---|
| `src/core/studio-board/previewAxes.ts` | **new** — type, default, schema |
| `src/core/studio-board/index.ts` | export the leaf |
| `src/admin/pages/site/store/slices/canvasSlice.ts` | `previewAxes` + setter |
| `src/admin/pages/site/canvas/IframeFrameSurface.tsx` | `dir`/`lang` effect on the frame document element |
| `src/admin/pages/site/toolbar/StudioToolbarActions.tsx` | direction control (§5) |
| `server/ai/mcp/tools/studio/fidelityReport.ts` | `RTL_PHYSICAL_PROPERTY` |
| `src/admin/pages/site/canvas/__tests__/` | `dir` lands on the frame root — query via `iframeCanvasQuery.ts` (trap #10) |

---

## 3. Phase 1 — Dark mode

Two mechanisms exist in real projects and they need different handling. Guessing
one is why this is a probe, not a toggle.

### 3.1 Detect (`ProjectProfile.colorScheme`)

Extend `server/handlers/studio/projectProfileSchema.ts`:

```ts
colorScheme: {
  mechanism: 'media' | 'class' | 'none'
  selector?: string    // '.dark' | '[data-theme="dark"]' — for 'class'
}
```

Detection is purely syntactic (Tier 0 safe, nothing executes):

- **`'class'`** — Tailwind `darkMode: 'class' | 'selector'` read by the existing
  static config reader `tokenExtractTailwind.ts`, **or** a `.dark` /
  `[data-theme=…]` / `[data-scheme=…]` selector present in the loaded CSS.
- **`'media'`** — the CSS contains `@media (prefers-color-scheme: dark)`.
- **`'none'`** — neither. The toolbar control is disabled with that reason
  shown, rather than rendering a toggle that does nothing.

### 3.2 Apply

**`'class'` — trivial.** Set the class or attribute on the frame's `<html>`,
same effect as §2.2. Render-time, free.

**`'media'` — needs a CSS transform, and here is why.**
`prefers-color-scheme` is a *user-preference* media feature. It resolves from the
browser/OS, is not inherited into an iframe as an overridable value, and cannot
be forced per-frame from CSS. (DevTools emulates it over CDP; that is not
available to us in-app.)

So at **injection time only**, rewrite

```css
@media (prefers-color-scheme: dark) { … }
```

into a scoped, unconditional block:

```css
:where(html[data-studio-scheme='dark']) { … }
```

Non-negotiable properties of this transform:

- It operates on the **injected copy** in the iframe. The user's `.css` on disk
  is never touched. (Compare `ProjectCssInjector`'s read-only `@layer vendor`.)
- `:where()` keeps specificity at zero, so the rewrite cannot outrank a
  declaration that the original media query would have lost to.
- It composes with the existing cascade layers (`canvasCssLayers.ts`) — the
  rewritten rules stay in whichever layer they came from.

Also set `color-scheme: dark` on the frame root so UA-rendered surfaces
(scrollbars, form controls, `<input>` defaults) match instead of staying white in
a dark frame.

### 3.3 Explicitly deferred

`.studio/framework.json` (Studio's own extracted token sidecar) is single-valued.
Dark mode makes token extraction two-valued. **Out of scope for V1** — the dark
preview reads the *project's* CSS directly and does not consult the token
sidecar. Note it in the handoff so nobody assumes `tokens-01` covers it.

### 3.4 Files

| File | Change |
|---|---|
| `server/handlers/studio/projectProfileSchema.ts` | `colorScheme` on the profile |
| `server/handlers/studio/projectProbe.ts` | detector; `tokenExtractTailwind.ts` supplies the Tailwind half |
| `src/admin/pages/site/canvas/darkSchemeCssTransform.ts` | **new** — the `prefers-color-scheme` rewrite, pure + unit-testable |
| `src/admin/pages/site/canvas/UserStylesheetInjector.tsx` / `ProjectCssInjector.tsx` | apply the transform when the axis is dark and the mechanism is `'media'` |
| `src/admin/pages/site/canvas/IframeFrameSurface.tsx` | scheme attribute + `color-scheme` on the frame root |

---

## 4. Phase 2 — Localization

### 4.1 Discover the locales (removes the hand-typed string)

`previewLocale` is a free-text field a user edits by hand in JSON. Nothing tells
them which keys are valid.

New `server/handlers/studio/localeProbe.ts` → `ProjectProfile.locales`:

```ts
locales: { keys: string[]; defaultKey?: string; source: string }
```

Detected from, in order: the dictionary object that a `translations[lang]`-style
index reads (exactly the shape Tier B already resolves in `staticEvalCalls.ts`),
then `i18next`/`react-intl` resource maps, then a `locales/*.json` directory.
Purely syntactic — no execution, Tier 0 safe.

### 4.2 Board-global locale switch

The toolbar control is populated from the probe. Choosing a locale writes
through `mergeStudioMeta` → `configHash` changes (it already includes
`preferredKey`) → the project re-parses → the board re-renders in that locale.

The re-parse machinery exists. The work is: the client re-fetch, a visible
"re-parsing…" state, and not blowing away board scroll/selection across it.

### 4.3 Per-frame variants — the same page in `en` and `ar`, light and dark, side by side (REQUIRED)

**This is the requirement, not an optional Phase 3.** A frame carries its own
axis overrides, so one board shows the same screen four ways at once:

```
┌── Checkout · en/ltr/light ──┐  ┌── Checkout · ar/rtl/light ──┐
└─────────────────────────────┘  └─────────────────────────────┘
┌── Checkout · en/ltr/dark  ──┐  ┌── Checkout · ar/rtl/dark  ──┐
└─────────────────────────────┘  └─────────────────────────────┘
```

**Dark mode and direction are free** — render-time, no parse, nothing to key.
Four frames of one page already work today; they just all render identically.

**Locale is the one with a real problem**, and my earlier read of it was too
pessimistic. Restating it correctly:

> A node's id is a source location (`relFile:line:col`) — trap #2. Two locale
> variants of one page parse from the *same file*, so every node id is
> **identical** across the variants.

The instinct is to make the ids unique. **That is the wrong fix.** A node id is a
**write target**, and the two variants genuinely *share* their write target —
editing the button's padding in the `ar` frame and in the `en` frame must edit
the same JSX attribute, because there is only one button in the source. Making
the ids differ would fabricate two write targets where the repo has one, which is
exactly the failure invariant 2 exists to prevent.

Text is the interesting exception and it already works: each variant is parsed
with its own `preferredKey`, so each variant's node carries its **own**
`textOrigin` pointing at that locale's string literal. Editing text in the `ar`
frame writes to the `ar` entry in `translations.js`. That falls out of the
existing design — no new mechanism.

**So the id grammar does not change** (trap #2 respected). What changes is that
**editor state keys on `(frameId, nodeId)` instead of `nodeId`**:

| Concern | Today | Change |
|---|---|---|
| Selection / hover | `nodeId` | `(frameId, nodeId)` — so selecting in the `ar` frame doesn't ring the `en` frame |
| Canvas DOM mapping | `[data-node-id]` within the page | already per-iframe — **no change** |
| `_nodeIdToPageIds` | `nodeId → pageIds` | `nodeId → frameIds` |
| Parsed page entries | one per `pageId` | one per `(pageId, locale)`, cached by the existing `configHash` + locale |
| Writeback | `nodeId → file:line:col` | **no change** — one target, as it should be |

Selecting a node in one variant may optionally *co-highlight* its twin in the
others; that is a UI nicety, and it is honest precisely because they are the same
source element.

### 4.4 Frame model

`BoardFrame` gains one optional field:

```ts
interface BoardFrame {
  pageId: string
  x: number; y: number
  width?: number; height?: number
  axes?: Partial<PreviewAxes>   // ← overrides the board default, per axis
}
```

Optional, exactly like `width`/`height` — a `boards.json` written before this
change opens unchanged with no migration, which is the precedent the existing
comment in `types.ts:13` already establishes for that file.

The board-level axes (§5.1) are the default; a frame's `axes` overrides
per-axis, not wholesale. "Duplicate this frame as Arabic" is then a two-line
board mutation, and it is the primary way users will reach this feature.

### 4.5 Cost, stated honestly

Parsing one page per distinct locale on the board is the real cost: two locales =
two parses. Mitigations, both already in the codebase:

- The on-disk parse cache keys on `configHash`, which already includes
  `preferredKey` — extend the key with the locale and switching back is free.
- Frame virtualization (`frameVirtualization.ts`) already means offscreen frames
  are not mounted; variant frames obey it like any other.

What this does **not** do is parse a locale nobody is looking at. The load route
builds entries for the **union of locales actually in use on the board**, not for
every locale the probe found.

### 4.4 The payoff worth testing explicitly

Editing text in a non-default locale should write to **that locale's** string
literal, because `textOrigin` already names the literal that produced the
resolved text (§7, "Never write a resolved value back as a literal" — resolved
*text* is the sanctioned exception). If that holds, a user edits Arabic copy on
the canvas and it lands in `translations.js`'s `ar` branch.

This likely already works. **Verify it with a test before claiming it** — it is
the single most valuable behaviour in Phase 2.

---

## 5. Cross-cutting

### 5.1 UI

One control group in `src/admin/pages/site/toolbar/StudioToolbarActions.tsx`:
direction toggle · locale `Select` · scheme toggle. `Button`/`Select` primitives
only, `globals.css` tokens only, no hex, no `var(--x, fallback)`. A control whose
probe found nothing renders **disabled with the reason**, never absent.

### 5.2 Persistence, and the one place a compat read is correct

`.studio/meta.json` gains `previewAxes` and **loses** `previewLocale`.

That file is **user data on disk**, hand-editable, and already exists in every
imported project — the same category as the DB-schema exception in `CLAUDE.md`.
So `readStudioMeta` folds a legacy `previewLocale` into `previewAxes.locale` on
read and writes only the new shape thereafter. That is a **data migration on one
read path**, not an old-and-new code path: `StudioMetaSchema` keeps exactly one
shape, and nothing downstream ever sees `previewLocale`.

### 5.3 MCP

- `studio_fidelity_report` gains the RTL and dark-mode findings.
- The visual-audit trio (`exportFrames.ts` / `referenceRender.ts` /
  `diffFrames.ts`) gains a `PreviewAxes` parameter. An agent can then pixel-diff
  `en/ltr/light` against `ar/rtl/dark` — which is precisely the audit those tools
  were built for, and the strongest argument for modelling the three axes as one
  typed triple rather than three ad-hoc flags.

### 5.4 Docs (same change, per §8 of `PROJECT-BRIEF.md`)

- `docs/features/studio-import.md` — delete the "RTL is not applied" row, add
  the real codes; update the locale rows.
- `docs/agent-refs/path-index.md` — the new files.
- `docs/agent-refs/canvas-internals.md` — how axes reach a frame without a remount.
- `docs/agent-refs/glossary.md` — `previewLocale` → `previewAxes`.
- `STATE.md` — handoff entry **in the same commit as the code**
  (`parser-07`'s lesson: a commit with no `STATE.md` entry is indistinguishable
  from unfinished work).

### 5.5 Tests

| Area | Test |
|---|---|
| Locale-key probe against the WS-13 fixture + a synthetic `i18next` shape | `server/handlers/__tests__/projectProbe.test.ts` |
| `dir` / scheme attribute lands on the frame root | canvas test via `iframeCanvasQuery.ts` (trap #10) |
| `prefers-color-scheme` rewrite: scoping, `:where()` specificity, layer preservation | unit test on `darkSchemeCssTransform.ts` |
| Text edit in a non-default locale lands in that locale's literal | `src/__tests__/studio/` |
| `previewLocale` → `previewAxes` fold | `projectProbe.test.ts` (meta merge cases already live there) |
| Fidelity code ↔ registry ↔ doc table agree | existing `fidelityCodes.test.ts` |

**No browser/e2e runs** — trap #13. Static gates only (`bun test`,
`bun run build`, `bun run lint`), then hand off with a *needs human dogfood* note.

---

## 6. Sequencing

| Phase | Contents | Depends on | Ships alone? |
|---|---|---|---|
| **1** | Direction + dark mode, board-global — both render-time | — | **yes** |
| **2** | `BoardFrame.axes` + per-frame direction/scheme + "duplicate as variant" | Phase 1 | **yes** |
| **3** | Locale probe + board-global locale switch | Phase 1's `PreviewAxes` model | yes |
| **4** | Per-frame locale: `(frameId, nodeId)` keying + per-`(pageId, locale)` entries | 2 + 3 | yes |
| **5** | MCP axes params + fidelity codes | 1–3 | yes |

Phase 2 delivers the side-by-side requirement for **dark mode and direction**
immediately, because neither needs a parse. Phase 4 extends it to locale, which
is the only axis that does.

Phases 1 and 2 are the fastest win available anywhere in this document: they are
pure render-time work, they need no parser change, and any project that already
ships a second locale or a dark stylesheet renders it correctly the day they
land.

## 7. Risks

1. **Frame remount on axis change.** If direction is wired through `srcDoc` or a
   React `key` instead of an attribute effect, every toggle pays a full board
   remount. Watch `perf-01`'s frame-mount budget.
2. **The dark-mode CSS rewrite over-reaching.** It must stay on the injected copy
   and stay specificity-neutral. A regex-only implementation will mangle nested
   at-rules — parse the media query properly (`studioCss.ts` already runs a real
   CSSOM via happy-dom; reuse it rather than inventing a second parser).
3. **§4.3 attempted opportunistically.** Per-frame locale looks like a small
   addition to Phase 2 and is not. It is gated on the id grammar.
4. **Probe false negatives.** A project with no detectable locale dictionary must
   degrade to a disabled control with a reason, never to a silent no-op toggle.

## 8. Open decisions for the user

1. ~~Per-frame locale — defer?~~ **Decided: no, it is required (§4.3).** Variants
   of one page sit side by side on the board. The id grammar does **not** change;
   editor state re-keys on `(frameId, nodeId)`.
2. ~~Dark-mode token extraction (§3.3)?~~ **Confirmed: `.studio/framework.json`
   stays single-valued.** A second value set is a framework-panel change, not a
   preview-axis change, and belongs to its own workstream.
3. ~~Axis scope?~~ **Per project** — `.studio/meta.json`, so the board a
   colleague opens is the board you left.

---
---

# WS-11 — Canvas chat on Claude CLI login

**Use the chat in the canvas without pasting an API key — authenticate with the
`claude` CLI's existing login instead.**

---

## 1. What already exists

The chat is built. `src/admin/pages/site/panels/AgentPanel/` (654 lines +
composer, history, model picker, tool-call rows) is mounted from
`AdminCanvasLayout.tsx`, backed by `server/ai/drivers/anthropic.ts` talking
straight to `POST /v1/messages`, with a real encrypted credential store
(`server/ai/credentials/`).

**Only the auth mode is missing.** `AiAuthMode` is `'apiKey' | 'baseUrl'`
(`server/ai/runtime/types.ts:36`), and `anthropicDriver` hard-refuses anything
that is not `apiKey` (`anthropic.ts:74`). So this workstream is narrow: one new
way to authenticate, plus the surface that selects it.

## 2. The mechanism — the VS Code extension model (DECIDED)

**Studio's AgentPanel becomes a front-end over a local `claude` process**, exactly
the way the Claude Code VS Code extension works. The extension does not hold an
API key and does not extract a token — it drives the CLI, and the CLI carries
whatever login the user already has, including a **Claude Pro/Max subscription**.

```
AgentPanel  ──stdin/NDJSON──►  claude -p --output-format stream-json
   ▲                                │  (auth: the CLI's own subscription login)
   └────────stream-json─────────────┘
```

Consequences, all of them good:

- **No API key anywhere.** Nothing to paste, store, encrypt, fingerprint, or
  rotate.
- **Subscription login works directly.** `claude` is already logged in; Studio
  inherits that session by spawning it. If the user is logged out, they run
  `claude` once (or `/login`) and Studio picks it up on the next probe.
- **Studio never sees a token.** It does not read `~/.claude/.credentials.json`,
  does not touch the OS keychain, and does not send an `Authorization` header
  anywhere.

The rejected alternative, recorded so nobody re-proposes it: reading the CLI's
stored OAuth token and calling `api.anthropic.com` directly. It is fewer moving
parts, but those credentials are issued to Claude Code, so driving a separate
application with them sits outside what the subscription grants — it risks the
account rather than anything technical. Spawning the CLI gets the identical
outcome with none of that, which is precisely why the VS Code extension is built
this way too.

### 2.1 Per-user login — the "small environment" (D2)

The original draft treated CLI auth as *machine-level* and proposed gating the
feature to loopback or admins. **That is no longer the design.** Each user gets
their own isolated CLI environment and logs in with their own Claude account, so
each user spends their own subscription and acts as themselves.

The mechanism is `CLAUDE_CONFIG_DIR` (F2). One directory per user, created and
owned by the server:

```
<dataDir>/claude-cli/<userId>/        mode 0700, never inside the user's project
  .credentials.json                   written by the CLI, never read by Studio
  settings.json
```

Every spawn — probe, login, and chat — sets `CLAUDE_CONFIG_DIR` to that user's
directory. Consequences:

- **Studio still never reads a token.** It creates a directory and sets an env
  var. The CLI writes and reads its own credentials inside it. `CredentialView`
  is untouched, `ai_provider_credentials` is untouched, and there is nothing new
  to encrypt or rotate.
- **Login state is per user.** The availability probe runs in the requesting
  user's config dir, so the picker shows *that user* logged in or logged out,
  with the reason.

#### The login flow — corrected by probe (P3)

The draft above assumed Studio could spawn the CLI's login, capture the URL it
prints, and take the code back. **It cannot.** `claude setup-token` and
`claude auth login` are Ink TUIs: with piped or `/dev/null` stdin they die
immediately with `Raw mode is not supported on the current process.stdin`,
before printing any URL. `setup-token` takes no flags at all — there is no
`--no-browser`, no headless mode. Driving them would need a real PTY, which Bun
has no built-in for and which would mean a native dependency.

So Studio offers **two login paths, both landing in the same per-user
environment**, and is honest about which applies where:

| | Path | Studio holds a secret? | Works when the server is remote? |
|---|---|---|---|
| **L1** | **Terminal login.** Studio shows a prefilled one-liner — `CLAUDE_CONFIG_DIR=<dir> claude auth login` — the user runs it in their own shell and completes OAuth in their browser. The CLI writes credentials into their directory. | **No.** | Only if the user has shell access to the host. |
| **L2** | **Token paste.** The user runs `claude setup-token` anywhere (their own laptop is fine), gets a one-year token, and pastes it into Studio. Studio encrypts it per user and passes it as `CLAUDE_CODE_OAUTH_TOKEN` when spawning. | Yes — encrypted, per user. | **Yes.** |

L2 is what makes "login on the server" work at all, and it is what the request
called *"single sign on code"*. `setup-token` exists precisely for
"environments where interactive browser login isn't available", so this is the
sanctioned use, not a workaround. Confirmed by probe: `CLAUDE_CODE_OAUTH_TOKEN`
is a first-class auth source in the binary, resolved as
`{ accessToken, refreshToken: null, expiresAt: null, scopes: ['user:inference'] }`.

Two properties of an L2 token to surface in the UI rather than discover later:
it is **inference-only** (it cannot drive Remote Control) and it **does not
refresh** — a one-year expiry that Studio must show and prompt to renew, because
nothing will renew it automatically.
- **No gating is required**, because the surprise the gating existed to prevent
  — spending someone else's subscription — cannot happen.

Two things this does not fix, both of which stay in §5:

1. The subprocess still runs **on the server**, with the server's filesystem
   access. Per-user auth changes who pays, not what the process can reach.
   Containment (§5.2) is unchanged and still mandatory.
2. **macOS stores credentials in the OS keychain**, which `CLAUDE_CONFIG_DIR`
   does not relocate. On a macOS host, all users of one OS account share one
   login. Detect the platform and disable the provider with that reason shown —
   the same disabled-with-a-reason rule as every other probe. Do not silently
   fall back to a shared login.

## 3. Storage — and why this ships with no migration at all

**Resolved: WS-11 needs zero schema changes.** The draft below correctly
identified the `auth_mode` CHECK as unwidenable and proposed a new
`ai_local_provider_defaults` table to route around it. Two probe findings make
that table unnecessary:

**P1 — an L2 token fits the existing credential table unchanged.** The CHECK is
`auth_mode in ('apiKey','baseUrl')`, and `ai_creds_apikey_shape_check` requires
`ciphertext` and `iv` non-null with `base_url` null. A `setup-token` OAuth token
is exactly that: an opaque secret string Studio encrypts. It stores as
`auth_mode = 'apiKey'` with `provider_id = 'claudeCli'` — and **`provider_id`
has no DB constraint at all**, because the schema's own comment says it is
validated at the TypeBox boundary so a new provider never forces a migration.
That comment was written for this exact case. Per-user isolation comes free:
`ai_provider_credentials` is already keyed by `user_id`.

`auth_mode = 'apiKey'` is honest here, not a reuse dodge. The column records
*the shape of the thing stored* — an encrypted secret string — not which OAuth
grant minted it. `provider_id` is what says this is the CLI.

**P2 — L1 needs no row, and no default either.** A terminal login leaves
nothing for Studio to store; the credential lives in the user's config dir. The
old design invented a table because `ai_defaults.credential_id` is
`not null references ai_provider_credentials(id)`, so a credential-less provider
had nowhere to record its model. But WS-12 §5 already puts the agent session's
model, effort, and mode in **`.studio/meta.json`** — per project, next to the
board it belongs to. That is the right home regardless, and it removes the only
reason the table existed.

So: **`ai_local_provider_defaults` is cut.** No new table, no `ADD COLUMN`, no
migration in either dialect. Combined with WS-12 §8.1's scope collapse — also
migration-free — the entire agent programme ships without touching the schema.

<details>
<summary>Original blocker analysis, kept for the reasoning (superseded by P1/P2)</summary>

#### The blocker

`ai_provider_credentials` has an **inline CHECK constraint** in both dialects:

```sql
constraint ai_creds_authmode_check check (auth_mode in ('apiKey', 'baseUrl'))
```

SQLite has no `ALTER TABLE … DROP/ALTER CONSTRAINT`. Widening that CHECK needs
the 12-step table rebuild — which `CLAUDE.md` bans outright ("no table
rebuilds"). Migration `008_ai_drop_ambient_credentials` set the precedent by
*narrowing* the set with a `DELETE`, never by touching the constraint.

**So: do not add a `'claudeCli'` auth mode to that table.**

That is not a workaround — it is the right shape anyway, and the schema's own
comment already argues for it:

> `provider_id` is validated at the application boundary by the TypeBox
> `ProviderId` union. A DB enum that duplicates that list would force a
> destructive migration on every new provider, so it lives at the boundary, not
> here.

**A locally-authenticated CLI is not a credential.** There is no secret to
encrypt, no `iv`, no `key_fingerprint`, no rotation, and nothing that could leak
through `CredentialView`. Every column on that table is about a secret Studio
holds. Studio holds nothing here — it holds the *fact that a binary is installed
and logged in*.

### Model it as a local provider, not a credential row

- **No change to `ai_provider_credentials`.** No migration on that table.
- **One new additive table**, both dialects, identical id (`migrations-pg.ts` +
  `migrations-sqlite.ts`, gated by `migration-parity.test.ts`):

  ```sql
  create table if not exists ai_local_provider_defaults (
    scope       text primary key,   -- validated at the TypeBox boundary, NOT here
    provider    text not null,      -- 'claudeCli'
    model_id    text not null,
    updated_at  ...
  );
  ```

  **Deliberately no CHECK on `scope`.** The existing `ai_defaults_scope_check` /
  `ai_conv_scope_check` pin `scope` to `('site','content','data','plugin')`, and
  because SQLite cannot alter a CHECK, that is precisely what blocks WS-12 from
  adding a `'studio'` scope (WS-12 §6.1). Repeating the pattern in a brand-new
  table would re-create the trap on day one. Validate at the boundary — the same
  argument the schema already makes for `provider_id`.

  This exists because `ai_defaults.credential_id` is `not null references
  ai_provider_credentials(id)` — and making it nullable is another SQLite
  `ALTER COLUMN` we cannot perform. A separate table that takes precedence over
  `ai_defaults` for a scope is purely additive and costs one resolution
  function.

- `AiAuthMode` stays `'apiKey' | 'baseUrl'`. The local provider is selected on a
  **different axis** from credentials, so it does not widen that union at all.

</details>

## 4. The driver

New `server/ai/drivers/claudeCli.ts`, implementing the same `AiProvider`
interface as every other driver.

- **Transport:** spawn via the repo's existing
  `server/handlers/studio/subprocessRunner.ts` (`runCappedSubprocess`,
  `minimalSubprocessEnv`) — the same primitive `styleCompileWorker` and
  `installDeps` already use. Timeout, capped capture, explicit minimal env, all
  free.
- **Translation:** the CLI emits NDJSON `stream-json` on stdout. The driver
  translates those events → `AiStreamEvent`, sitting where the SSE translator
  sits for the HTTP drivers. `toolLoop.ts`'s `ProviderAdapter` shape is the
  contract to hit.
- **Availability probe:** `claude auth status --json` (see §4.0). Not installed,
  or installed and logged out → the provider appears in the picker **disabled
  with the reason shown**, never silently absent. (Same rule as WS-10's probes.)
- **Model list:** from the CLI, not from `/v1/models` — there is no API key to
  call that endpoint with.

### 4.0 The verified CLI contract

Every claim here was observed against the installed binary (v2.1.114), not read
from documentation. Implement against these, and do not re-derive them.

**Spawn shape.** There is **no `--cwd` flag** — set the child process's working
directory. It determines `.claude/agents` discovery, `CLAUDE.md` discovery, and
the session-transcript folder, and it is echoed back as `init.cwd`.

```
env:  CLAUDE_CONFIG_DIR=<per-user dir>   [+ CLAUDE_CODE_OAUTH_TOKEN for L2]
cwd:  <resolved workspace root>
argv: -p --output-format stream-json --verbose --input-format stream-json
      --model <id> --effort <low|medium|high|xhigh|max>
      --permission-mode <default|acceptEdits|plan|bypassPermissions>
      --mcp-config <json> --strict-mcp-config
      --session-id <uuid> | --resume <id>
```

**`--permission-mode` accepts exactly the four modes WS-12 §5.2 needs** (plus
`auto` and `dontAsk`), so the mode control maps 1:1 with no translation layer.
`--effort` takes the five levels verbatim. Both confirmed in `--help`.

**The login probe is `claude auth status --json`:** exit 0 with
`{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro",…}`, exit 1
with `{"loggedIn":false,"authMethod":"none"}`. No model call, no cost, no session
file. Use this, and nothing else.

**Four traps, each of which would produce a plausible-looking wrong
implementation:**

1. **`apiKeySource` is `"none"` even when fully logged in.** It reports the *API
   key* source, not auth state. It reads identically in the logged-in and
   logged-out runs. Never probe with it.
2. **`result.subtype` is `"success"` even when the turn failed.** Key off
   `result.is_error`, never off `subtype`.
3. **stderr is empty on every non-crash path.** Authentication failures and MCP
   config errors all arrive on **stdout**. A driver that waits on stderr for
   errors waits forever.
4. **`--strict-mcp-config` is mandatory.** Without it the CLI merges the user's
   own `~/.claude.json` and the project's `.mcp.json` servers and connects to
   them. Studio must ship exactly the toolset it intends and no more.

**Unauthenticated runs still emit `system/init`** before failing, which is what
makes a zero-cost capability probe possible. Failure then arrives as an
`assistant` event carrying top-level `"error":"authentication_failed"` with
`message.model === "<synthetic>"`, then a `result` with `is_error: true`.

**Cost warning.** A single trivial prompt in this repo cost **$0.168**, because
it cache-created ~27k tokens of `CLAUDE.md` and context. Any probe or health
check must use `--bare` or an empty `cwd`. `modelUsage` also bills models you
never requested (an internal Haiku classifier call), so account against the whole
map, not just `--model`.

**Schema note for the translator:** within one `result` event, `usage.*` is
snake_case while `modelUsage.<model>.*` is camelCase. Parse by key name, never by
position — the authenticated and synthetic `assistant` messages differ in key
order and in which optional keys are present.

### 4.1 Tools — route them through the MCP server Studio already has

This is the decision that makes the feature worth building rather than a
downgrade.

Studio's chat has real tools (site tools, the live editor bridge). A `claude`
subprocess runs *its own* agent loop with *its own* tools, so a naive delegation
would bypass all of them and give you a chat that cannot touch the canvas.

Studio already solved exactly this: **`/_studio/mcp`**, per-connector bearer
tokens, and the `(userId, scope)` live bridge that routes browser tools to the
owner's open workspace (`server/ai/mcp/editorBridge.ts`,
`docs/features/mcp-connectors.md`). It was built so Claude Code could drive the
open workspace.

So: launch the subprocess with `--mcp-config` pointed at Studio's own MCP
endpoint, carrying a scoped connector token minted for that chat session. The CLI
gets Studio's real toolset, the edits land through the live bridge exactly as
they do for an external Claude Code connector, and Studio's tool loop is not
duplicated — it is reused through the interface it already exposes.

Consequence to accept deliberately: with this provider the **CLI owns the agent
loop**, not `toolLoop.ts`. Turn structure, retries, and tool-permission prompts
are the CLI's. That is a genuine behavioural fork from the HTTP drivers and must
be documented, not papered over.

## 5. Security — three things that are not optional

1. **The per-user config directory is a credential store Studio owns the
   lifecycle of.** It holds another user's session. Create it `0700`, never
   inside a project directory, never inside `uploads/`, never served over HTTP.
   The path is derived from `userId` through the same containment guard as any
   other user-supplied path segment — a `userId` is not a filename until it has
   been validated as one. Delete the directory when the user is deleted, and on
   an explicit "log out of Claude" action.
2. **A subprocess that can edit files.** `cwd` pinned to the resolved workspace
   root with the same containment guard `appRoot.ts` applies; minimal env; never
   pass a permission-bypassing flag. `security-guard` reviews this before merge.
3. **Never log or persist CLI output verbatim** into conversation storage without
   the same redaction the other drivers get.

## 6. Files

| File | Change |
|---|---|
| `server/ai/drivers/claudeCli.ts` | **new** — the provider: spawn, stream-json → `AiStreamEvent`, availability probe |
| `server/ai/drivers/index.ts` | register it |
| ~~`server/db/migrations-*.ts`~~ | **cut — no migration (§3, P1/P2)** |
| `server/ai/credentials/` | accept a `claudeCli` provider whose secret is an L2 OAuth token, `auth_mode='apiKey'`; surface its one-year expiry |
| `server/handlers/studio/claudeCliEnv.ts` | **new** — resolve + create the per-user `CLAUDE_CONFIG_DIR` (0700, containment-checked `userId`), and the L1 one-liner shown in the UI |
| `server/ai/mcp/` | mint a scoped connector token for a chat session (§4.1) |
| `src/admin/ai/ModelPicker/ModelPicker.tsx` | show the local provider + its disabled-with-reason state |
| `src/admin/pages/site/panels/AgentPanel/` | no structural change — it consumes whatever provider is selected |
| `src/__tests__/architecture/ai-driver-isolation.test.ts` | **the rule moves — move its gate** (§6.1) |
| `docs/features/agent.md`, `docs/features/mcp-connectors.md` | the new provider + the loop-ownership fork |

### 6.1 The architecture rule this changes

`ai-driver-isolation.test.ts` encodes "every driver talks directly to its
provider's REST API over HTTP/SSE". A subprocess driver is the first exception.

The **npm bans are untouched** — `@anthropic-ai/sdk` and
`@anthropic-ai/claude-agent-sdk` stay banned and nothing is added to
`bun.lock`; this invokes a binary the user installed themselves. But the *stated
rule* is now narrower than reality, so per `CLAUDE.md` ("when your change drifts
a structural rule, fix the rule's gate test in the same change") the test's
documented rule becomes: **no provider SDK may be imported; a driver may reach
its provider over HTTP/SSE or via a local user-installed binary.**

## 7. Open decisions for the user

All closed.

1. ~~Approach (A) or (B)?~~ **Decided: (A), the VS Code extension model** — spawn
   the CLI, never handle a token (§2).
2. ~~Multi-user gating?~~ **Decided: no gating — per-user login instead (D2, §2.1).**
   Each user authenticates their own account in their own `CLAUDE_CONFIG_DIR`.
   The one platform that cannot honour this is macOS, which is disabled with a
   reason rather than silently shared.
3. ~~Tools via MCP, or a no-tool backend?~~ **Decided: MCP (§4.1).** A chat that
   cannot touch the canvas cannot create screens, which is the entire point of
   WS-12.

## 8. Sequencing

| Step | Contents | Ships alone? |
|---|---|---|
| 1 | Driver + availability probe + model list, **no tools** — proves auth end to end | yes |
| 2 | `ai_local_provider_defaults` + picker selection + disabled-state UI | yes |
| 3 | MCP tool routing (§4.1) | yes |
| 4 | Gate-test rule change + docs | with 1 |

Step 1 is the honest proof: if `claude -p` streams a reply into the AgentPanel
using your existing login, the premise holds and the rest is plumbing.

---
---

# WS-12 — The Studio agent

**System prompt, harness, subagents, and the tools needed to actually create
screens inside Studio and understand the project it is editing.**

---

## 1. The finding that defines this workstream

**The in-canvas agent has no Studio mode at all.** This is not a gap in quality —
it is a gap in kind.

- `ToolScope` is `'site' | 'data' | 'plugin'` (`server/ai/runtime/types.ts:39`).
  **There is no `'studio'` scope.** `handlers/chat.ts:82` validates against
  exactly those three.
- The AgentPanel therefore runs the **`site`** scope, whose system prompt
  (`server/ai/tools/site/systemPrompt.ts`) is a **CMS page-builder prompt**:
  `site_insert_html`, `<studio-outlet>` templates, loops over `data.rows`, post
  types, "Homepage = page with slug index".
- Every one of those concepts belongs to the **dormant CMS half**. Pointed at a
  React repo, that prompt instructs the model to do things that cannot work —
  it will try to insert HTML into a `.tsx` file it should be editing as an AST.

Meanwhile Studio's real tools **already exist** — but only for *external* MCP
clients (`server/ai/mcp/tools/studio/`), not for the chat in the canvas:

| Read / understand | Write | Verify |
|---|---|---|
| `studio_list_projects` | `studio_apply_edits` | `studio_fidelity_report` |
| `studio_project_profile` | `studio_codemod` | `studio_export_frames` |
| `studio_list_pages` | `studio_set_frames` | `studio_render_reference` |
| `studio_get_node_source` | | `studio_diff_frames` |
| `studio_find_nodes` | | |
| `studio_install_deps` / `studio_install_status` | | |

**So this workstream is mostly wiring and authoring, not invention.** Fourteen
tools exist. What is missing is a scope, a prompt, a context assembly, and two
tools (§3).

### 1.1 Two concrete defects found while mapping this

1. **`studio_apply_edits` hides half its own capability.** Its `inputSchema` is
   `StudioEditSchema`, whose union includes `insert`, `delete`, and `move`
   (`studioWriteback.ts:174/186/206`) — but its `description` advertises only
   `prop|text|style|literal|tag|asset|detach|swap`. The model reads the
   description, not the schema. **The agent currently cannot know it is allowed
   to add, remove, or reorder elements** — which is most of "create a screen".
   One-line fix, disproportionate payoff.
2. **Screen creation is not exposed at all.** `POST /admin/api/studio/page`
   scaffolds a new page (`server/handlers/studio.ts:279`) and the canvas has a
   `NewPageButton`. No tool wraps it. The agent cannot create a screen.

---

## 2. Harness — where the loop lives (depends on WS-11)

Two shapes. **WS-11's decision picks H2**, and that changes what this workstream
has to build by roughly an order of magnitude.

| | **H1 — Studio owns the loop** | **H2 — the CLI owns the loop** |
|---|---|---|
| Driver | HTTP → `toolLoop.ts` | `claude` subprocess (WS-11 §2) |
| Prompt delivery | `buildStudioSystemPrompt()` → `AiStreamRequest.systemPrompt` | `--append-system-prompt` + a generated `STUDIO.md` in the workspace |
| Tools | registered in the in-process tool engine | Studio's own MCP server, `--mcp-config` (WS-11 §4.1) |
| Subagents | Studio implements a sub-loop | **`.claude/agents/*.md` — free** |
| Retries, permissions, prompt caching, compaction | Studio builds each one | **free** |

**Recommendation: H2.** Under H2, "subagents" stop being a feature Studio has to
implement and become four markdown files. Prompt caching, tool-permission
prompting, context compaction, and turn recovery all come from the CLI. Studio's
job shrinks to: *author the prompt, expose the tools over MCP, assemble the
context, render the stream.*

**The prompt content in §4 is identical either way.** Only its delivery differs,
so authoring it is not a bet on H2.

### 2.1 Context assembly — `StudioAgentSnapshot`

The `site` scope has `SiteAgentSnapshot` feeding a dynamic suffix rebuilt every
turn. Studio needs its own, in a new
`src/admin/pages/site/agent/studioAgentSnapshot.ts`:

```ts
interface StudioAgentSnapshot {
  project:    { dir, displayName, appRoot, trust: TrustTier }
  profile:    { framework, pagesDir, styleToolchain, componentPackages, warnings }
  board:      { id, name, frames: { pageId, title, x, y, w, h }[] }
  activePage: { id, file, rootNodeId }
  selection:  { nodeId, tag, moduleId, writableProps, lockedReason }[]
  axes:       PreviewAxes                    // WS-10
  fidelity:   { code, count }[]              // digest, not the full report
  install:    { status, missingDeps }
}
```

Design rules, each learned from something already in the repo:

- **Digest, never dump.** The token digest in `systemPrompt.ts:89` is the
  precedent: bounded lists with `+N more`. A board of 40 frames must not
  serialise 40 node trees.
- **Never scan every node of every page to build it** — trap #11. The snapshot
  reads board metadata and the *selected* subtree only.
- **It rides the dynamic suffix**, after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, so the
  static prefix stays prompt-cacheable exactly as the site scope does today.

### 2.2 The staleness rule — the harness's single most important job

`studio_apply_edits` returns **`shifted: true`** when a write changed a file's
line count. A node id **is** a source location (`relFile:line:col`), so:

> **Every node id the agent captured before that call is now wrong.**

An agent that keeps using pre-write ids will silently edit the wrong element.
The harness must enforce this, not hope the model remembers:

1. The tool result surfaces `shifted` prominently.
2. The prompt states the rule as an absolute (§4).
3. On `shifted: true`, the snapshot for the next turn is **rebuilt**, and the
   suffix carries an explicit `⚠ node ids re-issued after the last write` line.

This is the one harness behaviour whose absence causes silent repo corruption
rather than a visible failure.

### 2.3 Budgets and guardrails

- **Trust tier is the gate.** Tier 0 = read + AST edits only; `studio_install_deps`
  and anything spawning the project's toolchain require explicit promotion
  (`studioProjectTrust.ts`). The agent may *ask* for promotion; it may never
  perform it.
- **Writes are batched and bounded.** Prefer one `studio_apply_edits` with N
  edits over N calls — the engine already orders bottom-to-top so a
  line-shifting codemod cannot invalidate a pending edit's location.
- **`studio-workspace/*` is user data** (trap #12). No delete-the-project path is
  reachable from any tool the agent holds.
- **Verify, don't assume.** A screen-building turn ends with
  `studio_export_frames` (and `studio_diff_frames` when a reference exists), not
  with the model asserting it worked.

---

## 3. Tools — what's missing

Two additions; everything else is wiring the existing fourteen into the new
scope.

| Tool | Why |
|---|---|
| **`studio_create_page`** | Wraps the existing `POST /admin/api/studio/page`. Scaffolds the `.tsx`, registers a board frame, returns `{ pageId, file, rootNodeId }`. **Without this the agent cannot create a screen at all.** |
| **`studio_read_file`** | Bounded read of a workspace file by relative path, containment-checked. `studio_get_node_source` reads *a node*; composing a new screen needs to read a sibling screen and a component's props. |

Plus the §1.1 description fix on `studio_apply_edits`, which costs one line and
unlocks `insert`/`delete`/`move`.

**Deliberately not added:** a shell tool, a raw file-write tool, and a
"regenerate this file" tool. All three break invariant 2 (*a write must have
exactly one honest target*) — an edit that cannot land in one place in the user's
source must be refused, not brute-forced by rewriting the file.

---

## 4. The system prompt

Authored in the repo's existing three-part cacheable form
(`[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]`), so Anthropic
prompt-caching applies to the prefix unchanged. Under H2 the prefix is delivered
via `--append-system-prompt` and the suffix as a per-turn context block.

### 4.1 Static prefix — `server/ai/tools/studio/systemPrompt.ts` (new)

> You design screens inside Studio. The document you are editing is a **real
> React repository on disk** — the user's own `.tsx`/`.jsx` files. There is no
> export step and no code generation: the repo *is* the design.
>
> **Two rules govern everything you do.**
>
> **1. Parse, never execute.** Everything you see was read statically out of the
> AST. No component was rendered, no hook was called. When a value shows as
> unresolved, that is an honest limit of static reading — not a bug to route
> around.
>
> **2. A write must have exactly one honest target.** Before any edit, the one
> question is: *does this land in exactly one place in the user's source?* If it
> would destroy a binding or change N call sites at once, it is refused — say
> why, and offer the edit that is honest instead.
>
> **Node ids are source locations** (`relFile:line:col`). Never invent, guess,
> concatenate, or pattern-match one. Use ids exactly as `studio_list_pages`,
> `studio_find_nodes`, or a prior tool result returned them.
>
> **After any write that reports `shifted: true`, every node id you already hold
> is stale.** Re-read before your next edit. Editing with a stale id silently
> modifies the wrong element — this is the single worst failure available to you.
>
> **Editable vs. locked — they are different facts.**
> `locked` is about *structure*. `codeProps` is about *values*. A node can be
> structurally locked and still have editable text; a prop can be read-only on an
> otherwise fully editable node. Never treat one as implying the other. A
> resolved value (`title={c.sheetTitle}` showing as "Where to?") is read-only —
> writing the resolved string would delete the binding. **Text is the one
> exception**: it writes back to the string literal's own origin.
>
> **You write Canonical JSX.** Screens you author follow the canonical subset —
> one `return`, props as literals or module-scope consts, text as literal
> strings, `.map` only over module-scope const arrays, no spread props, static
> `className` or `styles.x`, one styling mechanism, no wrapper elements. The full
> contract is `canonical-jsx.md`; read it once per session.
>
> This is not a style preference. Every rule maps to something that would
> otherwise come back locked, unresolved, or read-only on the canvas. **A
> canonical screen is fully editable; a non-canonical one is not.** When you are
> tempted to reach outside the subset, you are choosing to make part of your own
> output uneditable.
>
> A canonical screen is a **static composition**. Interactivity and data belong
> to components the screen imports, or to the app around it — not to the screen
> file. If a request needs state, put it in a component and compose that
> component in.
>
> **Creating a screen:**
> 1. `studio_create_page` — scaffolds a canonical file and its board frame.
> 2. Read a *sibling* screen first (`studio_read_file`). Match the project's
>    conventions — imports, component vocabulary, class naming, file layout. You
>    are joining a codebase, not starting one.
> 3. Compose structure with `studio_apply_edits` using `insert` edits, batched.
>    Reuse the project's own components before reaching for raw elements.
> 4. Style with the project's existing mechanism — the CSS file, CSS Module, or
>    utility classes `studio_project_profile` reports. Never introduce a second
>    styling system into a repo that already has one.
> 5. Verify with `studio_export_frames`, and confirm the screen is still
>    canonical. Do not report success unverified.
>
> **Editing an imported (non-canonical) screen is different work.** Do not
> "fix" it toward canonical unless asked — it is the user's code, written their
> way. Work within what is editable, and say plainly what is not.
>
> **Editing a screen:** `studio_find_nodes` to locate, `studio_get_node_source`
> to confirm, then one batched `studio_apply_edits`. Batch — the engine orders
> writes bottom-to-top so line shifts cannot invalidate a pending edit.
>
> **Never add a wrapper element** around existing canvas content. A wrapper
> breaks `%`/flex height chains and `>`/`+`/`:nth-child` combinators in the
> user's CSS. Insert as a sibling, or into an existing container.
>
> **Trust tiers.** Tier 0 projects run nothing — no install, no Sass/Tailwind
> compilation. If a task needs it, say so and let the user promote the project.
> Never attempt to work around a tier.
>
> **Unresolved is information, not failure.** `studio_fidelity_report` names what
> static reading could not resolve. Report it plainly; do not fabricate the
> missing value or "fix" it by inlining a literal.
>
> Reply in 1–2 sentences after acting. Tools change the repo; the reply narrates.
> Never paste source, JSON, or diffs into the reply.

### 4.2 Dynamic suffix

Rendered from `StudioAgentSnapshot` (§2.1), one line per group, same `·`-joined
shape the site scope uses:

```
Project: "Acme App" (trust: static, appRoot: .)
· Framework: vite+react · pagesDir: src/screens · styles: css-modules, plain-css
· Board "Main": 12 frames [Checkout, Settings, OrderSummary, …+9 more]
· Active: page:src/screens/Checkout.tsx root=…:12:4 (canonical ✓)
· Selected: …:41:6 <SheetHeader> (writable: title, subtitle; locked: items — resolved from props)
· Axes: ltr / en / light
· Fidelity: clean
· Deps: installed
```

The `canonical ✓` marker and a clean `Fidelity` line are what a WS-13 screen
looks like. On an imported file both degrade to the honest version —
`canonical ✗ (3 rules)` and a code histogram — which is exactly the signal the
agent needs to know which path it is on.

Every id in it is real and passable verbatim — the property the site scope's
suffix already maintains, and the reason "never invent an id" is enforceable.

---

## 5. Session controls — model, effort, mode, attachments

Everything in this section is a **native CLI capability** under H2. That is the
payoff of WS-11's decision: model choice, reasoning effort, permission modes, MCP
wiring, and subagents are flags and files, not an engine Studio has to write.
Studio's job is the UI and the persistence.

### 5.1 The control surface

One session bar above the composer in `AgentPanel`:

| Control | Maps to | Notes |
|---|---|---|
| **Model** | `--model` | Populated from the CLI, not a hardcoded list — same rule the Anthropic driver already follows for `/v1/models` (no static fallback, so new models appear without a code change). |
| **Effort** | reasoning-effort setting | Low / medium / high. Surfaced per-session; the default belongs in editor preferences. |
| **Mode** | `--permission-mode` | The four you asked for, 1:1 (§5.2). |
| **MCP** | `--mcp-config` | Studio's own server, always on (WS-11 §4.1). Additional servers — including the Almosafer package's (§6.2) — toggled per project. |
| **Attachments** | content blocks / paths | Images already exist (§5.3); files are new. |

**Persistence:** per project in `.studio/meta.json` (`agentSession`), so reopening
a project restores the model/effort/mode you were using. Mode is the exception —
see §5.2.

### 5.2 The four modes

| Your name | CLI mode | Behaviour |
|---|---|---|
| **Ask before edits** | `default` | Prompts before each write. **The default.** |
| **Auto** | `acceptEdits` | Edits apply without prompting; still refuses out-of-scope actions. |
| **Plan** | `plan` | Reads and reasons, writes nothing, produces a plan. |
| **Bypass** | `bypassPermissions` | No prompts at all. |

Three rules on **Bypass**, because it is the one that can hurt:

1. **It never persists.** It resets to *Ask before edits* on project switch and on
   reload. A mode this permissive should be a deliberate act each time, not a
   setting someone set once in March.
2. **The canvas shows it.** A persistent indicator while the session is in
   Bypass — this mirrors how Studio already treats trust promotion as visible,
   explicit consent rather than a silent flag.
3. **It does not widen the toolset.** Bypass skips *prompting*; it does not grant
   the agent tools it otherwise lacks, and it does not lift the trust tier.
   Tier 0 still runs nothing (§2.3).

### 5.3 Attachments

**Images already work** — `usePendingImageAttachments`, paste-from-clipboard, a
file picker, a per-message cap, and `PendingImageAttachmentGrid` are all built
and tested (`chatImageHandler.test.ts`). The work is **routing them to the CLI**
as content blocks instead of to the HTTP driver.

**Files are new.** A dropped `.png` design reference, a `.json` token export, a
`.md` spec: staged into a session-scoped temp directory and passed **by path**,
so the model reads them with its own tools rather than having them inflate every
turn's context. Containment-checked like every other filesystem path in this repo
(`appRoot.ts`'s posture), and cleaned up with the session.

### 5.4 Reasoning

Under H2 the CLI emits reasoning as stream-json events. `AgentPanel` renders them
in a collapsed block above the reply — visible on demand, never dominating the
panel. `ToolCallRow.tsx` is the existing precedent for this kind of secondary
stream; follow it rather than inventing a second pattern.

---

## 6. Canvas parity — "anything I can do"

The requirement is that the agent can do what you can do in the canvas. That is
checkable, so §7's gate checks it: **every editor action maps to a tool, or is
listed here as deliberately withheld.**

### 6.1 The matrix

| Editor action | Tool | Status |
|---|---|---|
| Select / inspect a node | `studio_find_nodes`, `studio_get_node_source` | ✅ |
| Edit text | `studio_apply_edits` `text` | ✅ |
| Edit a prop | `studio_apply_edits` `prop` | ✅ |
| Edit styles | `studio_apply_edits` `style` | ✅ |
| Change a tag | `studio_apply_edits` `tag` / `studio_codemod rename-tag` | ✅ |
| **Insert an element** | `studio_apply_edits` `insert` | ⚠️ works, **undocumented** (§1.1) |
| **Delete an element** | `studio_apply_edits` `delete` | ⚠️ same |
| **Move / reorder** | `studio_apply_edits` `move` | ⚠️ same |
| Replace an image | `studio_apply_edits` `asset` | ✅ |
| Detach / swap an instance | `studio_codemod` | ✅ |
| Extract a component | `studio_codemod extract-component` | ✅ |
| Resize / move frames | `studio_set_frames` | ✅ |
| **Create a page** | `studio_create_page` | ❌ **missing** (§3) |
| **Read a project file** | `studio_read_file` | ❌ **missing** (§3) |
| **Upload a new asset** | — | ❌ **missing** — `POST /admin/api/studio/asset-upload` exists, unexposed |
| **Set preview axes** | — | ❌ **missing** — needs WS-10; "show me this screen in Arabic" is a natural ask |
| **Duplicate a frame as a variant** | — | ❌ **missing** — WS-10 §4.4 |
| Install dependencies | `studio_install_deps` | ✅ trust-gated |
| Promote trust tier | — | 🚫 **withheld** — consent action, user-only (§9.2) |
| Undo / redo | — | 🚫 **withheld** — the user's safety net stays the user's |
| Pan / zoom / marquee | — | 🚫 **withheld** — viewport is not document state |
| Delete a project | — | 🚫 **withheld** — trap #12 |

So closing parity is **five tools**, not a rewrite: `studio_create_page`,
`studio_read_file`, `studio_upload_asset`, `studio_set_axes`, and
`studio_duplicate_frame` — plus the one-line description fix that reveals
insert/delete/move.

### 6.2 MCP servers the agent gets

- **Studio's own** (`/_studio/mcp`) — always on. The 14 + 5 tools above.
- **`@alm-design/design-system`'s own MCP server** — the package ships
  `mcp/server.js` + `mcp/catalog.js`. When the open project depends on it, wire
  it in so the DS-expert agent (§7) queries the real component catalog instead of
  reasoning from memory.
- **User-configured servers**, per project, in `.studio/meta.json`.

---

## 7. Subagents

**Confirmed by probe:** under `-p`, the CLI auto-discovers `.claude/agents/*.md`
from its working directory, and `--agents '<json>'` **merges with** that set
rather than replacing it. So D4's decision — generated agents live in
`<project>/.claude/`, committed — works with no extra wiring: set `cwd` to the
workspace root and the roster is simply there. `claude agents` lists what
resolved, which is the cheapest way to gate that generation actually worked.

The JSON form accepts `{ description, prompt, tools[], model }` per agent. Both
forms were verified to register.

Under **H2 these are markdown files** in a Studio-managed `.claude/agents/`
directory generated into the workspace beside the MCP config. Under H1 each is a
restricted sub-loop Studio implements — same roster, roughly 10× the work.

**A note on count, made once.** Every subagent starts cold and re-derives
context, so a large roster costs real tokens per spawn. Nine is what you asked
for and nine is what this specs; the mitigation is **routing discipline** — the
main agent delegates only when the work is genuinely separable, and the two
meta-agents (§7.3) are invoked deliberately, never as part of an ordinary
screen-building turn.

### 7.1 Build agents

| Agent | Tools | Owns |
|---|---|---|
| **`screen-scout`** | `studio_list_pages`, `studio_find_nodes`, `studio_get_node_source`, `studio_read_file`, `studio_project_profile` | **Read-only.** "Where is X, how does this project do Y, what convention does the sibling screen follow." Answers with `file:line`, never opinions. Absorbs the high-volume reads that would otherwise flood the main context. |
| **`screen-builder`** | `studio_create_page`, `studio_apply_edits`, `studio_read_file` | Scaffolds and composes **in Canonical JSX** (WS-13). Owns the insert/move/delete batch and the staleness discipline (§2.2). |
| **`style-surgeon`** | `studio_apply_edits` (style/literal), `studio_project_profile` | Styling only, through the project's *existing* mechanism. Separate because the failure it must avoid — introducing a second styling system into a repo that has one — is specific and easy to trip. |
| **`fidelity-auditor`** | `studio_export_frames`, `studio_render_reference`, `studio_diff_frames`, `studio_fidelity_report` | Verification. Runs last. The one that can say "it didn't work" — which is exactly why it must not be the agent that built it. |

### 7.2 Design agents

| Agent | Reference files | Owns |
|---|---|---|
| **`design-critic`** | `studio-design-principles.md` (new, §7.4) | Visual judgement — hierarchy, spacing rhythm, alignment, contrast, state coverage, empty/error states. Reviews a rendered frame, not source. Pairs with `fidelity-auditor`: one asks *"did it render as intended"*, this one asks *"was the intent any good"*. |
| **`almosafer-ds-expert`** | `@alm-design/design-system`'s **`CLAUDE.md`** (technical API, props, tokens) + **`design.md`** (intent, content guidelines, decision logic) + its **MCP catalog** (§6.2) | The authority on ALM 2.0: which component to reach for, its real props, its content rules, and its Arabic/RTL guidance. Both files exist on disk today at `node_modules/@alm-design/design-system/`. |

`design.md`'s own framing — *"`CLAUDE.md` covers the technical API; `design.md`
covers the why and when"* — is exactly the split this agent needs, which is why
it loads both rather than one.

**Sourcing rule:** these files are **read from the installed package**, never
copied into Studio. A vendored copy goes stale the first time the package
updates, and a DS expert quoting last quarter's props is worse than no expert.

### 7.3 Meta agents

| Agent | Owns |
|---|---|
| **`synthesizer`** | Takes scattered findings — scout results, fidelity codes, a critic's notes, a user's rambling brief — and returns one ordered plan with the open questions named. Invoked before a multi-screen job, and whenever a turn has accumulated more context than it can act on cleanly. |
| **`agent-creator`** | Authors new subagent definitions: frontmatter, tool allowlist, prompt body, reference files. Used when a recurring task deserves its own specialist. |
| **`system-prompt-expert`** | Owns prompt quality across the roster — the main prompt (§4) and every subagent's. Reviews for contradiction, dead instructions, and drift against the tools that actually exist. |

**These two write the things that govern the others, so they need a guard rail.**
An agent that can author agents can, in principle, grant itself tools. So:

1. A generated agent definition is **validated before it can load** — TypeBox on
   the frontmatter, and every tool in its allowlist must exist in the registry
   (the §7 gate already enforces that for the main prompt; it extends here).
2. **No generated agent may hold a tool the main agent does not.** The roster can
   be subdivided, never escalated.
3. Generated definitions land as **a diff the user accepts**, in the same posture
   as trust promotion — written to the workspace, not activated silently.

### 7.4 Reference files

Loaded by name from a Studio-managed `.claude/` directory in the workspace. Each
exists because several agents need the same fact and re-deriving it per agent is
how the roster starts contradicting itself.

| File | Contents | Read by |
|---|---|---|
| `canonical-jsx.md` | **WS-13's contract** — the authoring subset and why each rule exists | every build agent |
| `studio-invariants.md` | Parse-never-execute; one honest write target; locked-vs-`codeProps`; the no-wrapper rule | every agent |
| `node-ids-and-writeback.md` | The id grammar, the `shifted` staleness rule, what refuses and why | builder, style-surgeon, scout |
| `studio-tools.md` | The tool inventory + parity matrix (§6.1), generated from the registry so it cannot drift | every agent |
| `studio-design-principles.md` | Studio's own design bar — the house style a critic reviews against | design-critic |
| `project-conventions.md` | **Per project, generated** from `studio_project_profile`: framework, pagesDir, styling mechanism, component packages | scout, builder, style-surgeon |
| *(package-supplied)* | `@alm-design/design-system`'s `CLAUDE.md` + `design.md`, read in place | almosafer-ds-expert |

`studio-tools.md` being **generated from the registry** is the important one: a
hand-written tool list is wrong the first time a tool is renamed, and every agent
inherits the error at once.

---

## 8. Files

| File | Change |
|---|---|
| `server/ai/runtime/types.ts` | `ToolScope` gains `'studio'` |
| `server/ai/handlers/chat.ts` | `VALID_SCOPES` (line 82) |
| `server/ai/tools/studio/systemPrompt.ts` | **new** — §4, three-part cacheable form |
| `server/ai/tools/studio/index.ts` | **new** — scope toolset: the 14 existing + the 2 new |
| `server/ai/mcp/tools/studio/projectTools.ts` | **new** `studio_create_page`, `studio_read_file`, `studio_upload_asset`, `studio_set_axes`, `studio_duplicate_frame` (§6.1) |
| `server/ai/mcp/tools/studio/editTools.ts` | fix `studio_apply_edits` description (§1.1) |
| `src/admin/pages/site/agent/studioAgentSnapshot.ts` | **new** — §2.1 |
| `src/admin/pages/site/panels/AgentPanel/` | `studio` scope + the session bar (§5.1); route existing image attachments to the CLI; file staging (§5.3); reasoning block (§5.4) |
| `.claude/agents/` + `.claude/*.md` generation (H2) | **new** — §7 roster and §7.4 reference files, written beside the MCP config |
| `server/handlers/studio/studioMeta.ts` | `agentSession` (model, effort, mode) + extra MCP servers |
| `docs/features/agent.md` | the new scope, prompt, controls, subagents |
| `server/db/migrations-*.ts` | see §8.1 — **verified blocker**, decide before starting |

### 8.1 One scope: Studio (D3) — no migration needed

**Superseded.** The analysis below was written assuming Studio needed to *add* a
`'studio'` value alongside four existing scopes. Recon (F1) showed there are not
four scopes — there is one live scope and two empty reserved branches. The
decision is therefore to **remove the scope concept from the application
entirely**, not to extend it.

What that means concretely:

| | Change |
|---|---|
| `server/ai/runtime/types.ts` | delete `ToolScope`, and the re-export in `tools/types.ts` |
| `server/ai/tools/index.ts` | `scopeToolset(scope)` → `studioTools`, a constant. The empty `'data'`/`'plugin'` arms go. |
| `server/ai/handlers/chat.ts` | `POST /admin/api/ai/chat/:scope` → `POST /admin/api/ai/chat`. `VALID_SCOPES` and `buildSystemPromptForScope`'s placeholder branch go; the prompt is the Studio prompt (§4). |
| `server/ai/handlers/defaults.ts` | `PUT/DELETE /admin/api/ai/defaults/:scope` → unsuffixed. One default, not a map. |
| `server/ai/handlers/conversations.ts` | drop the `?scope=` filter |
| `src/admin/ai/api.ts:45` | delete the stale 4-literal `ToolScope` schema (the last place `'content'` appears in code) |
| `src/admin/pages/ai/tabs/DefaultsTab.tsx` | the per-scope grid collapses to a single form |
| `src/admin/pages/site/agent/types.ts`, `.../ai/tabs/DefaultsTab.tsx` | delete the two redundant local copies of the union |

**The database is not migrated.** `ai_defaults.scope` (primary key) and
`ai_conversations.scope` keep their CHECK constraints from `007_ai_runtime`
untouched, and the single write site pins them to a permitted constant:

```ts
/**
 * Vestigial. Migration 007 pinned `scope` with an inline CHECK, and SQLite
 * cannot alter one. Studio now has exactly one agent, so this column
 * discriminates nothing — it holds a permitted constant so the constraint is
 * satisfied. Nothing reads it. Drop it when the row set is next rebuilt.
 */
const LEGACY_SCOPE_COLUMN = 'site'
```

This is honest in a way the rejected option (c) was not. (c) would have labelled
a Studio conversation `'content'` *while other scopes still existed*, misleading
every future reader. Here there is only one kind of conversation, the column
distinguishes nothing, and the comment says so at the only place it is written.
Adding an `agent_scope` column to store a single constant value would be pure
ceremony.

<details>
<summary>Original analysis, kept for the reasoning (superseded by D3)</summary>

#### `scope` is CHECK-constrained — verified

Both dialects pin it, inline, in `CREATE TABLE`:

```sql
constraint ai_defaults_scope_check check (scope in ('site','content','data','plugin'))
constraint ai_conv_scope_check     check (scope in ('site','content','data','plugin'))
```

So **`'studio'` cannot be written to `ai_conversations.scope` or
`ai_defaults.scope`**, and SQLite cannot alter a CHECK (WS-11 §3). Conversation
persistence and per-scope model defaults are both affected.

Two notes that shape the fix. First, the DB set already contains `'content'`,
which `ToolScope` does not — the column and the code union have *already*
drifted, so the constraint is not currently load-bearing as a source of truth.
Second, this is the exact anti-pattern the same schema file argues against for
`provider_id`: a DB enum duplicating an application list forces a destructive
migration every time the list grows.

**Options, non-destructive only:**

| | Approach | Cost |
|---|---|---|
| **a** | **`alter table ai_conversations add column agent_scope text`** (nullable, unconstrained) — becomes the scope source of truth; the legacy `scope` column keeps a permitted value purely to satisfy the old constraint. | One additive migration per dialect. `ADD COLUMN` is supported in SQLite. |
| **b** | Studio conversations live in their own additive table. | More code, duplicated conversation logic. |
| **c** | Reuse an allowed value (`'content'`) for Studio. | Free, and dishonest — a Studio conversation labelled `content` will mislead every future reader. Rejected. |

**Recommendation: (a).** It is one `ADD COLUMN` in each dialect, it is
non-destructive, and it moves scope validation to the TypeBox boundary where the
schema's own comment already says it belongs. The residual wart — a legacy
`scope` column kept alive for a constraint nobody wants — is worth naming in the
migration comment so the eventual cleanup is obvious.

**This is decision §11.4 and it gates step 1.**

</details>

## 9. Tests

| Area | Test |
|---|---|
| Prompt prefix is static + cacheable; suffix carries only real ids | `src/__tests__/agent/` |
| Snapshot never walks every page's nodes (trap #11) | perf assertion on `studioAgentSnapshot` |
| `shifted: true` forces a snapshot rebuild (§2.2) | harness unit test |
| `studio_create_page` containment + returns a usable `rootNodeId` | `projectTools.test.ts` |
| Tier 0 refuses install/compile tools **even in Bypass mode** (§5.2) | `projectTools.test.ts` |
| Bypass does not persist across project switch or reload (§5.2) | AgentPanel session test |
| **Parity matrix is complete** — every editor action is mapped or explicitly withheld (§6.1) | **new gate** |
| Every tool named in any prompt or agent definition exists in the registry | **new gate**, mirroring `fidelityCodes.test.ts`'s registry↔doc pattern |
| No generated subagent holds a tool the main agent lacks (§7.3) | **new gate** |

The last three matter more than they look. A prompt naming a renamed tool is
invisible until an agent fails at runtime; and the parity gate is the only thing
that keeps "the agent can do what I can do" true a year from now, when someone
adds an editor action and forgets the tool.

## 10. Sequencing

| Step | Contents | Gate |
|---|---|---|
| 0 | **WS-13** — the canonical contract + scaffolding | screens Studio writes are fully editable |
| 1 | `'studio'` scope + prompt + wire the 14 existing tools | agent can read and explain a project |
| 2 | The 5 parity tools + the description fix (§6.1) | **agent can create a screen** |
| 3 | `StudioAgentSnapshot` + the staleness rule (§2.2) | multi-edit turns stop corrupting ids |
| 4 | Session controls: model, effort, mode, attachments (§5) | you drive it like the VS Code extension |
| 5 | Build + design agents (§7.1, §7.2) + reference files (§7.4) | delegation works; DS expert is authoritative |
| 6 | Meta agents (§7.3) + their validation gates | the roster can grow safely |

**Step 2 is the milestone** — the difference between a chat that discusses the
project and one that builds in it. Steps 4–6 are what make it feel like a tool
rather than a demo, but none of them matter if step 2 is not real.

## 11. Open decisions

All closed (D3, D4, D5).

1. ~~H1 or H2?~~ **H2** — WS-11 spawns the CLI, so the CLI owns the loop and §5
   is nearly free.
2. ~~Trust promotion?~~ **Ask, never act.** Promotion is a consent action; the
   agent surfaces the need and the user clicks.
3. ~~Auto-place the frame?~~ **Yes.** A scaffolded screen the user cannot see is
   not a screen. It lands on the board at the next free slot.
4. ~~The `scope` CHECK constraint?~~ **Dissolved, not solved (§8.1).** One scope
   means no discriminator, no new column, and no migration. Step 1 is unblocked.
5. ~~Bypass guard rails?~~ **Confirmed as specced** — non-persisting, visibly
   indicated, still trust-tier-bound.
6. **Reference files in the workspace.** The generated `.claude/` directory lands
   inside the user's project, so it shows up in their git status. Commit it (the
   agents become part of the repo, shared with their team) or `.gitignore` it
   (Studio-local)? I lean **commit** — a DS-expert agent is worth sharing.
